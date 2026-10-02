-- A source document produces at most one stock movement per product and store.
-- Manual movements use their durable financial request claim as source_id.
-- Historical manual movements have no source_id and remain untouched.
CREATE UNIQUE INDEX inventory_movements_one_per_source_store_product
  ON inventory_movements (store_id, product_id, source_type, source_id)
  WHERE source_id IS NOT NULL
    AND source_type IN (
      'purchase', 'sale', 'customer_return', 'supplier_return', 'manual_inventory'
    );

-- Each source payment, invoice, return, or check creates one effect in each
-- applicable ledger. Source document ids are global, including across stores.
CREATE UNIQUE INDEX customer_ledger_one_per_source
  ON customer_ledger (source_type, source_id)
  WHERE source_id IS NOT NULL;

CREATE UNIQUE INDEX supplier_ledger_one_per_source
  ON supplier_ledger (source_type, source_id)
  WHERE source_id IS NOT NULL;

CREATE UNIQUE INDEX financial_movements_one_per_source
  ON financial_movements (source_type, source_id)
  WHERE source_id IS NOT NULL;

CREATE UNIQUE INDEX bank_movements_one_per_source
  ON bank_movements (source_type, source_id)
  WHERE source_id IS NOT NULL;
