-- Purchase document numbers are assigned by the database when left blank.
-- Existing blank historical rows are backfilled from their immutable identity.

DROP TRIGGER purchases_immutable ON purchases;

UPDATE purchases
SET document_number = 'P-' || LPAD(id::TEXT, 8, '0')
WHERE document_number IS NULL OR BTRIM(document_number) = '';

ALTER TABLE purchases
  ALTER COLUMN document_number SET NOT NULL,
  ADD CONSTRAINT purchases_document_number_not_blank
    CHECK (BTRIM(document_number) <> '' AND CHAR_LENGTH(document_number) <= 100);

CREATE TRIGGER purchases_immutable
BEFORE UPDATE OR DELETE ON purchases
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

CREATE OR REPLACE FUNCTION assign_automatic_purchase_document_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  base_number TEXT;
  candidate_number TEXT;
  collision_suffix BIGINT := 0;
BEGIN
  IF NEW.document_number IS NOT NULL AND BTRIM(NEW.document_number) <> '' THEN
    RETURN NEW;
  END IF;

  base_number := 'P-' || LPAD(NEW.id::TEXT, 8, '0');
  candidate_number := base_number;

  WHILE EXISTS (
    SELECT 1
    FROM purchases
    WHERE store_id = NEW.store_id
      AND document_number = candidate_number
  ) LOOP
    collision_suffix := collision_suffix + 1;
    candidate_number := base_number || '-' || collision_suffix::TEXT;
  END LOOP;

  NEW.document_number := candidate_number;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchases_assign_automatic_document_number
BEFORE INSERT ON purchases
FOR EACH ROW EXECUTE FUNCTION assign_automatic_purchase_document_number();

COMMENT ON FUNCTION assign_automatic_purchase_document_number() IS
  'Assigns a purchase document number when a purchase is inserted without one.';
