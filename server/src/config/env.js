import dotenv from 'dotenv'

dotenv.config({ quiet: true })

const allowedEnvironments = new Set(['development', 'test', 'production'])
const nodeEnv = process.env.NODE_ENV ?? 'development'

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
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY?.trim() || null
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY?.trim() || null
const vapidSubject = process.env.VAPID_SUBJECT?.trim() || null
const configuredVapidValues = [vapidPublicKey, vapidPrivateKey, vapidSubject].filter(Boolean).length
const databaseUrl = process.env.DATABASE_URL?.trim()
const clientOrigin = readHttpOrigin('CLIENT_ORIGIN', 'http://localhost:5173')
const electronOrigin = (process.env.ELECTRON_ORIGIN ?? 'app://renderer').trim()

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('يجب أن يكون PORT رقماً صحيحاً بين 1 و65535')
}

if (configuredVapidValues !== 0 && configuredVapidValues !== 3) {
  throw new Error('يجب ضبط VAPID_PUBLIC_KEY وVAPID_PRIVATE_KEY وVAPID_SUBJECT معاً')
}

if (nodeEnv === 'production' && !databaseUrl) {
  throw new Error('يجب ضبط DATABASE_URL على الخادم في بيئة الإنتاج')
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
  databaseUrl: databaseUrl ?? 'postgresql://postgres@localhost:5432/electricity_accountant',
  clientOrigin,
  electronOrigin,
  timezone: process.env.TIMEZONE ?? 'Asia/Hebron',
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD,
  adminDisplayName: process.env.ADMIN_DISPLAY_NAME ?? 'المدير',
  vapidPublicKey,
  vapidPrivateKey,
  vapidSubject,
})
