-- Received customer checks have three financial lifecycle states only. Whether a
-- pending check is before or after its due date is derived when it is displayed.

UPDATE checks
SET status = CASE status
  WHEN 'collected' THEN 'cleared'
  WHEN 'returned' THEN 'bounced'
  WHEN 'late' THEN 'pending'
  WHEN 'due' THEN 'pending'
  ELSE status
END
WHERE customer_id IS NOT NULL
  AND direction = 'inflow'
  AND status IN ('collected', 'returned', 'late', 'due');

ALTER TABLE checks
  ADD CONSTRAINT received_customer_check_status_valid CHECK (
    customer_id IS NULL
    OR direction <> 'inflow'
    OR status IN ('pending', 'cleared', 'bounced')
  ),
  ADD CONSTRAINT received_customer_check_number_valid CHECK (
    customer_id IS NULL
    OR direction <> 'inflow'
    OR (BTRIM(check_number) <> '' AND CHAR_LENGTH(check_number) <= 100)
  ),
  ADD CONSTRAINT received_customer_check_notes_length CHECK (
    customer_id IS NULL
    OR direction <> 'inflow'
    OR notes IS NULL
    OR CHAR_LENGTH(notes) <= 2000
  );

COMMENT ON CONSTRAINT received_customer_check_status_valid ON checks IS
  'Received customer checks are pending, cleared, or bounced. Due/late is calculated from due_date.';
