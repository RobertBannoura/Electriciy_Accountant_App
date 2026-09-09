-- Foundational schema only. Business workflows and status vocabularies remain
-- intentionally unconstrained until their dedicated specifications are agreed.

CREATE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_append_only_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; insert a correcting movement instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX users_username_lower_unique ON users (LOWER(username));

CREATE TABLE stores (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE categories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id BIGINT REFERENCES categories (id),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT categories_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX categories_parent_id_index ON categories (parent_id);

CREATE TABLE products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id BIGINT REFERENCES categories (id),
  sku TEXT,
  name TEXT NOT NULL,
  unit_name TEXT,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX products_sku_unique
  ON products (sku)
  WHERE sku IS NOT NULL;
CREATE INDEX products_category_id_index ON products (category_id);
CREATE INDEX products_name_index ON products (name);

CREATE TABLE barcodes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  value TEXT NOT NULL UNIQUE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX barcodes_one_primary_per_product
  ON barcodes (product_id)
  WHERE is_primary;
CREATE INDEX barcodes_product_id_index ON barcodes (product_id);

CREATE TABLE store_inventory (
  store_id BIGINT NOT NULL REFERENCES stores (id),
  product_id BIGINT NOT NULL REFERENCES products (id),
  reorder_level NUMERIC,
  location_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, product_id),
  CONSTRAINT store_inventory_reorder_level_nonnegative
    CHECK (reorder_level IS NULL OR reorder_level >= 0)
);

COMMENT ON TABLE store_inventory IS
  'Store/product configuration only. On-hand quantity is derived from inventory_movements.';

CREATE TABLE customers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  code TEXT,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, store_id)
);

CREATE UNIQUE INDEX customers_store_code_unique
  ON customers (store_id, code)
  WHERE code IS NOT NULL;
CREATE INDEX customers_store_name_index ON customers (store_id, name);

CREATE TABLE customer_projects (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  customer_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, store_id),
  UNIQUE (id, customer_id, store_id),
  CONSTRAINT customer_projects_customer_store_fk
    FOREIGN KEY (customer_id, store_id)
    REFERENCES customers (id, store_id)
);

CREATE INDEX customer_projects_customer_id_index
  ON customer_projects (customer_id);

CREATE TABLE suppliers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  code TEXT,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, store_id)
);

CREATE UNIQUE INDEX suppliers_store_code_unique
  ON suppliers (store_id, code)
  WHERE code IS NOT NULL;
CREATE INDEX suppliers_store_name_index ON suppliers (store_id, name);

CREATE TABLE sales (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  customer_id BIGINT,
  customer_project_id BIGINT,
  document_number TEXT,
  business_date DATE NOT NULL,
  status TEXT NOT NULL,
  currency_code TEXT,
  notes TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, store_id),
  CONSTRAINT sales_customer_store_fk
    FOREIGN KEY (customer_id, store_id)
    REFERENCES customers (id, store_id),
  CONSTRAINT sales_project_requires_customer
    CHECK (customer_project_id IS NULL OR customer_id IS NOT NULL),
  CONSTRAINT sales_project_customer_store_fk
    FOREIGN KEY (customer_project_id, customer_id, store_id)
    REFERENCES customer_projects (id, customer_id, store_id)
);

CREATE INDEX sales_store_business_date_index ON sales (store_id, business_date);
CREATE INDEX sales_customer_id_index ON sales (customer_id);
CREATE INDEX sales_customer_project_id_index ON sales (customer_project_id);

CREATE TABLE sale_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id BIGINT NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products (id),
  description TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  unit_price NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sale_items_quantity_nonzero CHECK (quantity <> 0)
);

CREATE INDEX sale_items_sale_id_index ON sale_items (sale_id);
CREATE INDEX sale_items_product_id_index ON sale_items (product_id);

CREATE TABLE purchases (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  supplier_id BIGINT,
  document_number TEXT,
  business_date DATE NOT NULL,
  status TEXT NOT NULL,
  currency_code TEXT,
  notes TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, store_id),
  CONSTRAINT purchases_supplier_store_fk
    FOREIGN KEY (supplier_id, store_id)
    REFERENCES suppliers (id, store_id)
);

CREATE INDEX purchases_store_business_date_index
  ON purchases (store_id, business_date);
CREATE INDEX purchases_supplier_id_index ON purchases (supplier_id);

CREATE TABLE purchase_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_id BIGINT NOT NULL REFERENCES purchases (id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products (id),
  description TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  unit_cost NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT purchase_items_quantity_nonzero CHECK (quantity <> 0)
);

CREATE INDEX purchase_items_purchase_id_index ON purchase_items (purchase_id);
CREATE INDEX purchase_items_product_id_index ON purchase_items (product_id);

CREATE TABLE payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  customer_id BIGINT,
  supplier_id BIGINT,
  sale_id BIGINT,
  purchase_id BIGINT,
  direction TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency_code TEXT,
  payment_method TEXT,
  reference TEXT,
  paid_at TIMESTAMPTZ NOT NULL,
  notes TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payments_amount_nonnegative CHECK (amount >= 0),
  CONSTRAINT payments_single_party CHECK (num_nonnulls(customer_id, supplier_id) = 1),
  CONSTRAINT payments_customer_store_fk
    FOREIGN KEY (customer_id, store_id)
    REFERENCES customers (id, store_id),
  CONSTRAINT payments_supplier_store_fk
    FOREIGN KEY (supplier_id, store_id)
    REFERENCES suppliers (id, store_id),
  CONSTRAINT payments_sale_store_fk
    FOREIGN KEY (sale_id, store_id)
    REFERENCES sales (id, store_id),
  CONSTRAINT payments_purchase_store_fk
    FOREIGN KEY (purchase_id, store_id)
    REFERENCES purchases (id, store_id)
);

CREATE INDEX payments_store_paid_at_index ON payments (store_id, paid_at);
CREATE INDEX payments_customer_id_index ON payments (customer_id);
CREATE INDEX payments_supplier_id_index ON payments (supplier_id);

CREATE TABLE checks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  customer_id BIGINT,
  supplier_id BIGINT,
  check_number TEXT NOT NULL,
  bank_name TEXT,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency_code TEXT,
  due_date DATE NOT NULL,
  notes TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT checks_amount_nonnegative CHECK (amount >= 0),
  CONSTRAINT checks_at_most_one_party CHECK (num_nonnulls(customer_id, supplier_id) <= 1),
  CONSTRAINT checks_customer_store_fk
    FOREIGN KEY (customer_id, store_id)
    REFERENCES customers (id, store_id),
  CONSTRAINT checks_supplier_store_fk
    FOREIGN KEY (supplier_id, store_id)
    REFERENCES suppliers (id, store_id)
);

CREATE INDEX checks_store_due_date_index ON checks (store_id, due_date);
CREATE INDEX checks_customer_id_index ON checks (customer_id);
CREATE INDEX checks_supplier_id_index ON checks (supplier_id);

CREATE TABLE expenses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  description TEXT NOT NULL,
  expense_category TEXT,
  amount NUMERIC NOT NULL,
  currency_code TEXT,
  expense_date DATE NOT NULL,
  payment_method TEXT,
  status TEXT NOT NULL,
  notes TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT expenses_amount_nonnegative CHECK (amount >= 0)
);

CREATE INDEX expenses_store_expense_date_index
  ON expenses (store_id, expense_date);

CREATE TABLE customer_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  customer_id BIGINT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  currency_code TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  source_type TEXT NOT NULL,
  source_id BIGINT,
  notes TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_ledger_customer_store_fk
    FOREIGN KEY (customer_id, store_id)
    REFERENCES customers (id, store_id)
);

CREATE INDEX customer_ledger_customer_occurred_index
  ON customer_ledger (customer_id, occurred_at);
CREATE INDEX customer_ledger_store_occurred_index
  ON customer_ledger (store_id, occurred_at);

COMMENT ON TABLE customer_ledger IS
  'Append-only source for customer balances; corrections require new entries.';

CREATE TABLE supplier_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  supplier_id BIGINT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  currency_code TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  source_type TEXT NOT NULL,
  source_id BIGINT,
  notes TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT supplier_ledger_supplier_store_fk
    FOREIGN KEY (supplier_id, store_id)
    REFERENCES suppliers (id, store_id)
);

CREATE INDEX supplier_ledger_supplier_occurred_index
  ON supplier_ledger (supplier_id, occurred_at);
CREATE INDEX supplier_ledger_store_occurred_index
  ON supplier_ledger (store_id, occurred_at);

COMMENT ON TABLE supplier_ledger IS
  'Append-only source for supplier balances; corrections require new entries.';

CREATE TABLE inventory_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  movement_type TEXT NOT NULL,
  quantity_delta NUMERIC NOT NULL CHECK (quantity_delta <> 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  source_type TEXT NOT NULL,
  source_id BIGINT,
  reason TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inventory_movements_store_product_fk
    FOREIGN KEY (store_id, product_id)
    REFERENCES store_inventory (store_id, product_id)
);

CREATE INDEX inventory_movements_store_product_occurred_index
  ON inventory_movements (store_id, product_id, occurred_at);
CREATE INDEX inventory_movements_source_index
  ON inventory_movements (source_type, source_id);

COMMENT ON TABLE inventory_movements IS
  'Append-only source for auditable on-hand inventory quantities.';

CREATE TABLE financial_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores (id),
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  currency_code TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  source_type TEXT NOT NULL,
  source_id BIGINT,
  description TEXT,
  created_by_user_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX financial_movements_store_occurred_index
  ON financial_movements (store_id, occurred_at);
CREATE INDEX financial_movements_source_index
  ON financial_movements (source_type, source_id);

CREATE TABLE audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT REFERENCES stores (id),
  actor_user_id BIGINT REFERENCES users (id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  old_values JSONB,
  new_values JSONB,
  request_id TEXT,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_log_entity_index ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_store_created_index ON audit_log (store_id, created_at);
CREATE INDEX audit_log_actor_created_index ON audit_log (actor_user_id, created_at);

CREATE TABLE push_subscriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT REFERENCES users (id) ON DELETE CASCADE,
  store_id BIGINT REFERENCES stores (id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX push_subscriptions_user_id_index ON push_subscriptions (user_id);
CREATE INDEX push_subscriptions_store_id_index ON push_subscriptions (store_id);

CREATE TABLE system_settings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT REFERENCES stores (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (store_id, key)
);

CREATE VIEW store_inventory_balances AS
SELECT
  inventory.store_id,
  inventory.product_id,
  COALESCE(SUM(movements.quantity_delta), 0::NUMERIC) AS quantity
FROM store_inventory AS inventory
LEFT JOIN inventory_movements AS movements
  ON movements.store_id = inventory.store_id
 AND movements.product_id = inventory.product_id
GROUP BY inventory.store_id, inventory.product_id;

CREATE VIEW customer_balances AS
SELECT
  customers.store_id,
  customers.id AS customer_id,
  ledger.currency_code,
  COALESCE(
    SUM(
      CASE ledger.direction
        WHEN 'debit' THEN ledger.amount
        WHEN 'credit' THEN -ledger.amount
      END
    ),
    0::NUMERIC
  ) AS balance
FROM customers
LEFT JOIN customer_ledger AS ledger
  ON ledger.store_id = customers.store_id
 AND ledger.customer_id = customers.id
GROUP BY customers.store_id, customers.id, ledger.currency_code;

CREATE VIEW supplier_balances AS
SELECT
  suppliers.store_id,
  suppliers.id AS supplier_id,
  ledger.currency_code,
  COALESCE(
    SUM(
      CASE ledger.direction
        WHEN 'credit' THEN ledger.amount
        WHEN 'debit' THEN -ledger.amount
      END
    ),
    0::NUMERIC
  ) AS balance
FROM suppliers
LEFT JOIN supplier_ledger AS ledger
  ON ledger.store_id = suppliers.store_id
 AND ledger.supplier_id = suppliers.id
GROUP BY suppliers.store_id, suppliers.id, ledger.currency_code;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'stores',
    'categories',
    'products',
    'barcodes',
    'store_inventory',
    'customers',
    'customer_projects',
    'suppliers',
    'sales',
    'sale_items',
    'purchases',
    'purchase_items',
    'payments',
    'checks',
    'expenses',
    'push_subscriptions',
    'system_settings'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      table_name || '_set_updated_at',
      table_name
    );
  END LOOP;
END;
$$;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_ledger',
    'supplier_ledger',
    'inventory_movements',
    'financial_movements',
    'audit_log'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION reject_append_only_change()',
      table_name || '_append_only',
      table_name
    );
  END LOOP;
END;
$$;
