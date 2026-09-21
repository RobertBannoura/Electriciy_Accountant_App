import {
  calculatePayment,
  Currency,
  newPayment,
  normalizePaymentDecimal,
  PaymentDraft,
} from '../payments/payment-draft'

export type { PaymentDraft } from '../payments/payment-draft'
const inputClass = 'min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-black outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100'

export function PaymentEditor({
  payments,
  onChange,
  businessDate,
}: {
  payments: PaymentDraft[]
  onChange: (payments: PaymentDraft[]) => void
  businessDate: string
}) {
  function update(id: string, values: Partial<PaymentDraft>) {
    onChange(payments.map((payment) => payment.id === id ? { ...payment, ...values } : payment))
  }

  return (
    <section aria-labelledby="maintenance-payment-title" className="rounded-2xl border-2 border-teal-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black" id="maintenance-payment-title">طريقة الدفع</h2>
          <p className="text-sm font-bold text-slate-500">يمكن الجمع بين أكثر من طريقة</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="min-h-11 rounded-xl bg-emerald-700 px-4 font-black text-white hover:bg-emerald-800" onClick={() => onChange([...payments, newPayment('cash', businessDate)])} type="button">+ نقدي</button>
          <button className="min-h-11 rounded-xl bg-sky-700 px-4 font-black text-white hover:bg-sky-800" onClick={() => onChange([...payments, newPayment('bank_card', businessDate)])} type="button">+ بطاقة / بنك</button>
          <button className="min-h-11 rounded-xl bg-violet-700 px-4 font-black text-white hover:bg-violet-800" onClick={() => onChange([...payments, newPayment('check', businessDate)])} type="button">+ شيك</button>
          <button className="min-h-11 rounded-xl bg-fuchsia-700 px-4 font-black text-white hover:bg-fuchsia-800" onClick={() => onChange([...payments, newPayment('check', businessDate, true)])} type="button">+ شيك جيرو</button>
        </div>
      </div>

      {payments.length === 0 ? (
        <p className="mt-3 rounded-xl bg-slate-50 p-3 text-center font-bold text-slate-600">لم تُضف دفعة بعد. المبلغ غير المدفوع يصبح ديناً عند اختيار عميل.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {payments.map((payment, index) => {
            const calculation = calculatePayment(payment)
            const foreign = payment.method === 'cash' && payment.currency !== 'ILS'
            return (
              <div className="rounded-xl border-2 border-slate-200 p-3" key={payment.id}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="font-black">{index + 1}. {payment.method === 'cash' ? 'نقدي' : payment.method === 'bank_card' ? 'بطاقة / بنك' : payment.isGiro ? 'شيك جيرو' : 'شيك'}</h3>
                  <button className="min-h-9 rounded-lg px-3 text-sm font-black text-rose-700 hover:bg-rose-50" onClick={() => onChange(payments.filter((row) => row.id !== payment.id))} type="button">حذف الدفعة</button>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {payment.method === 'cash' && <label><span className="mb-1 block text-sm font-black">العملة</span><select className={inputClass} onChange={(event) => update(payment.id, { currency: event.target.value as Currency, exchangeRate: '' })} value={payment.currency}><option value="ILS">₪</option><option value="USD">دولار</option><option value="JOD">دينار</option></select></label>}
                  <label><span className="mb-1 block text-sm font-black">المبلغ</span><input className={inputClass} inputMode="decimal" onBlur={(event) => update(payment.id, { amount: normalizePaymentDecimal(event.target.value, foreign ? 6 : 2) })} onChange={(event) => update(payment.id, { amount: event.target.value })} placeholder="0" value={payment.amount} /></label>
                  {foreign && <label><span className="mb-2 block font-black">سعر الصرف اليدوي</span><input className={inputClass} inputMode="decimal" onBlur={(event) => update(payment.id, { exchangeRate: normalizePaymentDecimal(event.target.value, 6) })} onChange={(event) => update(payment.id, { exchangeRate: event.target.value })} placeholder="مثال: 3.00" value={payment.exchangeRate} /></label>}
                  {payment.method === 'bank_card' && <label><span className="mb-2 block font-black">المرجع (اختياري)</span><input className={inputClass} maxLength={200} onChange={(event) => update(payment.id, { reference: event.target.value })} value={payment.reference} /></label>}
                  {payment.method === 'check' && <><label><span className="mb-2 block font-black">رقم الشيك *</span><input className={inputClass} maxLength={100} onChange={(event) => update(payment.id, { checkNumber: event.target.value })} value={payment.checkNumber} /></label><label><span className="mb-2 block font-black">تاريخ الاستحقاق *</span><input className={inputClass} onChange={(event) => update(payment.id, { dueDate: event.target.value })} type="date" value={payment.dueDate} /></label><label><span className="mb-2 block font-black">ملاحظات — اختياري</span><input className={inputClass} maxLength={2000} onChange={(event) => update(payment.id, { notes: event.target.value })} value={payment.notes} /></label></>}
                  {payment.method === 'check' && payment.isGiro && <><label><span className="mb-2 block font-black">اسم صاحب الشيك الأصلي *</span><input className={inputClass} maxLength={150} onChange={(event) => update(payment.id, { originalOwnerName: event.target.value })} value={payment.originalOwnerName} /></label><label><span className="mb-2 block font-black">رقم هاتف صاحب الشيك الأصلي *</span><input className={inputClass} inputMode="tel" maxLength={50} onChange={(event) => update(payment.id, { originalOwnerPhone: event.target.value })} value={payment.originalOwnerPhone} /></label></>}
                  <div className="rounded-xl bg-slate-900 p-3 text-white"><p className="font-bold text-slate-300">يعادل بـ ₪</p><p className="mt-1 text-2xl font-black" dir="ltr">{calculation.amount ? `₪${calculation.amount.toFixed()}` : '—'}</p>{calculation.error && <p className="mt-1 text-sm font-bold text-rose-300">{calculation.error}</p>}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
