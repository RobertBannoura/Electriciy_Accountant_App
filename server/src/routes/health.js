import { Router } from 'express'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'

export const healthRouter = Router()

healthRouter.get('/', (_request, response) => {
  response.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
})

healthRouter.get('/readiness', async (_request, response) => {
  try {
    await query('SELECT 1')
  } catch (error) {
    throw new AppError(
      'الخادم يعمل، لكن قاعدة البيانات غير متاحة',
      503,
      'DATABASE_UNAVAILABLE',
      { cause: error },
    )
  }

  response.json({
    status: 'ok',
    database: 'connected',
    timestamp: new Date().toISOString(),
  })
})
