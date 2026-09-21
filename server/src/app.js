import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { env } from './config/env.js'
import { errorHandler, notFoundHandler } from './middleware/error-handler.js'
import { requireAdmin } from './middleware/require-admin.js'
import { requireAuth } from './middleware/require-auth.js'
import {
  createJsonComplexityGuard,
  createOriginGuard,
  createProxyClientIpNormalizer,
  isDevelopmentBrowserOrigin,
  validateRequestMetadata,
} from './middleware/request-boundaries.js'
import { authRouter } from './routes/auth.js'
import { backupsRouter } from './routes/backups.js'
import { categoriesRouter } from './routes/categories.js'
import { checksRouter } from './routes/checks.js'
import { customersRouter } from './routes/customers.js'
import { expensesRouter } from './routes/expenses.js'
import { healthRouter } from './routes/health.js'
import { productsRouter } from './routes/products.js'
import { pushRouter } from './routes/push.js'
import { purchasesRouter } from './routes/purchases.js'
import { reportsRouter } from './routes/reports.js'
import { returnsRouter } from './routes/returns.js'
import { maintenanceRouter } from './routes/maintenance.js'
import { salesRouter } from './routes/sales.js'
import { storesRouter } from './routes/stores.js'
import { suppliersRouter } from './routes/suppliers.js'
import { verificationRouter } from './routes/verification.js'

export const app = express()
const normalJsonBoundary = createJsonComplexityGuard({ maxDepth: 32, maxNodes: 20_000 })
const backupJsonBoundary = createJsonComplexityGuard({ maxDepth: 32, maxNodes: 2_000_000 })
const trustedBrowserOrigins = [env.clientOrigin, env.electronOrigin]
const corsOrigin = env.nodeEnv === 'development'
  ? (origin, callback) => {
      if (!origin || trustedBrowserOrigins.includes(origin) || isDevelopmentBrowserOrigin(origin)) {
        callback(null, true)
        return
      }
      callback(null, false)
    }
  : trustedBrowserOrigins

app.disable('x-powered-by')
app.set(
  'trust proxy',
  env.trustedProxyRanges.length > 0 ? env.trustedProxyRanges : false,
)
app.use(helmet({
  frameguard: { action: 'deny' },
  strictTransportSecurity: false,
}))
app.use('/api', createProxyClientIpNormalizer(env.proxyClientIpHeader))
app.use('/api', (_request, response, next) => {
  response.set('Cache-Control', 'no-store')
  response.set('Content-Security-Policy', "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  response.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()')
  next()
})
app.use('/api', validateRequestMetadata)
app.use('/api', createOriginGuard(trustedBrowserOrigins, {
  allowDevelopmentBrowserOrigins: env.nodeEnv === 'development',
}))
app.use(
  cors({
    origin: corsOrigin,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Store-Id',
      'X-Confirm-Restore',
      'X-Request-Id',
    ],
  }),
)
app.use('/api/health', healthRouter)
app.use('/api/auth', express.json({ limit: '1mb' }), normalJsonBoundary, authRouter)
app.use('/api/backups', requireAuth, requireAdmin, express.json({ limit: '100mb' }), backupJsonBoundary, backupsRouter)
app.use(express.json({ limit: '1mb' }))
app.use(normalJsonBoundary)
app.use('/api', requireAuth)
app.use('/api', requireAdmin)
app.use('/api/stores', storesRouter)
app.use('/api/categories', categoriesRouter)
app.use('/api/checks', checksRouter)
app.use('/api/customers', customersRouter)
app.use('/api/expenses', expensesRouter)
app.use('/api/products', productsRouter)
app.use('/api/push', pushRouter)
app.use('/api/purchases', purchasesRouter)
app.use('/api/reports', reportsRouter)
app.use('/api/returns', returnsRouter)
app.use('/api/maintenance', maintenanceRouter)
app.use('/api/sales', salesRouter)
app.use('/api/suppliers', suppliersRouter)
app.use('/api/verification', verificationRouter)

app.use(notFoundHandler)
app.use(errorHandler)
