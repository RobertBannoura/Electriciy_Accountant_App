import { useEffect } from 'react'
import { useCustomerReminders } from '../hooks/useCustomerReminders'

const shown = new Set<string>()
let notifying = false

export function CustomerReminderNotifications({ storeId, isOnline, userId }: { storeId: string | null; isOnline: boolean; userId: string }) {
  const { data, error } = useCustomerReminders(storeId, isOnline)
  useEffect(() => {
    if (!window.desktop || !data || error || !isOnline || !storeId || notifying) return
    const keys = data.customers.filter((customer) => customer.needs_notification).map((customer) =>
      `customer-reminder:${userId}:${customer.id}:${data.business_date}:${customer.promise_due ? customer.payment_promise_version : 'limit'}`,
    ).filter((key) => {
      if (shown.has(key)) return false
      try { return !localStorage.getItem(key) } catch { return true }
    })
    if (!keys.length) return
    notifying = true
    void window.desktop.showNotification({ kind: 'customer_reminders', count: Math.min(keys.length, 10_000) })
      .then((result) => {
        if (!result.shown) return
        for (const key of keys) {
          shown.add(key)
          try { localStorage.setItem(key, 'shown') } catch { /* Session memory still prevents repeats. */ }
        }
      })
      .catch(() => { /* Retry on the next poll if desktop notifications fail. */ })
      .finally(() => { notifying = false })
  }, [data, error, isOnline, storeId, userId])
  return null
}
