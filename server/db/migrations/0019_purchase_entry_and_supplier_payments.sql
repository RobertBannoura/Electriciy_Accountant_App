-- Purchases are immutable accounting documents. Their line costs are historical
-- snapshots; only products.current_purchase_price is refreshed by new purchases.

ALTER TABLE purchases
  ADD COLUMN total NUMERIC(38, 12),
  ADD COLUMN paid_total NUMERIC(38, 12),
  ADD COLUMN remaining_due NUMERIC(38, 12);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT purchases.id,
        COALESCE(SUM(purchase_items.quantity * purchase_items.unit_cost), 0::NUMERIC) AS total
      FROM purchases
      LEFT JOIN purchase_items ON purchase_items.purchase_id = purchases.id
      GROUP BY purchases.id
    ) AS totals
    LEFT JOIN (
      SELECT purchase_id, SUM(converted_ils_amount) AS paid_total
      FROM payments
      WHERE purchase_id IS NOT NULL
      GROUP BY purchase_id
    ) AS paid ON paid.purchase_id = totals.id
    WHERE COALESCE(paid.paid_total, 0::NUMERIC) > totals.total
  ) THEN
    RAISE EXCEPTION
      'A historical purchase has linked payments greater than its total. Correct it explicitly before applying 0019.';
  END IF;
END;
$$;

UPDATE purchases AS purchase
SET total = totals.total,
    paid_total = COALESCE(payments.paid_total, 0::NUMERIC),
    remaining_due = totals.total - COALESCE(payments.paid_total, 0::NUMERIC)
FROM (
  SELECT purchases.id, COALESCE(SUM(purchase_items.quantity * purchase_items.unit_cost), 0::NUMERIC) AS total
  FROM purchases
  LEFT JOIN purchase_items ON purchase_items.purchase_id = purchases.id
  GROUP BY purchases.id
) AS totals
LEFT JOIN (
  SELECT purchase_id, SUM(converted_ils_amount) AS paid_total
  FROM payments
  WHERE purchase_id IS NOT NULL
  GROUP BY purchase_id
) AS payments ON payments.purchase_id = totals.id
WHERE purchase.id = totals.id;

ALTER TABLE purchases
  ALTER COLUMN total SET NOT NULL,
  ALTER COLUMN paid_total SET NOT NULL,
  ALTER COLUMN remaining_due SET NOT NULL,
  ADD CONSTRAINT purchases_totals_consistent CHECK (
    total >= 0
    AND paid_total >= 0
    AND remaining_due >= 0
    AND total = paid_total + remaining_due
  );

ALTER TABLE purchase_items
  DROP CONSTRAINT purchase_items_quantity_nonzero,
  ADD CONSTRAINT purchase_items_quantity_positive CHECK (quantity > 0) NOT VALID,
  ADD CONSTRAINT purchase_items_unit_cost_nonnegative CHECK (unit_cost >= 0) NOT VALID,
  ADD CONSTRAINT purchase_items_unit_cost_half_ils CHECK (MOD(unit_cost, 0.50::NUMERIC) = 0) NOT VALID;

DROP TRIGGER purchases_set_updated_at ON purchases;
DROP TRIGGER purchase_items_set_updated_at ON purchase_items;

CREATE TRIGGER purchases_immutable
BEFORE UPDATE OR DELETE ON purchases
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

CREATE TRIGGER purchase_items_immutable
BEFORE UPDATE OR DELETE ON purchase_items
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

ALTER TABLE payments
  ADD CONSTRAINT purchase_payment_values_consistent CHECK (
    purchase_id IS NULL
    OR (
      supplier_id IS NOT NULL
      AND customer_id IS NULL
      AND direction = 'outflow'
      AND payment_method IN ('cash', 'bank_card')
      AND original_amount > 0
    )
  ) NOT VALID;

ALTER TABLE checks
  ADD COLUMN purchase_id BIGINT,
  ADD CONSTRAINT checks_purchase_store_fk
    FOREIGN KEY (purchase_id, store_id) REFERENCES purchases (id, store_id),
  ADD CONSTRAINT purchase_check_values_consistent CHECK (
    purchase_id IS NULL
    OR (
      supplier_id IS NOT NULL
      AND amount > 0
      AND currency_code = 'ILS'
      AND status IN ('pending', 'cleared', 'bounced')
    )
  );

CREATE INDEX checks_purchase_id_index ON checks (purchase_id)
  WHERE purchase_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_check_payment_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Check payment snapshots are append-only'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.sale_id IS DISTINCT FROM OLD.sale_id
     OR NEW.purchase_id IS DISTINCT FROM OLD.purchase_id
     OR NEW.maintenance_id IS DISTINCT FROM OLD.maintenance_id
     OR NEW.maintenance_reversal_id IS DISTINCT FROM OLD.maintenance_reversal_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.check_number IS DISTINCT FROM OLD.check_number
     OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.due_date IS DISTINCT FROM OLD.due_date
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.is_giro IS DISTINCT FROM OLD.is_giro
     OR NEW.original_owner_name IS DISTINCT FROM OLD.original_owner_name
     OR NEW.original_owner_phone IS DISTINCT FROM OLD.original_owner_phone
     OR NEW.is_owner_issued IS DISTINCT FROM OLD.is_owner_issued
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
  THEN
    -- A customer check can be allocated to a purchase only during its one-time
    -- supplier transfer. All other document/payment facts remain immutable.
    IF NOT (
      OLD.purchase_id IS NULL
      AND NEW.purchase_id IS NOT NULL
      AND NEW.supplier_id IS NOT NULL
      AND OLD.supplier_id IS NULL
      AND NEW.transferred_at IS NOT NULL
      AND OLD.transferred_at IS NULL
      AND NEW.sale_id IS NOT DISTINCT FROM OLD.sale_id
      AND NEW.maintenance_id IS NOT DISTINCT FROM OLD.maintenance_id
      AND NEW.maintenance_reversal_id IS NOT DISTINCT FROM OLD.maintenance_reversal_id
      AND NEW.store_id IS NOT DISTINCT FROM OLD.store_id
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.check_number IS NOT DISTINCT FROM OLD.check_number
      AND NEW.bank_name IS NOT DISTINCT FROM OLD.bank_name
      AND NEW.direction IS NOT DISTINCT FROM OLD.direction
      AND NEW.amount IS NOT DISTINCT FROM OLD.amount
      AND NEW.currency_code IS NOT DISTINCT FROM OLD.currency_code
      AND NEW.due_date IS NOT DISTINCT FROM OLD.due_date
      AND NEW.notes IS NOT DISTINCT FROM OLD.notes
      AND NEW.is_giro IS NOT DISTINCT FROM OLD.is_giro
      AND NEW.original_owner_name IS NOT DISTINCT FROM OLD.original_owner_name
      AND NEW.original_owner_phone IS NOT DISTINCT FROM OLD.original_owner_phone
      AND NEW.is_owner_issued IS NOT DISTINCT FROM OLD.is_owner_issued
      AND NEW.created_by_user_id IS NOT DISTINCT FROM OLD.created_by_user_id
    ) THEN
      RAISE EXCEPTION 'Check payment facts cannot be changed'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.transferred_at IS DISTINCT FROM OLD.transferred_at
  THEN
    IF OLD.customer_id IS NULL
       OR OLD.direction <> 'inflow'
       OR OLD.status <> 'pending'
       OR OLD.supplier_id IS NOT NULL
       OR OLD.transferred_at IS NOT NULL
       OR NEW.supplier_id IS NULL
       OR NEW.transferred_at IS NULL
       OR NEW.status <> 'pending'
    THEN
      RAISE EXCEPTION 'A customer check can be transferred to one supplier only while on hand'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('cleared', 'bounced'))
  THEN
    RAISE EXCEPTION 'Invalid check lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.cleared_at IS DISTINCT FROM OLD.cleared_at
     AND NOT (OLD.cleared_at IS NULL AND NEW.status = 'cleared' AND NEW.cleared_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Cleared timestamp is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.bounced_at IS DISTINCT FROM OLD.bounced_at
     AND NOT (OLD.bounced_at IS NULL AND NEW.status = 'bounced' AND NEW.bounced_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Bounced timestamp is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.bounced_reminder_stopped_at IS NOT NULL
     AND NEW.bounced_reminder_stopped_at IS DISTINCT FROM OLD.bounced_reminder_stopped_at
  THEN
    RAISE EXCEPTION 'Stopped bounced reminder cannot be restarted or rewritten'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE financial_movements
  ADD CONSTRAINT supplier_cash_payment_values_consistent CHECK (
    source_type NOT IN ('purchase_payment', 'supplier_payment')
    OR (direction = 'outflow' AND amount > 0 AND currency_code = 'ILS')
  );

ALTER TABLE bank_movements
  ADD CONSTRAINT supplier_bank_payment_values_consistent CHECK (
    source_type NOT IN ('purchase_payment', 'supplier_payment')
    OR (direction = 'outflow' AND amount_ils > 0)
  );

COMMENT ON COLUMN purchase_items.unit_cost IS
  'Immutable historical ILS purchase price captured when the purchase is saved.';
COMMENT ON COLUMN products.current_purchase_price IS
  'Latest saved purchase price; updating it never rewrites historical purchase_items.';
