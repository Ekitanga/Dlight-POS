ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS frequency VARCHAR(20) NOT NULL DEFAULT 'one_off',
  ADD COLUMN IF NOT EXISTS reference_notes TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'expenses_frequency_check'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_frequency_check
      CHECK (frequency IN ('daily', 'monthly', 'one_off'));
  END IF;
END $$;

UPDATE expenses
SET frequency = 'one_off'
WHERE frequency IS NULL OR frequency NOT IN ('daily', 'monthly', 'one_off');
