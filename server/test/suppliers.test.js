import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseSupplierInput } from '../src/suppliers/supplier-input.js'

test('supplier input accepts the four supplier fields and ignores balance input', () => {
  assert.deepEqual(
    parseSupplierInput({
      name: '  شركة النور  ',
      phone: ' 022900000 ',
      address: '  الخليل ',
      notes: '   ',
      balance: '5000',
    }),
    {
      value: {
        name: 'شركة النور',
        phone: '022900000',
        address: 'الخليل',
        notes: null,
      },
    },
  )
  assert.match(parseSupplierInput({ name: '' }).error, /اسم المورد/)
  assert.match(parseSupplierInput({ name: 'مورد', notes: 'x'.repeat(2001) }).error, /الملاحظات/)
})

test('supplier API uses a global directory and one ILS ledger balance', async () => {
  const source = await readFile(new URL('../src/routes/suppliers.js', import.meta.url), 'utf8')

  assert.match(source, /suppliersRouter\.use\(requireStore\)/)
  assert.match(source, /INNER JOIN supplier_balances/)
  assert.match(source, /supplier_store_balances/)
  assert.match(source, /balance_ils/)
  assert.match(source, /amount_ils/)
  assert.doesNotMatch(source, /WHERE suppliers\.store_id/)
  assert.doesNotMatch(source, /supplier_ledger\.currency_code/)
  assert.match(source, /purchases\.supplier_id/)
  assert.match(source, /payments[\s\S]*supplier_id/)
  assert.match(source, /checks[\s\S]*supplier_id/)
  assert.doesNotMatch(source, /customer_ledger/)
  assert.doesNotMatch(source, /SET[^;]*balance/is)
})

test('supplier schema has no editable balance and keeps its ledger append-only', async () => {
  const foundation = await readFile(
    new URL('../db/migrations/0001_foundational_schema.sql', import.meta.url),
    'utf8',
  )
  const supplierTable = foundation.match(/CREATE TABLE suppliers \(([\s\S]*?)\n\);/)?.[1]
  const sharedParties = await readFile(
    new URL('../db/migrations/0010_shared_parties_ils_ledgers.sql', import.meta.url),
    'utf8',
  )

  assert.ok(supplierTable)
  assert.doesNotMatch(supplierTable, /\bbalance\b/i)
  assert.match(sharedParties, /CREATE VIEW supplier_balances AS/)
  assert.match(sharedParties, /ALTER TABLE suppliers DROP COLUMN store_id/)
  assert.match(sharedParties, /ALTER TABLE supplier_ledger[\s\S]*RENAME COLUMN amount TO amount_ils/)
  assert.match(sharedParties, /DROP COLUMN currency_code/)
  assert.match(
    foundation,
    /'supplier_ledger'[\s\S]*BEFORE UPDATE OR DELETE[\s\S]*reject_append_only_change/,
  )
})

test('supplier UI stays separate and exposes only the requested supplier actions', async () => {
  const page = await readFile(
    new URL('../../client/src/pages/SuppliersPage.tsx', import.meta.url),
    'utf8',
  )
  const app = await readFile(new URL('../../client/src/App.tsx', import.meta.url), 'utf8')

  for (const label of [
    'الاسم *',
    'رقم الهاتف',
    'العنوان',
    'ملاحظات — اختياري',
    'المستحق للمورد',
    'كل المحلات',
    'المشتريات',
    'الدفعات',
    'الشيكات',
    'أحدث الحركات',
    'شراء جديد',
    'تسجيل دفعة',
    'كشف حساب',
  ]) {
    assert.match(page, new RegExp(label))
  }

  assert.match(app, /path="suppliers"[\s\S]*<SuppliersPage/)
  assert.match(app, /path="suppliers\/:supplierId"[\s\S]*<SupplierDetailPage/)
  assert.doesNotMatch(page, /to="\/customers"/)
  assert.doesNotMatch(page, /name="balance"/)
  assert.doesNotMatch(page, /BalanceBadges/)
  assert.match(page, /balance_ils/)
  assert.match(page, /store_balances/)
  assert.match(page, /to={`\/purchases\?supplierId=/)
})

test('purchasing uses the implemented store-scoped workflow', async () => {
  const app = await readFile(new URL('../../client/src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /path="purchases"[\s\S]*<PurchasePage configuredStoreId=/)
  assert.match(app, /path="suppliers\/:supplierId\/payment"[\s\S]*<SupplierPaymentPage/)
})
