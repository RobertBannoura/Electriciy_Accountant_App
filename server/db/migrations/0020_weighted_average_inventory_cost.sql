-- Perpetual weighted-average inventory costing, maintained independently for
-- every (store, product). Cost movements and sale snapshots are append-only.

CREATE TABLE inventory_cost_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  inventory_movement_id BIGINT UNIQUE REFERENCES inventory_movements (id),
  quantity_delta NUMERIC(38, 12) NOT NULL CHECK (quantity_delta <> 0),
  unit_cost_snapshot NUMERIC(38, 12) NOT NULL CHECK (unit_cost_snapshot >= 0),
  inventory_value_delta NUMERIC(38, 12) NOT NULL CHECK (
    (quantity_delta > 0 AND inventory_value_delta >= 0)
    OR (quantity_delta < 0 AND inventory_value_delta <= 0)
  ),
  occurred_at TIMESTAMPTZ NOT NULL,
  source_type TEXT NOT NULL,
  source_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inventory_cost_movements_store_product_fk
    FOREIGN KEY (store_id, product_id) REFERENCES store_inventory (store_id, product_id)
);

CREATE INDEX inventory_cost_movements_store_product_index
  ON inventory_cost_movements (store_id, product_id, id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM store_inventory_balances WHERE quantity < 0) THEN
    RAISE EXCEPTION
      'Cannot initialize weighted-average cost while a store/product has negative stock. Correct inventory explicitly before applying 0020.';
  END IF;
END;
$$;

-- Existing inventory has no reliable historical cost trail. Seed its current
-- quantity once at the product's current purchase price (or zero if absent),
-- without rewriting any historical inventory, purchase, or sale row.
INSERT INTO inventory_cost_movements (
  store_id, product_id, inventory_movement_id, quantity_delta,
  unit_cost_snapshot, inventory_value_delta, occurred_at, source_type
)
SELECT balances.store_id, balances.product_id, NULL, balances.quantity,
  COALESCE(products.current_purchase_price, 0::NUMERIC),
  ROUND(balances.quantity * COALESCE(products.current_purchase_price, 0::NUMERIC), 12),
  NOW(), 'legacy_cost_seed'
FROM store_inventory_balances AS balances
INNER JOIN products ON products.id = balances.product_id
WHERE balances.quantity <> 0;

CREATE VIEW store_inventory_cost_balances AS
SELECT inventory.store_id, inventory.product_id,
  COALESCE(SUM(cost.quantity_delta), 0::NUMERIC) AS quantity,
  COALESCE(SUM(cost.inventory_value_delta), 0::NUMERIC) AS inventory_value,
  CASE
    WHEN COALESCE(SUM(cost.quantity_delta), 0::NUMERIC) > 0
    THEN ROUND(
      COALESCE(SUM(cost.inventory_value_delta), 0::NUMERIC)
      / SUM(cost.quantity_delta),
      12
    )
    ELSE 0::NUMERIC
  END AS weighted_average_cost
FROM store_inventory AS inventory
LEFT JOIN inventory_cost_movements AS cost
  ON cost.store_id = inventory.store_id
 AND cost.product_id = inventory.product_id
GROUP BY inventory.store_id, inventory.product_id;

CREATE TRIGGER inventory_cost_movements_append_only
BEFORE UPDATE OR DELETE ON inventory_cost_movements
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

CREATE FUNCTION validate_inventory_cost_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  inventory_movement inventory_movements%ROWTYPE;
BEGIN
  IF NEW.inventory_movement_id IS NULL THEN
    IF NEW.source_type <> 'legacy_cost_seed' THEN
      RAISE EXCEPTION 'Only the migration seed may omit inventory_movement_id'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO inventory_movement
  FROM inventory_movements
  WHERE id = NEW.inventory_movement_id;

  IF NOT FOUND
     OR inventory_movement.store_id <> NEW.store_id
     OR inventory_movement.product_id <> NEW.product_id
     OR inventory_movement.quantity_delta <> NEW.quantity_delta
  THEN
    RAISE EXCEPTION 'Inventory cost movement must match its inventory movement'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_cost_movements_validate
BEFORE INSERT ON inventory_cost_movements
FOR EACH ROW EXECUTE FUNCTION validate_inventory_cost_movement();

CREATE FUNCTION require_inventory_cost_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory_cost_movements
    WHERE inventory_movement_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Inventory movement % has no matching cost movement', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER inventory_movements_require_cost
AFTER INSERT ON inventory_movements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_inventory_cost_movement();

DROP TRIGGER sales_immutable ON sales;
DROP TRIGGER sale_items_immutable ON sale_items;

ALTER TABLE sale_items
  ADD COLUMN unit_cost_snapshot NUMERIC(38, 12),
  ADD COLUMN cost_total NUMERIC(38, 12),
  ADD COLUMN gross_profit_before_invoice_discount NUMERIC(38, 12);

UPDATE sale_items
SET unit_cost_snapshot = COALESCE(products.current_purchase_price, 0::NUMERIC),
    cost_total = ROUND(sale_items.quantity * COALESCE(products.current_purchase_price, 0::NUMERIC), 12),
    gross_profit_before_invoice_discount = sale_items.line_total
      - ROUND(sale_items.quantity * COALESCE(products.current_purchase_price, 0::NUMERIC), 12)
FROM products
WHERE products.id = sale_items.product_id;

ALTER TABLE sale_items
  ALTER COLUMN unit_cost_snapshot SET NOT NULL,
  ALTER COLUMN cost_total SET NOT NULL,
  ALTER COLUMN gross_profit_before_invoice_discount SET NOT NULL,
  ADD CONSTRAINT sale_items_cost_snapshot_consistent CHECK (
    unit_cost_snapshot >= 0
    AND cost_total = ROUND(quantity * unit_cost_snapshot, 12)
    AND gross_profit_before_invoice_discount = line_total - cost_total
  );

ALTER TABLE sales
  ADD COLUMN cost_total NUMERIC(38, 12) DEFAULT 0,
  ADD COLUMN gross_profit NUMERIC(38, 12) DEFAULT 0;

UPDATE sales AS sale
SET cost_total = costs.cost_total,
    gross_profit = sale.total - costs.cost_total
FROM (
  SELECT sales.id AS sale_id, COALESCE(SUM(sale_items.cost_total), 0::NUMERIC) AS cost_total
  FROM sales
  LEFT JOIN sale_items ON sale_items.sale_id = sales.id
  GROUP BY sales.id
) AS costs
WHERE costs.sale_id = sale.id;

ALTER TABLE sales
  ALTER COLUMN cost_total SET NOT NULL,
  ALTER COLUMN gross_profit SET NOT NULL,
  ADD CONSTRAINT sales_profit_snapshot_consistent CHECK (
    cost_total >= 0 AND gross_profit = total - cost_total
  );

CREATE TRIGGER sales_immutable
BEFORE UPDATE OR DELETE ON sales
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

CREATE TRIGGER sale_items_immutable
BEFORE UPDATE OR DELETE ON sale_items
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

COMMENT ON TABLE inventory_cost_movements IS
  'Append-only perpetual weighted-average cost ledger, independent per store/product.';
COMMENT ON COLUMN products.current_purchase_price IS
  'Latest purchase-line price only; it is not weighted-average cost and never determines historical profit.';
COMMENT ON COLUMN purchase_items.unit_cost IS
  'Immutable historical price paid on this purchase line; separate from current and weighted-average cost.';
COMMENT ON COLUMN sale_items.unit_cost_snapshot IS
  'Store/product weighted-average unit cost captured atomically when the sale was recorded.';
COMMENT ON COLUMN sales.gross_profit IS
  'Immutable sale total minus the sum of sale-time inventory cost snapshots.';
