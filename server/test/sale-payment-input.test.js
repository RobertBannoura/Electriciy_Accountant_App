import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateSalePaymentBreakdown,
  parseSalePayments,
} from '../src/sales/sale-payment-input.js'

test('sale payment input accepts multiple methods and preserves an exact foreign snapshot', () => {
  const parsed = parseSalePayments([
    { method: 'cash', currency: 'ILS', amount: '٣٠٠' },
    { method: 'cash', currency: 'USD', amount: '١٠٠', exchangeRate: '٣٫٠٠' },
    { method: 'bank_card', amount: '100.50', reference: 'POS-9' },
    {
      method: 'check', amount: '200', checkNumber: '44',
      dueDate: '2026-09-30', notes: 'شيك العميل',
    },
  ])

  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.value[1], {
    method: 'cash',
    currency: 'USD',
    originalAmount: '100',
    exchangeRate: '3.00',
    convertedIlsAmount: '300',
    reference: null,
  })
  assert.equal(parsed.value[2].currency, 'ILS')
  assert.equal(parsed.value[3].checkNumber, '44')
  assert.equal(parsed.value[3].notes, 'شيك العميل')
})

test('foreign cash requires a manual exchange rate and ILS payment uses half-shekel steps', () => {
  assert.match(
    parseSalePayments([{ method: 'cash', currency: 'USD', amount: '10' }]).error,
    /سعر صرف يدوي/,
  )
  assert.match(
    parseSalePayments([{ method: 'bank_card', amount: '10.25' }]).error,
    /مضاعفات 0.50/,
  )
})

test('remaining amount is debt and therefore requires a customer without creating a row', () => {
  const payments = parseSalePayments([
    { method: 'cash', currency: 'ILS', amount: '300' },
    { method: 'check', amount: '200', checkNumber: '8', dueDate: '2026-09-30' },
  ]).value

  assert.match(calculateSalePaymentBreakdown(payments, '1000', null).error, /اختيار عميل/)
  assert.deepEqual(calculateSalePaymentBreakdown(payments, '1000', '4'), {
    value: { payments, paidTotal: '500', remainingDue: '500' },
  })
  assert.match(calculateSalePaymentBreakdown(payments, '400', '4').error, /أكبر/)
})

test('a received check always belongs to the customer selected by its sale or payment', () => {
  const payments = parseSalePayments([
    {
      method: 'check', amount: '200', checkNumber: '8',
      dueDate: '2026-09-30', notes: 'اتصل قبل الإيداع',
    },
  ]).value

  assert.equal(payments[0].notes, 'اتصل قبل الإيداع')
  assert.match(calculateSalePaymentBreakdown(payments, '200', null).error, /اختيار عميل/)
  assert.equal(calculateSalePaymentBreakdown(payments, '200', '4').value.paidTotal, '200')
})

test('giro check requires and preserves the original owner without changing payment method', () => {
  const parsed = parseSalePayments([{
    method: 'check',
    amount: '250',
    checkNumber: 'G-18',
    dueDate: '2026-11-01',
    isGiro: true,
    originalOwnerName: ' يوسف ',
    originalOwnerPhone: ' 0599000000 ',
  }])

  assert.equal(parsed.error, undefined)
  assert.deepEqual(
    {
      method: parsed.value[0].method,
      isGiro: parsed.value[0].isGiro,
      originalOwnerName: parsed.value[0].originalOwnerName,
      originalOwnerPhone: parsed.value[0].originalOwnerPhone,
    },
    {
      method: 'check',
      isGiro: true,
      originalOwnerName: 'يوسف',
      originalOwnerPhone: '0599000000',
    },
  )

  assert.match(parseSalePayments([{
    method: 'check', amount: '250', checkNumber: 'G-19',
    dueDate: '2026-11-01', isGiro: true,
  }]).error, /اسم صاحب الشيك الأصلي/)
  assert.match(parseSalePayments([{
    method: 'check', amount: '250', checkNumber: 'G-20',
    dueDate: '2026-11-01', isGiro: true, originalOwnerName: 'يوسف',
  }]).error, /رقم هاتف صاحب الشيك الأصلي/)
})
