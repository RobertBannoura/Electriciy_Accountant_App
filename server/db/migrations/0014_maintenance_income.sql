-- Maintenance is service income, separate from product sales and inventory.
-- Originals and reversals are append-only; every financial effect stays traceable.

CREATE TABLE maintenance_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  customer_id BIGINT REFERENCES customers (id),
  item_description TEXT NOT NULL,
  maintenance_details TEXT,
  amount_ils NUMERIC(38, 12) NOT NULL,
  business_date DATE NOT NULL,
  paid_total_ils NUMERIC(38, 12) NOT NULL,
  remaining_due_ils NUMERIC(38, 12) NOT NULL,
  notes TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT maintenance_records_id_store_unique UNIQUE (id, store_id),
  CONSTRAINT maintenance_item_description_valid CHECK (
    BTRIM(item_description) <> '' AND CHAR_LENGTH(item_description) <= 200
  ),
  CONSTRAINT maintenance_details_length CHECK (
    maintenance_details IS NULL OR CHAR_LENGTH(maintenance_details) <= 2000
  ),
  CONSTRAINT maintenance_notes_length CHECK (
    notes IS NULL OR CHAR_LENGTH(notes) <= 2000
  ),
  CONSTRAINT maintenance_amount_positive_half_ils CHECK (
    amount_ils > 0 AND MOD(amount_ils, 0.50::NUMERIC) = 0
  ),
  CONSTRAINT maintenance_totals_consistent CHECK (
    paid_total_ils >= 0
    AND remaining_due_ils >= 0
    AND amount_ils = paid_total_ils + remaining_due_ils
  ),
  CONSTRAINT anonymous_maintenance_fully_paid CHECK (
    customer_id IS NOT NULL OR remaining_due_ils = 0
  )
);

CREATE INDEX maintenance_store_date_index
  ON maintenance_records (store_id, business_date DESC, id DESC);
CREATE INDEX maintenance_customer_date_index
  ON maintenance_records (customer_id, business_date DESC, id DESC)
  WHERE customer_id IS NOT NULL;

CREATE TABLE maintenance_reversals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  maintenance_id BIGINT NOT NULL UNIQUE,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  reason TEXT NOT NULL,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT maintenance_reversals_id_store_unique UNIQUE (id, store_id),
  CONSTRAINT maintenance_reversal_source_store_fk
    FOREIGN KEY (maintenance_id, store_id)
    REFERENCES maintenance_records (id, store_id),
  CONSTRAINT maintenance_reversal_reason_valid CHECK (
    BTRIM(reason) <> '' AND CHAR_LENGTH(reason) <= 1000
  )
);

CREATE INDEX maintenance_reversals_store_created_index
  ON maintenance_reversals (store_id, created_at DESC);

CREATE TRIGGER maintenance_records_immutable
BEFORE UPDATE OR DELETE ON maintenance_records
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

CREATE TRIGGER maintenance_reversals_immutable
BEFORE UPDATE OR DELETE ON maintenance_reversals
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

ALTER TABLE payments
  ADD COLUMN maintenance_id BIGINT,
  ADD COLUMN maintenance_reversal_id BIGINT,
  ADD CONSTRAINT payments_maintenance_store_fk
    FOREIGN KEY (maintenance_id, store_id)
    REFERENCES maintenance_records (id, store_id),
  ADD CONSTRAINT payments_maintenance_reversal_store_fk
    FOREIGN KEY (maintenance_reversal_id, store_id)
    REFERENCES maintenance_reversals (id, store_id),
  ADD CONSTRAINT payments_single_document CHECK (
    num_nonnulls(sale_id, purchase_id, maintenance_id, maintenance_reversal_id) <= 1
  ),
  ADD CONSTRAINT maintenance_payment_values_consistent CHECK (
    (
      maintenance_id IS NULL
      OR (
        direction = 'inflow'
        AND payment_method IN ('cash', 'bank_card')
        AND original_amount > 0
      )
    )
    AND (
      maintenance_reversal_id IS NULL
      OR (
        direction = 'outflow'
        AND payment_method IN ('cash', 'bank_card')
        AND original_amount > 0
      )
    )
  );

ALTER TABLE payments
  DROP CONSTRAINT payments_party_or_sale,
  ADD CONSTRAINT payments_party_or_document CHECK (
    num_nonnulls(customer_id, supplier_id) = 1
    OR (
      num_nonnulls(sale_id, maintenance_id, maintenance_reversal_id) = 1
      AND num_nonnulls(customer_id, supplier_id) = 0
    )
  ),
  DROP CONSTRAINT customer_receipt_values_consistent,
  ADD CONSTRAINT customer_receipt_values_consistent CHECK (
    NOT (
      customer_id IS NOT NULL
      AND supplier_id IS NULL
      AND num_nonnulls(sale_id, purchase_id, maintenance_id, maintenance_reversal_id) = 0
    )
    OR (
      direction = 'inflow'
      AND payment_method IN ('cash', 'bank_card')
      AND original_amount > 0
    )
  ) NOT VALID;

CREATE INDEX payments_maintenance_id_index ON payments (maintenance_id)
  WHERE maintenance_id IS NOT NULL;
CREATE INDEX payments_maintenance_reversal_id_index ON payments (maintenance_reversal_id)
  WHERE maintenance_reversal_id IS NOT NULL;

ALTER TABLE checks
  ADD COLUMN maintenance_id BIGINT,
  ADD COLUMN maintenance_reversal_id BIGINT,
  ADD CONSTRAINT checks_maintenance_store_fk
    FOREIGN KEY (maintenance_id, store_id)
    REFERENCES maintenance_records (id, store_id),
  ADD CONSTRAINT checks_maintenance_reversal_store_fk
    FOREIGN KEY (maintenance_reversal_id, store_id)
    REFERENCES maintenance_reversals (id, store_id),
  ADD CONSTRAINT checks_single_document CHECK (
    num_nonnulls(sale_id, maintenance_id, maintenance_reversal_id) <= 1
  ),
  ADD CONSTRAINT maintenance_check_values_consistent CHECK (
    maintenance_id IS NULL
    OR (direction = 'inflow' AND amount > 0 AND currency_code = 'ILS')
  ),
  ADD CONSTRAINT maintenance_reversal_check_values_consistent CHECK (
    maintenance_reversal_id IS NULL
    OR (direction = 'outflow' AND amount > 0 AND currency_code = 'ILS')
  );

CREATE INDEX checks_maintenance_id_index ON checks (maintenance_id)
  WHERE maintenance_id IS NOT NULL;
CREATE INDEX checks_maintenance_reversal_id_index ON checks (maintenance_reversal_id)
  WHERE maintenance_reversal_id IS NOT NULL;

DROP TRIGGER checks_payment_snapshot_protected ON checks;
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
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
  THEN
    RAISE EXCEPTION 'Check payment facts cannot be changed'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER checks_payment_snapshot_protected
BEFORE UPDATE OR DELETE ON checks
FOR EACH ROW EXECUTE FUNCTION protect_check_payment_snapshot();

ALTER TABLE financial_movements
  ADD CONSTRAINT maintenance_cash_movement_values_consistent CHECK (
    source_type NOT IN ('maintenance_payment', 'maintenance_reversal_payment')
    OR (
      amount > 0
      AND currency_code IN ('ILS', 'USD', 'JOD')
      AND direction = CASE
        WHEN source_type = 'maintenance_payment' THEN 'inflow'
        ELSE 'outflow'
      END
    )
  );

COMMENT ON TABLE maintenance_records IS
  'Immutable service-income records. They never create inventory or COGS movements.';
COMMENT ON TABLE maintenance_reversals IS
  'Explicit immutable reversals; the original maintenance record is preserved.';
COMMENT ON COLUMN maintenance_records.item_description IS
  'Permanent free-text snapshot of the repaired device or item.';
COMMENT ON COLUMN maintenance_records.remaining_due_ils IS
  'Unpaid customer debt; never represented as a payment method.';
