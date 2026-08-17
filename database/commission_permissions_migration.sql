INSERT INTO permissions (name, description, module, action) VALUES
  ('dashboard_personal_sales', 'View own sales summary on dashboard', 'dashboard', 'personal_sales'),
  ('dashboard_personal_orders', 'View own assigned and completed orders on dashboard', 'dashboard', 'personal_orders'),
  ('dashboard_pending_speedaf', 'View own pending Speedaf orders on dashboard', 'dashboard', 'pending_speedaf'),
  ('dashboard_management_sales', 'View company-wide sales on dashboard', 'dashboard', 'management_sales'),
  ('dashboard_management_profit', 'View profit summaries on dashboard', 'dashboard', 'management_profit'),
  ('dashboard_management_suppliers', 'View supplier summaries on dashboard', 'dashboard', 'management_suppliers'),
  ('dashboard_management_riders', 'View rider summaries on dashboard', 'dashboard', 'management_riders'),
  ('dashboard_management_inventory', 'View inventory summaries on dashboard', 'dashboard', 'management_inventory'),
  ('dashboard_management_expenses', 'View expenses on dashboard', 'dashboard', 'management_expenses'),
  ('dashboard_management_reports', 'View global reports on dashboard', 'dashboard', 'management_reports'),
  ('dashboard_management_audit', 'View audit information on dashboard', 'dashboard', 'management_audit'),
  ('commission_view', 'View commission dashboard and reports', 'commission', 'view'),
  ('commission_own_view', 'View own commission summary', 'commission', 'own_view'),
  ('commission_own_daily', 'View own daily commission breakdown', 'commission', 'own_daily'),
  ('commission_own_monthly', 'View own monthly commission summary', 'commission', 'own_monthly'),
  ('commission_own_history', 'View own commission history by month', 'commission', 'own_history'),
  ('commission_own_transactions', 'View own commission transaction ledger', 'commission', 'own_transactions'),
  ('commission_own_potential', 'View own potential/pending commission', 'commission', 'own_potential'),
  ('commission_manage', 'Manage commission programme settings, rates, and eligibility', 'commission', 'manage'),
  ('commission_approve', 'Approve commission for payment', 'commission', 'approve'),
  ('commission_pay', 'Record commission payments', 'commission', 'pay'),
  ('commission_adjust', 'Create manual commission adjustments', 'commission', 'adjust'),
  ('commission_reconcile', 'Run commission reconciliation', 'commission', 'reconcile'),
  ('commission_close', 'Close commission periods and view closure history', 'commission', 'close')
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  module = EXCLUDED.module,
  action = EXCLUDED.action;

-- Preserve personal dashboard access for existing non-management users without
-- turning a broad legacy dashboard.view grant into access to company financials.
INSERT INTO user_permissions (user_id, permission_id, granted_by)
SELECT existing.user_id, granular.id, existing.granted_by
FROM user_permissions existing
JOIN permissions broad ON broad.id = existing.permission_id
JOIN users account ON account.id = existing.user_id
JOIN permissions granular ON granular.module = 'dashboard'
  AND granular.action IN (
    'personal_sales', 'personal_orders', 'pending_speedaf'
  )
WHERE broad.module = 'dashboard' AND broad.action = 'view'
  AND account.role = 'attendant'
ON CONFLICT DO NOTHING;

-- Preserve the management dashboard for existing managers who previously had
-- the broad dashboard permission. Attendants receive only personal widgets.
INSERT INTO user_permissions (user_id, permission_id, granted_by)
SELECT existing.user_id, granular.id, existing.granted_by
FROM user_permissions existing
JOIN permissions broad ON broad.id = existing.permission_id
JOIN users account ON account.id = existing.user_id
JOIN permissions granular ON granular.module = 'dashboard'
  AND granular.action IN (
    'management_sales', 'management_profit', 'management_suppliers', 'management_riders',
    'management_inventory', 'management_expenses', 'management_reports', 'management_audit'
  )
WHERE broad.module = 'dashboard' AND broad.action = 'view'
  AND account.role = 'manager'
ON CONFLICT DO NOTHING;

-- Attendants can see only their own commission information. This does not grant
-- approval, payment, settings, or company-wide reporting access.
INSERT INTO user_permissions (user_id, permission_id, granted_by)
SELECT account.id, personal.id, NULL
FROM users account
JOIN permissions personal ON personal.module = 'commission'
  AND personal.action IN ('own_view', 'own_daily', 'own_monthly', 'own_history', 'own_transactions', 'own_potential')
WHERE account.role = 'attendant'
ON CONFLICT DO NOTHING;
