INSERT INTO permissions (name, description, module, action) VALUES
  ('dashboard_view', 'View the operational dashboard', 'dashboard', 'view'),
  ('orders_view', 'View orders', 'orders', 'view'),
  ('orders_create', 'Create orders', 'orders', 'create'),
  ('orders_status', 'Update order workflow statuses', 'orders', 'status'),
  ('orders_edit', 'Edit open order details', 'orders', 'edit'),
  ('orders_cancel', 'Cancel or return orders', 'orders', 'cancel'),
  ('customers_view', 'View customers', 'customers', 'view'),
  ('customers_create', 'Create customers', 'customers', 'create'),
  ('customers_edit', 'Edit customers and record credit payments', 'customers', 'edit'),
  ('customers_delete', 'Deactivate customers', 'customers', 'delete'),
  ('products_view', 'View products', 'products', 'view'),
  ('products_create', 'Create products', 'products', 'create'),
  ('products_edit', 'Edit products', 'products', 'edit'),
  ('products_delete', 'Delete products', 'products', 'delete'),
  ('suppliers_view', 'View suppliers and balances', 'suppliers', 'view'),
  ('suppliers_manage', 'Create and edit suppliers', 'suppliers', 'manage'),
  ('suppliers_pay', 'Record supplier payments and returns', 'suppliers', 'pay'),
  ('riders_view', 'View riders and balances', 'riders', 'view'),
  ('riders_manage', 'Create and edit riders', 'riders', 'manage'),
  ('riders_pay', 'Record rider payments and reversals', 'riders', 'pay'),
  ('couriers_view', 'View courier companies', 'couriers', 'view'),
  ('couriers_manage', 'Create and edit courier companies', 'couriers', 'manage'),
  ('deliveries_view', 'View deliveries', 'deliveries', 'view'),
  ('deliveries_manage', 'Update delivery statuses', 'deliveries', 'manage'),
  ('cod_view', 'View COD balances and ageing', 'cod', 'view'),
  ('cod_remit', 'Record and resolve courier remittances', 'cod', 'remit'),
  ('inventory_view', 'View stock balances and movements', 'inventory', 'view'),
  ('inventory_adjust', 'Adjust inventory quantities', 'inventory', 'adjust'),
  ('receipts_view', 'View and print receipts', 'receipts', 'view'),
  ('expenses_view', 'View expenses', 'expenses', 'view'),
  ('expenses_create', 'Create expenses', 'expenses', 'create'),
  ('expenses_edit', 'Edit expenses', 'expenses', 'edit'),
  ('expenses_delete', 'Delete expenses', 'expenses', 'delete'),
  ('expenses_approve', 'Approve expenses', 'expenses', 'approve'),
  ('reports_view', 'View financial reports', 'reports', 'view'),
  ('reports_export', 'Export financial reports', 'reports', 'export'),
  ('users_view', 'View system users', 'users', 'view'),
  ('users_manage', 'Create users and assign permissions', 'users', 'manage'),
  ('settings_view', 'View business settings', 'settings', 'view'),
  ('settings_edit', 'Edit business settings', 'settings', 'edit')
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  module = EXCLUDED.module,
  action = EXCLUDED.action;

INSERT INTO user_permissions (user_id, permission_id, granted_by, granted_at)
SELECT up.user_id, canonical.id, up.granted_by, up.granted_at
FROM user_permissions up
JOIN permissions legacy ON legacy.id = up.permission_id
JOIN permissions canonical
  ON canonical.module = legacy.module
 AND canonical.action = legacy.action
 AND canonical.name = canonical.module || '_' || canonical.action
WHERE legacy.id <> canonical.id
ON CONFLICT (user_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, canonical.id
FROM role_permissions rp
JOIN permissions legacy ON legacy.id = rp.permission_id
JOIN permissions canonical
  ON canonical.module = legacy.module
 AND canonical.action = legacy.action
 AND canonical.name = canonical.module || '_' || canonical.action
WHERE legacy.id <> canonical.id
ON CONFLICT (role_id, permission_id) DO NOTHING;

DELETE FROM permissions legacy
USING permissions canonical
WHERE legacy.id <> canonical.id
  AND legacy.module = canonical.module
  AND legacy.action = canonical.action
  AND canonical.name = canonical.module || '_' || canonical.action;

INSERT INTO user_permissions (user_id, permission_id, granted_by)
SELECT u.id, p.id, admin_user.id
FROM users u
JOIN permissions p ON
  (p.module = 'dashboard' AND p.action = 'view') OR
  (p.module = 'orders' AND p.action IN ('view', 'create', 'status')) OR
  (p.module = 'customers' AND p.action IN ('view', 'create', 'edit')) OR
  (p.module IN ('products', 'suppliers', 'riders', 'couriers', 'inventory', 'receipts') AND p.action = 'view') OR
  (p.module = 'deliveries' AND p.action IN ('view', 'manage')) OR
  (p.module = 'cod' AND p.action IN ('view', 'remit'))
LEFT JOIN LATERAL (
  SELECT id FROM users WHERE role IN ('admin', 'owner') ORDER BY created_at LIMIT 1
) admin_user ON true
WHERE u.role = 'attendant'
ON CONFLICT (user_id, permission_id) DO NOTHING;
