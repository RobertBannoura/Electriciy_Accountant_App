-- Check lifecycle actions keep the original payment/check immutable. Financial
-- effects are reversed with linked, append-only ledger entries exactly once.

ALTER TABLE checks
  ADD COLUMN is_owner_issued BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN cleared_at TIMESTAMPTZ,
  ADD COLUMN bounced_at TIMESTAMPTZ,
  ADD COLUMN reminder_snoozed_until DATE,
  ADD COLUMN bounced_reminder_stopped_at TIMESTAMPTZ;

UPDATE checks
SET cleared_at = COALESCE(updated_at, created_at)
WHERE status = 'cleared';

UPDATE checks
SET bounced_at = COALESCE(updated_at, created_at)
WHERE status = 'bounced';

ALTER TABLE checks
  ADD CONSTRAINT owner_issued_check_valid CHECK (
    is_owner_issued = FALSE
    OR (
      customer_id IS NULL
      AND supplier_id IS NOT NULL
      AND transferred_at IS NULL
      AND direction = 'outflow'
      AND status IN ('pending', 'cleared', 'bounced')
      AND amount > 0
      AND currency_code = 'ILS'
      AND is_giro = FALSE
    )
  ),
  ADD CONSTRAINT check_lifecycle_timestamps_valid CHECK (
    (status = 'cleared' AND cleared_at IS NOT NULL AND bounced_at IS NULL)
    OR (status = 'bounced' AND bounced_at IS NOT NULL AND cleared_at IS NULL)
    OR (status NOT IN ('cleared', 'bounced') AND cleared_at IS NULL AND bounced_at IS NULL)
  ),
  ADD CONSTRAINT bounced_check_reminder_stop_valid CHECK (
    bounced_reminder_stopped_at IS NULL OR status = 'bounced'
  ),
  ADD CONSTRAINT pending_check_snooze_valid CHECK (
    reminder_snoozed_until IS NULL OR status = 'pending'
  );

CREATE INDEX checks_pending_reminder_index
  ON checks (store_id, due_date)
  WHERE status = 'pending';

CREATE INDEX checks_unresolved_bounced_reminder_index
  ON checks (store_id, bounced_at)
  WHERE status = 'bounced' AND bounced_reminder_stopped_at IS NULL;

CREATE UNIQUE INDEX customer_ledger_one_check_bounce
  ON customer_ledger (source_id)
  WHERE source_type = 'check_bounce';

CREATE UNIQUE INDEX supplier_ledger_one_transferred_check_bounce
  ON supplier_ledger (source_id)
  WHERE source_type = 'check_transfer_bounce';

CREATE UNIQUE INDEX supplier_ledger_one_owner_check_issue
  ON supplier_ledger (source_id)
  WHERE source_type = 'owner_check';

CREATE UNIQUE INDEX supplier_ledger_one_owner_check_bounce
  ON supplier_ledger (source_id)
  WHERE source_type = 'owner_check_bounce';

INSERT INTO system_settings (store_id, key, value)
SELECT stores.id, 'check_follow_up_business_days', '3'::JSONB
FROM stores
ON CONFLICT (store_id, key) DO NOTHING;

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
     OR NEW.is_owner_issued IS DISTINCT FROM OLD.is_owner_issued
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

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       OLD.status = 'pending'
       AND NEW.status IN ('cleared', 'bounced')
     )
  THEN
    RAISE EXCEPTION 'Invalid check lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.cleared_at IS DISTINCT FROM OLD.cleared_at
     AND NOT (OLD.cleared_at IS NULL AND NEW.status = 'cleared' AND NEW.cleared_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Cleared timestamp is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.bounced_at IS DISTINCT FROM OLD.bounced_at
     AND NOT (OLD.bounced_at IS NULL AND NEW.status = 'bounced' AND NEW.bounced_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Bounced timestamp is immutable'
      USING ERRCODE = '55000';
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

COMMENT ON COLUMN checks.is_owner_issued IS
  'True for a business/owner check issued directly to a supplier.';
COMMENT ON COLUMN checks.reminder_snoozed_until IS
  'Operational reminder snooze only; it never changes the financial status.';
COMMENT ON COLUMN checks.bounced_reminder_stopped_at IS
  'Stops future reminders while preserving the historical bounced state.';
