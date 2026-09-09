import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  notificationCategories,
  parseNotificationSettings,
  parsePushSubscription,
  requirePersistentAdmin,
} from '../src/notifications/notification-input.js'
import { sendDueCheckNotifications } from '../src/notifications/check-due-scheduler.js'
import { formatIlsAmount, notifyAdminAfterCommit } from '../src/notifications/push-service.js'

test('notification settings require an explicit boolean for every supported category', () => {
  const enabled = Object.fromEntries(notificationCategories.map((category) => [category, true]))
  assert.deepEqual(parseNotificationSettings(enabled), { value: enabled })
  assert.match(parseNotificationSettings({ ...enabled, check_due: 'yes' }).error, /فئة/)
  assert.match(parseNotificationSettings(null).error, /صالحة/)
})

test('push subscriptions accept HTTPS capability URLs and encrypted browser keys only', () => {
  const parsed = parsePushSubscription({
    endpoint: 'https://push.example.test/subscription/1',
    expirationTime: null,
    keys: { p256dh: 'A'.repeat(65), auth: 'B'.repeat(22) },
  })
  assert.equal(parsed.value.endpoint, 'https://push.example.test/subscription/1')
  assert.equal(parsed.value.expiresAt, null)
  assert.match(parsePushSubscription({
    endpoint: 'http://push.example.test/unsafe',
    keys: { p256dh: 'A'.repeat(65), auth: 'B'.repeat(22) },
  }).error, /غير صالح/)
})

test('only a persistent admin account can manage push subscriptions', () => {
  assert.equal(requirePersistentAdmin({ auth: { user: { id: '7', role: 'admin' } } }), '7')
  assert.throws(
    () => requirePersistentAdmin({ auth: { user: { id: '8', role: 'worker' } } }),
    (error) => error.statusCode === 403,
  )
  assert.throws(
    () => requirePersistentAdmin({ auth: { user: { id: 'temporary-admin', role: 'admin' } } }),
    (error) => error.statusCode === 409,
  )
})

test('push delivery selects active admins and absorbs provider failure after commit', async () => {
  const queries = []
  const dbQuery = async (sql, parameters = []) => {
    queries.push({ sql, parameters })
    if (sql.includes('FROM push_subscriptions AS subscriptions')) {
      return { rowCount: 1, rows: [{ id: '11', endpoint: 'https://push.example/1', p256dh_key: 'key', auth_key: 'auth' }] }
    }
    if (sql.includes('INSERT INTO push_notification_events')) return { rowCount: 1, rows: [{ id: '21' }] }
    return { rowCount: 1, rows: [] }
  }
  const warnings = []
  const result = await notifyAdminAfterCommit({
    category: 'sale_created', sourceType: 'sale', sourceId: '9',
    businessDate: '2026-09-09', title: 'بيع جديد', body: 'بيع جديد بقيمة ₪1,250',
  }, {
    configured: true,
    dbQuery,
    pushClient: { sendNotification: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }) } },
    logger: { error: () => {}, warn: (...values) => warnings.push(values) },
  })
  assert.deepEqual(result, { successes: 0, failures: 1 })
  assert.match(queries[0].sql, /users\.role = 'admin'/)
  assert.ok(queries.some(({ sql }) => sql.includes('DELETE FROM push_subscriptions')))
  assert.equal(warnings.length, 1)
})

test('notification examples use exact ILS grouping and due checks are deduplicable events', async () => {
  assert.equal(formatIlsAmount('1250.00'), '₪1,250')
  assert.equal(formatIlsAmount('500.50'), '₪500.5')
  const notifications = []
  const result = await sendDueCheckNotifications({
    today: '2026-09-09',
    dbQuery: async () => ({ rowCount: 1, rows: [{ id: '5', amount: '2000', customer_name: 'أحمد', supplier_name: null }] }),
    notify: async (notification) => { notifications.push(notification) },
  })
  assert.equal(result.sent, 1)
  assert.equal(notifications[0].body, 'شيك مستحق اليوم لأحمد بقيمة ₪2,000')
  assert.deepEqual(
    [notifications[0].category, notifications[0].sourceType, notifications[0].sourceId, notifications[0].businessDate],
    ['check_due', 'check', '5', '2026-09-09'],
  )
})

test('schema, routes, settings, and service worker implement VAPID without client private key exposure', async () => {
  const [migration, app, sales, purchases, customers, suppliers, checks, pushRoute, serviceWorker, settings, clientTree] = await Promise.all([
    readFile(new URL('../db/migrations/0022_vapid_admin_notifications.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/sales.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/purchases.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/customers.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/suppliers.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/checks.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/push.js', import.meta.url), 'utf8'),
    readFile(new URL('../../client/public/sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/components/PushNotificationSettings.tsx', import.meta.url), 'utf8'),
    Promise.all([
      readFile(new URL('../../client/src/api.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../client/src/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../client/src/pages/SettingsPage.tsx', import.meta.url), 'utf8'),
    ]).then((files) => files.join('\n')),
  ])
  assert.match(migration, /CREATE TABLE push_notification_preferences/)
  assert.match(migration, /UNIQUE \(category, source_type, source_id\)/)
  assert.match(app, /app\.use\('\/api\/push', pushRouter\)/)
  for (const [route, createMarker, notifyMarker] of [
    [sales, 'await createSale', 'await notifySaleCreated'],
    [purchases, 'await createPurchase', 'await notifyPurchaseCreated'],
    [customers, 'await createCustomerPayment', 'await notifyCustomerPaymentCreated'],
    [suppliers, 'await createSupplierPayment', 'await notifySupplierPaymentCreated'],
    [checks, 'await bounceCheck', 'await notifyCheckBounced'],
  ]) {
    assert.ok(route.indexOf(createMarker) < route.indexOf(notifyMarker))
  }
  assert.match(pushRoute, /publicKey: configuration\.publicKey/)
  assert.doesNotMatch(pushRoute, /vapidPrivateKey/)
  assert.match(serviceWorker, /addEventListener\('push'/)
  assert.match(serviceWorker, /showNotification/)
  assert.match(serviceWorker, /addEventListener\('notificationclick'/)
  for (const label of ['المبيعات الجديدة', 'دفعات العملاء', 'المشتريات الجديدة', 'دفعات الموردين', 'الشيكات المستحقة اليوم', 'الشيكات المرتجعة']) {
    assert.match(settings, new RegExp(label))
  }
  assert.doesNotMatch(clientTree, /VAPID_PRIVATE_KEY|vapidPrivateKey/)
})
