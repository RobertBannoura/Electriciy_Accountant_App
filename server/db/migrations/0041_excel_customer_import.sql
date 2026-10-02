-- Workbook data is staged as JSON; only reviewed balances enter the live ledger.
CREATE TABLE excel_import_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores(id),
  source_name TEXT NOT NULL,
  source_sha256 CHAR(64) NOT NULL,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'imported', 'rolled_back')),
  staged_data JSONB NOT NULL,
  review JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by_user_id BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  UNIQUE (source_sha256)
);

CREATE TABLE excel_import_customers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES excel_import_batches(id),
  group_key TEXT NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  created_customer BOOLEAN NOT NULL,
  opening_balance_ils NUMERIC NOT NULL,
  ledger_id BIGINT REFERENCES customer_ledger(id),
  reversal_ledger_id BIGINT REFERENCES customer_ledger(id),
  UNIQUE (batch_id, group_key),
  UNIQUE (ledger_id),
  UNIQUE (reversal_ledger_id)
);

CREATE INDEX excel_import_batches_created_index ON excel_import_batches(created_at DESC);
CREATE INDEX excel_import_customers_customer_index ON excel_import_customers(customer_id);
