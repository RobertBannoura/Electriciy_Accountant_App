-- Invoice-only supplier purchase lines may be entered without a catalog product.
-- Their description is the immutable human-readable purchase snapshot.

ALTER TABLE purchase_items
  ADD CONSTRAINT purchase_items_description_not_blank
  CHECK (BTRIM(description) <> '') NOT VALID;

ALTER TABLE purchase_items
  VALIDATE CONSTRAINT purchase_items_description_not_blank;

COMMENT ON COLUMN purchase_items.product_id IS
  'Catalog product for stock-tracked lines; null for invoice-only manual lines.';
COMMENT ON COLUMN purchase_items.description IS
  'Immutable purchase description, typed directly for manual lines or copied from the catalog.';

COMMENT ON CONSTRAINT purchase_items_description_not_blank ON purchase_items IS
  'Manual purchase lines require a description and never create stock or cost movements.';
