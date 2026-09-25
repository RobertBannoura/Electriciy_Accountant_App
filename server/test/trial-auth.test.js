import assert from 'node:assert/strict'
import test from 'node:test'
import { provisionAdmin } from '../src/auth/provision-admin.js'
import { verifyPassword } from '../src/auth/password.js'

test('short trial admin credential requires both explicit trial flags and provisioning opt-in', async () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalTrial = process.env.TRIAL_OFFLINE
  const unavailableDatabase = { query: () => { throw new Error('Database should not be reached') } }
  try {
    process.env.NODE_ENV = 'production'
    delete process.env.TRIAL_OFFLINE
    await assert.rejects(provisionAdmin(unavailableDatabase, {
      username: 'admin', password: 'admin', allowOfflineTrialPassword: true,
    }), /ADMIN_PASSWORD/)

    process.env.NODE_ENV = 'trial'
    process.env.TRIAL_OFFLINE = '1'
    await assert.rejects(provisionAdmin(unavailableDatabase, {
      username: 'admin', password: 'admin',
    }), /ADMIN_PASSWORD/)

    let storedHash = null
    const database = {
      query: async (sql, parameters) => {
        if (sql.startsWith('SELECT id FROM users')) return { rowCount: 0, rows: [] }
        if (sql.includes('INSERT INTO users')) {
          storedHash = parameters[1]
          return { rowCount: 1, rows: [{ id: '1', username: 'admin', display_name: 'Admin', role: 'admin' }] }
        }
        throw new Error('Unexpected query')
      },
    }
    const admin = await provisionAdmin(database, {
      username: 'admin', password: 'admin', displayName: 'Admin',
      allowOfflineTrialPassword: true,
    })
    assert.equal(admin.username, 'admin')
    assert.equal(await verifyPassword('admin', storedHash), true)
    assert.notEqual(storedHash, 'admin')
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    if (originalTrial === undefined) delete process.env.TRIAL_OFFLINE
    else process.env.TRIAL_OFFLINE = originalTrial
  }
})
