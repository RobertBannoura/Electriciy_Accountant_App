-- A later workbook is a new snapshot of the same ledger, not a second opening.
ALTER TABLE excel_import_batches
  ADD COLUMN parent_batch_id BIGINT REFERENCES excel_import_batches(id);

ALTER TABLE excel_import_customers
  ADD COLUMN posted_delta_ils NUMERIC,
  ADD COLUMN history_fingerprints JSONB,
  ADD COLUMN new_history_count INTEGER NOT NULL DEFAULT 0;

-- Rows written by the first importer posted their whole snapshot once.
UPDATE excel_import_customers
SET posted_delta_ils = opening_balance_ils
WHERE posted_delta_ils IS NULL;

ALTER TABLE excel_import_customers
  ALTER COLUMN posted_delta_ils SET NOT NULL;

CREATE INDEX excel_import_batches_parent_index
  ON excel_import_batches(parent_batch_id);

CREATE UNIQUE INDEX excel_import_customers_one_customer_per_batch
  ON excel_import_customers(batch_id, customer_id);
