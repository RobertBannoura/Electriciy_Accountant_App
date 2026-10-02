import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientUrl = (path) => new URL(`../../client/${path}`, import.meta.url)

test('products page uses the reusable scanner hook for barcode lookup', async () => {
  const page = await readFile(clientUrl('src/pages/ProductsPage.tsx'), 'utf8')
  const hook = await readFile(clientUrl('src/hooks/useBarcodeScanner.ts'), 'utf8')

  assert.match(page, /useBarcodeScanner\(\{/)
  assert.match(page, /\/products\?barcode=/)
  assert.match(page, /setEditingProduct\(product\)/)
  assert.match(hook, /window\.addEventListener\('keydown', handleKeyDown\)/)
  assert.match(hook, /event\.key === 'Enter'/)
  assert.match(hook, /now - lastKeyAt <= maxInterKeyDelayMs/)
})

test('products page exposes catalog filters and showroom-only inventory controls', async () => {
  const page = await readFile(clientUrl('src/pages/ProductsPage.tsx'), 'utf8')

  for (const label of [
    'بحث بالاسم',
    'بحث بالباركود',
    'كل التصنيفات',
    'كل المتاجر',
    'مخزون منخفض',
    'حركة المخزون',
  ]) {
    assert.match(page, new RegExp(label))
  }
  assert.match(page, /store\.code === 'SHOWROOM'/)
  assert.match(page, /inventory\.store_id === showroomStoreId/)
  assert.match(page, /storeFilter === showroomStoreId/)
})

test('generated EAN-13 barcodes have a preview and generic print action', async () => {
  const page = await readFile(clientUrl('src/pages/ProductsPage.tsx'), 'utf8')
  const preview = await readFile(clientUrl('src/components/BarcodePreview.tsx'), 'utf8')
  const styles = await readFile(clientUrl('src/styles.css'), 'utf8')

  assert.match(page, /إنشاء باركود/)
  assert.match(page, /window\.print\(\)/)
  assert.match(preview, /isValidEan13\(barcode\)/)
  assert.match(preview, /role="img"/)
  assert.match(styles, /@media print/)
  assert.match(styles, /\.barcode-print-area/)
})
