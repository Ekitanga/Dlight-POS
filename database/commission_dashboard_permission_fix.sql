-- Corrects the early commission migration, which could expand dashboard.view
-- into management-only financial widgets for attendants. Safe to run repeatedly.

DELETE FROM user_permissions up
USING permissions permission, users account
WHERE up.permission_id = permission.id
  AND up.user_id = account.id
  AND permission.module = 'dashboard'
  AND permission.action IN (
    'management_sales', 'management_profit', 'management_suppliers', 'management_riders',
    'management_inventory', 'management_expenses', 'management_reports', 'management_audit'
  )
  AND account.role = 'attendant';

-- Legacy role assignments can include the company-wide commission permission.
-- Attendants must retain only the explicitly scoped own_* permissions below.
DELETE FROM user_permissions up
USING permissions permission, users account
WHERE up.permission_id = permission.id
  AND up.user_id = account.id
  AND permission.module = 'commission'
  AND permission.action IN ('view', 'manage', 'approve', 'pay', 'adjust', 'reconcile', 'close')
  AND account.role = 'attendant';

INSERT INTO user_permissions (user_id, permission_id, granted_by)
SELECT existing.user_id, granular.id, existing.granted_by
FROM user_permissions existing
JOIN permissions broad ON broad.id = existing.permission_id
JOIN users account ON account.id = existing.user_id
JOIN permissions granular ON granular.module = 'dashboard'
  AND granular.action IN ('personal_sales', 'personal_orders', 'pending_speedaf')
WHERE broad.module = 'dashboard' AND broad.action = 'view'
  AND account.role = 'attendant'
ON CONFLICT DO NOTHING;

-- Reapply the correct migration safely for systems that were already updated
-- with the overly broad/non-management role filter.
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

INSERT INTO user_permissions (user_id, permission_id, granted_by)
SELECT account.id, personal.id, NULL
FROM users account
JOIN permissions personal ON personal.module = 'commission'
  AND personal.action IN ('own_view', 'own_daily', 'own_monthly', 'own_history', 'own_transactions', 'own_potential')
WHERE account.role = 'attendant'
ON CONFLICT DO NOTHING;
