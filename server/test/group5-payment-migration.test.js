import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('../db/migrations/0012_sale_payment_breakdown.sql', import.meta.url)

test('sale payment migration stores paid and debt totals without a fake debt method', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /paid_total NUMERIC\(38, 12\)/)
  assert.match(sql, /remaining_due NUMERIC\(38, 12\)/)
  assert.match(sql, /total = paid_total \+ remaining_due/)
  assert.doesNotMatch(sql, /payment_method IN \([^)]*debt/)
})

test('physical cash, bank, checks, and invoice payment facts stay traceable and separated', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE bank_movements/)
  assert.match(sql, /bank_movements_append_only/)
  assert.match(sql, /currency_code IN \('ILS', 'USD', 'JOD'\)/)
  assert.match(sql, /ADD COLUMN sale_id BIGINT/)
  assert.match(sql, /payments_immutable/)
  assert.match(sql, /checks_sale_snapshot_protected/)
})

test('sale service writes every effect before the same transaction commits', async () => {
  const [source, writer] = await Promise.all([
    readFile(new URL('../src/sales/create-sale.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/payments/payment-writer.js', import.meta.url), 'utf8'),
  ])
  const commitPosition = source.indexOf("client.query('COMMIT')")

  for (const statement of [
    'INSERT INTO sales',
    'INSERT INTO sale_items',
    'INSERT INTO inventory_movements',
    'INSERT INTO payments',
    'INSERT INTO checks',
    'INSERT INTO financial_movements',
    'INSERT INTO bank_movements',
    'INSERT INTO customer_ledger',
  ]) {
    assert.ok(`${source}\n${writer}`.indexOf(statement) > -1, `${statement} is missing`)
  }
  for (const operation of [
    'insertCustomerLedgerMovement(client',
    'insertIncomingPayment(client',
  ]) {
    assert.ok(source.indexOf(operation) < commitPosition, `${operation} occurs after COMMIT`)
  }
})
