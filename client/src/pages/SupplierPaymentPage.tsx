import Decimal from 'decimal.js'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiFetch, storeScopedApiFetch } from '../api'
import { SupplierPaymentEditor } from '../components/SupplierPaymentEditor'
import { formatDecimal } from '../money-display'
import {
  newSupplierPayment,
  serializeSupplierPayments,
  SupplierPaymentDraft,
  supplierPaymentsTotal,
  TransferableCheck,
} from '../payments/supplier-payment-draft'
import { Store } from '../types'

type Supplier = { id: string; name: string; balance_ils: string }

function currentBusinessDate() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { error?: { message?: string } }
    if (body.error?.message) return body.error.message
  } catch { /* fallback below */ }
  return 'تعذر تسجيل دفعة المورد.'
}

export function SupplierPaymentPage({ defaultStoreId, stores, onDraftStateChange }: {
  defaultStoreId: string | null
  stores: Store[]
  onDraftStateChange: (active: boolean) => void
}) {
  const { supplierId = '' } = useParams()
  const storeId = stores.some((store) => store.id === defaultStoreId) ? defaultStoreId! : ''
  const store = stores.find((item) => item.id === storeId)
  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [checks, setChecks] = useState<TransferableCheck[]>([])
  const [payments, setPayments] = useState<SupplierPaymentDraft[]>(() => [newSupplierPayment('cash', currentBusinessDate())])
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!storeId || !supplierId) { setLoading(false); return }
    const controller = new AbortController()
    const headers = { 'X-Store-Id': storeId }
    Promise.all([
      apiFetch(`/suppliers/${supplierId}`, { headers, signal: controller.signal }),
      apiFetch('/checks?status=pending', { headers, signal: controller.signal }),
    ]).then(async ([supplierResponse, checkResponse]) => {
      if (!supplierResponse.ok) throw new Error(await responseError(supplierResponse))
      if (!checkResponse.ok) throw new Error(await responseError(checkResponse))
      const supplierBody = await supplierResponse.json() as { supplier: Supplier }
      const checkBody = await checkResponse.json() as { checks: TransferableCheck[] }
      setSupplier(supplierBody.supplier)
      setChecks(checkBody.checks.filter((check) => check.status === 'pending' && !check.supplier_id))
    }).catch((caught) => {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) setError(caught instanceof Error ? caught.message : 'تعذر تحميل حساب المورد')
    }).finally(() => setLoading(false))
    return () => controller.abort()
  }, [storeId, supplierId])

  const paid = useMemo(() => supplierPaymentsTotal(payments, checks), [payments, checks])
  const debt = supplier ? new Decimal(supplier.balance_ils) : null
  const remaining = debt && paid ? debt.minus(paid) : null
  const canSave = Boolean(supplier && debt?.greaterThan(0) && paid?.greaterThan(0) && !remaining?.lessThan(0) && !saving)
  const hasDraft = Boolean(notes.trim() || payments.length > 1 || payments.some((payment) => payment.amount || payment.reference || payment.checkNumber || payment.checkId))
  useEffect(() => onDraftStateChange(hasDraft), [hasDraft, onDraftStateChange])
  useEffect(() => () => onDraftStateChange(false), [onDraftStateChange])

  async function save() {
    if (!canSave || !supplier) return
    setSaving(true); setError(null); setMessage('جارٍ تسجيل الدفعة…')
    try {
      const init: RequestInit = {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payments: serializeSupplierPayments(payments), notes: notes.trim() || null }),
      }
      const response = window.desktop
        ? await storeScopedApiFetch(`/suppliers/${supplier.id}/payments`, init)
        : await apiFetch(`/suppliers/${supplier.id}/payments`, { ...init, headers: { ...init.headers, 'X-Store-Id': storeId } })
      if (!response.ok) throw new Error(await responseError(response))
      const body = await response.json() as { payment: { total_ils: string; balance_after_ils: string } }
      const transferredIds = new Set(payments.filter((payment) => payment.method === 'transferred_customer_check').map((payment) => payment.checkId))
      setChecks((current) => current.filter((check) => !transferredIds.has(check.id)))
      setSupplier({ ...supplier, balance_ils: body.payment.balance_after_ils })
      setPayments([newSupplierPayment('cash', currentBusinessDate())]); setNotes('')
      setMessage(`تم تسجيل ₪${formatDecimal(body.payment.total_ils)}؛ الدين المتبقي ₪${formatDecimal(body.payment.balance_after_ils)}.`)
      onDraftStateChange(false)
    } catch (caught) {
      setMessage(null); setError(caught instanceof Error ? caught.message : 'تعذر تسجيل دفعة المورد')
    } finally { setSaving(false) }
  }

  if (!storeId) return <State text="اختر المحل الحالي من أعلى الصفحة قبل تسجيل الدفعة." />
  if (loading) return <State text="جارٍ تحميل حساب المورد…" />
  if (!supplier) return <State error text={error ?? 'المورد غير موجود'} />
  return (
    <section>
      <Link className="font-black text-violet-700" to={`/suppliers/${supplier.id}`}>← العودة إلى ملف المورد</Link>
      <div className="mt-5 flex flex-wrap justify-between gap-5 rounded-3xl bg-slate-900 p-6 text-white"><div><p className="font-bold text-violet-300">{store?.name ?? 'المتجر الحالي'}</p><h1 className="mt-1 text-3xl font-black">دفعة للمورد {supplier.name}</h1></div><div className="rounded-2xl bg-white/10 px-6 py-4 text-center"><p className="font-bold text-slate-300">الدين الحالي</p><p className="mt-1 text-3xl font-black" dir="ltr">₪{formatDecimal(supplier.balance_ils)}</p></div></div>
      {message && <p className="mt-5 rounded-xl bg-emerald-50 p-4 text-lg font-black text-emerald-900">{message}</p>}
      {error && <p className="mt-5 rounded-xl bg-rose-50 p-4 text-lg font-black text-rose-900">{error}</p>}
      <div className="mt-6 grid items-start gap-5 min-[1120px]:grid-cols-[20rem_minmax(0,1fr)]" dir="ltr">
        <div className="order-1 min-w-0 min-[1120px]:order-2" dir="rtl"><SupplierPaymentEditor businessDate={currentBusinessDate()} checks={checks} onChange={setPayments} payments={payments} /></div>
        <aside aria-label="ملخص دفعة المورد" className="order-2 rounded-3xl border-2 border-slate-200 bg-white p-5 shadow-sm min-[1120px]:sticky min-[1120px]:top-4 min-[1120px]:order-1" dir="rtl"><label><span className="mb-2 block font-black">ملاحظات (اختياري)</span><textarea className="min-h-24 w-full rounded-xl border border-slate-300 p-3 text-lg" maxLength={2000} onChange={(event) => setNotes(event.target.value)} value={notes} /></label><div className="mt-4 rounded-2xl bg-slate-100 p-5"><Row label="الدين قبل الدفع" value={debt} /><Row label="مجموع الدفعة" value={paid} /><Row label="المتبقي" value={remaining} /><button className="mt-5 min-h-16 w-full rounded-2xl bg-violet-700 text-xl font-black text-white disabled:bg-slate-300 disabled:text-slate-600" disabled={!canSave} onClick={() => void save()} type="button">{saving ? 'جارٍ التسجيل…' : 'تسجيل الدفعة'}</button></div></aside>
      </div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: Decimal | null }) {
  return <div className="flex justify-between gap-4 border-b border-slate-200 py-3 text-lg font-black"><span>{label}</span><span dir="ltr">₪{value?.toFixed() ?? '—'}</span></div>
}
function State({ text, error = false }: { text: string; error?: boolean }) {
  return <p className={`rounded-2xl p-8 text-center text-lg font-black ${error ? 'bg-rose-50 text-rose-800' : 'bg-white text-slate-600'}`}>{text}</p>
}
