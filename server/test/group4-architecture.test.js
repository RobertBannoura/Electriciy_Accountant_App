import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  '../db/migrations/0010_shared_parties_ils_ledgers.sql',
  import.meta.url,
)

test('Group 4 migration makes party identity global without merging records', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /ALTER TABLE customers DROP COLUMN store_id/)
  assert.match(sql, /ALTER TABLE customer_projects DROP COLUMN store_id/)
  assert.match(sql, /ALTER TABLE suppliers DROP COLUMN store_id/)
  assert.match(sql, /Existing rows keep their IDs and are never merged/)
  assert.doesNotMatch(sql, /DELETE FROM customers|DELETE FROM suppliers/)
  assert.doesNotMatch(sql, /GROUP BY (?:name|phone)/i)
  assert.match(sql, /FOREIGN KEY \(customer_id\) REFERENCES customers \(id\)/)
  assert.match(sql, /FOREIGN KEY \(supplier_id\) REFERENCES suppliers \(id\)/)
  assert.match(sql, /FOREIGN KEY \(customer_project_id, customer_id\)/)
})

test('party ledgers store only ILS accounting values and retain store identity', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /RENAME COLUMN amount TO amount_ils/)
  assert.match(sql, /DROP COLUMN currency_code/)
  assert.match(sql, /customer_store_balances/)
  assert.match(sql, /supplier_store_balances/)
  assert.match(sql, /ledger\.store_id/)
  assert.match(sql, /payments\.converted_ils_amount/)
  assert.match(sql, /Cannot migrate customer_ledger rows/)
  assert.match(sql, /Cannot migrate supplier_ledger rows/)
  assert.match(sql, /CREATE TRIGGER customer_ledger_append_only/)
  assert.match(sql, /CREATE TRIGGER supplier_ledger_append_only/)
})

test('payment snapshots and physical cash currency columns remain untouched', async () => {
  const paymentMigration = await readFile(
    new URL('../db/migrations/0002_payment_money_snapshot.sql', import.meta.url),
    'utf8',
  )
  const foundation = await readFile(
    new URL('../db/migrations/0001_foundational_schema.sql', import.meta.url),
    'utf8',
  )
  const sharedParties = await readFile(migrationUrl, 'utf8')

  assert.match(paymentMigration, /original_amount/)
  assert.match(paymentMigration, /exchange_rate/)
  assert.match(paymentMigration, /converted_ils_amount/)
  assert.match(foundation, /CREATE TABLE financial_movements[\s\S]*currency_code TEXT/)
  assert.doesNotMatch(
    sharedParties,
    /ALTER TABLE financial_movements|DROP COLUMN original_amount|DROP COLUMN exchange_rate|DROP COLUMN converted_ils_amount/,
  )
})
