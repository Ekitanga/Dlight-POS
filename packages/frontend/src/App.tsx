import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import { Login } from './pages/auth/Login'
import { Dashboard } from './pages/dashboard/Dashboard'
import { Layout } from './components/Layout'
import { Products } from './pages/products/Products'
import { Orders } from './pages/orders/Orders'
import { Customers } from './pages/customers/Customers'
import { Suppliers } from './pages/suppliers/Suppliers'
import { Riders } from './pages/riders/Riders'
import { Expenses } from './pages/expenses/Expenses'
import { Settings } from './pages/settings/Settings'
import { Deliveries } from './pages/deliveries/Deliveries'
import { Inventory } from './pages/inventory/Inventory'
import { Users } from './pages/users/Users'
import { Receipts } from './pages/receipts/Receipts'
import { Couriers } from './pages/couriers/Couriers'
import { Reports } from './pages/reports/Reports'
import { AuditLogs } from './pages/audit/AuditLogs'
import { Notifications } from './pages/notifications/Notifications'
import { Commissions } from './pages/commissions/Commissions'

const dashboardAccessPermissions = [
  'dashboard.view',
  'dashboard.personal_sales', 'dashboard.personal_orders', 'dashboard.pending_speedaf',
  'dashboard.management_sales', 'dashboard.management_profit', 'dashboard.management_expenses',
  'dashboard.management_suppliers', 'dashboard.management_riders', 'dashboard.management_inventory',
  'dashboard.management_reports', 'dashboard.management_audit'
]

function App() {
  const { user, hasPermission } = useAuthStore()
  
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }
  
  const isAdminOrOwner = user.role === 'admin' || user.role === 'owner'
  const canAccessDashboard = dashboardAccessPermissions.some(hasPermission)
  
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={canAccessDashboard ? <Dashboard /> : <Navigate to="/orders" replace />} />
        <Route path="/pos" element={<Navigate to="/orders" replace />} />
        <Route path="/products" element={hasPermission('products.view') ? <Products /> : <Navigate to="/orders" replace />} />
        <Route path="/orders" element={hasPermission('orders.view') ? <Orders /> : <div className="p-8">Access denied</div>} />
        <Route path="/customers" element={hasPermission('customers.view') ? <Customers /> : <Navigate to="/orders" replace />} />
        <Route path="/suppliers" element={hasPermission('suppliers.view') ? <Suppliers /> : <Navigate to="/orders" replace />} />
        <Route path="/riders" element={hasPermission('riders.view') ? <Riders /> : <Navigate to="/orders" replace />} />
        <Route path="/couriers" element={hasPermission('couriers.view') ? <Couriers /> : <Navigate to="/orders" replace />} />
        <Route path="/expenses" element={hasPermission('expenses.view') ? <Expenses /> : <Navigate to="/orders" replace />} />
        <Route path="/deliveries" element={hasPermission('deliveries.view') ? <Deliveries /> : <Navigate to="/orders" replace />} />
        <Route path="/inventory" element={hasPermission('inventory.view') ? <Inventory /> : <Navigate to="/orders" replace />} />
        <Route path="/receipts" element={hasPermission('receipts.view') ? <Receipts /> : <Navigate to="/orders" replace />} />
        <Route path="/users" element={hasPermission('users.view') ? <Users /> : <Navigate to="/orders" replace />} />
        <Route path="/settings" element={hasPermission('settings.view') ? <Settings /> : <Navigate to="/orders" replace />} />
        <Route path="/reports" element={hasPermission('reports.view') ? <Reports /> : <Navigate to="/orders" replace />} />
        <Route path="/audit" element={hasPermission('audit.view') ? <AuditLogs /> : <Navigate to="/orders" replace />} />
        <Route path="/notifications" element={isAdminOrOwner ? <Notifications /> : <Navigate to="/orders" replace />} />
        <Route path="/commissions" element={
          hasPermission('commission.view') || hasPermission('commission.own_view') || hasPermission('commission.own_daily') ||
          hasPermission('commission.own_monthly') || hasPermission('commission.own_history') || hasPermission('commission.own_transactions') || hasPermission('commission.own_potential') || hasPermission('commission.manage') ||
          hasPermission('commission.approve') || hasPermission('commission.pay') || hasPermission('commission.adjust') || hasPermission('commission.reconcile') || hasPermission('commission.close')
            ? <Commissions /> : <Navigate to="/orders" replace />
        } />
      </Routes>
    </Layout>
  )
}

export default App
