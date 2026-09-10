import { env } from '../config/env.js'
import { provisionAdmin } from '../auth/provision-admin.js'
import { pool } from './pool.js'
import { logSecurityEvent, safeErrorDetails } from '../security/security-log.js'

const developmentStores = [
  { code: 'AL_SALAM_ELECTRIC', name: 'كهرباء السلام' },
  { code: 'SHOWROOM', name: 'المعرض' },
]

async function run() {
  if (env.nodeEnv !== 'development') {
    throw new Error('Development seeds may only run with NODE_ENV=development.')
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    for (const store of developmentStores) {
      await client.query(
        `
          INSERT INTO stores (code, name, is_active)
          VALUES ($1, $2, TRUE)
          ON CONFLICT (code) DO NOTHING
        `,
        [store.code, store.name],
      )
    }

    await provisionAdmin(client, {
      username: env.adminUsername,
      password: env.adminPassword,
      displayName: env.adminDisplayName,
    })

    await client.query('COMMIT')
    console.log('Development seed applied: admin، كهرباء السلام، المعرض')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((error) => {
  logSecurityEvent('error', 'development_seed_failed', {
    ...safeErrorDetails(error),
    outcome: 'failure',
  })
  process.exitCode = 1
})
