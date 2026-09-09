-- Immutable sale invoices with exact server-calculated totals. Existing sale
-- rows can be upgraded only when their invoice identity and product links are
-- complete; missing historical facts must not be invented by a migration.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sales
    WHERE document_number IS NULL OR BTRIM(document_number) = ''
  ) THEN
    RAISE EXCEPTION
      'Cannot make sales immutable while a sale has no invoice number. Backfill it explicitly before applying 0011.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM sales
    GROUP BY store_id, document_number
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce per-store invoice uniqueness while duplicate sale invoice numbers exist.';
  END IF;

  IF EXISTS (SELECT 1 FROM sale_items WHERE product_id IS NULL) THEN
    RAISE EXCEPTION
      'Cannot deduct sale inventory while a historical sale item has no product. Link it explicitly before applying 0011.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM sale_items
    WHERE quantity <= 0
       OR quantity > 999999999999.999
       OR quantity <> TRUNC(quantity, 3)
       OR unit_price < 0
       OR unit_price > 999999999999.50
       OR MOD(unit_price, 0.50::NUMERIC) <> 0
  ) THEN
    RAISE EXCEPTION
      'Historical sale item quantity or price exceeds the precision supported by 0011.';
  END IF;
END;
$$;

ALTER TABLE sales
  ALTER COLUMN document_number SET NOT NULL,
  ADD COLUMN items_subtotal NUMERIC(32, 5),
  ADD COLUMN invoice_discount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN total NUMERIC(32, 5);

-- PostgreSQL cannot change a column type while an UPDATE OF trigger depends on
-- that column. Keep the validation function and recreate its trigger after the
-- controlled precision upgrade below.
DROP TRIGGER sale_items_enforce_unit_quantity ON sale_items;

ALTER TABLE sale_items
  DROP CONSTRAINT sale_items_quantity_nonzero,
  ALTER COLUMN product_id SET NOT NULL,
  ALTER COLUMN quantity TYPE NUMERIC(15, 3) USING quantity::NUMERIC(15, 3),
  ALTER COLUMN unit_price TYPE NUMERIC(14, 2) USING unit_price::NUMERIC(14, 2),
  ADD COLUMN original_unit_price NUMERIC(14, 2),
  ADD COLUMN line_discount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN line_total NUMERIC(32, 5);

UPDATE sale_items
SET line_total = (quantity * unit_price) - line_discount;

UPDATE sales AS sale
SET items_subtotal = totals.items_subtotal,
    total = totals.items_subtotal - sale.invoice_discount
FROM (
  SELECT
    sales.id AS sale_id,
    COALESCE(SUM(sale_items.line_total), 0::NUMERIC) AS items_subtotal
  FROM sales
  LEFT JOIN sale_items ON sale_items.sale_id = sales.id
  GROUP BY sales.id
) AS totals
WHERE totals.sale_id = sale.id;

ALTER TABLE sales
  ALTER COLUMN items_subtotal SET NOT NULL,
  ALTER COLUMN total SET NOT NULL,
  ADD CONSTRAINT sales_invoice_number_not_blank
    CHECK (BTRIM(document_number) <> '' AND CHAR_LENGTH(document_number) <= 100),
  ADD CONSTRAINT sales_invoice_discount_nonnegative_half_ils
    CHECK (
      invoice_discount >= 0
      AND MOD(invoice_discount, 0.50::NUMERIC) = 0
    ),
  ADD CONSTRAINT sales_totals_consistent
    CHECK (
      items_subtotal >= 0
      AND invoice_discount <= items_subtotal
      AND total = items_subtotal - invoice_discount
    ),
  ADD CONSTRAINT sales_store_document_number_unique
    UNIQUE (store_id, document_number);

ALTER TABLE sale_items
  ALTER COLUMN line_total SET NOT NULL,
  ADD CONSTRAINT sale_items_quantity_positive
    CHECK (quantity > 0),
  ADD CONSTRAINT sale_items_original_price_nonnegative_half_ils
    CHECK (
      original_unit_price IS NULL
      OR (
        original_unit_price >= 0
        AND MOD(original_unit_price, 0.50::NUMERIC) = 0
      )
    ),
  ADD CONSTRAINT sale_items_actual_price_nonnegative_half_ils
    CHECK (unit_price >= 0 AND MOD(unit_price, 0.50::NUMERIC) = 0),
  ADD CONSTRAINT sale_items_discount_nonnegative_half_ils
    CHECK (line_discount >= 0 AND MOD(line_discount, 0.50::NUMERIC) = 0),
  ADD CONSTRAINT sale_items_total_consistent
    CHECK (
      line_discount <= quantity * unit_price
      AND line_total = (quantity * unit_price) - line_discount
    );

COMMENT ON COLUMN sales.document_number IS
  'Required invoice number, unique inside its store and immutable after creation.';
COMMENT ON COLUMN sales.items_subtotal IS
  'Server-calculated sum of immutable sale item totals before invoice discount.';
COMMENT ON COLUMN sales.invoice_discount IS
  'Invoice-level ILS amount discount captured at sale creation.';
COMMENT ON COLUMN sales.total IS
  'Server-calculated final ILS total after item and invoice discounts.';
COMMENT ON COLUMN sale_items.original_unit_price IS
  'Snapshot of the product default sale price at creation; null when no default existed.';
COMMENT ON COLUMN sale_items.unit_price IS
  'Actual unit sale price accepted at creation; immutable after the sale is saved.';
COMMENT ON COLUMN sale_items.line_discount IS
  'Line-level ILS amount discount captured at sale creation.';
COMMENT ON COLUMN sale_items.line_total IS
  'Server-calculated quantity times actual price minus the line discount.';

CREATE TRIGGER sale_items_enforce_unit_quantity
BEFORE INSERT OR UPDATE OF product_id, quantity ON sale_items
FOR EACH ROW EXECUTE FUNCTION enforce_sale_item_unit_quantity();

DROP TRIGGER sales_set_updated_at ON sales;
DROP TRIGGER sale_items_set_updated_at ON sale_items;

CREATE TRIGGER sales_immutable
BEFORE UPDATE OR DELETE ON sales
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

CREATE TRIGGER sale_items_immutable
BEFORE UPDATE OR DELETE ON sale_items
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
