import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientUrl = (path) => new URL(`../../client/${path}`, import.meta.url)

test('selling screen exposes barcode and name search with inline line editing', async () => {
  const page = await readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8')

  assert.match(page, /useBarcodeScanner/)
  assert.match(page, /onKeyDown=\{\(event\) => \{/)
  assert.match(page, /event\.stopPropagation\(\)/)
  assert.match(page, /addScannedProduct\(term\)/)
  assert.match(page, /امسح الباركود أو اكتب اسم الصنف/)
  assert.match(page, /actualSalePrice/)
  assert.match(page, /originalPrice/)
  assert.match(page, /القطعة تقبل عدداً صحيحاً فقط/)
  assert.match(page, /saleUnit === 'قطعة'/)
  assert.match(page, /خصم على كامل الفاتورة/)
  assert.match(page, /إتمام البيع/)
  assert.match(page, /disabled={!canSave}/)
  assert.doesNotMatch(page, /\+ سطر يدوي/)
  assert.match(page, /aria-label="سطر يدوي جديد"/)
  assert.match(page, /sale-manual-draft-row sticky top-\[61px\]/)
  assert.match(page, /commitManualLine/)
  assert.match(page, /سطر جديد جاهز — لا يؤثر على المخزون/)
  assert.doesNotMatch(page, /sale-empty-row/)
  assert.match(page, /اسم الصنف اليدوي/)
  assert.match(page, /بند يدوي — لا يؤثر على المخزون/)
  assert.match(page, /productId: null, description: line\.productName\.trim\(\)/)
  assert.match(page, /manual:\$\{crypto\.randomUUID\(\)\}/)
})

test('selling screen generates invoice numbers and provides searchable customer selection', async () => {
  const page = await readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8')

  assert.match(page, /يُنشأ تلقائياً عند الحفظ/)
  assert.doesNotMatch(page, /invoiceNumber: invoiceNumber\.trim\(\)/)
  assert.doesNotMatch(page, /id="sale-invoice-number"/)
  assert.match(page, /placeholder=.*ابحث باسم العميل أو رقم الهاتف/)
  assert.match(page, /aria-autocomplete="list"/)
  assert.match(page, /customer\.phone\?\.toLocaleLowerCase\('ar'\)\.includes\(term\)/)
})

test('selling screen keeps live totals on the left and item lines in a compact scroll area', async () => {
  const page = await readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8')

  assert.match(page, /min-\[1150px\]:grid-cols-\[20rem_minmax\(0,1fr\)\]/)
  assert.match(page, /aria-label="ملخص الفاتورة المباشر"/)
  assert.match(page, /aria-live="polite"/)
  assert.match(page, /min-\[1150px\]:sticky min-\[1150px\]:top-4 min-\[1150px\]:order-1/)
  assert.match(page, /max-h-\[46vh\].*overflow-y-auto overflow-x-hidden/)
  assert.match(page, /sticky top-0 z-10/)
  assert.match(page, /sale-lines-table w-full min-w-0 table-fixed/)
  assert.doesNotMatch(page, /md:min-w-\[950px\]/)
  assert.equal(page.match(/<span>مجموع السطور<\/span>/g)?.length, 1)
  assert.equal(page.match(/id="invoice-discount"/g)?.length, 1)
})

test('sale route can use the available desktop width without widening other screens', async () => {
  const shell = await readFile(clientUrl('src/components/AppShell.tsx'), 'utf8')

  assert.match(shell, /location\.pathname === '\/sale' \? 'max-w-\[78rem\]' : 'max-w-6xl'/)
})

test('payment methods open as a dedicated second checkout step', async () => {
  const page = await readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8')

  assert.match(page, /useState<'items' \| 'payment'>\('items'\)/)
  assert.match(page, /step === 'items' \? 'الخطوة 1 من 2' : 'الخطوة 2 من 2'/)
  assert.match(page, /disabled={!canContinueToPayment}/)
  assert.match(page, /onClick={continueToPayment}/)
  assert.match(page, /newPayment\('cash', businessDate\), amount: finalTotal\?\.toFixed\(\)/)
  assert.match(page, /متابعة إلى الدفع/)
  assert.match(page, /العودة إلى الأصناف/)
  assert.match(page, /enabled: !needsStore && step === 'items'/)
  assert.match(page, /aria-label="ملخص الدفع المباشر"/)
  assert.match(page, /aria-label="إضافة طريقة دفع"/)
  assert.match(page, /grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5/)
  assert.match(page, /شيكل \/ دولار \/ دينار/)
  assert.match(page, /مع مرجع اختياري/)
  assert.match(page, /رقم وتاريخ استحقاق/)
  assert.match(page, /بيانات صاحب الشيك/)
  assert.match(page, /الدفع لاحقاً/)
  assert.match(page, /يُسجّل ديناً على العميل/)
  assert.match(page, /setPayments\(\[\]\)/)
  assert.match(page, /setPayLater\(true\)/)
})

test('selling screen uses decimal arithmetic and saves through the configured Electron store', async () => {
  const page = await readFile(clientUrl('src/pages/SalePage.tsx'), 'utf8')

  assert.match(page, /from 'decimal\.js'/)
  assert.match(page, /quantity\.mul\(price\)/)
  assert.doesNotMatch(page, /Math\.round|parseFloat|parseInt/)
  assert.match(page, /saleApiFetch\('\/sales'/)
  assert.match(page, /بطاقة \/ بنك/)
  assert.match(page, /سعر الصرف اليدوي/)
  assert.match(page, /ويظهر غير المدفوع ديناً/)
})

test('purchase screen supports Enter for scanner and single-result product lookup', async () => {
  const page = await readFile(clientUrl('src/pages/PurchasePage.tsx'), 'utf8')

  assert.match(page, /onKeyDown=\{\(event\) => \{/)
  assert.match(page, /exactBarcodeMatch/)
  assert.match(page, /event\.stopPropagation\(\)/)
  assert.match(page, /scanBarcode\(term\)/)
  assert.match(page, /اسم صنف الشراء اليدوي الجديد/)
  assert.match(page, /manual-purchase:\$\{crypto\.randomUUID\(\)\}/)
})

test('product dialogs close with Escape for keyboard-only desktop operation', async () => {
  const page = await readFile(clientUrl('src/pages/ProductsPage.tsx'), 'utf8')

  assert.match(page, /if \(event\.key === 'Escape'\) onClose\(\)/)
  assert.match(page, /window\.addEventListener\('keydown', closeOnEscape\)/)
  assert.match(page, /window\.removeEventListener\('keydown', closeOnEscape\)/)
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
  assert.match(formatter, /toDecimalPlaces\(2\)\.toFixed\(\)/)
  assert.match(formatter, /toNearest\('0\.5', DisplayDecimal\.ROUND_HALF_UP\)/)
  assert.match(formatter, /formatMoney\(value\)/)
  assert.match(sale, /formatDecimal\(payload\.sale\.total\)/)
  assert.match(maintenance, /amount_ils: formatDecimal\(record\.amount_ils\)/)
  assert.match(customerPayment, /formatDecimal\(customer\.balance_ils\)/)
  assert.match(customers, /formatDecimal\(item\.total\)/)
  assert.match(customers, /formatHalfShekel\(amount\)/)
  assert.match(customers, /grid-cols-\[minmax\(0,1fr\)_auto\]/)
})
