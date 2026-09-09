import pg from 'pg'
import { env } from '../config/env.js'

const { Pool } = pg

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl:
    env.nodeEnv === 'production'
      ? { rejectUnauthorized: true }
      : false,
})

pool.on('error', (error) => {
  console.error('خطأ غير متوقع في اتصال PostgreSQL:', error)
})

export function query(text, params) {
  return pool.query(text, params)
}
