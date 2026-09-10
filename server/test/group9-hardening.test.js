import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { paginatedResult, parsePagination } from '../src/pagination/pagination.js'
import { parseStatementRange } from '../src/statements/statement-input.js'

test('pagination is bounded, reports a next page, and rejects abusive offsets', () => {
  const parsed = parsePagination({ page: '2', limit: '2' })
  assert.deepEqual(parsed, { page: 2, limit: 2, offset: 2, fetchLimit: 3 })
  assert.deepEqual(paginatedResult([1, 2, 3], parsed), {
    rows: [1, 2],
    pagination: { page: 2, limit: 2, hasMore: true, nextPage: 3 },
  })
  assert.throws(() => parsePagination({ limit: '101' }), (error) => error.code === 'INVALID_PAGINATION')
  assert.throws(() => parsePagination({ page: '1000000' }), (error) => error.code === 'INVALID_PAGINATION')
})

test('statements cannot load multiple years in one request', () => {
  assert.ok(parseStatementRange({ from: '2025-01-01', to: '2026-09-09' }).error)
  assert.deepEqual(parseStatementRange({ from: '2026-01-01', to: '2026-09-09' }), {
    value: { from: '2026-01-01', to: '2026-09-09' },
  })
})

test('the hardening migration adds search, store/date, and immutable audit indexes', async () => {
  const [sql, foundational] = await Promise.all([
    readFile(new URL('../db/migrations/0023_audit_security_performance_hardening.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/0001_foundational_schema.sql', import.meta.url), 'utf8'),
  ])
  for (const expected of [
    'pg_trgm', 'products_name_trgm_index', 'customers_name_trgm_index',
    'customers_phone_trgm_index', 'suppliers_name_trgm_index', 'checks_number_trgm_index',
    'barcodes_active_value_product_index', 'sales_store_date_page_index',
    'purchases_store_date_page_index', 'payments_store_date_page_index',
    'checks_store_due_page_index', 'expenses_store_date_page_index',
    'inventory_movements_store_date_page_index', 'audit_log_action_created_index',
  ]) assert.match(sql, new RegExp(expected))
  assert.match(foundational, /audit_log[\s\S]*table_name \|\| '_append_only'/)
})

test('all required business actions write audit entries', async () => {
  const files = await Promise.all([
    '../src/routes/auth.js', '../src/sales/create-sale.js',
    '../src/returns/create-customer-return.js', '../src/returns/create-supplier-return.js',
    '../src/purchases/create-purchase.js', '../src/customers/create-customer-payment.js',
    '../src/suppliers/create-supplier-payment.js', '../src/checks/check-lifecycle.js',
    '../src/checks/transfer-check.js', '../src/expenses/create-expense.js',
    '../src/routes/products.js', '../src/routes/backups.js',
    '../src/backups/backup-service.js', '../src/routes/stores.js',
    '../src/routes/checks.js', '../src/routes/push.js',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')))
  const source = files.join('\n')
  for (const action of [
    'login', 'sale', 'sale_reversal', 'purchase', 'return', 'payment',
    'check_status_change', 'check_transfer', 'bounced_reversal', 'expense',
    'inventory_adjustment', 'backup', 'restore', 'settings_change',
  ]) assert.match(source, new RegExp(`['"]${action}['"]`), `missing audit action ${action}`)
})

test('security controls stay server-side and Electron IPC stays isolated', async () => {
  const [app, password, auth, electron, preload, clientApi, env] = await Promise.all([
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/auth/password.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/preload.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/config/env.js', import.meta.url), 'utf8'),
  ])
  assert.match(app, /helmet\(/)
  assert.match(app, /cors\(/)
  assert.match(app, /app\.use\('\/api', requireAuth\)/)
  assert.match(auth, /rateLimit\(/)
  assert.match(password, /scrypt/)
  assert.match(password, /timingSafeEqual/)
  assert.match(electron, /contextIsolation:\s*true/)
  assert.match(electron, /nodeIntegration:\s*false/)
  assert.match(electron, /sandbox:\s*true/)
  assert.match(electron, /assertTrustedIpcSender/)
  assert.doesNotMatch(`${electron}\n${preload}\n${clientApi}`, /DATABASE_URL|PGPASSWORD|VAPID_PRIVATE_KEY/)
  assert.match(env, /nodeEnv === 'production' && !databaseUrl/)
})

test('backup implementation is included in source control packaging', async () => {
  const [ignoreRules, backupService] = await Promise.all([
    readFile(new URL('../../.gitignore', import.meta.url), 'utf8'),
    readFile(new URL('../src/backups/backup-service.js', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(ignoreRules, /^backups\/$/m)
  assert.match(ignoreRules, /^\/backups\/$/m)
  assert.match(backupService, /export async function createBackup/)
  assert.match(backupService, /export async function restoreBackup/)
})

test('sale and purchase services recompute totals instead of accepting frontend totals', async () => {
  const [saleInput, saleService, purchaseInput, purchaseService] = await Promise.all([
    readFile(new URL('../src/sales/sale-input.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/sales/create-sale.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/purchases/purchase-input.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/purchases/create-purchase.js', import.meta.url), 'utf8'),
  ])
  assert.match(saleService, /calculateSale\(enrichedItems, input\.invoiceDiscount\)/)
  assert.match(purchaseService, /calculatePurchase\(input\.items\.map/)
  const saleParser = saleInput.slice(
    saleInput.indexOf('export function parseSaleInput'),
    saleInput.indexOf('export function calculateSale'),
  )
  const purchaseParser = purchaseInput.slice(
    purchaseInput.indexOf('export function parsePurchaseInput'),
    purchaseInput.indexOf('export function calculatePurchase'),
  )
  assert.doesNotMatch(saleParser, /body\?\.(total|paidTotal|remainingDue|grossProfit)/)
  assert.doesNotMatch(purchaseParser, /body\?\.(total|paidTotal|remainingDue)/)
})
