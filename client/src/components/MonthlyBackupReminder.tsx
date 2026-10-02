import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

const storageKey = 'external-backup-completed-month'

function businessMonth() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date())
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`
}

export function MonthlyBackupReminder() {
  const [due, setDue] = useState(false)
  const completedMonth = useRef<string | null>(null)

  function markCompleted() {
    const month = businessMonth()
    completedMonth.current = month
    try { localStorage.setItem(storageKey, month) } catch { /* Keep completion for this session. */ }
    setDue(false)
  }

  useEffect(() => {
    const desktop = window.desktop
    if (!desktop) return
    let stopped = false
    let checking = false

    async function checkReminder() {
      if (stopped || checking) return
      const month = businessMonth()
      let storedMonth: string | null = null
      try { storedMonth = localStorage.getItem(storageKey) } catch { /* Session completion still applies. */ }
      if (completedMonth.current === month || storedMonth === month) {
        setDue(false)
        return
      }
      checking = true
      try {
        const status = await desktop!.getBackupStatus()
        if (stopped) return
        if (completedMonth.current === month) {
          setDue(false)
        } else if (status.today.startsWith(month) && status.monthlyDirectory && !status.monthlyBackupDue) {
          // Remember a successful copy even after the external drive is unplugged.
          completedMonth.current = month
          try { localStorage.setItem(storageKey, month) } catch { /* Session completion still applies. */ }
          setDue(false)
        } else {
          setDue(true)
        }
      } catch {
        if (!stopped) setDue(true)
      } finally {
        checking = false
      }
    }

    void checkReminder()
    const timer = window.setInterval(() => void checkReminder(), 60 * 60 * 1000)
    window.addEventListener('focus', checkReminder)
    window.addEventListener('backup-settings-changed', checkReminder)
    window.addEventListener('backup-created', checkReminder)
    return () => {
      stopped = true
      window.clearInterval(timer)
      window.removeEventListener('focus', checkReminder)
      window.removeEventListener('backup-settings-changed', checkReminder)
      window.removeEventListener('backup-created', checkReminder)
    }
  }, [])

  if (!due) return null

  return (
    <aside aria-label="تذكير النسخ الاحتياطي الشهري" className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950 print:hidden" role="status">
      <h2 className="text-lg font-black">تذكير شهري: احفظ نسخة على قرص خارجي</h2>
      <p className="mt-2 leading-7">وصّل قرصاً خارجياً أو USB واحفظ عليه نسخة احتياطية من بيانات البرنامج لهذا الشهر. بعد اكتمال النسخ، افصل القرص واحتفظ به في مكان آمن.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <Link className="inline-flex min-h-11 items-center rounded-xl bg-amber-700 px-4 font-black text-white hover:bg-amber-800" to="/settings#backup-settings">فتح إعدادات النسخ الاحتياطي</Link>
        <button className="min-h-11 rounded-xl border border-amber-400 bg-white px-4 font-black hover:bg-amber-100" onClick={markCompleted} type="button">تم النسخ إلى قرص خارجي</button>
      </div>
    </aside>
  )
}
