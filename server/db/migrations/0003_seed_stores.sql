-- These codes are permanent identities. Display names remain editable.
INSERT INTO stores (code, name, is_active)
VALUES
  ('AL_SALAM_ELECTRIC', 'كهرباء السلام', TRUE),
  ('SHOWROOM', 'المعرض', TRUE)
ON CONFLICT (code) DO NOTHING;
