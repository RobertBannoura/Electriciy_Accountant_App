import { Router } from 'express'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import {
  notificationCategories,
  parseNotificationSettings,
  parsePushSubscription,
  requirePersistentAdmin,
} from '../notifications/notification-input.js'
import { getPushConfiguration } from '../notifications/push-service.js'

export const pushRouter = Router()

pushRouter.get('/status', async (request, response) => {
  const userId = requirePersistentAdmin(request)
  await ensurePreferences(userId)
  const [preferencesResult, subscriptionsResult] = await Promise.all([
    query(
      `SELECT sale_created, customer_payment, purchase_created,
        supplier_payment, check_due, check_bounced
       FROM push_notification_preferences WHERE user_id = $1::BIGINT`,
      [userId],
    ),
    query(
      `SELECT COUNT(*)::INTEGER AS count FROM push_subscriptions
       WHERE user_id = $1::BIGINT AND (expires_at IS NULL OR expires_at > NOW())`,
      [userId],
    ),
  ])
  const configuration = getPushConfiguration()
  response.json({
    configured: configuration.configured,
    publicKey: configuration.publicKey,
    subscriptionCount: subscriptionsResult.rows[0]?.count ?? 0,
    settings: preferencesResult.rows[0],
  })
})

pushRouter.put('/settings', async (request, response) => {
  const userId = requirePersistentAdmin(request)
  const parsed = parseNotificationSettings(request.body)
  if (parsed.error) throw new AppError(parsed.error, 400, 'INVALID_NOTIFICATION_SETTINGS')
  const values = notificationCategories.map((category) => parsed.value[category])
  const result = await query(
    `
      INSERT INTO push_notification_preferences (
        user_id, sale_created, customer_payment, purchase_created,
        supplier_payment, check_due, check_bounced
      ) VALUES ($1::BIGINT, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id) DO UPDATE SET
        sale_created = EXCLUDED.sale_created,
        customer_payment = EXCLUDED.customer_payment,
        purchase_created = EXCLUDED.purchase_created,
        supplier_payment = EXCLUDED.supplier_payment,
        check_due = EXCLUDED.check_due,
        check_bounced = EXCLUDED.check_bounced,
        updated_at = NOW()
      RETURNING sale_created, customer_payment, purchase_created,
        supplier_payment, check_due, check_bounced
    `,
    [userId, ...values],
  )
  response.json({ settings: result.rows[0] })
})

pushRouter.post('/subscriptions', async (request, response) => {
  const userId = requirePersistentAdmin(request)
  if (!getPushConfiguration().configured) {
    throw new AppError('مفاتيح VAPID غير مضبوطة على الخادم', 503, 'VAPID_NOT_CONFIGURED')
  }
  const parsed = parsePushSubscription(request.body)
  if (parsed.error) throw new AppError(parsed.error, 400, 'INVALID_PUSH_SUBSCRIPTION')
  const subscription = parsed.value
  const result = await query(
    `
      INSERT INTO push_subscriptions (
        user_id, store_id, endpoint, p256dh_key, auth_key, expires_at
      ) VALUES ($1::BIGINT, NULL, $2, $3, $4, $5::TIMESTAMPTZ)
      ON CONFLICT (endpoint) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        store_id = NULL,
        p256dh_key = EXCLUDED.p256dh_key,
        auth_key = EXCLUDED.auth_key,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
      RETURNING id::TEXT AS id
    `,
    [userId, subscription.endpoint, subscription.p256dh, subscription.auth, subscription.expiresAt],
  )
  response.status(201).json({ subscription: { id: result.rows[0].id } })
})

pushRouter.delete('/subscriptions', async (request, response) => {
  const userId = requirePersistentAdmin(request)
  const endpoint = parseEndpoint(request.body?.endpoint)
  if (!endpoint) throw new AppError('عنوان اشتراك الإشعارات غير صالح', 400, 'INVALID_PUSH_ENDPOINT')
  await query(
    'DELETE FROM push_subscriptions WHERE user_id = $1::BIGINT AND endpoint = $2',
    [userId, endpoint],
  )
  response.status(204).end()
})

async function ensurePreferences(userId) {
  await query(
    `INSERT INTO push_notification_preferences (user_id)
     VALUES ($1::BIGINT) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  )
}

function parseEndpoint(value) {
  try {
    const endpoint = new URL(value)
    return endpoint.protocol === 'https:' && endpoint.href.length <= 4096 ? endpoint.href : null
  } catch {
    return null
  }
}

