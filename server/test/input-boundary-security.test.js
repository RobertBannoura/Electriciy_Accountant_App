import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseCustomerInput } from '../src/customers/customer-input.js'
import { DEFAULT_EXPENSE_CATEGORIES, parseExpenseInput } from '../src/expenses/expense-input.js'
import { parseInventorySettings } from '../src/inventory/inventory-input.js'
import { parsePagination } from '../src/pagination/pagination.js'
import {
  normalizeBarcode,
  parseId,
  parseProductInput,
  SALE_UNITS,
} from '../src/products/product-input.js'
import { parsePurchaseInput } from '../src/purchases/purchase-input.js'
import { parseReportFilters } from '../src/reports/report-input.js'
import { parseSaleInput } from '../src/sales/sale-input.js'
import { parseSalePayments } from '../src/sales/sale-payment-input.js'
import { parseSupplierInput } from '../src/suppliers/supplier-input.js'

const privilegedFields = {
  balance: '999999',
  role: 'admin',
  store_id: 'attacker-value',
  storeId: '999999',
  total: '0',
  createdAt: '1970-01-01T00:00:00.000Z',
}

test('body parsers whitelist fields instead of mass-assigning privileged or derived values', () => {
  const customer = parseCustomerInput({
    name: 'Customer',
    phone: '123',
    address: 'Address',
    notes: 'Note',
    ...privilegedFields,
  })
  const supplier = parseSupplierInput({
    name: 'Supplier',
    phone: '456',
    ...privilegedFields,
  })
  const product = parseProductInput({
    name: 'Product',
    categoryId: '1',
    saleUnit: SALE_UNITS[0],
    barcode: 'ABC-123',
    currentPurchasePrice: '10.50',
    defaultSalePrice: '12.50',
    ...privilegedFields,
  })
  const sale = parseSaleInput({
    invoiceNumber: 'INV-1',
    businessDate: '2026-09-10',
    customerId: '1',
    invoiceDiscount: '0',
    items: [{
      productId: '1',
      quantity: '1',
      actualPrice: '12.50',
      discount: '0',
      purchasePrice: '0',
      lineTotal: '0',
      storeId: '999999',
    }],
    ...privilegedFields,
  })
  const purchase = parsePurchaseInput({
    supplierId: '1',
    documentNumber: 'PUR-1',
    businessDate: '2026-09-10',
    items: [{
      productId: '1',
      quantity: '1',
      purchasePrice: '10.50',
      lineTotal: '0',
      storeId: '999999',
    }],
    ...privilegedFields,
  })

  assert.deepEqual(Object.keys(customer.value), ['name', 'phone', 'address', 'notes'])
  assert.deepEqual(Object.keys(supplier.value), ['name', 'phone', 'address', 'notes'])
  assert.deepEqual(Object.keys(product.value), [
    'name', 'categoryId', 'saleUnit', 'barcode', 'purchasePrice', 'salePrice', 'notes',
  ])
  assert.deepEqual(Object.keys(sale.value), [
    'invoiceNumber', 'businessDate', 'customerId', 'customerProjectId',
    'invoiceDiscount', 'items', 'payments',
  ])
  assert.deepEqual(sale.value.items[0], {
    productId: '1', quantity: '1', actualPrice: '12.50', discount: '0',
  })
  assert.deepEqual(Object.keys(purchase.value), [
    'supplierId', 'documentNumber', 'businessDate', 'notes', 'items', 'payments',
  ])
  assert.deepEqual(purchase.value.items[0], {
    productId: '1', quantity: '1', purchasePrice: '10.50',
  })
})

test('route and service code never spreads or assigns raw request bodies', async () => {
  const serverSourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
  const sourceFiles = (await readdir(serverSourceRoot, { recursive: true }))
    .filter((name) => name.endsWith('.js'))
  const source = (await Promise.all(
    sourceFiles.map((name) => readFile(path.join(serverSourceRoot, name), 'utf8')),
  )).join('\n')

  assert.equal(/\.\.\.(?:request|req)\.body/.test(source), false)
  assert.equal(/Object\.assign\([^\n]*(?:request|req)\.body/.test(source), false)
})

test('injection-shaped identifiers fail closed while text values remain data', () => {
  for (const payload of ["'", "' OR '1'='1", "'; DROP TABLE users; --", '%27']) {
    assert.equal(parseId(payload), null)
    assert.equal(parseCustomerInput({ name: payload }).value.name, payload)
  }
})

test('pagination, report ranges, inventory batches, barcodes, money, FX, and enums are bounded', () => {
  assert.throws(
    () => parsePagination({ limit: '1000000' }),
    (error) => error.code === 'INVALID_PAGINATION',
  )
  assert.ok(parseReportFilters({ from: '2025-01-01', to: '2026-09-10' }).error)
  assert.ok(parseInventorySettings(
    Array.from({ length: 101 }, (_, index) => ({
      storeId: String(index + 1),
      reorderLevel: '0',
    })),
    SALE_UNITS[1],
  ).error)
  assert.equal(normalizeBarcode('A B'), undefined)
  assert.equal(normalizeBarcode('x'.repeat(101)), undefined)
  assert.ok(parseProductInput({
    name: 'Product',
    categoryId: '1',
    saleUnit: SALE_UNITS[0],
    currentPurchasePrice: '-1',
    defaultSalePrice: '10',
  }).error)
  assert.ok(parseSalePayments([{
    method: 'cash', currency: 'USD', amount: '10', exchangeRate: '0',
  }]).error)
  assert.ok(parseSalePayments([{
    method: 'cash', currency: 'BTC', amount: '10', exchangeRate: '1',
  }]).error)
  assert.ok(parseExpenseInput({
    amount: '10',
    category: `${DEFAULT_EXPENSE_CATEGORIES[0]}${'x'.repeat(101)}`,
    date: '2026-09-10',
    paymentMethod: 'cash',
  }).error)
})

test('React escapes stored and reflected attack strings and first-party UI code has no HTML escape hatch', async () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg/onload=alert(1)>',
  ]

  for (const payload of payloads) {
    const html = renderToStaticMarkup(createElement('div', null, payload))
    assert.equal(html.includes(payload), false)
    assert.match(html, /&lt;/)
  }

  const clientSourceRoot = fileURLToPath(new URL('../../client/src/', import.meta.url))
  const sourceFiles = (await readdir(clientSourceRoot, { recursive: true }))
    .filter((name) => /\.(?:js|jsx|ts|tsx)$/.test(name))
  const source = (await Promise.all(
    sourceFiles.map((name) => readFile(path.join(clientSourceRoot, name), 'utf8')),
  )).join('\n')

  assert.equal(
    /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|\bsrcDoc\s*=|document\.write\s*\(/.test(source),
    false,
  )
})
