const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const documentKind = process.env.GROUP8_QA_DOCUMENT || 'customer-statement'
const invoiceSize = process.env.GROUP8_QA_SIZE || 'A4'
const sessionToken = process.env.GROUP8_QA_TOKEN || 'group8-qa-token'
const customerId = process.env.GROUP8_QA_CUSTOMER_ID || '11'
const supplierId = process.env.GROUP8_QA_SUPPLIER_ID || '11'
const invoiceNumber = process.env.GROUP8_QA_INVOICE_NUMBER || `QA-PDF-${invoiceSize}`
const productSearch = process.env.GROUP8_QA_PRODUCT_SEARCH || 'كابل'
const statementKind = documentKind === 'supplier-statement' ? 'supplier' : 'customer'
const targetUrl = process.env.GROUP8_QA_URL
  || (documentKind === 'invoice'
    ? 'http://localhost:39002/sale'
    : `http://localhost:39002/${statementKind === 'supplier' ? 'suppliers' : 'customers'}/${statementKind === 'supplier' ? supplierId : customerId}`)
const outputPath = path.resolve(
  process.env.GROUP8_QA_PDF
    || (documentKind === 'invoice'
      ? `tmp/group8-invoice-${invoiceSize.toLowerCase()}-qa.pdf`
      : `output/pdf/group8-${statementKind}-statement-qa.pdf`),
)

app.disableHardwareAcceleration()

async function waitFor(window, expression, timeoutMs = 15_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

app.whenReady().then(async () => {
  let resolvePdfSaved
  const pdfSaved = new Promise((resolve) => { resolvePdfSaved = resolve })
  ipcMain.handle('app:get-versions', () => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }))
  ipcMain.handle('device:get-store-assignment', () => ({ storeId: '1' }))
  ipcMain.handle('device:set-store-assignment', (_event, storeId) => ({ storeId }))
  ipcMain.handle('app:show-notification', () => ({ shown: false }))
  ipcMain.handle('app:save-pdf-data', async (_event, options) => {
    const bytes = options?.data
    const data = ArrayBuffer.isView(bytes)
      ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes instanceof ArrayBuffer ? Buffer.from(bytes) : null
    if (!data || data.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('Invalid generated PDF data')
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, data)
    resolvePdfSaved(data.length)
    return { saved: true, canceled: false, path: outputPath }
  })
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.resolve('electron/preload.cjs'),
      sandbox: true,
    },
  })
  let phase = 'load'
  try {
    await window.loadURL(targetUrl)
    phase = 'authenticate'
    await window.webContents.executeJavaScript(`
      sessionStorage.setItem('electricity-accountant-session', ${JSON.stringify(sessionToken)});
      localStorage.setItem('electricity-accountant-user', JSON.stringify({
        id: '1', username: 'qa-admin', displayName: 'مدير الاختبار', role: 'admin'
      }));
    `)
    await window.webContents.reload()
    if (documentKind === 'invoice') {
      phase = 'prepare invoice'
      await waitFor(window, "document.querySelector('#sale-invoice-number') && document.querySelector('#sale-product-search')")
      await window.webContents.executeJavaScript(`
        function setValue(selector, value) {
          const element = document.querySelector(selector);
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(element, value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }
        setValue('#sale-invoice-number', ${JSON.stringify(invoiceNumber)});
        setValue('#sale-product-search', ${JSON.stringify(productSearch)});
      `)
      await waitFor(window, "[...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'إضافة')")
      phase = 'add invoice product and customer'
      await window.webContents.executeJavaScript(`
        [...document.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === 'إضافة')
          .click();
        const customer = document.querySelector('#sale-customer');
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(customer, ${JSON.stringify(customerId)});
        customer.dispatchEvent(new Event('change', { bubbles: true }));
      `)
      await waitFor(window, "[...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'إتمام البيع وحفظه' && !button.disabled)")
      phase = 'save invoice'
      await window.webContents.executeJavaScript(`
        [...document.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === 'إتمام البيع وحفظه')
          .click();
      `)
      await waitFor(window, "document.querySelector('[aria-label=\"إخراج الفاتورة\"] .print-document')")
      phase = 'select invoice size'
      await window.webContents.executeJavaScript(`
        const size = document.querySelector('[aria-label="إخراج الفاتورة"] select');
        const sizeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        sizeSetter.call(size, ${JSON.stringify(invoiceSize)});
        size.dispatchEvent(new Event('change', { bubbles: true }));
      `)
    } else {
      phase = 'open statement'
      const statementLabel = statementKind === 'supplier' ? 'كشف حساب مورد' : 'كشف حساب عميل'
      await waitFor(window, `[...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === ${JSON.stringify(statementLabel)})`)
      await window.webContents.executeJavaScript(`
        [...document.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === ${JSON.stringify(statementLabel)})
          .click();
      `)
      await waitFor(window, "document.querySelector('.print-document')")
    }
    phase = 'generate PDF'
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === 'PDF')
        .click();
    `)
    const pdfLength = await Promise.race([
      pdfSaved,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out saving generated PDF')), 30_000)),
    ])
    console.log(`Wrote ${outputPath} (${pdfLength} bytes)`)
  } catch (error) {
    console.error(`QA failed during: ${phase}`)
    console.error(error)
    process.exitCode = 1
  } finally {
    window.destroy()
    app.exit(process.exitCode ?? 0)
  }
})
