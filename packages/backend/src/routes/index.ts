import { Router } from 'express'
import { authRoutes } from './auth'
import { productRoutes } from './products'
import { orderRoutes } from './orders'
import { customerRoutes } from './customers'
import { supplierRoutes } from './suppliers'
import { riderRoutes } from './riders'
import { courierRoutes } from './couriers'
import { expenseRoutes } from './expenses'
import { dashboardRoutes } from './dashboard'
import { settingsRoutes } from './settings'
import { deliveryRoutes } from './deliveries'
import { receiptRoutes } from './receipts'
import { userRoutes } from './users'
import { inventoryRoutes } from './inventory'
import { reportRoutes } from './reports'
import { auditRoutes } from './audit'
import { authMiddleware, requireAdmin, requireModulePermission } from '../middleware/auth'

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
