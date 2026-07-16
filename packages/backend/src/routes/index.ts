import { Router } from 'express'
import { authRoutes } from './auth.js'
import { productRoutes } from './products.js'
import { orderRoutes } from './orders.js'
import { customerRoutes } from './customers.js'
import { supplierRoutes } from './suppliers.js'
import { riderRoutes } from './riders.js'
import { courierRoutes } from './couriers.js'
import { expenseRoutes } from './expenses.js'
import { dashboardRoutes } from './dashboard.js'
import { settingsRoutes } from './settings.js'
import { deliveryRoutes } from './deliveries.js'
import { receiptRoutes } from './receipts.js'
import { userRoutes } from './users.js'
import { inventoryRoutes } from './inventory.js'
import { reportRoutes } from './reports.js'
import { auditRoutes } from './audit.js'
import { authMiddleware, requireAdmin, requireModulePermission } from '../middleware/auth.js'

const router = Router()

router.use('/auth', authRoutes)
router.use('/products', authMiddleware, requireModulePermission('products'), productRoutes)
router.use('/orders', authMiddleware, requireModulePermission('orders'), orderRoutes)
router.use('/customers', authMiddleware, requireModulePermission('customers'), customerRoutes)
router.use('/suppliers', authMiddleware, requireModulePermission('suppliers'), supplierRoutes)
router.use('/riders', authMiddleware, requireModulePermission('riders'), riderRoutes)
router.use('/couriers', authMiddleware, requireModulePermission('couriers'), courierRoutes)
router.use('/expenses', authMiddleware, requireModulePermission('expenses'), expenseRoutes)
router.use('/dashboard', authMiddleware, requireModulePermission('dashboard'), dashboardRoutes)
router.use('/settings', authMiddleware, requireAdmin, requireModulePermission('settings'), settingsRoutes)
router.use('/deliveries', authMiddleware, requireModulePermission('deliveries'), deliveryRoutes)
router.use('/reports', authMiddleware, requireModulePermission('reports'), reportRoutes)
router.use('/receipts', authMiddleware, requireModulePermission('receipts'), receiptRoutes)
router.use('/users', authMiddleware, requireAdmin, requireModulePermission('users'), userRoutes)
router.use('/inventory', authMiddleware, requireModulePermission('inventory'), inventoryRoutes)
router.use('/audit', authMiddleware, requireModulePermission('audit'), auditRoutes)

export { router as apiRouter }
