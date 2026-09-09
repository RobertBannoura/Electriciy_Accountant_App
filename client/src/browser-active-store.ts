import { Store } from './types'

export const BROWSER_ACTIVE_STORE_KEY = 'electricity-accountant.active-store-id'

export function resolveBrowserActiveStoreId(storedId: string | null, stores: Store[]) {
  if (!storedId) return null
  return stores.some((store) => store.id === storedId) ? storedId : null
}

export function readBrowserActiveStoreId(stores: Store[]) {
  try {
    const storedId = window.localStorage.getItem(BROWSER_ACTIVE_STORE_KEY)
    const resolvedId = resolveBrowserActiveStoreId(storedId, stores)
    if (storedId && !resolvedId) window.localStorage.removeItem(BROWSER_ACTIVE_STORE_KEY)
    return resolvedId
  } catch {
    return null
  }
}

export function persistBrowserActiveStoreId(storeId: string) {
  try {
    window.localStorage.setItem(BROWSER_ACTIVE_STORE_KEY, storeId)
  } catch {
    // Storage can be blocked; the explicit in-memory selection still remains safe.
  }
}
