import { app } from './app.js'
import { env } from './config/env.js'
import { pool } from './db/pool.js'
import { startCheckDueNotificationScheduler } from './notifications/check-due-scheduler.js'

if (!process.env.NODE_ENV) {
  throw new Error('NODE_ENV must be set explicitly before starting the server.')
}

process.env.TZ = env.timezone

const server = app.listen(env.port, env.host, () => {
  console.log(`الخادم يعمل على http://${env.host}:${env.port}`)
  console.log(`المنطقة الزمنية: ${env.timezone}`)
})
const stopPushScheduler = env.offlineTrial
  ? () => {}
  : startCheckDueNotificationScheduler()

async function shutdown(signal) {
  console.log(`تم استلام ${signal}، جارٍ إيقاف الخادم بأمان...`)

  stopPushScheduler()
  server.close(async () => {
    await pool.end()
    process.exit(0)
  })

  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
