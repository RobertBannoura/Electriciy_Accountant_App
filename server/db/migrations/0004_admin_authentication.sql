ALTER TABLE users
  ADD COLUMN role TEXT NOT NULL DEFAULT 'admin',
  ADD CONSTRAINT users_role_supported CHECK (role = 'admin');

ALTER TABLE users
  ALTER COLUMN role DROP DEFAULT;

CREATE TABLE auth_sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_id_index ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expires_at_index ON auth_sessions (expires_at);
