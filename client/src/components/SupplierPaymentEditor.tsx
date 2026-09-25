import { formatDecimal } from '../money-display'
import {
  calculateSupplierPayment,
  newSupplierPayment,
  SupplierPaymentDraft,
  SupplierPaymentMethod,
  TransferableCheck,
} from '../payments/supplier-payment-draft'

const inputClass = 'min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-lg font-black outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100'
export function SupplierPaymentEditor({
  payments,
  checks,
  businessDate,
  onChange,
  allowEmpty = false,
}: {
  payments: SupplierPaymentDraft[]
  checks: TransferableCheck[]
  businessDate: string
  onChange: (payments: SupplierPaymentDraft[]) => void
  allowEmpty?: boolean
}) {
  function add(method: SupplierPaymentMethod) {
    onChange([...payments, newSupplierPayment(method, businessDate)])
  }
  function update(id: string, values: Partial<SupplierPaymentDraft>) {
    onChange(payments.map((payment) => payment.id === id ? { ...payment, ...values } : payment))
  }
  const chosenChecks = new Set(payments.map((payment) => payment.checkId).filter(Boolean))

  return (
    <section className="rounded-3xl border-2 border-violet-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><h2 className="text-2xl font-black">دفعات المورد</h2><p className="mt-1 font-bold text-slate-600">يمكن الجمع بين أكثر من طريقة. غير المدفوع يبقى ديناً للمورد.</p></div>
        <div className="flex flex-wrap gap-2">
          <button className="min-h-11 rounded-xl bg-emerald-700 px-4 font-black text-white" onClick={() => add('cash')} type="button">+ نقد</button>
          <button className="min-h-11 rounded-xl bg-sky-700 px-4 font-black text-white" onClick={() => add('bank')} type="button">+ بنك</button>
          <button className="min-h-11 rounded-xl bg-violet-700 px-4 font-black text-white" onClick={() => add('owner_check')} type="button">+ شيك المنشأة</button>
          <button className="min-h-11 rounded-xl bg-fuchsia-700 px-4 font-black text-white" disabled={checks.length === 0} onClick={() => add('transferred_customer_check')} type="button">+ تحويل شيك عميل</button>
        </div>
      </div>
      {payments.length === 0 ? <p className="mt-5 rounded-2xl bg-slate-50 p-4 text-center font-bold text-slate-600">{allowEmpty ? 'لا توجد دفعة فورية؛ كامل الفاتورة سيصبح ديناً.' : 'أضف طريقة دفع واحدة على الأقل.'}</p> : (
        <div className="mt-5 space-y-4">
          {payments.map((payment, index) => {
            const calculated = calculateSupplierPayment(payment, checks)
            return (
              <article className="rounded-2xl border-2 border-slate-200 p-4" key={payment.id}>
                <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-black">{index + 1}. {methodLabel(payment.method)}</h3><button className="min-h-10 rounded-xl px-3 font-black text-rose-700 hover:bg-rose-50" onClick={() => onChange(payments.filter((item) => item.id !== payment.id))} type="button">حذف</button></div>
                <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {payment.method === 'transferred_customer_check' ? (
                    <label className="md:col-span-2"><span className="mb-2 block font-black">شيك العميل</span><select className={inputClass} onChange={(event) => update(payment.id, { checkId: event.target.value })} value={payment.checkId}><option value="">اختر شيكاً موجوداً قيد التحصيل</option>{checks.filter((check) => check.id === payment.checkId || !chosenChecks.has(check.id)).map((check) => <option key={check.id} value={check.id}>{check.check_number} — {check.customer_name ?? 'عميل'} — ₪{formatDecimal(check.amount)} — {check.due_date}</option>)}</select></label>
                  ) : <label><span className="mb-2 block font-black">المبلغ (₪)</span><input className={inputClass} inputMode="decimal" onChange={(event) => update(payment.id, { amount: event.target.value })} value={payment.amount} /></label>}
                  {payment.method === 'bank' && <label><span className="mb-2 block font-black">مرجع البنك (اختياري)</span><input className={inputClass} maxLength={200} onChange={(event) => update(payment.id, { reference: event.target.value })} value={payment.reference} /></label>}
                  {payment.method === 'owner_check' && <><label><span className="mb-2 block font-black">رقم الشيك</span><input className={inputClass} maxLength={100} onChange={(event) => update(payment.id, { checkNumber: event.target.value })} value={payment.checkNumber} /></label><label><span className="mb-2 block font-black">تاريخ الاستحقاق</span><input className={inputClass} onChange={(event) => update(payment.id, { dueDate: event.target.value })} type="date" value={payment.dueDate} /></label></>}
                  <div className="rounded-xl bg-slate-900 p-3 text-white"><p className="font-bold text-slate-300">القيمة</p><p className="mt-1 text-xl font-black" dir="ltr">₪{calculated.amount ? formatDecimal(calculated.amount.toFixed()) : '—'}</p></div>
                </div>
                {calculated.error && <p className="mt-3 font-black text-rose-700">{calculated.error}</p>}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function methodLabel(method: SupplierPaymentMethod) {
  if (method === 'cash') return 'نقد'
  if (method === 'bank') return 'بنك'
  if (method === 'owner_check') return 'شيك المنشأة'
  return 'شيك عميل محوّل'
}
