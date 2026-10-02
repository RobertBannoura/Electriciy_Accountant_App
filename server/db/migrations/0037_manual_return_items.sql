-- Manual invoice lines reverse their financial value without moving stock.
ALTER TABLE customer_return_items ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE supplier_return_items ALTER COLUMN product_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION validate_customer_return_item()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  source_quantity NUMERIC;
  returned_quantity NUMERIC;
BEGIN
  SELECT item.quantity INTO source_quantity
  FROM customer_returns AS return_document
  INNER JOIN sales AS sale ON sale.id = return_document.sale_id
    AND sale.store_id = return_document.store_id
  INNER JOIN sale_items AS item ON item.sale_id = sale.id
  WHERE return_document.id = NEW.customer_return_id
    AND item.id = NEW.sale_item_id
    AND item.product_id IS NOT DISTINCT FROM NEW.product_id
  FOR UPDATE OF item;
  IF source_quantity IS NULL THEN
    RAISE EXCEPTION 'Customer return item does not belong to its original sale'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(quantity), 0::NUMERIC) INTO returned_quantity
  FROM customer_return_items WHERE sale_item_id = NEW.sale_item_id;
  IF returned_quantity + NEW.quantity > source_quantity THEN
    RAISE EXCEPTION 'Customer return quantity exceeds original sale quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_supplier_return_item()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  source_quantity NUMERIC;
  returned_quantity NUMERIC;
BEGIN
  SELECT item.quantity INTO source_quantity
  FROM supplier_returns AS return_document
  INNER JOIN purchases AS purchase ON purchase.id = return_document.purchase_id
    AND purchase.store_id = return_document.store_id
  INNER JOIN purchase_items AS item ON item.purchase_id = purchase.id
  WHERE return_document.id = NEW.supplier_return_id
    AND item.id = NEW.purchase_item_id
    AND item.product_id IS NOT DISTINCT FROM NEW.product_id
  FOR UPDATE OF item;
  IF source_quantity IS NULL THEN
    RAISE EXCEPTION 'Supplier return item does not belong to its original purchase'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(quantity), 0::NUMERIC) INTO returned_quantity
  FROM supplier_return_items WHERE purchase_item_id = NEW.purchase_item_id;
  IF returned_quantity + NEW.quantity > source_quantity THEN
    RAISE EXCEPTION 'Supplier return quantity exceeds original purchase quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
