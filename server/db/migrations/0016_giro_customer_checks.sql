-- A giro check is still a received customer check. These columns describe the
-- check's original owner; they do not transfer the check to a supplier.

ALTER TABLE checks
  ADD COLUMN is_giro BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN original_owner_name TEXT,
  ADD COLUMN original_owner_phone TEXT,
  ADD CONSTRAINT giro_check_original_owner_valid CHECK (
    (
      is_giro = FALSE
      AND original_owner_name IS NULL
      AND original_owner_phone IS NULL
    )
    OR (
      is_giro = TRUE
      AND customer_id IS NOT NULL
      AND supplier_id IS NULL
      AND original_owner_name IS NOT NULL
      AND BTRIM(original_owner_name) <> ''
      AND CHAR_LENGTH(original_owner_name) <= 150
      AND original_owner_phone IS NOT NULL
      AND BTRIM(original_owner_phone) <> ''
      AND CHAR_LENGTH(original_owner_phone) <= 50
    )
  );

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
     OR NEW.maintenance_id IS DISTINCT FROM OLD.maintenance_id
     OR NEW.maintenance_reversal_id IS DISTINCT FROM OLD.maintenance_reversal_id
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
     OR NEW.is_giro IS DISTINCT FROM OLD.is_giro
     OR NEW.original_owner_name IS DISTINCT FROM OLD.original_owner_name
     OR NEW.original_owner_phone IS DISTINCT FROM OLD.original_owner_phone
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
  THEN
    RAISE EXCEPTION 'Check payment facts cannot be changed'
      USING ERRCODE = '55000';
  END IF;

  -- Lifecycle status remains the only mutable business field.
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN checks.is_giro IS
  'True when the customer delivered a check originally owned by another person.';
COMMENT ON COLUMN checks.original_owner_name IS
  'Original check owner for giro checks; not a supplier or check-transfer recipient.';
