-- Customers, customer projects, and suppliers are business-wide identities.
-- Store identity remains on every transaction and ledger movement.
-- Customer/supplier ledger amounts are ILS accounting values only.

-- A foreign-currency payment already has an immutable ILS snapshot. It is the
-- only safe automatic source for converting an old foreign-labelled ledger row.
-- Abort before changing anything when historical conversion cannot be proven.
DO $$
DECLARE
  unmappable_ids TEXT;
BEGIN
  SELECT STRING_AGG(ledger.id::TEXT, ', ' ORDER BY ledger.id)
  INTO unmappable_ids
  FROM customer_ledger AS ledger
  WHERE COALESCE(ledger.currency_code, 'ILS') <> 'ILS'
    AND NOT EXISTS (
      SELECT 1
      FROM payments
      WHERE payments.id = ledger.source_id
        AND ledger.source_type = 'payment'
        AND payments.store_id = ledger.store_id
        AND payments.customer_id = ledger.customer_id
        AND payments.currency_code = ledger.currency_code
    );

  IF unmappable_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot migrate customer_ledger rows (%) to ILS: link each foreign-currency row to its payment snapshot before applying 0010.',
      unmappable_ids;
  END IF;

  SELECT STRING_AGG(ledger.id::TEXT, ', ' ORDER BY ledger.id)
  INTO unmappable_ids
  FROM supplier_ledger AS ledger
  WHERE COALESCE(ledger.currency_code, 'ILS') <> 'ILS'
    AND NOT EXISTS (
      SELECT 1
      FROM payments
      WHERE payments.id = ledger.source_id
        AND ledger.source_type = 'payment'
        AND payments.store_id = ledger.store_id
        AND payments.supplier_id = ledger.supplier_id
        AND payments.currency_code = ledger.currency_code
    );

  IF unmappable_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot migrate supplier_ledger rows (%) to ILS: link each foreign-currency row to its payment snapshot before applying 0010.',
      unmappable_ids;
  END IF;
END;
$$;

DROP VIEW customer_balances;
DROP VIEW supplier_balances;

DROP TRIGGER customer_ledger_append_only ON customer_ledger;
DROP TRIGGER supplier_ledger_append_only ON supplier_ledger;

UPDATE customer_ledger AS ledger
SET amount = payments.converted_ils_amount
FROM payments
WHERE payments.id = ledger.source_id
  AND ledger.source_type = 'payment'
  AND payments.store_id = ledger.store_id
  AND payments.customer_id = ledger.customer_id
  AND payments.currency_code = ledger.currency_code
  AND COALESCE(ledger.currency_code, 'ILS') <> 'ILS';

UPDATE supplier_ledger AS ledger
SET amount = payments.converted_ils_amount
FROM payments
WHERE payments.id = ledger.source_id
  AND ledger.source_type = 'payment'
  AND payments.store_id = ledger.store_id
  AND payments.supplier_id = ledger.supplier_id
  AND payments.currency_code = ledger.currency_code
  AND COALESCE(ledger.currency_code, 'ILS') <> 'ILS';

ALTER TABLE customer_ledger
  RENAME COLUMN amount TO amount_ils;
ALTER TABLE customer_ledger
  RENAME CONSTRAINT customer_ledger_amount_check
  TO customer_ledger_amount_ils_nonnegative;
ALTER TABLE customer_ledger
  DROP COLUMN currency_code;

ALTER TABLE supplier_ledger
  RENAME COLUMN amount TO amount_ils;
ALTER TABLE supplier_ledger
  RENAME CONSTRAINT supplier_ledger_amount_check
  TO supplier_ledger_amount_ils_nonnegative;
ALTER TABLE supplier_ledger
  DROP COLUMN currency_code;

CREATE TRIGGER customer_ledger_append_only
BEFORE UPDATE OR DELETE ON customer_ledger
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

CREATE TRIGGER supplier_ledger_append_only
BEFORE UPDATE OR DELETE ON supplier_ledger
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- Remove store-coupled foreign keys before removing store ownership from party
-- and project identities. Existing rows keep their IDs and are never merged.
ALTER TABLE sales
  DROP CONSTRAINT sales_customer_store_fk,
  DROP CONSTRAINT sales_project_customer_store_fk;
ALTER TABLE purchases
  DROP CONSTRAINT purchases_supplier_store_fk;
ALTER TABLE payments
  DROP CONSTRAINT payments_customer_store_fk,
  DROP CONSTRAINT payments_supplier_store_fk;
ALTER TABLE checks
  DROP CONSTRAINT checks_customer_store_fk,
  DROP CONSTRAINT checks_supplier_store_fk;
ALTER TABLE customer_ledger
  DROP CONSTRAINT customer_ledger_customer_store_fk;
ALTER TABLE supplier_ledger
  DROP CONSTRAINT supplier_ledger_supplier_store_fk;
ALTER TABLE customer_projects
  DROP CONSTRAINT customer_projects_customer_store_fk;

DROP INDEX customers_store_code_unique;
DROP INDEX customers_store_name_index;
DROP INDEX customers_store_phone_active_index;
DROP INDEX customer_projects_store_customer_created_index;
DROP INDEX suppliers_store_code_unique;
DROP INDEX suppliers_store_name_index;
DROP INDEX suppliers_store_phone_active_index;

ALTER TABLE customer_projects
  DROP CONSTRAINT customer_projects_id_store_id_key,
  DROP CONSTRAINT customer_projects_id_customer_id_store_id_key;
ALTER TABLE customers
  DROP CONSTRAINT customers_id_store_id_key;
ALTER TABLE suppliers
  DROP CONSTRAINT suppliers_id_store_id_key;

ALTER TABLE customer_projects DROP COLUMN store_id;
ALTER TABLE customers DROP COLUMN store_id;
ALTER TABLE suppliers DROP COLUMN store_id;

ALTER TABLE customer_projects
  ADD CONSTRAINT customer_projects_id_customer_id_key UNIQUE (id, customer_id),
  ADD CONSTRAINT customer_projects_customer_fk
    FOREIGN KEY (customer_id) REFERENCES customers (id);
ALTER TABLE sales
  ADD CONSTRAINT sales_customer_fk
    FOREIGN KEY (customer_id) REFERENCES customers (id),
  ADD CONSTRAINT sales_project_customer_fk
    FOREIGN KEY (customer_project_id, customer_id)
    REFERENCES customer_projects (id, customer_id);
ALTER TABLE purchases
  ADD CONSTRAINT purchases_supplier_fk
    FOREIGN KEY (supplier_id) REFERENCES suppliers (id);
ALTER TABLE payments
  ADD CONSTRAINT payments_customer_fk
    FOREIGN KEY (customer_id) REFERENCES customers (id),
  ADD CONSTRAINT payments_supplier_fk
    FOREIGN KEY (supplier_id) REFERENCES suppliers (id);
ALTER TABLE checks
  ADD CONSTRAINT checks_customer_fk
    FOREIGN KEY (customer_id) REFERENCES customers (id),
  ADD CONSTRAINT checks_supplier_fk
    FOREIGN KEY (supplier_id) REFERENCES suppliers (id);
ALTER TABLE customer_ledger
  ADD CONSTRAINT customer_ledger_customer_fk
    FOREIGN KEY (customer_id) REFERENCES customers (id);
ALTER TABLE supplier_ledger
  ADD CONSTRAINT supplier_ledger_supplier_fk
    FOREIGN KEY (supplier_id) REFERENCES suppliers (id);

CREATE INDEX customers_name_index ON customers (name);
CREATE INDEX customers_phone_active_index
  ON customers (phone)
  WHERE is_active = TRUE AND phone IS NOT NULL;
CREATE INDEX customers_code_index
  ON customers (code)
  WHERE code IS NOT NULL;

CREATE INDEX customer_projects_customer_created_index
  ON customer_projects (customer_id, created_at DESC)
  WHERE is_active = TRUE;

CREATE INDEX suppliers_name_index ON suppliers (name);
CREATE INDEX suppliers_phone_active_index
  ON suppliers (phone)
  WHERE is_active = TRUE AND phone IS NOT NULL;
CREATE INDEX suppliers_code_index
  ON suppliers (code)
  WHERE code IS NOT NULL;

CREATE INDEX sales_customer_business_date_index
  ON sales (customer_id, business_date DESC)
  WHERE customer_id IS NOT NULL;
CREATE INDEX payments_customer_paid_at_global_index
  ON payments (customer_id, paid_at DESC)
  WHERE customer_id IS NOT NULL;
CREATE INDEX checks_customer_due_date_global_index
  ON checks (customer_id, due_date DESC)
  WHERE customer_id IS NOT NULL;
CREATE INDEX purchases_supplier_business_date_global_index
  ON purchases (supplier_id, business_date DESC)
  WHERE supplier_id IS NOT NULL;
CREATE INDEX payments_supplier_paid_at_global_index
  ON payments (supplier_id, paid_at DESC)
  WHERE supplier_id IS NOT NULL;
CREATE INDEX checks_supplier_due_date_global_index
  ON checks (supplier_id, due_date DESC)
  WHERE supplier_id IS NOT NULL;

CREATE VIEW customer_balances AS
SELECT
  customers.id AS customer_id,
  COALESCE(
    SUM(
      CASE ledger.direction
        WHEN 'debit' THEN ledger.amount_ils
        WHEN 'credit' THEN -ledger.amount_ils
      END
    ),
    0::NUMERIC
  ) AS balance_ils
FROM customers
LEFT JOIN customer_ledger AS ledger ON ledger.customer_id = customers.id
GROUP BY customers.id;

CREATE VIEW customer_store_balances AS
SELECT
  ledger.customer_id,
  ledger.store_id,
  SUM(
    CASE ledger.direction
      WHEN 'debit' THEN ledger.amount_ils
      WHEN 'credit' THEN -ledger.amount_ils
    END
  ) AS balance_ils
FROM customer_ledger AS ledger
GROUP BY ledger.customer_id, ledger.store_id;

CREATE VIEW supplier_balances AS
SELECT
  suppliers.id AS supplier_id,
  COALESCE(
    SUM(
      CASE ledger.direction
        WHEN 'credit' THEN ledger.amount_ils
        WHEN 'debit' THEN -ledger.amount_ils
      END
    ),
    0::NUMERIC
  ) AS balance_ils
FROM suppliers
LEFT JOIN supplier_ledger AS ledger ON ledger.supplier_id = suppliers.id
GROUP BY suppliers.id;

CREATE VIEW supplier_store_balances AS
SELECT
  ledger.supplier_id,
  ledger.store_id,
  SUM(
    CASE ledger.direction
      WHEN 'credit' THEN ledger.amount_ils
      WHEN 'debit' THEN -ledger.amount_ils
    END
  ) AS balance_ils
FROM supplier_ledger AS ledger
GROUP BY ledger.supplier_id, ledger.store_id;

COMMENT ON TABLE customers IS
  'Business-wide customer directory shared by all stores; balances are derived from customer_ledger.';
COMMENT ON TABLE customer_projects IS
  'Business-wide projects belonging to a customer; transactions retain their own store_id.';
COMMENT ON TABLE suppliers IS
  'Business-wide supplier directory shared by all stores; balances are derived from supplier_ledger.';
COMMENT ON COLUMN customer_ledger.amount_ils IS
  'ILS accounting effect. Foreign payment amount/currency/rate snapshots remain on payments.';
COMMENT ON COLUMN supplier_ledger.amount_ils IS
  'ILS accounting effect. Foreign payment amount/currency/rate snapshots remain on payments.';
