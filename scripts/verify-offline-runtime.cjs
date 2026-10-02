const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { spawn } = require('node:child_process')
const { prepareTrial, stopTrial } = require('../electron/trial-runtime.cjs')
const { createDeviceSettingsStore } = require('../electron/device-settings.cjs')
const { Client } = require('pg')

const projectRoot = path.resolve(__dirname, '..')
const packaged = process.argv.includes('--packaged-resources')
const fullCoverage = process.argv.includes('--coverage')
const testLocalAppData = path.join(projectRoot, 'tmp',
  packaged ? 'offline-packaged-integration' : 'offline-trial-integration')
const dataRoot = path.join(testLocalAppData, 'ElectricityAccountantTrial')

function call(port, token, method, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method, path: pathname,
      headers: { 'X-Trial-Runtime-Token': token }, timeout: 5000 }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.once('error', reject)
    request.once('timeout', () => request.destroy(new Error('Timed out')))
    request.end()
  })
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)))
  })
}

async function runCoverage(config) {
  const connection = `postgresql://trial_owner:${config.databasePassword}@127.0.0.1:${config.databasePort}/electricity_accountant`
  const integrationVariables = [
    'GROUP4_INTEGRATION_DATABASE_URL', 'GROUP5_INTEGRATION_DATABASE_URL',
    'GROUP6_INTEGRATION_DATABASE_URL', 'GROUP7_INTEGRATION_DATABASE_URL',
    'GROUP8_INTEGRATION_DATABASE_URL', 'GROUP9_INTEGRATION_DATABASE_URL',
    'GROUP10_INTEGRATION_DATABASE_URL',
  ]
  const environment = { ...process.env, NODE_ENV: 'test', TRIAL_OFFLINE: '0',
    DATABASE_URL: connection, HOST: '127.0.0.1' }
  for (const key of integrationVariables) environment[key] = connection
  const files = [
    'group4-api.integration.test.js',
    'group5-sale-api.integration.test.js',
    'maintenance-api.integration.test.js',
    'group6-check-lifecycle-api.integration.test.js',
    'group7-api.integration.test.js',
    'group7-supplier-return-cost.integration.test.js',
    'group8-reports.test.js',
    'group8-statements-pdf.test.js',
  ].map((name) => path.join(projectRoot, 'server', 'test', name))
  const outputPath = path.join(testLocalAppData, 'coverage.log')
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ['--test', '--test-concurrency=1', ...files], {
        cwd: projectRoot, env: environment, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, output }))
  })
  await fs.writeFile(outputPath, result.output, 'utf8')
  const summary = result.output.match(/# pass \d+[\s\S]*?# fail \d+/)?.[0] ?? 'No test summary'
  if (result.code !== 0) {
    throw new Error(`Offline feature coverage failed; see ${outputPath}. ${summary}`)
  }
  console.log(`Offline feature coverage passed: ${summary.replace(/\s+/g, ' ')}`)
}

function occupyPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer((socket) => socket.destroy())
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolve(listener))
  })
}

function closeListener(listener) {
  return new Promise((resolve) => listener.close(resolve))
}

async function api(port, pathname, { method = 'GET', token, storeId, body, headers = {} } = {}) {
  const target = new URL(`http://127.0.0.1:${port}/api${pathname}`)
  assert.equal(target.hostname, '127.0.0.1')
  const response = await fetch(target, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(storeId ? { 'X-Store-Id': storeId } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(!['GET', 'HEAD'].includes(method) ? { 'X-Request-Id': randomBytes(16).toString('hex') } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  assert.ok(response.ok, `${method} ${pathname} returned ${response.status}: ${payload?.error?.code ?? ''}`)
  return payload
}

async function verifyBalances(config, storeId, productId, customerId, saleId) {
  const client = new Client({
    host: '127.0.0.1', port: config.databasePort,
    user: 'trial_owner', password: config.databasePassword,
    database: 'electricity_accountant', ssl: false,
  })
  await client.connect()
  try {
    const result = await client.query(`
      SELECT
        (SELECT quantity::TEXT FROM store_inventory_balances
         WHERE store_id = $1::BIGINT AND product_id = $2::BIGINT) AS stock,
        (SELECT balance_ils::TEXT FROM customer_balances
         WHERE customer_id = $3::BIGINT) AS balance,
        (SELECT remaining_due::TEXT FROM sales WHERE id = $4::BIGINT) AS debt
    `, [storeId, productId, customerId, saleId])
    assert.equal(Number(result.rows[0].stock), 8)
    assert.equal(Number(result.rows[0].balance), 40)
    assert.equal(Number(result.rows[0].debt), 40)
  } finally {
    await client.end()
  }
}

async function waitForPortToClose(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const listener = await occupyPortAt(port)
      await closeListener(listener)
      return
    } catch { await new Promise((resolve) => setTimeout(resolve, 250)) }
  }
  throw new Error('Local service did not stop')
}

function occupyPortAt(port) {
  return new Promise((resolve, reject) => {
    const listener = net.createServer((socket) => socket.destroy())
    listener.once('error', reject)
    listener.listen(port, '127.0.0.1', () => resolve(listener))
  })
}

async function assertNoLanBinding(config) {
  const addresses = Object.values(os.networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
  for (const host of [...new Set(addresses)].slice(0, 4)) {
    for (const port of [config.databasePort, config.backendPort]) {
      const connected = await new Promise((resolve) => {
        const socket = net.createConnection({ host, port, timeout: 1000 })
        socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('error', () => resolve(false))
        socket.once('timeout', () => { socket.destroy(); resolve(false) })
      })
      assert.equal(connected, false, `Trial port ${port} is reachable through ${host}`)
    }
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  if (path.dirname(testLocalAppData) !== path.join(projectRoot, 'tmp')) {
    throw new Error('Test path escaped the workspace')
  }
  await fs.rm(testLocalAppData, { recursive: true, force: true })
  await fs.mkdir(testLocalAppData, { recursive: true })
  process.env.LOCALAPPDATA = testLocalAppData
  const app = packaged
    ? {
        isPackaged: true,
        trialNodeExecutable: path.join(projectRoot, 'release', 'ElectricityAccountant-win32-x64', 'ElectricityAccountant.exe'),
      }
    : { isPackaged: false }
  if (packaged) {
    process.resourcesPath = path.join(projectRoot, 'release', 'ElectricityAccountant-win32-x64', 'resources')
  }
  const occupiedDatabase = await occupyPort()
  const occupiedBackend = await occupyPort()
  await fs.mkdir(path.join(dataRoot, 'config'), { recursive: true })
  await fs.writeFile(path.join(dataRoot, 'config', 'runtime.json'), JSON.stringify({
    version: 1,
    databasePassword: randomBytes(32).toString('hex'),
    runtimeToken: randomBytes(32).toString('hex'),
    databasePort: occupiedDatabase.address().port,
    backendPort: occupiedBackend.address().port,
  }))
  let activeTrial = null
  try {
    const first = await prepareTrial(app)
    activeTrial = first
    assert.equal(first.firstRun, true)
    const config = JSON.parse(await fs.readFile(path.join(dataRoot, 'config', 'runtime.json'), 'utf8'))
    assert.notEqual(config.databasePort, occupiedDatabase.address().port)
    assert.notEqual(config.backendPort, occupiedBackend.address().port)
    assert.equal(await call(config.backendPort, config.runtimeToken, 'GET', '/api/health/readiness'), 200)
    await assertNoLanBinding(config)
    const login = await api(config.backendPort, '/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin' },
    })
    const token = login.token
    const stores = await api(config.backendPort, '/stores', { token })
    const storeId = stores.stores[0].id
    const deviceSettings = createDeviceSettingsStore(dataRoot)
    await deviceSettings.setStoreAssignment(storeId)
    const category = await api(config.backendPort, '/categories', {
      method: 'POST', token, body: { name: 'Offline trial persistence category' },
    })
    const product = await api(config.backendPort, '/products', {
      method: 'POST', token, body: {
        name: 'Offline trial persistence product', categoryId: category.category.id,
        saleUnit: 'قطعة', currentPurchasePrice: '10', defaultSalePrice: '30',
        inventorySettings: [{ storeId, reorderLevel: '1', openingQuantity: '10' }],
      },
    })
    const customer = await api(config.backendPort, '/customers', {
      method: 'POST', token, storeId,
      body: { name: 'Offline trial persistence customer' },
    })
    const sale = await api(config.backendPort, '/sales', {
      method: 'POST', token, storeId,
      body: {
        invoiceNumber: 'OFFLINE-TRIAL-PERSISTENCE', date: '2026-09-25',
        customerId: customer.customer.id, invoiceDiscount: '0',
        items: [{ productId: product.product.id, quantity: '2', actualPrice: '30', discount: '0' }],
        payments: [{ method: 'cash', currency: 'ILS', amount: '20' }],
      },
    })
    assert.equal(Number(sale.sale.remaining_due), 40)
    await verifyBalances(config, storeId, product.product.id, customer.customer.id, sale.sale.id)
    await stopTrial(first)
    activeTrial = null
    await waitForPortToClose(config.backendPort)
    const pgCtl = path.join(packaged ? process.resourcesPath : path.join(projectRoot, 'vendor', 'postgresql'),
      'windows-x64', 'bin', 'pg_ctl.exe')
    const reopened = await prepareTrial(app)
    activeTrial = reopened
    assert.equal(reopened.firstRun, false)
    assert.equal(reopened.backendPort, first.backendPort)
    const secondLogin = await api(config.backendPort, '/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin' },
    })
    const secondToken = secondLogin.token
    assert.equal((await createDeviceSettingsStore(dataRoot).getStoreAssignment()).storeId, storeId)
    const categories = await api(config.backendPort, '/categories', { token: secondToken })
    assert.ok(categories.categories.some((row) => row.id === category.category.id))
    const products = await api(config.backendPort, '/products', { token: secondToken })
    assert.ok(products.products.some((row) => row.id === product.product.id))
    const customers = await api(config.backendPort, '/customers', { token: secondToken, storeId })
    assert.ok(customers.customers.some((row) => row.id === customer.customer.id))
    const savedSale = await api(config.backendPort, `/sales/${sale.sale.id}`, { token: secondToken, storeId })
    assert.equal(Number(savedSale.sale.remaining_due), 40)
    await verifyBalances(config, storeId, product.product.id, customer.customer.id, sale.sale.id)
    const verification = await api(config.backendPort, '/verification/financial', { token: secondToken })
    assert.equal(verification.status, 'ok')
    assert.equal(verification.sections.reduce((total, section) => total + section.issueCount, 0), 0)
    const backup = await api(config.backendPort, '/backups/export', { token: secondToken })
    assert.equal(backup.format, 'electricity-accountant-backup')
    const verifiedBackup = await api(config.backendPort, '/backups/verify', {
      method: 'POST', token: secondToken, body: backup,
    })
    assert.equal(verifiedBackup.backup.schemaVersion, backup.schemaVersion)
    await api(config.backendPort, '/backups/restore', {
      method: 'POST', token: secondToken, body: backup,
      headers: { 'X-Confirm-Restore': 'restore-both-stores' },
    })
    await verifyBalances(config, storeId, product.product.id, customer.customer.id, sale.sale.id)
    const afterRestore = await api(config.backendPort, '/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin' },
    })
    const afterRestoreVerification = await api(config.backendPort, '/verification/financial', {
      token: afterRestore.token,
    })
    assert.equal(afterRestoreVerification.status, 'ok')
    await run(pgCtl, ['-D', path.join(dataRoot, 'postgres-data'), '-m', 'immediate', 'stop'])
    const recovered = await prepareTrial(app)
    activeTrial = recovered
    assert.equal(recovered.backendPort, first.backendPort)
    assert.equal(await call(config.backendPort, config.runtimeToken, 'GET', '/api/health/readiness'), 200)
    if (fullCoverage) await runCoverage(config)
    console.log('Offline trial passed: admin login, local store assignment, category/product/customer/sale persistence, stock/debt, financial verification, backup restore, port recovery.')
  } finally {
    await closeListener(occupiedDatabase)
    await closeListener(occupiedBackend)
    await stopTrial(activeTrial).catch(() => {})
    try {
      const config = JSON.parse(await fs.readFile(path.join(dataRoot, 'config', 'runtime.json'), 'utf8'))
      await call(config.backendPort, config.runtimeToken, 'POST', '/api/health/trial-shutdown').catch(() => {})
      await run(path.join(packaged ? process.resourcesPath : path.join(projectRoot, 'vendor', 'postgresql'),
        'windows-x64', 'bin', 'pg_ctl.exe'),
        ['-D', path.join(dataRoot, 'postgres-data'), '-m', 'fast', 'stop']).catch(() => {})
    } catch { /* Keep test data for inspection after an early failure. */ }
  }
}

main().catch((error) => {
  console.error('Offline runtime integration failed:', error.message)
  process.exitCode = 1
})
