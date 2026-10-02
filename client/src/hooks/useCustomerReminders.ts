import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { apiFetch } from '../api'

export type CustomerReminder = {
  id: string
  name: string
  phone: string | null
  balance_ils: string
  debt_limit_ils: string | null
  payment_promise_date: string | null
  payment_promise_note: string | null
  payment_promise_version: string
  limit_reached: boolean
  promise_due: boolean
  needs_notification: boolean
}
export const customerRemindersChanged = 'app:customer-reminders-changed'

export function useCustomerReminders(storeId: string | null, isOnline: boolean) {
  const [data, setData] = useState<{ customers: CustomerReminder[]; business_date: string } | null>(null)
  const [error, setError] = useState(false)
  const location = useLocation()
  const load = useCallback(async (signal: AbortSignal) => {
    if (!storeId) return
    try {
      const response = await apiFetch('/customers/reminders', { headers: { 'X-Store-Id': storeId }, signal })
      if (!response.ok) throw new Error('Unable to load customer reminders')
      const payload = await response.json() as NonNullable<typeof data>
      if (signal.aborted) return
      setData(payload)
      setError(false)
    } catch {
      if (!signal.aborted) setError(true)
    }
  }, [storeId])

  useEffect(() => {
    const controller = new AbortController()
    let busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      try { await load(controller.signal) } finally { busy = false }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener(customerRemindersChanged, refresh)
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => {
      controller.abort()
      window.removeEventListener('focus', refresh)
      window.removeEventListener(customerRemindersChanged, refresh)
      window.clearInterval(timer)
    }
  }, [load, isOnline, location.key])
  return { data, error }
}
