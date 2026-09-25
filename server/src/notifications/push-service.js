import webpush from 'web-push'
import { env } from '../config/env.js'
import { query } from '../db/pool.js'
import { notificationCategories } from './notification-input.js'
import { safeErrorDetails } from '../security/security-log.js'
import { formatMoneyDisplay } from '../money/money.js'

const categoryColumns = new Set(notificationCategories)
const vapidConfigured = Boolean(env.vapidPublicKey && env.vapidPrivateKey && env.vapidSubject)

if (vapidConfigured) {
  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey)
}

export function getPushConfiguration() {
  return {
    configured: vapidConfigured,
    publicKey: vapidConfigured ? env.vapidPublicKey : null,
  }
}

export async function notifyAdminAfterCommit(notification, {
  dbQuery = query,
  pushClient = webpush,
  configured = vapidConfigured,
  logger = console,
} = {}) {
  try {
    if (!configured) return { skipped: 'not_configured', successes: 0, failures: 0 }
    if (!categoryColumns.has(notification.category)) throw new Error('Unsupported notification category')

    const recipients = await dbQuery(
      `
        SELECT subscriptions.id::TEXT AS id, subscriptions.endpoint,
          subscriptions.p256dh_key, subscriptions.auth_key
        FROM push_subscriptions AS subscriptions
        INNER JOIN users ON users.id = subscriptions.user_id
        LEFT JOIN push_notification_preferences AS preferences
          ON preferences.user_id = users.id
        WHERE users.role = 'admin'
          AND users.is_active = TRUE
          AND (subscriptions.expires_at IS NULL OR subscriptions.expires_at > NOW())
          AND COALESCE(preferences.${notification.category}, TRUE) = TRUE
      `,
    )
    if (recipients.rowCount === 0) return { skipped: 'no_recipients', successes: 0, failures: 0 }

    const eventResult = await dbQuery(
      `
        INSERT INTO push_notification_events (
          category, source_type, source_id, business_date, title, body
        ) VALUES ($1, $2, $3::BIGINT, $4::DATE, $5, $6)
        ON CONFLICT (category, source_type, source_id) DO NOTHING
        RETURNING id::TEXT AS id
      `,
      [
        notification.category,
        notification.sourceType,
        notification.sourceId,
        notification.businessDate,
        notification.title,
        notification.body,
      ],
    )
    if (eventResult.rowCount === 0) return { skipped: 'duplicate', successes: 0, failures: 0 }

    let successes = 0
    let failures = 0
    const payload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      url: notification.url ?? '/',
      tag: `${notification.category}-${notification.sourceId}`,
    })

    await Promise.all(recipients.rows.map(async (subscription) => {
      try {
        await pushClient.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh_key, auth: subscription.auth_key },
        }, payload, { TTL: 3600, urgency: 'high', timeout: 10_000 })
        successes += 1
        await dbQuery(
          'UPDATE push_subscriptions SET last_success_at = NOW() WHERE id = $1::BIGINT',
          [subscription.id],
        ).catch(() => {})
      } catch (error) {
        failures += 1
        const statusCode = Number(error?.statusCode)
        if (statusCode === 404 || statusCode === 410) {
          await dbQuery(
            'DELETE FROM push_subscriptions WHERE id = $1::BIGINT',
            [subscription.id],
          ).catch(() => {})
        } else {
          await dbQuery(
            'UPDATE push_subscriptions SET last_failure_at = NOW() WHERE id = $1::BIGINT',
            [subscription.id],
          ).catch(() => {})
        }
        logger.warn('تعذر إرسال إشعار Web Push', { statusCode, category: notification.category })
      }
    }))

    await dbQuery(
      `UPDATE push_notification_events
       SET success_count = $1, failure_count = $2, completed_at = NOW()
       WHERE id = $3::BIGINT`,
      [successes, failures, eventResult.rows[0].id],
    )
    return { successes, failures }
  } catch (error) {
    logger.error(
      'فشل مسار إشعار ما بعد الالتزام دون التأثير على العملية المالية',
      safeErrorDetails(error),
    )
    return { skipped: 'failed', successes: 0, failures: 1 }
  }
}

export function formatIlsAmount(value) {
  const formatted = formatMoneyDisplay(value ?? '0')
  if (formatted.startsWith('<') || formatted.startsWith('>')) return `₪${formatted}`
  const [integer, fraction = ''] = formatted.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const visibleFraction = fraction.replace(/0+$/, '')
  return `₪${grouped}${visibleFraction ? `.${visibleFraction}` : ''}`
}
