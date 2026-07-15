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
  
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={hasPermission('dashboard.view') ? <Dashboard /> : <Navigate to="/orders" replace />} />
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
      </Routes>
    </Layout>
  )
}

export default App
