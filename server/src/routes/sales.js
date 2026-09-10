import { Router } from 'express'
import { AppError } from '../errors/app-error.js'
import { requireStore } from '../middleware/require-store.js'
import { createSale } from '../sales/create-sale.js'
import { parseSaleInput } from '../sales/sale-input.js'
import { notifySaleCreated } from '../notifications/financial-notifications.js'
import {
  financialOperation,
  requireFinancialRequestId,
} from '../financial/financial-operation.js'

export const salesRouter = Router()

salesRouter.use(requireStore)

salesRouter.post('/', requireFinancialRequestId, async (request, response) => {
  const parsed = parseSaleInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_SALE')
  }

  const sale = await createSale({
    input: parsed.value,
    storeId: request.storeId,
    userId: request.auth.user.id,
    operation: financialOperation(request, 'sale:create', {
      storeId: request.storeId,
      input: parsed.value,
    }),
  })

  await notifySaleCreated({ sale, storeId: request.storeId })

  response.status(201).json({ sale })
})
