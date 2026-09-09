import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientFile = (path) => new URL(`../../client/${path}`, import.meta.url)

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

test('web manifest provides an installable Arabic standalone application', async () => {
  const manifest = JSON.parse(await readFile(clientFile('public/manifest.webmanifest'), 'utf8'))
  assert.equal(manifest.lang, 'ar')
  assert.equal(manifest.dir, 'rtl')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.start_url, './')
  assert.ok(manifest.name)
  assert.ok(manifest.short_name)
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.type === 'image/png'))
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.type === 'image/png'))

  const [smallIcon, largeIcon] = await Promise.all([
    readFile(clientFile('public/icons/app-icon-192.png')),
    readFile(clientFile('public/icons/app-icon-512.png')),
  ])
  assert.deepEqual(pngDimensions(smallIcon), { width: 192, height: 192 })
  assert.deepEqual(pngDimensions(largeIcon), { width: 512, height: 512 })
})

test('service worker caches only the application shell and never handles financial writes', async () => {
  const [serviceWorker, entrypoint, html, vite] = await Promise.all([
    readFile(clientFile('public/sw.js'), 'utf8'),
    readFile(clientFile('src/main.tsx'), 'utf8'),
    readFile(clientFile('index.html'), 'utf8'),
    readFile(clientFile('vite.config.ts'), 'utf8'),
  ])
  assert.match(serviceWorker, /request\.method !== 'GET'/)
  assert.match(serviceWorker, /url\.pathname\.startsWith\('\/api\/'\)/)
  assert.match(serviceWorker, /request\.mode === 'navigate'/)
  assert.match(entrypoint, /import\.meta\.env\.PROD && !window\.desktop/)
  assert.match(entrypoint, /serviceWorker\.register\('\/sw\.js'\)/)
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/)
  assert.match(vite, /base: '\/'/)
})

test('mobile bottom navigation has the required visual order and emphasized finance center', async () => {
  const shell = await readFile(clientFile('src/components/AppShell.tsx'), 'utf8')
  const navigation = shell.slice(shell.indexOf('const mobileNavigation'), shell.indexOf('function activeSection'))
  const labels = ['المنتجات', 'العملاء', 'المالية', 'الموردون', 'الرئيسية']
  for (let index = 1; index < labels.length; index += 1) {
    assert.ok(navigation.indexOf(labels[index - 1]) < navigation.indexOf(labels[index]))
  }
  assert.match(shell, /className="mobile-bottom-nav[^\n]+sm:hidden" dir="ltr"/)
  assert.match(navigation, /label: 'المالية'.+emphasized: true/)
  assert.match(shell, /-mt-5 min-h-18 bg-teal-700/)
})

test('mobile sections stay focused while desktop home actions remain available', async () => {
  const [finance, products, customers, suppliers, home] = await Promise.all([
    readFile(clientFile('src/pages/MobileFinancePage.tsx'), 'utf8'),
    readFile(clientFile('src/pages/ProductsPage.tsx'), 'utf8'),
    readFile(clientFile('src/pages/CustomersPage.tsx'), 'utf8'),
    readFile(clientFile('src/pages/SuppliersPage.tsx'), 'utf8'),
    readFile(clientFile('src/pages/HomePage.tsx'), 'utf8'),
  ])
  for (const label of ['المبيعات', 'المشتريات', 'الشيكات', 'المصاريف', 'الأرباح', 'حركة الأموال']) {
    assert.match(finance, new RegExp(label))
  }
  assert.match(products, /بحث بالاسم/)
  assert.match(products, /مخزون منخفض/)
  assert.match(customers, /الرصيد الحالي/)
  assert.match(customers, /المشاريع/)
  assert.match(customers, /أحدث حركات الحساب/)
  assert.match(customers, /كشف حساب عميل/)
  assert.match(suppliers, /المشتريات/)
  assert.match(suppliers, /الدفعات/)
  assert.match(suppliers, /كشف حساب مورد/)
  assert.match(home, /hidden grid-cols-2 gap-4 sm:grid/)
  assert.match(home, /recent_activity/)
})

test('sale lines become stacked mobile cards and offline state disables financial operations', async () => {
  const [sale, styles, api, shell, finance] = await Promise.all([
    readFile(clientFile('src/pages/SalePage.tsx'), 'utf8'),
    readFile(clientFile('src/styles.css'), 'utf8'),
    readFile(clientFile('src/api.ts'), 'utf8'),
    readFile(clientFile('src/components/AppShell.tsx'), 'utf8'),
    readFile(clientFile('src/pages/MobileFinancePage.tsx'), 'utf8'),
  ])
  assert.match(sale, /sale-lines-table/)
  assert.match(sale, /data-mobile-label="الصنف"/)
  assert.match(sale, /data-mobile-label="الإجمالي"/)
  assert.match(styles, /@media \(max-width: 767px\)/)
  assert.match(styles, /\.sale-lines-table tr[\s\S]+display: block/)
  assert.match(api, /isMutation\(init\) && !serverReachable/)
  assert.match(api, /!navigator\.onLine/)
  assert.match(shell, /inert={financialRouteLocked}/)
  assert.match(shell, /العمليات المالية متوقفة حتى عودة الاتصال/)
  assert.match(finance, /aria-disabled={disabled}/)
  assert.match(finance, /pointer-events-none opacity-45/)
})
