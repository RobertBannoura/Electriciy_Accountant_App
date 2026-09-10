import { pool } from './pool.js'
import { logSecurityEvent, safeErrorDetails } from '../security/security-log.js'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function expectDatabaseError(client, name, expectedCode, operation) {
  await client.query(`SAVEPOINT ${name}`)
  let caught

  try {
    await operation()
  } catch (error) {
    caught = error
  }

  await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
  await client.query(`RELEASE SAVEPOINT ${name}`)
  assert(caught?.code === expectedCode, `${name} returned ${caught?.code ?? 'no error'}`)
}

async function run() {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const storesResult = await client.query(
      `
        SELECT id::TEXT AS id, code, name
        FROM stores
        WHERE code = ANY($1::TEXT[])
        ORDER BY code
      `,
      [['AL_SALAM_ELECTRIC', 'SHOWROOM']],
    )
    assert(storesResult.rowCount === 2, 'Both seeded stores must exist.')
    const salam = storesResult.rows.find((store) => store.code === 'AL_SALAM_ELECTRIC')
    const showroom = storesResult.rows.find((store) => store.code === 'SHOWROOM')
    assert(salam?.name === 'كهرباء السلام', 'The Al Salam seed name is incorrect.')
    assert(showroom?.name === 'المعرض', 'The showroom seed name is incorrect.')

    await client.query('UPDATE stores SET name = $1 WHERE id = $2::BIGINT', [
      'اسم عرض معدل للاختبار',
      salam.id,
    ])
    await client.query(
      `
        INSERT INTO stores (code, name, is_active)
        VALUES
          ('AL_SALAM_ELECTRIC', 'كهرباء السلام', TRUE),
          ('SHOWROOM', 'المعرض', TRUE)
        ON CONFLICT (code) DO NOTHING
      `,
    )
    const reseededStore = await client.query(
      'SELECT id::TEXT AS id, name FROM stores WHERE code = $1',
      ['AL_SALAM_ELECTRIC'],
    )
    assert(reseededStore.rows[0].id === salam.id, 'Store identity changed after reseeding.')
    assert(
      reseededStore.rows[0].name === 'اسم عرض معدل للاختبار',
      'Reseeding overwrote an edited display name.',
    )

    const customerResult = await client.query(
      'INSERT INTO customers (name) VALUES ($1) RETURNING id',
      ['عميل اختبار Group 2'],
    )
    const customerId = customerResult.rows[0].id

    for (const amount of ['0.50', '10', '10.50']) {
      await client.query(
        `
          INSERT INTO payments (
            store_id, customer_id, direction, original_amount, currency_code,
            converted_ils_amount, payment_method, paid_at
          )
          VALUES ($1, $2, 'inflow', $3::NUMERIC, 'ILS', $3::NUMERIC, 'cash', NOW())
        `,
        [salam.id, customerId, amount],
      )
    }

    await expectDatabaseError(client, 'invalid_ils_step', '23514', () =>
      client.query(
        `
          INSERT INTO payments (
            store_id, customer_id, direction, original_amount, currency_code,
            converted_ils_amount, payment_method, paid_at
          )
          VALUES ($1, $2, 'inflow', 10.25, 'ILS', 10.25, 'cash', NOW())
        `,
        [salam.id, customerId],
      ),
    )

    const preciseRate = '3.123456789012345678901234567890123456789'
    const preciseConverted = '312.3456789012345678901234567890123456789'
    const foreignResult = await client.query(
      `
        INSERT INTO payments (
          store_id, customer_id, direction, original_amount, currency_code,
          exchange_rate, converted_ils_amount, payment_method, paid_at
        )
        VALUES
          ($1, $2, 'inflow', 100.00, 'USD', $3::NUMERIC, $4::NUMERIC, 'cash', NOW()),
          ($1, $2, 'inflow', 5.000, 'JOD', 5.00, 25.00000, 'cash', NOW())
        RETURNING currency_code, exchange_rate::TEXT, converted_ils_amount::TEXT
      `,
      [salam.id, customerId, preciseRate, preciseConverted],
    )
    const usd = foreignResult.rows.find((payment) => payment.currency_code === 'USD')
    assert(usd.exchange_rate === preciseRate, 'PostgreSQL changed FX rate precision.')
    assert(
      usd.converted_ils_amount === preciseConverted,
      'PostgreSQL changed the converted ILS snapshot.',
    )

    for (const [savepoint, rate] of [['zero_fx', '0'], ['negative_fx', '-1']]) {
      await expectDatabaseError(client, savepoint, '23514', () =>
        client.query(
          `
            INSERT INTO payments (
              store_id, customer_id, direction, original_amount, currency_code,
              exchange_rate, converted_ils_amount, payment_method, paid_at
            )
            VALUES ($1, $2, 'inflow', 1, 'USD', $3::NUMERIC, $3::NUMERIC, 'cash', NOW())
          `,
          [salam.id, customerId, rate],
        ),
      )
    }

    await expectDatabaseError(client, 'unsupported_currency', '23514', () =>
      client.query(
        `
          INSERT INTO payments (
            store_id, customer_id, direction, original_amount, currency_code,
            exchange_rate, converted_ils_amount, payment_method, paid_at
          )
          VALUES ($1, $2, 'inflow', 1, 'EUR', 4, 4, 'cash', NOW())
        `,
        [salam.id, customerId],
      ),
    )
    await expectDatabaseError(client, 'malformed_decimal', '22P02', () =>
      client.query('SELECT $1::NUMERIC', ['not-a-decimal']),
    )

    const adminResult = await client.query(
      "SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE LIMIT 1",
    )
    assert(adminResult.rowCount === 1, 'An active admin was not provisioned.')
    await expectDatabaseError(client, 'unsupported_role', '23514', () =>
      client.query(
        `
          INSERT INTO users (username, password_hash, display_name, role)
          VALUES ('group2-non-admin', 'not-used', 'اختبار', 'cashier')
        `,
      ),
    )
    await expectDatabaseError(client, 'invalid_session_expiry', '23514', () =>
      client.query(
        `
          INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at)
          VALUES ($1, $2, NOW(), NOW())
        `,
        [adminResult.rows[0].id, 'a'.repeat(64)],
      ),
    )

    const authColumns = await client.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'auth_sessions'
      `,
    )
    const authColumnNames = new Set(authColumns.rows.map((row) => row.column_name))
    assert(authColumnNames.has('token_hash'), 'auth_sessions.token_hash is missing.')
    assert(!authColumnNames.has('token'), 'A raw session token column exists.')

    const deviceSchema = await client.query(
      `
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            table_name IN ('device_assignments', 'store_devices')
            OR column_name IN ('device_store_id', 'assigned_device_id')
          )
      `,
    )
    assert(deviceSchema.rowCount === 0, 'Device assignment is persisted in PostgreSQL.')

    console.log(
      'Group 2 database verification passed: money constraints, precise FX snapshots, stable stores, idempotent seeds, admin-only roles, hashed-session schema, and no device assignment schema.',
    )
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    await pool.end()
  }
}

run().catch((error) => {
  logSecurityEvent('error', 'database_verification_failed', {
    ...safeErrorDetails(error),
    outcome: 'failure',
  })
  process.exitCode = 1
})
