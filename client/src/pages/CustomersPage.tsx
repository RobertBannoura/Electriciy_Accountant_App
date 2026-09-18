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
import { formatDecimal } from '../money-display'
import { AccountStatementDialog } from '../components/AccountStatementDialog'
import { DialogCloseButton } from '../components/DialogCloseButton'

type StoreBalance = { store_id: string; store_name: string; amount_ils: string }
type CustomerSummary = {
  id: string
  name: string
  phone: string | null
  address: string | null
  notes: string | null
  balance_ils: string
}
type Sale = {
  id: string
  document_number: string | null
  business_date: string
  status: string
  currency_code: string | null
  project_id: string | null
  project_name: string | null
  total: string
  store_name: string
}
type Maintenance = {
  id: string
  item_description: string
  business_date: string
  amount_ils: string
  paid_total_ils: string
  remaining_due_ils: string
  reversed_at: string | null
  store_name: string
}
type Payment = {
  id: string
  direction: string
  original_amount: string
  currency_code: string
  converted_ils_amount: string
  payment_method: string | null
  reference: string | null
  paid_at: string
  store_name: string
  notes: string | null
}
type CustomerCheck = {
  id: string
  check_number: string
  direction: string
  status: string
  amount: string
  currency_code: string | null
  due_date: string
  store_name: string
  notes: string | null
  is_giro: boolean
  original_owner_name: string | null
  original_owner_phone: string | null
  supplier_id: string | null
  supplier_name: string | null
  transferred_at: string | null
}
type Project = {
  id: string
  customer_id: string
  name: string
  notes: string | null
  created_at: string
}
type Movement = {
  id: string
  direction: 'debit' | 'credit'
  amount_ils: string
  occurred_at: string
  source_type: string
  source_id: string | null
  notes: string | null
  project_id: string | null
  project_name: string | null
  store_name: string
}
type CustomerDetail = CustomerSummary & {
  store_balances: StoreBalance[]
  recent_sales: Sale[]
  recent_maintenance: Maintenance[]
  payments: Payment[]
  checks: CustomerCheck[]
  projects: Project[]
  recent_movements: Movement[]
  selected_project_id: string | null
  selected_store_id: string | null
}
type CustomerForm = { name: string; phone: string; address: string; notes: string }

const inputClass =
  'min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100'

function withStore(init: RequestInit | undefined, storeId: string) {
  const headers = new Headers(init?.headers)
  headers.set('X-Store-Id', storeId)
  return { ...init, headers }
}

async function customerApiFetch(path: string, storeId: string, init?: RequestInit) {
  return apiFetch(path, withStore(init, storeId))
}

async function errorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } }
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch {
    // Use the stable fallback below.
  }
  return 'تعذّر إكمال الطلب. حاول مرة أخرى.'
}

function initialStoreId(defaultStoreId: string | null, stores: Store[]) {
  return stores.some((store) => store.id === defaultStoreId)
    ? defaultStoreId!
    : (stores[0]?.id ?? '')
}

export function CustomersPage({
  defaultStoreId,
  readOnly = false,
  stores,
}: {
  defaultStoreId: string | null
  readOnly?: boolean
  stores: Store[]
}) {
  const operatingStoreId = initialStoreId(defaultStoreId, stores)
  const [search, setSearch] = useState('')
  const [customers, setCustomers] = useState<CustomerSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingCustomer, setEditingCustomer] = useState<CustomerSummary | null | undefined>()

  const loadCustomers = useCallback(
    async (signal?: AbortSignal) => {
      if (!operatingStoreId) {
        setCustomers([])
        return
      }
      setLoading(true)
      setError(null)
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      try {
        const response = await customerApiFetch(
          `/customers${params.size ? `?${params}` : ''}`,
          operatingStoreId,
          { signal },
        )
        if (!response.ok) throw new Error(await errorMessage(response))
        const payload = (await response.json()) as { customers: CustomerSummary[] }
        setCustomers(payload.customers)
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setError(caught instanceof Error ? caught.message : 'تعذّر تحميل العملاء')
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [operatingStoreId, search],
  )

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => void loadCustomers(controller.signal), 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [loadCustomers])

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-bold text-teal-700">الحسابات وسجل التعامل</p>
          <h1 className="mt-1 text-3xl font-black sm:text-4xl">العملاء</h1>
          <p className="mt-2 text-slate-600">{readOnly ? 'ابحث عن العميل وافتح ملفه لعرض الرصيد وتصدير كشف الحساب.' : 'الرصيد الظاهر محسوب من دفتر العميل ولا يُعدّل يدوياً.'}</p>
        </div>
        <button
          className="hidden min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60 sm:block"
          disabled={!operatingStoreId}
          onClick={() => setEditingCustomer(null)}
          type="button"
        >
          + إضافة عميل
        </button>
      </div>

      <div className="mt-7 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <Field label="بحث بالاسم أو رقم الهاتف">
          <input className={inputClass} onChange={(event) => setSearch(event.target.value)} placeholder="اسم العميل أو رقم الهاتف" value={search} />
        </Field>
      </div>

      {error && <p className="mt-5 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}

      <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <p className="p-8 text-center text-lg font-bold text-slate-600" role="status">جارٍ تحميل العملاء…</p>
        ) : customers.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-xl font-black">لا يوجد عملاء مطابقون</p>
            <p className="mt-2 text-slate-600">يمكن إتمام البيع المدفوع بالكامل دون إضافة عميل.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {customers.map((customer) => (
              <article className="group relative flex flex-wrap items-center justify-between gap-5 p-5 transition-colors hover:bg-teal-50/50" key={customer.id}>
                <Link
                  aria-label={`فتح ملف ${customer.name}`}
                  className="absolute inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600"
                  to={`/customers/${customer.id}`}
                />
                <div className="min-w-0">
                  <p className="text-xl font-black text-slate-950 transition-colors group-hover:text-teal-700">{customer.name}</p>
                  <p className="mt-1 text-slate-600">{customer.phone ?? 'لا يوجد رقم هاتف'}{customer.address ? ` · ${customer.address}` : ''}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <IlsBalance amount={customer.balance_ils} />
                  <button className="relative z-10 hidden min-h-11 rounded-xl bg-slate-100 px-4 font-black hover:bg-slate-200 sm:block" onClick={() => setEditingCustomer(customer)} type="button">تعديل</button>
                  <Link className="relative z-10 inline-flex min-h-11 items-center rounded-xl bg-teal-50 px-4 font-black text-teal-800 hover:bg-teal-100" to={`/customers/${customer.id}`}>فتح الملف</Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {!readOnly && editingCustomer !== undefined && (
        <CustomerEditor
          customer={editingCustomer}
          onClose={() => setEditingCustomer(undefined)}
          onSaved={() => {
            setEditingCustomer(undefined)
            void loadCustomers()
          }}
          storeId={operatingStoreId}
        />
      )}
    </section>
  )
}

export function CustomerDetailPage({
  defaultStoreId,
  readOnly = false,
  stores,
}: {
  defaultStoreId: string | null
  readOnly?: boolean
  stores: Store[]
}) {
  const { customerId = '' } = useParams()
  const operatingStoreId = initialStoreId(defaultStoreId, stores)
  const [customer, setCustomer] = useState<CustomerDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [addingProject, setAddingProject] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedActivityStoreId, setSelectedActivityStoreId] = useState('')
  const [showStatement, setShowStatement] = useState(false)

  const loadCustomer = useCallback(async () => {
    if (!operatingStoreId || !customerId) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (selectedProjectId) params.set('projectId', selectedProjectId)
      if (selectedActivityStoreId) params.set('storeId', selectedActivityStoreId)
      const response = await customerApiFetch(
        `/customers/${customerId}${params.size ? `?${params}` : ''}`,
        operatingStoreId,
      )
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as { customer: CustomerDetail }
      setCustomer(payload.customer)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذّر تحميل ملف العميل')
    } finally {
      setLoading(false)
    }
  }, [customerId, operatingStoreId, selectedActivityStoreId, selectedProjectId])

  useEffect(() => {
    void loadCustomer()
  }, [loadCustomer])

  if (!operatingStoreId) return <EmptyState text="يجب إعداد متجر قبل فتح ملفات العملاء." />
  if (loading) return <EmptyState text="جارٍ تحميل ملف العميل…" />
  if (error || !customer) return <EmptyState error text={error ?? 'العميل غير موجود'} />

  return (
    <section className="customer-statement">
      <div className="mb-5 print:hidden">
        <Link className="font-black text-teal-700 hover:text-teal-900" to="/customers">← العودة إلى العملاء</Link>
      </div>
      <header className="rounded-3xl bg-slate-900 p-6 text-white shadow-lg sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="font-bold text-teal-300">ملف العميل</p>
            <h1 className="mt-1 text-3xl font-black sm:text-4xl">{customer.name}</h1>
            <p className="mt-3 text-slate-300">{customer.phone ?? 'لا يوجد رقم هاتف'}{customer.address ? ` · ${customer.address}` : ''}</p>
          </div>
          <div>
            <p className="text-sm font-bold text-slate-300">الرصيد الحالي</p>
            <div className="mt-2"><IlsBalance amount={customer.balance_ils} dark /></div>
            {customer.store_balances.length > 1 && <StoreBreakdown balances={customer.store_balances} />}
          </div>
        </div>
        {customer.notes && <p className="mt-5 border-t border-slate-700 pt-4 text-slate-300">{customer.notes}</p>}
      </header>

      <div className="mt-5 flex flex-wrap gap-3 print:hidden">
        <Link className="hidden min-h-12 items-center rounded-xl bg-teal-700 px-5 font-black text-white hover:bg-teal-800 sm:inline-flex" to={`/sale?customerId=${customer.id}&storeId=${operatingStoreId}`}>بيع جديد</Link>
        <Link className="hidden min-h-12 items-center rounded-xl bg-amber-400 px-5 font-black text-slate-950 hover:bg-amber-300 sm:inline-flex" to={`/maintenance?customerId=${customer.id}`}>صيانة جديدة</Link>
        {!readOnly && <Link className="inline-flex min-h-12 items-center rounded-xl bg-indigo-700 px-5 font-black text-white hover:bg-indigo-800" to={`/customers/${customer.id}/payment?storeId=${operatingStoreId}`}>تسجيل دفعة</Link>}
        <button className="hidden min-h-12 rounded-xl bg-amber-500 px-5 font-black text-slate-950 hover:bg-amber-400 sm:block" onClick={() => setAddingProject(true)} type="button">مشروع جديد</button>
        <button className="min-h-12 rounded-xl border border-slate-300 bg-white px-5 font-black hover:bg-slate-100" onClick={() => setShowStatement(true)} type="button">كشف حساب عميل</button>
        <button className="hidden min-h-12 rounded-xl px-5 font-black text-slate-700 hover:bg-slate-100 sm:block" onClick={() => setEditing(true)} type="button">تعديل البيانات</button>
      </div>

      <section className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-5 print:hidden">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-indigo-950">نطاق النشاط</h2>
            <p className="mt-1 text-sm font-bold text-indigo-800">
              {selectedProjectId
                ? 'يعرض نشاط المشروع المحدد، بينما يبقى الرصيد الإجمالي للعميل كما هو.'
                : 'يعرض نشاط العميل في كل المشاريع، بما فيه النشاط غير المرتبط بمشروع.'}
            </p>
          </div>
          <div className="grid w-full gap-3 sm:w-auto sm:grid-cols-2">
          <Field label="المحل">
            <select className={`${inputClass} min-w-52`} onChange={(event) => setSelectedActivityStoreId(event.target.value)} value={selectedActivityStoreId}>
              <option value="">كل المحلات</option>
              {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
          </Field>
          <Field label="المشروع">
            <select className={`${inputClass} min-w-64`} onChange={(event) => setSelectedProjectId(event.target.value)} value={selectedProjectId}>
              <option value="">كل المشاريع</option>
              {customer.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </Field>
          </div>
        </div>
      </section>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <DetailSection title={selectedProjectId ? 'مبيعات المشروع' : 'أحدث المبيعات لكل المشاريع'}><SalesList items={customer.recent_sales} /></DetailSection>
        {!selectedProjectId && <DetailSection title="الصيانة"><MaintenanceList items={customer.recent_maintenance} /></DetailSection>}
        <DetailSection title="الدفعات"><PaymentsList items={customer.payments} /></DetailSection>
        <DetailSection title="الشيكات"><ChecksList items={customer.checks} /></DetailSection>
        <DetailSection title="المشاريع"><ProjectsList items={customer.projects} /></DetailSection>
      </div>
      <div className="mt-5" id="account-movements">
        <DetailSection title={selectedProjectId ? 'حركات حساب المشروع' : 'أحدث حركات الحساب لكل المشاريع'}><MovementsList items={customer.recent_movements} /></DetailSection>
      </div>

      {!readOnly && editing && <CustomerEditor customer={customer} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void loadCustomer() }} storeId={operatingStoreId} />}
      {!readOnly && addingProject && <ProjectEditor customerId={customer.id} onClose={() => setAddingProject(false)} onSaved={() => { setAddingProject(false); void loadCustomer() }} storeId={operatingStoreId} />}
      {showStatement && <AccountStatementDialog initialProjectId={selectedProjectId} initialStoreId={selectedActivityStoreId} kind="customer" onClose={() => setShowStatement(false)} operatingStoreId={operatingStoreId} partyId={customer.id} projects={customer.projects} stores={stores} />}
    </section>
  )
}

function CustomerEditor({ customer, storeId, onClose, onSaved }: { customer: CustomerSummary | null; storeId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<CustomerForm>({ name: customer?.name ?? '', phone: customer?.phone ?? '', address: customer?.address ?? '', notes: customer?.notes ?? '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const response = await customerApiFetch(customer ? `/customers/${customer.id}` : '/customers', storeId, {
        method: customer ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذّر حفظ العميل')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose} title={customer ? 'تعديل بيانات العميل' : 'إضافة عميل'}>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <Field label="الاسم *"><input autoFocus className={inputClass} maxLength={150} onChange={(event) => setForm({ ...form, name: event.target.value })} required value={form.name} /></Field>
        <Field label="رقم الهاتف"><input className={inputClass} dir="ltr" maxLength={50} onChange={(event) => setForm({ ...form, phone: event.target.value })} type="tel" value={form.phone} /></Field>
        <Field label="العنوان"><input className={inputClass} maxLength={500} onChange={(event) => setForm({ ...form, address: event.target.value })} value={form.address} /></Field>
        <Field label="ملاحظات — اختياري"><textarea className={`${inputClass} min-h-28 py-3`} maxLength={2000} onChange={(event) => setForm({ ...form, notes: event.target.value })} value={form.notes} /></Field>
        <p className="rounded-xl bg-slate-50 p-3 text-sm font-bold text-slate-600">رصيد العميل يُحسب من دفتر الحساب ولا يوجد له حقل تعديل.</p>
        {error && <p className="rounded-xl bg-rose-50 p-3 font-bold text-rose-800" role="alert">{error}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <button className="min-h-12 rounded-xl px-5 font-black hover:bg-slate-100" onClick={onClose} type="button">إلغاء</button>
          <button className="min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white hover:bg-teal-800 disabled:opacity-60" disabled={saving} type="submit">{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button>
        </div>
      </form>
    </Modal>
  )
}

function ProjectEditor({ customerId, storeId, onClose, onSaved }: { customerId: string; storeId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const response = await customerApiFetch(`/customers/${customerId}/projects`, storeId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      if (!response.ok) throw new Error(await errorMessage(response))
      onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذّر حفظ المشروع')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal onClose={onClose} title="مشروع جديد">
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <Field label="اسم المشروع *"><input autoFocus className={inputClass} maxLength={150} onChange={(event) => setForm({ ...form, name: event.target.value })} required value={form.name} /></Field>
        <Field label="ملاحظات — اختياري"><textarea className={`${inputClass} min-h-24 py-3`} maxLength={2000} onChange={(event) => setForm({ ...form, notes: event.target.value })} value={form.notes} /></Field>
        {error && <p className="rounded-xl bg-rose-50 p-3 font-bold text-rose-800" role="alert">{error}</p>}
        <div className="flex justify-end gap-3"><button className="min-h-12 rounded-xl px-5 font-black hover:bg-slate-100" onClick={onClose} type="button">إلغاء</button><button className="min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white disabled:opacity-60" disabled={saving} type="submit">{saving ? 'جارٍ الحفظ…' : 'حفظ المشروع'}</button></div>
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-2 block text-sm font-black text-slate-700">{label}</span>{children}</label>
}

function IlsBalance({ amount, dark = false }: { amount: string; dark?: boolean }) {
  return <span className={`inline-block rounded-xl px-3 py-2 font-black ${dark ? 'bg-white/10 text-white' : 'bg-amber-50 text-amber-900'}`} dir="ltr">₪{formatDecimal(amount)}</span>
}

function StoreBreakdown({ balances }: { balances: StoreBalance[] }) {
  return <div className="mt-3 space-y-1 text-sm text-slate-300">{balances.map((balance) => <p className="flex justify-between gap-4" key={balance.store_id}><span>{balance.store_name}</span><span dir="ltr">₪{formatDecimal(balance.amount_ils)}</span></p>)}</div>
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><h2 className="border-b border-slate-200 bg-slate-50 px-5 py-4 text-xl font-black">{title}</h2><div className="divide-y divide-slate-100">{children}</div></section>
}

function SalesList({ items }: { items: Sale[] }) {
  if (!items.length) return <NoRecords />
  return <>{items.map((item) => <RecordRow key={item.id} primary={`بيع ${item.document_number ?? `#${item.id}`}`} secondary={`${localDate(item.business_date)} · ${item.store_name} · ${statusLabel(item.status)}${item.project_name ? ` · ${item.project_name}` : ''}`} value={`${formatDecimal(item.total)} ${item.currency_code ?? ''}`} />)}</>
}
function MaintenanceList({ items }: { items: Maintenance[] }) {
  if (!items.length) return <NoRecords />
  return <>{items.map((item) => <RecordRow key={item.id} primary={`صيانة — ${item.item_description}${item.reversed_at ? ' (معكوسة)' : ''}`} secondary={`${localDate(item.business_date)} · ${item.store_name} · مدفوع ₪${formatDecimal(item.paid_total_ils)} · متبقٍ ₪${formatDecimal(item.remaining_due_ils)}`} value={`₪${formatDecimal(item.amount_ils)}`} />)}</>
}
function PaymentsList({ items }: { items: Payment[] }) {
  if (!items.length) return <NoRecords />
  return <>{items.map((item) => <RecordRow key={item.id} primary={`${item.direction === 'outflow' ? 'عكس ' : ''}${paymentMethodLabel(item.payment_method)}`} secondary={`${localDate(item.paid_at)} · ${item.store_name}${item.reference ? ` · ${item.reference}` : ''}${item.currency_code === 'ILS' ? '' : ` · يعادل ₪${formatDecimal(item.converted_ils_amount)}`}${item.notes ? ` · ${item.notes}` : ''}`} value={`${item.direction === 'outflow' ? '-' : ''}${originalMoney(item.original_amount, item.currency_code)}`} />)}</>
}
function ChecksList({ items }: { items: CustomerCheck[] }) {
  if (!items.length) return <NoRecords />
  return <>{items.map((item) => <RecordRow key={item.id} primary={`${item.direction === 'outflow' ? 'عكس ' : ''}${item.is_giro ? 'شيك جيرو' : 'شيك'} ${item.check_number}`} secondary={`${item.is_giro ? `صاحب الشيك الأصلي: ${item.original_owner_name} · ${item.original_owner_phone} · ` : ''}${item.supplier_id ? `حُوّل إلى المورد ${item.supplier_name} بتاريخ ${localDate(item.transferred_at!)} · ` : ''}${item.store_name} · ${localDate(item.due_date)} · ${customerCheckStatusLabel(item.status)}${item.notes ? ` · ${item.notes}` : ''}`} value={`${item.direction === 'outflow' ? '-' : ''}${formatDecimal(item.amount)} ${item.currency_code ?? ''}`} />)}</>
}
function ProjectsList({ items }: { items: Project[] }) {
  if (!items.length) return <NoRecords />
  return <>{items.map((item) => <RecordRow key={item.id} primary={item.name} secondary={item.notes ?? 'لا توجد ملاحظات'} />)}</>
}
function MovementsList({ items }: { items: Movement[] }) {
  if (!items.length) return <NoRecords />
  return <>{items.map((item) => <RecordRow key={item.id} primary={item.notes ?? movementSourceLabel(item.source_type)} secondary={`${localDate(item.occurred_at)} · ${item.store_name} · ${item.direction === 'debit' ? 'مدين' : 'دائن'}${item.project_name ? ` · ${item.project_name}` : ''}`} value={`${item.direction === 'debit' ? '+' : '-'}₪${formatDecimal(item.amount_ils)}`} />)}</>
}

function RecordRow({ primary, secondary, value }: { primary: string; secondary: string; value?: string }) {
  return <div className="flex items-start justify-between gap-4 p-4"><div><p className="font-black">{primary}</p><p className="mt-1 text-sm text-slate-500">{secondary}</p></div>{value && <p className="whitespace-nowrap font-black" dir="ltr">{value}</p>}</div>
}
function NoRecords() { return <p className="p-5 text-slate-500">لا توجد سجلات.</p> }
function EmptyState({ text, error = false }: { text: string; error?: boolean }) { return <p className={`rounded-2xl p-8 text-center text-lg font-black ${error ? 'bg-rose-50 text-rose-800' : 'bg-white text-slate-600'}`} role={error ? 'alert' : 'status'}>{text}</p> }
function localDate(value: string) { return new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeZone: 'Asia/Hebron' }).format(new Date(value)) }
function originalMoney(amount: string, currency: string) {
  const displayAmount = formatDecimal(amount)
  if (currency === 'ILS') return `₪${displayAmount}`
  if (currency === 'USD') return `$${displayAmount}`
  return `${displayAmount} JOD`
}
