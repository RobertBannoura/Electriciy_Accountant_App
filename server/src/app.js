import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { env } from './config/env.js'
import { errorHandler, notFoundHandler } from './middleware/error-handler.js'
import { requireAuth } from './middleware/require-auth.js'
import { authRouter } from './routes/auth.js'
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

export const app = express()

app.disable('x-powered-by')
app.use(helmet())
app.use(
  cors({
    origin: [env.clientOrigin, env.electronOrigin],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Store-Id'],
  }),
)
app.use(express.json({ limit: '1mb' }))

app.use('/api/health', healthRouter)
app.use('/api/auth', authRouter)
app.use('/api', requireAuth)
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

app.use(notFoundHandler)
app.use(errorHandler)
