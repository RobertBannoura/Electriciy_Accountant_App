ALTER TABLE sales
  ADD COLUMN receiver_name TEXT,
  ADD CONSTRAINT sales_receiver_name_length
    CHECK (receiver_name IS NULL OR (BTRIM(receiver_name) <> '' AND CHAR_LENGTH(receiver_name) <= 150));

COMMENT ON COLUMN sales.receiver_name IS
  'Optional person who received the items for this sale; shown on the printed pricing order.';
