export const apiUrl = window.location.protocol === 'app:'
  ? window.desktop?.trialMode && window.desktop.trialApiBaseUrl
    ? window.desktop.trialApiBaseUrl
    : (() => { throw new Error('تعذر الاتصال بالخدمة المحلية') })()
  : import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api'

const sessionTokenKey = 'electricity-accountant-session'
const rememberedSessionTokenKey = 'electricity-accountant-remembered-session'
const cachedUserKey = 'electricity-accountant-user'
export const connectionStatusEvent = 'app:connection-status'
let serverReachable = typeof navigator === 'undefined' || Boolean(window.desktop?.trialMode)
  ? true : navigator.onLine
const financialRequestStoragePrefix = 'electricity-accountant-financial-request:'
const financialRequestRetryWindowMs = 5 * 60 * 1000
const financialRequestCompletedWindowMs = 3 * 1000

type StoredFinancialRequest = { requestId: string; expiresAt: number }

function announceConnection(available: boolean) {
  serverReachable = available
  window.dispatchEvent(new CustomEvent(connectionStatusEvent, { detail: { available } }))
}

function isMutation(init?: RequestInit) {
  const method = (init?.method ?? 'GET').toUpperCase()
  return !['GET', 'HEAD', 'OPTIONS'].includes(method)
}

function shortHash(value: string) {
  let first = 2166136261
  let second = 2246822519
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 3266489917)
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`
}

function financialRequestIdentity(path: string, init: RequestInit | undefined, headers: Headers) {
  const method = (init?.method ?? 'GET').toUpperCase()
  const signature = JSON.stringify({
    method,
    path,
    storeId: headers.get('X-Store-Id'),
    body: typeof init?.body === 'string' ? init.body : null,
  })
  const signatureHash = shortHash(signature)
  const storageKey = `${financialRequestStoragePrefix}${signatureHash}`
  const now = Date.now()

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as StoredFinancialRequest | null
    if (saved && saved.expiresAt > now) return { ...saved, storageKey }
  } catch {
    // Storage can be unavailable in hardened browser contexts. The request
    // still receives a strong unique id; only cross-tab reuse is unavailable.
  }

  // The time bucket closes the tiny cross-tab race where both tabs read before
  // either writes. A different payload with a hash collision is rejected by
  // the server-side SHA-256 request hash and never reuses financial effects.
  const requestId = `fin-${signatureHash}-${Math.floor(now / 5000).toString(36)}`
  const saved = { requestId, expiresAt: now + financialRequestRetryWindowMs }
  try {
    localStorage.setItem(storageKey, JSON.stringify(saved))
  } catch {
    // See storage note above.
  }
  return { ...saved, storageKey }
}

function markFinancialRequestCompleted(storageKey: string, requestId: string) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      requestId,
      expiresAt: Date.now() + financialRequestCompletedWindowMs,
    }))
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

export type AuthUser = {
  id: string
  username: string
  displayName: string
  role: 'admin'
}

type AuthTokenOptions = {
  remember?: boolean
  expiresAt?: string
}

type RememberedSession = {
  token: string
  expiresAt: string
}

const sessionTokenPattern = /^[A-Za-z0-9_-]{43}$/

function readRememberedSession() {
  try {
    const value = localStorage.getItem(rememberedSessionTokenKey)
    if (!value) return null
    const session = JSON.parse(value) as Partial<RememberedSession>
    const expiresAt = typeof session.expiresAt === 'string'
      ? Date.parse(session.expiresAt)
      : Number.NaN
    if (
      typeof session.token !== 'string'
      || !sessionTokenPattern.test(session.token)
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()
    ) {
      localStorage.removeItem(rememberedSessionTokenKey)
      return null
    }
    return session as RememberedSession
  } catch {
    try { localStorage.removeItem(rememberedSessionTokenKey) } catch { /* Storage is optional. */ }
    return null
  }
}

export function getAuthToken() {
  try {
    const token = sessionStorage.getItem(sessionTokenKey)
    if (token) return token
  } catch {
    // Fall through to the explicit remembered-session store.
  }
  return readRememberedSession()?.token ?? null
}

export function setAuthToken(token: string, options: AuthTokenOptions = {}) {
  clearAuthToken()
  if (options.remember && options.expiresAt) {
    const expiresAt = Date.parse(options.expiresAt)
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      try {
        localStorage.setItem(rememberedSessionTokenKey, JSON.stringify({
          token,
          expiresAt: options.expiresAt,
        } satisfies RememberedSession))
        return
      } catch {
        // Fall back to a tab-only session when persistent storage is unavailable.
      }
    }
  }
  sessionStorage.setItem(sessionTokenKey, token)
}

export function clearAuthToken() {
  try { sessionStorage.removeItem(sessionTokenKey) } catch { /* Storage is optional. */ }
  try { localStorage.removeItem(rememberedSessionTokenKey) } catch { /* Storage is optional. */ }
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
  if ((!window.desktop?.trialMode && !navigator.onLine) || (isMutation(init) && !serverReachable)) {
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
  const mutationIdentity = isMutation(init) && !headers.has('X-Request-Id')
    ? financialRequestIdentity(path, init, headers)
    : null

  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (mutationIdentity) headers.set('X-Request-Id', mutationIdentity.requestId)

  return publicApiFetch(path, { ...init, headers }).then((response) => {
    if (mutationIdentity) {
      markFinancialRequestCompleted(mutationIdentity.storageKey, mutationIdentity.requestId)
    }
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
