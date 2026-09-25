import { Router } from 'express'
import { currentBusinessDate, getCheckReminders } from '../checks/check-reminders.js'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { requireStore } from '../middleware/require-store.js'
import { parseReportFilters } from '../reports/report-input.js'
import { paginatedResult, parsePagination } from '../pagination/pagination.js'

export const reportsRouter = Router()

reportsRouter.get('/sales', async (request, response) => {
  const parsed = parseReportFilters(request.query)
  if (parsed.error) throw new AppError(parsed.error, 400, 'INVALID_REPORT_FILTERS')
  const { from, to, storeId } = parsed.value
  const pagination = parsePagination(request.query)
  const search = request.query.search === undefined ? '' : request.query.search
  if (typeof search !== 'string' || search.length > 100) {
    throw new AppError('بحث المبيعات غير صالح', 400, 'INVALID_SALES_SEARCH')
  }
  await requireActiveReportStore(storeId)

  const result = await query(
    `SELECT sale.id::TEXT AS id, sale.store_id::TEXT AS store_id,
       sale.document_number AS invoice_number,
       sale.business_date::TEXT AS business_date,
       sale.total::TEXT AS total, sale.paid_total::TEXT AS paid_total,
       sale.remaining_due::TEXT AS remaining_due,
       customers.name AS customer_name, stores.name AS store_name
     FROM sales AS sale
     INNER JOIN stores ON stores.id = sale.store_id
     LEFT JOIN customers ON customers.id = sale.customer_id
     WHERE ($1::BIGINT IS NULL OR sale.store_id = $1::BIGINT)
       AND sale.business_date BETWEEN $2::DATE AND $3::DATE
       AND sale.status = 'recorded'
       AND POSITION(LOWER($4::TEXT) IN LOWER(
         COALESCE(sale.document_number, '') || ' ' || COALESCE(customers.name, '')
       )) > 0
     ORDER BY sale.business_date DESC, sale.id DESC
     LIMIT $5::INTEGER OFFSET $6::INTEGER`,
    [storeId, from, to, search.trim(), pagination.fetchLimit, pagination.offset],
  )
  const page = paginatedResult(result.rows, pagination)
  response.json({ sales: page.rows, pagination: page.pagination })
})

reportsRouter.get('/home', requireStore, async (request, response) => {
  const today = currentBusinessDate()
  const [salesResult, debtResult, balanceResult, lowStockResult, activityResult, reminders] = await Promise.all([
    query(
      `WITH sold AS (
         SELECT COALESCE(SUM(total), 0::NUMERIC) AS total
         FROM sales
         WHERE store_id = $1::BIGINT AND business_date = $2::DATE AND status = 'recorded'
       ), returned AS (
         SELECT COALESCE(SUM(total), 0::NUMERIC) AS total
         FROM customer_returns
         WHERE store_id = $1::BIGINT AND business_date = $2::DATE
       )
       SELECT (sold.total - returned.total)::TEXT AS net_sales
       FROM sold CROSS JOIN returned`,
      [request.storeId, today],
    ),
    query(
      `WITH customer_accounts AS (
         SELECT customer_id,
           SUM(CASE direction WHEN 'debit' THEN amount_ils ELSE -amount_ils END) AS balance
         FROM customer_ledger WHERE store_id = $1::BIGINT GROUP BY customer_id
       ), supplier_accounts AS (
         SELECT supplier_id,
           SUM(CASE direction WHEN 'credit' THEN amount_ils ELSE -amount_ils END) AS balance
         FROM supplier_ledger WHERE store_id = $1::BIGINT GROUP BY supplier_id
       )
       SELECT
         COALESCE((SELECT SUM(GREATEST(balance, 0::NUMERIC)) FROM customer_accounts), 0::NUMERIC)::TEXT AS customer_debt,
         COALESCE((SELECT SUM(GREATEST(balance, 0::NUMERIC)) FROM supplier_accounts), 0::NUMERIC)::TEXT AS supplier_debt`,
      [request.storeId],
    ),
    query(
      `SELECT cash.currency_code, cash.balance::TEXT AS cash_balance,
         CASE WHEN cash.currency_code = 'ILS' THEN bank.balance_ils::TEXT ELSE NULL END AS bank_balance,
         CASE WHEN cash.currency_code = 'ILS' THEN (cash.balance + bank.balance_ils)::TEXT ELSE NULL END AS total_ils
       FROM store_cash_balances AS cash
       INNER JOIN store_bank_balances AS bank ON bank.store_id = cash.store_id
       WHERE cash.store_id = $1::BIGINT
       ORDER BY CASE cash.currency_code WHEN 'ILS' THEN 1 WHEN 'USD' THEN 2 ELSE 3 END`,
      [request.storeId],
    ),
    query(
      `SELECT COUNT(*)::TEXT AS count
       FROM store_inventory AS inventory
       INNER JOIN store_inventory_balances AS balances
         ON balances.store_id = inventory.store_id AND balances.product_id = inventory.product_id
       INNER JOIN products ON products.id = inventory.product_id
       WHERE inventory.store_id = $1::BIGINT
         AND inventory.is_active = TRUE AND products.is_active = TRUE
         AND balances.quantity <= inventory.reorder_level`,
      [request.storeId],
    ),
    query(
      `SELECT kind, id, document_number, amount, business_date, occurred_at
       FROM (
         SELECT 'sale'::TEXT AS kind, id::TEXT AS id,
           COALESCE(document_number, '#' || id::TEXT) AS document_number,
           total::TEXT AS amount, business_date::TEXT AS business_date, created_at AS occurred_at
         FROM sales WHERE store_id = $1::BIGINT AND status = 'recorded'
         UNION ALL
         SELECT 'purchase', id::TEXT, COALESCE(document_number, '#' || id::TEXT),
           total::TEXT, business_date::TEXT, created_at
         FROM purchases WHERE store_id = $1::BIGINT AND status = 'recorded'
         UNION ALL
         SELECT 'expense', id::TEXT, COALESCE(description, expense_category, '#' || id::TEXT),
           amount::TEXT, expense_date::TEXT, created_at
         FROM expenses WHERE store_id = $1::BIGINT AND status = 'recorded'
         UNION ALL
         SELECT 'customer_return', id::TEXT, document_number,
           total::TEXT, business_date::TEXT, created_at
         FROM customer_returns WHERE store_id = $1::BIGINT
         UNION ALL
         SELECT 'supplier_return', id::TEXT, document_number,
           total::TEXT, business_date::TEXT, created_at
         FROM supplier_returns WHERE store_id = $1::BIGINT
       ) AS activity
       ORDER BY occurred_at DESC, id DESC
       LIMIT 8`,
      [request.storeId],
    ),
    getCheckReminders({ storeId: request.storeId, today }),
  ])

  response.json({
    summary: {
      date: today,
      today_sales: salesResult.rows[0].net_sales,
      customer_debt: debtResult.rows[0].customer_debt,
      supplier_debt: debtResult.rows[0].supplier_debt,
      cash_balances: balanceResult.rows.map((row) => ({
        currency_code: row.currency_code,
        balance: row.cash_balance,
      })),
      bank_balance_ils: balanceResult.rows.find((row) => row.currency_code === 'ILS')?.bank_balance ?? '0',
      cash_and_bank_ils: balanceResult.rows.find((row) => row.currency_code === 'ILS')?.total_ils ?? '0',
      checks_needing_follow_up: String(reminders.follow_up.length + reminders.bounced.length),
      low_stock_count: lowStockResult.rows[0].count,
      recent_activity: activityResult.rows,
    },
  })
})

reportsRouter.get('/', async (request, response) => {
  const parsed = parseReportFilters(request.query)
  if (parsed.error) throw new AppError(parsed.error, 400, 'INVALID_REPORT_FILTERS')
  const { from, to, storeId } = parsed.value
  await requireActiveReportStore(storeId)
  const parameters = [storeId, from, to]

  const [financialResult, debtResult, inventoryResult, moneyResult, cashResult, checksResult, comparisonResult] = await Promise.all([
    query(
      `WITH sold AS (
         SELECT COALESCE(SUM(total), 0::NUMERIC) AS sales,
           COALESCE(SUM(cost_total), 0::NUMERIC) AS cost
         FROM sales
         WHERE ($1::BIGINT IS NULL OR store_id = $1)
           AND business_date BETWEEN $2::DATE AND $3::DATE AND status = 'recorded'
       ), sale_returns AS (
         SELECT COALESCE(SUM(total), 0::NUMERIC) AS sales,
           COALESCE(SUM(cost_total), 0::NUMERIC) AS cost
         FROM customer_returns
         WHERE ($1::BIGINT IS NULL OR store_id = $1)
           AND business_date BETWEEN $2::DATE AND $3::DATE
       ), bought AS (
         SELECT COALESCE(SUM(total), 0::NUMERIC) AS purchases
         FROM purchases
         WHERE ($1::BIGINT IS NULL OR store_id = $1)
           AND business_date BETWEEN $2::DATE AND $3::DATE AND status = 'recorded'
       ), purchase_returns AS (
         SELECT COALESCE(SUM(total), 0::NUMERIC) AS purchases
         FROM supplier_returns
         WHERE ($1::BIGINT IS NULL OR store_id = $1)
           AND business_date BETWEEN $2::DATE AND $3::DATE
       ), spent AS (
         SELECT COALESCE(SUM(amount), 0::NUMERIC) AS expenses
         FROM expenses
         WHERE ($1::BIGINT IS NULL OR store_id = $1)
           AND expense_date BETWEEN $2::DATE AND $3::DATE AND status = 'recorded'
       )
       SELECT
         (sold.sales - sale_returns.sales)::TEXT AS sales,
         (bought.purchases - purchase_returns.purchases)::TEXT AS purchases,
         (sold.cost - sale_returns.cost)::TEXT AS cost_of_goods,
         ((sold.sales - sale_returns.sales) - (sold.cost - sale_returns.cost))::TEXT AS gross_profit,
         spent.expenses::TEXT AS expenses,
         ((sold.sales - sale_returns.sales) - (sold.cost - sale_returns.cost) - spent.expenses)::TEXT AS net_profit,
         sale_returns.sales::TEXT AS sales_returns,
         purchase_returns.purchases::TEXT AS purchase_returns
       FROM sold CROSS JOIN sale_returns CROSS JOIN bought CROSS JOIN purchase_returns CROSS JOIN spent`,
      parameters,
    ),
    query(
      `WITH customer_accounts AS (
         SELECT customer_id,
           SUM(CASE direction WHEN 'debit' THEN amount_ils ELSE -amount_ils END) AS balance
         FROM customer_ledger WHERE ($1::BIGINT IS NULL OR store_id = $1) GROUP BY customer_id
       ), supplier_accounts AS (
         SELECT supplier_id,
           SUM(CASE direction WHEN 'credit' THEN amount_ils ELSE -amount_ils END) AS balance
         FROM supplier_ledger WHERE ($1::BIGINT IS NULL OR store_id = $1) GROUP BY supplier_id
       )
       SELECT
         COALESCE((SELECT SUM(GREATEST(balance, 0::NUMERIC)) FROM customer_accounts), 0::NUMERIC)::TEXT AS customer_debt,
         COALESCE((SELECT COUNT(*) FROM customer_accounts WHERE balance > 0), 0)::TEXT AS indebted_customers,
         COALESCE((SELECT SUM(GREATEST(balance, 0::NUMERIC)) FROM supplier_accounts), 0::NUMERIC)::TEXT AS supplier_debt,
         COALESCE((SELECT COUNT(*) FROM supplier_accounts WHERE balance > 0), 0)::TEXT AS owed_suppliers`,
      [storeId],
    ),
    query(
      `SELECT COALESCE(SUM(costs.inventory_value), 0::NUMERIC)::TEXT AS inventory_value,
         COUNT(*)::TEXT AS inventory_lines,
         COUNT(*) FILTER (WHERE balances.quantity <= inventory.reorder_level)::TEXT AS low_stock_count
       FROM store_inventory AS inventory
       INNER JOIN stores ON stores.id = inventory.store_id AND stores.is_active = TRUE
       INNER JOIN products ON products.id = inventory.product_id AND products.is_active = TRUE
       INNER JOIN store_inventory_balances AS balances
         ON balances.store_id = inventory.store_id AND balances.product_id = inventory.product_id
       INNER JOIN store_inventory_cost_balances AS costs
         ON costs.store_id = inventory.store_id AND costs.product_id = inventory.product_id
       WHERE inventory.is_active = TRUE AND ($1::BIGINT IS NULL OR inventory.store_id = $1)`,
      [storeId],
    ),
    query(
      `WITH ils AS (
         SELECT direction, amount FROM financial_movements
         WHERE currency_code = 'ILS' AND ($1::BIGINT IS NULL OR store_id = $1)
           AND (occurred_at AT TIME ZONE 'Asia/Hebron')::DATE BETWEEN $2::DATE AND $3::DATE
         UNION ALL
         SELECT direction, amount_ils AS amount FROM bank_movements
         WHERE ($1::BIGINT IS NULL OR store_id = $1)
           AND (occurred_at AT TIME ZONE 'Asia/Hebron')::DATE BETWEEN $2::DATE AND $3::DATE
       )
       SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'inflow'), 0::NUMERIC)::TEXT AS inflow_ils,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'outflow'), 0::NUMERIC)::TEXT AS outflow_ils,
         COALESCE(SUM(CASE direction WHEN 'inflow' THEN amount ELSE -amount END), 0::NUMERIC)::TEXT AS net_ils
       FROM ils`,
      parameters,
    ),
    query(
      `SELECT currency_code,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'inflow'), 0::NUMERIC)::TEXT AS inflow,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'outflow'), 0::NUMERIC)::TEXT AS outflow,
         COALESCE(SUM(CASE direction WHEN 'inflow' THEN amount ELSE -amount END), 0::NUMERIC)::TEXT AS net
       FROM financial_movements
       WHERE ($1::BIGINT IS NULL OR store_id = $1)
         AND (occurred_at AT TIME ZONE 'Asia/Hebron')::DATE BETWEEN $2::DATE AND $3::DATE
       GROUP BY currency_code
       ORDER BY CASE currency_code WHEN 'ILS' THEN 1 WHEN 'USD' THEN 2 ELSE 3 END`,
      parameters,
    ),
    query(
      `SELECT status, COUNT(*)::TEXT AS count, COALESCE(SUM(amount), 0::NUMERIC)::TEXT AS amount,
         SUM(COUNT(*)) OVER ()::TEXT AS total_count
       FROM checks
       WHERE ($1::BIGINT IS NULL OR store_id = $1)
         AND due_date BETWEEN $2::DATE AND $3::DATE
         AND ((direction = 'inflow' AND customer_id IS NOT NULL) OR is_owner_issued = TRUE)
       GROUP BY status`,
      parameters,
    ),
    query(
      `SELECT stores.id::TEXT AS store_id, stores.name AS store_name,
         (COALESCE(sold.total, 0::NUMERIC) - COALESCE(returned.total, 0::NUMERIC))::TEXT AS sales,
         (COALESCE(bought.total, 0::NUMERIC) - COALESCE(purchase_returns.total, 0::NUMERIC))::TEXT AS purchases,
         ((COALESCE(sold.total, 0::NUMERIC) - COALESCE(returned.total, 0::NUMERIC))
           - (COALESCE(sold.cost, 0::NUMERIC) - COALESCE(returned.cost, 0::NUMERIC)))::TEXT AS gross_profit,
         COALESCE(spent.total, 0::NUMERIC)::TEXT AS expenses,
         ((COALESCE(sold.total, 0::NUMERIC) - COALESCE(returned.total, 0::NUMERIC))
           - (COALESCE(sold.cost, 0::NUMERIC) - COALESCE(returned.cost, 0::NUMERIC))
           - COALESCE(spent.total, 0::NUMERIC))::TEXT AS net_profit
       FROM stores
       LEFT JOIN LATERAL (SELECT SUM(total) AS total, SUM(cost_total) AS cost FROM sales
         WHERE store_id = stores.id AND status = 'recorded' AND business_date BETWEEN $2::DATE AND $3::DATE) sold ON TRUE
       LEFT JOIN LATERAL (SELECT SUM(total) AS total, SUM(cost_total) AS cost FROM customer_returns
         WHERE store_id = stores.id AND business_date BETWEEN $2::DATE AND $3::DATE) returned ON TRUE
       LEFT JOIN LATERAL (SELECT SUM(total) AS total FROM purchases
         WHERE store_id = stores.id AND status = 'recorded' AND business_date BETWEEN $2::DATE AND $3::DATE) bought ON TRUE
       LEFT JOIN LATERAL (SELECT SUM(total) AS total FROM supplier_returns
         WHERE store_id = stores.id AND business_date BETWEEN $2::DATE AND $3::DATE) purchase_returns ON TRUE
       LEFT JOIN LATERAL (SELECT SUM(amount) AS total FROM expenses
         WHERE store_id = stores.id AND status = 'recorded' AND expense_date BETWEEN $2::DATE AND $3::DATE) spent ON TRUE
       WHERE stores.is_active = TRUE AND ($1::BIGINT IS NULL OR stores.id = $1)
       ORDER BY stores.id`,
      parameters,
    ),
  ])

  response.json({
    filters: { from, to, store_id: storeId },
    summary: {
      ...financialResult.rows[0],
      ...debtResult.rows[0],
      ...inventoryResult.rows[0],
      ...moneyResult.rows[0],
      check_count: checksResult.rows[0]?.total_count ?? '0',
      cash_movements: cashResult.rows,
      checks: checksResult.rows,
    },
    store_comparison: comparisonResult.rows,
  })
})

async function requireActiveReportStore(storeId) {
  if (!storeId) return
  const result = await query('SELECT id FROM stores WHERE id = $1::BIGINT AND is_active = TRUE', [storeId])
  if (result.rowCount === 0) throw new AppError('المتجر غير موجود أو غير فعال', 404, 'STORE_NOT_FOUND')
}
