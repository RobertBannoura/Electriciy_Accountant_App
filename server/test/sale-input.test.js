import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateSale, parseSaleInput } from '../src/sales/sale-input.js'

test('sale input normalizes Arabic values and ignores client totals and store IDs', () => {
  const parsed = parseSaleInput({
    storeId: '999',
    invoiceNumber: '  S-100  ',
    date: '2026-09-08',
    customerId: '',
    customerProjectId: null,
    invoiceDiscount: '١٫٥٠',
    total: '1',
    itemsSubtotal: '1',
    items: [
      {
        productId: '7',
        quantity: '٢٫٥',
        originalPrice: '999999',
        actualPrice: '١٠٫٥٠',
        discount: '٠٫٥٠',
        total: '0',
      },
    ],
  })

  assert.deepEqual(parsed, {
    value: {
      invoiceNumber: 'S-100',
      businessDate: '2026-09-08',
      customerId: null,
      customerProjectId: null,
      invoiceDiscount: '1.50',
      items: [
        { productId: '7', quantity: '2.5', actualPrice: '10.50', discount: '0.50' },
      ],
      payments: [],
    },
  })
})

test('sale input permits automatic invoice numbering and validates the remaining fields', () => {
  const base = {
    invoiceNumber: 'S-1',
    date: '2026-09-08',
    items: [{ productId: '1', quantity: '1', actualPrice: '10', discount: '0' }],
  }

  assert.equal(parseSaleInput({ ...base, invoiceNumber: '' }).value.invoiceNumber, null)
  assert.equal(parseSaleInput({ ...base, invoiceNumber: undefined }).value.invoiceNumber, null)
  assert.match(parseSaleInput({ ...base, invoiceNumber: 'x'.repeat(101) }).error, /رقم الفاتورة/)
  assert.match(parseSaleInput({ ...base, date: '2026-02-30' }).error, /تاريخ الفاتورة/)
  assert.match(parseSaleInput({ ...base, items: [] }).error, /صنف واحد/)
  assert.match(parseSaleInput({ ...base, customerId: 0 }).error, /معرّف العميل/)
  assert.match(
    parseSaleInput({ ...base, customerProjectId: '2' }).error,
    /اختيار العميل/,
  )
  assert.match(
    parseSaleInput({ ...base, invoiceDiscount: '0.25' }).error,
    /نصف شيكل/,
  )
})

test('sale input accepts validated invoice-only manual lines without a product ID', () => {
  const parsed = parseSaleInput({
    invoiceNumber: 'MANUAL-1',
    date: '2026-09-11',
    items: [{
      productId: null,
      description: '  أجرة تركيب لوحة  ',
      quantity: '1.5',
      actualPrice: '20',
      discount: '0.50',
    }],
  })

  assert.deepEqual(parsed.value.items, [{
    productId: null,
    description: 'أجرة تركيب لوحة',
    quantity: '1.5',
    actualPrice: '20',
    discount: '0.50',
  }])
  assert.match(parseSaleInput({
    invoiceNumber: 'MANUAL-2', date: '2026-09-11',
    items: [{ productId: null, description: ' ', quantity: '1', actualPrice: '10' }],
  }).error, /اسم الصنف مطلوب/)
})

test('server sale calculation is exact and applies line then invoice amount discounts', () => {
  const calculated = calculateSale(
    [
      {
        productId: '1',
        productName: 'سلك',
        saleUnit: 'متر',
        quantity: '0.1',
        actualPrice: '0.50',
        originalPrice: '1.00',
        discount: '0',
      },
      {
        productId: '2',
        productName: 'قاطع',
        saleUnit: 'قطعة',
        quantity: '2',
        actualPrice: '10.50',
        originalPrice: null,
        discount: '0.50',
      },
    ],
    '0.50',
  )

  assert.equal(calculated.value.items[0].lineTotal, '0.05')
  assert.equal(calculated.value.items[1].lineTotal, '20.5')
  assert.equal(calculated.value.itemsSubtotal, '20.55')
  assert.equal(calculated.value.total, '20.05')

  assert.match(
    calculateSale(
      [{
        productId: '2', productName: 'قاطع', saleUnit: 'قطعة', quantity: '1.5',
        actualPrice: '10', originalPrice: '10', discount: '0',
      }],
      '0',
    ).error,
    /عدداً صحيحاً/,
  )
})
