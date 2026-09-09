-- Explicit, append-only returns plus store-scoped ILS expenses.

CREATE SEQUENCE customer_return_document_sequence AS BIGINT;
CREATE SEQUENCE supplier_return_document_sequence AS BIGINT;

CREATE TABLE customer_returns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  sale_id BIGINT NOT NULL,
  customer_id BIGINT REFERENCES customers (id),
  document_number TEXT NOT NULL DEFAULT
    ('CR-' || LPAD(nextval('customer_return_document_sequence')::TEXT, 8, '0')),
  business_date DATE NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'ILS' CHECK (currency_code = 'ILS'),
  total NUMERIC(38, 12) NOT NULL CHECK (total >= 0),
  cost_total NUMERIC(38, 12) NOT NULL CHECK (cost_total >= 0),
  gross_profit_reversal NUMERIC(38, 12) NOT NULL,
  notes TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, store_id),
  UNIQUE (store_id, document_number),
  CONSTRAINT customer_returns_sale_store_fk
    FOREIGN KEY (sale_id, store_id) REFERENCES sales (id, store_id),
  CONSTRAINT customer_returns_profit_consistent
    CHECK (gross_profit_reversal = total - cost_total)
);

CREATE TABLE customer_return_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_return_id BIGINT NOT NULL REFERENCES customer_returns (id),
  sale_item_id BIGINT NOT NULL REFERENCES sale_items (id),
  product_id BIGINT NOT NULL REFERENCES products (id),
  description TEXT NOT NULL,
  quantity NUMERIC(15, 3) NOT NULL CHECK (quantity > 0),
  unit_refund_snapshot NUMERIC(38, 12) NOT NULL CHECK (unit_refund_snapshot >= 0),
  line_total NUMERIC(38, 12) NOT NULL CHECK (line_total >= 0),
  unit_cost_snapshot NUMERIC(38, 12) NOT NULL CHECK (unit_cost_snapshot >= 0),
  cost_total NUMERIC(38, 12) NOT NULL CHECK (cost_total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_return_id, sale_item_id)
);

CREATE INDEX customer_returns_sale_index ON customer_returns (sale_id, id);
CREATE INDEX customer_returns_store_date_index ON customer_returns (store_id, business_date, id);
CREATE INDEX customer_return_items_sale_item_index ON customer_return_items (sale_item_id);

CREATE TABLE supplier_returns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  purchase_id BIGINT NOT NULL,
  supplier_id BIGINT NOT NULL REFERENCES suppliers (id),
  document_number TEXT NOT NULL DEFAULT
    ('PR-' || LPAD(nextval('supplier_return_document_sequence')::TEXT, 8, '0')),
  business_date DATE NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'ILS' CHECK (currency_code = 'ILS'),
  total NUMERIC(38, 12) NOT NULL CHECK (total >= 0),
  inventory_cost_total NUMERIC(38, 12) NOT NULL CHECK (inventory_cost_total >= 0),
  cost_variance NUMERIC(38, 12) NOT NULL,
  notes TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, store_id),
  UNIQUE (store_id, document_number),
  CONSTRAINT supplier_returns_purchase_store_fk
    FOREIGN KEY (purchase_id, store_id) REFERENCES purchases (id, store_id),
  CONSTRAINT supplier_returns_variance_consistent
    CHECK (cost_variance = total - inventory_cost_total)
);

CREATE TABLE supplier_return_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_return_id BIGINT NOT NULL REFERENCES supplier_returns (id),
  purchase_item_id BIGINT NOT NULL REFERENCES purchase_items (id),
  product_id BIGINT NOT NULL REFERENCES products (id),
  description TEXT NOT NULL,
  quantity NUMERIC(15, 3) NOT NULL CHECK (quantity > 0),
  purchase_unit_cost_snapshot NUMERIC(38, 12) NOT NULL CHECK (purchase_unit_cost_snapshot >= 0),
  line_total NUMERIC(38, 12) NOT NULL CHECK (line_total >= 0),
  unit_inventory_cost_snapshot NUMERIC(38, 12) NOT NULL CHECK (unit_inventory_cost_snapshot >= 0),
  inventory_cost_total NUMERIC(38, 12) NOT NULL CHECK (inventory_cost_total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_return_id, purchase_item_id)
);

CREATE INDEX supplier_returns_purchase_index ON supplier_returns (purchase_id, id);
CREATE INDEX supplier_returns_store_date_index ON supplier_returns (store_id, business_date, id);
CREATE INDEX supplier_return_items_purchase_item_index ON supplier_return_items (purchase_item_id);

CREATE FUNCTION validate_customer_return_item()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_quantity NUMERIC;
  returned_quantity NUMERIC;
BEGIN
  SELECT item.quantity
  INTO source_quantity
  FROM customer_returns AS return_document
  INNER JOIN sales AS sale
    ON sale.id = return_document.sale_id
   AND sale.store_id = return_document.store_id
  INNER JOIN sale_items AS item ON item.sale_id = sale.id
  WHERE return_document.id = NEW.customer_return_id
    AND item.id = NEW.sale_item_id
    AND item.product_id = NEW.product_id
  FOR UPDATE OF item;

  IF source_quantity IS NULL THEN
    RAISE EXCEPTION 'Customer return item does not belong to its original sale'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(quantity), 0::NUMERIC)
  INTO returned_quantity
  FROM customer_return_items
  WHERE sale_item_id = NEW.sale_item_id;

  IF returned_quantity + NEW.quantity > source_quantity THEN
    RAISE EXCEPTION 'Customer return quantity exceeds original sale quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_return_items_validate
BEFORE INSERT ON customer_return_items
FOR EACH ROW EXECUTE FUNCTION validate_customer_return_item();

CREATE FUNCTION validate_supplier_return_item()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_quantity NUMERIC;
  returned_quantity NUMERIC;
BEGIN
  SELECT item.quantity
  INTO source_quantity
  FROM supplier_returns AS return_document
  INNER JOIN purchases AS purchase
    ON purchase.id = return_document.purchase_id
   AND purchase.store_id = return_document.store_id
  INNER JOIN purchase_items AS item ON item.purchase_id = purchase.id
  WHERE return_document.id = NEW.supplier_return_id
    AND item.id = NEW.purchase_item_id
    AND item.product_id = NEW.product_id
  FOR UPDATE OF item;

  IF source_quantity IS NULL THEN
    RAISE EXCEPTION 'Supplier return item does not belong to its original purchase'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(quantity), 0::NUMERIC)
  INTO returned_quantity
  FROM supplier_return_items
  WHERE purchase_item_id = NEW.purchase_item_id;

  IF returned_quantity + NEW.quantity > source_quantity THEN
    RAISE EXCEPTION 'Supplier return quantity exceeds original purchase quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_return_items_validate
BEFORE INSERT ON supplier_return_items
FOR EACH ROW EXECUTE FUNCTION validate_supplier_return_item();

CREATE FUNCTION validate_customer_return_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  item_count BIGINT;
  returned_total NUMERIC;
  returned_cost NUMERIC;
  source_customer_id BIGINT;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(line_total), 0::NUMERIC),
    COALESCE(SUM(cost_total), 0::NUMERIC)
  INTO item_count, returned_total, returned_cost
  FROM customer_return_items WHERE customer_return_id = NEW.id;
  SELECT customer_id INTO source_customer_id FROM sales WHERE id = NEW.sale_id;
  IF item_count = 0 OR returned_total <> NEW.total OR returned_cost <> NEW.cost_total
     OR source_customer_id IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION 'Customer return header does not match its original sale and items'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER customer_returns_validate_totals
AFTER INSERT ON customer_returns
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_customer_return_totals();

CREATE FUNCTION validate_supplier_return_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  item_count BIGINT;
  returned_total NUMERIC;
  returned_cost NUMERIC;
  source_supplier_id BIGINT;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(line_total), 0::NUMERIC),
    COALESCE(SUM(inventory_cost_total), 0::NUMERIC)
  INTO item_count, returned_total, returned_cost
  FROM supplier_return_items WHERE supplier_return_id = NEW.id;
  SELECT supplier_id INTO source_supplier_id FROM purchases WHERE id = NEW.purchase_id;
  IF item_count = 0 OR returned_total <> NEW.total OR returned_cost <> NEW.inventory_cost_total
     OR source_supplier_id IS DISTINCT FROM NEW.supplier_id THEN
    RAISE EXCEPTION 'Supplier return header does not match its original purchase and items'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER supplier_returns_validate_totals
AFTER INSERT ON supplier_returns
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_supplier_return_totals();

CREATE TRIGGER customer_returns_append_only
BEFORE UPDATE OR DELETE ON customer_returns
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER customer_return_items_append_only
BEFORE UPDATE OR DELETE ON customer_return_items
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER supplier_returns_append_only
BEFORE UPDATE OR DELETE ON supplier_returns
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER supplier_return_items_append_only
BEFORE UPDATE OR DELETE ON supplier_return_items
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

CREATE TABLE expense_categories (
  name TEXT PRIMARY KEY,
  sort_order SMALLINT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO expense_categories (name, sort_order) VALUES
  ('كهرباء', 1),
  ('أجار', 2),
  ('رواتب', 3),
  ('مواصلات', 4),
  ('صيانة', 5),
  ('مشتريات للمحل', 6),
  ('أخرى', 7);

UPDATE expenses SET expense_category = 'أخرى' WHERE expense_category IS NULL;
ALTER TABLE expenses
  ALTER COLUMN expense_category SET NOT NULL,
  ADD CONSTRAINT expenses_recorded_values CHECK (
    status <> 'recorded'
    OR (
      amount > 0
      AND MOD(amount, 0.50::NUMERIC) = 0
      AND currency_code = 'ILS'
      AND payment_method IN ('cash', 'bank_card')
      AND expense_category IN (
        'كهرباء', 'أجار', 'رواتب', 'مواصلات', 'صيانة', 'مشتريات للمحل', 'أخرى'
      )
    )
  ) NOT VALID;

DROP TRIGGER expenses_set_updated_at ON expenses;
CREATE TRIGGER expenses_append_only
BEFORE UPDATE OR DELETE ON expenses
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

ALTER TABLE financial_movements
  ADD CONSTRAINT expense_cash_movement_consistent CHECK (
    source_type <> 'expense'
    OR (direction = 'outflow' AND amount > 0 AND currency_code = 'ILS')
  ) NOT VALID;
ALTER TABLE bank_movements
  ADD CONSTRAINT expense_bank_movement_consistent CHECK (
    source_type <> 'expense'
    OR (direction = 'outflow' AND amount_ils > 0)
  ) NOT VALID;

CREATE VIEW store_cash_balances AS
SELECT stores.id AS store_id, currencies.currency_code,
  COALESCE(SUM(
    CASE financial.direction WHEN 'inflow' THEN financial.amount ELSE -financial.amount END
  ), 0::NUMERIC) AS balance
FROM stores
CROSS JOIN (VALUES ('ILS'), ('USD'), ('JOD')) AS currencies(currency_code)
LEFT JOIN financial_movements AS financial
  ON financial.store_id = stores.id
 AND financial.currency_code = currencies.currency_code
GROUP BY stores.id, currencies.currency_code;

CREATE VIEW store_bank_balances AS
SELECT stores.id AS store_id,
  COALESCE(SUM(
    CASE bank.direction WHEN 'inflow' THEN bank.amount_ils ELSE -bank.amount_ils END
  ), 0::NUMERIC) AS balance_ils
FROM stores
LEFT JOIN bank_movements AS bank ON bank.store_id = stores.id
GROUP BY stores.id;

COMMENT ON TABLE customer_returns IS
  'Append-only customer credit documents linked to immutable original sales.';
COMMENT ON TABLE supplier_returns IS
  'Append-only supplier credit documents linked to immutable original purchases.';
COMMENT ON TABLE expenses IS
  'Append-only store expenses; cash and bank effects are separate ledger movements.';
