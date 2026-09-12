import assert from 'node:assert/strict'
import test from 'node:test'

const databaseUrl = process.env.GROUP9_INTEGRATION_DATABASE_URL

test(
  'Group 9 backup, transactional restore, and financial verification work against PostgreSQL',
  { skip: databaseUrl ? false : 'GROUP9_INTEGRATION_DATABASE_URL is not configured' },
  async () => {
    process.env.DATABASE_URL = databaseUrl
    process.env.NODE_ENV = 'test'

    const [{ pool }, backupService, verificationService] = await Promise.all([
      import('../src/db/pool.js'),
      import('../src/backups/backup-service.js'),
      import('../src/verification/financial-verification.js'),
    ])

    const triggerName = 'group9_force_restore_rollback'
    const functionName = `${triggerName}_fn`

    try {
      const identity = await pool.query('SELECT current_database() AS database_name')
      assert.equal(identity.rows[0].database_name, 'group9_backup')

      await pool.query(
        `INSERT INTO system_settings (store_id, key, value)
         VALUES (NULL, 'group9_restore_probe', $1::JSONB)
         ON CONFLICT (store_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify('before-backup')],
      )

      const backup = await backupService.createBackup({
        now: () => new Date('2026-09-09T12:34:56.000Z'),
      })
      assert.equal(backup.timestamp, '2026-09-09T12:34:56.000Z')
      assert.match(backup.checksum, /^sha256:[a-f0-9]{64}$/)
      assert.equal(backup.schemaVersion, '0026_manual_purchase_items.sql')
      const verified = await backupService.verifyBackup(backup)
      assert.equal(verified.timestamp, backup.timestamp)
      assert.equal(verified.counts.settings >= 1, true)

      const tampered = structuredClone(backup)
      tampered.timestamp = '2026-09-10T00:00:00.000Z'
      await assert.rejects(
        backupService.verifyBackup(tampered),
        (error) => error?.code === 'BACKUP_CHECKSUM_MISMATCH',
      )

      await setProbeValue(pool, 'after-backup')
      await pool.query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.key = 'group9_restore_probe' THEN
            RAISE EXCEPTION 'forced Group 9 restore rollback';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER ${triggerName} BEFORE INSERT ON system_settings
        FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `)

      await assert.rejects(
        backupService.restoreBackup(backup),
        /forced Group 9 restore rollback/,
      )
      assert.equal(await probeValue(pool), 'after-backup')

      await pool.query(`DROP TRIGGER ${triggerName} ON system_settings`)
      await pool.query(`DROP FUNCTION ${functionName}()`)

      const restored = await backupService.restoreBackup(backup)
      assert.equal(restored.schemaVersion, backup.schemaVersion)
      assert.equal(await probeValue(pool), 'before-backup')
      const restoreAudit = await pool.query(
        "SELECT COUNT(*)::INTEGER AS count FROM audit_log WHERE action = 'restore'",
      )
      assert.equal(restoreAudit.rows[0].count, 1)

      const accounts = await verificationService.verifyFinancialAccounts({
        now: () => new Date('2026-09-09T12:35:00.000Z'),
      })
      assert.equal(accounts.status, 'ok')
      assert.deepEqual(
        accounts.sections.map(({ key, status, issueCount }) => ({ key, status, issueCount })),
        ['sales', 'customers', 'suppliers', 'inventory', 'cash', 'bank', 'checks', 'reversals']
          .map((key) => ({ key, status: 'ok', issueCount: 0 })),
      )
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON system_settings`).catch(() => {})
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => {})
      await pool.end()
    }
  },
)

async function setProbeValue(pool, value) {
  await pool.query(
    "UPDATE system_settings SET value = $1::JSONB WHERE store_id IS NULL AND key = 'group9_restore_probe'",
    [JSON.stringify(value)],
  )
}

async function probeValue(pool) {
  const result = await pool.query(
    "SELECT value FROM system_settings WHERE store_id IS NULL AND key = 'group9_restore_probe'",
  )
  assert.equal(result.rowCount, 1)
  return result.rows[0].value
}
