import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api'
import { formatIls } from '../money-display'
import { Store } from '../types'

type Period = 'today' | 'week' | 'month'
type MoneyReport = {
  filters: { from: string; to: string; store_id: string | null }
  summary: {
    inflow_ils: string
    outflow_ils: string
    net_ils: string
    cash_movements: Array<{ currency_code: string; inflow: string; outflow: string; net: string }>
  }
}

function businessToday() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function periodDates(period: Period) {
  const today = businessToday()
  if (period === 'today') return { from: today, to: today }
  if (period === 'month') return { from: `${today.slice(0, 7)}-01`, to: today }
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()
  return { from: shiftDate(today, -weekday), to: today }
}

export function MobileMoneyPage({ stores }: { stores: Store[] }) {
  const [period, setPeriod] = useState<Period>('month')
  const [storeId, setStoreId] = useState('')
  const [report, setReport] = useState<MoneyReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const dates = periodDates(period)
    const search = new URLSearchParams(dates)
    if (storeId) search.set('storeId', storeId)
    setLoading(true)
    setError(null)
    apiFetch(`/reports?${search}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('تعذّر تحميل حركة الأموال')
        return response.json() as Promise<MoneyReport>
      })
      .then(setReport)
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setError(reason instanceof Error ? reason.message : 'تعذّر تحميل حركة الأموال')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [period, storeId])

  return (
    <section aria-labelledby="money-title">
      <div className="hidden rounded-3xl bg-gradient-to-br from-teal-700 to-emerald-600 p-5 text-white shadow-lg shadow-teal-900/15 sm:block">
        <p className="text-sm font-black text-teal-100">عرض مالي فقط</p>
        <h1 className="hidden text-3xl font-black sm:mt-1 sm:block" id="money-title">الحسابات</h1>
        <p className="mt-2 text-sm font-bold text-teal-50/85">تابع الداخل والخارج وصافي الحركة دون إدخال عمليات من الهاتف.</p>
      </div>

      <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-3 gap-2">
          {([['today', 'اليوم'], ['week', 'الأسبوع'], ['month', 'الشهر']] as const).map(([key, label]) => (
            <button aria-pressed={period === key} className={`min-h-11 rounded-xl px-2 text-sm font-black ${period === key ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-700'}`} key={key} onClick={() => setPeriod(key)} type="button">{label}</button>
          ))}
        </div>
        {stores.length > 1 && <label className="mt-3 block text-sm font-black text-slate-700">المحل<select className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-black" onChange={(event) => setStoreId(event.target.value)} value={storeId}><option value="">كل المحلات</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>}
      </div>

      {loading && <p className="mt-4 rounded-2xl bg-teal-50 p-4 text-center font-black text-teal-900" role="status">جارٍ تحميل الملخص…</p>}
      {error && <p className="mt-4 rounded-2xl bg-rose-50 p-4 text-center font-black text-rose-900" role="alert">{error}</p>}

      {report && !loading && <>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <MoneyCard label="الأموال الداخلة" tone="in" value={formatIls(report.summary.inflow_ils)} />
          <MoneyCard label="الأموال الخارجة" tone="out" value={formatIls(report.summary.outflow_ils)} />
          <article className="col-span-2 rounded-2xl border border-teal-600 bg-teal-700 p-5 text-white shadow-sm shadow-teal-900/10"><p className="text-sm font-black text-teal-100">صافي الحركة</p><p className="mt-2 text-3xl font-black" dir="ltr">{formatIls(report.summary.net_ils)}</p><p className="mt-2 text-xs font-bold text-teal-100/80">من {report.filters.from} إلى {report.filters.to}</p></article>
        </div>
        {report.summary.cash_movements.length > 0 && <section className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><h2 className="border-b border-slate-200 bg-slate-50 p-4 text-lg font-black">الحركة حسب العملة</h2>{report.summary.cash_movements.map((row) => <div className="grid grid-cols-3 gap-2 border-b border-slate-100 p-4 text-center last:border-0" key={row.currency_code}><div><p className="text-xs font-bold text-slate-500">داخل</p><p className="mt-1 font-black" dir="ltr">{row.inflow} {row.currency_code}</p></div><div><p className="text-xs font-bold text-slate-500">خارج</p><p className="mt-1 font-black" dir="ltr">{row.outflow} {row.currency_code}</p></div><div><p className="text-xs font-bold text-slate-500">الصافي</p><p className="mt-1 font-black" dir="ltr">{row.net} {row.currency_code}</p></div></div>)}</section>}
      </>}

      <Link className="mt-4 flex min-h-12 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 font-black text-slate-800" to="/reports?section=money">عرض جميع التقارير</Link>
    </section>
  )
}

function MoneyCard({ label, tone, value }: { label: string; tone: 'in' | 'out'; value: string }) {
  return <article className={`rounded-2xl border p-4 shadow-sm ${tone === 'in' ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : 'border-rose-200 bg-rose-50 text-rose-950'}`}><p className="text-sm font-black opacity-70">{label}</p><p className="mt-2 text-xl font-black" dir="ltr">{value}</p></article>
}
