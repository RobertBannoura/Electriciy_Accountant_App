import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = (name) => new URL(`../db/migrations/${name}`, import.meta.url)

test('Group 3 inventory stays per-store, derived, and append-only', async () => {
  const foundation = await readFile(migrationUrl('0001_foundational_schema.sql'), 'utf8')
  const inventory = await readFile(migrationUrl('0006_per_store_inventory.sql'), 'utf8')

  const productTable = foundation.match(/CREATE TABLE products \(([\s\S]*?)\n\);/)?.[1]
  const storeInventoryTable = foundation.match(
    /CREATE TABLE store_inventory \(([\s\S]*?)\n\);/,
  )?.[1]

  assert.ok(productTable)
  assert.ok(storeInventoryTable)
  assert.doesNotMatch(productTable, /\bquantity\b/i)
  assert.doesNotMatch(storeInventoryTable, /\bquantity\b/i)
  assert.match(foundation, /CREATE VIEW store_inventory_balances AS/)
  assert.match(foundation, /SUM\(movements\.quantity_delta\)/)
  assert.match(
    foundation,
    /'inventory_movements'[\s\S]*BEFORE UPDATE OR DELETE[\s\S]*reject_append_only_change/,
  )
  assert.match(inventory, /ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE/)
  assert.match(inventory, /BEFORE INSERT ON inventory_movements/)

  for (const movementType of [
    'opening',
    'purchase',
    'sale',
    'customer_return',
    'supplier_return',
    'correction',
    'reversal',
  ]) {
    assert.match(inventory, new RegExp(`'${movementType}'`))
  }
})

test('Group 3 product catalog and generated barcode invariants are migrated', async () => {
  const products = await readFile(migrationUrl('0005_product_module.sql'), 'utf8')
  const inventory = await readFile(migrationUrl('0006_per_store_inventory.sql'), 'utf8')
  const barcodes = await readFile(migrationUrl('0007_barcode_generation.sql'), 'utf8')

  assert.match(products, /products_sale_unit_check/)
  assert.match(products, /unit_name IN \('قطعة', 'متر'\)/)
  assert.match(products, /sale_items_piece_quantity_whole/)
  assert.match(inventory, /ALTER TABLE products DROP COLUMN store_id/)
  assert.match(inventory, /ALTER TABLE categories DROP COLUMN store_id/)
  assert.match(inventory, /inventory_movements_one_opening_per_store_product/)
  assert.match(barcodes, /is_generated BOOLEAN NOT NULL DEFAULT FALSE/)
  assert.match(barcodes, /is_active BOOLEAN NOT NULL DEFAULT TRUE/)
  assert.match(barcodes, /CREATE SEQUENCE generated_barcode_sequence/)
  assert.match(barcodes, /NO CYCLE/)
  assert.doesNotMatch(barcodes, /DROP CONSTRAINT\s+barcodes_value_key/i)
})

test('product listing caps products before expanding their store rows', async () => {
  const source = await readFile(
    new URL('../src/routes/products.js', import.meta.url),
    'utf8',
  )

  const candidateIndex = source.indexOf('WITH candidate_products AS')
  const limitIndex = source.indexOf('LIMIT 500', candidateIndex)
  const expansionIndex = source.indexOf('FROM candidate_products', limitIndex)

  assert.ok(candidateIndex >= 0)
  assert.ok(limitIndex > candidateIndex)
  assert.ok(expansionIndex > limitIndex)
})
