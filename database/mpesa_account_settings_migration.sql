ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS mpesa_account_number VARCHAR(50);

