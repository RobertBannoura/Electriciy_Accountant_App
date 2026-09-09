CREATE TABLE push_notification_preferences (
  user_id BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  sale_created BOOLEAN NOT NULL DEFAULT TRUE,
  customer_payment BOOLEAN NOT NULL DEFAULT TRUE,
  purchase_created BOOLEAN NOT NULL DEFAULT TRUE,
  supplier_payment BOOLEAN NOT NULL DEFAULT TRUE,
  check_due BOOLEAN NOT NULL DEFAULT TRUE,
  check_bounced BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER push_notification_preferences_set_updated_at
BEFORE UPDATE ON push_notification_preferences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE push_subscriptions
  ADD COLUMN last_success_at TIMESTAMPTZ,
  ADD COLUMN last_failure_at TIMESTAMPTZ;

CREATE TABLE push_notification_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'sale_created',
    'customer_payment',
    'purchase_created',
    'supplier_payment',
    'check_due',
    'check_bounced'
  )),
  source_type TEXT NOT NULL,
  source_id BIGINT NOT NULL,
  business_date DATE NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category, source_type, source_id)
);

CREATE INDEX push_notification_events_created_at_index
  ON push_notification_events (created_at DESC);

COMMENT ON TABLE push_notification_events IS
  'Post-commit Web Push attempts. These rows never participate in the originating financial transaction.';
