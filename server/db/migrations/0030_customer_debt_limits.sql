-- A NULL limit disables follow-up reminders for this customer.
ALTER TABLE customers ADD COLUMN debt_limit_ils NUMERIC;
ALTER TABLE customers ADD CONSTRAINT customers_debt_limit_valid CHECK (
  debt_limit_ils IS NULL OR (
    debt_limit_ils >= 0 AND debt_limit_ils <= 999999999999.99
    AND debt_limit_ils = ROUND(debt_limit_ils, 2)
  )
);
