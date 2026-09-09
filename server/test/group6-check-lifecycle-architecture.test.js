import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('check lifecycle schema and UI preserve history, idempotency, owner checks, and reminders', async () => {
  const [migration, lifecycle, owner, reminders, route, home, page, main, preload] = await Promise.all([
    readFile(new URL('../db/migrations/0018_check_lifecycle_and_reminders.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/checks/check-lifecycle.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/checks/owner-check.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/checks/check-reminders.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/checks.js', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/HomePage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/ChecksPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/preload.cjs', import.meta.url), 'utf8'),
  ])

  assert.match(migration, /customer_ledger_one_check_bounce/)
  assert.match(migration, /supplier_ledger_one_transferred_check_bounce/)
  assert.match(migration, /supplier_ledger_one_owner_check_bounce/)
  assert.match(migration, /bounced_reminder_stopped_at/)
  assert.match(lifecycle, /ON CONFLICT[\s\S]*DO NOTHING/)
  assert.doesNotMatch(lifecycle, /DELETE FROM payments|DELETE FROM customer_ledger|DELETE FROM supplier_ledger/)
  assert.match(owner, /'outflow', 'pending'/)
  assert.match(owner, /'debit'[\s\S]*'owner_check'/)
  assert.match(route, /\/:checkId\/clear/)
  assert.match(route, /\/:checkId\/bounce/)
  assert.match(route, /\/:checkId\/later/)
  assert.match(route, /\/:checkId\/stop-bounced-reminder/)
  assert.match(route, /checks\.bounced_reminder_stopped_at/)
  assert.match(route, /getCheckReminders\(\{ storeId: request\.storeId \}\)/)
  assert.match(reminders, /export async function getCheckReminders/)
  assert.match(reminders, /due_today:/)
  assert.match(reminders, /follow_up:/)
  assert.match(reminders, /bounced:/)
  assert.match(home, /\/checks\/reminders/)
  assert.match(home, /شيكات تحتاج متابعة/)
  assert.match(home, /لاحقاً/)
  assert.match(home, /showDesktopNotificationOnce/)
  assert.match(page, /شيك صادر من صاحب العمل إلى مورد/)
  assert.match(page, /تم تحصيله/)
  assert.match(page, /check\.bounced_reminder_stopped_at/)
  assert.match(page, /await Promise\.all\(\[loadChecks\(\), loadSuppliers\(\)\]\)/)
  assert.doesNotMatch(page, /:\s*\(stores\[0\]\?\.id \?\? ''\)/)
  assert.match(main, /new Notification/)
  assert.doesNotMatch(main, /FROM checks|customer_ledger|supplier_ledger/)
  assert.match(preload, /showNotification/)
})
