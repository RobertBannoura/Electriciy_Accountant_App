import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isValidLoginPassword,
  isValidProvisionedPassword,
  normalizeUsername,
} from '../src/auth/credentials.js'
import { hashPassword, verifyPassword } from '../src/auth/password.js'
import { provisionAdmin } from '../src/auth/provision-admin.js'
import {
  createSessionToken,
  hashSessionToken,
  isValidSessionToken,
  readBearerToken,
} from '../src/auth/session-token.js'

test('normalizes login usernames and validates credential bounds', () => {
  assert.equal(normalizeUsername('  admin  '), 'admin')
  assert.equal(normalizeUsername(''), null)
  assert.equal(normalizeUsername('a'.repeat(65)), null)
  assert.equal(isValidLoginPassword('short'), true)
  assert.equal(isValidLoginPassword(''), false)
  assert.equal(isValidProvisionedPassword('short'), false)
  assert.equal(isValidProvisionedPassword('long-password'), true)
})

test('hashes passwords with unique salts and verifies them safely', async () => {
  const firstHash = await hashPassword('a-secure-password')
  const secondHash = await hashPassword('a-secure-password')

  assert.notEqual(firstHash, secondHash)
  assert.equal(firstHash.includes('a-secure-password'), false)
  assert.equal(await verifyPassword('a-secure-password', firstHash), true)
  assert.equal(await verifyPassword('wrong-password', firstHash), false)
  assert.equal(await verifyPassword('a-secure-password', 'invalid-hash'), false)
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
