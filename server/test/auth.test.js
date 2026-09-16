import assert from 'node:assert/strict'
import { randomBytes, scrypt as nodeScrypt } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  isValidLoginPassword,
  isValidProvisionedPassword,
  normalizeUsername,
} from '../src/auth/credentials.js'
import {
  hashPassword,
  passwordHashNeedsUpgrade,
  verifyPassword,
} from '../src/auth/password.js'
import { provisionAdmin } from '../src/auth/provision-admin.js'
import {
  createSessionToken,
  hashSessionToken,
  isValidSessionToken,
  readBearerToken,
} from '../src/auth/session-token.js'

const scrypt = promisify(nodeScrypt)

test('normalizes login usernames and validates credential bounds', () => {
  assert.equal(normalizeUsername('  admin  '), 'admin')
  assert.equal(normalizeUsername(''), null)
  assert.equal(normalizeUsername('a'.repeat(65)), null)
  assert.equal(isValidLoginPassword('short'), true)
  assert.equal(isValidLoginPassword(''), false)
  assert.equal(isValidProvisionedPassword('short'), false)
  assert.equal(isValidProvisionedPassword('fourteen-char!'), false)
  assert.equal(isValidProvisionedPassword('🔐'.repeat(8)), false)
  assert.equal(isValidProvisionedPassword('fifteen-chars!!'), true)
})

test('hashes passwords with unique salts and verifies them safely', async () => {
  const firstHash = await hashPassword('a-secure-password')
  const secondHash = await hashPassword('a-secure-password')

  assert.notEqual(firstHash, secondHash)
  assert.match(firstHash, /^scrypt\$16384\$8\$5\$/)
  assert.equal(firstHash.includes('a-secure-password'), false)
  assert.equal(passwordHashNeedsUpgrade(firstHash), false)
  assert.equal(await verifyPassword('a-secure-password', firstHash), true)
  assert.equal(await verifyPassword('wrong-password', firstHash), false)
  assert.equal(await verifyPassword('a-secure-password', 'invalid-hash'), false)
  assert.equal(await verifyPassword('a-secure-password', `${firstHash}$extra`), false)
})

test('allows a short admin password only through the explicit local-development provision option', async () => {
  const calls = []
  const client = {
    async query(text, params) {
      calls.push({ text, params })

      if (text.startsWith('SELECT id')) {
        return { rowCount: 0, rows: [] }
      }

      return {
        rowCount: 1,
        rows: [{ id: '1', username: 'admin', display_name: 'المدير', role: 'admin' }],
      }
    },
  }

  await assert.rejects(
    provisionAdmin(client, {
      username: 'admin',
      password: 'admin',
      displayName: 'المدير',
    }),
    /at least 15 characters/,
  )

  const admin = await provisionAdmin(client, {
    username: 'admin',
    password: 'admin',
    displayName: 'المدير',
    allowLocalDevelopmentPassword: true,
  })

  assert.equal(admin.username, 'admin')
  assert.equal(calls.length, 2)
  assert.match(calls[1].params[1], /^scrypt\$/)
  assert.equal(calls[1].params.includes('admin'), true)
  assert.notEqual(calls[1].params[1], 'admin')
})

test('verifies the previous scrypt profile only for a transparent upgrade', async () => {
  const password = 'existing-admin-password'
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 64, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  const legacyHash = [
    'scrypt',
    '16384',
    '8',
    '1',
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$')

  assert.equal(passwordHashNeedsUpgrade(legacyHash), true)
  assert.equal(await verifyPassword(password, legacyHash), true)
  assert.equal(await verifyPassword('wrong-password', legacyHash), false)
})

test('creates opaque session tokens and stores only deterministic hashes', () => {
  const token = createSessionToken()
  const secondToken = createSessionToken()
  const tokenHash = hashSessionToken(token)

  assert.equal(isValidSessionToken(token), true)
  assert.notEqual(token, secondToken)
  assert.match(tokenHash, /^[a-f0-9]{64}$/)
  assert.equal(tokenHash.includes(token), false)
  assert.equal(readBearerToken(`Bearer ${token}`), token)
  assert.equal(readBearerToken(`bearer ${token}`), null)
  assert.equal(hashSessionToken('invalid'), null)
})

test('the browser keeps the bearer token in sessionStorage rather than localStorage', async () => {
  const clientApi = await readFile(
    new URL('../../client/src/api.ts', import.meta.url),
    'utf8',
  )

  assert.match(clientApi, /sessionStorage\.setItem\(sessionTokenKey, token\)/)
  assert.doesNotMatch(clientApi, /localStorage\.setItem\(sessionTokenKey/)
  assert.match(clientApi, /headers\.set\('Authorization', `Bearer \$\{token\}`\)/)
})

test('revokes existing sessions when the admin password is reprovisioned', async () => {
  const calls = []
  const client = {
    async query(text, params) {
      calls.push({ text, params })

      if (text.startsWith('SELECT id')) {
        return { rowCount: 1, rows: [{ id: '7' }] }
      }

      if (text.includes('UPDATE users')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: '7',
              username: 'admin',
              display_name: 'المدير',
              role: 'admin',
            },
          ],
        }
      }

      return { rowCount: 1, rows: [] }
    },
  }

  await provisionAdmin(client, {
    username: 'admin',
    password: 'new-secure-password',
    displayName: 'المدير',
  })

  assert.equal(calls.length, 3)
  assert.match(calls[1].params[1], /^scrypt\$/)
  assert.equal(calls[1].params.includes('new-secure-password'), false)
  assert.match(calls[2].text, /DELETE FROM auth_sessions/)
  assert.deepEqual(calls[2].params, ['7'])
})

test('allows the admin testing password only in development', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const client = {
    async query(text) {
      if (text.startsWith('SELECT id')) return { rowCount: 0, rows: [] }
      return {
        rowCount: 1,
        rows: [{ id: '8', username: 'admin', display_name: 'المدير', role: 'admin' }],
      }
    },
  }

  try {
    process.env.NODE_ENV = 'production'
    await assert.rejects(
      provisionAdmin(client, {
        username: 'admin',
        password: 'admin',
        displayName: 'المدير',
      }),
      /at least 15 characters/,
    )

    process.env.NODE_ENV = 'development'
    const result = await provisionAdmin(client, {
      username: 'admin',
      password: 'admin',
      displayName: 'المدير',
    })
    assert.equal(result.username, 'admin')
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
})
