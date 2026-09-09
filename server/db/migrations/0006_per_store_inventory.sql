-- Products and categories form one shared catalog. Store presence and stock
-- remain in store_inventory and append-only inventory_movements.

ALTER TABLE products DROP CONSTRAINT products_category_store_fk;
DROP INDEX categories_store_name_lower_active_unique;
DROP INDEX categories_store_name_index;
DROP INDEX products_store_name_index;
ALTER TABLE categories DROP CONSTRAINT categories_id_store_unique;

CREATE TEMP TABLE category_merge_map ON COMMIT DROP AS
SELECT
  id AS old_id,
  MIN(id) OVER (PARTITION BY LOWER(name)) AS keep_id
FROM categories;

UPDATE products AS product
SET category_id = mapping.keep_id
FROM category_merge_map AS mapping
WHERE product.category_id = mapping.old_id
  AND mapping.old_id <> mapping.keep_id;

UPDATE categories
SET parent_id = NULL
WHERE parent_id IN (
  SELECT old_id
  FROM category_merge_map
  WHERE old_id <> keep_id
);

DELETE FROM categories AS category
USING category_merge_map AS mapping
WHERE category.id = mapping.old_id
  AND mapping.old_id <> mapping.keep_id;

ALTER TABLE products DROP COLUMN store_id;
ALTER TABLE categories DROP COLUMN store_id;

CREATE UNIQUE INDEX categories_name_lower_active_unique
  ON categories (LOWER(name))
  WHERE is_active = TRUE;

ALTER TABLE store_inventory
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE store_inventory SET reorder_level = 0 WHERE reorder_level IS NULL;
ALTER TABLE store_inventory ALTER COLUMN reorder_level SET NOT NULL;

CREATE OR REPLACE FUNCTION validate_inventory_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  product_unit TEXT;
  inventory_active BOOLEAN;
BEGIN
  IF NEW.movement_type NOT IN (
    'opening',
    'purchase',
    'sale',
    'customer_return',
    'supplier_return',
    'correction',
    'reversal'
  ) THEN
    RAISE EXCEPTION 'Unsupported inventory movement type'
      USING ERRCODE = '23514',
            CONSTRAINT = 'inventory_movements_type_supported';
  END IF;

  SELECT products.unit_name, inventory.is_active
  INTO product_unit, inventory_active
  FROM store_inventory AS inventory
  INNER JOIN products ON products.id = inventory.product_id
  WHERE inventory.store_id = NEW.store_id
    AND inventory.product_id = NEW.product_id;

  IF inventory_active IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Inventory is not active for this product and store'
      USING ERRCODE = '23514',
            CONSTRAINT = 'inventory_movements_active_inventory';
  END IF;

  IF product_unit = 'قطعة' AND NEW.quantity_delta <> TRUNC(NEW.quantity_delta) THEN
    RAISE EXCEPTION 'Piece products require whole-number inventory quantities'
      USING ERRCODE = '23514',
            CONSTRAINT = 'inventory_movements_piece_quantity_whole';
  END IF;

  IF NEW.movement_type IN ('opening', 'purchase', 'customer_return')
     AND NEW.quantity_delta <= 0 THEN
    RAISE EXCEPTION 'This inventory movement requires a positive quantity'
      USING ERRCODE = '23514',
            CONSTRAINT = 'inventory_movements_positive_direction';
  END IF;

  IF NEW.movement_type IN ('sale', 'supplier_return')
     AND NEW.quantity_delta >= 0 THEN
    RAISE EXCEPTION 'This inventory movement requires a negative quantity'
      USING ERRCODE = '23514',
            CONSTRAINT = 'inventory_movements_negative_direction';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movements_validate
BEFORE INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION validate_inventory_movement();

CREATE UNIQUE INDEX inventory_movements_one_opening_per_store_product
  ON inventory_movements (store_id, product_id)
  WHERE movement_type = 'opening';
