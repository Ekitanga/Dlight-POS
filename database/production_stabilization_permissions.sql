INSERT INTO permissions (name, description, module, action) VALUES
  ('orders_status', 'Update order workflow statuses', 'orders', 'status'),
  ('reports_reconcile', 'Create and close daily reconciliation', 'reports', 'reconcile'),
  ('audit_view', 'View critical system audit history', 'audit', 'view')
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  module = EXCLUDED.module,
  action = EXCLUDED.action;
