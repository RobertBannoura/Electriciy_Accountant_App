-- Preserve the stock behavior of existing bills while recording whether each
-- new bill line changed inventory. Only showroom bills track stock going forward.
-- NULL marks an immutable legacy line. Legacy catalog lines used to move stock;
-- legacy manual lines did not. New writers always save an explicit value.
ALTER TABLE sale_items ADD COLUMN tracks_inventory BOOLEAN;
ALTER TABLE purchase_items ADD COLUMN tracks_inventory BOOLEAN;

ALTER TABLE sale_items ADD CONSTRAINT sale_items_tracking_requires_product
  CHECK (tracks_inventory IS NOT TRUE OR product_id IS NOT NULL);
ALTER TABLE purchase_items ADD CONSTRAINT purchase_items_tracking_requires_product
  CHECK (tracks_inventory IS NOT TRUE OR product_id IS NOT NULL);

COMMENT ON COLUMN sale_items.tracks_inventory IS
  'True when this sale line changed stock; NULL infers legacy behavior. New sales track only in SHOWROOM.';
COMMENT ON COLUMN purchase_items.tracks_inventory IS
  'True when this purchase line changed stock; NULL infers legacy behavior. New purchases track only in SHOWROOM.';
