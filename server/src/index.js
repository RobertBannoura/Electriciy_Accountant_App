import { app } from './app.js'
import { env } from './config/env.js'
import { pool } from './db/pool.js'
import { startCheckDueNotificationScheduler } from './notifications/check-due-scheduler.js'

process.env.TZ = env.timezone

const server = app.listen(env.port, '127.0.0.1', () => {
  console.log(`الخادم يعمل على http://127.0.0.1:${env.port}`)
  console.log(`المنطقة الزمنية: ${env.timezone}`)
})
const stopPushScheduler = startCheckDueNotificationScheduler()

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
