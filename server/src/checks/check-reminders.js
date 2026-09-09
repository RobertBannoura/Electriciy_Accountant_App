import { query } from '../db/pool.js'

export function currentBusinessDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Hebron',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export function elapsedBusinessDays(dueDate, today) {
  const cursor = new Date(`${dueDate}T00:00:00Z`)
  const end = new Date(`${today}T00:00:00Z`)
  let days = 0
  cursor.setUTCDate(cursor.getUTCDate() + 1)
  while (cursor <= end) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 5 && weekday !== 6) days += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

export async function getCheckReminders({
  dbQuery = query,
  storeId,
  today = currentBusinessDate(),
}) {
  const [settingResult, checksResult] = await Promise.all([
    dbQuery(
      `
        SELECT value
        FROM system_settings
        WHERE store_id = $1::BIGINT AND key = 'check_follow_up_business_days'
      `,
      [storeId],
    ),
    dbQuery(
      `
        SELECT
          checks.id::TEXT AS id,
          checks.check_number,
          checks.amount::TEXT AS amount,
          checks.due_date::TEXT AS due_date,
          checks.status,
          checks.customer_id::TEXT AS customer_id,
          customers.name AS customer_name,
          checks.supplier_id::TEXT AS supplier_id,
          suppliers.name AS supplier_name,
          checks.is_owner_issued,
          checks.reminder_snoozed_until::TEXT AS reminder_snoozed_until
        FROM checks
        LEFT JOIN customers ON customers.id = checks.customer_id
        LEFT JOIN suppliers ON suppliers.id = checks.supplier_id
        WHERE checks.store_id = $1::BIGINT
          AND (
            (checks.status = 'pending' AND checks.due_date <= $2::DATE)
            OR (
              checks.status = 'bounced'
              AND checks.bounced_reminder_stopped_at IS NULL
            )
          )
          AND (
            (checks.customer_id IS NOT NULL AND checks.direction = 'inflow')
            OR checks.is_owner_issued = TRUE
          )
        ORDER BY checks.due_date, checks.id
      `,
      [storeId, today],
    ),
  ])

  const configured = Number(settingResult.rows[0]?.value ?? 3)
  const businessDays = Number.isInteger(configured) && configured >= 1 && configured <= 30
    ? configured
    : 3
  const visible = checksResult.rows.filter(
    (check) => !check.reminder_snoozed_until || check.reminder_snoozed_until <= today,
  )

  return {
    business_days: businessDays,
    due_today: visible.filter((check) => check.status === 'pending' && check.due_date === today),
    follow_up: visible.filter(
      (check) => check.status === 'pending'
        && check.due_date < today
        && elapsedBusinessDays(check.due_date, today) >= businessDays,
    ),
    bounced: visible.filter((check) => check.status === 'bounced'),
  }
}
