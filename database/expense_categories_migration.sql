ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS expense_categories JSONB NOT NULL DEFAULT '["Rent","Salaries","Electricity","Internet","Packaging","Fuel","Miscellaneous"]'::jsonb;

UPDATE settings
SET expense_categories = '["Rent","Salaries","Electricity","Internet","Packaging","Fuel","Miscellaneous"]'::jsonb
WHERE expense_categories IS NULL OR jsonb_typeof(expense_categories) <> 'array' OR jsonb_array_length(expense_categories) = 0;
