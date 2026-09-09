import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('maintenance schema is append-only, reportable, and independent from products', async () => {
  const sql = await readFile(new URL('../db/migrations/0014_maintenance_income.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE maintenance_records/)
  assert.match(sql, /CREATE TABLE maintenance_reversals/)
  assert.match(sql, /maintenance_records_immutable/)
  assert.match(sql, /maintenance_reversals_immutable/)
  assert.match(sql, /item_description TEXT NOT NULL/)
  assert.match(sql, /remaining_due_ils/)
  assert.doesNotMatch(sql, /product_id|INSERT INTO inventory_movements|cost_of_goods/i)
})

test('maintenance service commits records, ledgers, payment effects, and audit atomically', async () => {
  const source = await readFile(new URL('../src/maintenance/maintenance-service.js', import.meta.url), 'utf8')
  assert.match(source, /client\.query\('BEGIN'\)/)
  assert.match(source, /insertIncomingPayment/)
  assert.match(source, /insertCustomerLedgerMovement/)
  assert.match(source, /INSERT INTO audit_log/)
  assert.match(source, /client\.query\('ROLLBACK'\)/)
  assert.doesNotMatch(source, /inventory_movements|sale_items|INSERT INTO sales/)
})

test('maintenance UI is reachable from sale and customer history is clearly labelled', async () => {
  const [page, sale, customers, app] = await Promise.all([
    readFile(new URL('../../client/src/pages/MaintenancePage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/SalePage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/CustomersPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/App.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(page, /صيانة جديدة/)
  assert.match(page, /ابحث باسم العميل أو الجهاز/)
  assert.match(page, /PaymentEditor/)
  assert.match(sale, /to="\/maintenance"/)
  assert.match(customers, /صيانة —/)
  assert.match(app, /path="maintenance"/)
})
