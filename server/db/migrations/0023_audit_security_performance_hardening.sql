-- Search indexes cover the substring searches used by the Arabic UI.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX products_name_trgm_index
  ON products USING GIN (LOWER(name) gin_trgm_ops)
  WHERE is_active = TRUE;
CREATE INDEX customers_name_trgm_index
  ON customers USING GIN (LOWER(name) gin_trgm_ops)
  WHERE is_active = TRUE;
CREATE INDEX customers_phone_trgm_index
  ON customers USING GIN (LOWER(phone) gin_trgm_ops)
  WHERE is_active = TRUE AND phone IS NOT NULL;
CREATE INDEX suppliers_name_trgm_index
  ON suppliers USING GIN (LOWER(name) gin_trgm_ops)
  WHERE is_active = TRUE;
CREATE INDEX checks_number_trgm_index
  ON checks USING GIN (LOWER(check_number) gin_trgm_ops);

-- Barcode values are already unique. This covering index speeds active-product lookup.
CREATE INDEX barcodes_active_value_product_index
  ON barcodes (value, product_id)
  WHERE is_active = TRUE;

-- Store/date/id ordering matches paginated operational histories.
CREATE INDEX sales_store_date_page_index
  ON sales (store_id, business_date DESC, id DESC);
CREATE INDEX purchases_store_date_page_index
  ON purchases (store_id, business_date DESC, id DESC);
CREATE INDEX payments_store_date_page_index
  ON payments (store_id, paid_at DESC, id DESC);
CREATE INDEX checks_store_due_page_index
  ON checks (store_id, due_date DESC, id DESC);
CREATE INDEX expenses_store_date_page_index
  ON expenses (store_id, expense_date DESC, id DESC)
  WHERE status = 'recorded';
CREATE INDEX maintenance_store_date_page_index
  ON maintenance_records (store_id, business_date DESC, id DESC);
CREATE INDEX customer_returns_store_date_page_index
  ON customer_returns (store_id, business_date DESC, id DESC);
CREATE INDEX supplier_returns_store_date_page_index
  ON supplier_returns (store_id, business_date DESC, id DESC);
CREATE INDEX inventory_movements_store_date_page_index
  ON inventory_movements (store_id, occurred_at DESC, id DESC);
CREATE INDEX financial_movements_store_date_page_index
  ON financial_movements (store_id, occurred_at DESC, id DESC);
CREATE INDEX bank_movements_store_date_page_index
  ON bank_movements (store_id, occurred_at DESC, id DESC);
CREATE INDEX customer_ledger_store_date_page_index
  ON customer_ledger (store_id, occurred_at DESC, id DESC);
CREATE INDEX supplier_ledger_store_date_page_index
  ON supplier_ledger (store_id, occurred_at DESC, id DESC);
CREATE INDEX audit_log_created_page_index
  ON audit_log (created_at DESC, id DESC);
CREATE INDEX audit_log_action_created_index
  ON audit_log (action, created_at DESC, id DESC);
