CREATE TABLE catalog_entries (
  product_id BIGINT PRIMARY KEY REFERENCES products(id),
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000)
);
CREATE TABLE catalog_photos (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upload_id UUID NOT NULL UNIQUE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  object_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX catalog_photos_product_index ON catalog_photos (product_id, id) WHERE is_active;
CREATE TABLE catalog_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  show_sale_prices BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO catalog_settings (id) VALUES (1);
CREATE TABLE catalog_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '12 hours'
);
