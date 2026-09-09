import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientUrl = (path) => new URL(`../../client/${path}`, import.meta.url)

test('Group 4 screens translate stored status and payment codes to Arabic', async () => {
  const labels = await readFile(clientUrl('src/business-labels.ts'), 'utf8')
  const customers = await readFile(clientUrl('src/pages/CustomersPage.tsx'), 'utf8')
  const suppliers = await readFile(clientUrl('src/pages/SuppliersPage.tsx'), 'utf8')

  assert.match(labels, /recorded: 'مسجّلة'/)
  assert.match(labels, /pending: 'قيد الانتظار'/)
  assert.match(labels, /cash: 'نقداً'/)
  assert.match(labels, /bank_transfer: 'تحويل بنكي'/)
  assert.match(customers, /customerCheckStatusLabel\(item\.status\)/)
  assert.match(customers, /paymentMethodLabel\(item\.payment_method\)/)
  assert.match(suppliers, /statusLabel\(item\.status\)/)
  assert.match(suppliers, /paymentMethodLabel\(item\.payment_method\)/)
})

test('Group 4 dialogs have accessible names and keyboard dismissal', async () => {
  for (const path of ['src/pages/CustomersPage.tsx', 'src/pages/SuppliersPage.tsx']) {
    const page = await readFile(clientUrl(path), 'utf8')
    assert.match(page, /aria-label={title}/)
    assert.match(page, /event\.key === 'Escape'/)
    assert.match(page, /removeEventListener\('keydown', closeOnEscape\)/)
  }
})

test('customer and supplier statements have independent printable regions', async () => {
  const styles = await readFile(clientUrl('src/styles.css'), 'utf8')
  assert.match(styles, /\.customer-statement/)
  assert.match(styles, /\.supplier-statement/)
  assert.match(styles, /@media print/)
})

test('Group 4 screens expose one ILS balance and default activity to all stores', async () => {
  const customers = await readFile(clientUrl('src/pages/CustomersPage.tsx'), 'utf8')
  const suppliers = await readFile(clientUrl('src/pages/SuppliersPage.tsx'), 'utf8')

  for (const page of [customers, suppliers]) {
    assert.match(page, /balance_ils/)
    assert.match(page, /store_balances/)
    assert.match(page, /<option value="">كل المحلات<\/option>/)
    assert.match(page, /₪/)
    assert.doesNotMatch(page, /BalanceBadges/)
    assert.doesNotMatch(page, /type Balance = \{ currency_code/)
  }

  assert.match(customers, /يعادل ₪\$\{formatDecimal\(item\.converted_ils_amount\)\}/)
  assert.match(suppliers, /يعادل ₪\$\{item\.converted_ils_amount\}/)
})
