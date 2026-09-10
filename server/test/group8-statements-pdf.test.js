import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'
import { parseStatementRange } from '../src/statements/statement-input.js'

test('statement date ranges default safely and reject invalid calendar ranges', () => {
  assert.deepEqual(parseStatementRange({}, '2026-09-09'), {
    value: { from: '2026-01-01', to: '2026-09-09' },
  })
  assert.deepEqual(
    parseStatementRange({ from: '2026-08-01', to: '2026-08-31' }, '2026-09-09'),
    { value: { from: '2026-08-01', to: '2026-08-31' } },
  )
  assert.match(parseStatementRange({ from: '2026-02-30', to: '2026-03-01' }).error, /فترة/)
  assert.match(parseStatementRange({ from: '2026-09-10', to: '2026-09-09' }).error, /بداية/)
})

test('account statements derive opening and running balances from append-only ledgers', async () => {
  const service = await readFile(new URL('../src/statements/account-statements.js', import.meta.url), 'utf8')
  assert.match(service, /FROM customer_ledger AS ledger/)
  assert.match(service, /FROM supplier_ledger AS ledger/)
  assert.match(service, /statement_date < \$2::DATE/)
  assert.match(service, /ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW/)
  assert.match(service, /contextual_sale\.customer_project_id = \$5/)
  assert.match(service, /customer_returns/)
  assert.match(service, /supplier_returns/)
  assert.match(service, /purchase_items/)
  assert.match(service, /'unit_price', items\.unit_cost::TEXT/)
  assert.match(service, /AT TIME ZONE 'Asia\/Hebron'/)
})

test('customer and supplier statement routes validate party, store, and project scope', async () => {
  const [customers, suppliers] = await Promise.all([
    readFile(new URL('../src/routes/customers.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/suppliers.js', import.meta.url), 'utf8'),
  ])
  assert.match(customers, /get\('\/:customerId\/statement'/)
  assert.match(customers, /CUSTOMER_PROJECT_NOT_FOUND/)
  assert.match(customers, /requireActiveActivityStore/)
  assert.match(suppliers, /get\('\/:supplierId\/statement'/)
  assert.match(suppliers, /SUPPLIER_NOT_FOUND/)
  assert.match(suppliers, /requireActiveActivityStore/)
})

test('statement and invoice documents expose Arabic print and PDF output without rasterization', async () => {
  const [statement, invoice, actions, output, pdfDocuments, styles, electron, platformSecurity, preload, html] = await Promise.all([
    readFile(new URL('../../client/src/components/AccountStatementDialog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/components/InvoiceOutput.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/components/DocumentOutputActions.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/print-output.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pdf-documents.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/platform-security.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/preload.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../../client/index.html', import.meta.url), 'utf8'),
  ])
  for (const label of ['كشف حساب عميل', 'كشف حساب مورد', 'الرصيد الافتتاحي', 'الرصيد الختامي']) {
    assert.match(statement, new RegExp(label))
  }
  for (const label of ['طباعة', 'PDF', '80mm', 'A4']) assert.match(`${actions}\n${invoice}`, new RegExp(label))
  assert.match(statement, /purchase_items/)
  assert.match(statement, /running_balance/)
  assert.match(output, /document\.fonts\.ready/)
  assert.match(output, /window\.print\(\)/)
  assert.match(actions, /createPdf/)
  assert.match(actions, /savePdfBlob/)
  assert.match(pdfDocuments, /@react-pdf\/renderer/)
  assert.match(pdfDocuments, /createStatementPdf/)
  assert.match(pdfDocuments, /createInvoicePdf/)
  assert.match(pdfDocuments, /Amiri-Regular\.ttf/)
  assert.match(pdfDocuments, /direction: 'rtl'/)
  assert.match(electron, /printToPDF/)
  assert.match(electron, /generateTaggedPDF: true/)
  assert.match(electron, /preferCSSPageSize: true/)
  assert.match(electron, /app:save-pdf-data/)
  assert.match(platformSecurity, /%PDF-/)
  assert.match(preload, /savePdfData/)
  assert.match(html, /script-src 'self' 'wasm-unsafe-eval'/)
  assert.match(styles, /NotoSansArabic-Variable\.ttf/)
  assert.match(styles, /size: A4 portrait/)
  assert.match(styles, /size: 80mm 200mm/)
  assert.match(styles, /table-header-group/)
  assert.match(styles, /break-inside: avoid/)
  assert.doesNotMatch(`${statement}\n${invoice}\n${output}`, /canvas|html2canvas|toDataURL/i)
})

test('the project bundles a licensed Arabic-capable font', async () => {
  const [font, boldFont] = await Promise.all([
    stat(new URL('../../client/src/assets/fonts/Amiri-Regular.ttf', import.meta.url)),
    stat(new URL('../../client/src/assets/fonts/Amiri-Bold.ttf', import.meta.url)),
  ])
  const license = await readFile(new URL('../../client/src/assets/fonts/OFL.txt', import.meta.url), 'utf8')
  assert.ok(font.size > 100_000)
  assert.ok(boldFont.size > 100_000)
  assert.match(license, /SIL OPEN FONT LICENSE/i)
})
