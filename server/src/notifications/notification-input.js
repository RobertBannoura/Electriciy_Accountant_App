import { createECDH } from 'node:crypto'
import { AppError } from '../errors/app-error.js'

export const notificationCategories = Object.freeze([
  'sale_created',
  'customer_payment',
  'purchase_created',
  'supplier_payment',
  'check_due',
  'check_bounced',
])

export function parseNotificationSettings(input) {
  if (!input || typeof input !== 'object') {
    return { error: 'إعدادات الإشعارات غير صالحة' }
  }
  const settings = {}
  for (const category of notificationCategories) {
    if (typeof input[category] !== 'boolean') {
      return { error: 'يجب تحديد حالة كل فئة من فئات الإشعارات' }
    }
    settings[category] = input[category]
  }
  return { value: settings }
}

export function parsePushSubscription(input) {
  try {
    const endpoint = new URL(input?.endpoint)
    const p256dh = input?.keys?.p256dh
    const auth = input?.keys?.auth
    if (!isHttpsPushEndpoint(endpoint)) throw new Error()
    if (!isValidP256dh(p256dh) || !isExactBase64UrlBytes(auth, 16)) throw new Error()
    const expirationTime = input.expirationTime == null ? null : new Date(input.expirationTime)
    if (expirationTime && Number.isNaN(expirationTime.getTime())) throw new Error()
    return {
      value: {
        endpoint: endpoint.href,
        p256dh,
        auth,
        expiresAt: expirationTime?.toISOString() ?? null,
      },
    }
  } catch {
    return { error: 'اشتراك الإشعارات غير صالح' }
  }
}

export function requirePersistentAdmin(request) {
  if (request.auth?.user?.role !== 'admin') {
    throw new AppError('هذه الإعدادات متاحة للمدير فقط', 403, 'ADMIN_ONLY')
  }
  if (!/^\d+$/.test(request.auth.user.id)) {
    throw new AppError(
      'يجب تسجيل الدخول بحساب المدير الدائم لتفعيل الإشعارات',
      409,
      'PERSISTENT_ADMIN_REQUIRED',
    )
  }
  return request.auth.user.id
}

function isHttpsPushEndpoint(endpoint) {
  return endpoint.protocol === 'https:'
    && endpoint.href.length <= 4096
    && endpoint.username === ''
    && endpoint.password === ''
    && endpoint.hash === ''
}

function decodeCanonicalBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null
  const unpadded = value.replace(/=+$/, '')
  if (unpadded.length % 4 === 1) return null
  const decoded = Buffer.from(unpadded, 'base64url')
  return decoded.toString('base64url') === unpadded ? decoded : null
}

function isExactBase64UrlBytes(value, length) {
  return decodeCanonicalBase64Url(value)?.length === length
}

function isValidP256dh(value) {
  const key = decodeCanonicalBase64Url(value)
  if (!key || key.length !== 65 || key[0] !== 4) return false
  try {
    const verifier = createECDH('prime256v1')
    verifier.generateKeys()
    verifier.computeSecret(key)
    return true
  } catch {
    return false
  }
}
