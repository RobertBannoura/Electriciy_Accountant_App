import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientUrl = (path) => new URL(`../../client/${path}`, import.meta.url)

test('selling screen exposes barcode and name search with inline line editing', async () => {
  const page = await readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8')

  assert.match(page, /useBarcodeScanner/)
  assert.match(page, /امسح الباركود أو اكتب اسم الصنف/)
  assert.match(page, /actualSalePrice/)
  assert.match(page, /originalPrice/)
  assert.match(page, /القطعة تقبل عدداً صحيحاً فقط/)
  assert.match(page, /saleUnit === 'قطعة'/)
  assert.match(page, /خصم على كامل الفاتورة/)
  assert.match(page, /إتمام البيع/)
  assert.match(page, /disabled={!canSave}/)
})

test('selling screen uses decimal arithmetic and saves through the configured Electron store', async () => {
  const page = await readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8')

  assert.match(page, /from 'decimal\.js'/)
  assert.match(page, /quantity\.mul\(price\)/)
  assert.doesNotMatch(page, /Math\.round|parseFloat|parseInt/)
  assert.match(page, /saleApiFetch\('\/sales'/)
  assert.match(page, /بطاقة \/ بنك/)
  assert.match(page, /سعر الصرف اليدوي/)
  assert.match(page, /المبلغ غير المدفوع يظهر ديناً/)
})

test('web selling screen uses the selected store while Electron keeps device assignment', async () => {
  const [page, app, api, shell, browserStore] = await Promise.all([
    readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8'),
    readFile(clientUrl('src/App.tsx'), 'utf8'),
    readFile(clientUrl('src/api.ts'), 'utf8'),
    readFile(clientUrl('src/components/AppShell.tsx'), 'utf8'),
    readFile(clientUrl('src/browser-active-store.ts'), 'utf8'),
  ])

  assert.match(page, /if \(window\.desktop\) return storeScopedApiFetch/)
  assert.match(page, /headers\.set\('X-Store-Id', configuredStoreId\)/)
  assert.match(api, /window\.desktop\.getStoreAssignment\(\)/)
  assert.match(api, /headers\.set\('X-Store-Id', storeId\)/)
  assert.match(shell, /المحل الحالي:/)
  assert.match(shell, /onBrowserStoreChange\(event\.target\.value\)/)
  assert.match(browserStore, /localStorage\.getItem\(BROWSER_ACTIVE_STORE_KEY\)/)
  assert.match(browserStore, /localStorage\.setItem\(BROWSER_ACTIVE_STORE_KEY, storeId\)/)
  assert.match(browserStore, /stores\.some\(\(store\) => store\.id === storedId\)/)
  assert.match(app, /\.then\(\(loadedStores\) => \{[\s\S]*setStores\(loadedStores\)[\s\S]*setStoresLoaded\(true\)/)
  assert.doesNotMatch(app, /setConfiguredStoreId\(stores\[0\]\.id\)/)
  assert.doesNotMatch(page, /product\.inventories\[0\]/)
})

test('web financial writes stay blocked until a persisted active store is explicitly resolved', async () => {
  const [app, sale, maintenance, customerPayment] = await Promise.all([
    readFile(clientUrl('src/App.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/MaintenancePage.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/CustomerPaymentPage.tsx'), 'utf8'),
  ])

  assert.match(sale, /const needsStore = !configuredStoreId/)
  assert.match(sale, /if \(!configuredStoreId\) throw new Error/)
  assert.match(sale, /اختر المحل الحالي من أعلى الصفحة قبل بدء البيع/)
  assert.match(maintenance, /const needsStore = !configuredStoreId/)
  assert.match(maintenance, /اختر المحل الحالي من أعلى الصفحة قبل تسجيل الصيانة/)
  assert.doesNotMatch(customerPayment, /stores\[0\]/)
  assert.match(customerPayment, /اختر المحل الحالي من أعلى الصفحة قبل تسجيل الدفعة/)
  assert.match(app, /readBrowserActiveStoreId\(stores\)/)
})

test('changing the browser store confirms and discards any mounted financial draft', async () => {
  const [app, sale, maintenance, customerPayment] = await Promise.all([
    readFile(clientUrl('src/App.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/MaintenancePage.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/CustomerPaymentPage.tsx'), 'utf8'),
  ])

  assert.match(app, /financialDraftActive/)
  assert.match(app, /window\.confirm\('لديك مسودة مالية غير محفوظة/)
  assert.match(app, /key={configuredStoreId \?\? 'no-store'}/)
  for (const page of [sale, maintenance, customerPayment]) {
    assert.match(page, /onDraftStateChange\(hasUnsavedDraft\)/)
    assert.match(page, /onDraftStateChange\(false\)/)
  }
})

test('sale route uses the implemented selling screen', async () => {
  const app = await readFile(clientUrl('src/App.tsx'), 'utf8')

  assert.match(app, /path="sale"/)
  assert.match(app, /<SalePage configuredStoreId={configuredStoreId}/)
})

test('long PostgreSQL decimal scales are normalized for older users', async () => {
  const [formatter, sale, maintenance, customerPayment, customers] = await Promise.all([
    readFile(clientUrl('src/money-display.ts'), 'utf8'),
    readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/MaintenancePage.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/CustomerPaymentPage.tsx'), 'utf8'),
    readFile(clientUrl('src/pages/CustomersPage.tsx'), 'utf8'),
  ])

  assert.match(formatter, /new DisplayDecimal\(value\)\.toFixed\(\)/)
  assert.match(sale, /formatDecimal\(payload\.sale\.total\)/)
  assert.match(maintenance, /amount_ils: formatDecimal\(record\.amount_ils\)/)
  assert.match(customerPayment, /formatDecimal\(customer\.balance_ils\)/)
  assert.match(customers, /formatDecimal\(item\.total\)/)
})
