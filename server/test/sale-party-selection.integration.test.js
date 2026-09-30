import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'

const databaseUrl = process.env.SALE_PARTIES_DATABASE_URL

test('sale name selection creates, reuses and isolates customer projects atomically', {
  skip: databaseUrl ? false : 'SALE_PARTIES_DATABASE_URL is not configured',
}, async (t) => {
  process.env.DATABASE_URL = databaseUrl
  process.env.NODE_ENV = 'test'
  const [{ app }, { pool }, { provisionAdmin }] = await Promise.all([
    import('../src/app.js'), import('../src/db/pool.js'), import('../src/auth/provision-admin.js'),
  ])
  const password = randomUUID()
  await provisionAdmin(pool, { username: 'sale_parties_test', password, displayName: 'Sale test' })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api`
  let token
  let storeId
  async function request(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(storeId ? { 'X-Store-Id': storeId } : {}), 'X-Request-Id': randomUUID() },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: response.status, ...await response.json() }
  }
  const draft = { date: '2026-09-27', items: [{ description: 'تركيب', quantity: '1', actualPrice: '10' }], payments: [] }
  const suffix = randomUUID()
  const name = `Test Customer ${suffix}`
  const projectName = `بيت ${suffix}`
  try {
    token = (await request('/auth/login', { username: 'sale_parties_test', password })).token
    storeId = (await request('/stores')).stores[0].id
    let original
    await t.test('new names create a customer and project and post debt to them', async () => {
      const result = await request('/sales', { ...draft, customerName: name, customerProjectName: projectName })
      assert.equal(result.status, 201, JSON.stringify(result))
      original = result.sale
      assert.ok(original.customer_id)
      assert.ok(original.customer_project_id)
      assert.equal(original.customer_name, name)
      assert.equal(Number(original.remaining_due), 10)
    })
    await t.test('typing the same names with whitespace/case differences adds to existing records', async () => {
      const result = await request('/sales', { ...draft, customerName: ` ${name.toUpperCase().replace(' ', '   ')} `, customerProjectName: ` ${projectName} ` })
      assert.equal(result.status, 201, JSON.stringify(result))
      assert.equal(result.sale.customer_id, original.customer_id)
      assert.equal(result.sale.customer_project_id, original.customer_project_id)
      const customer = (await request(`/customers/${original.customer_id}`)).customer
      assert.equal(Number(customer.balance_ils), 20)
      assert.equal(customer.projects.length, 1)
    })
    await t.test('explicit selections attach to the same customer/project', async () => {
      const result = await request('/sales', { ...draft, customerId: original.customer_id, customerProjectId: original.customer_project_id })
      assert.equal(result.status, 201, JSON.stringify(result))
      assert.equal(result.sale.customer_project_id, original.customer_project_id)
    })
    await t.test('same project name belongs separately to a different customer', async () => {
      const result = await request('/sales', { ...draft, customerName: `Other ${name}`, customerProjectName: projectName })
      assert.equal(result.status, 201, JSON.stringify(result))
      assert.notEqual(result.sale.customer_project_id, original.customer_project_id)
      const invalid = await request('/sales', { ...draft, customerId: result.sale.customer_id, customerProjectId: original.customer_project_id })
      assert.equal(invalid.status, 404)
    })
    await t.test('failed sale rolls back new customers and projects', async () => {
      const failedName = `Failed ${suffix}`
      const result = await request('/sales', { ...draft, customerName: failedName, customerProjectName: projectName, invoiceDiscount: '20' })
      assert.equal(result.status, 400)
      assert.equal((await pool.query('SELECT id FROM customers WHERE name = $1', [failedName])).rowCount, 0)
      const failedProject = `Failed project ${suffix}`
      await request('/sales', { ...draft, customerId: original.customer_id, customerProjectName: failedProject, invoiceDiscount: '20' })
      assert.equal((await pool.query('SELECT id FROM customer_projects WHERE name = $1', [failedProject])).rowCount, 0)
    })
    await t.test('concurrent sales reuse one new customer and project', async () => {
      const results = await Promise.all(Array.from({ length: 3 }, () => request('/sales', {
        ...draft, customerName: `Concurrent ${suffix}`, customerProjectName: projectName,
      })))
      for (const result of results) assert.equal(result.status, 201, JSON.stringify(result))
      assert.equal(new Set(results.map((result) => result.sale.customer_id)).size, 1)
      assert.equal(new Set(results.map((result) => result.sale.customer_project_id)).size, 1)
    })
    await t.test('duplicate exact names require a selection instead of silently picking a record', async () => {
      await request('/customers', { name })
      const result = await request('/sales', { ...draft, customerName: name })
      assert.equal(result.status, 409)
      assert.equal(result.error.code, 'SALE_CUSTOMER_AMBIGUOUS')
      await request(`/customers/${original.customer_id}/projects`, { name: projectName })
      const projectResult = await request('/sales', { ...draft, customerId: original.customer_id, customerProjectName: projectName })
      assert.equal(projectResult.status, 409)
      assert.equal(projectResult.error.code, 'SALE_PROJECT_AMBIGUOUS')
    })
    await t.test('search finds similar Arabic names and records beyond the first 500', async () => {
      await pool.query("INSERT INTO customers (name) SELECT 'AAA filler ' || generate_series(1, 501)")
      const customer = await request('/customers', { name: `أحمد الزعبي ${suffix}` })
      const result = await request(`/customers/sale-search?search=${encodeURIComponent('احمد الزعبي')}`)
      assert.equal(result.status, 200)
      assert.ok(result.customers.some((row) => row.id === customer.customer.id))
      const typo = await request(`/customers/sale-search?search=${encodeURIComponent('احمد الزعبي'.replace('الزعبي', 'الزعب'))}`)
      assert.ok(typo.customers.some((row) => row.id === customer.customer.id))
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await pool.end()
  }
})
