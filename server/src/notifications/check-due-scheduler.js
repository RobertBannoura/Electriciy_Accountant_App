import { currentBusinessDate } from '../checks/check-reminders.js'
import { query } from '../db/pool.js'
import { getPushConfiguration, notifyAdminAfterCommit } from './push-service.js'
import { safeErrorDetails } from '../security/security-log.js'

export async function sendDueCheckNotifications({
  dbQuery = query,
  today = currentBusinessDate(),
  notify = notifyAdminAfterCommit,
} = {}) {
  if (!getPushConfiguration().configured && notify === notifyAdminAfterCommit) return { sent: 0 }
  const result = await dbQuery(
    `
      SELECT checks.id::TEXT AS id
      FROM checks
      WHERE checks.status = 'pending'
        AND checks.due_date = $1::DATE
        AND (
          (checks.customer_id IS NOT NULL AND checks.direction = 'inflow')
          OR checks.is_owner_issued = TRUE
        )
      ORDER BY checks.id
    `,
    [today],
  )
  await Promise.all(result.rows.map((check) => {
    return notify({
      category: 'check_due', sourceType: 'check', sourceId: check.id,
      businessDate: today, title: 'شيك مستحق اليوم', url: '/checks',
      body: 'يوجد شيك مستحق اليوم. افتح التطبيق لعرض التفاصيل.',
    })
  }))
  return { sent: result.rowCount }
}

export function startCheckDueNotificationScheduler({
  intervalMs = 15 * 60 * 1000,
  run = sendDueCheckNotifications,
  logger = console,
} = {}) {
  const execute = () => void run().catch((error) => {
    logger.error('تعذر فحص الشيكات المستحقة للإشعارات', safeErrorDetails(error))
  })
  const initialTimer = setTimeout(execute, 2_000)
  initialTimer.unref()
  const interval = setInterval(execute, intervalMs)
  interval.unref()
  return () => {
    clearTimeout(initialTimer)
    clearInterval(interval)
  }
}
