import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch, storeScopedApiFetch } from '../api'
import {
  PaymentDraft,
  PaymentEditor,
} from '../components/PaymentEditor'
import { DialogCloseButton } from '../components/DialogCloseButton'
import {
  newPayment,
  paymentsTotal,
  parsePaymentDecimal,
  serializePayments,
} from '../payments/payment-draft'
import { formatDecimal } from '../money-display'

type Customer = { id: string; name: string }
type MaintenanceRecord = {
  id: string
  customer_id: string | null
  customer_name: string | null
  item_description: string
  maintenance_details: string | null
  amount_ils: string
  business_date: string
  paid_total_ils: string
  remaining_due_ils: string
  notes: string | null
  reversal_id: string | null
  reversal_reason: string | null
  reversed_at: string | null
}

const inputClass = 'min-h-14 w-full rounded-xl border border-slate-300 bg-white px-4 text-lg font-black outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100'

function currentBusinessDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

async function errorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } }
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch {
    // Keep the stable fallback below.
  }
  return 'تعذّر إكمال الطلب. حاول مرة أخرى.'
}

export function MaintenancePage({
  configuredStoreId,
  onDraftStateChange,
}: {
  configuredStoreId: string | null
  onDraftStateChange: (active: boolean) => void
}) {
  const [searchParams] = useSearchParams()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [records, setRecords] = useState<MaintenanceRecord[]>([])
  const [recordPage, setRecordPage] = useState(1)
  const [hasMoreRecords, setHasMoreRecords] = useState(false)
  const [showForm, setShowForm] = useState(Boolean(searchParams.get('customerId')))
  const [customerId, setCustomerId] = useState(searchParams.get('customerId') ?? '')
  const [itemDescription, setItemDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [businessDate, setBusinessDate] = useState(currentBusinessDate)
  const [payments, setPayments] = useState<PaymentDraft[]>(() => [newPayment('cash', currentBusinessDate())])
  const [search, setSearch] = useState('')
  const [filterDate, setFilterDate] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reversingId, setReversingId] = useState<string | null>(null)
  const [reversalReason, setReversalReason] = useState('')
  const needsStore = !configuredStoreId

  const scopedFetch = useCallback((path: string, init?: RequestInit) => {
    if (window.desktop) return storeScopedApiFetch(path, init)
    const headers = new Headers(init?.headers)
    if (configuredStoreId) headers.set('X-Store-Id', configuredStoreId)
    return apiFetch(path, { ...init, headers })
  }, [configuredStoreId])

  const loadRecords = useCallback(async (nextSearch: string, nextDate: string, page = 1) => {
    if (needsStore) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      if (nextSearch.trim()) params.set('search', nextSearch.trim())
      if (nextDate) params.set('date', nextDate)
      const response = await scopedFetch(`/maintenance${params.size ? `?${params}` : ''}`)
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { maintenance: MaintenanceRecord[]; pagination: { hasMore: boolean } }
      setRecordPage(page)
      setHasMoreRecords(payload.pagination.hasMore)
      setRecords(payload.maintenance.map((record) => ({
        ...record,
        amount_ils: formatDecimal(record.amount_ils),
        paid_total_ils: formatDecimal(record.paid_total_ils),
        remaining_due_ils: formatDecimal(record.remaining_due_ils),
      })))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذّر تحميل سجلات الصيانة')
    } finally {
      setLoading(false)
    }
  }, [needsStore, scopedFetch])

  useEffect(() => {
    if (needsStore) return
    const controller = new AbortController()
    scopedFetch('/customers', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorMessage(response))
        return response.json() as Promise<{ customers: Customer[] }>
      })
      .then((payload) => setCustomers(payload.customers))
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setError(caught instanceof Error ? caught.message : 'تعذّر تحميل العملاء')
      })
    return () => controller.abort()
  }, [needsStore, scopedFetch])

  useEffect(() => { void loadRecords('', '') }, [loadRecords])

  const amountValue = parsePaymentDecimal(amount, 2)
  const amountValid = Boolean(amountValue?.greaterThan(0) && amountValue.mod('0.5').isZero())
  const paidTotal = useMemo(() => paymentsTotal(payments), [payments])
  const remaining = amountValid && paidTotal ? amountValue!.minus(paidTotal) : null
  const overpaid = remaining?.lessThan(0) ?? false
  const anonymousDebt = !customerId && (remaining?.greaterThan(0) ?? false)
  const anonymousCheck = !customerId && payments.some((payment) => payment.method === 'check')
  const canSave = Boolean(
    !needsStore && itemDescription.trim() && businessDate && amountValid
    && paidTotal && !overpaid && !anonymousDebt && !anonymousCheck && !saving,
  )
  const hasPaymentDraft = payments.length > 1 || payments.some((payment) => (
    payment.amount.trim()
    || payment.exchangeRate.trim()
    || payment.reference.trim()
    || payment.checkNumber.trim()
    || payment.notes.trim()
    || payment.originalOwnerName.trim()
    || payment.originalOwnerPhone.trim()
  ))
  const hasUnsavedDraft = Boolean(
    customerId || itemDescription.trim() || amount.trim()
    || hasPaymentDraft || reversingId || reversalReason.trim(),
  )

  useEffect(() => onDraftStateChange(hasUnsavedDraft), [hasUnsavedDraft, onDraftStateChange])
  useEffect(() => () => onDraftStateChange(false), [onDraftStateChange])
  useEffect(() => {
    if (!showForm) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !hasUnsavedDraft) setShowForm(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [hasUnsavedDraft, showForm])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    setMessage('جارٍ حفظ الصيانة والدفعات…')
    setError(null)
    try {
      const response = await scopedFetch('/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: customerId || null,
          itemDescription: itemDescription.trim(),
          maintenanceDetails: null,
          amount: amountValue!.toFixed(),
          businessDate,
          notes: null,
          payments: serializePayments(payments),
        }),
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { maintenance: MaintenanceRecord }
      setMessage(`تم حفظ صيانة «${payload.maintenance.item_description}» بمبلغ ₪${formatDecimal(payload.maintenance.amount_ils)}.`)
      setItemDescription('')
      setAmount('')
      setPayments([newPayment('cash', businessDate)])
      setShowForm(false)
      await loadRecords(search, filterDate)
    } catch (caught) {
      setMessage(null)
      setError(caught instanceof Error ? caught.message : 'تعذّر حفظ الصيانة')
    } finally {
      setSaving(false)
    }
  }

  async function submitReversal(record: MaintenanceRecord) {
    if (!reversalReason.trim()) return
    setSaving(true)
    setError(null)
    try {
      const response = await scopedFetch(`/maintenance/${record.id}/reversal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reversalReason.trim() }),
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      setMessage(`تم عكس سجل صيانة «${record.item_description}» مع حفظ الأصل.`)
      setReversingId(null)
      setReversalReason('')
      await loadRecords(search, filterDate)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذّر عكس الصيانة')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby="maintenance-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="font-bold text-teal-700">دخل خدمات مستقل عن المبيعات</p><h1 className="mt-1 text-3xl font-black sm:text-4xl" id="maintenance-title">الصيانة</h1><p className="mt-2 text-lg font-bold text-slate-600">سجّل الجهاز، المبلغ، والدفعات فقط. لا يتأثر المخزون.</p></div>
        <div className="flex flex-wrap gap-3"><button className="min-h-14 rounded-xl bg-teal-700 px-7 text-lg font-black text-white hover:bg-teal-800" onClick={() => setShowForm(true)} type="button">+ صيانة جديدة</button><Link className="inline-flex min-h-14 items-center rounded-xl bg-white px-5 font-black ring-1 ring-slate-300 hover:bg-slate-100" to="/sale">البيع</Link></div>
      </div>

      {needsStore && <p className="mt-6 rounded-2xl border-2 border-amber-300 bg-amber-50 p-5 text-lg font-black text-amber-950" role="alert">{window.desktop ? 'يجب تحديد متجر هذا الجهاز من الإعدادات أولاً.' : 'اختر المحل الحالي من أعلى الصفحة قبل تسجيل الصيانة.'}</p>}
      <div aria-live="polite">{message && <p className="mt-5 rounded-xl bg-emerald-50 p-4 text-lg font-black text-emerald-900" role="status">{message}</p>}{error && <p className="mt-5 rounded-xl bg-rose-50 p-4 text-lg font-black text-rose-900" role="alert">{error}</p>}</div>

      {showForm && !needsStore && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 sm:p-5">
        <form aria-label="صيانة جديدة" aria-modal="true" className="max-h-[94vh] w-full max-w-7xl overflow-y-auto rounded-3xl bg-slate-100 shadow-2xl" onSubmit={(event) => void submit(event)} role="dialog">
          <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
            <div><h2 className="text-2xl font-black">صيانة جديدة</h2><p className="text-sm font-bold text-slate-500">البيانات الأساسية والدفع فقط</p></div>
            <DialogCloseButton onClick={() => setShowForm(false)} />
          </header>

          <div className="space-y-3 p-3 sm:p-4">
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <label><span className="mb-1.5 block font-black">الجهاز أو القطعة *</span><input autoFocus className={inputClass} maxLength={200} onChange={(event) => setItemDescription(event.target.value)} placeholder="مثال: مضخة مياه" required value={itemDescription} /></label>
                <label><span className="mb-1.5 block font-black">العميل (اختياري)</span><select className={inputClass} onChange={(event) => setCustomerId(event.target.value)} value={customerId}><option value="">بدون عميل — دفع كامل</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
                <label><span className="mb-1.5 block font-black">المبلغ بالشيكل *</span><input className={inputClass} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required value={amount} />{amount && !amountValid && <span className="mt-1.5 block text-sm font-bold text-rose-700">أدخل مبلغاً أكبر من صفر وبمضاعفات 0.50</span>}</label>
                <label><span className="mb-1.5 block font-black">التاريخ *</span><input className={inputClass} onChange={(event) => setBusinessDate(event.target.value)} required type="date" value={businessDate} /></label>
              </div>
            </section>

            <PaymentEditor businessDate={businessDate} onChange={setPayments} payments={payments} />

            <section className="sticky bottom-0 rounded-2xl bg-slate-900 p-3 text-white shadow-xl sm:p-4">
              {overpaid && <p className="mb-3 rounded-xl bg-rose-100 p-3 font-black text-rose-900">مجموع الدفعات أكبر من مبلغ الصيانة.</p>}
              {anonymousDebt && <p className="mb-3 rounded-xl bg-amber-100 p-3 font-black text-amber-950">الصيانة بدون عميل يجب أن تكون مدفوعة بالكامل.</p>}
              {anonymousCheck && <p className="mb-3 rounded-xl bg-amber-100 p-3 font-black text-amber-950">اختر العميل قبل قبول الشيك.</p>}
              <div className="grid gap-2 md:grid-cols-4">
                <p className="rounded-xl bg-white/10 p-3 font-black">الإجمالي <span className="float-left text-lg" dir="ltr">{amountValid ? `₪${amountValue!.toFixed()}` : '—'}</span></p>
                <p className="rounded-xl bg-white/10 p-3 font-black">المدفوع <span className="float-left text-lg" dir="ltr">{paidTotal ? `₪${paidTotal.toFixed()}` : '—'}</span></p>
                <p className={`rounded-xl p-3 font-black ${remaining?.greaterThan(0) ? 'bg-amber-400 text-slate-950' : 'bg-emerald-700'}`}>المتبقي <span className="float-left text-lg" dir="ltr">{remaining && !overpaid ? `₪${remaining.toFixed()}` : '—'}</span></p>
                <button className="min-h-12 rounded-xl bg-amber-400 px-6 text-xl font-black text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50" disabled={!canSave} type="submit">{saving ? 'جارٍ الحفظ…' : 'حفظ الصيانة'}</button>
              </div>
            </section>
          </div>
        </form>
        </div>
      )}

      <section className="mt-8" aria-labelledby="recent-maintenance-title">
        <h2 className="text-2xl font-black" id="recent-maintenance-title">أحدث أعمال الصيانة</h2>
        <form className="mt-4 grid gap-3 rounded-2xl bg-white p-4 shadow-sm sm:grid-cols-[1fr_auto_auto]" onSubmit={(event) => { event.preventDefault(); void loadRecords(search, filterDate) }}><label><span className="sr-only">ابحث باسم العميل أو الجهاز</span><input className={inputClass} maxLength={200} onChange={(event) => setSearch(event.target.value)} placeholder="ابحث باسم العميل أو الجهاز" value={search} /></label><label><span className="sr-only">التاريخ</span><input className={inputClass} onChange={(event) => setFilterDate(event.target.value)} type="date" value={filterDate} /></label><button className="min-h-14 rounded-xl bg-slate-900 px-7 text-lg font-black text-white" type="submit">بحث</button></form>
        {loading ? <p className="mt-4 rounded-2xl bg-white p-8 text-center text-lg font-black text-slate-600">جارٍ التحميل…</p> : records.length === 0 ? <p className="mt-4 rounded-2xl bg-white p-8 text-center text-lg font-black text-slate-600">لا توجد سجلات صيانة مطابقة.</p> : <div className="mt-4 space-y-3">{records.map((record) => <article className={`rounded-2xl border bg-white p-5 shadow-sm ${record.reversed_at ? 'border-slate-300 opacity-70' : 'border-slate-200'}`} key={record.id}><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-xl font-black">{record.item_description}</h3>{record.reversed_at && <span className="rounded-full bg-rose-100 px-3 py-1 text-sm font-black text-rose-800">معكوسة</span>}</div><p className="mt-2 font-bold text-slate-600">{record.business_date} · {record.customer_name ?? 'بدون عميل'}</p>{record.maintenance_details && <p className="mt-2 text-slate-600">{record.maintenance_details}</p>}<p className="mt-2 text-sm font-bold text-slate-500">مدفوع ₪{record.paid_total_ils} · متبقٍ ₪{record.remaining_due_ils}</p>{record.reversal_reason && <p className="mt-2 font-bold text-rose-700">سبب العكس: {record.reversal_reason}</p>}</div><div className="text-left"><p className="text-2xl font-black" dir="ltr">₪{record.amount_ils}</p>{!record.reversed_at && <button className="mt-3 min-h-11 rounded-xl px-4 font-black text-rose-700 hover:bg-rose-50" onClick={() => { setReversingId(record.id); setReversalReason('') }} type="button">عكس السجل</button>}</div></div>{reversingId === record.id && <div className="mt-4 flex flex-wrap gap-3 rounded-xl bg-rose-50 p-4"><input aria-label="سبب عكس الصيانة" className={`${inputClass} flex-1`} maxLength={1000} onChange={(event) => setReversalReason(event.target.value)} placeholder="اكتب سبب العكس بوضوح" value={reversalReason} /><button className="min-h-14 rounded-xl bg-rose-700 px-6 font-black text-white disabled:opacity-50" disabled={!reversalReason.trim() || saving} onClick={() => void submitReversal(record)} type="button">تأكيد العكس</button><button className="min-h-14 rounded-xl px-5 font-black" onClick={() => setReversingId(null)} type="button">إلغاء</button></div>}</article>)}</div>}
        <nav aria-label="صفحات سجل الصيانة" className="mt-4 flex justify-center gap-3"><button className="min-h-11 rounded-xl border px-5 font-black disabled:opacity-40" disabled={loading || recordPage === 1} onClick={() => void loadRecords(search, filterDate, recordPage - 1)} type="button">السابق</button><span className="self-center font-black">صفحة {recordPage}</span><button className="min-h-11 rounded-xl border px-5 font-black disabled:opacity-40" disabled={loading || !hasMoreRecords} onClick={() => void loadRecords(search, filterDate, recordPage + 1)} type="button">التالي</button></nav>
      </section>
    </section>
  )
}
