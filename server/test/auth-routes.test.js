import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { hashPassword } from '../src/auth/password.js'
import { createSessionToken } from '../src/auth/session-token.js'
import { errorHandler, notFoundHandler } from '../src/middleware/error-handler.js'
import { createRequireAuth } from '../src/middleware/require-auth.js'
import { createAuthRouter } from '../src/routes/auth.js'

async function withServer(configure, run) {
  const app = express()
  app.use(express.json())
  configure(app)
  app.use(notFoundHandler)
  app.use(errorHandler)

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()

  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

test('successful login returns a no-store opaque token and persists only its hash', async () => {
  const password = 'correct horse battery staple'
  const passwordHash = await hashPassword(password)
  const calls = []
  const dbQuery = async (text, params = []) => {
    calls.push({ text, params })

    if (text.includes('FROM users')) {
      return {
        rowCount: 1,
        rows: [{
          id: '7',
          username: 'admin',
          password_hash: passwordHash,
          display_name: 'المدير',
          role: 'admin',
        }],
      }
    }

    if (text.includes('INSERT INTO auth_sessions')) {
      return { rowCount: 1, rows: [{ expires_at: '2030-01-01T00:00:00.000Z' }] }
    }

    return { rowCount: 0, rows: [] }
  }

  await withServer(
    (app) => app.use('/api/auth', createAuthRouter({ dbQuery })),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password }),
      })
      const body = await response.json()

      assert.equal(response.status, 201)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.match(body.token, /^[A-Za-z0-9_-]{43}$/)
      assert.equal(body.user.role, 'admin')

      const insert = calls.find((call) => call.text.includes('INSERT INTO auth_sessions'))
      assert.match(insert.params[1], /^[a-f0-9]{64}$/)
      assert.notEqual(insert.params[1], body.token)
      assert.equal(calls.some((call) => call.params.includes(password)), false)
    },
  )
})

test('unknown username and wrong password return the same public error', async () => {
  const passwordHash = await hashPassword('real-admin-password')
  const dbQuery = async (_text, params = []) => {
    if (params[0] === 'admin') {
      return {
        rowCount: 1,
        rows: [{
          id: '1',
          username: 'admin',
          password_hash: passwordHash,
          display_name: 'المدير',
          role: 'admin',
        }],
      }
    }

    return { rowCount: 0, rows: [] }
  }

  await withServer(
    (app) => app.use('/api/auth', createAuthRouter({ dbQuery })),
    async (baseUrl) => {
      const attempt = async (username) => {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password: 'wrong-password' }),
        })
        const body = await response.json()
        return { response, error: body.error }
      }

      const unknown = await attempt('unknown')
      const wrong = await attempt('admin')

      assert.equal(unknown.response.status, 401)
      assert.equal(wrong.response.status, 401)
      assert.equal(unknown.error.code, 'INVALID_CREDENTIALS')
      assert.equal(wrong.error.code, 'INVALID_CREDENTIALS')
      assert.equal(unknown.error.message, wrong.error.message)
    },
  )
})

test('expired or revoked sessions are rejected by the authentication middleware', async () => {
  const token = createSessionToken()
  let authenticationQuery
  const authenticate = createRequireAuth({
    dbQuery: async (text, params) => {
      authenticationQuery = { text, params }
      return { rowCount: 0, rows: [] }
    },
  })

  await withServer(
    (app) => app.get('/protected', authenticate, (_request, response) => response.json({ ok: true })),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/protected`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await response.json()

      assert.equal(response.status, 401)
      assert.equal(body.error.code, 'INVALID_SESSION')
      assert.match(authenticationQuery.text, /sessions\.expires_at > NOW\(\)/)
      assert.equal(authenticationQuery.params[0].length, 64)
    },
  )
})

test('logout deletes the authenticated database session', async () => {
  const calls = []
  const authenticate = (request, _response, next) => {
    request.auth = { sessionId: '44', user: { role: 'admin' } }
    next()
  }

  await withServer(
    (app) => app.use('/api/auth', createAuthRouter({
      authenticate,
      dbQuery: async (text, params) => {
        calls.push({ text, params })
        return { rowCount: 1, rows: [] }
      },
    })),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' })

      assert.equal(response.status, 204)
      assert.equal(calls.length, 1)
      assert.match(calls[0].text, /DELETE FROM auth_sessions/)
      assert.deepEqual(calls[0].params, ['44'])
    },
  )
})

test('login rate limiting blocks the eleventh failed attempt', async () => {
  await withServer(
    (app) => app.use('/api/auth', createAuthRouter()),
    async (baseUrl) => {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: '', password: '' }),
        })
        assert.equal(response.status, 401, `attempt ${attempt}`)
      }

      const blocked = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '', password: '' }),
      })
      const body = await blocked.json()

      assert.equal(blocked.status, 429)
      assert.equal(body.error.code, 'TOO_MANY_LOGIN_ATTEMPTS')
    },
  )
})

test('the authentication router exposes no public registration endpoint', async () => {
  await withServer(
    (app) => app.use('/api/auth', createAuthRouter()),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST' })
      const body = await response.json()

      assert.equal(response.status, 404)
      assert.equal(body.error.code, 'ROUTE_NOT_FOUND')
    },
  )
})
