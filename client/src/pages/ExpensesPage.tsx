import { FormEvent, useCallback, useEffect, useState } from 'react'
import { apiFetch, storeScopedApiFetch } from '../api'
import { formatDecimal } from '../money-display'
import { Store } from '../types'

type Expense = { id: string; category: string; amount: string; date: string; payment_method: 'cash' | 'bank_card'; notes: string | null; store_name: string }
const defaultCategories = ['كهرباء', 'أجار', 'رواتب', 'مواصلات', 'صيانة', 'مشتريات للمحل', 'أخرى']
const inputClass = 'min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100'

function today() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
function scopedFetch(path: string, storeId: string | null, init?: RequestInit) {
  if (window.desktop) return storeScopedApiFetch(path, init)
  const headers = new Headers(init?.headers); if (storeId) headers.set('X-Store-Id', storeId)
  return apiFetch(path, { ...init, headers })
}
async function errorMessage(response: Response) {
  try { const payload = (await response.json()) as { error?: { message?: unknown } }; if (typeof payload.error?.message === 'string') return payload.error.message } catch { /* fallback */ }
  return 'تعذر إكمال العملية.'
}

export function ExpensesPage({ configuredStoreId, onDraftStateChange, stores }: { configuredStoreId: string | null; onDraftStateChange: (active: boolean) => void; stores: Store[] }) {
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState(defaultCategories[0])
  const [date, setDate] = useState(today())
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank'>('cash')
  const [notes, setNotes] = useState('')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const store = stores.find((item) => item.id === configuredStoreId)
  const load = useCallback(async () => {
    if (!configuredStoreId && !window.desktop) return
    const response = await scopedFetch('/expenses', configuredStoreId)
    if (!response.ok) throw new Error(await errorMessage(response))
    const payload = (await response.json()) as { expenses: Expense[] }
    setExpenses(payload.expenses)
  }, [configuredStoreId])
  useEffect(() => { void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'تعذر تحميل المصاريف')) }, [load])
  useEffect(() => { onDraftStateChange(Boolean(amount || notes)); return () => onDraftStateChange(false) }, [amount, notes, onDraftStateChange])
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null); setSuccess(null)
    try {
      const response = await scopedFetch('/expenses', configuredStoreId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, category, date, paymentMethod, notes }) })
      if (!response.ok) throw new Error(await errorMessage(response))
      setSuccess('تم تسجيل المصروف وخصمه من الرصيد الصحيح.'); setAmount(''); setNotes(''); onDraftStateChange(false); await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'تعذر حفظ المصروف') } finally { setSaving(false) }
  }
  return <section aria-labelledby="expenses-title"><div className="rounded-3xl bg-slate-900 p-6 text-white"><p className="font-bold text-violet-300">المتجر: {store?.name ?? 'المتجر الحالي'}</p><h1 className="mt-1 text-3xl font-black" id="expenses-title">المصاريف</h1></div>{!configuredStoreId && !window.desktop && <p className="mt-5 rounded-xl bg-amber-50 p-4 font-bold text-amber-900">اختر المتجر الحالي أولاً.</p>}<form className="mt-6 grid gap-5 rounded-2xl border bg-white p-5 sm:grid-cols-2" onSubmit={submit}><label><span className="mb-2 block font-black">المبلغ</span><input className={inputClass} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} required value={amount} /></label><label><span className="mb-2 block font-black">التصنيف</span><select className={inputClass} onChange={(event) => setCategory(event.target.value)} value={category}>{defaultCategories.map((item) => <option key={item}>{item}</option>)}</select></label><label><span className="mb-2 block font-black">المتجر</span><input className={inputClass} disabled value={store?.name ?? 'المتجر الحالي'} /></label><label><span className="mb-2 block font-black">التاريخ</span><input className={inputClass} onChange={(event) => setDate(event.target.value)} required type="date" value={date} /></label><label><span className="mb-2 block font-black">طريقة الدفع</span><select className={inputClass} onChange={(event) => setPaymentMethod(event.target.value as 'cash' | 'bank')} value={paymentMethod}><option value="cash">نقداً</option><option value="bank">بنك</option></select></label><label><span className="mb-2 block font-black">ملاحظات اختيارية</span><input className={inputClass} maxLength={1000} onChange={(event) => setNotes(event.target.value)} value={notes} /></label>{error && <p className="rounded-xl bg-rose-50 p-4 font-bold text-rose-800 sm:col-span-2" role="alert">{error}</p>}{success && <p className="rounded-xl bg-emerald-50 p-4 font-bold text-emerald-900 sm:col-span-2" role="status">{success}</p>}<button className="min-h-14 rounded-xl bg-teal-700 px-7 text-lg font-black text-white disabled:opacity-50 sm:col-span-2 sm:justify-self-start" disabled={saving || (!configuredStoreId && !window.desktop)} type="submit">{saving ? 'جارٍ الحفظ…' : 'تسجيل المصروف'}</button></form><h2 className="mt-8 text-2xl font-black">آخر المصاريف</h2><div className="mt-3 overflow-hidden rounded-2xl border bg-white">{expenses.length === 0 ? <p className="p-5 text-slate-600">لا توجد مصاريف مسجلة.</p> : expenses.map((expense) => <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 last:border-0" key={expense.id}><div><p className="font-black">{expense.category}</p><p className="text-sm text-slate-600">{expense.date} · {expense.payment_method === 'cash' ? 'نقداً' : 'بنك'}{expense.notes ? ` · ${expense.notes}` : ''}</p></div><p className="text-lg font-black text-rose-700">₪{formatDecimal(expense.amount)}</p></div>)}</div></section>
}
