ALTER TABLE auth_sessions
  ADD COLUMN remember_me BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN last_seen_at TIMESTAMPTZ;

-- Preserve the behavior of sessions created before this migration.
UPDATE auth_sessions
SET remember_me = expires_at - created_at > INTERVAL '12 hours',
    last_seen_at = created_at;

ALTER TABLE auth_sessions
  ALTER COLUMN last_seen_at SET DEFAULT NOW(),
  ALTER COLUMN last_seen_at SET NOT NULL;
