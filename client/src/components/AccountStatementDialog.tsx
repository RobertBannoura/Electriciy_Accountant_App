import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { apiFetch } from '../api'
import { movementSourceLabel } from '../business-labels'
import { formatDecimal } from '../money-display'
import { DialogCloseButton } from './DialogCloseButton'
import type { Store } from '../types'
import { DocumentOutputActions } from './DocumentOutputActions'
import { DateField } from './DateField'
import type { PdfAccountStatement, PdfStatementEntry } from '../pdf-documents'

type AccountStatement = PdfAccountStatement
type StatementEntry = PdfStatementEntry

function currentBusinessDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

async function responseError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: { message?: string } }
    if (payload.error?.message) return payload.error.message
  } catch {
    // Use the stable fallback.
  }
  return 'تعذّر تحميل كشف الحساب'
}

function entryLabel(entry: StatementEntry, kind: 'customer' | 'supplier') {
  const labels: Record<string, string> = kind === 'customer' ? {
    sale: 'مبيعات', sale_payment: 'دفعة', payment: 'دفعة',
    sale_check: 'شيك', check: 'شيك', customer_return: 'مرتجع مبيعات',
    maintenance: 'صيانة', maintenance_payment: 'دفعة صيانة',
    maintenance_check: 'شيك صيانة', check_bounce: 'شيك مرتجع', correction: 'تصحيح رصيد',
  } : {
    purchase: 'مشتريات', purchase_payment: 'دفعة', supplier_payment: 'دفعة',
    owner_check: 'شيك', check_transfer: 'شيك محوّل',
    supplier_return: 'مرتجع مشتريات', owner_check_bounce: 'تصحيح شيك مرتجع',
    check_transfer_bounce: 'تصحيح شيك مرتجع', correction: 'تصحيح رصيد',
  }
  return labels[entry.source_type] ?? `تصحيح - ${movementSourceLabel(entry.source_type)}`
}

export function AccountStatementDialog({
  initialProjectId = '',
  initialStoreId = '',
  kind,
  onClose,
  operatingStoreId,
  partyId,
  projects = [],
  stores,
}: {
  initialProjectId?: string
  initialStoreId?: string
  kind: 'customer' | 'supplier'
  onClose: () => void
  operatingStoreId: string
  partyId: string
  projects?: Array<{ id: string; name: string }>
  stores: Store[]
}) {
  const today = currentBusinessDate()
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`)
  const [to, setTo] = useState(today)
  const [storeId, setStoreId] = useState(initialStoreId)
  const [projectId, setProjectId] = useState(initialProjectId)
  const [statement, setStatement] = useState<AccountStatement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const documentRef = useRef<HTMLElement>(null)

  useEffect(() => {
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])

  useEffect(() => {
    const controller = new AbortController()
    const search = new URLSearchParams({ from, to })
    if (storeId) search.set('storeId', storeId)
    if (kind === 'customer' && projectId) search.set('projectId', projectId)
    setLoading(true)
    setError(null)
    apiFetch(`/${kind === 'customer' ? 'customers' : 'suppliers'}/${partyId}/statement?${search}`, {
      headers: { 'X-Store-Id': operatingStoreId }, signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response))
      return response.json() as Promise<{ statement: AccountStatement }>
    }).then((payload) => setStatement(payload.statement)).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setError(reason instanceof Error ? reason.message : 'تعذّر تحميل كشف الحساب')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [from, kind, operatingStoreId, partyId, projectId, storeId, to])

  return (
    <div aria-label={kind === 'customer' ? 'كشف حساب عميل' : 'كشف حساب مورد'} aria-modal="true" className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/70 p-3 print:static print:bg-white print:p-0" role="dialog">
      <div className="mx-auto max-w-6xl rounded-3xl bg-white p-5 shadow-2xl print:max-w-none print:rounded-none print:p-0 print:shadow-none sm:p-7">
        <div className="mb-5 flex items-center justify-between gap-4 print:hidden">
          <h2 className="text-2xl font-black">{kind === 'customer' ? 'كشف حساب عميل' : 'كشف حساب مورد'}</h2>
          <DialogCloseButton onClick={onClose} />
        </div>
        <div className="mb-5 grid min-w-0 gap-3 rounded-2xl bg-slate-100 p-4 print:hidden sm:grid-cols-2 lg:grid-cols-4">
          <DateField label="من" max={to} onChange={setFrom} value={from} />
          <DateField label="إلى" min={from} onChange={setTo} value={to} />
          <label className="font-black">المحل<select className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3" onChange={(event) => setStoreId(event.target.value)} value={storeId}><option value="">كل المحلات</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
          {kind === 'customer' && <label className="font-black">المشروع<select className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3" onChange={(event) => setProjectId(event.target.value)} value={projectId}><option value="">كل المشاريع</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
        </div>

        {loading && <p className="rounded-xl bg-sky-50 p-5 text-center font-black text-sky-900" role="status">جارٍ إعداد كشف الحساب…</p>}
        {error && <p className="rounded-xl bg-rose-50 p-5 text-center font-black text-rose-900" role="alert">{error}</p>}
        {statement && !loading && <>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-4 print:hidden">
            <DocumentOutputActions createPdf={async () => (await import('../pdf-documents')).createStatementPdf(statement)} documentRef={documentRef} fileName={`${kind === 'customer' ? 'كشف-عميل' : 'كشف-مورد'}-${statement.party.name}-${from}-${to}`} />
          </div>
          <StatementDocument documentRef={documentRef} statement={statement} />
        </>}
      </div>
    </div>
  )
}

function StatementDocument({ documentRef, statement }: { documentRef: RefObject<HTMLElement | null>; statement: AccountStatement }) {
  const customer = statement.kind === 'customer'
  return (
    <article className={`print-document statement-print-area ${customer ? 'customer-statement' : 'supplier-statement'} bg-white p-2`} dir="rtl" ref={documentRef}>
      <header className="document-header border-b-2 border-slate-900 pb-4 text-right">
        <p className="text-sm font-black text-slate-500">نظام إدارة الحسابات والمتجر</p>
        <h1 className="mt-1 text-3xl font-black">{customer ? 'كشف حساب عميل' : 'كشف حساب مورد'}</h1>
        <div className="mt-3 grid grid-cols-2 gap-2 text-sm font-bold sm:grid-cols-4">
          <p><span className="text-slate-500">الاسم:</span> {statement.party.name}</p>
          <p><span className="text-slate-500">الهاتف:</span> {statement.party.phone ?? '—'}</p>
          <p><span className="text-slate-500">من:</span> {statement.from}</p>
          <p><span className="text-slate-500">إلى:</span> {statement.to}</p>
          {statement.project && <p><span className="text-slate-500">المشروع:</span> {statement.project.name}</p>}
        </div>
      </header>
      <div className="my-4 flex items-center justify-between rounded-xl bg-slate-100 p-3 font-black">
        <span>الرصيد الافتتاحي</span><span dir="ltr">₪{formatDecimal(statement.opening_balance)}</span>
      </div>
      <div className="overflow-x-auto print:overflow-visible">
        <table className="statement-table w-full border-collapse text-right text-sm">
          <thead><tr><th>التاريخ</th><th>البيان</th><th>المستند / المحل</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead>
          <tbody>
            {statement.entries.map((entry) => <tr key={entry.id}>
              <td>{entry.date}</td>
              <td><strong>{entryLabel(entry, statement.kind)}</strong>{entry.description && <small>{entry.description}</small>}{entry.project_name && <small>المشروع: {entry.project_name}</small>}{entry.purchase_items?.map((item, index) => <small key={`${entry.id}:${index}`}>{item.product} - {formatDecimal(item.quantity)} × ₪{formatDecimal(item.unit_price)} = ₪{formatDecimal(item.line_total)}</small>)}</td>
              <td>{entry.document_number ?? `#${entry.source_id ?? entry.id}`}<small>{entry.store_name}</small></td>
              <td dir="ltr">{entry.debit === '0' ? '—' : `₪${formatDecimal(entry.debit)}`}</td>
              <td dir="ltr">{entry.credit === '0' ? '—' : `₪${formatDecimal(entry.credit)}`}</td>
              <td className="font-black" dir="ltr">₪{formatDecimal(entry.running_balance)}</td>
            </tr>)}
            {!statement.entries.length && <tr><td className="py-8 text-center font-bold text-slate-500" colSpan={6}>لا توجد حركات في الفترة المحددة.</td></tr>}
          </tbody>
        </table>
      </div>
      <footer className="document-footer mt-4 flex items-center justify-between border-t-2 border-slate-900 pt-4 text-lg font-black">
        <span>الرصيد الختامي</span><span dir="ltr">₪{formatDecimal(statement.closing_balance)}</span>
      </footer>
    </article>
  )
}
