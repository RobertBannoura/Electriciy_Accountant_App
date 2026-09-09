-- Product catalog fields and store ownership for the first product workflow.

ALTER TABLE categories ADD COLUMN store_id BIGINT REFERENCES stores (id);
ALTER TABLE products ADD COLUMN store_id BIGINT REFERENCES stores (id);
ALTER TABLE products ADD COLUMN current_purchase_price NUMERIC(14, 2);
ALTER TABLE products ADD COLUMN default_sale_price NUMERIC(14, 2);

UPDATE products AS product
SET store_id = COALESCE(
  (
    SELECT MIN(inventory.store_id)
    FROM store_inventory AS inventory
    WHERE inventory.product_id = product.id
  ),
  (SELECT MIN(id) FROM stores)
)
WHERE product.store_id IS NULL;

UPDATE categories AS category
SET store_id = COALESCE(
  (
    SELECT MIN(product.store_id)
    FROM products AS product
    WHERE product.category_id = category.id
  ),
  (SELECT MIN(id) FROM stores)
)
WHERE category.store_id IS NULL;

INSERT INTO categories (store_id, name)
SELECT DISTINCT product.store_id, 'غير مصنف (بيانات سابقة)'
FROM products AS product
LEFT JOIN categories AS category
  ON category.id = product.category_id
 AND category.store_id = product.store_id
WHERE category.id IS NULL;

UPDATE products AS product
SET category_id = category.id
FROM categories AS category
WHERE category.store_id = product.store_id
  AND category.name = 'غير مصنف (بيانات سابقة)'
  AND NOT EXISTS (
    SELECT 1
    FROM categories AS current_category
    WHERE current_category.id = product.category_id
      AND current_category.store_id = product.store_id
  );

UPDATE products
SET unit_name = 'قطعة'
WHERE unit_name IS NULL;

ALTER TABLE categories ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE products ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE products ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE products ALTER COLUMN unit_name SET NOT NULL;

ALTER TABLE products
  ADD CONSTRAINT products_sale_unit_check
    CHECK (unit_name IN ('قطعة', 'متر')),
  ADD CONSTRAINT products_purchase_price_nonnegative
    CHECK (current_purchase_price IS NULL OR current_purchase_price >= 0),
  ADD CONSTRAINT products_sale_price_nonnegative
    CHECK (default_sale_price IS NULL OR default_sale_price >= 0),
  ADD CONSTRAINT products_purchase_price_half_ils
    CHECK (
      current_purchase_price IS NULL
      OR MOD(current_purchase_price, 0.50::NUMERIC) = 0
    ),
  ADD CONSTRAINT products_sale_price_half_ils
    CHECK (
      default_sale_price IS NULL
      OR MOD(default_sale_price, 0.50::NUMERIC) = 0
    );

ALTER TABLE categories ADD CONSTRAINT categories_id_store_unique UNIQUE (id, store_id);
ALTER TABLE products
  ADD CONSTRAINT products_category_store_fk
  FOREIGN KEY (category_id, store_id)
  REFERENCES categories (id, store_id);

CREATE UNIQUE INDEX categories_store_name_lower_active_unique
  ON categories (store_id, LOWER(name))
  WHERE is_active = TRUE;
CREATE INDEX categories_store_name_index ON categories (store_id, name);
CREATE INDEX products_store_name_index ON products (store_id, name);

CREATE OR REPLACE FUNCTION enforce_sale_item_unit_quantity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  product_unit TEXT;
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT unit_name INTO product_unit
  FROM products
  WHERE id = NEW.product_id;

  IF product_unit = 'قطعة' AND NEW.quantity <> TRUNC(NEW.quantity) THEN
    RAISE EXCEPTION 'Piece products require a whole-number sale quantity'
      USING ERRCODE = '23514',
            CONSTRAINT = 'sale_items_piece_quantity_whole';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER sale_items_enforce_unit_quantity
BEFORE INSERT OR UPDATE OF product_id, quantity ON sale_items
FOR EACH ROW EXECUTE FUNCTION enforce_sale_item_unit_quantity();
