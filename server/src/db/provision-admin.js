import { provisionAdmin } from '../auth/provision-admin.js'
import { env } from '../config/env.js'
import { pool } from './pool.js'

async function run() {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    const admin = await provisionAdmin(client, {
      username: env.adminUsername,
      password: env.adminPassword,
      displayName: env.adminDisplayName,
    })
    await client.query('COMMIT')
    console.log(`Admin provisioned: ${admin.username}`)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((error) => {
  console.error('Admin provisioning failed:', error)
  process.exitCode = 1
})
