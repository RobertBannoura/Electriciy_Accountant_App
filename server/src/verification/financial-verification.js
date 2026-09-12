import { pool } from '../db/pool.js'

const issueDescriptions = Object.freeze({
  SALE_LINE_MISMATCH: 'إجمالي بند البيع لا يساوي الكمية × السعر بعد خصم البند',
  SALE_INVOICE_TOTAL_MISMATCH: 'مجموع بنود البيع بعد خصم الفاتورة لا يساوي إجمالي الفاتورة',
  SALE_ITEMS_SUBTOTAL_MISMATCH: 'الإجمالي الفرعي المحفوظ لا يساوي مجموع بنود البيع',
  SALE_PAYMENT_TOTAL_MISMATCH: 'مجموع الدفعات والشيكات لا يساوي المدفوع المحفوظ للفاتورة',
  SALE_DEBT_TOTAL_MISMATCH: 'المدفوع مع الدين لا يساوي إجمالي الفاتورة',
  CUSTOMER_BALANCE_MISMATCH: 'حركة دفتر العميل لا تطابق المستند المالي المصدر',
  SUPPLIER_BALANCE_MISMATCH: 'حركة دفتر المورد لا تطابق المستند المالي المصدر',
  INVENTORY_BALANCE_MISMATCH: 'حركة المخزون لا تطابق بنود المستند المالي المصدر',
  INVENTORY_COST_QUANTITY_MISMATCH: 'كمية دفتر تكلفة المخزون لا تساوي كمية حركات المخزون',
  CASH_BALANCE_MISMATCH: 'حركة الصندوق لا تطابق الدفعة أو المصروف المصدر',
  CASH_UNSUPPORTED_CURRENCY: 'توجد حركة صندوق بعملة غير مدعومة',
  BANK_BALANCE_MISMATCH: 'حركة البنك لا تطابق الدفعة أو المصروف المصدر',
  CHECK_CUSTOMER_BOUNCE_MISMATCH: 'عكس شيك العميل المرتجع غير موجود مرة واحدة بالقيمة الصحيحة',
  CHECK_TRANSFER_BOUNCE_MISMATCH: 'الشيك المحول المرتجع لم يُعكس مرة واحدة لدى المورد',
  CHECK_OWNER_BOUNCE_MISMATCH: 'شيك المنشأة المرتجع لم يُعد رصيد المورد مرة واحدة',
  CHECK_UNEXPECTED_BOUNCE_REVERSAL: 'يوجد عكس ارتجاع لشيك غير مسجل كمرتجع',
  CHECK_CLEARED_PAYMENT_DUPLICATE: 'أثر دفع الشيك المحصل مفقود أو مكرر',
  REVERSAL_ORIGINAL_MISSING: 'عملية العكس لا ترتبط بسجل أصلي صالح',
  REVERSAL_DUPLICATED: 'تم تكرار عملية العكس للسجل الأصلي',
  CUSTOMER_RETURN_TOTAL_MISMATCH: 'إجماليات مرتجع العميل لا تطابق بنوده أو فاتورته الأصلية',
  SUPPLIER_RETURN_TOTAL_MISMATCH: 'إجماليات مرتجع المورد لا تطابق بنوده أو فاتورته الأصلية',
  CUSTOMER_RETURN_QUANTITY_EXCEEDED: 'إجمالي الكمية المرتجعة للعميل يتجاوز كمية بند البيع الأصلي',
  SUPPLIER_RETURN_QUANTITY_EXCEEDED: 'إجمالي الكمية المرتجعة للمورد يتجاوز كمية بند الشراء الأصلي',
})

const checks = Object.freeze([
  {
    key: 'sales',
    label: 'المبيعات',
    sql: `
      WITH line_totals AS (
        SELECT sale_id, COALESCE(SUM(line_total), 0::NUMERIC) AS total
        FROM sale_items GROUP BY sale_id
      ), payment_totals AS (
        SELECT sales.id AS sale_id,
          COALESCE((SELECT SUM(converted_ils_amount) FROM payments WHERE payments.sale_id = sales.id), 0::NUMERIC)
          + COALESCE((SELECT SUM(amount) FROM checks WHERE checks.sale_id = sales.id), 0::NUMERIC) AS total
        FROM sales
      )
      SELECT 'SALE_LINE_MISMATCH' AS code, items.id::TEXT AS entity_id,
        items.description AS reference,
        (items.quantity * items.unit_price - items.line_discount)::TEXT AS expected,
        items.line_total::TEXT AS actual
      FROM sale_items AS items
      WHERE items.line_total IS DISTINCT FROM items.quantity * items.unit_price - items.line_discount
      UNION ALL
      SELECT 'SALE_INVOICE_TOTAL_MISMATCH', sales.id::TEXT, sales.document_number,
        (COALESCE(lines.total, 0::NUMERIC) - sales.invoice_discount)::TEXT, sales.total::TEXT
      FROM sales LEFT JOIN line_totals AS lines ON lines.sale_id = sales.id
      WHERE sales.total IS DISTINCT FROM COALESCE(lines.total, 0::NUMERIC) - sales.invoice_discount
      UNION ALL
      SELECT 'SALE_ITEMS_SUBTOTAL_MISMATCH', sales.id::TEXT, sales.document_number,
        COALESCE(lines.total, 0::NUMERIC)::TEXT, sales.items_subtotal::TEXT
      FROM sales LEFT JOIN line_totals AS lines ON lines.sale_id = sales.id
      WHERE sales.items_subtotal IS DISTINCT FROM COALESCE(lines.total, 0::NUMERIC)
      UNION ALL
      SELECT 'SALE_PAYMENT_TOTAL_MISMATCH', sales.id::TEXT, sales.document_number,
        sales.paid_total::TEXT, payment_totals.total::TEXT
      FROM sales INNER JOIN payment_totals ON payment_totals.sale_id = sales.id
      WHERE sales.paid_total IS DISTINCT FROM payment_totals.total
      UNION ALL
      SELECT 'SALE_DEBT_TOTAL_MISMATCH', sales.id::TEXT, sales.document_number,
        sales.total::TEXT, (sales.paid_total + sales.remaining_due)::TEXT
      FROM sales
      WHERE sales.total IS DISTINCT FROM sales.paid_total + sales.remaining_due
    `,
  },
  {
    key: 'customers',
    label: 'أرصدة العملاء',
    sql: `
      WITH expected AS (
        SELECT store_id, customer_id, 'sale'::TEXT AS source_type, id AS source_id,
          'debit'::TEXT AS direction, total AS amount FROM sales WHERE customer_id IS NOT NULL
        UNION ALL
        SELECT store_id, customer_id, 'maintenance', id, 'debit', amount_ils
        FROM maintenance_records WHERE customer_id IS NOT NULL
        UNION ALL
        SELECT reversals.store_id, records.customer_id, 'maintenance_reversal', reversals.id,
          'credit', records.amount_ils
        FROM maintenance_reversals AS reversals
        INNER JOIN maintenance_records AS records ON records.id = reversals.maintenance_id
        WHERE records.customer_id IS NOT NULL
        UNION ALL
        SELECT store_id, customer_id,
          CASE WHEN sale_id IS NOT NULL THEN 'sale_payment'
               WHEN maintenance_id IS NOT NULL THEN 'maintenance_payment'
               WHEN maintenance_reversal_id IS NOT NULL THEN 'maintenance_reversal_payment'
               ELSE 'payment' END,
          id, CASE direction WHEN 'inflow' THEN 'credit' ELSE 'debit' END,
          converted_ils_amount
        FROM payments WHERE customer_id IS NOT NULL
        UNION ALL
        SELECT store_id, customer_id,
          CASE WHEN sale_id IS NOT NULL THEN 'sale_check'
               WHEN maintenance_id IS NOT NULL THEN 'maintenance_check'
               WHEN maintenance_reversal_id IS NOT NULL THEN 'maintenance_reversal_check'
               ELSE 'check' END,
          id, CASE direction WHEN 'inflow' THEN 'credit' ELSE 'debit' END, amount
        FROM checks WHERE customer_id IS NOT NULL
        UNION ALL
        SELECT store_id, customer_id, 'check_bounce', id, 'debit', amount
        FROM checks WHERE customer_id IS NOT NULL AND status = 'bounced'
        UNION ALL
        SELECT store_id, customer_id, 'customer_return', id, 'credit', total
        FROM customer_returns WHERE customer_id IS NOT NULL
      ), expected_totals AS (
        SELECT store_id, customer_id, source_type, source_id, direction,
          COUNT(*) AS entry_count, SUM(amount) AS amount
        FROM expected GROUP BY store_id, customer_id, source_type, source_id, direction
      ), actual_totals AS (
        SELECT store_id, customer_id, source_type, source_id, direction,
          COUNT(*) AS entry_count, SUM(amount_ils) AS amount
        FROM customer_ledger
        WHERE source_type IN (
          'sale', 'maintenance', 'maintenance_reversal', 'sale_payment',
          'maintenance_payment', 'maintenance_reversal_payment', 'payment',
          'sale_check', 'maintenance_check', 'maintenance_reversal_check',
          'check', 'check_bounce', 'customer_return'
        )
        GROUP BY store_id, customer_id, source_type, source_id, direction
      )
      SELECT 'CUSTOMER_BALANCE_MISMATCH' AS code,
        COALESCE(actual.source_id, expected.source_id)::TEXT AS entity_id,
        COALESCE(actual.source_type, expected.source_type) AS reference,
        (COALESCE(expected.entry_count, 0)::TEXT || ' × ' || COALESCE(expected.amount, 0::NUMERIC)::TEXT) AS expected,
        (COALESCE(actual.entry_count, 0)::TEXT || ' × ' || COALESCE(actual.amount, 0::NUMERIC)::TEXT) AS actual
      FROM expected_totals AS expected
      FULL JOIN actual_totals AS actual
        ON actual.store_id = expected.store_id
       AND actual.customer_id = expected.customer_id
       AND actual.source_type = expected.source_type
       AND actual.source_id IS NOT DISTINCT FROM expected.source_id
       AND actual.direction = expected.direction
      WHERE actual.entry_count IS DISTINCT FROM expected.entry_count
         OR actual.amount IS DISTINCT FROM expected.amount
    `,
  },
  {
    key: 'suppliers',
    label: 'أرصدة الموردين',
    sql: `
      WITH expected AS (
        SELECT store_id, supplier_id, 'purchase'::TEXT AS source_type, id AS source_id,
          'credit'::TEXT AS direction, total AS amount FROM purchases
        UNION ALL
        SELECT store_id, supplier_id,
          CASE WHEN purchase_id IS NOT NULL THEN 'purchase_payment' ELSE 'supplier_payment' END,
          id, 'debit', converted_ils_amount
        FROM payments WHERE supplier_id IS NOT NULL
        UNION ALL
        SELECT store_id, supplier_id,
          CASE WHEN is_owner_issued THEN 'owner_check' ELSE 'check_transfer' END,
          id, 'debit', amount
        FROM checks
        WHERE supplier_id IS NOT NULL
          AND (is_owner_issued = TRUE OR (customer_id IS NOT NULL AND transferred_at IS NOT NULL))
        UNION ALL
        SELECT store_id, supplier_id,
          CASE WHEN is_owner_issued THEN 'owner_check_bounce' ELSE 'check_transfer_bounce' END,
          id, 'credit', amount
        FROM checks
        WHERE supplier_id IS NOT NULL AND status = 'bounced'
          AND (is_owner_issued = TRUE OR (customer_id IS NOT NULL AND transferred_at IS NOT NULL))
        UNION ALL
        SELECT store_id, supplier_id, 'supplier_return', id, 'debit', total
        FROM supplier_returns
      ), expected_totals AS (
        SELECT store_id, supplier_id, source_type, source_id, direction,
          COUNT(*) AS entry_count, SUM(amount) AS amount
        FROM expected GROUP BY store_id, supplier_id, source_type, source_id, direction
      ), actual_totals AS (
        SELECT store_id, supplier_id, source_type, source_id, direction,
          COUNT(*) AS entry_count, SUM(amount_ils) AS amount
        FROM supplier_ledger
        WHERE source_type IN (
          'purchase', 'purchase_payment', 'supplier_payment', 'owner_check',
          'check_transfer', 'owner_check_bounce', 'check_transfer_bounce',
          'supplier_return'
        )
        GROUP BY store_id, supplier_id, source_type, source_id, direction
      )
      SELECT 'SUPPLIER_BALANCE_MISMATCH' AS code,
        COALESCE(actual.source_id, expected.source_id)::TEXT AS entity_id,
        COALESCE(actual.source_type, expected.source_type) AS reference,
        (COALESCE(expected.entry_count, 0)::TEXT || ' × ' || COALESCE(expected.amount, 0::NUMERIC)::TEXT) AS expected,
        (COALESCE(actual.entry_count, 0)::TEXT || ' × ' || COALESCE(actual.amount, 0::NUMERIC)::TEXT) AS actual
      FROM expected_totals AS expected
      FULL JOIN actual_totals AS actual
        ON actual.store_id = expected.store_id
       AND actual.supplier_id = expected.supplier_id
       AND actual.source_type = expected.source_type
       AND actual.source_id IS NOT DISTINCT FROM expected.source_id
       AND actual.direction = expected.direction
      WHERE actual.entry_count IS DISTINCT FROM expected.entry_count
         OR actual.amount IS DISTINCT FROM expected.amount
    `,
  },
  {
    key: 'inventory',
    label: 'المخزون',
    sql: `
      WITH expected AS (
        SELECT sales.store_id, items.product_id, 'sale'::TEXT AS source_type,
          sales.id AS source_id, -SUM(items.quantity) AS quantity
        FROM sales INNER JOIN sale_items AS items ON items.sale_id = sales.id
        WHERE items.product_id IS NOT NULL
        GROUP BY sales.store_id, items.product_id, sales.id
        UNION ALL
        SELECT purchases.store_id, items.product_id, 'purchase', purchases.id,
          SUM(items.quantity)
        FROM purchases INNER JOIN purchase_items AS items ON items.purchase_id = purchases.id
        WHERE items.product_id IS NOT NULL
        GROUP BY purchases.store_id, items.product_id, purchases.id
        UNION ALL
        SELECT returns.store_id, items.product_id, 'customer_return', returns.id,
          SUM(items.quantity)
        FROM customer_returns AS returns
        INNER JOIN customer_return_items AS items ON items.customer_return_id = returns.id
        GROUP BY returns.store_id, items.product_id, returns.id
        UNION ALL
        SELECT returns.store_id, items.product_id, 'supplier_return', returns.id,
          -SUM(items.quantity)
        FROM supplier_returns AS returns
        INNER JOIN supplier_return_items AS items ON items.supplier_return_id = returns.id
        GROUP BY returns.store_id, items.product_id, returns.id
      ), actual AS (
        SELECT store_id, product_id, source_type, source_id,
          SUM(quantity_delta) AS quantity
        FROM inventory_movements
        WHERE source_type IN ('sale', 'purchase', 'customer_return', 'supplier_return')
        GROUP BY store_id, product_id, source_type, source_id
      ), document_issues AS (
        SELECT COALESCE(actual.store_id, expected.store_id) AS store_id,
          COALESCE(actual.product_id, expected.product_id) AS product_id,
          COALESCE(actual.source_type, expected.source_type) AS source_type,
          COALESCE(actual.source_id, expected.source_id) AS source_id,
          expected.quantity AS expected_quantity, actual.quantity AS actual_quantity
        FROM expected FULL JOIN actual
          ON actual.store_id = expected.store_id
         AND actual.product_id = expected.product_id
         AND actual.source_type = expected.source_type
         AND actual.source_id = expected.source_id
        WHERE actual.quantity IS DISTINCT FROM expected.quantity
      ), movement_totals AS (
        SELECT inventory.store_id, inventory.product_id,
          COALESCE(SUM(movements.quantity_delta), 0::NUMERIC) AS quantity
        FROM store_inventory AS inventory
        LEFT JOIN inventory_movements AS movements
          ON movements.store_id = inventory.store_id AND movements.product_id = inventory.product_id
        GROUP BY inventory.store_id, inventory.product_id
      )
      SELECT 'INVENTORY_BALANCE_MISMATCH' AS code,
        (store_id::TEXT || ':' || product_id::TEXT || ':' || COALESCE(source_id::TEXT, 'null')) AS entity_id,
        source_type AS reference, COALESCE(expected_quantity, 0::NUMERIC)::TEXT AS expected,
        COALESCE(actual_quantity, 0::NUMERIC)::TEXT AS actual
      FROM document_issues
      UNION ALL
      SELECT 'INVENTORY_COST_QUANTITY_MISMATCH',
        (inventory.store_id::TEXT || ':' || inventory.product_id::TEXT), products.name,
        movement_totals.quantity::TEXT, costs.quantity::TEXT
      FROM store_inventory AS inventory
      INNER JOIN products ON products.id = inventory.product_id
      INNER JOIN movement_totals
        ON movement_totals.store_id = inventory.store_id AND movement_totals.product_id = inventory.product_id
      LEFT JOIN store_inventory_cost_balances AS costs
        ON costs.store_id = inventory.store_id AND costs.product_id = inventory.product_id
      WHERE costs.quantity IS DISTINCT FROM movement_totals.quantity
    `,
  },
  {
    key: 'cash',
    label: 'الصندوق',
    sql: `
      WITH expected AS (
        SELECT store_id,
          CASE WHEN sale_id IS NOT NULL THEN 'sale_payment'
               WHEN maintenance_id IS NOT NULL THEN 'maintenance_payment'
               WHEN maintenance_reversal_id IS NOT NULL THEN 'maintenance_reversal_payment'
               WHEN supplier_id IS NOT NULL AND purchase_id IS NOT NULL THEN 'purchase_payment'
               WHEN supplier_id IS NOT NULL THEN 'supplier_payment'
               ELSE 'customer_payment' END AS source_type,
          id AS source_id, direction, original_amount AS amount, currency_code
        FROM payments WHERE payment_method = 'cash'
        UNION ALL
        SELECT store_id, 'expense', id, 'outflow', amount, 'ILS' FROM expenses
        WHERE status = 'recorded' AND payment_method = 'cash'
      ), actual AS (
        SELECT store_id, source_type, source_id, direction, amount, currency_code
        FROM financial_movements
        WHERE source_type IN (
          'sale_payment', 'maintenance_payment', 'maintenance_reversal_payment',
          'purchase_payment', 'supplier_payment', 'customer_payment', 'expense'
        )
      )
      SELECT 'CASH_BALANCE_MISMATCH' AS code,
        COALESCE(actual.source_id, expected.source_id)::TEXT AS entity_id,
        COALESCE(actual.source_type, expected.source_type) AS reference,
        (COALESCE(expected.direction, 'missing') || ' ' || COALESCE(expected.amount, 0::NUMERIC)::TEXT || ' ' || COALESCE(expected.currency_code, 'missing')) AS expected,
        (COALESCE(actual.direction, 'missing') || ' ' || COALESCE(actual.amount, 0::NUMERIC)::TEXT || ' ' || COALESCE(actual.currency_code, 'missing')) AS actual
      FROM expected FULL JOIN actual
        ON actual.store_id = expected.store_id
       AND actual.source_type = expected.source_type
       AND actual.source_id = expected.source_id
      WHERE actual.direction IS DISTINCT FROM expected.direction
         OR actual.amount IS DISTINCT FROM expected.amount
         OR actual.currency_code IS DISTINCT FROM expected.currency_code
      UNION ALL
      SELECT 'CASH_UNSUPPORTED_CURRENCY', movements.id::TEXT, movements.currency_code,
        'ILS/USD/JOD', COALESCE(movements.currency_code, 'NULL')
      FROM financial_movements AS movements
      WHERE movements.currency_code IS NULL OR movements.currency_code NOT IN ('ILS', 'USD', 'JOD')
    `,
  },
  {
    key: 'bank',
    label: 'البنك',
    sql: `
      WITH expected AS (
        SELECT store_id,
          CASE WHEN sale_id IS NOT NULL THEN 'sale_payment'
               WHEN maintenance_id IS NOT NULL THEN 'maintenance_payment'
               WHEN maintenance_reversal_id IS NOT NULL THEN 'maintenance_reversal_payment'
               WHEN supplier_id IS NOT NULL AND purchase_id IS NOT NULL THEN 'purchase_payment'
               WHEN supplier_id IS NOT NULL THEN 'supplier_payment'
               ELSE 'customer_payment' END AS source_type,
          id AS source_id, direction, converted_ils_amount AS amount
        FROM payments WHERE payment_method = 'bank_card'
        UNION ALL
        SELECT store_id, 'expense', id, 'outflow', amount FROM expenses
        WHERE status = 'recorded' AND payment_method = 'bank_card'
      ), actual AS (
        SELECT store_id, source_type, source_id, direction, amount_ils AS amount
        FROM bank_movements
        WHERE source_type IN (
          'sale_payment', 'maintenance_payment', 'maintenance_reversal_payment',
          'purchase_payment', 'supplier_payment', 'customer_payment', 'expense'
        )
      )
      SELECT 'BANK_BALANCE_MISMATCH' AS code,
        COALESCE(actual.source_id, expected.source_id)::TEXT AS entity_id,
        COALESCE(actual.source_type, expected.source_type) AS reference,
        (COALESCE(expected.direction, 'missing') || ' ' || COALESCE(expected.amount, 0::NUMERIC)::TEXT) AS expected,
        (COALESCE(actual.direction, 'missing') || ' ' || COALESCE(actual.amount, 0::NUMERIC)::TEXT) AS actual
      FROM expected FULL JOIN actual
        ON actual.store_id = expected.store_id
       AND actual.source_type = expected.source_type
       AND actual.source_id = expected.source_id
      WHERE actual.direction IS DISTINCT FROM expected.direction
         OR actual.amount IS DISTINCT FROM expected.amount
    `,
  },
  {
    key: 'checks',
    label: 'الشيكات',
    sql: `
      WITH customer_effects AS (
        SELECT source_id, customer_id, store_id,
          COUNT(*) FILTER (WHERE source_type IN ('check', 'sale_check', 'maintenance_check')) AS original_count,
          COALESCE(SUM(CASE WHEN source_type IN ('check', 'sale_check', 'maintenance_check') AND direction = 'credit' THEN amount_ils ELSE 0 END), 0::NUMERIC) AS original_amount,
          COUNT(*) FILTER (WHERE source_type = 'check_bounce') AS bounce_count,
          COALESCE(SUM(CASE WHEN source_type = 'check_bounce' AND direction = 'debit' THEN amount_ils ELSE 0 END), 0::NUMERIC) AS bounce_amount
        FROM customer_ledger
        WHERE source_type IN ('check', 'sale_check', 'maintenance_check', 'check_bounce')
        GROUP BY source_id, customer_id, store_id
      ), supplier_effects AS (
        SELECT source_id, supplier_id, store_id,
          COUNT(*) FILTER (WHERE source_type = 'check_transfer') AS transfer_count,
          COUNT(*) FILTER (WHERE source_type = 'owner_check') AS owner_count,
          COALESCE(SUM(CASE WHEN source_type = 'owner_check' AND direction = 'debit' THEN amount_ils ELSE 0 END), 0::NUMERIC) AS owner_amount,
          COUNT(*) FILTER (WHERE source_type = 'check_transfer_bounce') AS transfer_bounce_count,
          COUNT(*) FILTER (WHERE source_type = 'owner_check_bounce') AS owner_bounce_count,
          COALESCE(SUM(CASE WHEN source_type = 'check_transfer_bounce' AND direction = 'credit' THEN amount_ils ELSE 0 END), 0::NUMERIC) AS transfer_bounce_amount,
          COALESCE(SUM(CASE WHEN source_type = 'owner_check_bounce' AND direction = 'credit' THEN amount_ils ELSE 0 END), 0::NUMERIC) AS owner_bounce_amount
        FROM supplier_ledger
        WHERE source_type IN ('check_transfer', 'owner_check', 'check_transfer_bounce', 'owner_check_bounce')
        GROUP BY source_id, supplier_id, store_id
      ), facts AS (
        SELECT checks.*,
          COALESCE(customer_effects.original_count, 0) AS customer_original_count,
          COALESCE(customer_effects.original_amount, 0::NUMERIC) AS customer_original_amount,
          COALESCE(customer_effects.bounce_count, 0) AS customer_bounce_count,
          COALESCE(customer_effects.bounce_amount, 0::NUMERIC) AS customer_bounce_amount,
          COALESCE(supplier_effects.transfer_count, 0) AS transfer_count,
          COALESCE(supplier_effects.owner_count, 0) AS owner_count,
          COALESCE(supplier_effects.owner_amount, 0::NUMERIC) AS owner_amount,
          COALESCE(supplier_effects.transfer_bounce_count, 0) AS transfer_bounce_count,
          COALESCE(supplier_effects.owner_bounce_count, 0) AS owner_bounce_count,
          COALESCE(supplier_effects.transfer_bounce_amount, 0::NUMERIC) AS transfer_bounce_amount,
          COALESCE(supplier_effects.owner_bounce_amount, 0::NUMERIC) AS owner_bounce_amount
        FROM checks
        LEFT JOIN customer_effects ON customer_effects.source_id = checks.id
          AND customer_effects.customer_id = checks.customer_id
          AND customer_effects.store_id = checks.store_id
        LEFT JOIN supplier_effects ON supplier_effects.source_id = checks.id
          AND supplier_effects.supplier_id = checks.supplier_id
          AND supplier_effects.store_id = checks.store_id
      )
      SELECT 'CHECK_CUSTOMER_BOUNCE_MISMATCH' AS code, id::TEXT AS entity_id,
        check_number AS reference, ('1 × ' || amount::TEXT) AS expected,
        (customer_bounce_count::TEXT || ' × ' || customer_bounce_amount::TEXT) AS actual
      FROM facts
      WHERE status = 'bounced' AND customer_id IS NOT NULL
        AND (customer_bounce_count <> 1 OR customer_bounce_amount <> amount)
      UNION ALL
      SELECT 'CHECK_TRANSFER_BOUNCE_MISMATCH', id::TEXT, check_number,
        ('1 × ' || amount::TEXT), (transfer_bounce_count::TEXT || ' × ' || transfer_bounce_amount::TEXT)
      FROM facts
      WHERE status = 'bounced' AND customer_id IS NOT NULL AND supplier_id IS NOT NULL AND transferred_at IS NOT NULL
        AND (transfer_bounce_count <> 1 OR transfer_bounce_amount <> amount)
      UNION ALL
      SELECT 'CHECK_OWNER_BOUNCE_MISMATCH', id::TEXT, check_number,
        ('1 × ' || amount::TEXT), (owner_bounce_count::TEXT || ' × ' || owner_bounce_amount::TEXT)
      FROM facts
      WHERE status = 'bounced' AND is_owner_issued = TRUE
        AND (owner_bounce_count <> 1 OR owner_bounce_amount <> amount)
      UNION ALL
      SELECT 'CHECK_UNEXPECTED_BOUNCE_REVERSAL', id::TEXT, check_number, '0',
        (customer_bounce_count + transfer_bounce_count + owner_bounce_count)::TEXT
      FROM facts
      WHERE status <> 'bounced'
        AND (customer_bounce_count + transfer_bounce_count + owner_bounce_count) <> 0
      UNION ALL
      SELECT 'CHECK_CLEARED_PAYMENT_DUPLICATE', id::TEXT, check_number,
        ('1 × ' || amount::TEXT),
        (CASE WHEN is_owner_issued
          THEN owner_count::TEXT || ' × ' || owner_amount::TEXT
          ELSE customer_original_count::TEXT || ' × ' || customer_original_amount::TEXT END)
      FROM facts
      WHERE status = 'cleared' AND (is_owner_issued = TRUE OR (customer_id IS NOT NULL AND direction = 'inflow'))
        AND (CASE WHEN is_owner_issued
          THEN owner_count <> 1 OR owner_amount <> amount
          ELSE customer_original_count <> 1 OR customer_original_amount <> amount END)
      UNION ALL
      SELECT 'CHECK_UNEXPECTED_BOUNCE_REVERSAL', ledger.id::TEXT, ledger.source_id::TEXT,
        'شيك عميل مرتجع مطابق', 'غير مطابق'
      FROM customer_ledger AS ledger
      LEFT JOIN checks ON checks.id = ledger.source_id
        AND checks.store_id = ledger.store_id AND checks.customer_id = ledger.customer_id
        AND checks.status = 'bounced'
      WHERE ledger.source_type = 'check_bounce' AND checks.id IS NULL
      UNION ALL
      SELECT 'CHECK_UNEXPECTED_BOUNCE_REVERSAL', ledger.id::TEXT, ledger.source_id::TEXT,
        'شيك مورد مرتجع مطابق', 'غير مطابق'
      FROM supplier_ledger AS ledger
      LEFT JOIN checks ON checks.id = ledger.source_id
        AND checks.store_id = ledger.store_id AND checks.supplier_id = ledger.supplier_id
        AND checks.status = 'bounced'
        AND ((ledger.source_type = 'owner_check_bounce' AND checks.is_owner_issued = TRUE)
          OR (ledger.source_type = 'check_transfer_bounce' AND checks.customer_id IS NOT NULL AND checks.transferred_at IS NOT NULL))
      WHERE ledger.source_type IN ('owner_check_bounce', 'check_transfer_bounce') AND checks.id IS NULL
    `,
  },
  {
    key: 'reversals',
    label: 'عمليات العكس',
    sql: `
      WITH customer_return_totals AS (
        SELECT returns.id, COUNT(items.id) AS item_count,
          COALESCE(SUM(items.line_total), 0::NUMERIC) AS total,
          COALESCE(SUM(items.cost_total), 0::NUMERIC) AS cost_total
        FROM customer_returns AS returns
        LEFT JOIN customer_return_items AS items ON items.customer_return_id = returns.id
        GROUP BY returns.id
      ), supplier_return_totals AS (
        SELECT returns.id, COUNT(items.id) AS item_count,
          COALESCE(SUM(items.line_total), 0::NUMERIC) AS total,
          COALESCE(SUM(items.inventory_cost_total), 0::NUMERIC) AS cost_total
        FROM supplier_returns AS returns
        LEFT JOIN supplier_return_items AS items ON items.supplier_return_id = returns.id
        GROUP BY returns.id
      ), customer_returned_quantities AS (
        SELECT sale_item_id, SUM(quantity) AS quantity
        FROM customer_return_items GROUP BY sale_item_id
      ), supplier_returned_quantities AS (
        SELECT purchase_item_id, SUM(quantity) AS quantity
        FROM supplier_return_items GROUP BY purchase_item_id
      )
      SELECT 'REVERSAL_ORIGINAL_MISSING' AS code, reversals.id::TEXT AS entity_id,
        reversals.maintenance_id::TEXT AS reference, 'سجل صيانة أصلي' AS expected, 'مفقود' AS actual
      FROM maintenance_reversals AS reversals
      LEFT JOIN maintenance_records AS original
        ON original.id = reversals.maintenance_id AND original.store_id = reversals.store_id
      WHERE original.id IS NULL
      UNION ALL
      SELECT 'REVERSAL_DUPLICATED', MIN(reversals.id)::TEXT, reversals.maintenance_id::TEXT,
        '1', COUNT(*)::TEXT
      FROM maintenance_reversals AS reversals
      GROUP BY reversals.maintenance_id HAVING COUNT(*) <> 1
      UNION ALL
      SELECT 'CUSTOMER_RETURN_TOTAL_MISMATCH', returns.id::TEXT, returns.document_number,
        (returns.total::TEXT || ' / ' || returns.cost_total::TEXT),
        (totals.total::TEXT || ' / ' || totals.cost_total::TEXT)
      FROM customer_returns AS returns
      LEFT JOIN sales ON sales.id = returns.sale_id AND sales.store_id = returns.store_id
      INNER JOIN customer_return_totals AS totals ON totals.id = returns.id
      WHERE sales.id IS NULL OR totals.item_count = 0 OR totals.total <> returns.total
        OR totals.cost_total <> returns.cost_total OR sales.customer_id IS DISTINCT FROM returns.customer_id
      UNION ALL
      SELECT 'SUPPLIER_RETURN_TOTAL_MISMATCH', returns.id::TEXT, returns.document_number,
        (returns.total::TEXT || ' / ' || returns.inventory_cost_total::TEXT),
        (totals.total::TEXT || ' / ' || totals.cost_total::TEXT)
      FROM supplier_returns AS returns
      LEFT JOIN purchases ON purchases.id = returns.purchase_id AND purchases.store_id = returns.store_id
      INNER JOIN supplier_return_totals AS totals ON totals.id = returns.id
      WHERE purchases.id IS NULL OR totals.item_count = 0 OR totals.total <> returns.total
        OR totals.cost_total <> returns.inventory_cost_total OR purchases.supplier_id IS DISTINCT FROM returns.supplier_id
      UNION ALL
      SELECT 'CUSTOMER_RETURN_QUANTITY_EXCEEDED', items.id::TEXT, items.description,
        items.quantity::TEXT, returned.quantity::TEXT
      FROM customer_returned_quantities AS returned
      INNER JOIN sale_items AS items ON items.id = returned.sale_item_id
      WHERE returned.quantity > items.quantity
      UNION ALL
      SELECT 'SUPPLIER_RETURN_QUANTITY_EXCEEDED', items.id::TEXT, items.description,
        items.quantity::TEXT, returned.quantity::TEXT
      FROM supplier_returned_quantities AS returned
      INNER JOIN purchase_items AS items ON items.id = returned.purchase_item_id
      WHERE returned.quantity > items.quantity
    `,
  },
])

async function runCheck(client, definition) {
  const result = await client.query(`
    SELECT issues.*, COUNT(*) OVER()::INTEGER AS total_issues
    FROM (${definition.sql}) AS issues
    ORDER BY issues.code, issues.entity_id
    LIMIT 200
  `)
  const issueCount = result.rows[0]?.total_issues ?? 0
  return {
    key: definition.key,
    label: definition.label,
    status: issueCount === 0 ? 'ok' : 'warning',
    issueCount,
    issues: result.rows.map((row) => ({
      code: row.code,
      description: issueDescriptions[row.code] ?? row.code,
      entityId: row.entity_id,
      reference: row.reference,
      expected: row.expected,
      actual: row.actual,
    })),
  }
}

export async function verifyFinancialAccounts({ connect = () => pool.connect(), now = () => new Date() } = {}) {
  const client = await connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const sections = []
    for (const definition of checks) sections.push(await runCheck(client, definition))
    await client.query('COMMIT')
    return {
      verifiedAt: now().toISOString(),
      status: sections.every((section) => section.status === 'ok') ? 'ok' : 'warning',
      sections,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export const financialVerificationChecks = checks
