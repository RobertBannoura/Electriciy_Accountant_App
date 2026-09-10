import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api'
import { customerCheckStatusLabel } from '../business-labels'
import { formatDecimal } from '../money-display'
import { Store } from '../types'

type CheckStatus = 'pending' | 'cleared' | 'bounced'
export type CheckRecord = {
  id: string
  check_number: string
  amount: string
  currency_code: string
  due_date: string
  status: CheckStatus
  notes: string | null
  sale_id: string | null
  maintenance_id: string | null
  customer_id: string | null
  customer_name: string | null
  is_giro: boolean
  original_owner_name: string | null
  original_owner_phone: string | null
  supplier_id: string | null
  supplier_name: string | null
  transferred_at: string | null
  is_owner_issued: boolean
  bounced_reminder_stopped_at: string | null
}
type Supplier = { id: string; name: string; balance_ils: string }

const inputClass = 'min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100'

function currentBusinessDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function localDate(value: string) {
  return new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`))
}

async function errorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } }
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch {
    // Use the stable Arabic fallback.
  }
  return 'تعذّر تحميل الشيكات. حاول مرة أخرى.'
}

export function ChecksPage({
  defaultStoreId,
  stores,
}: {
  defaultStoreId: string | null
  stores: Store[]
}) {
  const operatingStoreId = stores.some((store) => store.id === defaultStoreId)
    ? defaultStoreId!
    : ''
  const [checks, setChecks] = useState<CheckRecord[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [status, setStatus] = useState<'' | CheckStatus>('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [transferCheckId, setTransferCheckId] = useState<string | null>(null)
  const [supplierId, setSupplierId] = useState('')
  const [transferDate, setTransferDate] = useState(currentBusinessDate)
  const [savingTransfer, setSavingTransfer] = useState(false)
  const [actingCheckId, setActingCheckId] = useState<string | null>(null)
  const [showOwnerForm, setShowOwnerForm] = useState(false)
  const [ownerCheckNumber, setOwnerCheckNumber] = useState('')
  const [ownerAmount, setOwnerAmount] = useState('')
  const [ownerDueDate, setOwnerDueDate] = useState(currentBusinessDate)
  const [ownerSupplierId, setOwnerSupplierId] = useState('')
  const [ownerNotes, setOwnerNotes] = useState('')
  const [savingOwnerCheck, setSavingOwnerCheck] = useState(false)

  const loadChecks = useCallback(async (signal?: AbortSignal) => {
    if (!operatingStoreId) {
      setChecks([])
      return
    }
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    params.set('page', String(page))
    if (status) params.set('status', status)
    if (search.trim()) params.set('search', search.trim())
    try {
      const headers = new Headers({ 'X-Store-Id': operatingStoreId })
      const response = await apiFetch(`/checks${params.size ? `?${params}` : ''}`, {
        headers,
        signal,
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { checks: CheckRecord[]; pagination: { hasMore: boolean } }
      setChecks(payload.checks)
      setHasMore(payload.pagination.hasMore)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'تعذّر تحميل الشيكات')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [operatingStoreId, page, search, status])

  useEffect(() => setPage(1), [operatingStoreId, search, status])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => void loadChecks(controller.signal), 200)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [loadChecks])

  const loadSuppliers = useCallback(async (signal?: AbortSignal) => {
    if (!operatingStoreId) {
      setSuppliers([])
      return
    }
    const headers = new Headers({ 'X-Store-Id': operatingStoreId })
    try {
      const response = await apiFetch('/suppliers', { headers, signal })
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { suppliers: Supplier[] }
      setSuppliers(payload.suppliers)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'تعذّر تحميل الموردين')
    }
  }, [operatingStoreId])

  useEffect(() => {
    const controller = new AbortController()
    void loadSuppliers(controller.signal)
    return () => controller.abort()
  }, [loadSuppliers])

  function beginTransfer(checkId: string) {
    setTransferCheckId(checkId)
    setSupplierId('')
    setTransferDate(currentBusinessDate())
    setError(null)
  }

  async function submitTransfer(event: FormEvent) {
    event.preventDefault()
    if (!transferCheckId || !supplierId || !transferDate || savingTransfer) return
    setSavingTransfer(true)
    setError(null)
    try {
      const headers = new Headers({
        'Content-Type': 'application/json',
        'X-Store-Id': operatingStoreId,
      })
      const response = await apiFetch(`/checks/${transferCheckId}/transfer`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ supplierId, transferDate }),
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      setTransferCheckId(null)
      setSupplierId('')
      await Promise.all([loadChecks(), loadSuppliers()])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذّر تحويل الشيك إلى المورد')
    } finally {
      setSavingTransfer(false)
    }
  }

  async function submitOwnerCheck(event: FormEvent) {
    event.preventDefault()
    if (savingOwnerCheck) return
    setSavingOwnerCheck(true)
    setError(null)
    try {
      const response = await apiFetch('/checks/owner-issued', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Store-Id': operatingStoreId,
        },
        body: JSON.stringify({
          checkNumber: ownerCheckNumber,
          amount: ownerAmount,
          dueDate: ownerDueDate,
          supplierId: ownerSupplierId,
          notes: ownerNotes,
        }),
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      setOwnerCheckNumber('')
      setOwnerAmount('')
      setOwnerDueDate(currentBusinessDate())
      setOwnerSupplierId('')
      setOwnerNotes('')
      setShowOwnerForm(false)
      await Promise.all([loadChecks(), loadSuppliers()])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذّر إصدار شيك المنشأة')
    } finally {
      setSavingOwnerCheck(false)
    }
  }

  async function runLifecycleAction(check: CheckRecord, action: 'clear' | 'bounce' | 'stop-bounced-reminder') {
    if (actingCheckId) return
    if (action === 'bounce' && !window.confirm('سيُعاد المبلغ إلى الدين المستحق. هل تريد تسجيل الشيك كمرتجع؟')) return
    setActingCheckId(check.id)
    setError(null)
    try {
      const response = await apiFetch(`/checks/${check.id}/${action}`, {
        method: 'POST',
        headers: { 'X-Store-Id': operatingStoreId },
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      await Promise.all([loadChecks(), check.supplier_id ? loadSuppliers() : Promise.resolve()])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذّر تحديث حالة الشيك')
    } finally {
      setActingCheckId(null)
    }
  }

  if (!operatingStoreId) {
    return <p className="rounded-2xl bg-white p-8 text-center text-lg font-black text-slate-600">يجب إعداد متجر قبل عرض الشيكات.</p>
  }

  const today = currentBusinessDate()

  return (
    <section aria-labelledby="checks-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
        <p className="font-bold text-teal-700">شيكات العملاء وشيكات المنشأة</p>
        <h1 className="mt-1 text-3xl font-black sm:text-4xl" id="checks-title">الشيكات</h1>
        <p className="mt-2 text-slate-600">الشيك المقبول يخفض رصيد العميل فورًا، ويبقى قيد التحصيل حتى تحديث حالته صراحةً.</p>
        </div>
        <button className="min-h-12 rounded-xl bg-slate-900 px-5 font-black text-white hover:bg-slate-800" onClick={() => setShowOwnerForm((shown) => !shown)} type="button">+ شيك منشأة لمورد</button>
      </div>

      {showOwnerForm && (
        <form aria-label="إصدار شيك منشأة إلى مورد" className="mt-6 grid gap-4 rounded-2xl border-2 border-teal-200 bg-teal-50 p-5 md:grid-cols-2" onSubmit={(event) => void submitOwnerCheck(event)}>
          <h2 className="text-xl font-black md:col-span-2">شيك صادر من صاحب العمل إلى مورد</h2>
          <label><span className="mb-2 block font-black">رقم الشيك</span><input autoFocus className={inputClass} maxLength={100} onChange={(event) => setOwnerCheckNumber(event.target.value)} required value={ownerCheckNumber} /></label>
          <label><span className="mb-2 block font-black">المبلغ</span><input className={inputClass} min="0.01" onChange={(event) => setOwnerAmount(event.target.value)} required step="0.01" type="number" value={ownerAmount} /></label>
          <label><span className="mb-2 block font-black">تاريخ الاستحقاق</span><input className={inputClass} onChange={(event) => setOwnerDueDate(event.target.value)} required type="date" value={ownerDueDate} /></label>
          <label><span className="mb-2 block font-black">المورد</span><select className={inputClass} onChange={(event) => setOwnerSupplierId(event.target.value)} required value={ownerSupplierId}><option value="">اختر المورد</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name} — المستحق ₪{formatDecimal(supplier.balance_ils)}</option>)}</select></label>
          <label className="md:col-span-2"><span className="mb-2 block font-black">ملاحظات — اختياري</span><textarea className={`${inputClass} min-h-24 py-3`} maxLength={2000} onChange={(event) => setOwnerNotes(event.target.value)} value={ownerNotes} /></label>
          <div className="flex gap-3 md:col-span-2"><button className="min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white disabled:opacity-50" disabled={savingOwnerCheck} type="submit">{savingOwnerCheck ? 'جارٍ الحفظ…' : 'إصدار الشيك'}</button><button className="min-h-12 rounded-xl px-6 font-black text-slate-700 hover:bg-white" disabled={savingOwnerCheck} onClick={() => setShowOwnerForm(false)} type="button">إلغاء</button></div>
        </form>
      )}

      <div className="mt-6 grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-2">
        <label><span className="mb-2 block font-black">بحث بالعميل أو صاحب الشيك أو رقمه</span><input className={inputClass} onChange={(event) => setSearch(event.target.value)} value={search} /></label>
        <label><span className="mb-2 block font-black">الحالة المالية</span><select className={inputClass} onChange={(event) => setStatus(event.target.value as '' | CheckStatus)} value={status}><option value="">كل الحالات</option><option value="pending">قيد التحصيل</option><option value="cleared">تم تحصيله</option><option value="bounced">مرتجع</option></select></label>
      </div>

      {error && <p className="mt-5 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}

      <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <p className="p-8 text-center text-lg font-bold text-slate-600" role="status">جارٍ تحميل الشيكات…</p>
        ) : checks.length === 0 ? (
          <p className="p-10 text-center text-lg font-bold text-slate-600">لا توجد شيكات مطابقة.</p>
        ) : (
          <div className="divide-y divide-slate-200">
            {checks.map((check) => {
              const overdue = check.status === 'pending' && check.due_date < today
              return (
                <article className="grid gap-4 p-5 md:grid-cols-[minmax(0,1.5fr)_1fr_1fr_auto] md:items-center" key={check.id}>
                  <div className="min-w-0">
                    {check.customer_id ? <Link className="text-lg font-black text-slate-950 hover:text-teal-700" to={`/customers/${check.customer_id}`}>{check.customer_name}</Link> : <p className="text-lg font-black text-slate-950">شيك المنشأة إلى {check.supplier_name}</p>}
                    <p className="mt-1 font-bold text-slate-600">{check.is_owner_issued ? 'شيك صادر' : check.is_giro ? 'شيك جيرو' : 'شيك'} رقم {check.check_number}</p>
                    {check.is_giro && <p className="mt-1 text-sm font-bold text-fuchsia-800">صاحب الشيك الأصلي: {check.original_owner_name} · {check.original_owner_phone}</p>}
                    {check.customer_id && check.supplier_id && <p className="mt-1 text-sm font-bold text-violet-800">حُوّل إلى المورد {check.supplier_name} بتاريخ {localDate(check.transferred_at!)}</p>}
                    {check.notes && <p className="mt-1 truncate text-sm text-slate-500">{check.notes}</p>}
                  </div>
                  <div><p className="text-sm font-bold text-slate-500">المبلغ</p><p className="mt-1 text-xl font-black" dir="ltr">₪{formatDecimal(check.amount)}</p></div>
                  <div><p className="text-sm font-bold text-slate-500">تاريخ الاستحقاق</p><p className="mt-1 font-black">{localDate(check.due_date)}</p>{overdue && <p className="mt-1 text-sm font-bold text-amber-700">تجاوز تاريخ الاستحقاق</p>}</div>
                  <div className="flex flex-col gap-2">
                    <span className={`inline-flex min-h-10 items-center justify-center rounded-full px-4 font-black ${check.status === 'cleared' ? 'bg-emerald-100 text-emerald-900' : check.status === 'bounced' ? 'bg-rose-100 text-rose-900' : 'bg-violet-100 text-violet-900'}`}>{customerCheckStatusLabel(check.status)}</span>
                    {check.status === 'pending' && <button className="min-h-10 rounded-xl bg-emerald-700 px-4 font-black text-white hover:bg-emerald-800 disabled:opacity-50" disabled={actingCheckId === check.id} onClick={() => void runLifecycleAction(check, 'clear')} type="button">تم تحصيله</button>}
                    {check.status === 'pending' && <button className="min-h-10 rounded-xl bg-rose-700 px-4 font-black text-white hover:bg-rose-800 disabled:opacity-50" disabled={actingCheckId === check.id} onClick={() => void runLifecycleAction(check, 'bounce')} type="button">مرتجع</button>}
                    {check.status === 'pending' && check.customer_id && !check.supplier_id && <button className="min-h-10 rounded-xl bg-violet-700 px-4 font-black text-white hover:bg-violet-800" onClick={() => beginTransfer(check.id)} type="button">تحويل لمورد</button>}
                    {check.status === 'bounced' && !check.bounced_reminder_stopped_at && <button className="min-h-10 rounded-xl border border-slate-300 px-4 font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50" disabled={actingCheckId === check.id} onClick={() => void runLifecycleAction(check, 'stop-bounced-reminder')} type="button">إيقاف تذكير المرتجع</button>}
                    {check.status === 'bounced' && check.bounced_reminder_stopped_at && <span className="text-center text-sm font-bold text-slate-500">تم إيقاف التذكير</span>}
                  </div>
                  {transferCheckId === check.id && (
                    <form aria-label="تحويل الشيك إلى مورد" className="grid gap-3 rounded-xl bg-violet-50 p-4 md:col-span-4 md:grid-cols-[1fr_14rem_auto_auto] md:items-end" onSubmit={(event) => void submitTransfer(event)}>
                      <label><span className="mb-2 block font-black">المورد</span><select autoFocus className={inputClass} onChange={(event) => setSupplierId(event.target.value)} required value={supplierId}><option value="">اختر المورد</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name} — المستحق ₪{formatDecimal(supplier.balance_ils)}</option>)}</select></label>
                      <label><span className="mb-2 block font-black">تاريخ التحويل</span><input className={inputClass} onChange={(event) => setTransferDate(event.target.value)} required type="date" value={transferDate} /></label>
                      <button className="min-h-12 rounded-xl bg-violet-700 px-5 font-black text-white disabled:opacity-50" disabled={!supplierId || !transferDate || savingTransfer} type="submit">{savingTransfer ? 'جارٍ التحويل…' : 'تأكيد التحويل'}</button>
                      <button className="min-h-12 rounded-xl px-5 font-black text-slate-700 hover:bg-white" disabled={savingTransfer} onClick={() => setTransferCheckId(null)} type="button">إلغاء</button>
                    </form>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </div>
      <nav aria-label="صفحات الشيكات" className="mt-4 flex items-center justify-center gap-3">
        <button className="min-h-11 rounded-xl border border-slate-300 px-5 font-black disabled:opacity-40" disabled={loading || page === 1} onClick={() => setPage((value) => value - 1)} type="button">السابق</button>
        <span className="font-black">صفحة {page}</span>
        <button className="min-h-11 rounded-xl border border-slate-300 px-5 font-black disabled:opacity-40" disabled={loading || !hasMore} onClick={() => setPage((value) => value + 1)} type="button">التالي</button>
      </nav>
    </section>
  )
}
