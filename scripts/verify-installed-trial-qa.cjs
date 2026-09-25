const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { Client } = require('pg')

const root = path.resolve(__dirname, '..')
const qaRoot = path.join(root, 'tmp', 'qa')
const testRoot = path.join(qaRoot, 'installed-trial-check')
const installDir = path.join(testRoot, 'Program')
const localAppData = path.join(testRoot, 'LocalAppData')
const dataRoot = path.join(localAppData, 'ElectricityAccountantTrial')
const setup = path.join(root, 'release', 'installer', 'Electricity-Accountant-Trial-Setup.exe')
const executable = path.join(installDir, 'ElectricityAccountant.exe')

function windowsEnvironment() {
  const env = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.LOCALAPPDATA = localAppData
  return env
}

function run(file, args, { env = windowsEnvironment(), timeout = 180_000, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' })
    let output = ''
    if (capture) {
      child.stdout.on('data', (chunk) => { if (output.length < 100_000) output += chunk.toString() })
      child.stderr.on('data', (chunk) => { if (output.length < 100_000) output += chunk.toString() })
    }
    const timer = setTimeout(() => child.kill(), timeout)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve(output) : reject(new Error(`${path.basename(file)} exited with ${code}`))
    })
  })
}

async function api(port, pathname, { method = 'GET', token, storeId, body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api${pathname}`, {
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
  const payload = await response.json()
  assert.ok(response.ok, `${method} ${pathname}: ${response.status} ${payload?.error?.code ?? ''}`)
  return payload
}

async function login(config) {
  const response = await api(config.backendPort, '/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'admin' },
  })
  return response.token
}

async function waitForRuntime(child) {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Installed Electron exited before startup (code ${child.exitCode}, signal ${child.signalCode}).`)
    }
    try {
      const config = JSON.parse(await fs.readFile(path.join(dataRoot, 'config', 'runtime.json'), 'utf8'))
      const response = await fetch(`http://127.0.0.1:${config.backendPort}/api/health/trial-runtime`, {
        headers: { 'X-Trial-Runtime-Token': config.runtimeToken }, signal: AbortSignal.timeout(1000),
      })
      if (response.ok) return config
    } catch { /* First launch and migrations may still be running. */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Installed Electron trial did not start its local services.')
}

async function launchApp() {
  const child = spawn(executable, [], {
    env: windowsEnvironment(), windowsHide: true, detached: false, shell: false,
    stdio: 'ignore',
  })
  const config = await waitForRuntime(child)
  assert.equal(child.exitCode, null, 'Electron exited before the local services were ready.')
  return { child, config }
}

async function closeApp(child, config) {
  if (!child || child.exitCode !== null) return
  const script = `$p = Get-Process -Id ${child.pid} -ErrorAction Stop; `
    + "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; "
    + "public class TrialWindow { [DllImport(\"user32.dll\")] "
    + "public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'; "
    + 'if ($p.MainWindowHandle -eq 0) { exit 2 }; '
    + '[TrialWindow]::PostMessage($p.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null'
  const sent = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
  assert.equal(sent.status, 0, `Could not close installed Electron window: ${sent.stderr}`)
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => reject(new Error('Electron did not exit after window close.')), 45_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const databaseFree = await portIsFree(config.databasePort)
    const backendFree = await portIsFree(config.backendPort)
    if (databaseFree && backendFree && trialProcessIds().length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Trial processes remained running after Electron closed.')
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const listener = net.createServer()
    listener.once('error', () => resolve(false))
    listener.listen(port, '127.0.0.1', () => listener.close(() => resolve(true)))
  })
}

function visibleConsoleIds() {
  const script = 'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and '
    + '$_.ProcessName -match "^(cmd|powershell|pwsh|postgres|node|conhost)$" } | '
    + 'Select-Object -ExpandProperty Id'
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-WindowStyle', 'Hidden', '-Command', script], {
    windowsHide: true, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0, 'Could not inspect visible console windows.')
  return new Set(result.stdout.trim().split(/\s+/).filter(Boolean))
}

function assertNoNewConsoles(baseline) {
  const current = visibleConsoleIds()
  const added = [...current].filter((pid) => !baseline.has(pid))
  assert.deepEqual(added, [], `Trial launch opened ${added.length} visible console window(s).`)
}

function trialProcessIds() {
  const binDirectory = path.join(installDir, 'resources', 'windows-x64', 'bin')
  const script = `$appPath = '${executable.replaceAll("'", "''")}'; `
    + `$binPath = '${binDirectory.replaceAll("'", "''")}'; `
    + 'Get-Process | ForEach-Object { try { $p = $_.Path } catch { $p = $null }; '
    + 'if ($p -and ($p.Equals($appPath, [StringComparison]::OrdinalIgnoreCase) -or '
    + '$p.StartsWith($binPath + [IO.Path]::DirectorySeparatorChar, '
    + '[StringComparison]::OrdinalIgnoreCase))) { $_.Id } }'
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-WindowStyle', 'Hidden', '-Command', script], {
    windowsHide: true, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0, 'Could not inspect trial process counts.')
  return result.stdout.trim().split(/\s+/).filter(Boolean)
}

async function database(config, sql, values = []) {
  const client = new Client({ host: '127.0.0.1', port: config.databasePort,
    user: 'trial_owner', password: config.databasePassword,
    database: 'electricity_accountant', ssl: false })
  await client.connect()
  try { return await client.query(sql, values) } finally { await client.end() }
}

async function checkBindings(config) {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    env: windowsEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0)
  const rows = result.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
  const trialPids = new Set()
  const servicePids = {}
  for (const port of [config.databasePort, config.backendPort]) {
    const listeners = rows.filter((parts) => parts[0] === 'TCP' && parts[3] === 'LISTENING'
      && Number(parts[1]?.slice(parts[1].lastIndexOf(':') + 1)) === port)
    const addresses = listeners.map((parts) => parts[1].slice(0, parts[1].lastIndexOf(':')))
    assert.ok(addresses.length > 0, `Port ${port} had no listener in netstat.`)
    assert.ok(addresses.every((address) => address === '127.0.0.1'), `Port ${port} was not loopback-only.`)
    assert.equal(listeners.length, 1, `Port ${port} had duplicate listeners.`)
    servicePids[port] = listeners[0][4]
    for (const listener of listeners) trialPids.add(listener[4])
  }
  for (const parts of rows) {
    if (parts[0] !== 'TCP' || !trialPids.has(parts[4])
      || !['ESTABLISHED', 'SYN_SENT'].includes(parts[3])) continue
    const remoteHost = parts[2].slice(0, parts[2].lastIndexOf(':'))
    assert.ok(['127.0.0.1', '[::1]'].includes(remoteHost),
      'A trial service had a non-loopback TCP connection.')
  }
  const addresses = Object.values(os.networkInterfaces()).flat()
    .filter((entry) => entry?.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
  for (const address of [...new Set(addresses)].slice(0, 4)) {
    for (const port of [config.databasePort, config.backendPort]) {
      const reachable = await new Promise((resolve) => {
        const socket = net.createConnection({ host: address, port, timeout: 1000 })
        socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('error', () => resolve(false))
        socket.once('timeout', () => { socket.destroy(); resolve(false) })
      })
      assert.equal(reachable, false, `${address}:${port} accepted a LAN connection.`)
    }
  }
  return servicePids
}

async function verify(config, ids) {
  const token = await login(config)
  const products = await api(config.backendPort, '/products', { token })
  assert.ok(products.products.some((row) => row.id === ids.productId))
  const customers = await api(config.backendPort, '/customers', { token, storeId: ids.storeId })
  assert.ok(customers.customers.some((row) => row.id === ids.customerId))
  const sale = await api(config.backendPort, `/sales/${ids.saleId}`, { token, storeId: ids.storeId })
  assert.equal(Number(sale.sale.remaining_due), 40)
  const amounts = await database(config, `
    SELECT (SELECT quantity::TEXT FROM store_inventory_balances
      WHERE store_id = $1::BIGINT AND product_id = $2::BIGINT) AS stock,
      (SELECT balance_ils::TEXT FROM customer_balances
      WHERE customer_id = $3::BIGINT) AS balance
  `, [ids.storeId, ids.productId, ids.customerId])
  assert.equal(Number(amounts.rows[0].stock), ids.expectedStock)
  assert.equal(Number(amounts.rows[0].balance), 40)
  const financial = await api(config.backendPort, '/verification/financial', { token })
  assert.equal(financial.status, 'ok')
  assert.equal(financial.sections.reduce((sum, section) => sum + section.issueCount, 0), 0)
  return token
}

async function stopServices(config) {
  if (!config) return
  try {
    await fetch(`http://127.0.0.1:${config.backendPort}/api/health/trial-shutdown`, {
      method: 'POST', headers: { 'X-Trial-Runtime-Token': config.runtimeToken },
    })
  } catch { /* Already stopped. */ }
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await run(path.join(installDir, 'resources', 'windows-x64', 'bin', 'pg_ctl.exe'),
    ['-D', path.join(dataRoot, 'postgres-data'), '-m', 'fast', 'stop'],
    { timeout: 30_000 }).catch(() => {})
}

async function waitForRemoval() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { await fs.access(executable) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Uninstaller did not remove the program.')
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  assert.equal(path.dirname(testRoot), qaRoot)
  await fs.rm(testRoot, { recursive: true, force: true })
  await fs.mkdir(localAppData, { recursive: true })
  let config
  let running = null
  const consoleBaseline = visibleConsoleIds()
  try {
    await run(setup, ['/S', '/currentuser', `/D=${installDir}`])
    await fs.access(executable)
    const smokeOutput = await run(executable, ['--smoke-test'], { capture: true, timeout: 120_000 })
    assert.match(smokeOutput, /Electron authentication smoke test passed/)
    assert.deepEqual(trialProcessIds(), [], 'Packaged Electron smoke left trial processes running.')
    running = await launchApp()
    config = running.config
    assertNoNewConsoles(consoleBaseline)
    const originalPids = await checkBindings(config)
    assert.ok(trialProcessIds().length >= 3, 'Installed trial process inventory was incomplete.')
    const secondInstance = spawn(executable, [], {
      env: windowsEnvironment(), windowsHide: true, detached: false, shell: false,
      stdio: 'ignore',
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Second Electron instance did not exit.')), 15_000)
      secondInstance.once('exit', () => { clearTimeout(timer); resolve() })
    })
    assert.deepEqual(await checkBindings(config), originalPids,
      'Second launch replaced or duplicated a local service.')
    assertNoNewConsoles(consoleBaseline)
    const token = await login(config)
    const stores = await api(config.backendPort, '/stores', { token })
    const storeId = stores.stores[0].id
    const category = await api(config.backendPort, '/categories', {
      method: 'POST', token, body: { name: 'Installed trial QA category' },
    })
    const product = await api(config.backendPort, '/products', {
      method: 'POST', token, body: {
        name: 'Installed trial QA product', categoryId: category.category.id,
        saleUnit: 'قطعة', currentPurchasePrice: '10', defaultSalePrice: '30',
        inventorySettings: [{ storeId, reorderLevel: '1', openingQuantity: '10' }],
      },
    })
    const customer = await api(config.backendPort, '/customers', {
      method: 'POST', token, storeId, body: { name: 'Installed trial QA customer' },
    })
    const sale = await api(config.backendPort, '/sales', {
      method: 'POST', token, storeId, body: {
        invoiceNumber: 'INSTALLED-QA-SALE', date: '2026-09-25',
        customerId: customer.customer.id, invoiceDiscount: '0',
        items: [{ productId: product.product.id, quantity: '2', actualPrice: '30', discount: '0' }],
        payments: [{ method: 'cash', currency: 'ILS', amount: '20' }],
      },
    })
    assert.equal(Number(sale.sale.remaining_due), 40)
    const ids = { storeId, productId: product.product.id,
      customerId: customer.customer.id, saleId: sale.sale.id, expectedStock: 8 }
    await verify(config, ids)
    console.log('Actual installer, visible Electron launch, login, sale, second-instance and loopback checks passed.')

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await closeApp(running.child, config)
      running = null
      assertNoNewConsoles(consoleBaseline)
      running = await launchApp()
      assert.equal(running.config.databasePassword, config.databasePassword)
      config = running.config
      await verify(config, ids)
      await checkBindings(config)
      assertNoNewConsoles(consoleBaseline)
      console.log(`Electron close/reopen cycle ${cycle}: zero residual trial processes, data and balances retained.`)
    }

    const currentToken = await login(config)
    const supplier = await api(config.backendPort, '/suppliers', {
      method: 'POST', token: currentToken, storeId,
      body: { name: 'Installed trial QA supplier' },
    })
    const purchase = await api(config.backendPort, '/purchases', {
      method: 'POST', token: currentToken, storeId,
      body: {
        supplierId: supplier.supplier.id, documentNumber: 'INSTALLED-QA-PURCHASE',
        businessDate: '2026-09-25',
        items: [{ productId: ids.productId, quantity: '2', purchasePrice: '10' }],
        payments: [{ method: 'cash', amount: '20' }],
      },
    })
    assert.equal(Number(purchase.purchase.remaining_due), 0)
    ids.expectedStock = 10
    const maintenance = await api(config.backendPort, '/maintenance', {
      method: 'POST', token: currentToken, storeId,
      body: {
        customerId: ids.customerId, itemDescription: 'Installed trial QA maintenance',
        amount: '50', businessDate: '2026-09-25',
        payments: [{ method: 'cash', currency: 'ILS', amount: '50' }],
      },
    })
    assert.equal(Number(maintenance.maintenance.remaining_due_ils), 0)
    await verify(config, ids)
    const backup = await api(config.backendPort, '/backups/export', { token: currentToken })
    await api(config.backendPort, '/backups/verify', {
      method: 'POST', token: currentToken, body: backup,
    })
    await api(config.backendPort, '/backups/restore', {
      method: 'POST', token: currentToken, body: backup,
      headers: { 'X-Confirm-Restore': 'restore-both-stores' },
    })
    await verify(config, ids)
    console.log('Purchase, maintenance, backup, restore and financial verification passed.')
  } finally {
    if (running) {
      await closeApp(running.child, config).catch(() => { running.child.kill() })
    }
    await stopServices(config)
    const uninstaller = path.join(installDir, 'Uninstall ElectricityAccountant.exe')
    try {
      await fs.access(uninstaller)
      await run(uninstaller, ['/S'])
      await waitForRemoval()
    } catch { /* Keep the original failure visible if installation did not finish. */ }
  }
}

main().catch((error) => {
  console.error('Installed trial QA failed:', error.message)
  process.exitCode = 1
})
