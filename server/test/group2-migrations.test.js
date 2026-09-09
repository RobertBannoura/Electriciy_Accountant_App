import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = (name) => new URL(`../db/migrations/${name}`, import.meta.url)

test('payment migration enforces the application money rules in PostgreSQL', async () => {
  const sql = await readFile(migrationUrl('0002_payment_money_snapshot.sql'), 'utf8')
  const statements = sql.replace(/^\s*--.*$/gm, '')

  assert.match(sql, /currency_code IN \('ILS', 'USD', 'JOD'\)/)
  assert.match(sql, /original_amount >= 0/)
  assert.match(sql, /converted_ils_amount >= 0/)
  assert.match(sql, /MOD\(original_amount, 0\.50\) = 0/)
  assert.match(sql, /exchange_rate > 0/)
  assert.match(sql, /converted_ils_amount = original_amount \* exchange_rate/)
  assert.doesNotMatch(statements, /\b(?:REAL|FLOAT|DOUBLE PRECISION|MONEY)\b/i)
  assert.doesNotMatch(sql, /exchange_rate_id/i)
})

test('store seed keeps stable identities and never overwrites edited names', async () => {
  const sql = await readFile(migrationUrl('0003_seed_stores.sql'), 'utf8')

  assert.match(sql, /'AL_SALAM_ELECTRIC', 'كهرباء السلام'/)
  assert.match(sql, /'SHOWROOM', 'المعرض'/)
  assert.match(sql, /ON CONFLICT \(code\) DO NOTHING/)
  assert.doesNotMatch(sql, /DO UPDATE/i)
})

test('authentication migration permits only admin and stores token hashes', async () => {
  const sql = await readFile(migrationUrl('0004_admin_authentication.sql'), 'utf8')

  assert.match(sql, /CHECK \(role = 'admin'\)/)
  assert.match(sql, /token_hash CHAR\(64\) NOT NULL UNIQUE/)
  assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL/)
  assert.match(sql, /expires_at > created_at/)
  assert.doesNotMatch(sql, /\btoken\s+(?:TEXT|VARCHAR|CHAR)/i)
})

test('Group 2 database migrations contain no device assignment persistence', async () => {
  const names = [
    '0001_foundational_schema.sql',
    '0002_payment_money_snapshot.sql',
    '0003_seed_stores.sql',
    '0004_admin_authentication.sql',
  ]
  const sql = (
    await Promise.all(names.map((name) => readFile(migrationUrl(name), 'utf8')))
  ).join('\n')

  assert.doesNotMatch(sql, /(?:device_store|store_device|device_assignment)/i)
})
