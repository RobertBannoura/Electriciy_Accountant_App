-- Read paths for the store-scoped supplier list and supplier detail page.
-- Amounts owed remain derived exclusively from the append-only supplier_ledger.

CREATE INDEX suppliers_store_phone_active_index
  ON suppliers (store_id, phone)
  WHERE is_active = TRUE AND phone IS NOT NULL;

CREATE INDEX purchases_store_supplier_business_date_index
  ON purchases (store_id, supplier_id, business_date DESC)
  WHERE supplier_id IS NOT NULL;

CREATE INDEX payments_store_supplier_paid_at_index
  ON payments (store_id, supplier_id, paid_at DESC)
  WHERE supplier_id IS NOT NULL;

CREATE INDEX checks_store_supplier_due_date_index
  ON checks (store_id, supplier_id, due_date DESC)
  WHERE supplier_id IS NOT NULL;
