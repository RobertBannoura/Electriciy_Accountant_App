CREATE TABLE catalog_photo_links (
  product_id BIGINT NOT NULL REFERENCES products(id),
  photo_id BIGINT NOT NULL REFERENCES catalog_photos(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (product_id, photo_id)
);
INSERT INTO catalog_photo_links (product_id, photo_id, is_active)
SELECT product_id, id, is_active FROM catalog_photos;
CREATE INDEX catalog_photo_links_photo_index ON catalog_photo_links (photo_id) WHERE is_active;
