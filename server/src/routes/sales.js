import { Router } from 'express'
import { AppError } from '../errors/app-error.js'
import { requireStore } from '../middleware/require-store.js'
import { createSale } from '../sales/create-sale.js'
import { parseSaleInput } from '../sales/sale-input.js'
import { notifySaleCreated } from '../notifications/financial-notifications.js'
import { query } from '../db/pool.js'
import { parseStoreId } from '../stores/store-input.js'
import {
  financialOperation,
  requireFinancialRequestId,
} from '../financial/financial-operation.js'

export const salesRouter = Router()

salesRouter.use(requireStore)

salesRouter.get('/:saleId', async (request, response) => {
  const saleId = parseStoreId(request.params.saleId)
  if (!saleId) throw new AppError('معرّف الفاتورة غير صالح', 400, 'INVALID_SALE_ID')

  const result = await query(
    `SELECT sale.id::TEXT AS id, sale.document_number AS invoice_number,
       sale.business_date::TEXT AS business_date, customers.name AS customer_name,
       sale.items_subtotal::TEXT AS items_subtotal,
       sale.invoice_discount::TEXT AS invoice_discount,
       sale.total::TEXT AS total, sale.paid_total::TEXT AS paid_total,
       sale.remaining_due::TEXT AS remaining_due
     FROM sales AS sale
     LEFT JOIN customers ON customers.id = sale.customer_id
     WHERE sale.id = $1::BIGINT AND sale.store_id = $2::BIGINT
       AND sale.status = 'recorded'`,
    [saleId, request.storeId],
  )
  if (result.rowCount === 0) throw new AppError('الفاتورة غير موجودة', 404, 'SALE_NOT_FOUND')

  const items = await query(
    `SELECT id::TEXT AS id, description, quantity::TEXT AS quantity,
       unit_price::TEXT AS actual_price, line_discount::TEXT AS discount,
       line_total::TEXT AS total
     FROM sale_items WHERE sale_id = $1::BIGINT ORDER BY id`,
    [saleId],
  )
  response.json({ sale: { ...result.rows[0], items: items.rows } })
})

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
