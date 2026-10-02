ALTER TABLE customers
  ADD COLUMN payment_promise_date DATE,
  ADD COLUMN payment_promise_note TEXT,
  ADD COLUMN payment_promise_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE push_notification_preferences
  ADD COLUMN customer_reminder BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE push_notification_events DROP CONSTRAINT push_notification_events_category_check;
ALTER TABLE push_notification_events ADD CONSTRAINT push_notification_events_category_check
  CHECK (category IN ('sale_created', 'customer_payment', 'purchase_created',
    'supplier_payment', 'check_due', 'check_bounced', 'customer_reminder'));
