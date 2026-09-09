-- A supplier transfer changes custody of the existing physical customer check.
-- It preserves the customer and optional giro owner instead of inserting a copy.

ALTER TABLE checks
  DROP CONSTRAINT checks_at_most_one_party,
  DROP CONSTRAINT giro_check_original_owner_valid,
  ADD COLUMN transferred_at DATE,
  ADD CONSTRAINT checks_transfer_pair_valid CHECK (
    (
      transferred_at IS NULL
      AND num_nonnulls(customer_id, supplier_id) <= 1
    )
    OR (
      transferred_at IS NOT NULL
      AND customer_id IS NOT NULL
      AND supplier_id IS NOT NULL
      AND direction = 'inflow'
    )
  ),
  ADD CONSTRAINT giro_check_original_owner_valid CHECK (
    (
      is_giro = FALSE
      AND original_owner_name IS NULL
      AND original_owner_phone IS NULL
    )
    OR (
      is_giro = TRUE
      AND customer_id IS NOT NULL
      AND original_owner_name IS NOT NULL
      AND BTRIM(original_owner_name) <> ''
      AND CHAR_LENGTH(original_owner_name) <= 150
      AND original_owner_phone IS NOT NULL
      AND BTRIM(original_owner_phone) <> ''
      AND CHAR_LENGTH(original_owner_phone) <= 50
    )
  );

CREATE INDEX checks_supplier_transferred_at_index
  ON checks (supplier_id, transferred_at DESC)
  WHERE transferred_at IS NOT NULL;

CREATE UNIQUE INDEX supplier_ledger_one_check_transfer
  ON supplier_ledger (source_id)
  WHERE source_type = 'check_transfer';

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

  -- Status remains independently mutable; supplier custody is a one-time link.
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN checks.transferred_at IS
  'Date the same physical customer check was handed to supplier_id.';
