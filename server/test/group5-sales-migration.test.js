import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('../db/migrations/0011_sale_creation.sql', import.meta.url)

test('sale migration stores original, actual, discount, and exact total snapshots', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /original_unit_price NUMERIC\(14, 2\)/)
  assert.match(sql, /unit_price TYPE NUMERIC\(14, 2\)/)
  assert.match(sql, /line_discount NUMERIC\(14, 2\)/)
  assert.match(sql, /line_total NUMERIC\(32, 5\)/)
  assert.match(sql, /items_subtotal NUMERIC\(32, 5\)/)
  assert.match(sql, /invoice_discount NUMERIC\(14, 2\)/)
  assert.match(sql, /total = items_subtotal - invoice_discount/)
  assert.match(sql, /UNIQUE \(store_id, document_number\)/)
})

test('saved sale headers and items are immutable', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /sales_immutable[\s\S]*BEFORE UPDATE OR DELETE ON sales/)
  assert.match(sql, /sale_items_immutable[\s\S]*BEFORE UPDATE OR DELETE ON sale_items/)
  assert.match(sql, /reject_append_only_change/)
})

test('sale quantity trigger is recreated around the precision type change', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const dropPosition = sql.indexOf('DROP TRIGGER sale_items_enforce_unit_quantity')
  const alterPosition = sql.indexOf('ALTER TABLE sale_items')
  const recreatePosition = sql.lastIndexOf('CREATE TRIGGER sale_items_enforce_unit_quantity')

  assert.ok(dropPosition > -1)
  assert.ok(dropPosition < alterPosition)
  assert.ok(recreatePosition > alterPosition)
})

test('sales API is store-scoped and creates all records inside one transaction', async () => {
  const [app, route, service] = await Promise.all([
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/sales.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/sales/create-sale.js', import.meta.url), 'utf8'),
  ])

  assert.match(app, /app\.use\('\/api\/sales', salesRouter\)/)
  assert.match(route, /salesRouter\.use\(requireStore\)/)
  assert.match(route, /storeId: request\.storeId/)
  assert.match(service, /client\.query\('BEGIN'\)/)
  assert.match(service, /INSERT INTO sales/)
  assert.match(service, /INSERT INTO sale_items/)
  assert.match(service, /INSERT INTO inventory_movements/)
  assert.match(service, /movement_type[\s\S]*'sale'/)
  assert.match(service, /client\.query\('COMMIT'\)/)
  assert.match(service, /client\.query\('ROLLBACK'\)/)
})
