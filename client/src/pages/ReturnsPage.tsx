import Decimal from 'decimal.js'
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch, storeScopedApiFetch } from '../api'
import { formatDecimal, formatQuantity } from '../money-display'

type SourceItem = {
  id: string
  product_id: string | null
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
  const [params] = useSearchParams()
  const initialPartyId = params.get('partyId') ?? 'all'
  const activeStoreId = window.desktop ? configuredStoreId : (params.get('storeId') ?? configuredStoreId)
  const [documents, setDocuments] = useState<SourceDocument[]>([])
  const [parties, setParties] = useState<Array<{ id: string; name: string }>>([])
  const [partyId, setPartyId] = useState(initialPartyId)
  const [partySearch, setPartySearch] = useState(params.get('partyName') ?? '')
  const sourceRequest = useRef(0)
  const [sourcePage, setSourcePage] = useState(1)
  const [hasMoreSources, setHasMoreSources] = useState(false)
  const [documentId, setDocumentId] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [sourcesLoaded, setSourcesLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const title = kind === 'customer' ? 'مرتجع مبيعات' : 'مرتجع مشتريات'
  const sourceLabel = kind === 'customer' ? 'فاتورة البيع الأصلية' : 'فاتورة الشراء الأصلية'
  const partyLabel = kind === 'customer' ? 'العميل' : 'المورد'
  const selected = useMemo(
    () => documents.find((document) => document.id === documentId) ?? null,
    [documentId, documents],
  )

  const load = useCallback(async (page = 1, append = false) => {
    const requestId = ++sourceRequest.current
    if (!partyId) { setDocuments([]); setHasMoreSources(false); setLoading(false); return }
    if (!activeStoreId && !window.desktop) return
    setLoading(true); setSourcesLoaded(false); setError(null)
    try {
      const response = await scopedFetch(`/returns/${kind}/sources?page=${page}${partyId === 'all' ? '' : `&partyId=${encodeURIComponent(partyId)}`}`, activeStoreId)
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { documents: SourceDocument[]; pagination: { hasMore: boolean } }
      if (requestId !== sourceRequest.current) return
      setDocuments((current) => append ? [...current, ...payload.documents] : payload.documents)
      setSourcesLoaded(true)
      setSourcePage(page)
      setHasMoreSources(payload.pagination.hasMore)
    } catch (caught) {
      if (requestId !== sourceRequest.current) return
      setError(caught instanceof Error ? caught.message : 'تعذر تحميل الفواتير')
    } finally { if (requestId === sourceRequest.current) setLoading(false) }
  }, [activeStoreId, kind, partyId])

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const endpoint = kind === 'customer' ? 'customers' : 'suppliers'
      void scopedFetch(`/${endpoint}?search=${encodeURIComponent(partySearch)}`, activeStoreId, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(await errorMessage(response))
          const payload = await response.json() as Record<string, Array<{ id: string; name: string }>>
          if (!controller.signal.aborted) setParties(payload[endpoint])
        }).catch((caught: unknown) => {
          if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'تعذر تحميل الأسماء')
        })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [activeStoreId, kind, partySearch])

  useEffect(() => {
    setPartyId(initialPartyId); setDocumentId(''); setQuantities({}); setDocuments([]); setSuccess(null)
  }, [activeStoreId, kind, initialPartyId])

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
      const response = await scopedFetch(`/returns/${kind}`, activeStoreId, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(partyId === 'all' ? {} : { partyId }), sourceDocumentId: selected.id, items }),
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { return: { document_number: string; business_date: string; total: string } }
      setSuccess(`تم تسجيل حركة مرتجع ${payload.return.document_number} بتاريخ ${payload.return.business_date} للفاتورة ${selected.document_number} — ${selected.party_name ?? 'بيع نقدي بدون عميل'} — بقيمة ₪${formatDecimal(payload.return.total)}`)
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
      {!activeStoreId && !window.desktop && <p className="mt-5 rounded-xl bg-amber-50 p-4 font-bold text-amber-900">اختر المتجر الحالي أولاً.</p>}
      <form className="mt-6 space-y-6" onSubmit={submit}>
        <fieldset className="space-y-3" disabled={saving}>
          <legend className="mb-2 font-black">اختر {partyLabel} صاحب المرتجع</legend>
          <input aria-label={`بحث عن ${partyLabel}`} className={inputClass} onChange={(event) => { ++sourceRequest.current; setPartySearch(event.target.value); setPartyId('all'); setDocumentId(''); setQuantities({}); setDocuments([]); setSuccess(null) }} placeholder={`بحث باسم ${partyLabel} أو الهاتف`} value={partySearch} />
          <select aria-label={partyLabel} className={inputClass} onChange={(event) => { ++sourceRequest.current; setPartyId(event.target.value); setDocumentId(''); setQuantities({}); setDocuments([]); setSuccess(null) }} required value={partyId}>
            <option value="all">كل الفواتير</option>
            {kind === 'customer' && <option value="cash">بيع نقدي بدون عميل</option>}
            {partyId !== 'all' && partyId !== 'cash' && !parties.some((party) => party.id === partyId) && <option value={partyId}>{params.get('partyName') ?? partyLabel}</option>}
            {parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
          </select>
        </fieldset>
        {partyId && sourcesLoaded && !loading && documents.length === 0 && <p className="font-bold text-slate-600">لا توجد فواتير قابلة للإرجاع لهذا الطرف في المتجر الحالي.</p>}
        <label className="block"><span className="mb-2 block font-black">{sourceLabel}</span><select className={inputClass} disabled={saving || !partyId || loading || (!activeStoreId && !window.desktop)} onChange={(event) => { setDocumentId(event.target.value); setQuantities({}); setSuccess(null) }} required value={documentId}><option value="">{loading ? 'جارٍ التحميل…' : 'اختر الفاتورة'}</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.document_number} — {document.party_name ?? 'بيع نقدي'} — {document.business_date}</option>)}</select></label>
        {hasMoreSources && <button className="min-h-11 rounded-xl border border-slate-300 px-5 font-black" disabled={saving || loading} onClick={() => void load(sourcePage + 1, true)} type="button">تحميل فواتير أقدم</button>}
        {selected && <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white"><div className="border-b bg-slate-50 p-4 font-black">أصناف الفاتورة</div>{selected.items.map((item) => <div className="grid items-center gap-3 border-b p-4 last:border-0 sm:grid-cols-[1fr_12rem]" key={item.id}><div><p className="font-black">{item.description}</p><p className="text-sm text-slate-600">المتاح للمرتجع: {formatQuantity(item.returnable_quantity)} من أصل {formatQuantity(item.original_quantity)}</p></div><label><span className="sr-only">كمية مرتجع {item.description}</span><input className={inputClass} disabled={saving} inputMode="decimal" max={item.returnable_quantity} min="0" onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="الكمية المرتجعة" step="0.001" value={quantities[item.id] ?? ''} /></label></div>)}</div>}
        <p className="rounded-xl bg-slate-100 p-4 text-sm font-bold">يُسجل المرتجع كحركة مستقلة بتاريخ اليوم مرتبطة بالفاتورة الأصلية. تبقى كميات الفاتورة الأصلية وأسعارها وخصوماتها ومبالغها كما هي.</p>
        {kind === 'customer' && selected?.party_name && <p className="rounded-xl bg-sky-50 p-4 text-sm font-bold text-sky-900">ينشئ المرتجع رصيداً دائناً للعميل ولا يصرف مبلغاً نقدياً تلقائياً.</p>}
        {kind === 'customer' && selected && !selected.party_name && <p className="rounded-xl bg-sky-50 p-4 text-sm font-bold text-sky-900">هذه الفاتورة غير مرتبطة بعميل؛ يُحفظ المرتجع على الفاتورة ولا ينشئ حركة في كشف حساب عميل أو يصرف نقداً تلقائياً.</p>}
        {error && <p className="rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}
        {success && <p className="rounded-xl bg-emerald-50 p-4 font-bold text-emerald-900" role="status">{success}</p>}
        <button className="min-h-14 rounded-xl bg-teal-700 px-7 text-lg font-black text-white disabled:opacity-50" disabled={saving || !partyId || !selected} type="submit">{saving ? 'جارٍ الحفظ…' : `حفظ ${title}`}</button>
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
