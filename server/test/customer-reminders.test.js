import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePaymentPromise } from '../src/customers/customer-reminders.js'
import { sendCustomerReminderNotifications } from '../src/notifications/customer-reminder-scheduler.js'

test('payment promise validates real calendar dates and short optional notes', () => {
  assert.deepEqual(parsePaymentPromise({ date: '2028-02-29', note: '  بعد الظهر  ' }), {
    value: { date: '2028-02-29', note: 'بعد الظهر' },
  })
  for (const date of ['', '2027-02-29', '2026-09-31', 'bad', null, {}, ['2026-09-27']]) {
    assert.ok(parsePaymentPromise({ date }).error, `Reject invalid date: ${date}`)
  }
  assert.ok(parsePaymentPromise({ date: '2026-09-27', note: 'x'.repeat(501) }).error)
  assert.ok(parsePaymentPromise({ date: '2026-09-27', note: {} }).error)
  assert.equal(parsePaymentPromise({ date: '2026-09-27' }).value.note, null)
})

test('customer notification scheduler excludes deferred promises and repeats on a new business day', async () => {
  const events = []
  const options = {
    dbQuery: async () => ({ rows: [
      { id: '1', needs_notification: true },
      { id: '2', needs_notification: false },
      { id: '3', needs_notification: true },
    ] }),
    notify: async (event) => events.push(event),
  }
  assert.deepEqual(await sendCustomerReminderNotifications({ ...options, today: '2026-09-27' }), { sent: 2 })
  await sendCustomerReminderNotifications({ ...options, today: '2026-09-28' })
  assert.deepEqual(events.map((event) => event.sourceId), ['1', '3', '1', '3'])
  assert.notEqual(events[0].sourceType, events[2].sourceType)
  assert.equal(events[0].category, 'customer_reminder')
  assert.equal(events[0].url, '/')
})
