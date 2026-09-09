-- Preserve retired barcode values permanently so they can never be reassigned.

ALTER TABLE barcodes
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN is_generated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN retired_at TIMESTAMPTZ;

DROP INDEX barcodes_one_primary_per_product;
CREATE UNIQUE INDEX barcodes_one_active_primary_per_product
  ON barcodes (product_id)
  WHERE is_primary = TRUE AND is_active = TRUE;

CREATE SEQUENCE generated_barcode_sequence
  AS BIGINT
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  MAXVALUE 999999999
  NO CYCLE;
