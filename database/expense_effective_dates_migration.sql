ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS effective_end_date DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'expenses_effective_end_date_check'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_effective_end_date_check
      CHECK (effective_end_date IS NULL OR effective_end_date >= expense_date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_expenses_active_schedule
  ON expenses (status, frequency, expense_date, effective_end_date);
