import { query } from '../db/pool.js'

export async function getCustomerStatement({ customerId, from, to, storeId, projectId }) {
  const result = await query(
    `WITH enriched AS (
       SELECT ledger.id, ledger.store_id, stores.name AS store_name,
         ledger.direction, ledger.amount_ils, ledger.occurred_at,
         (ledger.occurred_at AT TIME ZONE 'Asia/Hebron')::DATE AS statement_date,
         ledger.source_type, ledger.source_id, ledger.notes,
         contextual_sale.customer_project_id AS project_id,
         projects.name AS project_name,
         COALESCE(source_sale.document_number, source_return.document_number,
           CASE WHEN source_check.id IS NOT NULL THEN 'شيك ' || source_check.check_number END,
           source_payment.reference) AS document_number,
         source_check.check_number, source_check.status AS check_status,
         source_payment.payment_method
       FROM customer_ledger AS ledger
       INNER JOIN stores ON stores.id = ledger.store_id
       LEFT JOIN sales AS source_sale
         ON ledger.source_type = 'sale' AND source_sale.id = ledger.source_id
       LEFT JOIN payments AS source_payment
         ON ledger.source_type IN ('sale_payment', 'payment', 'maintenance_payment', 'maintenance_reversal_payment')
        AND source_payment.id = ledger.source_id
       LEFT JOIN checks AS source_check
         ON ledger.source_type IN ('sale_check', 'check', 'check_bounce', 'maintenance_check', 'maintenance_reversal_check')
        AND source_check.id = ledger.source_id
       LEFT JOIN customer_returns AS source_return
         ON ledger.source_type = 'customer_return' AND source_return.id = ledger.source_id
       LEFT JOIN sales AS contextual_sale
         ON contextual_sale.id = COALESCE(source_sale.id, source_payment.sale_id,
           source_check.sale_id, source_return.sale_id)
       LEFT JOIN customer_projects AS projects
         ON projects.id = contextual_sale.customer_project_id
       WHERE ledger.customer_id = $1::BIGINT
         AND ($4::BIGINT IS NULL OR ledger.store_id = $4)
         AND ($5::BIGINT IS NULL OR contextual_sale.customer_project_id = $5)
     ), opening AS (
       SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount_ils ELSE -amount_ils END), 0::NUMERIC) AS balance
       FROM enriched WHERE statement_date < $2::DATE
     ), period_rows AS (
       SELECT enriched.*,
         opening.balance + SUM(CASE direction WHEN 'debit' THEN amount_ils ELSE -amount_ils END)
           OVER (ORDER BY occurred_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
       FROM enriched CROSS JOIN opening
       WHERE statement_date BETWEEN $2::DATE AND $3::DATE
     )
     SELECT opening.balance::TEXT AS opening_balance,
       (opening.balance + COALESCE((SELECT SUM(CASE direction WHEN 'debit' THEN amount_ils ELSE -amount_ils END) FROM period_rows), 0::NUMERIC))::TEXT AS closing_balance,
       COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
         'id', id::TEXT, 'date', statement_date::TEXT, 'occurred_at', occurred_at,
         'store_name', store_name, 'source_type', source_type,
         'source_id', source_id::TEXT, 'description', notes,
         'document_number', document_number, 'project_id', project_id::TEXT,
         'project_name', project_name, 'check_number', check_number,
         'check_status', check_status, 'payment_method', payment_method,
         'debit', CASE WHEN direction = 'debit' THEN amount_ils::TEXT ELSE '0' END,
         'credit', CASE WHEN direction = 'credit' THEN amount_ils::TEXT ELSE '0' END,
         'running_balance', running_balance::TEXT
       ) ORDER BY occurred_at, id) FROM period_rows), '[]'::JSONB) AS entries
     FROM opening`,
    [customerId, from, to, storeId, projectId],
  )
  return result.rows[0]
}

export async function getSupplierStatement({ supplierId, from, to, storeId }) {
  const result = await query(
    `WITH enriched AS (
       SELECT ledger.id, ledger.store_id, stores.name AS store_name,
         ledger.direction, ledger.amount_ils, ledger.occurred_at,
         (ledger.occurred_at AT TIME ZONE 'Asia/Hebron')::DATE AS statement_date,
         ledger.source_type, ledger.source_id, ledger.notes,
         COALESCE(source_purchase.document_number, source_return.document_number,
           CASE WHEN source_check.id IS NOT NULL THEN 'شيك ' || source_check.check_number END,
           source_payment.reference) AS document_number,
         source_check.check_number, source_check.status AS check_status,
         source_payment.payment_method,
         CASE WHEN source_purchase.id IS NULL THEN '[]'::JSONB ELSE COALESCE((
           SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
             'product', items.description, 'quantity', items.quantity::TEXT,
             'unit_price', items.unit_cost::TEXT,
             'line_total', (items.quantity * items.unit_cost)::TEXT
           ) ORDER BY items.id)
           FROM purchase_items AS items WHERE items.purchase_id = source_purchase.id
         ), '[]'::JSONB) END AS purchase_items
       FROM supplier_ledger AS ledger
       INNER JOIN stores ON stores.id = ledger.store_id
       LEFT JOIN purchases AS source_purchase
         ON ledger.source_type = 'purchase' AND source_purchase.id = ledger.source_id
       LEFT JOIN payments AS source_payment
         ON ledger.source_type IN ('purchase_payment', 'supplier_payment')
        AND source_payment.id = ledger.source_id
       LEFT JOIN checks AS source_check
         ON ledger.source_type IN ('owner_check', 'check_transfer', 'owner_check_bounce', 'check_transfer_bounce')
        AND source_check.id = ledger.source_id
       LEFT JOIN supplier_returns AS source_return
         ON ledger.source_type = 'supplier_return' AND source_return.id = ledger.source_id
       WHERE ledger.supplier_id = $1::BIGINT
         AND ($4::BIGINT IS NULL OR ledger.store_id = $4)
     ), opening AS (
       SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_ils ELSE -amount_ils END), 0::NUMERIC) AS balance
       FROM enriched WHERE statement_date < $2::DATE
     ), period_rows AS (
       SELECT enriched.*,
         opening.balance + SUM(CASE direction WHEN 'credit' THEN amount_ils ELSE -amount_ils END)
           OVER (ORDER BY occurred_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
       FROM enriched CROSS JOIN opening
       WHERE statement_date BETWEEN $2::DATE AND $3::DATE
     )
     SELECT opening.balance::TEXT AS opening_balance,
       (opening.balance + COALESCE((SELECT SUM(CASE direction WHEN 'credit' THEN amount_ils ELSE -amount_ils END) FROM period_rows), 0::NUMERIC))::TEXT AS closing_balance,
       COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
         'id', id::TEXT, 'date', statement_date::TEXT, 'occurred_at', occurred_at,
         'store_name', store_name, 'source_type', source_type,
         'source_id', source_id::TEXT, 'description', notes,
         'document_number', document_number, 'check_number', check_number,
         'check_status', check_status, 'payment_method', payment_method,
         'purchase_items', purchase_items,
         'debit', CASE WHEN direction = 'debit' THEN amount_ils::TEXT ELSE '0' END,
         'credit', CASE WHEN direction = 'credit' THEN amount_ils::TEXT ELSE '0' END,
         'running_balance', running_balance::TEXT
       ) ORDER BY occurred_at, id) FROM period_rows), '[]'::JSONB) AS entries
     FROM opening`,
    [supplierId, from, to, storeId],
  )
  return result.rows[0]
}
