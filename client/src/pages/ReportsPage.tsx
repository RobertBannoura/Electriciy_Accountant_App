import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch } from '../api'
import { DateField } from '../components/DateField'
import { formatCurrencyAmount, formatIls } from '../money-display'
import { Store } from '../types'

type ReportKey = 'sales' | 'purchases' | 'profit' | 'expenses' | 'customerDebt'
  | 'supplierDebt' | 'inventory' | 'money' | 'checks' | 'comparison'
type PeriodKey = 'today' | 'week' | 'month' | 'custom'
const reportKeys: ReportKey[] = ['sales', 'purchases', 'profit', 'expenses', 'customerDebt', 'supplierDebt', 'inventory', 'money', 'checks', 'comparison']

type CashMovement = { currency_code: string; inflow: string; outflow: string; net: string }
type CheckSummary = { status: string; count: string; amount: string }
type StoreComparison = {
  store_id: string
  store_name: string
  sales: string
  purchases: string
  gross_profit: string
  expenses: string
  net_profit: string
}
type ReportSummary = {
  sales: string
  purchases: string
  cost_of_goods: string
  gross_profit: string
  expenses: string
  net_profit: string
  sales_returns: string
  purchase_returns: string
  customer_debt: string
  indebted_customers: string
  supplier_debt: string
  owed_suppliers: string
  inventory_value: string
  inventory_lines: string
  low_stock_count: string
  inflow_ils: string
  outflow_ils: string
  net_ils: string
  check_count: string
  cash_movements: CashMovement[]
  checks: CheckSummary[]
}
type ReportResponse = {
  filters: { from: string; to: string; store_id: string | null }
  summary: ReportSummary
  store_comparison: StoreComparison[]
}

const statusLabels: Record<string, string> = {
  pending: 'قيد التحصيل',
  cleared: 'محصّلة',
  bounced: 'مرتجعة',
}

function businessToday() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function periodDates(period: Exclude<PeriodKey, 'custom'>, today = businessToday()) {
  if (period === 'today') return { from: today, to: today }
  if (period === 'month') return { from: `${today.slice(0, 7)}-01`, to: today }
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()
  return { from: shiftDate(today, -weekday), to: today }
}

async function reportError(response: Response) {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    if (body.error?.message) return body.error.message
  } catch {
    // Keep the concise fallback.
  }
  return 'تعذّر تحميل التقرير'
}

export function ReportsPage({ stores }: { stores: Store[] }) {
  const [searchParams] = useSearchParams()
  const initialDates = periodDates('month')
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [from, setFrom] = useState(initialDates.from)
  const [to, setTo] = useState(initialDates.to)
  const [storeId, setStoreId] = useState('')
  const [selected, setSelected] = useState<ReportKey>('profit')
  const [report, setReport] = useState<ReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const section = searchParams.get('section')
    if (section && reportKeys.includes(section as ReportKey)) setSelected(section as ReportKey)
  }, [searchParams])

  useEffect(() => {
    const controller = new AbortController()
    const search = new URLSearchParams({ from, to })
    if (storeId) search.set('storeId', storeId)
    setLoading(true)
    apiFetch(`/reports?${search}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await reportError(response))
        return response.json() as Promise<ReportResponse>
      })
      .then((payload) => {
        setReport(payload)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setError(reason instanceof Error ? reason.message : 'تعذّر تحميل التقرير')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [from, storeId, to])

  function choosePeriod(nextPeriod: Exclude<PeriodKey, 'custom'>) {
    const dates = periodDates(nextPeriod)
    setPeriod(nextPeriod)
    setFrom(dates.from)
    setTo(dates.to)
  }

  const cards = useMemo(() => {
    if (!report) return []
    const summary = report.summary
    return [
      { key: 'sales' as const, label: 'المبيعات', value: formatIls(summary.sales) },
      { key: 'purchases' as const, label: 'المشتريات', value: formatIls(summary.purchases) },
      { key: 'profit' as const, label: 'الأرباح', value: formatIls(summary.net_profit) },
      { key: 'expenses' as const, label: 'المصاريف', value: formatIls(summary.expenses) },
      { key: 'customerDebt' as const, label: 'ديون العملاء', value: formatIls(summary.customer_debt) },
      { key: 'supplierDebt' as const, label: 'ديون الموردين', value: formatIls(summary.supplier_debt) },
      { key: 'inventory' as const, label: 'المخزون', value: formatIls(summary.inventory_value) },
      { key: 'money' as const, label: 'حركة الأموال', value: formatIls(summary.net_ils) },
      { key: 'checks' as const, label: 'الشيكات', value: `${summary.check_count} شيك` },
      { key: 'comparison' as const, label: 'مقارنة المحلين', value: `${report.store_comparison.length} محل` },
    ]
  }, [report])

  return (
    <section aria-labelledby="reports-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="hidden sm:block">
          <p className="font-bold text-teal-700">ملخصات واضحة لاتخاذ القرار</p>
          <h1 className="hidden text-3xl font-black sm:mt-1 sm:block sm:text-4xl" id="reports-title">التقارير</h1>
        </div>
        <p className="rounded-xl bg-slate-100 px-4 py-2 font-bold text-slate-600">القيم المحاسبية بـ ₪</p>
      </div>

      <section className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="مرشحات التقارير">
        <div className="flex flex-wrap gap-2">
          {([
            ['today', 'اليوم'], ['week', 'هذا الأسبوع'], ['month', 'هذا الشهر'], ['custom', 'فترة مخصصة'],
          ] as const).map(([key, label]) => (
            <button
              className={`min-h-11 rounded-xl px-4 font-black ${period === key ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
              key={key}
              onClick={() => key === 'custom' ? setPeriod('custom') : choosePeriod(key)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-3">
          <label className="font-bold text-slate-700">المحل
            <select className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 font-black" onChange={(event) => setStoreId(event.target.value)} value={storeId}>
              <option value="">الكل</option>
              {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
          </label>
          <DateField label="من" max={to} onChange={(value) => { setPeriod('custom'); setFrom(value) }} value={from} />
          <DateField label="إلى" min={from} onChange={(value) => { setPeriod('custom'); setTo(value) }} value={to} />
        </div>
      </section>

      {error && <p className="mt-5 rounded-2xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}
      {loading && <p className="mt-5 rounded-2xl bg-teal-50 p-4 font-bold text-teal-900" role="status">جارٍ إعداد التقرير…</p>}

      {report && (
        <>
          <div className="mt-7 grid grid-cols-2 gap-3 lg:grid-cols-5">
            {cards.map((card) => (
              <button
                aria-pressed={selected === card.key}
                className={`min-h-24 rounded-2xl border p-3 text-right shadow-sm transition hover:-translate-y-0.5 active:scale-[.98] sm:min-h-28 sm:p-4 ${selected === card.key ? 'border-teal-700 bg-teal-700 text-white shadow-teal-900/15' : 'border-slate-200 bg-white hover:border-teal-300'}`}
                key={card.key}
                onClick={() => setSelected(card.key)}
                type="button"
              >
                <span className={`block text-sm font-black ${selected === card.key ? 'text-teal-50' : 'text-slate-500'}`}>{card.label}</span>
                <span className="mt-2 block text-xl font-black" dir="ltr">{card.value}</span>
              </button>
            ))}
          </div>
          <ReportDetail report={report} selected={selected} />
        </>
      )}
    </section>
  )
}

function MetricRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 border-b border-slate-200 py-3 last:border-0 ${strong ? 'text-xl font-black' : 'font-bold'}`}>
      <span>{label}</span><span dir="ltr">{value}</span>
    </div>
  )
}

function ReportDetail({ report, selected }: { report: ReportResponse; selected: ReportKey }) {
  const s = report.summary
  const simple: Partial<Record<ReportKey, Array<[string, string]>>> = {
    sales: [['صافي المبيعات', formatIls(s.sales)], ['مرتجعات المبيعات', formatIls(s.sales_returns)]],
    purchases: [['صافي المشتريات', formatIls(s.purchases)], ['مرتجعات المشتريات', formatIls(s.purchase_returns)]],
    expenses: [['إجمالي المصاريف', formatIls(s.expenses)]],
    customerDebt: [['إجمالي الدين الحالي', formatIls(s.customer_debt)], ['عملاء عليهم رصيد', s.indebted_customers]],
    supplierDebt: [['إجمالي الدين الحالي', formatIls(s.supplier_debt)], ['موردون لهم رصيد', s.owed_suppliers]],
    inventory: [['قيمة المخزون الحالية', formatIls(s.inventory_value)], ['أرصدة أصناف', s.inventory_lines], ['مخزون منخفض', s.low_stock_count]],
  }

  return (
    <section className="mt-5 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7" aria-live="polite">
      {selected === 'profit' && <>
        <h2 className="text-2xl font-black">تقرير الأرباح</h2>
        <p className="mt-1 text-sm font-bold text-slate-500">تعتمد تكلفة البضاعة على لقطة التكلفة المحفوظة وقت البيع.</p>
        <div className="mt-4">
          <MetricRow label="المبيعات" value={formatIls(s.sales)} />
          <MetricRow label="تكلفة البضاعة" value={formatIls(s.cost_of_goods)} />
          <MetricRow label="الربح الإجمالي" value={formatIls(s.gross_profit)} />
          <MetricRow label="المصاريف" value={formatIls(s.expenses)} />
          <MetricRow label="صافي الربح" strong value={formatIls(s.net_profit)} />
        </div>
      </>}

      {simple[selected] && <>
        <h2 className="text-2xl font-black">{selected === 'inventory' ? 'المخزون' : 'تفاصيل التقرير'}</h2>
        <div className="mt-4">{simple[selected]?.map(([label, value]) => <MetricRow key={label} label={label} value={value} />)}</div>
      </>}

      {selected === 'money' && <>
        <h2 className="text-2xl font-black">حركة الأموال</h2>
        <div className="mt-4"><MetricRow label="الداخل — ₪" value={formatIls(s.inflow_ils)} /><MetricRow label="الخارج — ₪" value={formatIls(s.outflow_ils)} /><MetricRow label="صافي الحركة — ₪" strong value={formatIls(s.net_ils)} /></div>
        {s.cash_movements.filter((row) => row.currency_code !== 'ILS').map((row) => <MetricRow key={row.currency_code} label={`صافي الصندوق — ${row.currency_code}`} value={formatCurrencyAmount(row.net, row.currency_code)} />)}
      </>}

      {selected === 'checks' && <>
        <h2 className="text-2xl font-black">الشيكات حسب تاريخ الاستحقاق</h2>
        <div className="mt-4">{s.checks.length ? s.checks.map((row) => <MetricRow key={row.status} label={`${statusLabels[row.status] ?? row.status} (${row.count})`} value={formatIls(row.amount)} />) : <p className="font-bold text-slate-500">لا توجد شيكات في هذه الفترة.</p>}</div>
      </>}

      {selected === 'comparison' && <>
        <h2 className="text-2xl font-black">مقارنة المحلين</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-170 border-collapse text-right">
            <thead><tr className="bg-slate-100"><th className="p-3">المحل</th><th className="p-3">المبيعات</th><th className="p-3">المشتريات</th><th className="p-3">الربح الإجمالي</th><th className="p-3">المصاريف</th><th className="p-3">صافي الربح</th></tr></thead>
            <tbody>{report.store_comparison.map((row) => <tr className="border-b border-slate-200" key={row.store_id}><th className="p-3">{row.store_name}</th><td className="p-3" dir="ltr">{formatIls(row.sales)}</td><td className="p-3" dir="ltr">{formatIls(row.purchases)}</td><td className="p-3" dir="ltr">{formatIls(row.gross_profit)}</td><td className="p-3" dir="ltr">{formatIls(row.expenses)}</td><td className="p-3 font-black" dir="ltr">{formatIls(row.net_profit)}</td></tr>)}</tbody>
          </table>
        </div>
      </>}
    </section>
  )
}
