-- Sale invoice numbers are assigned at insert time from the database identity.
-- The identity is global and concurrency-safe; the small collision loop only
-- handles a legacy manually entered document that happens to match a new number.

CREATE OR REPLACE FUNCTION assign_automatic_sale_document_number()
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

  base_number := 'S-' || LPAD(NEW.id::TEXT, 8, '0');
  candidate_number := base_number;

  WHILE EXISTS (
    SELECT 1
    FROM sales
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

CREATE TRIGGER sales_assign_automatic_document_number
BEFORE INSERT ON sales
FOR EACH ROW EXECUTE FUNCTION assign_automatic_sale_document_number();

COMMENT ON FUNCTION assign_automatic_sale_document_number() IS
  'Assigns a concurrency-safe invoice number when a sale is inserted without one.';
