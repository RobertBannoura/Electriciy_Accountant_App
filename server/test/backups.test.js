import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_CONTENTS,
  backupTables,
  createBackup,
  restoreBackup,
  stableStringify,
  verifyBackup,
} from '../src/backups/backup-service.js'

const schemaVersion = '0022_vapid_admin_notifications.sql'

function fakeExportConnection({ stores = [] } = {}) {
  const queries = []
  const client = {
    async query(sql, params) {
      queries.push({ sql, params })
      if (sql.includes('FROM schema_migrations')) {
        return { rowCount: 1, rows: [{ name: schemaVersion }] }
      }
      if (sql.includes('FROM information_schema.columns')) {
        return { rowCount: 1, rows: [{ column_name: 'id' }] }
      }
      if (sql.startsWith('SELECT * FROM')) {
        return { rows: sql.includes('"stores"') ? stores : [] }
      }
      if (sql.includes('last_value::TEXT')) {
        return { rows: [{ last_value: '1', is_called: false }] }
      }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  return { client, queries }
}

test('exports all required business sections from one repeatable-read transaction', async () => {
  const { client, queries } = fakeExportConnection()
  const backup = await createBackup({
    connect: async () => client,
    now: () => new Date('2026-09-09T10:20:30.000Z'),
  })

  assert.equal(backup.format, BACKUP_FORMAT)
  assert.equal(backup.formatVersion, BACKUP_FORMAT_VERSION)
  assert.deepEqual(backup.contents, BACKUP_CONTENTS)
  assert.equal(backup.schemaVersion, schemaVersion)
  assert.equal(backup.timestamp, '2026-09-09T10:20:30.000Z')
  assert.match(backup.checksum, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(Object.keys(backup.data), backupTables.map(({ key }) => key))
  assert.match(queries[0].sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/)
  assert.match(queries[1].sql, /pg_advisory_xact_lock_shared/)
  assert.equal(queries.at(-1).sql, 'COMMIT')
})

test('rejects a changed payload before consulting the database', async () => {
  const { client } = fakeExportConnection()
  const backup = await createBackup({ connect: async () => client })
  backup.data.products.rows.push({ id: '99' })

  await assert.rejects(
    verifyBackup(backup, { connect: async () => { throw new Error('must not connect') } }),
    (error) => error.code === 'BACKUP_CHECKSUM_MISMATCH',
  )
})

test('rejects re-checksummed malicious structure and SQL-shaped backup fields', async () => {
  const exported = fakeExportConnection({ stores: [{ id: '1' }] })
  const backup = { ...await createBackup({ connect: async () => exported.client }) }
  backup.data.stores.columns = ['id', 'id); DROP TABLE users; --']
  backup.data.stores.rows = [{ id: '1', 'id); DROP TABLE users; --': 'payload' }]
  resignBackup(backup)

  await assert.rejects(
    verifyBackup(backup, { connect: async () => { throw new Error('must not connect') } }),
    (error) => error.code === 'INVALID_BACKUP',
  )
})

test('rejects noncanonical timestamps, schema names, and checksum shapes', async () => {
  const { client } = fakeExportConnection()
  const backup = await createBackup({ connect: async () => client })
  for (const change of [
    { timestamp: '09/10/2026/../../escape' },
    { timestamp: '2026-99-99T99:99:99.999Z' },
    { schemaVersion: '../../malicious.sql' },
    { checksum: 'sha256:not-a-digest' },
  ]) {
    const hostile = { ...backup, ...change }
    if (!Object.hasOwn(change, 'checksum')) resignBackup(hostile)
    await assert.rejects(
      verifyBackup(hostile, { connect: async () => { throw new Error('must not connect') } }),
      (error) => ['INVALID_BACKUP', 'BACKUP_CHECKSUM_MISSING'].includes(error.code),
    )
  }
})

test('rejects a backup made by another schema version', async () => {
  const exported = fakeExportConnection()
  const backup = await createBackup({ connect: async () => exported.client })
  const verifying = fakeExportConnection()
  verifying.client.query = async (sql) => {
    if (sql.includes('FROM schema_migrations')) {
      return { rowCount: 1, rows: [{ name: '9999_future.sql' }] }
    }
    throw new Error('column lookup must not run after a version mismatch')
  }

  await assert.rejects(
    verifyBackup(backup, { connect: async () => verifying.client }),
    (error) => error.code === 'BACKUP_SCHEMA_MISMATCH',
  )
})

test('rolls back the whole restore if any table insert fails', async () => {
  const exported = fakeExportConnection({ stores: [{ id: '1' }] })
  const backup = await createBackup({ connect: async () => exported.client })
  const queries = []
  const restoreClient = {
    async query(sql) {
      queries.push(sql)
      if (sql.includes('FROM schema_migrations')) {
        return { rowCount: 1, rows: [{ name: schemaVersion }] }
      }
      if (sql.includes('FROM information_schema.columns')) {
        return { rowCount: 1, rows: [{ column_name: 'id' }] }
      }
      if (sql.includes('INSERT INTO "stores"')) throw new Error('simulated insert failure')
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }

  await assert.rejects(
    restoreBackup(backup, { connect: async () => restoreClient }),
    /simulated insert failure/,
  )
  assert.ok(queries.some((sql) => sql.startsWith('TRUNCATE TABLE')))
  assert.ok(queries.some((sql) => sql.includes('DISABLE TRIGGER')))
  assert.equal(queries.at(-1), 'ROLLBACK')
  assert.ok(!queries.includes('COMMIT'))
})

function resignBackup(backup) {
  const unsigned = { ...backup }
  delete unsigned.checksum
  backup.checksum = `sha256:${createHash('sha256').update(stableStringify(unsigned)).digest('hex')}`
}
