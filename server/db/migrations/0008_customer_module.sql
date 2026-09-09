-- Read paths used by the store-scoped customer list and simple customer file.
-- Balances remain derived exclusively from the append-only customer_ledger.

CREATE INDEX customers_store_phone_active_index
  ON customers (store_id, phone)
  WHERE is_active = TRUE AND phone IS NOT NULL;

CREATE INDEX customer_projects_store_customer_created_index
  ON customer_projects (store_id, customer_id, created_at DESC)
  WHERE is_active = TRUE;

CREATE INDEX sales_store_customer_business_date_index
  ON sales (store_id, customer_id, business_date DESC)
  WHERE customer_id IS NOT NULL;

CREATE INDEX payments_store_customer_paid_at_index
  ON payments (store_id, customer_id, paid_at DESC)
  WHERE customer_id IS NOT NULL;

CREATE INDEX checks_store_customer_due_date_index
  ON checks (store_id, customer_id, due_date DESC)
  WHERE customer_id IS NOT NULL;
