import assert from 'node:assert/strict'
import { once } from 'node:events'
import test, { after, before } from 'node:test'
import { app } from '../src/app.js'

let server
let baseUrl

before(async () => {
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

test('allows valid JSON to continue to normal route handling', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '', password: '' }),
  })
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.equal(body.error.code, 'INVALID_CREDENTIALS')
})

test('returns a safe Arabic 400 response for malformed JSON', async () => {
  const response = await fetch(`${baseUrl}/unknown-route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad',
  })
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.deepEqual(body, {
    error: {
      code: 'INVALID_JSON',
      message: 'بيانات JSON المرسلة غير صالحة',
    },
  })
})

test('returns a safe Arabic 413 response for oversized JSON', async () => {
  const response = await fetch(`${baseUrl}/unknown-route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(1024 * 1024) }),
  })
  const body = await response.json()

  assert.equal(response.status, 413)
  assert.deepEqual(body, {
    error: {
      code: 'PAYLOAD_TOO_LARGE',
      message: 'حجم الطلب أكبر من الحد المسموح',
    },
  })
})

test('keeps unknown routes on the centralized 404 response', async () => {
  const response = await fetch(`${baseUrl}/unknown-route`)
  const body = await response.json()

  assert.equal(response.status, 404)
  assert.equal(body.error.code, 'ROUTE_NOT_FOUND')
})

test('protected routes and store name updates reject unauthenticated requests', async () => {
  const storesResponse = await fetch(`${baseUrl}/api/stores`)
  const updateResponse = await fetch(`${baseUrl}/api/stores/1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'اسم جديد' }),
  })
  const storesBody = await storesResponse.json()
  const updateBody = await updateResponse.json()

  assert.equal(storesResponse.status, 401)
  assert.equal(updateResponse.status, 401)
  assert.equal(storesBody.error.code, 'AUTHENTICATION_REQUIRED')
  assert.equal(updateBody.error.code, 'AUTHENTICATION_REQUIRED')
})

test('allows only the canonical frontend development origin through CORS', async () => {
  const allowedResponse = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: 'http://localhost:5173' },
  })
  const rejectedResponse = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: 'http://127.0.0.1:5173' },
  })
  const allowedPreflight = await fetch(`${baseUrl}/api/stores`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'GET',
    },
  })
  const rejectedPreflight = await fetch(`${baseUrl}/api/stores`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://attacker.example',
      'Access-Control-Request-Method': 'POST',
    },
  })

  assert.equal(allowedResponse.status, 200)
  assert.equal(
    allowedResponse.headers.get('access-control-allow-origin'),
    'http://localhost:5173',
  )
  const rejectedBody = await rejectedResponse.json()

  assert.equal(rejectedResponse.status, 403)
  assert.equal(rejectedResponse.headers.get('access-control-allow-origin'), null)
  assert.equal(rejectedBody.error.code, 'ORIGIN_NOT_ALLOWED')
  assert.equal(allowedPreflight.status, 204)
  assert.equal(
    allowedPreflight.headers.get('access-control-allow-origin'),
    'http://localhost:5173',
  )
  assert.equal(rejectedPreflight.status, 403)
})

test('API responses are never stored by browser or intermediary caches', async () => {
  const healthResponse = await fetch(`${baseUrl}/api/health`)
  const protectedResponse = await fetch(`${baseUrl}/api/stores`)

  assert.equal(healthResponse.headers.get('cache-control'), 'no-store')
  assert.equal(protectedResponse.status, 401)
  assert.equal(protectedResponse.headers.get('cache-control'), 'no-store')
})

test('rejects invalid request identifiers before they can reach logs or audit storage', async () => {
  const rejectedResponse = await fetch(`${baseUrl}/api/health`, {
    headers: { 'X-Request-Id': 'contains spaces and control-like delimiters' },
  })
  const acceptedResponse = await fetch(`${baseUrl}/api/health`, {
    headers: { 'X-Request-Id': 'req_2026-09-10:abc.123' },
  })
  const rejectedBody = await rejectedResponse.json()

  assert.equal(rejectedResponse.status, 400)
  assert.equal(rejectedBody.error.code, 'INVALID_REQUEST_ID')
  assert.equal(acceptedResponse.status, 200)
})

test('rejects deeply nested JSON before authentication or business logic', async () => {
  let nested = 'value'
  for (let depth = 0; depth < 40; depth += 1) nested = { nested }

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: nested }),
  })
  const body = await response.json()

  assert.equal(response.status, 413)
  assert.equal(body.error.code, 'JSON_TOO_COMPLEX')
})

test('sets defensive API headers without advertising HSTS on the loopback HTTP server', async () => {
  const response = await fetch(`${baseUrl}/api/health`)
  const contentSecurityPolicy = response.headers.get('content-security-policy')

  assert.equal(response.status, 200)
  assert.match(contentSecurityPolicy, /default-src 'none'/)
  assert.match(contentSecurityPolicy, /frame-ancestors 'none'/)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.match(response.headers.get('permissions-policy'), /camera=\(\)/)
  assert.equal(response.headers.get('strict-transport-security'), null)
  assert.equal(response.headers.get('set-cookie'), null)
})

test('bearer authentication does not accept ambient cookie credentials', async () => {
  const response = await fetch(`${baseUrl}/api/stores`, {
    headers: { Cookie: 'session=attacker-controlled' },
  })
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.equal(body.error.code, 'AUTHENTICATION_REQUIRED')
  assert.equal(response.headers.get('set-cookie'), null)
})
