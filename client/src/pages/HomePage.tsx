import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api'
import { formatDecimal } from '../money-display'

type ReminderCheck = {
  id: string
  check_number: string
  amount: string
  due_date: string
  status: 'pending' | 'bounced'
  customer_name: string | null
  supplier_name: string | null
  is_owner_issued: boolean
}

type CheckReminders = {
  business_days: number
  due_today: ReminderCheck[]
  follow_up: ReminderCheck[]
  bounced: ReminderCheck[]
}

type HomeSummary = {
  date: string
  today_sales: string
  customer_debt: string
  supplier_debt: string
  cash_balances: Array<{ currency_code: string; balance: string }>
  bank_balance_ils: string
  cash_and_bank_ils: string
  checks_needing_follow_up: string
  low_stock_count: string
  recent_activity: Array<{
    kind: 'sale' | 'purchase' | 'expense' | 'customer_return' | 'supplier_return'
    id: string
    document_number: string
    amount: string
    business_date: string
  }>
}

const homeActions = [
  { label: 'بيع جديد', path: '/sale', primary: true },
  { label: 'الأصناف', path: '/products' },
  { label: 'العملاء', path: '/customers' },
  { label: 'الموردون', path: '/suppliers' },
  { label: 'المشتريات', path: '/purchases' },
  { label: 'الشيكات', path: '/checks' },
  { label: 'المصاريف', path: '/expenses' },
  { label: 'التقارير', path: '/reports' },
]

function localDate(value: string) {
  return new Intl.DateTimeFormat('ar-PS', { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`))
}

function currentBusinessDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

async function responseError(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } }
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch {
    // Use the stable fallback.
  }
  return fallback
}

async function showDesktopNotificationOnce(
  key: string,
  options: { title: string; body: string },
) {
  if (!window.desktop) return
  try {
    if (window.localStorage.getItem(key)) return
    window.localStorage.setItem(key, 'pending')
  } catch {
    // The notification can still be shown when local storage is unavailable.
  }
  try {
    const result = await window.desktop.showNotification(options)
    if (!result.shown) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, 'shown')
  } catch {
    try { window.localStorage.removeItem(key) } catch { /* Storage is optional. */ }
  }
}

function activityLabel(kind: HomeSummary['recent_activity'][number]['kind']) {
  return {
    sale: 'مبيعات',
    purchase: 'مشتريات',
    expense: 'مصروف',
    customer_return: 'مرتجع مبيعات',
    supplier_return: 'مرتجع مشتريات',
  }[kind]
}

export function HomePage({ isOnline, storeId }: { isOnline: boolean; storeId: string | null }) {
  const [reminders, setReminders] = useState<CheckReminders | null>(null)
  const [reminderError, setReminderError] = useState<string | null>(null)
  const [actingId, setActingId] = useState<string | null>(null)
  const [summary, setSummary] = useState<HomeSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  const loadSummary = useCallback(async (signal?: AbortSignal) => {
    if (!storeId) {
      setSummary(null)
      return
    }
    try {
      const response = await apiFetch('/reports/home', {
        headers: { 'X-Store-Id': storeId }, signal,
      })
      if (!response.ok) throw new Error(await responseError(response, 'تعذّر تحميل ملخص اليوم'))
      const payload = (await response.json()) as { summary: HomeSummary }
      setSummary(payload.summary)
      setSummaryError(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setSummaryError(error instanceof Error ? error.message : 'تعذّر تحميل ملخص اليوم')
    }
  }, [storeId])

  const loadReminders = useCallback(async (signal?: AbortSignal) => {
    if (!storeId) {
      setReminders(null)
      return
    }
    try {
      const response = await apiFetch('/checks/reminders', {
        headers: { 'X-Store-Id': storeId },
        signal,
      })
      if (!response.ok) throw new Error(await responseError(response, 'تعذّر تحميل تذكيرات الشيكات'))
      const payload = (await response.json()) as { reminders: CheckReminders }
      setReminders(payload.reminders)
      setReminderError(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setReminderError(error instanceof Error ? error.message : 'تعذّر تحميل تذكيرات الشيكات')
    }
  }, [storeId])

  useEffect(() => {
    const controller = new AbortController()
    void loadReminders(controller.signal)
    return () => controller.abort()
  }, [loadReminders])

  useEffect(() => {
    const controller = new AbortController()
    void loadSummary(controller.signal)
    return () => controller.abort()
  }, [loadSummary])

  useEffect(() => {
    if (!storeId || !reminders || reminders.due_today.length === 0 || !window.desktop) return
    const day = reminders.due_today[0].due_date
    const notificationKey = `check-due-notification:${storeId}:${day}`
    const body = reminders.due_today
      .slice(0, 3)
      .map((check) => `${check.customer_name ?? check.supplier_name ?? 'شيك'} — ₪${formatDecimal(check.amount)} — ${check.check_number}`)
      .join('\n')
    void showDesktopNotificationOnce(notificationKey, { title: 'شيكات مستحقة اليوم', body })
  }, [reminders, storeId])

  useEffect(() => {
    if (!storeId || !reminders || reminders.bounced.length === 0 || !window.desktop) return
    const notificationKey = `bounced-check-notification:${storeId}:${currentBusinessDate()}`
    const body = reminders.bounced
      .slice(0, 3)
      .map((check) => `${check.customer_name ?? check.supplier_name ?? 'شيك'} — ₪${formatDecimal(check.amount)} — ${check.check_number}`)
      .join('\n')
    void showDesktopNotificationOnce(notificationKey, { title: 'شيكات مرتجعة تحتاج متابعة', body })
  }, [reminders, storeId])

  const widgetChecks = useMemo(
    () => reminders ? [...reminders.follow_up, ...reminders.bounced] : [],
    [reminders],
  )

  async function act(check: ReminderCheck, action: 'clear' | 'bounce' | 'later' | 'stop-bounced-reminder') {
    if (!isOnline || !storeId || actingId) return
    if (action === 'bounce' && !window.confirm('سيُعاد مبلغ الشيك إلى الدين المستحق. هل تريد المتابعة؟')) return
    setActingId(check.id)
    setReminderError(null)
    try {
      const response = await apiFetch(`/checks/${check.id}/${action}`, {
        method: 'POST',
        headers: { 'X-Store-Id': storeId },
      })
      if (!response.ok) throw new Error(await responseError(response, 'تعذّر تحديث الشيك'))
      await Promise.all([loadReminders(), loadSummary()])
    } catch (error) {
      setReminderError(error instanceof Error ? error.message : 'تعذّر تحديث الشيك')
    } finally {
      setActingId(null)
    }
  }

  return (
    <section>
      <div className="mb-7">
        <p className="text-base font-bold text-teal-700">القائمة الرئيسية</p>
        <h1 className="mt-1 text-3xl font-black sm:text-4xl">ماذا تريد أن تفعل؟</h1>
      </div>

      <div className="hidden grid-cols-2 gap-4 sm:grid sm:gap-6">
        {homeActions.map((action) => (
          <Link
            className={`grid min-h-28 place-items-center rounded-2xl border px-4 text-center text-xl font-black shadow-md transition hover:-translate-y-0.5 hover:shadow-lg sm:min-h-32 sm:text-2xl ${
              action.primary
                ? 'border-teal-700 bg-teal-700 text-white shadow-teal-700/20 hover:bg-teal-800'
                : 'border-slate-200 bg-white text-slate-900 shadow-slate-200/60 hover:border-teal-300 hover:bg-teal-50'
            }`}
            key={action.path}
            to={action.path}
          >
            {action.label}
          </Link>
        ))}
      </div>

      {summary && (
        <section className="mt-9" aria-labelledby="home-summary-title">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-xl font-black" id="home-summary-title">ملخص اليوم</h2>
            <Link className="font-black text-teal-700 hover:text-teal-900" to="/reports">عرض التقارير</Link>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <SummaryCard label="مبيعات اليوم" value={`₪${formatDecimal(summary.today_sales)}`} />
            <SummaryCard label="ديون العملاء" value={`₪${formatDecimal(summary.customer_debt)}`} />
            <SummaryCard label="ديون الموردين" value={`₪${formatDecimal(summary.supplier_debt)}`} />
            <SummaryCard alert={summary.checks_needing_follow_up !== '0'} label="شيكات تحتاج متابعة" value={summary.checks_needing_follow_up} />
            <SummaryCard label="الصندوق والبنك" note={`الصندوق ₪${formatDecimal(summary.cash_balances.find((row) => row.currency_code === 'ILS')?.balance ?? '0')} • البنك ₪${formatDecimal(summary.bank_balance_ils)}`} value={`₪${formatDecimal(summary.cash_and_bank_ils)}`} />
            <SummaryCard alert={summary.low_stock_count !== '0'} label="المخزون المنخفض" value={summary.low_stock_count} />
          </div>
        </section>
      )}

      {summaryError && <p className="mt-5 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{summaryError}</p>}

      {summary && (
        <section className="mt-7" aria-labelledby="recent-activity-title">
          <h2 className="text-xl font-black" id="recent-activity-title">النشاط الأخير</h2>
          <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {summary.recent_activity.length === 0 ? (
              <p className="p-5 font-bold text-slate-500">لا يوجد نشاط حديث.</p>
            ) : summary.recent_activity.map((activity) => (
              <article className="flex items-center justify-between gap-3 border-b border-slate-100 p-4 last:border-0" key={`${activity.kind}:${activity.id}`}>
                <div>
                  <p className="font-black">{activityLabel(activity.kind)}</p>
                  <p className="mt-1 text-sm font-bold text-slate-500">{activity.document_number} · {localDate(activity.business_date)}</p>
                </div>
                <p className="shrink-0 font-black" dir="ltr">₪{formatDecimal(activity.amount)}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {reminders && reminders.due_today.length > 0 && (
        <p className="mb-5 mt-7 rounded-2xl border border-sky-300 bg-sky-50 p-4 font-black text-sky-950" role="status">
          لديك {reminders.due_today.length} شيك مستحق اليوم.
        </p>
      )}

      {reminders && widgetChecks.length > 0 && (
        <section className="mb-7 overflow-hidden rounded-3xl border-2 border-amber-400 bg-amber-50 shadow-xl shadow-amber-200/40" aria-labelledby="check-follow-up-title">
          <div className="border-b border-amber-300 bg-amber-100 px-5 py-4 sm:px-7">
            <h2 className="text-2xl font-black text-amber-950" id="check-follow-up-title">شيكات تحتاج متابعة</h2>
            <p className="mt-1 font-bold text-amber-900">المتأخرة {reminders.business_days} أيام عمل أو أكثر، والشيكات المرتجعة غير المغلقة تذكيراتها.</p>
          </div>
          <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-7">
            {widgetChecks.map((check) => (
              <article className="rounded-2xl border border-amber-200 bg-white p-5 shadow-sm" key={`${check.status}:${check.id}`}>
                <p className="text-xl font-black">{check.customer_name ?? check.supplier_name ?? 'شيك المنشأة'}</p>
                <p className="mt-2 text-2xl font-black" dir="ltr">₪{formatDecimal(check.amount)}</p>
                <p className="mt-2 font-bold text-slate-700">رقم الشيك: {check.check_number}</p>
                <p className="mt-1 font-bold text-slate-700">الاستحقاق: {localDate(check.due_date)}</p>
                {check.status === 'bounced' && <p className="mt-2 inline-flex rounded-full bg-rose-100 px-3 py-1 font-black text-rose-900">مرتجع — تذكير يومي</p>}
                <div className="mt-5 flex flex-wrap gap-2">
                  {check.status === 'pending' ? <>
                    <button className="min-h-11 rounded-xl bg-emerald-700 px-4 font-black text-white disabled:opacity-50" disabled={!isOnline || actingId === check.id} onClick={() => void act(check, 'clear')} type="button">تم تحصيله</button>
                    <button className="min-h-11 rounded-xl bg-rose-700 px-4 font-black text-white disabled:opacity-50" disabled={!isOnline || actingId === check.id} onClick={() => void act(check, 'bounce')} type="button">مرتجع</button>
                    <button className="min-h-11 rounded-xl border border-slate-300 px-4 font-black text-slate-700 disabled:opacity-50" disabled={!isOnline || actingId === check.id} onClick={() => void act(check, 'later')} type="button">لاحقاً</button>
                  </> : (
                    <button className="min-h-11 rounded-xl border border-slate-300 px-4 font-black text-slate-700 disabled:opacity-50" disabled={!isOnline || actingId === check.id} onClick={() => void act(check, 'stop-bounced-reminder')} type="button">إيقاف التذكير</button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {reminderError && <p className="mb-5 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{reminderError}</p>}

    </section>
  )
}

function SummaryCard({ alert = false, label, note, value }: { alert?: boolean; label: string; note?: string; value: string }) {
  return (
    <article className={`rounded-2xl border p-4 ${alert ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
      <p className={`text-sm font-black ${alert ? 'text-amber-900' : 'text-slate-500'}`}>{label}</p>
      <p className="mt-2 text-xl font-black" dir="ltr">{value}</p>
      {note && <p className="mt-1 text-xs font-bold text-slate-500" dir="ltr">{note}</p>}
    </article>
  )
}
