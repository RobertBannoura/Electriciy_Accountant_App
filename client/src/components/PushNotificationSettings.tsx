import { useEffect, useState } from 'react'
import { apiFetch } from '../api'

const categoryLabels = {
  sale_created: 'المبيعات الجديدة',
  customer_payment: 'دفعات العملاء',
  purchase_created: 'المشتريات الجديدة',
  supplier_payment: 'دفعات الموردين',
  check_due: 'الشيكات المستحقة اليوم',
  check_bounced: 'الشيكات المرتجعة',
} as const

type Category = keyof typeof categoryLabels
type NotificationSettings = Record<Category, boolean>
type PushStatus = {
  configured: boolean
  publicKey: string | null
  subscriptionCount: number
  settings: NotificationSettings
}

const defaultSettings: NotificationSettings = {
  sale_created: true,
  customer_payment: true,
  purchase_created: true,
  supplier_payment: true,
  check_due: true,
  check_bounced: true,
}

async function errorMessage(response: Response) {
  try {
    const payload = await response.json() as { error?: { message?: string } }
    if (payload.error?.message) return payload.error.message
  } catch {
    // Use the stable message below.
  }
  return 'تعذر إكمال إعداد الإشعارات.'
}

export function PushNotificationSettings() {
  const browserSupported = !window.desktop
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [settings, setSettings] = useState<NotificationSettings>(defaultSettings)
  const [deviceSubscribed, setDeviceSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/push/status', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorMessage(response))
        return response.json() as Promise<PushStatus>
      })
      .then(async (payload) => {
        setStatus(payload)
        setSettings(payload.settings)
        if (!browserSupported) return
        const registration = await navigator.serviceWorker.getRegistration()
        const subscription = await registration?.pushManager.getSubscription()
        setDeviceSubscribed(Boolean(subscription))
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setError(caught instanceof Error ? caught.message : 'تعذر تحميل إعدادات الإشعارات.')
      })
    return () => controller.abort()
  }, [browserSupported])

  async function enableNotifications() {
    if (!browserSupported || !status?.configured || !status.publicKey) return
    setBusy(true)
    setError(null)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') throw new Error('لم يتم منح إذن عرض الإشعارات لهذا التطبيق.')
      const registration = await navigator.serviceWorker.getRegistration()
      if (!registration) throw new Error('ثبّت التطبيق أو افتح نسخة الإنتاج الآمنة أولاً لتفعيل الإشعارات.')
      const existing = await registration.pushManager.getSubscription()
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidPublicKey(status.publicKey),
      })
      const response = await apiFetch('/push/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      setDeviceSubscribed(true)
      setStatus((current) => current ? {
        ...current,
        subscriptionCount: Math.max(1, current.subscriptionCount),
      } : current)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر تفعيل الإشعارات.')
    } finally {
      setBusy(false)
    }
  }

  async function disableNotifications() {
    if (!browserSupported) return
    setBusy(true)
    setError(null)
    try {
      const registration = await navigator.serviceWorker.getRegistration()
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        const response = await apiFetch('/push/subscriptions', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        })
        if (!response.ok) throw new Error(await errorMessage(response))
        await subscription.unsubscribe()
      }
      setDeviceSubscribed(false)
      setStatus((current) => current ? {
        ...current,
        subscriptionCount: Math.max(0, current.subscriptionCount - 1),
      } : current)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر إيقاف الإشعارات.')
    } finally {
      setBusy(false)
    }
  }

  async function saveSettings() {
    setBusy(true)
    setSaved(false)
    setError(null)
    try {
      const response = await apiFetch('/push/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = await response.json() as { settings: NotificationSettings }
      setSettings(payload.settings)
      setSaved(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر حفظ فئات الإشعارات.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 border-t border-slate-200 pt-8" aria-labelledby="push-settings-title">
      <h2 className="text-xl font-black" id="push-settings-title">إشعارات المدير</h2>
      <p className="mt-2 leading-7 text-slate-600">تنبيهات آمنة للمبيعات والدفعات والمشتريات والشيكات على أجهزة المدير المسجلة فقط.</p>

      {!browserSupported && <p className="mt-4 rounded-xl bg-slate-100 p-4 font-bold text-slate-700">Web Push متاح من نسخة الويب أو PWA على متصفح داعم، وليس من نافذة Electron.</p>}
      {status && !status.configured && <p className="mt-4 rounded-xl bg-amber-50 p-4 font-bold text-amber-900">يجب ضبط مفاتيح VAPID على الخادم قبل التفعيل.</p>}

      {status?.configured && browserSupported && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button className="min-h-12 rounded-xl bg-teal-700 px-6 font-black text-white disabled:opacity-50" disabled={busy || deviceSubscribed} onClick={() => void enableNotifications()} type="button">تفعيل الإشعارات على هذا الجهاز</button>
          <button className="min-h-12 rounded-xl border border-slate-300 px-6 font-black disabled:opacity-50" disabled={busy || !deviceSubscribed} onClick={() => void disableNotifications()} type="button">إيقافها على هذا الجهاز</button>
          <span className="font-bold text-slate-600">الأجهزة المسجلة: {status.subscriptionCount}</span>
        </div>
      )}

      {status && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {(Object.keys(categoryLabels) as Category[]).map((category) => (
            <label className="flex min-h-12 items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 font-bold" key={category}>
              <input checked={settings[category]} className="size-5 accent-teal-700" onChange={(event) => { setSettings((current) => ({ ...current, [category]: event.target.checked })); setSaved(false) }} type="checkbox" />
              {categoryLabels[category]}
            </label>
          ))}
        </div>
      )}

      {status && <button className="mt-4 min-h-12 rounded-xl bg-slate-900 px-6 font-black text-white disabled:opacity-50" disabled={busy} onClick={() => void saveSettings()} type="button">حفظ فئات الإشعارات</button>}
      {saved && <p className="mt-3 font-bold text-emerald-800" role="status">تم حفظ إعدادات الإشعارات.</p>}
      {error && <p className="mt-3 rounded-xl bg-rose-50 p-4 font-bold text-rose-800" role="alert">{error}</p>}
    </section>
  )
}

function decodeVapidPublicKey(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const binary = window.atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

