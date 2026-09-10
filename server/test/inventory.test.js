import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeSignedDecimal,
  parseInventorySettings,
  parseMovementInput,
} from '../src/inventory/inventory-input.js'
import { inventoryMovementAuthorId } from '../src/routes/products.js'

test('validates per-store settings and Arabic opening quantities', () => {
  assert.deepEqual(
    parseInventorySettings(
      [
        { storeId: '1', reorderLevel: '٥', openingQuantity: '٢٠' },
        { storeId: '2', reorderLevel: '10', openingQuantity: '35' },
      ],
      'قطعة',
      { opening: true },
    ),
    {
      value: [
        { storeId: '1', reorderLevel: '5', openingQuantity: '20' },
        { storeId: '2', reorderLevel: '10', openingQuantity: '35' },
      ],
    },
  )
})

test('requires at least one unique store and whole piece quantities', () => {
  assert.match(parseInventorySettings([], 'قطعة').error, /متجر واحد/)
  assert.match(
    parseInventorySettings(
      [
        { storeId: '1', reorderLevel: '2' },
        { storeId: '1', reorderLevel: '3' },
      ],
      'قطعة',
    ).error,
    /غير صالحة/,
  )
  assert.match(
    parseInventorySettings(
      [{ storeId: '1', reorderLevel: '2.5', openingQuantity: '1' }],
      'قطعة',
      { opening: true },
    ).error,
    /أعداداً صحيحة/,
  )
  assert.equal(
    parseInventorySettings(
      [{ storeId: '1', reorderLevel: '2.5', openingQuantity: '1.25' }],
      'متر',
      { opening: true },
    ).error,
    undefined,
  )
})

test('validates inventory movement direction and unit precision', () => {
  assert.equal(normalizeSignedDecimal('−٢٫٥'), '-2.5')
  assert.equal(
    parseMovementInput(
      { storeId: '1', movementType: 'purchase', quantityDelta: '2' },
      'قطعة',
    ).error,
    undefined,
  )
  assert.match(
    parseMovementInput(
      { storeId: '1', movementType: 'sale', quantityDelta: '2' },
      'قطعة',
    ).error,
    /سالبة/,
  )
  assert.match(
    parseMovementInput(
      { storeId: '1', movementType: 'sale', quantityDelta: '-2.5' },
      'قطعة',
    ).error,
    /صحيحاً/,
  )
  assert.equal(
    parseMovementInput(
      { storeId: '1', movementType: 'sale', quantityDelta: '-2.5' },
      'متر',
    ).error,
    undefined,
  )
})

test('supports every specified inventory movement type', () => {
  const signedQuantities = {
    opening: '1',
    purchase: '1',
    sale: '-1',
    customer_return: '1',
    supplier_return: '-1',
    correction: '1',
    reversal: '-1',
  }

  for (const [movementType, quantityDelta] of Object.entries(signedQuantities)) {
    const parsed = parseMovementInput(
      { storeId: '1', movementType, quantityDelta },
      'قطعة',
    )
    assert.equal(parsed.error, undefined)
  }
})

test('supports correction and reversal deltas in either direction', () => {
  for (const movementType of ['correction', 'reversal']) {
    const parsed = parseMovementInput(
      { storeId: '1', movementType, quantityDelta: '-1.25', reason: 'تصحيح' },
      'متر',
    )
    assert.equal(parsed.error, undefined)
  }
})

test('inventory movements retain the authenticated database admin ID', () => {
  assert.equal(
    inventoryMovementAuthorId({
      auth: { user: { id: '42' } },
    }),
    '42',
  )
})
