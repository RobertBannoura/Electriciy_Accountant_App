import dotenv from 'dotenv'

dotenv.config({ quiet: true })

const allowedEnvironments = new Set(['development', 'test', 'production'])
const nodeEnv = process.env.NODE_ENV ?? 'development'

if (!allowedEnvironments.has(nodeEnv)) {
  throw new Error(`قيمة NODE_ENV غير مدعومة: ${nodeEnv}`)
}

const port = Number.parseInt(process.env.PORT ?? '3000', 10)
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY?.trim() || null
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY?.trim() || null
const vapidSubject = process.env.VAPID_SUBJECT?.trim() || null
const configuredVapidValues = [vapidPublicKey, vapidPrivateKey, vapidSubject].filter(Boolean).length

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('يجب أن يكون PORT رقماً صحيحاً بين 1 و65535')
}

if (configuredVapidValues !== 0 && configuredVapidValues !== 3) {
  throw new Error('يجب ضبط VAPID_PUBLIC_KEY وVAPID_PRIVATE_KEY وVAPID_SUBJECT معاً')
}

if (vapidSubject && !/^(mailto:|https?:\/\/)/.test(vapidSubject)) {
  throw new Error('يجب أن يكون VAPID_SUBJECT رابطاً أو عنوان mailto صالحاً')
}

export const env = Object.freeze({
  nodeEnv,
  port,
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/electricity_accountant',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  electronOrigin: process.env.ELECTRON_ORIGIN ?? 'app://renderer',
  timezone: process.env.TIMEZONE ?? 'Asia/Hebron',
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD,
  adminDisplayName: process.env.ADMIN_DISPLAY_NAME ?? 'المدير',
  vapidPublicKey,
  vapidPrivateKey,
  vapidSubject,
})
