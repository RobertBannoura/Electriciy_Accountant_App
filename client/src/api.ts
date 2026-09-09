export const apiUrl =
  import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api'

const sessionTokenKey = 'electricity-accountant-session'
const cachedUserKey = 'electricity-accountant-user'
export const connectionStatusEvent = 'app:connection-status'
let serverReachable = typeof navigator === 'undefined' ? true : navigator.onLine

function announceConnection(available: boolean) {
  serverReachable = available
  window.dispatchEvent(new CustomEvent(connectionStatusEvent, { detail: { available } }))
}

function isMutation(init?: RequestInit) {
  const method = (init?.method ?? 'GET').toUpperCase()
  return !['GET', 'HEAD', 'OPTIONS'].includes(method)
}

export type AuthUser = {
  id: string
  username: string
  displayName: string
  role: 'admin'
}

export function getAuthToken() {
  return sessionStorage.getItem(sessionTokenKey)
}

export function setAuthToken(token: string) {
  sessionStorage.setItem(sessionTokenKey, token)
}

export function clearAuthToken() {
  sessionStorage.removeItem(sessionTokenKey)
}

export function readCachedAuthUser(): AuthUser | null {
  try {
    const value = localStorage.getItem(cachedUserKey)
    if (!value) return null
    const user = JSON.parse(value) as Partial<AuthUser>
    return typeof user.id === 'string'
      && typeof user.username === 'string'
      && typeof user.displayName === 'string'
      && user.role === 'admin'
      ? user as AuthUser
      : null
  } catch {
    return null
  }
}

export function cacheAuthUser(user: AuthUser) {
  localStorage.setItem(cachedUserKey, JSON.stringify(user))
}

export function clearCachedAuthUser() {
  localStorage.removeItem(cachedUserKey)
}

export function publicApiFetch(path: string, init?: RequestInit) {
  if (!navigator.onLine || (isMutation(init) && !serverReachable)) {
    announceConnection(false)
    return Promise.reject(new Error('لا يوجد اتصال بالخادم. أُوقفت العمليات المالية حتى عودة الاتصال.'))
  }

  return fetch(`${apiUrl}${path}`, init)
    .then((response) => {
      announceConnection(true)
      return response
    })
    .catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      announceConnection(false)
      throw new Error('تعذّر الاتصال بالخادم. تحقق من الشبكة ثم حاول مرة أخرى.')
    })
}

export function apiFetch(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  const token = getAuthToken()

  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  return publicApiFetch(path, { ...init, headers }).then((response) => {
    if (response.status === 401) {
      clearAuthToken()
      window.dispatchEvent(new Event('auth:expired'))
    }

    return response
  })
}

/**
 * Use this for future Electron operations whose records belong to a store.
 * The device assignment is loaded automatically instead of asking at checkout.
 */
export async function storeScopedApiFetch(path: string, init?: RequestInit) {
  if (!window.desktop) {
    throw new Error('سياق متجر الجهاز متاح في تطبيق سطح المكتب فقط')
  }

  const { storeId } = await window.desktop.getStoreAssignment()

  if (!storeId) {
    throw new Error('يجب تحديد متجر هذا الجهاز من الإعدادات أولاً')
  }

  const headers = new Headers(init?.headers)
  headers.set('X-Store-Id', storeId)

  return apiFetch(path, { ...init, headers })
}
