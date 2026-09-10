import pg from 'pg'
import { env } from '../config/env.js'
import { logSecurityEvent, safeErrorDetails } from '../security/security-log.js'

const { Pool } = pg

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: env.databaseTls,
  enableChannelBinding: env.nodeEnv === 'production',
})

pool.on('error', (error) => {
  logSecurityEvent('error', 'postgres_pool_error', {
    ...safeErrorDetails(error),
    outcome: 'failure',
  })
})

export function query(text, params) {
  return pool.query(text, params)
}
