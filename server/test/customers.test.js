import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  parseCustomerInput,
  parseCustomerProjectInput,
} from '../src/customers/customer-input.js'

test('customer input requires only a valid name and normalizes optional fields', () => {
  assert.deepEqual(
    parseCustomerInput({
      name: '  أحمد سالم  ',
      phone: ' 0599000000 ',
      address: '  رام الله ',
      notes: '   ',
      balance: '999999',
    }),
    {
      value: {
        name: 'أحمد سالم',
        phone: '0599000000',
        address: 'رام الله',
        notes: null,
      },
    },
  )

  assert.match(parseCustomerInput({ name: '' }).error, /اسم العميل/)
  assert.match(parseCustomerInput({ name: 'عميل', phone: '1'.repeat(51) }).error, /الهاتف/)
})

test('customer projects require a name because they always belong to a customer', () => {
  assert.match(parseCustomerProjectInput({ name: '' }).error, /اسم المشروع/)
  assert.deepEqual(parseCustomerProjectInput({ name: ' مشروع البيت ', address: 'ignored' }), {
    value: { name: 'مشروع البيت', notes: null },
  })
})

test('sales may select a real customer project or keep project_id null', async () => {
  const foundation = await readFile(
    new URL('../db/migrations/0001_foundational_schema.sql', import.meta.url),
    'utf8',
  )
  const salesTable = foundation.match(/CREATE TABLE sales \(([\s\S]*?)\n\);/)?.[1]
  const projectsTable = foundation.match(/CREATE TABLE customer_projects \(([\s\S]*?)\n\);/)?.[1]
  const sharedParties = await readFile(
    new URL('../db/migrations/0010_shared_parties_ils_ledgers.sql', import.meta.url),
    'utf8',
  )

  assert.match(salesTable, /customer_project_id BIGINT,/) // deliberately nullable
  assert.match(salesTable, /sales_project_requires_customer/)
  assert.match(sharedParties, /sales_project_customer_fk/)
  assert.match(sharedParties, /REFERENCES customer_projects \(id, customer_id\)/)
  assert.match(projectsTable, /name TEXT NOT NULL/)
  assert.doesNotMatch(foundation, /بدون مشروع/)
})

test('customer API uses a global directory and derives one ILS balance with optional store activity', async () => {
  const source = await readFile(new URL('../src/routes/customers.js', import.meta.url), 'utf8')
  assert.match(source, /customersRouter\.use\(requireStore\)/)
  assert.match(source, /INNER JOIN customer_balances/)
  assert.match(source, /balance_ils/)
  assert.match(source, /customer_store_balances/)
  assert.match(source, /\$2::BIGINT IS NULL OR sales\.store_id = \$2::BIGINT/)
  assert.doesNotMatch(source, /WHERE customers\.store_id/)
  assert.doesNotMatch(source, /customer_ledger\.currency_code/)
  assert.doesNotMatch(source, /SET[^;]*balance/is)
})

test('customer schema supports anonymous paid sales but requires customers for tracked records', async () => {
  const foundation = await readFile(
    new URL('../db/migrations/0001_foundational_schema.sql', import.meta.url),
    'utf8',
  )
  const salesTable = foundation.match(/CREATE TABLE sales \(([\s\S]*?)\n\);/)?.[1]
  const ledgerTable = foundation.match(/CREATE TABLE customer_ledger \(([\s\S]*?)\n\);/)?.[1]
  const projectsTable = foundation.match(/CREATE TABLE customer_projects \(([\s\S]*?)\n\);/)?.[1]
  const customerTable = foundation.match(/CREATE TABLE customers \(([\s\S]*?)\n\);/)?.[1]
  const sharedParties = await readFile(
    new URL('../db/migrations/0010_shared_parties_ils_ledgers.sql', import.meta.url),
    'utf8',
  )

  assert.ok(salesTable)
  assert.match(salesTable, /customer_id BIGINT,/) // nullable for fully paid anonymous sales
  assert.match(ledgerTable, /customer_id BIGINT NOT NULL/)
  assert.match(projectsTable, /customer_id BIGINT NOT NULL/)
  assert.doesNotMatch(customerTable, /\bbalance\b/i)
  assert.match(sharedParties, /ALTER TABLE customers DROP COLUMN store_id/)
  assert.match(sharedParties, /ALTER TABLE customer_projects DROP COLUMN store_id/)
  assert.match(sharedParties, /RENAME COLUMN amount TO amount_ils/)
  assert.match(sharedParties, /DROP COLUMN currency_code/)
  assert.match(sharedParties, /Existing rows keep their IDs and are never merged/)
})

test('customer page exposes the requested simple details and primary actions', async () => {
  const page = await readFile(
    new URL('../../client/src/pages/CustomersPage.tsx', import.meta.url),
    'utf8',
  )

  for (const label of [
    'الاسم *',
    'رقم الهاتف',
    'العنوان',
    'ملاحظات — اختياري',
    'الرصيد الحالي',
    'كل المحلات',
    'أحدث المبيعات',
    'الدفعات',
    'الشيكات',
    'المشاريع',
    'أحدث حركات الحساب',
    'بيع جديد',
    'تسجيل دفعة',
    'مشروع جديد',
    'كشف حساب',
  ]) {
    assert.match(page, new RegExp(label))
  }
  assert.doesNotMatch(page, /name="balance"/)
  assert.doesNotMatch(page, /BalanceBadges/)
  assert.match(page, /balance_ils/)
  assert.match(page, /store_balances/)
})

test('customer project activity supports all projects or one owned project', async () => {
  const api = await readFile(new URL('../src/routes/customers.js', import.meta.url), 'utf8')
  const page = await readFile(
    new URL('../../client/src/pages/CustomersPage.tsx', import.meta.url),
    'utf8',
  )

  assert.match(api, /request\.query\.projectId/)
  assert.match(api, /CUSTOMER_PROJECT_NOT_FOUND/)
  assert.match(api, /sales\.customer_project_id = \$3::BIGINT/)
  assert.match(api, /source_sale\.customer_project_id = \$3::BIGINT/)
  assert.match(page, /كل المشاريع/)
  assert.match(page, /selectedProjectId/)
  assert.doesNotMatch(page, /عنوان المشروع/)
})
