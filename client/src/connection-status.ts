import { useEffect, useState } from 'react'
import { connectionStatusEvent, publicApiFetch } from './api'

export function useConnectionStatus() {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    function offline() { setIsOnline(false) }
    function changed(event: Event) {
      const detail = (event as CustomEvent<{ available: boolean }>).detail
      setIsOnline(detail.available)
    }
    function online() {
      void publicApiFetch('/health', { cache: 'no-store' }).catch(() => {})
    }

    window.addEventListener('offline', offline)
    window.addEventListener('online', online)
    window.addEventListener(connectionStatusEvent, changed)
    return () => {
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', online)
      window.removeEventListener(connectionStatusEvent, changed)
    }
  }, [])

  return isOnline
}
