import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('customer payment API is store-scoped and atomic', async () => {
  const [route, service, writer] = await Promise.all([
    readFile(new URL('../src/routes/customers.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/customers/create-customer-payment.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/payments/payment-writer.js', import.meta.url), 'utf8'),
  ])

  assert.match(route, /post\('\/:customerId\/payments'/)
  assert.match(route, /storeId: request\.storeId/)
  assert.match(service, /client\.query\('BEGIN'\)/)
  assert.match(service, /FOR UPDATE/)
  assert.match(service, /customer_balances/)
  assert.match(service, /insertIncomingPayment/)
  assert.match(service, /insertCustomerLedgerMovement/)
  assert.match(service, /client\.query\('COMMIT'\)/)
  assert.match(service, /client\.query\('ROLLBACK'\)/)
  assert.match(writer, /INSERT INTO financial_movements/)
  assert.match(writer, /INSERT INTO bank_movements/)
  assert.match(writer, /INSERT INTO checks/)
})

test('customer check facts are immutable while lifecycle status remains explicit', async () => {
  const sql = await readFile(
    new URL('../db/migrations/0013_customer_payments.sql', import.meta.url),
    'utf8',
  )

  assert.match(sql, /checks_payment_snapshot_protected/)
  assert.match(sql, /BEFORE UPDATE OR DELETE ON checks/)
  assert.match(sql, /Check status is deliberately the only business field that may change/)
  assert.match(sql, /customer_cash_movement_values_consistent/)
})

test('customer payment screen keeps mixed payment editing inline and uses the configured store', async () => {
  const [page, app] = await Promise.all([
    readFile(new URL('../../client/src/pages/CustomerPaymentPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/App.tsx', import.meta.url), 'utf8'),
  ])

  for (const label of [
    'تسجيل دفعة',
    'الدين الحالي',
    '+ نقدي',
    '+ بطاقة / بنك',
    '+ شيك',
    '₪',
    'دولار',
    'دينار',
    'سعر الصرف اليدوي',
    'المتبقي بعد الدفعة',
  ]) {
    assert.ok(page.includes(label), `Missing customer payment label: ${label}`)
  }

  assert.match(page, /storeScopedApiFetch/)
  assert.match(page, /Decimal\.clone/)
  assert.match(page, /customer\.balance_ils/)
  assert.doesNotMatch(page, /<dialog|role="dialog"/)
  assert.match(app, /path="customers\/:customerId\/payment"/)
  assert.match(app, /<CustomerPaymentPage/)
})
