import { createHash } from 'node:crypto'
import { writeAuditEntry } from '../audit/write-audit-entry.js'
import { pool } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { claimFinancialOperation } from '../financial/financial-operation.js'

export const BACKUP_FORMAT = 'electricity-accountant-backup'
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_CONTENTS = Object.freeze([
  'products',
  'inventory',
  'customers',
  'projects',
  'suppliers',
  'sales',
  'purchases',
  'payments',
  'ledgers',
  'checks',
  'expenses',
  'important-settings',
])

// The object keys are part of the portable backup format. The table names are
// server-owned constants and are never accepted from a request.
export const backupTables = Object.freeze([
  { key: 'stores', table: 'stores', orderBy: 'id' },
  { key: 'expenseCategories', table: 'expense_categories', orderBy: 'sort_order, name' },
  { key: 'categories', table: 'categories', orderBy: 'id' },
  { key: 'products', table: 'products', orderBy: 'id' },
  { key: 'barcodes', table: 'barcodes', orderBy: 'id' },
  { key: 'inventory', table: 'store_inventory', orderBy: 'store_id, product_id' },
  { key: 'customers', table: 'customers', orderBy: 'id' },
  { key: 'projects', table: 'customer_projects', orderBy: 'id' },
  { key: 'suppliers', table: 'suppliers', orderBy: 'id' },
  { key: 'sales', table: 'sales', orderBy: 'id' },
  { key: 'saleItems', table: 'sale_items', orderBy: 'id' },
  { key: 'purchases', table: 'purchases', orderBy: 'id' },
  { key: 'purchaseItems', table: 'purchase_items', orderBy: 'id' },
  { key: 'maintenanceRecords', table: 'maintenance_records', orderBy: 'id' },
  { key: 'maintenanceReversals', table: 'maintenance_reversals', orderBy: 'id' },
  { key: 'payments', table: 'payments', orderBy: 'id' },
  { key: 'checks', table: 'checks', orderBy: 'id' },
  { key: 'customerReturns', table: 'customer_returns', orderBy: 'id' },
  { key: 'customerReturnItems', table: 'customer_return_items', orderBy: 'id' },
  { key: 'supplierReturns', table: 'supplier_returns', orderBy: 'id' },
  { key: 'supplierReturnItems', table: 'supplier_return_items', orderBy: 'id' },
  { key: 'inventoryMovements', table: 'inventory_movements', orderBy: 'id' },
  { key: 'inventoryCostMovements', table: 'inventory_cost_movements', orderBy: 'id' },
  { key: 'customerLedger', table: 'customer_ledger', orderBy: 'id' },
  { key: 'supplierLedger', table: 'supplier_ledger', orderBy: 'id' },
  { key: 'financialMovements', table: 'financial_movements', orderBy: 'id' },
  { key: 'bankMovements', table: 'bank_movements', orderBy: 'id' },
  { key: 'expenses', table: 'expenses', orderBy: 'id' },
  { key: 'settings', table: 'system_settings', orderBy: 'id' },
  { key: 'auditLog', table: 'audit_log', orderBy: 'id' },
  { key: 'notificationPreferences', table: 'push_notification_preferences', orderBy: 'user_id' },
  { key: 'notificationEvents', table: 'push_notification_events', orderBy: 'id' },
])

const customSequences = Object.freeze([
  'generated_barcode_sequence',
  'customer_return_document_sequence',
  'supplier_return_document_sequence',
])

const migrationLockId = 439_127_401
const restoreLockId = 439_127_409
const identifierPattern = /^[a-z][a-z0-9_]*$/
const backupTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const schemaVersionPattern = /^\d{4}_[A-Za-z0-9_-]+\.sql$/

function isCanonicalBackupTimestamp(value) {
  if (typeof value !== 'string' || !backupTimestampPattern.test(value)) return false
  const timestamp = new Date(value)
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value
}

function quoteIdentifier(identifier) {
  if (!identifierPattern.test(identifier)) throw new TypeError('Unsafe database identifier')
  return `"${identifier}"`
}

export function stableStringify(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
  return `{${entries.join(',')}}`
}

function checksumFor(unsignedBackup) {
  return `sha256:${createHash('sha256').update(stableStringify(unsignedBackup)).digest('hex')}`
}

function invalidBackup(message, code = 'INVALID_BACKUP') {
  return new AppError(message, 400, code)
}

async function readSchemaVersion(client) {
  const result = await client.query(
    'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
  )
  if (result.rowCount !== 1) {
    throw new AppError('تعذر تحديد إصدار مخطط قاعدة البيانات', 500, 'SCHEMA_VERSION_UNAVAILABLE')
  }
  return result.rows[0].name
}

async function readColumns(client, table) {
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
    [table],
  )
  if (result.rowCount === 0) {
    throw new AppError(`جدول النسخ الاحتياطي غير موجود: ${table}`, 500, 'BACKUP_TABLE_UNAVAILABLE')
  }
  return result.rows.map((row) => row.column_name)
}

async function readCustomSequences(client) {
  const values = {}
  for (const sequence of customSequences) {
    const result = await client.query(
      `SELECT last_value::TEXT AS last_value, is_called FROM ${quoteIdentifier(sequence)}`,
    )
    values[sequence] = result.rows[0]
  }
  return values
}

export async function createBackup({ connect = () => pool.connect(), now = () => new Date() } = {}) {
  const client = await connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [migrationLockId])
    const schemaVersion = await readSchemaVersion(client)
    const data = {}

    for (const definition of backupTables) {
      const columns = await readColumns(client, definition.table)
      const rows = await client.query(
        `SELECT * FROM ${quoteIdentifier(definition.table)} ORDER BY ${definition.orderBy}`,
      )
      data[definition.key] = { columns, rows: rows.rows }
    }

    const unsignedBackup = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      contents: BACKUP_CONTENTS,
      schemaVersion,
      timestamp: now().toISOString(),
      sequences: await readCustomSequences(client),
      data,
    }
    await client.query('COMMIT')
    return Object.freeze({ ...unsignedBackup, checksum: checksumFor(unsignedBackup) })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidBackup(message)
  return value
}

function assertBackupEnvelope(backup) {
  assertPlainObject(backup, 'ملف النسخة الاحتياطية غير صالح')
  if (backup.format !== BACKUP_FORMAT || backup.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw invalidBackup('تنسيق ملف النسخة الاحتياطية غير مدعوم', 'UNSUPPORTED_BACKUP_FORMAT')
  }
  if (!Array.isArray(backup.contents)
    || backup.contents.join('\0') !== BACKUP_CONTENTS.join('\0')) {
    throw invalidBackup('بيان محتويات النسخة الاحتياطية غير مكتمل')
  }
  if (typeof backup.schemaVersion !== 'string'
    || !schemaVersionPattern.test(backup.schemaVersion)
    || backup.schemaVersion.length > 128) {
    throw invalidBackup('إصدار مخطط النسخة الاحتياطية مفقود')
  }
  if (!isCanonicalBackupTimestamp(backup.timestamp)) {
    throw invalidBackup('تاريخ النسخة الاحتياطية غير صالح')
  }
  if (typeof backup.checksum !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(backup.checksum)) {
    throw invalidBackup('بصمة النسخة الاحتياطية مفقودة', 'BACKUP_CHECKSUM_MISSING')
  }

  const { checksum, ...unsignedBackup } = backup
  if (checksumFor(unsignedBackup) !== checksum) {
    throw invalidBackup('فشل التحقق من بصمة النسخة الاحتياطية', 'BACKUP_CHECKSUM_MISMATCH')
  }

  const data = assertPlainObject(backup.data, 'بيانات النسخة الاحتياطية مفقودة')
  const expectedKeys = backupTables.map(({ key }) => key).sort()
  if (Object.keys(data).sort().join('\0') !== expectedKeys.join('\0')) {
    throw invalidBackup('أقسام النسخة الاحتياطية غير مكتملة')
  }

  for (const { key } of backupTables) {
    const section = assertPlainObject(data[key], `قسم ${key} غير صالح`)
    if (!Array.isArray(section.columns)
      || !section.columns.every((column) => typeof column === 'string' && identifierPattern.test(column))) {
      throw invalidBackup(`أعمدة قسم ${key} غير صالحة`)
    }
    if (!Array.isArray(section.rows)) throw invalidBackup(`صفوف قسم ${key} غير صالحة`)
    const expectedColumns = [...section.columns].sort().join('\0')
    if (new Set(section.columns).size !== section.columns.length) {
      throw invalidBackup(`أعمدة قسم ${key} مكررة`)
    }
    for (const row of section.rows) {
      assertPlainObject(row, `أحد صفوف قسم ${key} غير صالح`)
      if (Object.keys(row).sort().join('\0') !== expectedColumns) {
        throw invalidBackup(`بنية أحد صفوف قسم ${key} غير مطابقة`)
      }
    }
  }

  const sequences = assertPlainObject(backup.sequences, 'حالة تسلسلات قاعدة البيانات مفقودة')
  if (Object.keys(sequences).sort().join('\0') !== [...customSequences].sort().join('\0')) {
    throw invalidBackup('حالة تسلسلات قاعدة البيانات غير مكتملة')
  }
  for (const sequence of customSequences) {
    const state = assertPlainObject(sequences[sequence], `حالة التسلسل ${sequence} غير صالحة`)
    if (!/^[1-9]\d*$/.test(state.last_value)
      || BigInt(state.last_value) > 9_223_372_036_854_775_807n
      || typeof state.is_called !== 'boolean') {
      throw invalidBackup(`حالة التسلسل ${sequence} غير صالحة`)
    }
  }

  return backup
}

function sortCategories(rows) {
  const pending = new Map(rows.map((row) => [String(row.id), row]))
  const inserted = new Set()
  const ordered = []
  while (pending.size > 0) {
    let progressed = false
    for (const [id, row] of pending) {
      if (row.parent_id === null || inserted.has(String(row.parent_id))) {
        ordered.push(row)
        inserted.add(id)
        pending.delete(id)
        progressed = true
      }
    }
    if (!progressed) throw invalidBackup('علاقات تصنيفات المنتجات في النسخة غير قابلة للاستعادة')
  }
  return ordered
}

async function assertCurrentSchema(client, backup) {
  const currentVersion = await readSchemaVersion(client)
  if (currentVersion !== backup.schemaVersion) {
    throw invalidBackup(
      `إصدار النسخة (${backup.schemaVersion}) لا يطابق إصدار النظام (${currentVersion})`,
      'BACKUP_SCHEMA_MISMATCH',
    )
  }

  for (const definition of backupTables) {
    const currentColumns = await readColumns(client, definition.table)
    const backupColumns = backup.data[definition.key].columns
    if (currentColumns.join('\0') !== backupColumns.join('\0')) {
      throw invalidBackup(`مخطط جدول ${definition.table} لا يطابق النسخة`, 'BACKUP_SCHEMA_MISMATCH')
    }
  }
}

export async function verifyBackup(backup, { connect = () => pool.connect() } = {}) {
  const validated = assertBackupEnvelope(backup)
  const client = await connect()
  try {
    await assertCurrentSchema(client, validated)
  } finally {
    client.release()
  }

  return {
    timestamp: validated.timestamp,
    schemaVersion: validated.schemaVersion,
    counts: Object.fromEntries(backupTables.map(({ key }) => [key, validated.data[key].rows.length])),
  }
}

async function insertSection(client, definition, section) {
  if (section.rows.length === 0) return
  const rows = definition.key === 'categories' ? sortCategories(section.rows) : section.rows
  await client.query(
    `
      INSERT INTO ${quoteIdentifier(definition.table)} OVERRIDING SYSTEM VALUE
      SELECT * FROM jsonb_populate_recordset(NULL::${quoteIdentifier(definition.table)}, $1::JSONB)
    `,
    [JSON.stringify(rows)],
  )
}

async function synchronizeIdentitySequence(client, table) {
  await client.query(
    `
      SELECT setval(
        pg_get_serial_sequence($1, 'id'),
        COALESCE((SELECT MAX(id) FROM ${quoteIdentifier(table)}), 1),
        EXISTS (SELECT 1 FROM ${quoteIdentifier(table)})
      )
    `,
    [table],
  )
}

async function readLegacyCheckConstraints(client) {
  const result = await client.query(`
    SELECT
      tables.relname AS table_name,
      constraints.conname AS constraint_name,
      pg_get_constraintdef(constraints.oid, TRUE) AS definition
    FROM pg_constraint AS constraints
    INNER JOIN pg_class AS tables ON tables.oid = constraints.conrelid
    INNER JOIN pg_namespace AS namespaces ON namespaces.oid = tables.relnamespace
    WHERE namespaces.nspname = 'public'
      AND constraints.contype = 'c'
      AND constraints.convalidated = FALSE
    ORDER BY tables.relname, constraints.conname
  `)
  return result.rows
}

async function suspendLegacyInsertGuards(client) {
  const constraints = await readLegacyCheckConstraints(client)
  for (const constraint of constraints) {
    await client.query(
      `ALTER TABLE ${quoteIdentifier(constraint.table_name)} DROP CONSTRAINT ${quoteIdentifier(constraint.constraint_name)}`,
    )
  }
  // Rows that predate migration 0020 intentionally have no one-to-one cost
  // movement. The current constraint trigger only applies to newly-created
  // movements, so it must not be applied retroactively during a restore.
  await client.query(
    'ALTER TABLE "inventory_movements" DISABLE TRIGGER "inventory_movements_require_cost"',
  )
  return constraints
}

async function restoreLegacyInsertGuards(client, constraints) {
  await client.query(
    'ALTER TABLE "inventory_movements" ENABLE TRIGGER "inventory_movements_require_cost"',
  )
  for (const constraint of constraints) {
    const definition = constraint.definition.replace(/\s+NOT VALID\s*$/i, '')
    await client.query(
      `ALTER TABLE ${quoteIdentifier(constraint.table_name)} ADD CONSTRAINT ${quoteIdentifier(constraint.constraint_name)} ${definition} NOT VALID`,
    )
  }
}

export async function restoreBackup(
  backup,
  {
    connect = () => pool.connect(), userId = null, requestId = null,
    ipAddress = null, operation = null,
  } = {},
) {
  const validated = assertBackupEnvelope(backup)
  const client = await connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await claimFinancialOperation(client, { userId, operation })
    await client.query('SELECT pg_advisory_xact_lock($1)', [migrationLockId])
    await client.query('SELECT pg_advisory_xact_lock($1)', [restoreLockId])
    await assertCurrentSchema(client, validated)

    const tables = backupTables.map(({ table }) => quoteIdentifier(table)).join(', ')
    // CASCADE also clears device-specific push subscriptions that refer to the
    // restored stores. Authentication users and sessions remain intact.
    await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`)
    await client.query('SET CONSTRAINTS ALL DEFERRED')
    const legacyConstraints = await suspendLegacyInsertGuards(client)

    for (const definition of backupTables) {
      await insertSection(client, definition, validated.data[definition.key])
    }

    for (const definition of backupTables) {
      if (definition.key === 'inventory' || definition.key === 'expenseCategories'
        || definition.key === 'notificationPreferences') continue
      await synchronizeIdentitySequence(client, definition.table)
    }
    for (const sequence of customSequences) {
      const state = validated.sequences[sequence]
      await client.query('SELECT setval($1::regclass, $2::BIGINT, $3)', [sequence, state.last_value, state.is_called])
    }
    await restoreLegacyInsertGuards(client, legacyConstraints)

    await writeAuditEntry(client, {
      userId,
      action: 'restore',
      entityType: 'system_backup',
      newValues: {
        timestamp: validated.timestamp,
        schemaVersion: validated.schemaVersion,
        checksum: validated.checksum,
      },
      requestId,
      ipAddress,
    })

    await client.query('COMMIT')
    return {
      timestamp: validated.timestamp,
      schemaVersion: validated.schemaVersion,
      counts: Object.fromEntries(backupTables.map(({ key }) => [key, validated.data[key].rows.length])),
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
