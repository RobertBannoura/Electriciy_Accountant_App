import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiFetch } from '../api'
import {
  customerCheckStatusLabel,
  movementSourceLabel,
  paymentMethodLabel,
  statusLabel,
} from '../business-labels'
import { Store } from '../types'
import { AccountStatementDialog } from '../components/AccountStatementDialog'
import { DialogCloseButton } from '../components/DialogCloseButton'
import { formatCurrencyAmount, formatDecimal } from '../money-display'

type StoreBalance = { store_id: string; store_name: string; amount_ils: string }
type SupplierSummary = {
  id: string
  name: string
  phone: string | null
  address: string | null
  notes: string | null
  balance_ils: string
}
type Purchase = {
  id: string
  document_number: string | null
  business_date: string
  status: string
  currency_code: string | null
  total: string
  store_name: string
}
type Payment = {
  id: string
  direction: string
  original_amount: string
  currency_code: string
  payment_method: string | null
  reference: string | null
  paid_at: string
  converted_ils_amount: string
  store_name: string
}
type SupplierCheck = {
  id: string
  check_number: string
  bank_name: string | null
  status: string
  amount: string
  currency_code: string | null
  due_date: string
  store_name: string
  transferred_at: string | null
  customer_id: string | null
  customer_name: string | null
  is_giro: boolean
  is_owner_issued: boolean
  original_owner_name: string | null
  original_owner_phone: string | null
}
type Movement = {
  id: string
  direction: 'debit' | 'credit'
  amount_ils: string
  occurred_at: string
  source_type: string
  notes: string | null
  store_name: string
}
type SupplierDetail = SupplierSummary & {
  store_balances: StoreBalance[]
  purchases: Purchase[]
  payments: Payment[]
  checks: SupplierCheck[]
  recent_movements: Movement[]
  selected_store_id: string | null
}
type SupplierForm = { name: string; phone: string; address: string; notes: string }

const inputClass =
  'min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100'

function initialStoreId(defaultStoreId: string | null, stores: Store[]) {
  return stores.some((store) => store.id === defaultStoreId)
    ? defaultStoreId!
    : (stores[0]?.id ?? '')
}

async function supplierApiFetch(path: string, storeId: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set('X-Store-Id', storeId)
  return apiFetch(path, { ...init, headers })
}

async function errorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } }
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch {
    // Use the stable fallback.
  }
  return 'تعذّر إكمال الطلب. حاول مرة أخرى.'
}

export function SuppliersPage({ defaultStoreId, readOnly = false, stores }: { defaultStoreId: string | null; readOnly?: boolean; stores: Store[] }) {
  const operatingStoreId = initialStoreId(defaultStoreId, stores)
  const [search, setSearch] = useState('')
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([])
  const [editingSupplier, setEditingSupplier] = useState<SupplierSummary | null | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSuppliers = useCallback(async (signal?: AbortSignal) => {
    if (!operatingStoreId) {
      setSuppliers([])
      return
    }
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (search.trim()) params.set('search', search.trim())
    try {
      const response = await supplierApiFetch(`/suppliers${params.size ? `?${params}` : ''}`, operatingStoreId, { signal })
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { suppliers: SupplierSummary[] }
      setSuppliers(payload.suppliers)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'تعذّر تحميل الموردين')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [operatingStoreId, search])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => void loadSuppliers(controller.signal), 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [loadSuppliers])

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="hidden font-bold text-teal-700 sm:block">المشتريات والحسابات الدائنة</p>
          <h1 className="hidden text-3xl font-black sm:mt-1 sm:block sm:text-4xl">الموردون</h1>
          <p className="mt-2 hidden text-slate-600 sm:block">{readOnly ? 'ابحث عن المورد وافتح ملفه لعرض الرصيد وكشف الحساب.' : 'المبلغ المستحق محسوب من دفتر المورد ولا يُعدّل يدوياً.'}</p>
        </div>
        <button className="hidden min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white hover:bg-teal-800 disabled:opacity-60 sm:block" disabled={!operatingStoreId} onClick={() => setEditingSupplier(null)} type="button">+ إضافة مورد</button>
      </div>

      <div className="mt-7 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <Field label="بحث بالاسم أو رقم الهاتف">
          <input className={inputClass} onChange={(event) => setSearch(event.target.value)} placeholder="اسم المورد أو رقم الهاتف" value={search} />
        </Field>
      </div>

      {error && <p className="mt-5 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}
      <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <p className="p-8 text-center text-lg font-bold text-slate-600" role="status">جارٍ تحميل الموردين…</p>
        ) : suppliers.length === 0 ? (
          <div className="p-10 text-center"><p className="text-xl font-black">لا يوجد موردون مطابقون</p><p className="mt-2 text-slate-600">أضف الموردين هنا بصورة مستقلة عن سجل العملاء.</p></div>
        ) : (
          <div className="divide-y divide-slate-200">
            {suppliers.map((supplier) => (
              <article className="group relative grid min-h-[4.75rem] cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 p-4 transition-colors hover:bg-teal-50/50 active:bg-teal-50 sm:flex sm:min-h-0 sm:flex-wrap sm:justify-between sm:gap-5 sm:p-5" key={supplier.id}>
                <Link
                  aria-label={`فتح ملف ${supplier.name}`}
                  className="absolute inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600"
                  to={`/suppliers/${supplier.id}`}
                />
                <div className="min-w-0 overflow-hidden">
                  <p className="truncate text-lg font-black text-slate-950 transition-colors group-hover:text-teal-700 sm:text-xl" title={supplier.name}>{supplier.name}</p>
                  <p className="mt-1 truncate text-sm text-slate-600 sm:text-base">{supplier.phone ?? 'لا يوجد رقم هاتف'}{supplier.address ? ` · ${supplier.address}` : ''}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2 sm:flex-wrap sm:gap-3">
                  <IlsBalance amount={supplier.balance_ils} />
                  <button className="relative z-10 hidden min-h-11 rounded-xl bg-slate-100 px-4 font-black hover:bg-slate-200 sm:block" onClick={() => setEditingSupplier(supplier)} type="button">تعديل</button>
                  <span aria-hidden="true" className="pointer-events-none grid size-9 place-items-center rounded-full bg-teal-50 text-xl font-black text-teal-700 sm:hidden">‹</span>
                  <Link className="relative z-10 hidden min-h-11 items-center rounded-xl bg-teal-50 px-4 font-black text-teal-800 hover:bg-teal-100 sm:inline-flex" to={`/suppliers/${supplier.id}`}>فتح الملف</Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {!readOnly && editingSupplier !== undefined && <SupplierEditor supplier={editingSupplier} storeId={operatingStoreId} onClose={() => setEditingSupplier(undefined)} onSaved={() => { setEditingSupplier(undefined); void loadSuppliers() }} />}
    </section>
  )
}

export function SupplierDetailPage({ defaultStoreId, readOnly = false, stores }: { defaultStoreId: string | null; readOnly?: boolean; stores: Store[] }) {
  const { supplierId = '' } = useParams()
  const operatingStoreId = initialStoreId(defaultStoreId, stores)
  const [supplier, setSupplier] = useState<SupplierDetail | null>(null)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedActivityStoreId, setSelectedActivityStoreId] = useState('')
  const [showStatement, setShowStatement] = useState(false)

  const loadSupplier = useCallback(async () => {
    if (!operatingStoreId || !supplierId) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (selectedActivityStoreId) params.set('storeId', selectedActivityStoreId)
      const response = await supplierApiFetch(`/suppliers/${supplierId}${params.size ? `?${params}` : ''}`, operatingStoreId)
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { supplier: SupplierDetail }
      setSupplier(payload.supplier)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذّر تحميل ملف المورد')
    } finally {
      setLoading(false)
    }
  }, [operatingStoreId, selectedActivityStoreId, supplierId])

  useEffect(() => { void loadSupplier() }, [loadSupplier])

  if (!operatingStoreId) return <EmptyState text="يجب إعداد متجر قبل فتح ملفات الموردين." />
  if (loading) return <EmptyState text="جارٍ تحميل ملف المورد…" />
  if (error || !supplier) return <EmptyState error text={error ?? 'المورد غير موجود'} />

  return (
    <section className="supplier-statement">
      <div className="mb-5 print:hidden"><Link className="font-black text-teal-700 hover:text-teal-900" to="/suppliers">← العودة إلى الموردين</Link></div>
      <header className="rounded-3xl border border-teal-200 bg-white p-6 text-slate-900 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div><p className="font-bold text-teal-700">ملف المورد</p><h1 className="mt-1 text-3xl font-black sm:text-4xl">{supplier.name}</h1><p className="mt-3 text-slate-600">{supplier.phone ?? 'لا يوجد رقم هاتف'}{supplier.address ? ` · ${supplier.address}` : ''}</p></div>
          <div><p className="text-sm font-bold text-slate-600">المستحق للمورد</p><div className="mt-2"><IlsBalance amount={supplier.balance_ils} /></div>{supplier.store_balances.length > 1 && <StoreBreakdown balances={supplier.store_balances} />}</div>
        </div>
        {supplier.notes && <p className="mt-5 border-t border-slate-200 pt-4 text-slate-600">{supplier.notes}</p>}
      </header>

      <div className="mt-5 flex flex-wrap gap-3 print:hidden">
        <Link className="hidden min-h-12 items-center rounded-xl bg-teal-700 px-5 font-black text-white hover:bg-teal-800 sm:inline-flex" to={`/purchases?supplierId=${supplier.id}&storeId=${operatingStoreId}`}>شراء جديد</Link>
        {!readOnly && <Link className="inline-flex min-h-12 items-center rounded-xl bg-teal-700 px-5 font-black text-white hover:bg-teal-800" to={`/suppliers/${supplier.id}/payment?storeId=${operatingStoreId}`}>تسجيل دفعة</Link>}
        <button className="min-h-12 rounded-xl border border-slate-300 bg-white px-5 font-black hover:bg-slate-100" onClick={() => setShowStatement(true)} type="button">كشف حساب مورد</button>
        <button className="hidden min-h-12 rounded-xl px-5 font-black text-slate-700 hover:bg-slate-100 sm:block" onClick={() => setEditing(true)} type="button">تعديل البيانات</button>
      </div>

      <section className="mt-6 rounded-2xl border border-teal-200 bg-teal-50 p-5 print:hidden">
        <Field label="نطاق النشاط">
          <select className={`${inputClass} max-w-sm`} onChange={(event) => setSelectedActivityStoreId(event.target.value)} value={selectedActivityStoreId}>
            <option value="">كل المحلات</option>
            {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
          </select>
        </Field>
      </section>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <DetailSection title="المشتريات"><PurchasesList items={supplier.purchases} /></DetailSection>
        <DetailSection title="الدفعات"><PaymentsList items={supplier.payments} /></DetailSection>
        <DetailSection title="الشيكات"><ChecksList items={supplier.checks} /></DetailSection>
        <DetailSection title="أحدث الحركات"><MovementsList items={supplier.recent_movements} /></DetailSection>
      </div>

      {!readOnly && editing && <SupplierEditor supplier={supplier} storeId={operatingStoreId} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void loadSupplier() }} />}
      {showStatement && <AccountStatementDialog initialStoreId={selectedActivityStoreId} kind="supplier" onClose={() => setShowStatement(false)} operatingStoreId={operatingStoreId} partyId={supplier.id} stores={stores} />}
    </section>
  )
}

function SupplierEditor({ supplier, storeId, onClose, onSaved }: { supplier: SupplierSummary | null; storeId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<SupplierForm>({ name: supplier?.name ?? '', phone: supplier?.phone ?? '', address: supplier?.address ?? '', notes: supplier?.notes ?? '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const response = await supplierApiFetch(supplier ? `/suppliers/${supplier.id}` : '/suppliers', storeId, { method: supplier ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      if (!response.ok) throw new Error(await errorMessage(response))
      onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذّر حفظ المورد')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal onClose={onClose} title={supplier ? 'تعديل بيانات المورد' : 'إضافة مورد'}>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <Field label="الاسم *"><input autoFocus className={inputClass} maxLength={150} onChange={(event) => setForm({ ...form, name: event.target.value })} required value={form.name} /></Field>
        <Field label="رقم الهاتف"><input className={inputClass} dir="ltr" maxLength={50} onChange={(event) => setForm({ ...form, phone: event.target.value })} type="tel" value={form.phone} /></Field>
        <Field label="العنوان"><input className={inputClass} maxLength={500} onChange={(event) => setForm({ ...form, address: event.target.value })} value={form.address} /></Field>
        <Field label="ملاحظات — اختياري"><textarea className={`${inputClass} min-h-28 py-3`} maxLength={2000} onChange={(event) => setForm({ ...form, notes: event.target.value })} value={form.notes} /></Field>
        <p className="rounded-xl bg-teal-50 p-3 text-sm font-bold text-teal-800">رصيد المورد يُحسب من دفتر المورد ولا يوجد له حقل تعديل.</p>
        {error && <p className="rounded-xl bg-rose-50 p-3 font-bold text-rose-800" role="alert">{error}</p>}
        <div className="flex justify-end gap-3"><button className="min-h-12 rounded-xl px-5 font-black hover:bg-slate-100" onClick={onClose} type="button">إلغاء</button><button className="min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white disabled:opacity-60" disabled={saving} type="submit">{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button></div>
      </form>
    </Modal>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div aria-label={title} aria-modal="true" className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/60 p-4" role="dialog"><div className="w-full max-w-xl rounded-3xl bg-white p-6 shadow-2xl sm:p-8"><div className="mb-6 flex items-center justify-between gap-4"><h2 className="text-2xl font-black">{title}</h2><DialogCloseButton onClick={onClose} /></div>{children}</div></div>
}
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className="mb-2 block text-sm font-black text-slate-700">{label}</span>{children}</label> }
function IlsBalance({ amount }: { amount: string }) { return <span className="inline-block whitespace-nowrap rounded-xl bg-teal-50 px-2.5 py-2 font-black text-teal-900 ring-1 ring-inset ring-teal-100 sm:px-3" dir="ltr">₪{formatDecimal(amount)}</span> }
function StoreBreakdown({ balances }: { balances: StoreBalance[] }) { return <div className="mt-3 space-y-1 text-sm text-slate-600">{balances.map((balance) => <p className="flex justify-between gap-4" key={balance.store_id}><span>{balance.store_name}</span><span dir="ltr">₪{formatDecimal(balance.amount_ils)}</span></p>)}</div> }
function DetailSection({ title, children }: { title: string; children: ReactNode }) { return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><h2 className="border-b border-slate-200 bg-slate-50 px-5 py-4 text-xl font-black">{title}</h2><div className="divide-y divide-slate-100">{children}</div></section> }
function PurchasesList({ items }: { items: Purchase[] }) { if (!items.length) return <NoRecords />; return <>{items.map((item) => <RecordRow key={item.id} primary={`شراء ${item.document_number ?? `#${item.id}`}`} secondary={`${localDate(item.business_date)} · ${item.store_name} · ${statusLabel(item.status)}`} value={formatCurrencyAmount(item.total, item.currency_code)} />)}</> }
function PaymentsList({ items }: { items: Payment[] }) { if (!items.length) return <NoRecords />; return <>{items.map((item) => <RecordRow key={item.id} primary={paymentMethodLabel(item.payment_method)} secondary={`${localDate(item.paid_at)} · ${item.store_name}${item.reference ? ` · ${item.reference}` : ''}${item.currency_code === 'ILS' ? '' : ` · يعادل ₪${formatDecimal(item.converted_ils_amount)}`}`} value={originalMoney(item.original_amount, item.currency_code)} />)}</> }
function ChecksList({ items }: { items: SupplierCheck[] }) {
  if (!items.length) return <NoRecords />
  return <>{items.map((item) => (
    <RecordRow
      key={item.id}
      primary={item.is_owner_issued ? `شيك المنشأة ${item.check_number}` : <>{item.is_giro ? 'شيك جيرو' : 'شيك'} {item.check_number} من العميل {item.customer_id ? <Link className="text-teal-700 hover:text-teal-950 hover:underline" to={`/customers/${item.customer_id}`}>{item.customer_name}</Link> : item.customer_name}</>}
      secondary={`${item.is_giro ? `صاحب الشيك الأصلي: ${item.original_owner_name} · ${item.original_owner_phone} · ` : ''}${item.transferred_at ? `تاريخ التحويل ${localDate(item.transferred_at)} · ` : ''}استحقاق ${localDate(item.due_date)} · ${item.store_name} · ${customerCheckStatusLabel(item.status)}`}
      value={formatCurrencyAmount(item.amount, item.currency_code)}
    />
  ))}</>
}
function MovementsList({ items }: { items: Movement[] }) { if (!items.length) return <NoRecords />; return <>{items.map((item) => <RecordRow key={item.id} primary={item.notes ?? movementSourceLabel(item.source_type)} secondary={`${localDate(item.occurred_at)} · ${item.store_name} · ${item.direction === 'credit' ? 'دائن' : 'مدين'}`} value={`${item.direction === 'credit' ? '+' : '-'}₪${formatDecimal(item.amount_ils)}`} />)}</> }
function RecordRow({ primary, secondary, value }: { primary: ReactNode; secondary: ReactNode; value?: string }) { return <div className="flex items-start justify-between gap-4 p-4"><div><p className="font-black">{primary}</p><p className="mt-1 text-sm text-slate-500">{secondary}</p></div>{value && <p className="whitespace-nowrap font-black" dir="ltr">{value}</p>}</div> }
function NoRecords() { return <p className="p-5 text-slate-500">لا توجد سجلات.</p> }
function EmptyState({ text, error = false }: { text: string; error?: boolean }) { return <p className={`rounded-2xl p-8 text-center text-lg font-black ${error ? 'bg-rose-50 text-rose-800' : 'bg-white text-slate-600'}`} role={error ? 'alert' : 'status'}>{text}</p> }
function localDate(value: string) { return new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeZone: 'Asia/Hebron' }).format(new Date(value)) }
function originalMoney(amount: string, currency: string) { return formatCurrencyAmount(amount, currency) }
