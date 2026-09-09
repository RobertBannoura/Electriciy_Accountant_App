import Decimal from 'decimal.js'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiFetch, storeScopedApiFetch } from '../api'
import { Store } from '../types'
import { formatDecimal } from '../money-display'

type PaymentMethod = 'cash' | 'bank_card' | 'check'
type Currency = 'ILS' | 'USD' | 'JOD'
type Customer = { id: string; name: string; balance_ils: string }
type PaymentDraft = {
  id: string
  method: PaymentMethod
  currency: Currency
  amount: string
  exchangeRate: string
  reference: string
  checkNumber: string
  dueDate: string
  notes: string
  isGiro: boolean
  originalOwnerName: string
  originalOwnerPhone: string
}

const PaymentDecimal = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP })
const arabicDigits = '٠١٢٣٤٥٦٧٨٩'
const persianDigits = '۰۱۲۳۴۵۶۷۸۹'
const inputClass = 'min-h-13 w-full rounded-xl border border-slate-300 bg-white px-4 text-lg font-black outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100'

function currentBusinessDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function newPayment(method: PaymentMethod, isGiro = false): PaymentDraft {
  return {
    id: crypto.randomUUID(), method, currency: 'ILS', amount: '', exchangeRate: '',
    reference: '', checkNumber: '', dueDate: currentBusinessDate(), notes: '', isGiro,
    originalOwnerName: '', originalOwnerPhone: '',
  }
}

function parseDecimal(value: string, maximumScale: number) {
  const normalized = value.trim()
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)))
    .replace(/٫/g, '.')
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(normalized)
  if (!match || (match[1]?.length ?? 0) > maximumScale) return null
  return new PaymentDecimal(normalized)
}

function normalized(value: string, maximumScale: number) {
  return parseDecimal(value, maximumScale)?.toFixed() ?? value
}

function isHalfShekel(value: Decimal) {
  return value.mod('0.5').isZero()
}

function calculatePayment(payment: PaymentDraft) {
  const foreign = payment.method === 'cash' && payment.currency !== 'ILS'
  const amount = parseDecimal(payment.amount, foreign ? 6 : 2)
  if (!amount || !amount.greaterThan(0)) return { amount: null, error: 'أدخل مبلغاً أكبر من صفر' }
  if (!foreign && !isHalfShekel(amount)) {
    return { amount: null, error: 'المبلغ بالشيكل يجب أن يكون بمضاعفات 0.50' }
  }
  if (payment.method === 'check' && !payment.checkNumber.trim()) {
    return { amount: null, error: 'رقم الشيك مطلوب' }
  }
  if (payment.method === 'check' && !payment.dueDate) {
    return { amount: null, error: 'تاريخ استحقاق الشيك مطلوب' }
  }
  if (payment.method === 'check' && payment.isGiro && !payment.originalOwnerName.trim()) {
    return { amount: null, error: 'اسم صاحب الشيك الأصلي مطلوب' }
  }
  if (payment.method === 'check' && payment.isGiro && !payment.originalOwnerPhone.trim()) {
    return { amount: null, error: 'رقم هاتف صاحب الشيك الأصلي مطلوب' }
  }
  if (!foreign) return { amount, error: null }

  const rate = parseDecimal(payment.exchangeRate, 6)
  if (!rate || !rate.greaterThan(0)) {
    return { amount: null, error: 'أدخل سعر الصرف يدوياً' }
  }
  return { amount: amount.mul(rate), error: null }
}

async function errorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } }
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch {
    // Use the stable Arabic fallback.
  }
  return 'تعذّر تسجيل الدفعة. حاول مرة أخرى.'
}

export function CustomerPaymentPage({
  defaultStoreId,
  onDraftStateChange,
  stores,
}: {
  defaultStoreId: string | null
  onDraftStateChange: (active: boolean) => void
  stores: Store[]
}) {
  const { customerId = '' } = useParams()
  const operatingStoreId = stores.some((store) => store.id === defaultStoreId)
    ? defaultStoreId!
    : ''
  const operatingStore = stores.find((store) => store.id === operatingStoreId)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [payments, setPayments] = useState<PaymentDraft[]>(() => [newPayment('cash')])
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!operatingStoreId || !customerId) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    const headers = new Headers({ 'X-Store-Id': operatingStoreId })
    apiFetch(`/customers/${customerId}`, { headers, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorMessage(response))
        return response.json() as Promise<{ customer: Customer }>
      })
      .then((payload) => setCustomer(payload.customer))
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setError(caught instanceof Error ? caught.message : 'تعذّر تحميل العميل')
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [customerId, operatingStoreId])

  const calculations = useMemo(
    () => new Map(payments.map((payment) => [payment.id, calculatePayment(payment)])),
    [payments],
  )
  const paidTotal = useMemo(() => {
    const values = payments.map((payment) => calculations.get(payment.id)?.amount ?? null)
    if (values.some((value) => value === null)) return null
    return values.reduce<Decimal>((sum, value) => sum.plus(value!), new PaymentDecimal(0))
  }, [calculations, payments])
  const debt = customer ? new PaymentDecimal(customer.balance_ils) : null
  const balanceAfter = debt && paidTotal ? debt.minus(paidTotal) : null
  const overpayment = balanceAfter?.lessThan(0) ?? false
  const canSave = Boolean(
    customer && debt?.greaterThan(0) && payments.length > 0 && paidTotal
      && paidTotal.greaterThan(0) && !overpayment && !saving,
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
  const hasUnsavedDraft = Boolean(notes.trim() || hasPaymentDraft)

  useEffect(() => onDraftStateChange(hasUnsavedDraft), [hasUnsavedDraft, onDraftStateChange])
  useEffect(() => () => onDraftStateChange(false), [onDraftStateChange])

  function updatePayment(id: string, values: Partial<PaymentDraft>) {
    setPayments((current) => current.map((payment) => (
      payment.id === id ? { ...payment, ...values } : payment
    )))
    setMessage(null)
  }

  async function submitPayment() {
    if (!canSave || !customer) return
    setSaving(true)
    setError(null)
    setMessage('جارٍ تسجيل الدفعة…')
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: notes.trim() || null,
          payments: payments.map((payment) => ({
            method: payment.method,
            currency: payment.method === 'cash' ? payment.currency : 'ILS',
            amount: normalized(
              payment.amount,
              payment.method === 'cash' && payment.currency !== 'ILS' ? 6 : 2,
            ),
            ...(payment.method === 'cash' && payment.currency !== 'ILS'
              ? { exchangeRate: normalized(payment.exchangeRate, 6) }
              : {}),
            ...(payment.method === 'bank_card'
              ? { reference: payment.reference.trim() || null }
              : {}),
            ...(payment.method === 'check'
              ? {
                  checkNumber: payment.checkNumber.trim(),
                  dueDate: payment.dueDate,
                  notes: payment.notes.trim() || null,
                  isGiro: payment.isGiro,
                  ...(payment.isGiro
                    ? {
                        originalOwnerName: payment.originalOwnerName.trim(),
                        originalOwnerPhone: payment.originalOwnerPhone.trim(),
                      }
                    : {}),
                }
              : {}),
          })),
        }),
      }
      const response = window.desktop
        ? await storeScopedApiFetch(`/customers/${customer.id}/payments`, init)
        : await apiFetch(`/customers/${customer.id}/payments`, {
            ...init,
            headers: { ...init.headers, 'X-Store-Id': operatingStoreId },
          })
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as {
        payment: { total_ils: string; balance_after_ils: string }
      }
      setCustomer({ ...customer, balance_ils: payload.payment.balance_after_ils })
      setPayments([newPayment('cash')])
      setNotes('')
      setMessage(`تم تسجيل ₪${formatDecimal(payload.payment.total_ils)}. الرصيد المتبقي ₪${formatDecimal(payload.payment.balance_after_ils)}.`)
    } catch (caught) {
      setMessage(null)
      setError(caught instanceof Error ? caught.message : 'تعذّر تسجيل الدفعة')
    } finally {
      setSaving(false)
    }
  }

  if (!operatingStoreId) return <PaymentState text={window.desktop ? 'يجب تحديد متجر هذا الجهاز من الإعدادات أولاً.' : 'اختر المحل الحالي من أعلى الصفحة قبل تسجيل الدفعة.'} />
  if (loading) return <PaymentState text="جارٍ تحميل حساب العميل…" />
  if (!customer) return <PaymentState error text={error ?? 'العميل غير موجود'} />

  return (
    <section aria-labelledby="customer-payment-title">
      <Link className="font-black text-teal-700 hover:text-teal-900" to={`/customers/${customer.id}`}>← العودة إلى ملف العميل</Link>
      <div className="mt-5 flex flex-wrap items-start justify-between gap-5 rounded-3xl bg-slate-900 p-6 text-white sm:p-8">
        <div>
          <p className="font-bold text-teal-300">{operatingStore?.name ?? 'المتجر الحالي'}</p>
          <h1 className="mt-1 text-3xl font-black sm:text-4xl" id="customer-payment-title">تسجيل دفعة</h1>
          <p className="mt-3 text-xl font-bold">{customer.name}</p>
        </div>
        <div className="rounded-2xl bg-white/10 px-6 py-4 text-center">
          <p className="font-bold text-slate-300">الدين الحالي</p>
          <p className="mt-1 text-3xl font-black" dir="ltr">₪{formatDecimal(customer.balance_ils)}</p>
        </div>
      </div>

      <div aria-live="polite">
        {message && <p className="mt-5 rounded-xl bg-emerald-50 p-4 text-lg font-black text-emerald-900" role="status">{message}</p>}
        {error && <p className="mt-5 rounded-xl bg-rose-50 p-4 text-lg font-black text-rose-900" role="alert">{error}</p>}
      </div>

      <div className="mt-6 rounded-3xl border-2 border-teal-200 bg-white p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black">تفصيل الدفعة</h2>
            <p className="mt-1 font-bold text-slate-600">يمكن جمع أكثر من طريقة في عملية واحدة.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="min-h-13 rounded-xl bg-emerald-700 px-5 text-lg font-black text-white" onClick={() => setPayments((current) => [...current, newPayment('cash')])} type="button">+ نقدي</button>
            <button className="min-h-13 rounded-xl bg-sky-700 px-5 text-lg font-black text-white" onClick={() => setPayments((current) => [...current, newPayment('bank_card')])} type="button">+ بطاقة / بنك</button>
            <button className="min-h-13 rounded-xl bg-violet-700 px-5 text-lg font-black text-white" onClick={() => setPayments((current) => [...current, newPayment('check')])} type="button">+ شيك</button>
            <button className="min-h-13 rounded-xl bg-fuchsia-700 px-5 text-lg font-black text-white" onClick={() => setPayments((current) => [...current, newPayment('check', true)])} type="button">+ شيك جيرو</button>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          {payments.map((payment, index) => {
            const calculation = calculations.get(payment.id)!
            const foreign = payment.method === 'cash' && payment.currency !== 'ILS'
            return (
              <article className="rounded-2xl border-2 border-slate-200 p-4" key={payment.id}>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-xl font-black">{index + 1}. {payment.method === 'cash' ? 'نقدي' : payment.method === 'bank_card' ? 'بطاقة / بنك' : payment.isGiro ? 'شيك جيرو' : 'شيك'}</h3>
                  <button className="min-h-11 rounded-xl px-4 font-black text-rose-700 hover:bg-rose-50" disabled={payments.length === 1} onClick={() => setPayments((current) => current.filter((item) => item.id !== payment.id))} type="button">حذف</button>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {payment.method === 'cash' && <PaymentField label="عملة النقد"><select className={inputClass} onChange={(event) => updatePayment(payment.id, { currency: event.target.value as Currency, exchangeRate: '' })} value={payment.currency}><option value="ILS">شيكل</option><option value="USD">دولار</option><option value="JOD">دينار</option></select></PaymentField>}
                  <PaymentField label={foreign ? 'المبلغ الأصلي' : 'المبلغ بالشيكل'}><input className={inputClass} inputMode="decimal" onBlur={(event) => updatePayment(payment.id, { amount: normalized(event.target.value, foreign ? 6 : 2) })} onChange={(event) => updatePayment(payment.id, { amount: event.target.value })} placeholder="0" value={payment.amount} /></PaymentField>
                  {foreign && <PaymentField label="سعر الصرف اليدوي"><input className={inputClass} inputMode="decimal" onBlur={(event) => updatePayment(payment.id, { exchangeRate: normalized(event.target.value, 6) })} onChange={(event) => updatePayment(payment.id, { exchangeRate: event.target.value })} placeholder="مثال: 3.00" value={payment.exchangeRate} /></PaymentField>}
                  {payment.method === 'bank_card' && <PaymentField label="مرجع العملية (اختياري)"><input className={inputClass} maxLength={200} onChange={(event) => updatePayment(payment.id, { reference: event.target.value })} value={payment.reference} /></PaymentField>}
                  {payment.method === 'check' && <><PaymentField label="رقم الشيك"><input className={inputClass} maxLength={100} onChange={(event) => updatePayment(payment.id, { checkNumber: event.target.value })} value={payment.checkNumber} /></PaymentField><PaymentField label="تاريخ الاستحقاق"><input className={inputClass} onChange={(event) => updatePayment(payment.id, { dueDate: event.target.value })} type="date" value={payment.dueDate} /></PaymentField><PaymentField label="ملاحظات — اختياري"><input className={inputClass} maxLength={2000} onChange={(event) => updatePayment(payment.id, { notes: event.target.value })} value={payment.notes} /></PaymentField></>}
                  {payment.method === 'check' && payment.isGiro && <><PaymentField label="اسم صاحب الشيك الأصلي"><input className={inputClass} maxLength={150} onChange={(event) => updatePayment(payment.id, { originalOwnerName: event.target.value })} value={payment.originalOwnerName} /></PaymentField><PaymentField label="رقم هاتف صاحب الشيك الأصلي"><input className={inputClass} inputMode="tel" maxLength={50} onChange={(event) => updatePayment(payment.id, { originalOwnerPhone: event.target.value })} value={payment.originalOwnerPhone} /></PaymentField></>}
                  <div className="rounded-xl bg-slate-100 p-3"><p className="font-bold text-slate-600">القيمة بالشيكل</p><p className="mt-1 text-xl font-black text-teal-900" dir="ltr">₪{calculation.amount?.toFixed() ?? '—'}</p></div>
                </div>
                {calculation.error && <p className="mt-3 font-black text-rose-700">{calculation.error}</p>}
              </article>
            )
          })}
        </div>

        <PaymentField label="ملاحظات (اختياري)"><textarea className={`${inputClass} mt-5 min-h-24 py-3`} maxLength={2000} onChange={(event) => setNotes(event.target.value)} value={notes} /></PaymentField>
      </div>

      <div className="mt-6 grid gap-5 rounded-3xl border-2 border-slate-200 bg-white p-5 shadow-sm lg:grid-cols-[1fr_24rem] sm:p-7">
        <div className="self-center">
          {overpayment && <p className="rounded-xl bg-rose-50 p-4 text-lg font-black text-rose-800">الدفعة أكبر من دين العميل. خفّض أحد المبالغ.</p>}
          {!debt?.greaterThan(0) && <p className="rounded-xl bg-emerald-50 p-4 text-lg font-black text-emerald-900">لا يوجد دين مستحق على هذا العميل.</p>}
          <p className="mt-3 leading-7 text-slate-600">النقد يدخل صندوق عملته، والبطاقة تدخل دفتر البنك، ويخفض الشيك الدين فوراً. تُحفظ العملية كاملة أو تُلغى كاملة عند الخطأ.</p>
        </div>
        <div className="rounded-2xl bg-slate-100 p-5">
          <SummaryRow label="الدين قبل الدفعة" value={debt} />
          <SummaryRow label="مجموع الدفعة" value={paidTotal} />
          <div className="mt-4 border-t-2 border-slate-300 pt-4"><SummaryRow large label="المتبقي بعد الدفعة" value={balanceAfter} /></div>
          <button className={`mt-5 min-h-16 w-full rounded-2xl px-6 text-xl font-black ${canSave ? 'bg-teal-700 text-white hover:bg-teal-800' : 'cursor-not-allowed bg-slate-300 text-slate-600'}`} disabled={!canSave} onClick={() => void submitPayment()} type="button">{saving ? 'جارٍ التسجيل…' : 'تسجيل الدفعة'}</button>
        </div>
      </div>
    </section>
  )
}

function PaymentField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-2 block font-black">{label}</span>{children}</label>
}

function SummaryRow({ label, value, large = false }: { label: string; value: Decimal | null; large?: boolean }) {
  return <div className={`flex items-center justify-between gap-4 ${large ? 'text-2xl font-black text-teal-900' : 'mt-3 text-lg font-bold'}`}><span>{label}</span><span dir="ltr">₪{value?.toFixed() ?? '—'}</span></div>
}

function PaymentState({ text, error = false }: { text: string; error?: boolean }) {
  return <p className={`rounded-2xl p-8 text-center text-lg font-black ${error ? 'bg-rose-50 text-rose-800' : 'bg-white text-slate-600'}`} role={error ? 'alert' : 'status'}>{text}</p>
}
