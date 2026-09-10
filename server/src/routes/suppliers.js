import { Router } from 'express'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { requireStore } from '../middleware/require-store.js'
import {
  normalizeOptionalText,
  parseId,
} from '../products/product-input.js'
import { parseSupplierInput } from '../suppliers/supplier-input.js'
import { createSupplierPayment } from '../suppliers/create-supplier-payment.js'
import {
  financialOperation,
  requireFinancialRequestId,
} from '../financial/financial-operation.js'
import { notifySupplierPaymentCreated } from '../notifications/financial-notifications.js'
import { parseSupplierPaymentInput } from '../suppliers/supplier-payment-input.js'
import { getSupplierStatement } from '../statements/account-statements.js'
import { parseStatementRange } from '../statements/statement-input.js'

export const suppliersRouter = Router()

// The store header identifies the operating context. Supplier identity and
// directory search are business-wide; only activity can be filtered by store.
suppliersRouter.use(requireStore)

suppliersRouter.get('/', async (request, response) => {
  const search = normalizeOptionalText(request.query.search, 150)
  if (request.query.search && !search) {
    throw new AppError('نص البحث غير صالح', 400, 'INVALID_SUPPLIER_SEARCH')
  }

  const result = await query(
    `
      SELECT
        suppliers.id::TEXT AS id,
        suppliers.name,
        suppliers.phone,
        suppliers.address,
        suppliers.notes,
        suppliers.created_at,
        supplier_balances.balance_ils::TEXT AS balance_ils
      FROM suppliers
      INNER JOIN supplier_balances
        ON supplier_balances.supplier_id = suppliers.id
      WHERE suppliers.is_active = TRUE
        AND (
          $1::TEXT IS NULL
          OR LOWER(suppliers.name) LIKE '%' || LOWER($1) || '%'
          OR LOWER(suppliers.phone) LIKE '%' || LOWER($1) || '%'
        )
      ORDER BY suppliers.name, suppliers.id
      LIMIT 500
    `,
    [search],
  )

  response.json({ suppliers: result.rows })
})

suppliersRouter.post('/', async (request, response) => {
  const parsed = parseSupplierInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_SUPPLIER')
  }

  const result = await query(
    `
      INSERT INTO suppliers (name, phone, address, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING id::TEXT AS id, name, phone, address, notes, created_at
    `,
    [
      parsed.value.name,
      parsed.value.phone,
      parsed.value.address,
      parsed.value.notes,
    ],
  )

  response.status(201).json({ supplier: { ...result.rows[0], balance_ils: '0' } })
})

suppliersRouter.post('/:supplierId/payments', requireFinancialRequestId, async (request, response) => {
  const supplierId = requireSupplierId(request.params.supplierId)
  const parsed = parseSupplierPaymentInput(request.body)
  if (parsed.error) throw new AppError(parsed.error, 400, 'INVALID_SUPPLIER_PAYMENT')
  const payment = await createSupplierPayment({
    supplierId,
    input: parsed.value,
    storeId: request.storeId,
    userId: request.auth.user.id,
    operation: financialOperation(request, 'payment:supplier', {
      storeId: request.storeId,
      supplierId,
      input: parsed.value,
    }),
  })
  await notifySupplierPaymentCreated({ payment })
  response.status(201).json({ payment })
})

suppliersRouter.get('/:supplierId/statement', async (request, response) => {
  const supplierId = requireSupplierId(request.params.supplierId)
  const parsedRange = parseStatementRange(request.query)
  if (parsedRange.error) throw new AppError(parsedRange.error, 400, 'INVALID_STATEMENT_RANGE')
  const activityStoreId = optionalStoreId(request.query.storeId)
  if (activityStoreId) await requireActiveActivityStore(activityStoreId)
  const supplierResult = await query(
    `SELECT id::TEXT AS id, name, phone, address
     FROM suppliers WHERE id = $1::BIGINT AND is_active = TRUE`,
    [supplierId],
  )
  if (supplierResult.rowCount === 0) throw new AppError('المورد غير موجود', 404, 'SUPPLIER_NOT_FOUND')
  const statement = await getSupplierStatement({
    supplierId, storeId: activityStoreId, ...parsedRange.value,
  })
  response.json({
    statement: {
      kind: 'supplier', party: supplierResult.rows[0],
      store_id: activityStoreId, ...parsedRange.value, ...statement,
    },
  })
})

suppliersRouter.get('/:supplierId', async (request, response) => {
  const supplierId = requireSupplierId(request.params.supplierId)
  const activityStoreId = optionalStoreId(request.query.storeId)
  if (activityStoreId) await requireActiveActivityStore(activityStoreId)

  const supplierResult = await query(
    `
      SELECT
        suppliers.id::TEXT AS id,
        suppliers.name,
        suppliers.phone,
        suppliers.address,
        suppliers.notes,
        suppliers.created_at,
        supplier_balances.balance_ils::TEXT AS balance_ils
      FROM suppliers
      INNER JOIN supplier_balances
        ON supplier_balances.supplier_id = suppliers.id
      WHERE suppliers.id = $1::BIGINT AND suppliers.is_active = TRUE
    `,
    [supplierId],
  )
  if (supplierResult.rowCount === 0) {
    throw new AppError('المورد غير موجود', 404, 'SUPPLIER_NOT_FOUND')
  }

  const [storeBalances, purchases, payments, checks, movements] = await Promise.all([
    query(
      `
        SELECT
          stores.id::TEXT AS store_id,
          stores.name AS store_name,
          supplier_store_balances.balance_ils::TEXT AS amount_ils
        FROM supplier_store_balances
        INNER JOIN stores ON stores.id = supplier_store_balances.store_id
        WHERE supplier_store_balances.supplier_id = $1::BIGINT
        ORDER BY stores.id
      `,
      [supplierId],
    ),
    query(
      `
        SELECT
          purchases.id::TEXT AS id,
          purchases.store_id::TEXT AS store_id,
          stores.name AS store_name,
          purchases.document_number,
          purchases.business_date,
          purchases.status,
          purchases.currency_code,
          COALESCE(SUM(purchase_items.quantity * purchase_items.unit_cost), 0::NUMERIC)::TEXT AS total
        FROM purchases
        INNER JOIN stores ON stores.id = purchases.store_id
        LEFT JOIN purchase_items ON purchase_items.purchase_id = purchases.id
        WHERE purchases.supplier_id = $1::BIGINT
          AND ($2::BIGINT IS NULL OR purchases.store_id = $2::BIGINT)
        GROUP BY purchases.id, stores.name
        ORDER BY purchases.business_date DESC, purchases.id DESC
        LIMIT 10
      `,
      [supplierId, activityStoreId],
    ),
    query(
      `
        SELECT
          payments.id::TEXT AS id,
          payments.store_id::TEXT AS store_id,
          stores.name AS store_name,
          payments.direction,
          payments.original_amount::TEXT AS original_amount,
          payments.currency_code,
          payments.exchange_rate::TEXT AS exchange_rate,
          payments.converted_ils_amount::TEXT AS converted_ils_amount,
          payments.payment_method,
          payments.reference,
          payments.paid_at,
          payments.notes
        FROM payments
        INNER JOIN stores ON stores.id = payments.store_id
        WHERE payments.supplier_id = $1::BIGINT
          AND ($2::BIGINT IS NULL OR payments.store_id = $2::BIGINT)
        ORDER BY payments.paid_at DESC, payments.id DESC
        LIMIT 10
      `,
      [supplierId, activityStoreId],
    ),
    query(
      `
        SELECT
          checks.id::TEXT AS id,
          checks.store_id::TEXT AS store_id,
          stores.name AS store_name,
          checks.check_number,
          checks.bank_name,
          checks.direction,
          checks.status,
          checks.amount::TEXT AS amount,
          checks.currency_code,
          checks.due_date,
          checks.notes,
          checks.transferred_at,
          checks.customer_id::TEXT AS customer_id,
          customers.name AS customer_name,
          checks.is_giro,
          checks.original_owner_name,
          checks.original_owner_phone,
          checks.is_owner_issued
        FROM checks
        INNER JOIN stores ON stores.id = checks.store_id
        LEFT JOIN customers ON customers.id = checks.customer_id
        WHERE checks.supplier_id = $1::BIGINT
          AND ($2::BIGINT IS NULL OR checks.store_id = $2::BIGINT)
        ORDER BY checks.due_date DESC, checks.id DESC
        LIMIT 10
      `,
      [supplierId, activityStoreId],
    ),
    query(
      `
        SELECT
          supplier_ledger.id::TEXT AS id,
          supplier_ledger.store_id::TEXT AS store_id,
          stores.name AS store_name,
          supplier_ledger.direction,
          supplier_ledger.amount_ils::TEXT AS amount_ils,
          supplier_ledger.occurred_at,
          supplier_ledger.source_type,
          supplier_ledger.source_id::TEXT AS source_id,
          supplier_ledger.notes
        FROM supplier_ledger
        INNER JOIN stores ON stores.id = supplier_ledger.store_id
        WHERE supplier_ledger.supplier_id = $1::BIGINT
          AND ($2::BIGINT IS NULL OR supplier_ledger.store_id = $2::BIGINT)
        ORDER BY supplier_ledger.occurred_at DESC, supplier_ledger.id DESC
        LIMIT 20
      `,
      [supplierId, activityStoreId],
    ),
  ])

  response.json({
    supplier: {
      ...supplierResult.rows[0],
      store_balances: storeBalances.rows,
      purchases: purchases.rows,
      payments: payments.rows,
      checks: checks.rows,
      recent_movements: movements.rows,
      selected_store_id: activityStoreId,
    },
  })
})

suppliersRouter.patch('/:supplierId', async (request, response) => {
  const supplierId = requireSupplierId(request.params.supplierId)
  const parsed = parseSupplierInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_SUPPLIER')
  }

  const result = await query(
    `
      UPDATE suppliers
      SET name = $1, phone = $2, address = $3, notes = $4
      WHERE id = $5::BIGINT AND is_active = TRUE
      RETURNING id::TEXT AS id, name, phone, address, notes, created_at
    `,
    [
      parsed.value.name,
      parsed.value.phone,
      parsed.value.address,
      parsed.value.notes,
      supplierId,
    ],
  )
  if (result.rowCount === 0) {
    throw new AppError('المورد غير موجود', 404, 'SUPPLIER_NOT_FOUND')
  }

  response.json({ supplier: result.rows[0] })
})

function requireSupplierId(value) {
  const supplierId = parseId(value)
  if (!supplierId) {
    throw new AppError('معرّف المورد غير صالح', 400, 'INVALID_SUPPLIER_ID')
  }
  return supplierId
}

function optionalStoreId(value) {
  if (value === undefined) return null
  const storeId = parseId(value)
  if (!storeId) {
    throw new AppError('معرّف المتجر غير صالح', 400, 'INVALID_ACTIVITY_STORE_ID')
  }
  return storeId
}

async function requireActiveActivityStore(storeId) {
  const result = await query(
    'SELECT 1 FROM stores WHERE id = $1::BIGINT AND is_active = TRUE',
    [storeId],
  )
  if (result.rowCount === 0) {
    throw new AppError('المتجر غير موجود أو غير فعال', 404, 'STORE_NOT_FOUND')
  }
}
