import Decimal from 'decimal.js'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api'
import { formatDecimal } from '../money-display'
import { customerRemindersChanged, useCustomerReminders } from '../hooks/useCustomerReminders'
import type { CustomerReminder } from '../hooks/useCustomerReminders'
import { PaymentPromiseDialog } from './PaymentPromiseDialog'

export function CustomerDebtReminders({ storeId, isOnline }: { storeId: string | null; isOnline: boolean }) {
  const { data, error } = useCustomerReminders(storeId, isOnline)
  const [editing, setEditing] = useState<CustomerReminder | null | undefined>()
  const [acting, setActing] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  if (!storeId) return null
  const activeStoreId = storeId
  async function completeEmptyPromise(customer: CustomerReminder) {
    setActing(customer.id)
    setActionError(null)
    try {
      const response = await apiFetch(`/customers/${customer.id}/payment-promise/complete`, {
        method: 'POST', headers: { 'X-Store-Id': activeStoreId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: customer.payment_promise_version }),
      })
      if (!response.ok) {
        const payload = await response.json() as { error?: { message?: string } }
        throw new Error(payload.error?.message ?? 'تعذّر إنهاء الوعد')
      }
      window.dispatchEvent(new Event(customerRemindersChanged))
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : 'تعذّر إنهاء الوعد') }
    finally { setActing(null) }
  }
  const customers = data?.customers ?? []
  const dueCount = customers.filter((customer) => customer.needs_notification).length
  return (
    <section aria-labelledby="customer-debt-reminders-title" className="mb-7 overflow-hidden rounded-3xl border border-amber-200 bg-amber-50 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 px-4 py-3 sm:px-5">
        <h2 className="text-xl font-black text-amber-950" id="customer-debt-reminders-title">تذكيرات الدفع{dueCount > 0 ? ` · ${dueCount} للمتابعة` : ''}</h2>
        <button className="min-h-11 rounded-xl bg-teal-700 px-4 font-black text-white disabled:opacity-50" disabled={!isOnline} onClick={() => setEditing(null)} type="button">+ وعد جديد</button>
      </div>
      {error && <p className="p-5 font-bold text-rose-800" role="alert">تعذّر تحديث التذكيرات. ستتم إعادة المحاولة تلقائياً.</p>}
      {actionError && <p className="p-5 font-bold text-rose-800" role="alert">{actionError}</p>}
      {!data && !error && <p className="p-5" role="status">جارٍ تحميل التذكيرات…</p>}
      {data && customers.length === 0 && !error && <p className="p-4 font-bold text-slate-600">لا توجد تذكيرات حالياً.</p>}
      <div className={customers.length ? 'grid max-h-[36rem] gap-3 overflow-y-auto p-4 sm:grid-cols-2 sm:p-5' : ''}>
        {customers.map((customer) => (
          <article className="rounded-2xl border border-amber-200 bg-white p-4" key={customer.id}>
            <Link className="block break-words text-lg font-black text-slate-900 hover:text-teal-800" to={`/customers/${customer.id}`}>{customer.name}</Link>
            <p className="mt-1 font-bold text-slate-700">الدين: <span dir="ltr">₪{formatDecimal(customer.balance_ils)}</span></p>
            <div className="mt-2 flex flex-wrap gap-2 text-sm font-bold">
              {customer.limit_reached && <span className="rounded-lg bg-rose-50 px-2 py-1 text-rose-800">بلغ حد الدين</span>}
              {customer.payment_promise_date && <span className={`rounded-lg px-2 py-1 ${customer.promise_due ? 'bg-rose-50 text-rose-800' : 'bg-teal-50 text-teal-800'}`}>
                {customer.promise_due ? 'وعد مستحق' : 'وعد الدفع'} · <span dir="ltr">{customer.payment_promise_date}</span>
              </span>}
            </div>
            {customer.payment_promise_note && <p className="mt-2 break-words text-sm text-slate-600">{customer.payment_promise_note}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              {customer.phone && <a aria-label={`اتصال بـ ${customer.name}: ${customer.phone}`} className="inline-flex min-h-10 items-center rounded-lg bg-amber-100 px-3 font-bold text-amber-950" href={`tel:${customer.phone.replace(/[^+\d*#]/g, '')}`}>اتصال</a>}
              {new Decimal(customer.balance_ils).greaterThan(0)
                ? <Link className="inline-flex min-h-10 items-center rounded-lg bg-teal-700 px-3 font-bold text-white" to={`/customers/${customer.id}/payment?storeId=${storeId}${customer.payment_promise_date ? `&completePromise=${customer.payment_promise_version}` : ''}`}>{customer.payment_promise_date ? 'تسجيل دفعة وإنهاء الوعد' : 'تسجيل دفعة'}</Link>
                : <button className="min-h-10 rounded-lg bg-teal-700 px-3 font-bold text-white disabled:opacity-50" disabled={!isOnline || acting !== null} onClick={() => void completeEmptyPromise(customer)} type="button">{acting === customer.id ? 'جارٍ الإنهاء…' : 'إنهاء الوعد'}</button>}
              <button className="min-h-10 rounded-lg border border-slate-300 px-3 font-bold disabled:opacity-50" disabled={!isOnline || acting !== null} onClick={() => setEditing(customer)} type="button">{customer.payment_promise_date ? 'تغيير الموعد' : 'وعد بالدفع'}</button>
            </div>
          </article>
        ))}
      </div>
      {editing !== undefined && <PaymentPromiseDialog customer={editing ?? undefined} initialDate={editing?.payment_promise_date ?? ''} initialNote={editing?.payment_promise_note ?? ''} onClose={() => setEditing(undefined)} onSaved={() => setEditing(undefined)} storeId={storeId} />}
    </section>
  )
}
