import assert from 'node:assert/strict'
import { randomBytes, scrypt as nodeScrypt } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import { promisify } from 'node:util'
import express from 'express'
import { hashPassword } from '../src/auth/password.js'
import { createSessionToken } from '../src/auth/session-token.js'
import { errorHandler, notFoundHandler } from '../src/middleware/error-handler.js'
import { createProxyClientIpNormalizer } from '../src/middleware/request-boundaries.js'
import { createRequireAuth } from '../src/middleware/require-auth.js'
import {
  createAuthRouter,
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_RATE_LIMIT_WINDOW_MS,
} from '../src/routes/auth.js'

const scrypt = promisify(nodeScrypt)

async function createLegacyPasswordHash(password) {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 64, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })

  return [
    'scrypt',
    '16384',
    '8',
    '1',
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$')
}

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

test('revoked sessions are rejected without exposing the raw token to PostgreSQL', async () => {
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
      assert.equal(authenticationQuery.params[0].length, 64)
      assert.notEqual(authenticationQuery.params[0], token)
    },
  )
})

test('expired and disabled-account sessions are rejected by server-side predicates', async () => {
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
      assert.match(authenticationQuery.text, /users\.is_active = TRUE/)
      assert.match(authenticationQuery.text, /INNER JOIN users/)
    },
  )
})

test('logout invalidates the session for subsequent authenticated requests', async () => {
  const token = createSessionToken()
  let sessionActive = true
  const dbQuery = async (text) => {
    if (text.includes('DELETE FROM auth_sessions')) {
      sessionActive = false
      return { rowCount: 1, rows: [] }
    }

    if (text.includes('FROM auth_sessions')) {
      return sessionActive
        ? {
            rowCount: 1,
            rows: [{
              session_id: '44',
              user_id: '7',
              username: 'admin',
              display_name: 'المدير',
              role: 'admin',
            }],
          }
        : { rowCount: 0, rows: [] }
    }

    return { rowCount: 1, rows: [] }
  }
  const authenticate = createRequireAuth({ dbQuery })

  await withServer(
    (app) => app.use('/api/auth', createAuthRouter({
      authenticate,
      dbQuery,
    })),
    async (baseUrl) => {
      const headers = { Authorization: `Bearer ${token}` }
      const beforeLogout = await fetch(`${baseUrl}/api/auth/me`, { headers })
      const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers })
      const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers })
      const afterLogoutBody = await afterLogout.json()

      assert.equal(beforeLogout.status, 200)
      assert.equal(logout.status, 204)
      assert.equal(afterLogout.status, 401)
      assert.equal(afterLogoutBody.error.code, 'INVALID_SESSION')
    },
  )
})

test('login protection uses the required temporary 45-attempt window', () => {
  assert.equal(LOGIN_ATTEMPT_LIMIT, 45)
  assert.equal(LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000)
})

test('login rate limiting applies per IP across different account identifiers', async () => {
  const testLimit = 3
  await withServer(
    (app) => app.use('/api/auth', createAuthRouter({ loginAttemptLimit: testLimit })),
    async (baseUrl) => {
      for (let attempt = 1; attempt <= testLimit; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: `unknown-${attempt}`, password: '' }),
        })
        assert.equal(response.status, 401, `attempt ${attempt}`)
      }

      const blocked = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'another-unknown', password: '' }),
      })
      const body = await blocked.json()

      assert.equal(blocked.status, 429)
      assert.equal(body.error.code, 'TOO_MANY_LOGIN_ATTEMPTS')
    },
  )
})

test('login rate limiting applies per normalized account across different IPs', async () => {
  const testLimit = 3
  await withServer(
    (app) => {
      app.set('trust proxy', (address) => (
        address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
      ))
      app.use('/api/auth', createAuthRouter({ loginAttemptLimit: testLimit }))
    },
    async (baseUrl) => {
      for (let attempt = 1; attempt <= testLimit; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': `203.0.113.${attempt}`,
          },
          body: JSON.stringify({ username: attempt % 2 ? ' ADMIN ' : 'admin', password: '' }),
        })
        assert.equal(response.status, 401, `attempt ${attempt}`)
      }

      const blocked = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.99',
        },
        body: JSON.stringify({ username: 'Admin', password: '' }),
      })
      const body = await blocked.json()

      assert.equal(blocked.status, 429)
      assert.equal(body.error.code, 'TOO_MANY_LOGIN_ATTEMPTS')
    },
  )
})

test('trusted Railway-style proxy IPs produce independent limiter keys and overwrite spoofed chains', async () => {
  const testLimit = 2
  await withServer(
    (app) => {
      app.set('trust proxy', 'loopback')
      app.use(createProxyClientIpNormalizer('x-real-ip'))
      app.use('/api/auth', createAuthRouter({ loginAttemptLimit: testLimit }))
    },
    async (baseUrl) => {
      const attempt = (clientIp, username, spoofedForwardedFor) => fetch(
        `${baseUrl}/api/auth/login`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Real-IP': clientIp,
            'X-Forwarded-For': spoofedForwardedFor,
          },
          body: JSON.stringify({ username, password: '' }),
        },
      )

      assert.equal((await attempt('203.0.113.10', 'proxy-a-1', '192.0.2.1')).status, 401)
      assert.equal((await attempt('203.0.113.10', 'proxy-a-2', '192.0.2.2')).status, 401)
      assert.equal((await attempt('203.0.113.11', 'proxy-b-1', '192.0.2.1')).status, 401)
      assert.equal((await attempt('203.0.113.11', 'proxy-b-2', '192.0.2.2')).status, 401)
      assert.equal((await attempt('203.0.113.10', 'proxy-a-3', '198.51.100.250')).status, 429)
      assert.equal((await attempt('203.0.113.11', 'proxy-b-3', '198.51.100.251')).status, 429)

      const malformed = await attempt('not-an-ip', 'proxy-invalid', '198.51.100.252')
      assert.equal(malformed.status, 400)
      assert.equal((await malformed.json()).error.code, 'INVALID_PROXY_CLIENT_IP')
    },
  )
})

test('untrusted direct callers cannot select limiter keys with forwarding headers', async () => {
  const testLimit = 2
  await withServer(
    (app) => {
      app.set('trust proxy', false)
      app.use(createProxyClientIpNormalizer('x-real-ip'))
      app.use('/api/auth', createAuthRouter({ loginAttemptLimit: testLimit }))
    },
    async (baseUrl) => {
      for (let attempt = 1; attempt <= testLimit; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Real-IP': `203.0.113.${attempt}`,
            'X-Forwarded-For': `198.51.100.${attempt}`,
          },
          body: JSON.stringify({ username: `direct-${attempt}`, password: '' }),
        })
        assert.equal(response.status, 401)
      }

      const blocked = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': '203.0.113.99',
          'X-Forwarded-For': '198.51.100.99',
        },
        body: JSON.stringify({ username: 'direct-three', password: '' }),
      })
      assert.equal(blocked.status, 429)
    },
  )
})

test('successful authentication resets temporary failed-attempt counters', async () => {
  const testLimit = 3
  const password = 'correct-admin-password'
  const passwordHash = await hashPassword(password)
  const dbQuery = async (text) => {
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
    (app) => app.use('/api/auth', createAuthRouter({ dbQuery, loginAttemptLimit: testLimit })),
    async (baseUrl) => {
      const attempt = (attemptedPassword) => fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: attemptedPassword }),
      })

      assert.equal((await attempt('')).status, 401)
      assert.equal((await attempt('')).status, 401)
      assert.equal((await attempt(password)).status, 201)

      for (let count = 1; count <= testLimit; count += 1) {
        assert.equal((await attempt('')).status, 401, `post-success failure ${count}`)
      }
      assert.equal((await attempt('')).status, 429)
    },
  )
})

test('successful legacy-password login upgrades the KDF without storing plaintext', async () => {
  const password = 'existing-admin-password'
  const legacyHash = await createLegacyPasswordHash(password)
  const calls = []
  const dbQuery = async (text, params = []) => {
    calls.push({ text, params })

    if (text.includes('FROM users')) {
      return {
        rowCount: 1,
        rows: [{
          id: '7',
          username: 'admin',
          password_hash: legacyHash,
          display_name: 'المدير',
          role: 'admin',
        }],
      }
    }

    if (text.includes('INSERT INTO auth_sessions')) {
      return { rowCount: 1, rows: [{ expires_at: '2030-01-01T00:00:00.000Z' }] }
    }

    return { rowCount: 1, rows: [] }
  }

  await withServer(
    (app) => app.use('/api/auth', createAuthRouter({ dbQuery })),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password }),
      })

      assert.equal(response.status, 201)
      const upgrade = calls.find((call) => call.text.includes('UPDATE users SET password_hash'))
      assert.ok(upgrade)
      assert.match(upgrade.params[0], /^scrypt\$16384\$8\$5\$/)
      assert.equal(upgrade.params.includes(password), false)
    },
  )
})

test('malformed authorization headers are rejected before a session lookup', async () => {
  let queryCount = 0
  const authenticate = createRequireAuth({
    dbQuery: async () => {
      queryCount += 1
      return { rowCount: 0, rows: [] }
    },
  })

  await withServer(
    (app) => app.get('/protected', authenticate, (_request, response) => response.json({ ok: true })),
    async (baseUrl) => {
      for (const authorization of [
        'Basic YWRtaW46cGFzc3dvcmQ=',
        'Bearer short',
        `bearer ${createSessionToken()}`,
        `Bearer ${createSessionToken()} trailing`,
      ]) {
        const response = await fetch(`${baseUrl}/protected`, {
          headers: { Authorization: authorization },
        })
        const body = await response.json()

        assert.equal(response.status, 401)
        assert.equal(body.error.code, 'AUTHENTICATION_REQUIRED')
      }

      assert.equal(queryCount, 0)
    },
  )
})

test('authentication does not write passwords or raw session tokens to logs', async () => {
  const password = 'log-safety-password'
  const passwordHash = await hashPassword(password)
  const logEntries = []
  const originalMethods = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  }

  console.error = (...values) => logEntries.push(values)
  console.log = (...values) => logEntries.push(values)
  console.warn = (...values) => logEntries.push(values)

  let token
  try {
    await withServer(
      (app) => app.use('/api/auth', createAuthRouter({
        dbQuery: async (text) => {
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
        },
      })),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password }),
        })
        const body = await response.json()
        token = body.token
        assert.equal(response.status, 201)
      },
    )
  } finally {
    console.error = originalMethods.error
    console.log = originalMethods.log
    console.warn = originalMethods.warn
  }

  const serializedLogs = JSON.stringify(logEntries)
  assert.equal(serializedLogs.includes(password), false)
  assert.equal(serializedLogs.includes(token), false)
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
