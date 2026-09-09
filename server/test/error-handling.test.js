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

  assert.equal(allowedResponse.status, 200)
  assert.equal(
    allowedResponse.headers.get('access-control-allow-origin'),
    'http://localhost:5173',
  )
  assert.equal(rejectedResponse.status, 200)
  assert.equal(rejectedResponse.headers.get('access-control-allow-origin'), null)
})
