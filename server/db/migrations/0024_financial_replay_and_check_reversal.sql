-- Durable replay protection for accounting writes. The claim is inserted in
-- the same transaction as the financial effect, so a rollback also releases
-- the request id for a safe retry.
CREATE TABLE financial_operation_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users (id),
  scope TEXT NOT NULL CHECK (BTRIM(scope) <> '' AND CHAR_LENGTH(scope) <= 100),
  request_id TEXT NOT NULL CHECK (
    request_id ~ '^[A-Za-z0-9._:-]{1,100}$'
  ),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX financial_operation_requests_unique
  ON financial_operation_requests (
    COALESCE(actor_user_id, 0::BIGINT), scope, request_id
  );

CREATE INDEX financial_operation_requests_created_index
  ON financial_operation_requests (created_at DESC);

-- A pending maintenance check that is returned during an explicit maintenance
-- reversal becomes a terminal historical check. This prevents it from later
-- being cleared, bounced, or transferred after its accounting effect was
-- already reversed.
ALTER TABLE checks
  DROP CONSTRAINT received_customer_check_status_valid,
  ADD CONSTRAINT received_customer_check_status_valid CHECK (
    customer_id IS NULL
    OR direction <> 'inflow'
    OR status IN ('pending', 'cleared', 'bounced')
    OR (status = 'reversed' AND maintenance_id IS NOT NULL)
  );

COMMENT ON CONSTRAINT received_customer_check_status_valid ON checks IS
  'Received customer checks are pending, cleared, bounced, or terminally reversed with their maintenance record.';

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
     AND NOT (
       OLD.status = 'pending'
       AND (
         NEW.status IN ('cleared', 'bounced')
         OR (
           NEW.status = 'reversed'
           AND OLD.maintenance_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM maintenance_reversals
             WHERE maintenance_id = OLD.maintenance_id
               AND store_id = OLD.store_id
           )
         )
       )
     )
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
