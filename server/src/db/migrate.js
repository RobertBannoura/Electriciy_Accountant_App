import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './pool.js'
import { logSecurityEvent, safeErrorDetails } from '../security/security-log.js'

const migrationsDirectory = fileURLToPath(
  new URL('../../db/migrations/', import.meta.url),
)
const migrationLockId = 439_127_401

function checksum(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function loadMigrations() {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true })
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))

  return Promise.all(
    filenames.map(async (name) => {
      const sql = await readFile(path.join(migrationsDirectory, name), 'utf8')
      return { name, sql, checksum: checksum(sql) }
    }),
  )
}

async function run() {
  const migrations = await loadMigrations()
  const client = await pool.connect()

  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockId])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    const appliedResult = await client.query(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    )
    const applied = new Map(
      appliedResult.rows.map((migration) => [migration.name, migration.checksum]),
    )

    for (const migration of migrations) {
      const appliedChecksum = applied.get(migration.name)

      if (appliedChecksum && appliedChecksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} was modified after it was applied.`,
        )
      }

      if (appliedChecksum) {
        console.log(`Already applied: ${migration.name}`)
        continue
      }

      console.log(`Applying: ${migration.name}`)
      await client.query('BEGIN')

      try {
        // Migration SQL is trusted, version-controlled DDL. Runtime values are
        // never interpolated into it; metadata writes below are parameterized.
        await client.query(migration.sql)
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }

    console.log('Database migrations are up to date.')
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId]).catch(
      () => {},
    )
    client.release()
    await pool.end()
  }
}

run().catch((error) => {
  logSecurityEvent('error', 'database_migration_failed', {
    ...safeErrorDetails(error),
    outcome: 'failure',
  })
  process.exitCode = 1
})
