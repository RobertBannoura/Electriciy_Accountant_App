import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { app } from '../src/app.js'
import { requireAdmin } from '../src/middleware/require-admin.js'

const ROUTERS = {
  auth: { mount: '/api/auth', variable: 'authRouter', declarationVariable: 'router' },
  backups: { mount: '/api/backups', variable: 'backupsRouter' },
  categories: { mount: '/api/categories', variable: 'categoriesRouter' },
  checks: { mount: '/api/checks', variable: 'checksRouter' },
  customers: { mount: '/api/customers', variable: 'customersRouter' },
  expenses: { mount: '/api/expenses', variable: 'expensesRouter' },
  health: { mount: '/api/health', variable: 'healthRouter' },
  maintenance: { mount: '/api/maintenance', variable: 'maintenanceRouter' },
  products: { mount: '/api/products', variable: 'productsRouter' },
  purchases: { mount: '/api/purchases', variable: 'purchasesRouter' },
  push: { mount: '/api/push', variable: 'pushRouter' },
  reports: { mount: '/api/reports', variable: 'reportsRouter' },
  returns: { mount: '/api/returns', variable: 'returnsRouter' },
  sales: { mount: '/api/sales', variable: 'salesRouter' },
  stores: { mount: '/api/stores', variable: 'storesRouter' },
  suppliers: { mount: '/api/suppliers', variable: 'suppliersRouter' },
  verification: { mount: '/api/verification', variable: 'verificationRouter' },
}

const PUBLIC_ENDPOINTS = new Set([
  'GET /api/health',
  'GET /api/health/readiness',
  'POST /api/auth/login',
])

test('API security matrix contains every and only declared router method/path pair', async () => {
  const [appSource, matrix] = await Promise.all([
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/API_SECURITY_MATRIX.md', import.meta.url), 'utf8'),
  ])
  const declared = new Set()

  for (const [filename, { mount, variable, declarationVariable = variable }] of Object.entries(ROUTERS)) {
    const routeSource = await readFile(
      new URL(`../src/routes/${filename}.js`, import.meta.url),
      'utf8',
    )
    assert.match(
      appSource,
      new RegExp(`app\\.use\\('${escapeRegExp(mount)}'[^\\n]*\\b${variable}\\b`),
      `${filename} router is not mounted at ${mount}`,
    )
    const routePattern = new RegExp(
      `${declarationVariable}\\.(get|post|put|patch|delete)\\(\\s*['"]([^'"]+)['"]`,
      'g',
    )
    for (const match of routeSource.matchAll(routePattern)) {
      declared.add(`${match[1].toUpperCase()} ${joinPath(mount, match[2])}`)
    }
  }

  const documented = new Set()
  for (const match of matrix.matchAll(/^\| (GET|POST|PUT|PATCH|DELETE) \| (\/api\/[^ |]+) \|/gm)) {
    documented.add(`${match[1]} ${match[2]}`)
  }

  assert.equal(declared.size, 62)
  assert.deepEqual([...documented].sort(), [...declared].sort())
})

test('all declared non-public endpoints reject direct unauthenticated requests', async () => {
  const endpoints = await discoverEndpoints()
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    for (const endpoint of endpoints) {
      if (PUBLIC_ENDPOINTS.has(endpoint)) continue
      const [method, template] = endpoint.split(' ')
      const path = template.replace(/:[^/]+/g, '999999999999')
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
          ? { 'Content-Type': 'application/json' }
          : undefined,
        body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? '{}' : undefined,
      })
      assert.equal(response.status, 401, `${endpoint} was not authentication-gated`)
      const body = await response.json()
      assert.equal(body.error.code, 'AUTHENTICATION_REQUIRED', endpoint)
    }

    const hidden = await fetch(`${baseUrl}/api/hidden-admin-tool`)
    assert.equal(hidden.status, 401)
    assert.equal((await hidden.json()).error.code, 'AUTHENTICATION_REQUIRED')

    const head = await fetch(`${baseUrl}/api/stores`, { method: 'HEAD' })
    assert.equal(head.status, 401)
    assert.equal(await head.text(), '')
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

test('the explicit admin guard denies missing or future non-admin roles', () => {
  for (const auth of [undefined, { user: { role: 'employee' } }, { user: { role: 'cashier' } }]) {
    assert.throws(
      () => requireAdmin({ auth }, {}, () => assert.fail('must not continue')),
      (error) => error.statusCode === 403 && error.code === 'ADMIN_REQUIRED',
    )
  }

  let continued = false
  requireAdmin({ auth: { user: { role: 'admin' } } }, {}, () => { continued = true })
  assert.equal(continued, true)
})

test('manual inventory writes require and bind the validated header store', async () => {
  const [appSource, productsSource, pageSource] = await Promise.all([
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/products.js', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/ProductsPage.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(appSource, /app\.use\('\/api', requireAuth\)\s*\r?\napp\.use\('\/api', requireAdmin\)/)
  assert.match(appSource, /app\.use\('\/api\/backups', requireAuth, requireAdmin,/)
  assert.match(
    productsSource,
    /post\([\s\S]*?'\/:productId\/inventory-movements',[\s\S]*?requireStore,[\s\S]*?requireFinancialRequestId,/,
  )
  assert.match(productsSource, /requestedStoreId !== request\.storeId/)
  assert.equal((productsSource.match(/if \(storeId\) await requireActiveStoreFilter\(storeId\)/g) ?? []).length, 2)
  assert.doesNotMatch(
    productsSource.slice(
      productsSource.indexOf("productsRouter.post('/:productId/inventory-movements'"),
      productsSource.indexOf("productsRouter.post('/:productId/barcode/generate'"),
    ),
    /storeId:\s*parsed\.value\.storeId|\[parsed\.value\.storeId/,
  )
  assert.match(pageSource, /'X-Store-Id': storeId/)
})

async function discoverEndpoints() {
  const endpoints = []
  for (const [filename, { mount, variable, declarationVariable = variable }] of Object.entries(ROUTERS)) {
    const routeSource = await readFile(
      new URL(`../src/routes/${filename}.js`, import.meta.url),
      'utf8',
    )
    const pattern = new RegExp(
      `${declarationVariable}\\.(get|post|put|patch|delete)\\(\\s*['"]([^'"]+)['"]`,
      'g',
    )
    for (const match of routeSource.matchAll(pattern)) {
      endpoints.push(`${match[1].toUpperCase()} ${joinPath(mount, match[2])}`)
    }
  }
  return endpoints
}

function joinPath(mount, route) {
  return route === '/' ? mount : `${mount}${route}`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
