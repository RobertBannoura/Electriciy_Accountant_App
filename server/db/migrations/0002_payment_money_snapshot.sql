-- Payment money is stored as an immutable-at-creation snapshot. No payment row
-- refers to a mutable exchange-rate record for its historical ILS value.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM payments) THEN
    RAISE EXCEPTION
      'Cannot infer historical payment currencies and rates. Backfill payments explicitly before applying 0002.';
  END IF;
END;
$$;

ALTER TABLE payments
  DROP CONSTRAINT payments_amount_nonnegative;

ALTER TABLE payments
  RENAME COLUMN amount TO original_amount;

ALTER TABLE payments
  ALTER COLUMN currency_code SET NOT NULL,
  ADD COLUMN exchange_rate NUMERIC,
  ADD COLUMN converted_ils_amount NUMERIC NOT NULL,
  ADD CONSTRAINT payments_currency_supported
    CHECK (currency_code IN ('ILS', 'USD', 'JOD')),
  ADD CONSTRAINT payments_original_amount_nonnegative
    CHECK (original_amount >= 0),
  ADD CONSTRAINT payments_converted_ils_amount_nonnegative
    CHECK (converted_ils_amount >= 0),
  ADD CONSTRAINT payments_currency_values_consistent CHECK (
    (
      currency_code = 'ILS'
      AND exchange_rate IS NULL
      AND MOD(original_amount, 0.50) = 0
      AND converted_ils_amount = original_amount
    )
    OR
    (
      currency_code IN ('USD', 'JOD')
      AND exchange_rate > 0
      AND converted_ils_amount = original_amount * exchange_rate
    )
  );
