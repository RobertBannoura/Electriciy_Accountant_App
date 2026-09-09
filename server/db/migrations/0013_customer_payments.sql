-- Customer receipts reuse immutable payment snapshots. The customer ledger is
-- the only source of debt; cash and bank effects remain in separate ledgers.

ALTER TABLE payments
  ADD CONSTRAINT customer_receipt_values_consistent CHECK (
    NOT (
      customer_id IS NOT NULL
      AND supplier_id IS NULL
      AND sale_id IS NULL
      AND purchase_id IS NULL
    )
    OR (
      direction = 'inflow'
      AND payment_method IN ('cash', 'bank_card')
      AND original_amount > 0
    )
  ) NOT VALID;

ALTER TABLE financial_movements
  ADD CONSTRAINT customer_cash_movement_values_consistent CHECK (
    source_type <> 'customer_payment'
    OR (
      direction = 'inflow'
      AND amount > 0
      AND currency_code IN ('ILS', 'USD', 'JOD')
    )
  );

DROP TRIGGER checks_sale_snapshot_protected ON checks;
DROP FUNCTION protect_sale_check_snapshot();

CREATE FUNCTION protect_check_payment_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Check payment snapshots are append-only'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.sale_id IS DISTINCT FROM OLD.sale_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
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
  THEN
    RAISE EXCEPTION 'Check payment facts cannot be changed'
      USING ERRCODE = '55000';
  END IF;

  -- Check status is deliberately the only business field that may change.
  RETURN NEW;
END;
$$;

CREATE TRIGGER checks_payment_snapshot_protected
BEFORE UPDATE OR DELETE ON checks
FOR EACH ROW EXECUTE FUNCTION protect_check_payment_snapshot();

COMMENT ON FUNCTION protect_check_payment_snapshot() IS
  'Protects customer and sale check payment facts while allowing explicit lifecycle status transitions.';
