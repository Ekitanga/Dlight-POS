INSERT INTO permissions (name, description, module, action) VALUES
  ('orders_status', 'Update order workflow statuses', 'orders', 'status'),
  ('orders_edit', 'Edit open order details', 'orders', 'edit')
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  module = EXCLUDED.module,
  action = EXCLUDED.action;

DELETE FROM user_permissions up
USING users u, permissions p
WHERE up.user_id = u.id
  AND up.permission_id = p.id
  AND u.role = 'attendant'
  AND p.module = 'orders'
  AND p.action = 'edit';

INSERT INTO user_permissions (user_id, permission_id, granted_by)
SELECT u.id, p.id, admin_user.id
FROM users u
JOIN permissions p ON p.module = 'orders' AND p.action = 'status'
LEFT JOIN LATERAL (
  SELECT id FROM users WHERE role IN ('admin', 'owner') ORDER BY created_at LIMIT 1
) admin_user ON true
WHERE u.role = 'attendant'
ON CONFLICT (user_id, permission_id) DO NOTHING;
