ALTER TABLE expenses DROP CONSTRAINT expenses_recorded_values;

ALTER TABLE expenses
  ADD CONSTRAINT expenses_recorded_values CHECK (
    status <> 'recorded'
    OR (
      amount > 0
      AND MOD(amount, 0.50::NUMERIC) = 0
      AND currency_code = 'ILS'
      AND payment_method IN ('cash', 'bank_card')
      AND CHAR_LENGTH(expense_category) BETWEEN 1 AND 100
      AND expense_category = BTRIM(expense_category)
    )
  ) NOT VALID;
