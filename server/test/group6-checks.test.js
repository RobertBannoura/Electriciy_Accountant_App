import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('../db/migrations/0015_customer_checks.sql', import.meta.url)
const clientUrl = (path) => new URL(`../../client/${path}`, import.meta.url)

test('received customer checks have only the three financial states', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /status IN \('pending', 'cleared', 'bounced'\)/)
  assert.match(sql, /WHEN 'late' THEN 'pending'/)
  assert.match(sql, /WHEN 'due' THEN 'pending'/)
  assert.match(sql, /derived when it is displayed/)
})

test('customer check entry stays quick and acceptance starts pending', async () => {
  const [sale, customerPayment, sharedEditor, writer] = await Promise.all([
    readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/CustomerPaymentPage.tsx'), 'utf8'),
    readFile(clientUrl('src/components/PaymentEditor.tsx'), 'utf8'),
    readFile(new URL('../src/payments/payment-writer.js', import.meta.url), 'utf8'),
  ])

  for (const page of [sale, customerPayment, sharedEditor]) {
    assert.match(page, /رقم الشيك/)
    assert.match(page, /المبلغ/)
    assert.match(page, /تاريخ الاستحقاق/)
    assert.match(page, /ملاحظات — اختياري/)
    assert.doesNotMatch(page, /اسم البنك \(اختياري\)|البنك \(اختياري\)/)
  }
  assert.match(writer, /'inflow', 'pending'/)
  assert.match(writer, /payment\.notes \?\? contextLabel/)
})

test('checks register is store-only and derives overdue information from dates', async () => {
  const [app, route, page, labels] = await Promise.all([
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/checks.js', import.meta.url), 'utf8'),
    readFile(clientUrl('src/pages/ChecksPage.tsx'), 'utf8'),
    readFile(clientUrl('src/business-labels.ts'), 'utf8'),
  ])

  assert.match(app, /app\.use\('\/api\/checks', checksRouter\)/)
  assert.match(route, /checksRouter\.use\(requireStore\)/)
  assert.match(route, /checks\.direction = 'inflow'/)
  assert.doesNotMatch(route, /checksRouter\.(patch|delete)/i)
  assert.match(route, /checksRouter\.put\('\/reminder-settings'/)
  assert.match(route, /checksRouter\.post\('\/:checkId\/transfer'/)
  assert.match(route, /request\.query\.supplierAssigned/)
  assert.match(route, /checks\.supplier_id IS NOT NULL/)
  assert.match(page, /params\.set\('supplierAssigned', supplierAssigned\)/)
  assert.match(page, /مُسلّم إلى مورد/)
  assert.match(page, /غير مُسلّم إلى مورد/)
  assert.match(page, /check\.due_date < today/)
  assert.match(labels, /customerCheckStatusLabels[\s\S]*pending: 'قيد التحصيل'/)
  assert.match(labels, /customerCheckStatusLabels[\s\S]*cleared: 'تم تحصيله'/)
  assert.match(labels, /customerCheckStatusLabels[\s\S]*bounced: 'مرتجع'/)
})

test('giro describes the original owner and never creates a supplier transfer', async () => {
  const [migration, parser, writer, route, sale, customerPayment, sharedEditor] = await Promise.all([
    readFile(new URL('../db/migrations/0016_giro_customer_checks.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/sales/sale-payment-input.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/payments/payment-writer.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/checks.js', import.meta.url), 'utf8'),
    readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/CustomerPaymentPage.tsx'), 'utf8'),
    readFile(clientUrl('src/components/PaymentEditor.tsx'), 'utf8'),
  ])

  assert.match(migration, /ADD COLUMN is_giro BOOLEAN NOT NULL DEFAULT FALSE/)
  assert.match(migration, /original_owner_name TEXT/)
  assert.match(migration, /original_owner_phone TEXT/)
  assert.match(migration, /supplier_id IS NULL/)
  assert.match(migration, /NEW\.original_owner_name IS DISTINCT FROM OLD\.original_owner_name/)
  assert.match(parser, /originalOwnerName/)
  assert.match(parser, /originalOwnerPhone/)
  assert.match(writer, /is_giro, original_owner_name, original_owner_phone/)
  assert.match(route, /checks\.original_owner_name/)

  for (const page of [sale, customerPayment, sharedEditor]) {
    assert.match(page, /شيك جيرو/)
    assert.match(page, /payment\.isGiro/)
    assert.match(page, /اسم صاحب الشيك الأصلي/)
    assert.match(page, /رقم هاتف صاحب الشيك الأصلي/)
    assert.doesNotMatch(page, /supplierId|supplier_id|المورد/)
  }
})

test('supplier transfer preserves one check and creates one supplier debit', async () => {
  const [migration, service, route, checksPage, suppliersPage] = await Promise.all([
    readFile(new URL('../db/migrations/0017_supplier_check_transfers.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/checks/transfer-check.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/checks.js', import.meta.url), 'utf8'),
    readFile(clientUrl('src/pages/ChecksPage.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/SuppliersPage.tsx'), 'utf8'),
  ])

  assert.match(migration, /DROP CONSTRAINT checks_at_most_one_party/)
  assert.match(migration, /ADD COLUMN transferred_at DATE/)
  assert.match(migration, /customer_id IS NOT NULL[\s\S]*supplier_id IS NOT NULL/)
  assert.match(migration, /OLD\.supplier_id IS NOT NULL/)
  assert.match(migration, /supplier_ledger_one_check_transfer/)
  assert.match(service, /UPDATE checks[\s\S]*SET supplier_id/)
  assert.doesNotMatch(service, /INSERT INTO checks/)
  assert.match(service, /INSERT INTO supplier_ledger/)
  assert.match(service, /'debit'/)
  assert.match(service, /'check_transfer'/)
  assert.match(route, /checksRouter\.post\('\/:checkId\/transfer'/)
  assert.match(checksPage, /تحويل لمورد/)
  assert.match(checksPage, /اختر المورد/)
  assert.match(checksPage, /تاريخ التحويل/)
  assert.match(suppliersPage, /من العميل/)
  assert.match(suppliersPage, /صاحب الشيك الأصلي/)
})
