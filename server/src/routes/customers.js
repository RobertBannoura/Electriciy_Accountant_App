import { Router } from 'express'
import { rankNameMatches } from '../customers/name-matching.js'
import { getCustomerReminders, parsePaymentPromise, parsePromiseVersion } from '../customers/customer-reminders.js'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { requireStore } from '../middleware/require-store.js'
import {
  parseCustomerInput,
  parseCustomerProjectInput,
} from '../customers/customer-input.js'
import { parseCustomerPaymentInput } from '../customers/customer-payment-input.js'
import { createCustomerPayment } from '../customers/create-customer-payment.js'
import {
  financialOperation,
  requireFinancialRequestId,
} from '../financial/financial-operation.js'
import { notifyCustomerPaymentCreated } from '../notifications/financial-notifications.js'
import { getCustomerStatement } from '../statements/account-statements.js'
import { parseStatementRange } from '../statements/statement-input.js'
import { paginatedResult, parsePagination } from '../pagination/pagination.js'
import {
  normalizeOptionalText,
  parseId,
} from '../products/product-input.js'

export const customersRouter = Router()

// A configured store remains required as the operating context. Customer and
// project identities are business-wide; only activity can be filtered by store.
customersRouter.use(requireStore)

customersRouter.get('/', async (request, response) => {
  const search = normalizeOptionalText(request.query.search, 150)
  if (request.query.search && !search) {
    throw new AppError('نص البحث غير صالح', 400, 'INVALID_CUSTOMER_SEARCH')
  }

  const result = await query(
    `
      SELECT
        customers.id::TEXT AS id,
        customers.name,
        customers.phone,
        customers.address,
        customers.notes,
        customers.payment_promise_date::TEXT AS payment_promise_date,
        customers.payment_promise_note,
        customers.debt_limit_ils::TEXT AS debt_limit_ils,
        customers.created_at,
        customer_balances.balance_ils::TEXT AS balance_ils
      FROM customers
      INNER JOIN customer_balances
        ON customer_balances.customer_id = customers.id
      WHERE customers.is_active = TRUE
        AND (
          $1::TEXT IS NULL
          OR LOWER(customers.name) LIKE '%' || LOWER($1) || '%'
          OR LOWER(customers.phone) LIKE '%' || LOWER($1) || '%'
        )
      ORDER BY customers.name, customers.id
      LIMIT 500
    `,
    [search],
  )

  response.json({ customers: result.rows })
})

customersRouter.get('/sale-search', async (request, response) => {
  const search = normalizeOptionalText(request.query.search, 150)
  if (request.query.search && !search) {
    throw new AppError('نص البحث غير صالح', 400, 'INVALID_CUSTOMER_SEARCH')
  }
  // Rank before limiting so customers outside the directory's first 500 are searchable.
  const result = await query(`
    SELECT id::TEXT AS id, name, phone FROM customers
    WHERE is_active = TRUE ORDER BY name, id
  `)
  response.json({ customers: rankNameMatches(result.rows, search ?? '').slice(0, 50) })
})

customersRouter.get('/reminders', async (_request, response) => {
  response.json(await getCustomerReminders())
})

customersRouter.put('/:customerId/payment-promise', async (request, response) => {
  const customerId = requireCustomerId(request.params.customerId)
  const parsed = parsePaymentPromise(request.body)
  if (parsed.error) throw new AppError(parsed.error, 400, 'INVALID_PAYMENT_PROMISE')
  const result = await query(`
    UPDATE customers SET payment_promise_date = $2::DATE, payment_promise_note = $3,
      payment_promise_version = payment_promise_version + 1
    WHERE id = $1::BIGINT AND is_active = TRUE
    RETURNING payment_promise_date::TEXT, payment_promise_note, payment_promise_version::TEXT
  `, [customerId, parsed.value.date, parsed.value.note])
  if (!result.rowCount) throw new AppError('العميل غير موجود', 404, 'CUSTOMER_NOT_FOUND')
  response.json({ promise: result.rows[0] })
})

customersRouter.post('/:customerId/payment-promise/complete', async (request, response) => {
  const customerId = requireCustomerId(request.params.customerId)
  const version = parsePromiseVersion(request.body?.version)
  if (!version) throw new AppError('نسخة التذكير غير صالحة', 400, 'INVALID_PROMISE_VERSION')
  const result = await query(`
    UPDATE customers SET payment_promise_date = NULL, payment_promise_note = NULL,
      payment_promise_version = payment_promise_version + 1
    WHERE id = $1::BIGINT AND is_active = TRUE AND payment_promise_version = $2::BIGINT
      AND payment_promise_date IS NOT NULL
    RETURNING id::TEXT
  `, [customerId, version])
  if (!result.rowCount) throw new AppError('تم تغيير التذكير. حدّث الصفحة وحاول مرة أخرى.', 409, 'PAYMENT_PROMISE_CHANGED')
  response.json({ completed: true })
})

customersRouter.get('/debt-reminders', async (_request, response) => {
  const result = await query(`
    SELECT customers.id::TEXT AS id, customers.name, customers.phone,
           customers.debt_limit_ils::TEXT AS debt_limit_ils,
           customer_balances.balance_ils::TEXT AS balance_ils
    FROM customers
    INNER JOIN customer_balances ON customer_balances.customer_id = customers.id
    WHERE customers.is_active = TRUE
      AND customers.debt_limit_ils IS NOT NULL
      AND customer_balances.balance_ils > 0
      AND customer_balances.balance_ils >= customers.debt_limit_ils
    ORDER BY customer_balances.balance_ils - customers.debt_limit_ils DESC,
             customers.name, customers.id
  `)
  response.json({ customers: result.rows })
})

customersRouter.post('/', async (request, response) => {
  const parsed = parseCustomerInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_CUSTOMER')
  }

  const result = await query(
    `
      INSERT INTO customers (name, phone, address, notes, debt_limit_ils)
      VALUES ($1, $2, $3, $4, $5::NUMERIC)
      RETURNING id::TEXT AS id, name, phone, address, notes, created_at,
                debt_limit_ils::TEXT AS debt_limit_ils
    `,
    [
      parsed.value.name,
      parsed.value.phone,
      parsed.value.address,
      parsed.value.notes,
      parsed.value.debtLimitIls ?? null,
    ],
  )

  response.status(201).json({ customer: { ...result.rows[0], balance_ils: '0' } })
})

customersRouter.get('/:customerId/sales', async (request, response) => {
  const customerId = requireCustomerId(request.params.customerId)
  const projectId = optionalId(request.query.projectId, 'معرّف المشروع غير صالح', 'INVALID_CUSTOMER_PROJECT_ID')
  const activityStoreId = optionalId(request.query.storeId, 'معرّف المتجر غير صالح', 'INVALID_ACTIVITY_STORE_ID')
  if (activityStoreId) await requireActiveActivityStore(activityStoreId)
  const pagination = parsePagination(request.query, { defaultLimit: 10, maxLimit: 50 })
  const search = request.query.search === undefined ? '' : request.query.search
  if (typeof search !== 'string' || search.length > 100) {
    throw new AppError('بحث الفواتير غير صالح', 400, 'INVALID_SALES_SEARCH')
  }

  const result = await query(
    `SELECT sales.id::TEXT AS id, sales.store_id::TEXT AS store_id,
            sales.document_number, sales.business_date::TEXT AS business_date,
            sales.status, sales.currency_code, sales.customer_project_id::TEXT AS project_id,
            customer_projects.name AS project_name, sales.total::TEXT AS total,
            stores.name AS store_name
     FROM sales
     INNER JOIN customers ON customers.id = sales.customer_id AND customers.is_active = TRUE
     INNER JOIN stores ON stores.id = sales.store_id
     LEFT JOIN customer_projects ON customer_projects.id = sales.customer_project_id
     WHERE sales.customer_id = $1::BIGINT AND sales.status = 'recorded'
       AND ($2::BIGINT IS NULL OR sales.store_id = $2::BIGINT)
       AND ($3::BIGINT IS NULL OR sales.customer_project_id = $3::BIGINT)
       AND POSITION(LOWER($4::TEXT) IN LOWER(COALESCE(sales.document_number, ''))) > 0
     ORDER BY sales.business_date DESC, sales.id DESC
     LIMIT $5::INTEGER OFFSET $6::INTEGER`,
    [customerId, activityStoreId, projectId, search.trim(), pagination.fetchLimit, pagination.offset],
  )
  const page = paginatedResult(result.rows, pagination)
  response.json({ sales: page.rows, pagination: page.pagination })
})

customersRouter.get('/:customerId/statement', async (request, response) => {
  const customerId = requireCustomerId(request.params.customerId)
  const parsedRange = parseStatementRange(request.query)
  if (parsedRange.error) throw new AppError(parsedRange.error, 400, 'INVALID_STATEMENT_RANGE')
  const projectId = optionalId(request.query.projectId, 'معرّف المشروع غير صالح', 'INVALID_CUSTOMER_PROJECT_ID')
  const activityStoreId = optionalId(request.query.storeId, 'معرّف المتجر غير صالح', 'INVALID_ACTIVITY_STORE_ID')
  if (activityStoreId) await requireActiveActivityStore(activityStoreId)

  const customerResult = await query(
    `SELECT id::TEXT AS id, name, phone, address
     FROM customers WHERE id = $1::BIGINT AND is_active = TRUE`,
    [customerId],
  )
  if (customerResult.rowCount === 0) throw new AppError('العميل غير موجود', 404, 'CUSTOMER_NOT_FOUND')

  let project = null
  if (projectId) {
    const projectResult = await query(
      `SELECT id::TEXT AS id, name FROM customer_projects
       WHERE id = $1::BIGINT AND customer_id = $2::BIGINT AND is_active = TRUE`,
      [projectId, customerId],
    )
    if (projectResult.rowCount === 0) throw new AppError('المشروع غير موجود لهذا العميل', 404, 'CUSTOMER_PROJECT_NOT_FOUND')
    project = projectResult.rows[0]
  }

  const statement = await getCustomerStatement({
    customerId, projectId, storeId: activityStoreId, ...parsedRange.value,
  })
  response.json({
    statement: {
      kind: 'customer', party: customerResult.rows[0], project,
      store_id: activityStoreId, ...parsedRange.value, ...statement,
    },
  })
})

customersRouter.get('/:customerId', async (request, response) => {
  const customerId = requireCustomerId(request.params.customerId)
  const projectId = optionalId(
    request.query.projectId,
    'معرّف المشروع غير صالح',
    'INVALID_CUSTOMER_PROJECT_ID',
  )
  const activityStoreId = optionalId(
    request.query.storeId,
    'معرّف المتجر غير صالح',
    'INVALID_ACTIVITY_STORE_ID',
  )
  if (activityStoreId) await requireActiveActivityStore(activityStoreId)

  const customerResult = await query(
    `
      SELECT
        customers.id::TEXT AS id,
        customers.name,
        customers.phone,
        customers.address,
        customers.notes,
        customers.payment_promise_date::TEXT AS payment_promise_date,
        customers.payment_promise_note,
        customers.debt_limit_ils::TEXT AS debt_limit_ils,
        customers.created_at,
        customer_balances.balance_ils::TEXT AS balance_ils
      FROM customers
      INNER JOIN customer_balances
        ON customer_balances.customer_id = customers.id
      WHERE customers.id = $1::BIGINT AND customers.is_active = TRUE
    `,
    [customerId],
  )
  if (customerResult.rowCount === 0) {
    throw new AppError('العميل غير موجود', 404, 'CUSTOMER_NOT_FOUND')
  }

  const projects = await query(
    `
      SELECT id::TEXT AS id, customer_id::TEXT AS customer_id, name, notes, created_at
      FROM customer_projects
      WHERE customer_id = $1::BIGINT AND is_active = TRUE
      ORDER BY created_at DESC, id DESC
    `,
    [customerId],
  )
  if (projectId && !projects.rows.some((project) => project.id === projectId)) {
    throw new AppError('المشروع غير موجود لهذا العميل', 404, 'CUSTOMER_PROJECT_NOT_FOUND')
  }

  const [storeBalances, sales, maintenance, payments, checks, movements] = await Promise.all([
    query(
      `
        SELECT
          stores.id::TEXT AS store_id,
          stores.name AS store_name,
          customer_store_balances.balance_ils::TEXT AS amount_ils
        FROM customer_store_balances
        INNER JOIN stores ON stores.id = customer_store_balances.store_id
        WHERE customer_store_balances.customer_id = $1::BIGINT
        ORDER BY stores.id
      `,
      [customerId],
    ),
    query(
      `
        SELECT
          sales.id::TEXT AS id,
          sales.store_id::TEXT AS store_id,
          stores.name AS store_name,
          sales.document_number,
          sales.business_date,
          sales.status,
          sales.currency_code,
          sales.customer_project_id::TEXT AS project_id,
          customer_projects.name AS project_name,
          COALESCE(
            (TO_JSONB(sales) ->> 'total')::NUMERIC,
            SUM(sale_items.quantity * sale_items.unit_price),
            0::NUMERIC
          )::TEXT AS total
        FROM sales
        INNER JOIN stores ON stores.id = sales.store_id
        LEFT JOIN sale_items ON sale_items.sale_id = sales.id
        LEFT JOIN customer_projects ON customer_projects.id = sales.customer_project_id
        WHERE sales.customer_id = $1::BIGINT
          AND ($2::BIGINT IS NULL OR sales.store_id = $2::BIGINT)
          AND ($3::BIGINT IS NULL OR sales.customer_project_id = $3::BIGINT)
        GROUP BY sales.id, stores.name, customer_projects.name
        ORDER BY sales.business_date DESC, sales.id DESC
        LIMIT 10
      `,
      [customerId, activityStoreId, projectId],
    ),
    query(
      `
        SELECT
          maintenance_records.id::TEXT AS id,
          maintenance_records.store_id::TEXT AS store_id,
          stores.name AS store_name,
          maintenance_records.item_description,
          maintenance_records.business_date::TEXT AS business_date,
          maintenance_records.amount_ils::TEXT AS amount_ils,
          maintenance_records.paid_total_ils::TEXT AS paid_total_ils,
          maintenance_records.remaining_due_ils::TEXT AS remaining_due_ils,
          maintenance_reversals.created_at AS reversed_at
        FROM maintenance_records
        INNER JOIN stores ON stores.id = maintenance_records.store_id
        LEFT JOIN maintenance_reversals
          ON maintenance_reversals.maintenance_id = maintenance_records.id
        WHERE maintenance_records.customer_id = $1::BIGINT
          AND ($2::BIGINT IS NULL OR maintenance_records.store_id = $2::BIGINT)
        ORDER BY maintenance_records.business_date DESC, maintenance_records.id DESC
        LIMIT 10
      `,
      [customerId, activityStoreId],
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
        WHERE payments.customer_id = $1::BIGINT
          AND ($2::BIGINT IS NULL OR payments.store_id = $2::BIGINT)
        ORDER BY payments.paid_at DESC, payments.id DESC
        LIMIT 10
      `,
      [customerId, activityStoreId],
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
          checks.is_giro,
          checks.original_owner_name,
          checks.original_owner_phone,
          checks.supplier_id::TEXT AS supplier_id,
          suppliers.name AS supplier_name,
          checks.transferred_at
        FROM checks
        INNER JOIN stores ON stores.id = checks.store_id
        LEFT JOIN suppliers ON suppliers.id = checks.supplier_id
        WHERE checks.customer_id = $1::BIGINT
          AND ($2::BIGINT IS NULL OR checks.store_id = $2::BIGINT)
        ORDER BY checks.due_date DESC, checks.id DESC
        LIMIT 10
      `,
      [customerId, activityStoreId],
    ),
    query(
      `
        SELECT
          customer_ledger.id::TEXT AS id,
          customer_ledger.store_id::TEXT AS store_id,
          stores.name AS store_name,
          customer_ledger.direction,
          customer_ledger.amount_ils::TEXT AS amount_ils,
          customer_ledger.occurred_at,
          customer_ledger.source_type,
          customer_ledger.source_id::TEXT AS source_id,
          customer_ledger.notes,
          source_sale.customer_project_id::TEXT AS project_id,
          source_project.name AS project_name
        FROM customer_ledger
        INNER JOIN stores ON stores.id = customer_ledger.store_id
        LEFT JOIN sales AS source_sale
          ON customer_ledger.source_type = 'sale'
         AND source_sale.id = customer_ledger.source_id
         AND source_sale.store_id = customer_ledger.store_id
         AND source_sale.customer_id = customer_ledger.customer_id
        LEFT JOIN customer_projects AS source_project
          ON source_project.id = source_sale.customer_project_id
        WHERE customer_ledger.customer_id = $1::BIGINT
          AND ($2::BIGINT IS NULL OR customer_ledger.store_id = $2::BIGINT)
          AND ($3::BIGINT IS NULL OR source_sale.customer_project_id = $3::BIGINT)
        ORDER BY customer_ledger.occurred_at DESC, customer_ledger.id DESC
        LIMIT 20
      `,
      [customerId, activityStoreId, projectId],
    ),
  ])

  response.json({
    customer: {
      ...customerResult.rows[0],
      store_balances: storeBalances.rows,
      recent_sales: sales.rows,
      recent_maintenance: maintenance.rows,
      payments: payments.rows,
      checks: checks.rows,
      projects: projects.rows,
      recent_movements: movements.rows,
      selected_project_id: projectId,
      selected_store_id: activityStoreId,
    },
  })
})

customersRouter.patch('/:customerId', async (request, response) => {
  const customerId = requireCustomerId(request.params.customerId)
  const parsed = parseCustomerInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_CUSTOMER')
  }

  const result = await query(
    `
      UPDATE customers
      SET name = $1, phone = $2, address = $3, notes = $4,
          debt_limit_ils = CASE WHEN $6::BOOLEAN THEN $7::NUMERIC ELSE debt_limit_ils END
      WHERE id = $5::BIGINT AND is_active = TRUE
      RETURNING id::TEXT AS id, name, phone, address, notes, created_at,
                debt_limit_ils::TEXT AS debt_limit_ils
    `,
    [
      parsed.value.name,
      parsed.value.phone,
      parsed.value.address,
      parsed.value.notes,
      customerId,
      Object.hasOwn(parsed.value, 'debtLimitIls'),
      parsed.value.debtLimitIls ?? null,
    ],
  )
  if (result.rowCount === 0) {
    throw new AppError('العميل غير موجود', 404, 'CUSTOMER_NOT_FOUND')
  }

  response.json({ customer: result.rows[0] })
})

customersRouter.post('/:customerId/projects', async (request, response) => {
  const customerId = requireCustomerId(request.params.customerId)
  const parsed = parseCustomerProjectInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_CUSTOMER_PROJECT')
  }

  const result = await query(
    `
      INSERT INTO customer_projects (customer_id, name, notes)
      SELECT customers.id, $2, $3
      FROM customers
      WHERE customers.id = $1::BIGINT AND customers.is_active = TRUE
      RETURNING id::TEXT AS id, customer_id::TEXT AS customer_id, name, notes, created_at
    `,
    [customerId, parsed.value.name, parsed.value.notes],
  )
  if (result.rowCount === 0) {
    throw new AppError('العميل غير موجود', 404, 'CUSTOMER_NOT_FOUND')
  }

  response.status(201).json({ project: result.rows[0] })
})

customersRouter.post('/:customerId/payments', requireFinancialRequestId, async (request, response) => {
  const customerId = requireCustomerId(request.params.customerId)
  const parsed = parseCustomerPaymentInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_CUSTOMER_PAYMENT')
  }

  const payment = await createCustomerPayment({
    customerId,
    input: parsed.value,
    storeId: request.storeId,
    userId: request.auth.user.id,
    operation: financialOperation(request, 'payment:customer', {
      storeId: request.storeId,
      customerId,
      input: parsed.value,
    }),
  })

  await notifyCustomerPaymentCreated({ payment })

  response.status(201).json({ payment })
})

function requireCustomerId(value) {
  const customerId = parseId(value)
  if (!customerId) {
    throw new AppError('معرّف العميل غير صالح', 400, 'INVALID_CUSTOMER_ID')
  }
  return customerId
}

function optionalId(value, message, code) {
  if (value === undefined) return null
  const id = parseId(value)
  if (!id) throw new AppError(message, 400, code)
  return id
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
