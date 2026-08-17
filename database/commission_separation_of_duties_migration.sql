-- A salesperson must not independently verify Speedaf remittance for a sale
-- they created. Remove the high-risk remittance capability from attendant
-- defaults; an explicit grant still remains subject to the backend own-order
-- separation-of-duties check.

DELETE FROM user_permissions up
USING users account, permissions permission
WHERE up.user_id = account.id
  AND up.permission_id = permission.id
  AND account.role = 'attendant'
  AND permission.module = 'cod'
  AND permission.action = 'remit';
