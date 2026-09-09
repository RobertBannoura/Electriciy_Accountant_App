import { currentBusinessDate } from '../checks/check-reminders.js'
import { query } from '../db/pool.js'
import { formatIlsAmount, getPushConfiguration, notifyAdminAfterCommit } from './push-service.js'

export async function sendDueCheckNotifications({
  dbQuery = query,
  today = currentBusinessDate(),
  notify = notifyAdminAfterCommit,
} = {}) {
  if (!getPushConfiguration().configured && notify === notifyAdminAfterCommit) return { sent: 0 }
  const result = await dbQuery(
    `
      SELECT checks.id::TEXT AS id, checks.amount::TEXT AS amount,
        customers.name AS customer_name, suppliers.name AS supplier_name
      FROM checks
      LEFT JOIN customers ON customers.id = checks.customer_id
      LEFT JOIN suppliers ON suppliers.id = checks.supplier_id
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
    const partyName = check.customer_name ?? check.supplier_name ?? 'غير محدد'
    return notify({
      category: 'check_due', sourceType: 'check', sourceId: check.id,
      businessDate: today, title: 'شيك مستحق اليوم', url: '/checks',
      body: `شيك مستحق اليوم ل${partyName} بقيمة ${formatIlsAmount(check.amount)}`,
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
    logger.error('تعذر فحص الشيكات المستحقة للإشعارات', error)
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
