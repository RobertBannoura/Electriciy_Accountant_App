import { pool } from './pool.js'
import { logSecurityEvent, safeErrorDetails } from '../security/security-log.js'

const requiredTables = [
  'auth_sessions',
  'audit_log',
  'barcodes',
  'bank_movements',
  'categories',
  'checks',
  'customer_ledger',
  'customer_return_items',
  'customer_returns',
  'customer_projects',
  'customers',
  'expenses',
  'expense_categories',
  'financial_movements',
  'inventory_cost_movements',
  'inventory_movements',
  'payments',
  'products',
  'purchase_items',
  'purchases',
  'push_subscriptions',
  'push_notification_events',
  'push_notification_preferences',
  'sale_items',
  'sales',
  'schema_migrations',
  'store_inventory',
  'stores',
  'supplier_ledger',
  'supplier_return_items',
  'supplier_returns',
  'suppliers',
  'system_settings',
  'users',
]

const requiredViews = [
  'customer_balances',
  'customer_store_balances',
  'store_inventory_balances',
  'store_inventory_cost_balances',
  'store_bank_balances',
  'store_cash_balances',
  'supplier_balances',
  'supplier_store_balances',
]

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function verifyDerivedDataAndConstraints(client) {
  await client.query('BEGIN')

  try {
    const storesResult = await client.query(
      'SELECT id, code FROM stores WHERE code = ANY($1::TEXT[])',
      [['AL_SALAM_ELECTRIC', 'SHOWROOM']],
    )
    const storesByCode = new Map(
      storesResult.rows.map((store) => [store.code, store.id]),
    )
    const firstStoreId = storesByCode.get('AL_SALAM_ELECTRIC')
    const secondStoreId = storesByCode.get('SHOWROOM')

    assert(firstStoreId && secondStoreId, 'Seeded store IDs are unavailable.')

    const categoryResult = await client.query(
      `
        INSERT INTO categories (name)
        VALUES ($1)
        RETURNING id
      `,
      ['تصنيف اختبار المخزون'],
    )
    const productResult = await client.query(
      `
        INSERT INTO products (category_id, name, unit_name)
        VALUES ($1, $2, 'متر')
        RETURNING id
      `,
      [categoryResult.rows[0].id, 'منتج اختبار المخزون'],
    )
    const productId = productResult.rows[0].id
    await client.query(
      `
        INSERT INTO store_inventory (store_id, product_id, reorder_level)
        VALUES ($1, $3, 2), ($2, $3, 10)
      `,
      [firstStoreId, secondStoreId, productId],
    )
    const inventoryMovementResult = await client.query(
      `
        INSERT INTO inventory_movements (
          store_id,
          product_id,
          movement_type,
          quantity_delta,
          occurred_at,
          source_type
        )
        VALUES
          ($1, $2, $3, $4::NUMERIC, NOW(), $5),
          ($1, $2, $6, $7::NUMERIC, NOW(), $5),
          ($8, $2, $3, $9::NUMERIC, NOW(), $5)
        RETURNING id, store_id, product_id, quantity_delta, occurred_at
      `,
      [
        firstStoreId,
        productId,
        'purchase',
        '7.5',
        'verification',
        'sale',
        '-2.25',
        secondStoreId,
        '35',
      ],
    )
    for (const movement of inventoryMovementResult.rows) {
      const unitCost = movement.store_id === secondStoreId ? '20' : '10'
      await client.query(
        `
          INSERT INTO inventory_cost_movements (
            store_id, product_id, inventory_movement_id, quantity_delta,
            unit_cost_snapshot, inventory_value_delta, occurred_at, source_type
          ) VALUES (
            $1, $2, $3, $4, $5::NUMERIC,
            ROUND($4::NUMERIC * $5::NUMERIC, 12), $6, 'verification'
          )
        `,
        [movement.store_id, movement.product_id, movement.id,
          movement.quantity_delta, unitCost, movement.occurred_at],
      )
    }
    await client.query('SET CONSTRAINTS inventory_movements_require_cost IMMEDIATE')
    await client.query('SET CONSTRAINTS inventory_movements_require_cost DEFERRED')
    const inventoryBalanceResult = await client.query(
      `
        SELECT quantity = $3::NUMERIC AS matches
        FROM store_inventory_balances
        WHERE store_id = $1 AND product_id = $2
      `,
      [firstStoreId, productId, '5.25'],
    )
    assert(
      inventoryBalanceResult.rows[0]?.matches,
      'Inventory balance is not derived correctly from movements.',
    )
    const secondInventoryBalanceResult = await client.query(
      `
        SELECT quantity = 35::NUMERIC AS matches
        FROM store_inventory_balances
        WHERE store_id = $1 AND product_id = $2
      `,
      [secondStoreId, productId],
    )
    assert(
      secondInventoryBalanceResult.rows[0]?.matches,
      'The same product does not keep an independent balance per store.',
    )
    const inventoryCostResult = await client.query(
      `
        SELECT quantity = 5.25::NUMERIC AS quantity_matches,
          inventory_value = 52.5::NUMERIC AS value_matches,
          weighted_average_cost = 10::NUMERIC AS average_matches
        FROM store_inventory_cost_balances
        WHERE store_id = $1 AND product_id = $2
      `,
      [firstStoreId, productId],
    )
    assert(
      inventoryCostResult.rows[0]?.quantity_matches
        && inventoryCostResult.rows[0]?.value_matches
        && inventoryCostResult.rows[0]?.average_matches,
      'Weighted-average inventory cost is not derived correctly from cost movements.',
    )

    const customerResult = await client.query(
      `
        INSERT INTO customers (name)
        VALUES ($1)
        RETURNING id
      `,
      ['عميل اختبار القيود'],
    )
    const customerId = customerResult.rows[0].id
    await client.query(
      `
        INSERT INTO customer_ledger (
          store_id,
          customer_id,
          direction,
          amount_ils,
          occurred_at,
          source_type
        )
        VALUES
          ($1, $3, 'debit', $4::NUMERIC, NOW(), $6),
          ($2, $3, 'credit', $5::NUMERIC, NOW(), $6)
      `,
      [firstStoreId, secondStoreId, customerId, '100.50', '25.25', 'verification'],
    )
    const customerBalanceResult = await client.query(
      `
        SELECT balance_ils = $2::NUMERIC AS matches
        FROM customer_balances
        WHERE customer_id = $1
      `,
      [customerId, '75.25'],
    )
    assert(
      customerBalanceResult.rows[0]?.matches,
      'Customer balance is not derived correctly from its ledger.',
    )

    const supplierResult = await client.query(
      `
        INSERT INTO suppliers (name)
        VALUES ($1)
        RETURNING id
      `,
      ['مورد اختبار القيود'],
    )
    const supplierId = supplierResult.rows[0].id
    await client.query(
      `
        INSERT INTO supplier_ledger (
          store_id,
          supplier_id,
          direction,
          amount_ils,
          occurred_at,
          source_type
        )
        VALUES
          ($1, $3, 'credit', $4::NUMERIC, NOW(), $6),
          ($2, $3, 'debit', $5::NUMERIC, NOW(), $6)
      `,
      [firstStoreId, secondStoreId, supplierId, '50.00', '10.00', 'verification'],
    )
    const supplierBalanceResult = await client.query(
      `
        SELECT balance_ils = $2::NUMERIC AS matches
        FROM supplier_balances
        WHERE supplier_id = $1
      `,
      [supplierId, '40.00'],
    )
    assert(
      supplierBalanceResult.rows[0]?.matches,
      'Supplier balance is not derived correctly from its ledger.',
    )

    await client.query('SAVEPOINT append_only_check')
    let appendOnlyError
    try {
      await client.query(
        'UPDATE inventory_movements SET quantity_delta = $1 WHERE id = $2',
        ['99', inventoryMovementResult.rows[0].id],
      )
    } catch (error) {
      appendOnlyError = error
    }
    await client.query('ROLLBACK TO SAVEPOINT append_only_check')
    await client.query('RELEASE SAVEPOINT append_only_check')
    assert(
      appendOnlyError?.code === '55000',
      'Inventory movements are not protected as append-only records.',
    )

    const crossStoreSale = await client.query(
      `
        INSERT INTO sales (
          store_id, customer_id, document_number, business_date, status,
          currency_code, items_subtotal, invoice_discount, total,
          paid_total, remaining_due
        )
        VALUES ($1, $2, $3, CURRENT_DATE, $4, 'ILS', 0, 0, 0, 0, 0)
        RETURNING id
      `,
      [secondStoreId, customerId, `VERIFY-${Date.now()}`, 'verification'],
    )
    assert(
      crossStoreSale.rowCount === 1,
      'A business-wide customer could not be used by the other store.',
    )
  } finally {
    await client.query('ROLLBACK')
  }
}

async function run() {
  const client = await pool.connect()

  try {
    const tablesResult = await client.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = ANY($2::TEXT[])
      `,
      ['public', requiredTables],
    )
    const foundTables = new Set(tablesResult.rows.map((row) => row.table_name))
    const missingTables = requiredTables.filter((table) => !foundTables.has(table))
    assert(missingTables.length === 0, `Missing tables: ${missingTables.join(', ')}`)

    const requiredPaymentMoneyColumns = [
      'currency_code',
      'original_amount',
      'exchange_rate',
      'converted_ils_amount',
    ]
    const paymentColumnsResult = await client.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'payments'
          AND column_name = ANY($2::TEXT[])
      `,
      ['public', requiredPaymentMoneyColumns],
    )
    const foundPaymentColumns = new Set(
      paymentColumnsResult.rows.map((row) => row.column_name),
    )
    const missingPaymentColumns = requiredPaymentMoneyColumns.filter(
      (column) => !foundPaymentColumns.has(column),
    )
    assert(
      missingPaymentColumns.length === 0,
      `Missing payment money columns: ${missingPaymentColumns.join(', ')}`,
    )

    const forbiddenPartyScopeColumns = await client.query(
      `
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name IN ('customers', 'customer_projects', 'suppliers')
              AND column_name = 'store_id')
            OR
            (table_name IN ('customer_ledger', 'supplier_ledger')
              AND column_name IN ('amount', 'currency_code'))
          )
      `,
    )
    assert(
      forbiddenPartyScopeColumns.rowCount === 0,
      `Store-owned party identity or multi-currency debt columns remain: ${JSON.stringify(forbiddenPartyScopeColumns.rows)}`,
    )

    const ilsLedgerColumns = await client.query(
      `
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('customer_ledger', 'supplier_ledger')
          AND column_name = 'amount_ils'
      `,
    )
    assert(
      ilsLedgerColumns.rowCount === 2,
      'Customer and supplier ledgers must expose amount_ils.',
    )

    const inventoryActiveResult = await client.query(
      `
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'store_inventory'
          AND column_name = 'is_active'
          AND is_nullable = 'NO'
      `,
    )
    assert(
      inventoryActiveResult.rowCount === 1,
      'store_inventory.is_active is missing or nullable.',
    )

    const barcodeColumnsResult = await client.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'barcodes'
          AND column_name = ANY($1::TEXT[])
      `,
      [['is_active', 'is_generated', 'retired_at']],
    )
    assert(
      barcodeColumnsResult.rowCount === 3,
      'Barcode lifecycle columns are missing.',
    )
    const barcodeSequenceResult = await client.query(
      "SELECT to_regclass('public.generated_barcode_sequence') IS NOT NULL AS exists",
    )
    assert(
      barcodeSequenceResult.rows[0]?.exists,
      'The non-cycling generated barcode sequence is missing.',
    )

    const viewsResult = await client.query(
      `
        SELECT table_name
        FROM information_schema.views
        WHERE table_schema = $1
          AND table_name = ANY($2::TEXT[])
      `,
      ['public', requiredViews],
    )
    const foundViews = new Set(viewsResult.rows.map((row) => row.table_name))
    const missingViews = requiredViews.filter((view) => !foundViews.has(view))
    assert(missingViews.length === 0, `Missing views: ${missingViews.join(', ')}`)

    const forbiddenColumnsResult = await client.query(
      `
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = ANY($2::TEXT[])
          AND column_name = ANY($3::TEXT[])
      `,
      [
        'public',
        ['customers', 'suppliers', 'store_inventory', 'products'],
        ['balance', 'current_balance', 'quantity', 'quantity_on_hand'],
      ],
    )
    assert(
      forbiddenColumnsResult.rowCount === 0,
      `Forbidden manually maintained columns: ${JSON.stringify(forbiddenColumnsResult.rows)}`,
    )

    const storesResult = await client.query(
      'SELECT code, name FROM stores WHERE code = ANY($1::TEXT[]) ORDER BY code',
      [['AL_SALAM_ELECTRIC', 'SHOWROOM']],
    )
    assert(storesResult.rowCount === 2, 'The two development stores were not seeded.')

    const adminResult = await client.query(
      `
        SELECT id
        FROM users
        WHERE role = 'admin'
          AND is_active = TRUE
      `,
    )
    assert(adminResult.rowCount >= 1, 'An active admin user was not provisioned.')

    await verifyDerivedDataAndConstraints(client)

    console.log(
      `Schema verified: ${requiredTables.length} tables, ${requiredViews.length} derived views, shared parties, ILS party ledgers, payment money snapshots, 2 stores, append-only records, and transaction store identity.`,
    )
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((error) => {
  logSecurityEvent('error', 'database_verification_failed', {
    ...safeErrorDetails(error),
    outcome: 'failure',
  })
  process.exitCode = 1
})
