ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS commission_module_enabled BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE settings SET commission_module_enabled = COALESCE(commission_module_enabled, TRUE);
