import Decimal from 'decimal.js'
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch, storeScopedApiFetch } from '../api'
import { formatDecimal, formatQuantity } from '../money-display'

type SourceItem = {
  id: string
  product_id: string
  description: string
  original_quantity: string
  returnable_quantity: string
}
type SourceDocument = {
  id: string
  document_number: string
  business_date: string
  total: string
  party_name: string | null
  items: SourceItem[]
}
type ReturnKind = 'customer' | 'supplier'

const inputClass = 'min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100'

async function errorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } }
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch { /* stable fallback */ }
  return 'تعذر إكمال العملية. حاول مرة أخرى.'
}

function scopedFetch(path: string, storeId: string | null, init?: RequestInit) {
  if (window.desktop) return storeScopedApiFetch(path, init)
  const headers = new Headers(init?.headers)
  if (storeId) headers.set('X-Store-Id', storeId)
  return apiFetch(path, { ...init, headers })
}

function ReturnPage({ configuredStoreId, kind, onDraftStateChange }: {
  configuredStoreId: string | null
  kind: ReturnKind
  onDraftStateChange: (active: boolean) => void
}) {
  const [documents, setDocuments] = useState<SourceDocument[]>([])
  const [sourcePage, setSourcePage] = useState(1)
  const [hasMoreSources, setHasMoreSources] = useState(false)
  const [documentId, setDocumentId] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const title = kind === 'customer' ? 'مرتجع مبيعات' : 'مرتجع مشتريات'
  const sourceLabel = kind === 'customer' ? 'فاتورة البيع الأصلية' : 'فاتورة الشراء الأصلية'
  const selected = useMemo(
    () => documents.find((document) => document.id === documentId) ?? null,
    [documentId, documents],
  )

  const load = useCallback(async (page = 1, append = false) => {
    if (!configuredStoreId && !window.desktop) return
    setLoading(true); setError(null)
    try {
      const response = await scopedFetch(`/returns/${kind}/sources?page=${page}`, configuredStoreId)
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { documents: SourceDocument[]; pagination: { hasMore: boolean } }
      setDocuments((current) => append ? [...current, ...payload.documents] : payload.documents)
      setSourcePage(page)
      setHasMoreSources(payload.pagination.hasMore)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر تحميل الفواتير')
    } finally { setLoading(false) }
  }, [configuredStoreId, kind])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const active = Object.values(quantities).some((quantity) => quantity.trim() !== '')
    onDraftStateChange(active)
    return () => onDraftStateChange(false)
  }, [onDraftStateChange, quantities])

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(null); setSuccess(null)
    if (!selected) { setError(`يجب اختيار ${sourceLabel}`); return }
    const items: { sourceItemId: string; quantity: string }[] = []
    for (const item of selected.items) {
      const quantity = quantities[item.id]?.trim()
      if (!quantity) continue
      try {
        const parsed = new Decimal(quantity)
        if (!parsed.greaterThan(0) || parsed.greaterThan(item.returnable_quantity)) {
          setError(`الكمية المدخلة للصنف «${item.description}» تتجاوز الكمية المتاحة للمرتجع`)
          return
        }
      } catch { setError(`كمية «${item.description}» غير صالحة`); return }
      items.push({ sourceItemId: item.id, quantity })
    }
    if (items.length === 0) { setError('أدخل كمية مرتجعة لصنف واحد على الأقل'); return }
    setSaving(true)
    try {
      const response = await scopedFetch(`/returns/${kind}`, configuredStoreId, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceDocumentId: selected.id, items }),
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { return: { document_number: string; total: string } }
      setSuccess(`تم حفظ المستند ${payload.return.document_number} بقيمة ₪${formatDecimal(payload.return.total)}`)
      setQuantities({}); setDocumentId(''); onDraftStateChange(false); await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر حفظ المرتجع')
    } finally { setSaving(false) }
  }

  return (
    <section aria-labelledby="return-title">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl bg-slate-900 p-6 text-white">
        <div><p className="font-bold text-violet-300">مرتجع مرتبط بمستند أصلي</p><h1 className="mt-1 text-3xl font-black" id="return-title">{title}</h1></div>
        <Link className="rounded-xl bg-white px-5 py-3 font-black text-slate-900" to={kind === 'customer' ? '/sale' : '/purchases'}>عودة</Link>
      </div>
      {!configuredStoreId && !window.desktop && <p className="mt-5 rounded-xl bg-amber-50 p-4 font-bold text-amber-900">اختر المتجر الحالي أولاً.</p>}
      <form className="mt-6 space-y-6" onSubmit={submit}>
        <label className="block"><span className="mb-2 block font-black">{sourceLabel}</span><select className={inputClass} disabled={loading || (!configuredStoreId && !window.desktop)} onChange={(event) => { setDocumentId(event.target.value); setQuantities({}); setSuccess(null) }} required value={documentId}><option value="">{loading ? 'جارٍ التحميل…' : 'اختر الفاتورة'}</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.document_number} — {document.party_name ?? 'بيع نقدي'} — {document.business_date}</option>)}</select></label>
        {hasMoreSources && <button className="min-h-11 rounded-xl border border-slate-300 px-5 font-black" onClick={() => void load(sourcePage + 1, true)} type="button">تحميل فواتير أقدم</button>}
        {selected && <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white"><div className="border-b bg-slate-50 p-4 font-black">أصناف الفاتورة</div>{selected.items.map((item) => <div className="grid items-center gap-3 border-b p-4 last:border-0 sm:grid-cols-[1fr_12rem]" key={item.id}><div><p className="font-black">{item.description}</p><p className="text-sm text-slate-600">المتاح للمرتجع: {formatQuantity(item.returnable_quantity)} من أصل {formatQuantity(item.original_quantity)}</p></div><label><span className="sr-only">كمية مرتجع {item.description}</span><input className={inputClass} inputMode="decimal" max={item.returnable_quantity} min="0" onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="الكمية المرتجعة" step="0.001" value={quantities[item.id] ?? ''} /></label></div>)}</div>}
        {kind === 'customer' && <p className="rounded-xl bg-sky-50 p-4 text-sm font-bold text-sky-900">ينشئ المرتجع رصيداً دائناً للعميل ولا يصرف مبلغاً نقدياً تلقائياً.</p>}
        {error && <p className="rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}
        {success && <p className="rounded-xl bg-emerald-50 p-4 font-bold text-emerald-900" role="status">{success}</p>}
        <button className="min-h-14 rounded-xl bg-teal-700 px-7 text-lg font-black text-white disabled:opacity-50" disabled={saving || !selected} type="submit">{saving ? 'جارٍ الحفظ…' : `حفظ ${title}`}</button>
      </form>
    </section>
  )
}

export function CustomerReturnPage(props: Omit<Parameters<typeof ReturnPage>[0], 'kind'>) {
  return <ReturnPage {...props} kind="customer" />
}

export function SupplierReturnPage(props: Omit<Parameters<typeof ReturnPage>[0], 'kind'>) {
  return <ReturnPage {...props} kind="supplier" />
}
