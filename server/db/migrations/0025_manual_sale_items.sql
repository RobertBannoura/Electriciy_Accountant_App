-- Allow invoice-only sale lines entered directly at checkout. Manual lines do
-- not reference inventory and therefore never create stock or cost movements.

ALTER TABLE sale_items
  ALTER COLUMN product_id DROP NOT NULL,
  ADD CONSTRAINT sale_items_description_not_blank
    CHECK (BTRIM(description) <> '');

COMMENT ON COLUMN sale_items.product_id IS
  'Catalog product for stock-tracked lines; null for invoice-only manual lines.';
COMMENT ON COLUMN sale_items.description IS
  'Immutable invoice description, typed directly for manual lines or copied from the catalog.';
