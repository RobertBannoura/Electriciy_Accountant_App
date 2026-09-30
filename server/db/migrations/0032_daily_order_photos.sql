CREATE TABLE daily_order_photos (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upload_id UUID NOT NULL UNIQUE,
  store_id BIGINT NOT NULL REFERENCES stores(id),
  business_date DATE NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_by_user_id BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX daily_order_photos_store_date_index
  ON daily_order_photos (store_id, business_date, id DESC);
