import { Router } from 'express'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { requireStore } from '../middleware/require-store.js'
import { createPurchase } from '../purchases/create-purchase.js'
import { parsePurchaseInput } from '../purchases/purchase-input.js'
import { notifyPurchaseCreated } from '../notifications/financial-notifications.js'

export const purchasesRouter = Router()

purchasesRouter.use(requireStore)

purchasesRouter.get('/', async (request, response) => {
  const result = await query(
    `
      SELECT purchases.id::TEXT AS id, purchases.document_number,
        purchases.business_date::TEXT AS business_date, purchases.status,
        purchases.total::TEXT AS total, purchases.paid_total::TEXT AS paid_total,
        purchases.remaining_due::TEXT AS remaining_due,
        suppliers.id::TEXT AS supplier_id, suppliers.name AS supplier_name,
        stores.name AS store_name
      FROM purchases
      INNER JOIN suppliers ON suppliers.id = purchases.supplier_id
      INNER JOIN stores ON stores.id = purchases.store_id
      WHERE purchases.store_id = $1::BIGINT
      ORDER BY purchases.business_date DESC, purchases.id DESC
      LIMIT 100
    `,
    [request.storeId],
  )
  response.json({ purchases: result.rows })
})

purchasesRouter.post('/', async (request, response) => {
  const parsed = parsePurchaseInput(request.body)
  if (parsed.error) throw new AppError(parsed.error, 400, 'INVALID_PURCHASE')
  const purchase = await createPurchase({
    input: parsed.value,
    storeId: request.storeId,
    userId: request.auth.user.id,
  })
  await notifyPurchaseCreated({ purchase })
  response.status(201).json({ purchase })
})
