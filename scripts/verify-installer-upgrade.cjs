const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { Client } = require('pg')
const { prepareTrial } = require('../electron/trial-runtime.cjs')

const root = path.resolve(__dirname, '..')
const testRoot = path.join(root, 'tmp', 'installer-upgrade-check-real')
const installDir = path.join(testRoot, 'Installed Trial')
const localAppData = path.join(testRoot, 'LocalAppData')
const dataRoot = path.join(localAppData, 'ElectricityAccountantTrial')
const setupA = path.join(root, 'tmp', 'installer-version-a-output', 'Electricity-Accountant-Trial-Setup.exe')
const setupB = path.join(root, 'release', 'installer', 'Electricity-Accountant-Trial-Setup.exe')

function run(file, args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited with ${code}`))
    })
  })
}

async function api(port, pathname, { method = 'GET', token, storeId, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(storeId ? { 'X-Store-Id': storeId } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(!['GET', 'HEAD'].includes(method) ? { 'X-Request-Id': randomBytes(16).toString('hex') } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const payload = await response.json()
  assert.ok(response.ok, `${method} ${pathname}: ${response.status} ${payload?.error?.code ?? ''}`)
  return payload
}

async function database(config, sql, values = []) {
  const client = new Client({
    host: '127.0.0.1', port: config.databasePort, user: 'trial_owner',
    password: config.databasePassword, database: 'electricity_accountant', ssl: false,
  })
  await client.connect()
  try { return await client.query(sql, values) } finally { await client.end() }
}

async function startup() {
  process.resourcesPath = path.join(installDir, 'resources')
  await prepareTrial({ isPackaged: true, trialNodeExecutable: path.join(installDir, 'ElectricityAccountant.exe') })
  return JSON.parse(await fs.readFile(path.join(dataRoot, 'config', 'runtime.json'), 'utf8'))
}

async function verifyRecords(config, ids) {
  const login = await api(config.backendPort, '/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'admin' },
  })
  const token = login.token
  const products = await api(config.backendPort, '/products', { token })
  assert.ok(products.products.some((item) => item.id === ids.productId))
  const customers = await api(config.backendPort, '/customers', { token, storeId: ids.storeId })
  assert.ok(customers.customers.some((item) => item.id === ids.customerId))
  const savedSale = await api(config.backendPort, `/sales/${ids.saleId}`, { token, storeId: ids.storeId })
  assert.equal(Number(savedSale.sale.remaining_due), 40)
  const balance = await database(config, `
    SELECT
      (SELECT quantity::TEXT FROM store_inventory_balances
       WHERE store_id = $1::BIGINT AND product_id = $2::BIGINT) AS stock,
      (SELECT balance_ils::TEXT FROM customer_balances
       WHERE customer_id = $3::BIGINT) AS balance
  `, [ids.storeId, ids.productId, ids.customerId])
  assert.equal(Number(balance.rows[0].stock), 8)
  assert.equal(Number(balance.rows[0].balance), 40)
  const verification = await api(config.backendPort, '/verification/financial', { token })
  assert.equal(verification.status, 'ok')
  assert.equal(verification.sections.reduce((sum, section) => sum + section.issueCount, 0), 0)
}

async function stopServices() {
  let config
  try { config = JSON.parse(await fs.readFile(path.join(dataRoot, 'config', 'runtime.json'), 'utf8')) } catch { return }
  try {
    await fetch(`http://127.0.0.1:${config.backendPort}/api/health/trial-shutdown`, {
      method: 'POST', headers: { 'X-Trial-Runtime-Token': config.runtimeToken },
    })
  } catch { /* The installer may already have stopped the old backend. */ }
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const pgCtl = path.join(installDir, 'resources', 'windows-x64', 'bin', 'pg_ctl.exe')
  try { await run(pgCtl, ['-D', path.join(dataRoot, 'postgres-data'), '-m', 'fast', 'stop'], 30_000) } catch { /* Already stopped. */ }
}

async function waitForProgramRemoval() {
  const executable = path.join(installDir, 'ElectricityAccountant.exe')
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await fs.access(executable)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('The uninstaller did not remove program binaries.')
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  assert.equal(path.dirname(testRoot), path.join(root, 'tmp'))
  await fs.access(setupA)
  await fs.access(setupB)
  await fs.rm(testRoot, { recursive: true, force: true })
  await fs.mkdir(localAppData, { recursive: true })
  process.env.LOCALAPPDATA = localAppData
  try {
    await run(setupA, ['/S', '/currentuser', `/D=${installDir}`])
    await fs.access(path.join(installDir, 'ElectricityAccountant.exe'))
    const configA = await startup()
    const oldMigration = await database(configA,
      "SELECT 1 FROM schema_migrations WHERE name = '0029_custom_expense_categories.sql'")
    assert.equal(oldMigration.rowCount, 0)
    const login = await api(configA.backendPort, '/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin' },
    })
    const token = login.token
    const stores = await api(configA.backendPort, '/stores', { token })
    const storeId = stores.stores[0].id
    const category = await api(configA.backendPort, '/categories', {
      method: 'POST', token, body: { name: 'Installer upgrade category' },
    })
    const product = await api(configA.backendPort, '/products', {
      method: 'POST', token,
      body: {
        name: 'Installer upgrade product', categoryId: category.category.id,
        saleUnit: 'قطعة', currentPurchasePrice: '10', defaultSalePrice: '30',
        inventorySettings: [{ storeId, reorderLevel: '1', openingQuantity: '10' }],
      },
    })
    const customer = await api(configA.backendPort, '/customers', {
      method: 'POST', token, storeId, body: { name: 'Installer upgrade customer' },
    })
    const sale = await api(configA.backendPort, '/sales', {
      method: 'POST', token, storeId,
      body: {
        invoiceNumber: 'INSTALLER-UPGRADE-SALE', date: '2026-09-25',
        customerId: customer.customer.id, invoiceDiscount: '0',
        items: [{ productId: product.product.id, quantity: '2', actualPrice: '30', discount: '0' }],
        payments: [{ method: 'cash', currency: 'ILS', amount: '20' }],
      },
    })
    const ids = { storeId, productId: product.product.id,
      customerId: customer.customer.id, saleId: sale.sale.id }
    await verifyRecords(configA, ids)
    console.log('Version A installed and sale verified.')

    await run(setupB, ['/S', '/currentuser', `/D=${installDir}`])
    const configB = await startup()
    assert.equal(configB.databasePassword, configA.databasePassword)
    assert.equal(configB.runtimeToken, configA.runtimeToken)
    const newMigration = await database(configB,
      "SELECT 1 FROM schema_migrations WHERE name = '0029_custom_expense_categories.sql'")
    assert.equal(newMigration.rowCount, 1)
    await verifyRecords(configB, ids)
    console.log('Version B upgraded the same database; migration 0029 and financial checks passed.')

    await stopServices()
    const uninstaller = path.join(installDir, 'Uninstall ElectricityAccountant.exe')
    await fs.access(uninstaller)
    await run(uninstaller, ['/S'])
    await waitForProgramRemoval()
    await fs.access(path.join(dataRoot, 'postgres-data', 'PG_VERSION'))
    await run(setupB, ['/S', '/currentuser', `/D=${installDir}`])
    const configReinstalled = await startup()
    assert.equal(configReinstalled.databasePassword, configA.databasePassword)
    await verifyRecords(configReinstalled, ids)
    console.log('Uninstall preserved data; reinstall retained login, records, stock and balances.')
    await stopServices()
    await run(uninstaller, ['/S'])
    await waitForProgramRemoval()
    await fs.access(path.join(dataRoot, 'postgres-data', 'PG_VERSION'))
    console.log('Final test uninstall removed program binaries and preserved trial data.')
  } finally {
    await stopServices()
  }
}

main().catch((error) => {
  console.error('Installer upgrade verification failed:', error.message)
  process.exitCode = 1
})
