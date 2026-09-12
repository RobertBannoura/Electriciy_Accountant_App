import dotenv from 'dotenv'
import { isIP } from 'node:net'

dotenv.config({ quiet: true })

const allowedEnvironments = new Set(['development', 'test', 'production'])
const nodeEnv = process.env.NODE_ENV ?? 'development'
const trustedProxyNames = new Set(['loopback', 'linklocal', 'uniquelocal'])
const proxyClientIpHeaders = new Set(['x-forwarded-for', 'x-real-ip'])
const connectionStringTlsKeys = new Set([
  'ssl',
  'sslcert',
  'sslkey',
  'sslmode',
  'sslrootcert',
])

export function parseTrustedProxyRanges(rawValue) {
  const value = rawValue?.trim()
  if (!value) return []

  const ranges = value.split(',').map((entry) => entry.trim())
  if (ranges.length > 32 || ranges.some((entry) => !entry)) {
    throw new Error('TRUST_PROXY must contain 1-32 comma-separated proxy IPs or CIDRs.')
  }

  for (const range of ranges) {
    if (trustedProxyNames.has(range)) continue
    if (['true', 'false'].includes(range.toLowerCase()) || /^\d+$/.test(range)) {
      throw new Error('TRUST_PROXY must use explicit proxy IPs or CIDRs, not a boolean or hop count.')
    }

    const [address, prefix, extra] = range.split('/')
    const family = isIP(address)
    const maximumPrefix = family === 4 ? 32 : 128
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > maximumPrefix))
    ) {
      throw new Error(`TRUST_PROXY contains an invalid proxy IP or CIDR: ${range}`)
    }
  }

  return ranges
}

function readDatabaseTls(databaseUrl) {
  if (nodeEnv !== 'production') return false

  let parsed
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.')
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL TCP connection URL.')
  }

  for (const key of parsed.searchParams.keys()) {
    if (connectionStringTlsKeys.has(key.toLowerCase())) {
      throw new Error(
        'Production DATABASE_URL must not contain SSL parameters; TLS is configured separately and cannot be overridden.',
      )
    }
  }

  const configuredCa = process.env.DATABASE_TLS_CA?.replace(/\\n/g, '\n').trim()
  if (
    configuredCa &&
    (
      configuredCa.length > 262_144 ||
      !configuredCa.startsWith('-----BEGIN CERTIFICATE-----') ||
      !configuredCa.endsWith('-----END CERTIFICATE-----')
    )
  ) {
    throw new Error('DATABASE_TLS_CA must contain a bounded PEM certificate chain.')
  }

  return Object.freeze({
    rejectUnauthorized: true,
    ...(configuredCa ? { ca: configuredCa } : {}),
  })
}

function readHttpOrigin(name, fallback) {
  const value = (process.env[name] ?? fallback).trim()
  let parsed

  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin without a path.`)
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== value ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${name} must be an absolute HTTP(S) origin without a path.`)
  }

  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)

  if (nodeEnv === 'production' && parsed.protocol !== 'https:' && !isLoopback) {
    throw new Error(`${name} must use HTTPS in production unless it is a loopback origin.`)
  }

  return value
}

if (!allowedEnvironments.has(nodeEnv)) {
  throw new Error(`قيمة NODE_ENV غير مدعومة: ${nodeEnv}`)
}

const port = Number.parseInt(process.env.PORT ?? '3000', 10)
const host = (process.env.HOST ?? (nodeEnv === 'production' ? '' : '127.0.0.1')).trim()
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY?.trim() || null
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY?.trim() || null
const vapidSubject = process.env.VAPID_SUBJECT?.trim() || null
const configuredVapidValues = [vapidPublicKey, vapidPrivateKey, vapidSubject].filter(Boolean).length
const databaseUrl = process.env.DATABASE_URL?.trim()
const clientOrigin = readHttpOrigin('CLIENT_ORIGIN', 'http://localhost:5173')
const electronOrigin = (process.env.ELECTRON_ORIGIN ?? 'app://renderer').trim()
const trustedProxyRanges = parseTrustedProxyRanges(process.env.TRUST_PROXY)
const proxyClientIpHeader = (
  process.env.PROXY_CLIENT_IP_HEADER ?? 'x-forwarded-for'
).trim().toLowerCase()
const shortDevelopmentAdminPasswordValue = (
  process.env.DEVELOPMENT_SHORT_ADMIN_PASSWORD_ENABLED ?? 'false'
).trim().toLowerCase()

if (!['true', 'false'].includes(shortDevelopmentAdminPasswordValue)) {
  throw new Error('DEVELOPMENT_SHORT_ADMIN_PASSWORD_ENABLED must be true or false.')
}

const shortDevelopmentAdminPasswordEnabled = shortDevelopmentAdminPasswordValue === 'true'

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('يجب أن يكون PORT رقماً صحيحاً بين 1 و65535')
}

if (!host || (!isIP(host) && host !== 'localhost')) {
  throw new Error('HOST must be an explicit IP address (or localhost outside production).')
}

if (nodeEnv === 'production' && host === 'localhost') {
  throw new Error('Production HOST must be an explicit IP address.')
}

if (
  shortDevelopmentAdminPasswordEnabled
  && (
    nodeEnv !== 'development'
    || !['127.0.0.1', '::1', 'localhost'].includes(host)
  )
) {
  throw new Error(
    'DEVELOPMENT_SHORT_ADMIN_PASSWORD_ENABLED is restricted to loopback development servers.',
  )
}

if (configuredVapidValues !== 0 && configuredVapidValues !== 3) {
  throw new Error('يجب ضبط VAPID_PUBLIC_KEY وVAPID_PRIVATE_KEY وVAPID_SUBJECT معاً')
}

if (nodeEnv === 'production' && !databaseUrl) {
  throw new Error('يجب ضبط DATABASE_URL على الخادم في بيئة الإنتاج')
}

if (nodeEnv === 'production' && trustedProxyRanges.length === 0) {
  throw new Error('TRUST_PROXY must identify the production reverse proxy by IP or CIDR.')
}

if (!proxyClientIpHeaders.has(proxyClientIpHeader)) {
  throw new Error('PROXY_CLIENT_IP_HEADER must be x-forwarded-for or x-real-ip.')
}

if (electronOrigin !== 'app://renderer') {
  throw new Error('ELECTRON_ORIGIN must be exactly app://renderer.')
}

if (vapidSubject && !/^(mailto:|https?:\/\/)/.test(vapidSubject)) {
  throw new Error('يجب أن يكون VAPID_SUBJECT رابطاً أو عنوان mailto صالحاً')
}

export const env = Object.freeze({
  nodeEnv,
  port,
  host,
  databaseUrl: databaseUrl ?? 'postgresql://postgres@localhost:5432/electricity_accountant',
  databaseTls: readDatabaseTls(databaseUrl),
  clientOrigin,
  electronOrigin,
  trustedProxyRanges,
  proxyClientIpHeader,
  timezone: process.env.TIMEZONE ?? 'Asia/Hebron',
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD,
  adminDisplayName: process.env.ADMIN_DISPLAY_NAME ?? 'المدير',
  shortDevelopmentAdminPasswordEnabled,
  vapidPublicKey,
  vapidPrivateKey,
  vapidSubject,
})
