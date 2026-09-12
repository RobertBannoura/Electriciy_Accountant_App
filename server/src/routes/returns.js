import { Router } from 'express'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { requireStore } from '../middleware/require-store.js'
import { createCustomerReturn } from '../returns/create-customer-return.js'
import { createSupplierReturn } from '../returns/create-supplier-return.js'
import { parseReturnInput } from '../returns/return-input.js'
import { paginatedResult, parsePagination } from '../pagination/pagination.js'
import {
  financialOperation,
  requireFinancialRequestId,
} from '../financial/financial-operation.js'

export const returnsRouter = Router()
returnsRouter.use(requireStore)

returnsRouter.get('/customer/sources', async (request, response) => {
  const pagination = parsePagination(request.query)
  const result = await query(
    `WITH recent_sales AS (
       SELECT id FROM sales WHERE store_id = $1::BIGINT
       ORDER BY business_date DESC, id DESC
       LIMIT $2::INTEGER OFFSET $3::INTEGER
     )
     SELECT sale.id::TEXT AS document_id, sale.document_number,
       sale.business_date::TEXT AS business_date, sale.total::TEXT AS document_total,
       customers.name AS party_name, item.id::TEXT AS item_id,
       item.product_id::TEXT AS product_id, item.description,
       item.quantity::TEXT AS original_quantity,
       (item.quantity - COALESCE(returned.quantity, 0::NUMERIC))::TEXT AS returnable_quantity
     FROM recent_sales
     INNER JOIN sales AS sale ON sale.id = recent_sales.id
     LEFT JOIN customers ON customers.id = sale.customer_id
     INNER JOIN sale_items AS item ON item.sale_id = sale.id
     LEFT JOIN LATERAL (
       SELECT SUM(quantity) AS quantity FROM customer_return_items
       WHERE sale_item_id = item.id
     ) AS returned ON TRUE
     WHERE item.product_id IS NOT NULL
       AND item.quantity > COALESCE(returned.quantity, 0::NUMERIC)
     ORDER BY sale.business_date DESC, sale.id DESC, item.id`,
    [request.storeId, pagination.fetchLimit, pagination.offset],
  )
  const documents = groupSourceDocuments(result.rows)
  const page = paginatedResult(documents, pagination)
  response.json({ documents: page.rows, pagination: page.pagination })
})

returnsRouter.get('/supplier/sources', async (request, response) => {
  const pagination = parsePagination(request.query)
  const result = await query(
    `WITH recent_purchases AS (
       SELECT id FROM purchases WHERE store_id = $1::BIGINT
       ORDER BY business_date DESC, id DESC
       LIMIT $2::INTEGER OFFSET $3::INTEGER
     )
     SELECT purchase.id::TEXT AS document_id, purchase.document_number,
       purchase.business_date::TEXT AS business_date,
       purchase.total::TEXT AS document_total, suppliers.name AS party_name,
       item.id::TEXT AS item_id, item.product_id::TEXT AS product_id,
       item.description, item.quantity::TEXT AS original_quantity,
       (item.quantity - COALESCE(returned.quantity, 0::NUMERIC))::TEXT AS returnable_quantity
     FROM recent_purchases
     INNER JOIN purchases AS purchase ON purchase.id = recent_purchases.id
     INNER JOIN suppliers ON suppliers.id = purchase.supplier_id
     INNER JOIN purchase_items AS item ON item.purchase_id = purchase.id
     LEFT JOIN LATERAL (
       SELECT SUM(quantity) AS quantity FROM supplier_return_items
       WHERE purchase_item_id = item.id
     ) AS returned ON TRUE
     WHERE item.product_id IS NOT NULL
       AND item.quantity > COALESCE(returned.quantity, 0::NUMERIC)
     ORDER BY purchase.business_date DESC, purchase.id DESC, item.id`,
    [request.storeId, pagination.fetchLimit, pagination.offset],
  )
  const documents = groupSourceDocuments(result.rows)
  const page = paginatedResult(documents, pagination)
  response.json({ documents: page.rows, pagination: page.pagination })
})

returnsRouter.post('/customer', requireFinancialRequestId, async (request, response) => {
  const parsed = parseReturnInput(request.body)
  if (parsed.error) throw new AppError(parsed.error, 400, 'INVALID_CUSTOMER_RETURN')
  const returnDocument = await createCustomerReturn({
    input: parsed.value, storeId: request.storeId,
    userId: request.auth.user.id,
    operation: financialOperation(request, 'return:customer', {
      storeId: request.storeId,
      input: parsed.value,
    }),
  })
  response.status(201).json({ return: returnDocument })
})

returnsRouter.post('/supplier', requireFinancialRequestId, async (request, response) => {
  const parsed = parseReturnInput(request.body)
  if (parsed.error) throw new AppError(parsed.error, 400, 'INVALID_SUPPLIER_RETURN')
  const returnDocument = await createSupplierReturn({
    input: parsed.value, storeId: request.storeId,
    userId: request.auth.user.id,
    operation: financialOperation(request, 'return:supplier', {
      storeId: request.storeId,
      input: parsed.value,
    }),
  })
  response.status(201).json({ return: returnDocument })
})

function groupSourceDocuments(rows) {
  const documents = new Map()
  for (const row of rows) {
    if (!documents.has(row.document_id)) {
      documents.set(row.document_id, {
        id: row.document_id, document_number: row.document_number,
        business_date: row.business_date, total: row.document_total,
        party_name: row.party_name, items: [],
      })
    }
    documents.get(row.document_id).items.push({
      id: row.item_id, product_id: row.product_id, description: row.description,
      original_quantity: row.original_quantity,
      returnable_quantity: row.returnable_quantity,
    })
  }
  return [...documents.values()]
}
