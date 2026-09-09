-- Sale settlement is captured with immutable payment snapshots. Debt is the
-- unpaid sale balance in the customer ledger, never a fabricated payment row.

DROP TRIGGER sales_immutable ON sales;

ALTER TABLE sales
  ADD COLUMN paid_total NUMERIC(38, 12),
  ADD COLUMN remaining_due NUMERIC(38, 12);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM sales
    INNER JOIN (
      SELECT sale_id, SUM(converted_ils_amount) AS paid_total
      FROM payments
      WHERE sale_id IS NOT NULL
      GROUP BY sale_id
    ) AS paid ON paid.sale_id = sales.id
    WHERE paid.paid_total > sales.total
  ) THEN
    RAISE EXCEPTION
      'A historical sale has linked payments greater than its total. Correct it explicitly before applying 0012.';
  END IF;
END;
$$;

UPDATE sales
SET paid_total = COALESCE(paid.paid_total, 0::NUMERIC),
    remaining_due = total - COALESCE(paid.paid_total, 0::NUMERIC)
FROM (
  SELECT sales.id AS sale_id, SUM(payments.converted_ils_amount) AS paid_total
  FROM sales
  LEFT JOIN payments ON payments.sale_id = sales.id
  GROUP BY sales.id
) AS paid
WHERE paid.sale_id = sales.id;

ALTER TABLE sales
  ALTER COLUMN paid_total SET NOT NULL,
  ALTER COLUMN remaining_due SET NOT NULL,
  ADD CONSTRAINT sales_payment_totals_consistent CHECK (
    paid_total >= 0
    AND remaining_due >= 0
    AND total = paid_total + remaining_due
  );

COMMENT ON COLUMN sales.paid_total IS
  'Server-calculated sum of all sale payment rows in ILS, including checks.';
COMMENT ON COLUMN sales.remaining_due IS
  'Server-calculated unpaid ILS debt. No fake payment row is created for it.';

CREATE TRIGGER sales_immutable
BEFORE UPDATE OR DELETE ON sales
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- An anonymous sale may have cash or bank payments without inventing a party.
-- Unlinked historical payments still require exactly one real party.
ALTER TABLE payments
  DROP CONSTRAINT payments_single_party,
  ADD CONSTRAINT payments_party_or_sale CHECK (
    num_nonnulls(customer_id, supplier_id) = 1
    OR (sale_id IS NOT NULL AND num_nonnulls(customer_id, supplier_id) = 0)
  ),
  ADD CONSTRAINT sale_payment_method_supported CHECK (
    sale_id IS NULL OR payment_method IN ('cash', 'bank_card')
  ) NOT VALID,
  ADD CONSTRAINT sale_payment_direction_inflow CHECK (
    sale_id IS NULL OR direction = 'inflow'
  ) NOT VALID,
  ADD CONSTRAINT sale_payment_amount_positive CHECK (
    sale_id IS NULL OR original_amount > 0
  ) NOT VALID;

CREATE INDEX payments_sale_id_index ON payments (sale_id)
  WHERE sale_id IS NOT NULL;

COMMENT ON COLUMN payments.sale_id IS
  'Invoice allocation for immutable cash and bank/card payment snapshots.';

DROP TRIGGER payments_set_updated_at ON payments;
CREATE TRIGGER payments_immutable
BEFORE UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

ALTER TABLE checks
  ADD COLUMN sale_id BIGINT,
  ADD CONSTRAINT checks_sale_store_fk
    FOREIGN KEY (sale_id, store_id) REFERENCES sales (id, store_id),
  ADD CONSTRAINT sale_check_values_consistent CHECK (
    sale_id IS NULL
    OR (
      direction = 'inflow'
      AND amount > 0
      AND currency_code = 'ILS'
      AND MOD(amount, 0.50::NUMERIC) = 0
    )
  );

CREATE INDEX checks_sale_id_index ON checks (sale_id)
  WHERE sale_id IS NOT NULL;

COMMENT ON COLUMN checks.sale_id IS
  'Sale whose debt is reduced immediately by this incoming check.';

CREATE FUNCTION protect_sale_check_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.sale_id IS NOT NULL THEN
      RAISE EXCEPTION 'Sale check snapshots are append-only'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.sale_id IS DISTINCT FROM OLD.sale_id
     AND (NEW.sale_id IS NOT NULL OR OLD.sale_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A check cannot be attached to or detached from a saved sale'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.sale_id IS NOT NULL AND (
    NEW.store_id IS DISTINCT FROM OLD.store_id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.check_number IS DISTINCT FROM OLD.check_number
    OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.due_date IS DISTINCT FROM OLD.due_date
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
  ) THEN
    RAISE EXCEPTION 'Sale check payment facts cannot be changed'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER checks_sale_snapshot_protected
BEFORE UPDATE OR DELETE ON checks
FOR EACH ROW EXECUTE FUNCTION protect_sale_check_snapshot();

-- Bank receipts are deliberately separate from physical cash movements.
CREATE TABLE bank_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  amount_ils NUMERIC(38, 12) NOT NULL CHECK (amount_ils > 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  source_type TEXT NOT NULL,
  source_id BIGINT,
  description TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX bank_movements_store_occurred_index
  ON bank_movements (store_id, occurred_at);
CREATE INDEX bank_movements_source_index
  ON bank_movements (source_type, source_id);

CREATE TRIGGER bank_movements_append_only
BEFORE UPDATE OR DELETE ON bank_movements
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

ALTER TABLE financial_movements
  ADD CONSTRAINT sale_cash_movement_values_consistent CHECK (
    source_type <> 'sale_payment'
    OR (
      direction = 'inflow'
      AND amount > 0
      AND currency_code IN ('ILS', 'USD', 'JOD')
    )
  );

COMMENT ON TABLE bank_movements IS
  'Append-only bank/card ledger, separate from physical currency balances.';
COMMENT ON COLUMN financial_movements.amount IS
  'Physical amount in currency_code; sale cash remains separate as ILS, USD, or JOD.';
