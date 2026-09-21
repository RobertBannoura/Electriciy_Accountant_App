import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isSaleQuantityAllowed,
  normalizeDecimal,
  parseProductInput,
} from '../src/products/product-input.js'

test('normalizes Arabic decimal inputs without using floating-point arithmetic', () => {
  assert.equal(normalizeDecimal('١٢٥٫٥٠'), '125.50')
  assert.equal(normalizeDecimal('۰٫۵۰'), '0.50')
  assert.equal(normalizeDecimal('10.125', { scale: 3 }), '10.125')
  assert.equal(normalizeDecimal('10.125', { scale: 2 }), undefined)
  assert.equal(normalizeDecimal(10), undefined)
  assert.equal(normalizeDecimal('-1'), undefined)
  assert.equal(normalizeDecimal('1,000'), undefined)
})

test('accepts valid products and preserves optional zero prices', () => {
  const parsed = parseProductInput({
    name: '  سلك كهرباء  ',
    categoryId: '2',
    saleUnit: 'متر',
    barcode: '123456',
    currentPurchasePrice: '0',
    defaultSalePrice: '',
    reorderLevel: '١٢٫٥',
    notes: '',
  })

  assert.deepEqual(parsed, {
    value: {
      name: 'سلك كهرباء',
      categoryId: '2',
      saleUnit: 'متر',
      barcode: '123456',
      purchasePrice: '0',
      salePrice: null,
      notes: null,
    },
  })
})

test('rejects invalid prices and missing categories', () => {
  const base = {
    name: 'قاطع كهرباء',
    categoryId: '1',
    saleUnit: 'قطعة',
    reorderLevel: '5',
  }

  assert.match(
    parseProductInput({ ...base, defaultSalePrice: '10.25' }).error,
    /₪0\.50/,
  )
  assert.match(parseProductInput({ ...base, categoryId: '' }).error, /تصنيف/)
  assert.match(parseProductInput({ ...base, categoryId: 1 }).error, /تصنيف/)
})

test('allows decimal sale quantities only for meter products', () => {
  assert.equal(isSaleQuantityAllowed('قطعة', '2'), true)
  assert.equal(isSaleQuantityAllowed('قطعة', '2.000'), true)
  assert.equal(isSaleQuantityAllowed('قطعة', '2.5'), false)
  assert.equal(isSaleQuantityAllowed('متر', '2.5'), true)
  assert.equal(isSaleQuantityAllowed('متر', '٢٫٢٥'), true)
  assert.equal(isSaleQuantityAllowed('متر', '0'), false)
  assert.equal(isSaleQuantityAllowed('متر', '0.000'), false)
})
