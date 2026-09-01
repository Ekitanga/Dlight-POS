import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { Pool } from 'pg'

const sourceUrl = new URL(process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/dlight_pos')
const testDatabase = `dlight_pos_phase6_${process.pid}`
const adminUrl = new URL(sourceUrl)
adminUrl.pathname = '/postgres'
const testUrl = new URL(sourceUrl)
testUrl.pathname = `/${testDatabase}`

const adminPool = new Pool({ connectionString: adminUrl.toString() })
await adminPool.query(`DROP DATABASE IF EXISTS ${testDatabase} WITH (FORCE)`)
await adminPool.query(`CREATE DATABASE ${testDatabase}`)
const db = new Pool({ connectionString: testUrl.toString() })

const root = path.resolve(process.cwd(), '../..')
for (const file of [
  'database/schema.sql',
  'database/trial_balance_migration.sql',
  'database/admin_order_status_correction_migration.sql',
  'database/production_stabilization_phase1.sql',
  'database/permissions_migration.sql',
  'database/production_stabilization_permissions.sql',
  'database/commission_module_settings_migration.sql',
  'database/commission_tables_migration.sql',
  'database/commission_permissions_migration.sql',
  'database/commission_hardening_migration.sql',
  'database/commission_dashboard_permission_fix.sql',
  'database/commission_accuracy_migration.sql',
  'database/commission_return_accuracy_migration.sql',
  'database/commission_separation_of_duties_migration.sql',
  'database/commission_category_snapshot_provenance_migration.sql',
  'database/commission_period_closure_migration.sql',
  'database/commission_operational_hardening_migration.sql',
  'database/commission_business_policy_migration.sql',
  'database/commission_initial_activation_fix_migration.sql',
  'database/commission_month_end_usability_migration.sql',
  'database/speedaf_immediate_reconciliation_migration.sql'
]) {
  const sql = await fs.readFile(path.join(root, file), 'utf8')
  // schema.sql uses psql's relative include for production/fresh installs.
  // The pg driver does not understand psql meta-commands, and the included
  // migration is executed explicitly above in this test bootstrap.
  await db.query(file === 'database/schema.sql' ? sql.replace(/^\\ir .*$/gm, '') : sql)
}

const password = 'Phase6-Test-Password!'
const passwordHash = await bcrypt.hash(password, 4)
const users = await db.query(
  `INSERT INTO users (email, password_hash, full_name, role, commission_eligible) VALUES
   ('admin.phase6@dlight.test', $1, 'Phase 6 Admin', 'admin', FALSE),
   ('owner.phase6@dlight.test', $1, 'Phase 6 Owner', 'owner', FALSE),
   ('attendant.phase6@dlight.test', $1, 'Phase 6 Attendant', 'attendant', TRUE)
   RETURNING id, email, role`,
  [passwordHash]
)
const adminUser = users.rows.find(row => row.role === 'admin')
const attendantUser = users.rows.find(row => row.role === 'attendant')

await db.query(
  `INSERT INTO user_permissions (user_id, permission_id, granted_by)
   SELECT $1, p.id, $2 FROM permissions p
   WHERE (p.module = 'orders' AND p.action IN ('view', 'create'))
      OR (p.module = 'customers' AND p.action IN ('view', 'create'))
      OR (p.module IN ('products', 'suppliers', 'riders', 'couriers', 'inventory', 'receipts') AND p.action = 'view')
      OR (p.module = 'deliveries' AND p.action IN ('view', 'manage'))
      OR (p.module = 'cod' AND p.action IN ('view', 'remit'))`,
  [attendantUser.id, adminUser.id]
)
await db.query(
  `INSERT INTO settings (company_name, currency, tax_rate, order_prefix)
   VALUES ('Dlight Phase 6', 'KES', 0, 'TST')`
)
await db.query(
  `INSERT INTO commission_programmes (status, effective_from, created_by)
   VALUES ('active', (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')::date, $1)`,
  [adminUser.id]
)
await db.query(
  `INSERT INTO commission_rates (programme_id, rate_per_item, effective_from, scope_type, created_by)
   SELECT id, 50, (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')::date, 'global', $1
   FROM commission_programmes
   WHERE status = 'active'
   ORDER BY effective_from DESC, created_at DESC, id DESC
   LIMIT 1`,
  [adminUser.id]
)

const supplier = (await db.query(
  `INSERT INTO suppliers (name, phone) VALUES ('Phase 6 Supplier', '0700000001') RETURNING *`
)).rows[0]
const rider = (await db.query(
  `INSERT INTO riders (name, phone) VALUES ('Phase 6 Rider', '0700000002') RETURNING *`
)).rows[0]
const courier = (await db.query(
  `INSERT INTO couriers (name, tracking_prefix) VALUES ('Speedaf', 'SPD-P6') RETURNING *`
)).rows[0]
const stockProduct = (await db.query(
  `INSERT INTO products (sku, name, cost_price, selling_price, reorder_level)
   VALUES ('P6-STOCK', 'Phase 6 Stock Product', 40, 100, 5) RETURNING *`
)).rows[0]
const secondStockProduct = (await db.query(
  `INSERT INTO products (sku, name, cost_price, selling_price, reorder_level)
   VALUES ('P6-STOCK-2', 'Phase 6 Second Stock Product', 100, 300, 5) RETURNING *`
)).rows[0]
const supplierProduct = (await db.query(
  `INSERT INTO products (sku, name, cost_price, selling_price, is_dropship)
   VALUES ('P6-DROP', 'Phase 6 Supplier Product', 0, 500, true) RETURNING *`
)).rows[0]
await db.query(
  `INSERT INTO inventory (product_id, quantity) VALUES ($1, 100), ($2, 100), ($3, 2)`,
  [stockProduct.id, secondStockProduct.id, supplierProduct.id]
)

process.env.DATABASE_URL = testUrl.toString()
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'phase6-access-secret-that-is-long-and-safe'
process.env.JWT_REFRESH_SECRET = 'phase6-refresh-secret-that-is-long-and-safe'
const { default: app } = await import('./index.js')
const { pool: appPool } = await import('./db/pool.js')
const { evaluateOrderItemFromRecords } = await import('./services/commission.js')
const { isSpeedafDeliveredCollectedEvent, syncSpeedafTracking } = await import('./services/speedafTracking.js')
const server = app.listen(0)
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Unable to start Phase 6 API')
const baseUrl = `http://127.0.0.1:${address.port}/api`

async function request(
  method: string,
  route: string,
  token?: string,
  body?: Record<string, unknown>,
  expectedStatus = 200
) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  assert.equal(response.status, expectedStatus, `${method} ${route}: ${text}`)
  return data
}

async function login(email: string) {
  return request('POST', '/auth/login', undefined, { email, password }, 200)
}

const admin = await login('admin.phase6@dlight.test')
const owner = await login('owner.phase6@dlight.test')
const attendant = await login('attendant.phase6@dlight.test')

let customerCounter = 0
function customer(prefix: string) {
  customerCounter += 1
  return {
    customer_name: `${prefix} Customer`,
    customer_phone: `0712${String(340000 + customerCounter).padStart(6, '0')}`,
    customer_address: 'Nairobi'
  }
}

function isoDate(value = new Date()) {
  return value.toISOString().split('T')[0]
}

function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return isoDate(next)
}

function daysInUtcMonth(date: string) {
  const [year, month] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

function internalItem(productId = stockProduct.id, quantity = 1, sellingPrice = 100) {
  return { product_id: productId, quantity, selling_price: sellingPrice, fulfillment_source: 'shop_stock' }
}

function supplierItem(quantity = 1, sellingPrice = 500, supplierCost = 300, productId = supplierProduct.id) {
  return {
    product_id: productId,
    quantity,
    selling_price: sellingPrice,
    fulfillment_source: 'supplier_fulfilled',
    supplier_id: supplier.id,
    supplier_cost: supplierCost
  }
}

async function createOrder(body: Record<string, unknown>, token = admin.accessToken) {
  return request('POST', '/orders', token, body, 201)
}

async function advance(orderId: string, statuses: string[], extra: Record<string, unknown> = {}) {
  let order
  for (const status of statuses) {
    order = await request('PUT', `/orders/${orderId}/status`, admin.accessToken, {
      status,
      ...(status === 'returned' ? { notes: 'Automated test return reason' } : {}),
      ...extra
    })
  }
  return order
}

async function row(sql: string, params: unknown[] = []) {
  return (await db.query(sql, params)).rows[0]
}

async function count(sql: string, params: unknown[] = []) {
  return Number((await row(sql, params)).count)
}

async function waitForAudit(action: string, entityId?: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await db.query(
      `SELECT * FROM audit_logs WHERE action = $1 AND ($2::uuid IS NULL OR entity_id = $2) ORDER BY created_at DESC LIMIT 1`,
      [action, entityId || null]
    )
    if (result.rows[0]) return result.rows[0]
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`Missing audit action ${action}`)
}

async function assertGlobalIntegrity() {
  assert.equal(await count(`SELECT COUNT(*) FROM inventory WHERE quantity < 0 OR reserved_quantity < 0`), 0)
  assert.equal(await count(`SELECT COUNT(*) FROM (SELECT order_id FROM deliveries GROUP BY order_id HAVING COUNT(*) > 1) d`), 0)
  assert.equal(await count(`SELECT COUNT(*) FROM (SELECT order_id FROM cod_collections GROUP BY order_id HAVING COUNT(*) > 1) c`), 0)
  assert.equal(await count(`
    SELECT COUNT(*) FROM suppliers s
    WHERE s.balance <> COALESCE((SELECT SUM(p.amount) FROM supplier_payables p WHERE p.supplier_id=s.id),0)
      - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id=s.id),0)
      - COALESCE((SELECT SUM(r.amount) FROM supplier_returns r WHERE r.supplier_id=s.id),0)
  `), 0)
  assert.equal(await count(`
    SELECT COUNT(*) FROM riders r
    WHERE r.balance <> COALESCE((SELECT SUM(e.amount) FROM rider_earnings e WHERE e.rider_id=r.id AND e.status <> 'reversed'),0)
      - COALESCE((SELECT SUM(p.amount) FROM rider_payments p WHERE p.rider_id=r.id),0)
  `), 0)

  const expected = await row(`
    SELECT COALESCE(SUM(
      subtotal + CASE
        WHEN delivery_type = 'courier'
          AND courier_payment_type = 'cod'
          AND delivery_fee_payment_method IN ('paid_to_courier', 'pay_on_delivery')
        THEN 0
        ELSE delivery_income
      END
    ),0) AS sales, COUNT(*)::int AS orders
    FROM orders WHERE status IN ('delivered','collected_paid')
  `)
  const dashboard = await request(
    'GET',
    '/dashboard/stats?date_from=2000-01-01&date_to=2100-01-01',
    admin.accessToken
  )
  const salesReport = await request('GET', '/reports/sales', admin.accessToken)
  const profit = await request('GET', '/reports/profit', admin.accessToken)
  const overview = await request(
    'GET',
    '/reports/overview?date_from=2000-01-01&date_to=2100-01-01',
    admin.accessToken
  )
  assert.equal(Number(dashboard.periodSales), Number(expected.sales))
  assert.equal(Number(dashboard.periodOrders), Number(expected.orders))
  assert.equal(salesReport.length, Number(expected.orders))
  assert.equal(Number(profit.netProfit), Number(profit.grossProfit) - Number(profit.deliveryCosts) - Number(profit.expenses))
  assert.equal(Number(overview.kpis.revenue), Number(expected.sales))
  assert.equal(Number(overview.kpis.supplier_payables), Number((await row(`
    SELECT COALESCE((SELECT SUM(amount) FROM supplier_payables),0)
      - COALESCE((SELECT SUM(amount) FROM supplier_payments),0)
      - COALESCE((SELECT SUM(amount) FROM supplier_returns),0) AS amount
  `)).amount))
  assert.equal(Number(overview.kpis.rider_payables), Number((await row(`
    SELECT COALESCE((SELECT SUM(amount) FROM rider_earnings WHERE status <> 'reversed'),0)
      - COALESCE((SELECT SUM(amount) FROM rider_payments),0) AS amount
  `)).amount))
  assert.equal(Number(overview.kpis.customer_credit), Number((await row('SELECT COALESCE(SUM(amount),0) AS amount FROM customer_credits')).amount))
  assert.equal(Number(overview.kpis.inventory_value), Number((await row(`
    SELECT COALESCE(SUM(GREATEST(i.quantity-i.reserved_quantity,0)*p.cost_price),0) AS amount
    FROM inventory i JOIN products p ON p.id=i.product_id
    WHERE p.deleted_at IS NULL AND p.is_active=TRUE
  `)).amount))
}

await test('Phase 6 order-first ERP scenarios', { concurrency: false }, async t => {
  await t.test('catalog import and flexible per-order fulfillment', async () => {
    const importedName = 'Website Perfume Without SKU'
    const firstImport = await request('POST', '/products/import', admin.accessToken, {
      default_category: 'Perfumes',
      duplicate_mode: 'update',
      rows: [{ name: importedName, sku: '', cost_price: '2500', selling_price: '6000' }]
    })
    assert.equal(firstImport.created, 1)
    const imported = await row(
      `SELECT p.*, c.name AS category_name, i.quantity
       FROM products p JOIN categories c ON c.id=p.category_id
       JOIN inventory i ON i.product_id=p.id WHERE p.name=$1`,
      [importedName]
    )
    assert.match(imported.sku, /^PERF-[A-F0-9]{8}$/)
    assert.equal(imported.category_name, 'Perfumes')
    assert.equal(Number(imported.quantity), 0)

    const secondImport = await request('POST', '/products/import', admin.accessToken, {
      default_category: 'Perfumes',
      duplicate_mode: 'update',
      rows: [{ name: importedName, sku: '', cost_price: '2500', selling_price: '6500' }]
    })
    assert.equal(secondImport.updated, 1)
    assert.equal(await count('SELECT COUNT(*) FROM products WHERE LOWER(name)=LOWER($1)', [importedName]), 1)
    assert.equal(Number((await row('SELECT selling_price FROM products WHERE name=$1', [importedName])).selling_price), 6500)

    const manualProduct = await request('POST', '/products', admin.accessToken, {
      name: 'Manually Added Perfume',
      sku: '',
      category_id: imported.category_id,
      cost_price: 1000,
      selling_price: 2000,
      reorder_level: 0,
      is_dropship: false
    }, 201)
    assert.match(manualProduct.sku, /^PERF-[A-F0-9]{8}$/)
    assert.equal(await count('SELECT COUNT(*) FROM inventory WHERE product_id=$1 AND quantity=0', [manualProduct.id]), 1)
    const editedProduct = await request('PUT', `/products/${manualProduct.id}`, admin.accessToken, {
      name: 'Manually Added Perfume - Updated',
      sku: manualProduct.sku,
      barcode: 'EDIT-PRODUCT-001',
      category_id: imported.category_id,
      cost_price: 1200,
      selling_price: 2400,
      reorder_level: 2,
      is_dropship: true
    })
    assert.equal(editedProduct.name, 'Manually Added Perfume - Updated')
    assert.equal(Number(editedProduct.selling_price), 2400)
    assert.equal(editedProduct.is_dropship, true)
    assert.equal((await row('SELECT barcode FROM products WHERE id=$1', [manualProduct.id])).barcode, 'EDIT-PRODUCT-001')
    const productPage = await request('GET', '/products?page=1&page_size=10', admin.accessToken)
    assert.equal(Array.isArray(productPage.data), true)
    assert.equal(productPage.pagination.page, 1)
    assert.equal(productPage.pagination.pageSize, 10)
    assert.ok(productPage.pagination.total >= productPage.data.length)
    for (const reportName of ['inventory', 'supplier-payables', 'rider-earnings', 'cod-outstanding', 'cod-ageing', 'customer-credit']) {
      const reportRows = await request('GET', `/reports/${reportName}`, admin.accessToken)
      assert.equal(Array.isArray(reportRows), true)
    }

    const stockBeforeSupplierOrder = Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity)
    const supplierFromStockedProduct = await createOrder({
      ...customer('Flexible Supplier'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [supplierItem(1, 100, 60, stockProduct.id)]
    })
    await advance(supplierFromStockedProduct.id, ['confirmed', 'delivered'])
    assert.equal(Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity), stockBeforeSupplierOrder)
    assert.equal(await count('SELECT COUNT(*) FROM supplier_payables WHERE order_id=$1 AND amount=60', [supplierFromStockedProduct.id]), 1)

    const supplierPreferredStockBefore = Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [supplierProduct.id])).quantity)
    const stockFromSupplierPreferred = await createOrder({
      ...customer('Flexible Stock'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [internalItem(supplierProduct.id, 1, 500)]
    })
    await advance(stockFromSupplierPreferred.id, ['confirmed', 'delivered'])
    assert.equal(Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [supplierProduct.id])).quantity), supplierPreferredStockBefore - 1)
    await assertGlobalIntegrity()
  })

  await t.test('1. walk-in cash sale', async () => {
    const before = Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity)
    const order = await createOrder({
      ...customer('Walk-in'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [internalItem(stockProduct.id, 2, 100)]
    })
    await advance(order.id, ['confirmed', 'delivered'])
    assert.equal(Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity), before - 2)
    assert.equal(await count(`SELECT COUNT(*) FROM inventory_movements WHERE reference_id=$1 AND type='stock_out' AND quantity=2`, [order.id]), 1)
    assert.equal(await count('SELECT COUNT(*) FROM deliveries WHERE order_id=$1', [order.id]), 0)
    assert.equal((await row('SELECT payment_status FROM orders WHERE id=$1', [order.id])).payment_status, 'paid')
    assert.equal(await count('SELECT COUNT(*) FROM customers WHERE normalized_phone=$1', ['254712340001']), 1)
    await waitForAudit('order_status_changed', order.id)
    await assertGlobalIntegrity()
  })

  await t.test('2. rider delivery with delivery loss', async () => {
    const order = await createOrder({
      ...customer('Rider'), customer_name: '', delivery_type: 'rider', rider_id: rider.id,
      customer_delivery_fee: 400, actual_rider_fee: 500, payment_method: 'pay_on_delivery',
      items: [internalItem(stockProduct.id, 1, 200)]
    })
    assert.equal(order.payment_status, 'pending')
    assert.equal(Number(order.paid_amount), 0)
    assert.equal(await count('SELECT COUNT(*) FROM order_payments WHERE order_id=$1', [order.id]), 0)
    assert.match((await row(
      'SELECT c.name FROM customers c JOIN orders o ON o.customer_id=c.id WHERE o.id=$1',
      [order.id]
    )).name, /^Customer 07\*{4}\d{4}$/)
    assert.equal((await row('SELECT delivery_address FROM orders WHERE id=$1', [order.id])).delivery_address, 'Nairobi')
    const destinationSearch = await request('GET', '/orders?search=Nairobi&page=1&page_size=10', admin.accessToken)
    assert.ok(destinationSearch.data.some((listedOrder: any) => listedOrder.id === order.id))
    await advance(order.id, ['confirmed', 'in_transit', 'delivered'], { completion_payment_method: 'cash' })
    const delivery = await row('SELECT * FROM deliveries WHERE order_id=$1', [order.id])
    assert.equal(Number(delivery.delivery_income) - Number(delivery.delivery_cost), -100)
    assert.equal(await count('SELECT COUNT(*) FROM rider_earnings WHERE order_id=$1 AND amount=500', [order.id]), 1)
    assert.equal(Number((await row('SELECT balance FROM riders WHERE id=$1', [rider.id])).balance), 500)
    const completedOrder = await row('SELECT status, payment_status, paid_amount FROM orders WHERE id=$1', [order.id])
    assert.equal(completedOrder.status, 'delivered')
    assert.equal(completedOrder.payment_status, 'paid')
    assert.equal(Number(completedOrder.paid_amount), 600)
    assert.equal(await count("SELECT COUNT(*) FROM order_payments WHERE order_id=$1 AND payment_method='cash' AND amount=600", [order.id]), 1)
    await assertGlobalIntegrity()
  })

  await t.test('3. supplier-fulfilled order', async () => {
    const stockBefore = await count('SELECT COUNT(*) FROM inventory_movements WHERE product_id=$1', [supplierProduct.id])
    const order = await createOrder({
      ...customer('Supplier'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [supplierItem(2, 500, 300)]
    })
    await advance(order.id, ['confirmed', 'delivered'])
    const payable = await row('SELECT * FROM supplier_payables WHERE order_id=$1', [order.id])
    assert.equal(Number(payable.amount), 600)
    assert.equal(await count('SELECT COUNT(*) FROM inventory_movements WHERE product_id=$1', [supplierProduct.id]), stockBefore)
    assert.equal(await count('SELECT COUNT(*) FROM order_items WHERE order_id=$1 AND supplier_quantity=2 AND internal_quantity=0', [order.id]), 1)
    await assertGlobalIntegrity()
  })

  await t.test('4. mixed internal and supplier fulfillment', async () => {
    const before = Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity)
    const order = await createOrder({
      ...customer('Mixed'), delivery_type: 'walk_in', payment_method: 'mpesa',
      items: [internalItem(stockProduct.id, 1, 150), supplierItem(1, 500, 300)]
    })
    await advance(order.id, ['confirmed', 'delivered'])
    assert.equal(Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity), before - 1)
    assert.equal(await count('SELECT COUNT(*) FROM order_items WHERE order_id=$1', [order.id]), 2)
    assert.equal(Number((await row('SELECT amount FROM supplier_payables WHERE order_id=$1', [order.id])).amount), 300)
    await assertGlobalIntegrity()
  })

  await t.test('4a. only management can move an active order backward with dependent reversals', async () => {
    const stockBefore = Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity)
    const riderBalanceBefore = Number((await row('SELECT balance FROM riders WHERE id=$1', [rider.id])).balance)
    const order = await createOrder({
      ...customer('Backward Correction'), delivery_type: 'rider', rider_id: rider.id,
      customer_delivery_fee: 100, actual_rider_fee: 120, payment_method: 'pay_on_delivery',
      items: [internalItem(stockProduct.id, 2, 100)]
    }, attendant.accessToken)
    await advance(order.id, ['confirmed', 'in_transit', 'delivered'], { completion_payment_method: 'mpesa' })

    assert.equal(await count("SELECT COUNT(*) FROM rider_earnings WHERE order_id=$1 AND status='payable'", [order.id]), 1)
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned' AND transaction_status<>'reversed'", [order.id]), 1)
    assert.equal(Number((await row('SELECT balance FROM riders WHERE id=$1', [rider.id])).balance), riderBalanceBefore + 120)

    await request('GET', `/orders/${order.id}/status-correction`, attendant.accessToken, undefined, 403)
    const preview = await request('GET', `/orders/${order.id}/status-correction`, admin.accessToken)
    assert.deepEqual(preview.allowed_targets, ['in_transit', 'confirmed', 'pending'])
    assert.deepEqual(preview.blockers, [])
    assert.equal(preview.completion_payment.reversible, true)
    assert.equal(Number(preview.completion_payment.amount), 300)
    assert.ok(preview.effects.some((effect: string) => effect.includes('completion-generated payment')))
    await request('POST', `/orders/${order.id}/status-correction`, admin.accessToken, {
      target_status: 'in_transit', reason: 'short'
    }, 400)

    const corrected = await request('POST', `/orders/${order.id}/status-correction`, admin.accessToken, {
      target_status: 'in_transit',
      reason: 'Sales agent marked the rider order delivered before physical delivery',
      reverse_completion_payment: true
    })
    assert.equal(corrected.order.status, 'in_transit')
    assert.equal(corrected.order.payment_status, 'pending')
    assert.equal(Number(corrected.order.paid_amount), 0)
    assert.equal((await row('SELECT delivery_status FROM deliveries WHERE order_id=$1', [order.id])).delivery_status, 'in_transit')
    assert.equal((await row('SELECT delivered_at FROM deliveries WHERE order_id=$1', [order.id])).delivered_at, null)
    assert.equal(await count("SELECT COUNT(*) FROM rider_earnings WHERE order_id=$1 AND status='reversed'", [order.id]), 1)
    assert.equal(Number((await row('SELECT balance FROM riders WHERE id=$1', [rider.id])).balance), riderBalanceBefore)
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='reversal'", [order.id]), 1)
    assert.equal(Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity), stockBefore - 2)
    assert.equal(await count('SELECT COUNT(*) FROM order_payments WHERE order_id=$1', [order.id]), 0)
    await waitForAudit('order_status_corrected_backward', order.id)

    await advance(order.id, ['delivered'], { completion_payment_method: 'cash' })
    assert.equal(await count("SELECT COUNT(*) FROM rider_earnings WHERE order_id=$1 AND status='payable'", [order.id]), 1)
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned' AND transaction_status<>'reversed'", [order.id]), 1)
    assert.equal(await count('SELECT COUNT(*) FROM order_payments WHERE order_id=$1', [order.id]), 1)
    assert.equal(Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity), stockBefore - 2)

    const activeRiderEarning = await row("SELECT id FROM rider_earnings WHERE order_id=$1 AND status='payable'", [order.id])
    await db.query("UPDATE rider_earnings SET status='paid' WHERE id=$1", [activeRiderEarning.id])
    const paidEarningPreview = await request('GET', `/orders/${order.id}/status-correction`, admin.accessToken)
    assert.ok(paidEarningPreview.blockers.some((blocker: string) => blocker.includes('rider earning')))
    await request('POST', `/orders/${order.id}/status-correction`, admin.accessToken, {
      target_status: 'in_transit',
      reason: 'Paid rider earning must block an unsafe backward status correction'
    }, 409)
    await db.query("UPDATE rider_earnings SET status='payable' WHERE id=$1", [activeRiderEarning.id])

    // Leave shared rider balances at their pre-scenario baseline for the
    // settlement scenario below while also proving a repeated correction is
    // deterministic.
    await request('POST', `/orders/${order.id}/status-correction`, admin.accessToken, {
      target_status: 'in_transit',
      reason: 'Test cleanup repeats the reviewed backward correction deterministically',
      reverse_completion_payment: true
    })
    assert.equal(Number((await row('SELECT balance FROM riders WHERE id=$1', [rider.id])).balance), riderBalanceBefore)
    await assertGlobalIntegrity()
  })

  await t.test('5. Speedaf COD lifecycle and remittance', async () => {
    const order = await createOrder({
      ...customer('COD'), delivery_type: 'courier', courier_id: courier.id,
      courier_tracking_number: 'SPD-P6-COD', courier_payment_type: 'cod',
      customer_delivery_fee: 200, actual_courier_fee: 150, payment_method: 'mpesa',
      items: [internalItem(stockProduct.id, 1, 1000)]
    }, attendant.accessToken)
    assert.equal(order.payment_status, 'partially_paid')
    assert.equal(Number(order.paid_amount), 200)
    assert.equal(order.delivery_fee_payment_method, 'mpesa')
    assert.equal(Number(order.delivery_fee_paid_amount), 200)
    assert.equal(await count('SELECT COUNT(*) FROM order_payments WHERE order_id=$1 AND amount=200 AND payment_method=$2', [order.id, 'mpesa']), 1)
    assert.equal(await count('SELECT COUNT(*) FROM cod_collections WHERE order_id=$1 AND cod_amount=1000', [order.id]), 1)
    await advance(order.id, ['confirmed', 'in_transit', 'delivered'])
    assert.equal((await row('SELECT status FROM cod_collections WHERE order_id=$1', [order.id])).status, 'delivered_awaiting_remittance')
    assert.equal((await row('SELECT commission_completion_at FROM orders WHERE id=$1', [order.id])).commission_completion_at, null)
    const dashboardBefore = await request('GET', '/dashboard/stats', admin.accessToken)
    assert.ok(Number(dashboardBefore.outstandingCOD) >= 1000)
    await request('POST', `/deliveries/orders/${order.id}/cod`, admin.accessToken, {
      amount: 400, reference: 'SPD-P6-REM-001', payment_method: 'mpesa'
    }, 201)
    const partiallyPaid = await row('SELECT status,payment_status,paid_amount FROM orders WHERE id=$1', [order.id])
    assert.equal(partiallyPaid.status, 'delivered')
    assert.equal(partiallyPaid.payment_status, 'partially_paid')
    assert.equal(Number(partiallyPaid.paid_amount), 600)
    assert.equal((await row('SELECT status FROM cod_collections WHERE order_id=$1', [order.id])).status, 'partially_remitted')
    await request('POST', `/deliveries/orders/${order.id}/cod`, admin.accessToken, {
      amount: 600, reference: 'SPD-P6-REM-002', payment_method: 'bank_transfer'
    }, 201)
    const completed = await row('SELECT status,payment_status,paid_amount FROM orders WHERE id=$1', [order.id])
    assert.equal(completed.status, 'collected_paid')
    assert.equal(completed.payment_status, 'paid')
    assert.equal(Number(completed.paid_amount), 1200)
    const finalCompletion = await row(
      `SELECT o.commission_completion_at, cc.closed_at, cc.remitted_at
       FROM orders o JOIN cod_collections cc ON cc.order_id = o.id
       WHERE o.id = $1`,
      [order.id]
    )
    assert.ok(finalCompletion.commission_completion_at)
    assert.equal(new Date(finalCompletion.commission_completion_at).getTime(), new Date(finalCompletion.closed_at).getTime())
    assert.equal(await count(
      `SELECT COUNT(*) FROM audit_logs
       WHERE entity_type='order' AND entity_id=$1 AND action='order_status_changed'
         AND old_values->>'status'='delivered' AND new_values->>'status'='collected_paid'`,
      [order.id]
    ), 1)
    assert.equal(await count('SELECT COUNT(*) FROM cod_remittances WHERE order_id=$1', [order.id]), 2)
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'", [order.id]), 1)
    const remittedPreview = await request('GET', `/orders/${order.id}/status-correction`, admin.accessToken)
    assert.deepEqual(remittedPreview.allowed_targets, [])
    assert.ok(remittedPreview.blockers.some((blocker: string) => blocker.includes('COD remittance')))
    await request('POST', `/orders/${order.id}/status-correction`, admin.accessToken, {
      target_status: 'in_transit',
      reason: 'A remitted Speedaf order must use the remittance reversal workflow'
    }, 409)
    await waitForAudit('cod_remittance_recorded', order.id)
    await assertGlobalIntegrity()
  })

  await t.test('5ab. admin rebuilds a collected Speedaf COD order into a prepaid courier order', async () => {
    const order = await createOrder({
      ...customer('Prepaid Fix'), delivery_type: 'courier', courier_id: courier.id,
      courier_tracking_number: 'SPD-P6-FIX', courier_payment_type: 'cod',
      customer_delivery_fee: 200, actual_courier_fee: 150, payment_method: 'mpesa',
      items: [internalItem(stockProduct.id, 1, 1000)]
    }, attendant.accessToken)
    await advance(order.id, ['confirmed', 'in_transit', 'delivered'])
    await request('POST', `/deliveries/orders/${order.id}/cod`, admin.accessToken, {
      amount: 1000, reference: 'SPD-P6-FIX-REM', payment_method: 'bank_transfer'
    }, 201)
    const before = await row('SELECT status, payment_status, paid_amount FROM orders WHERE id=$1', [order.id])
    assert.equal(before.status, 'collected_paid')
    assert.equal(await count('SELECT COUNT(*) FROM cod_collections WHERE order_id=$1 AND status=$2', [order.id, 'remitted']), 1)
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned' AND transaction_status<>'reversed'", [order.id]), 1)

    const fixed = await request('PUT', `/orders/${order.id}`, admin.accessToken, {
      ...customer('Prepaid Fix'), delivery_type: 'courier', courier_id: courier.id,
      courier_tracking_number: 'SPD-P6-FIX', courier_payment_type: 'prepaid',
      customer_delivery_fee: 200, actual_courier_fee: 150, payment_method: 'mpesa',
      items: [internalItem(stockProduct.id, 1, 1000)]
    })
    assert.equal(fixed.id, order.id)
    assert.equal(fixed.delivery_type, 'courier')
    assert.equal(fixed.courier_payment_type, 'prepaid')
    assert.equal(await count('SELECT COUNT(*) FROM cod_collections WHERE order_id=$1', [order.id]), 0)
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned' AND transaction_status<>'reversed'", [order.id]), 0)
    assert.equal(await count('SELECT COUNT(*) FROM cod_remittances WHERE order_id=$1', [order.id]), 0)
    await waitForAudit('order_updated', order.id)
    await assertGlobalIntegrity()
  })

  await t.test('5a. Speedaf tracking moves a collected parcel to pending payment only', async () => {
    assert.equal(isSpeedafDeliveredCollectedEvent('Parcel delivered Collectedand Received'), true)
    assert.equal(isSpeedafDeliveredCollectedEvent('Parcel delivered - Collected and Received'), true)
    assert.equal(isSpeedafDeliveredCollectedEvent('  PARCEL   DELIVERED: collected AND\tRECEIVED  '), true)
    assert.equal(isSpeedafDeliveredCollectedEvent('Parcel delivered'), false)

    const order = await createOrder({
      ...customer('Auto Tracking'), delivery_type: 'courier', courier_id: courier.id,
      courier_tracking_number: 'SPD-P6-AUTO', courier_payment_type: 'cod',
      delivery_fee_payment_method: 'pay_on_delivery', payment_method: 'pay_on_delivery',
      items: [internalItem(stockProduct.id, 1, 800)]
    }, attendant.accessToken)
    await advance(order.id, ['confirmed', 'in_transit'])

    const provider = async () => [{
      tracking_number: 'SPD-P6-AUTO',
      status: 'delivered',
      shipment: {
        status: 'delivered',
        states: [{
          state: 'Parcel delivered Collectedand Received by courier; Collection site is Nairobi.',
          date: '2026-08-18T10:00:00.000Z',
          location: 'Nairobi'
        }]
      }
    }]
    const synced = await syncSpeedafTracking({ orderId: order.id, source: 'manual', userId: adminUser.id, provider })
    assert.equal(synced.movedToPendingPayment, 1)

    const updated = await row(
      `SELECT status, payment_status, paid_amount, commission_completion_at FROM orders WHERE id=$1`,
      [order.id]
    )
    assert.equal(updated.status, 'delivered')
    assert.notEqual(updated.payment_status, 'paid')
    assert.equal(Number(updated.paid_amount), 0)
    assert.equal(updated.commission_completion_at, null)
    assert.equal((await row('SELECT status FROM cod_collections WHERE order_id=$1', [order.id])).status, 'delivered_awaiting_remittance')
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'", [order.id]), 0)
    assert.equal(await count("SELECT COUNT(*) FROM courier_tracking_events WHERE order_id=$1 AND triggered_transition", [order.id]), 1)
    assert.equal(await count("SELECT COUNT(*) FROM audit_logs WHERE entity_id=$1 AND action='speedaf_tracking_auto_delivered'", [order.id]), 1)

    const repeated = await syncSpeedafTracking({ orderId: order.id, source: 'manual', userId: adminUser.id, provider })
    assert.equal(repeated.movedToPendingPayment, 0)
    assert.equal(await count("SELECT COUNT(*) FROM courier_tracking_events WHERE order_id=$1", [order.id]), 1)
    assert.equal(await count("SELECT COUNT(*) FROM audit_logs WHERE entity_id=$1 AND action='speedaf_tracking_auto_delivered'", [order.id]), 1)
  })

  await t.test('5aa. attendant records a multi-order Speedaf payment and management can revert it', async () => {
    const first = await createOrder({
      ...customer('Bulk COD One'), delivery_type: 'courier', courier_id: courier.id,
      courier_tracking_number: 'SPD-P6-BULK-1', courier_payment_type: 'cod',
      delivery_fee_payment_method: 'pay_on_delivery', payment_method: 'pay_on_delivery',
      items: [internalItem(stockProduct.id, 1, 600)]
    }, attendant.accessToken)
    const second = await createOrder({
      ...customer('Bulk COD Two'), delivery_type: 'courier', courier_id: courier.id,
      courier_tracking_number: 'SPD-P6-BULK-2', courier_payment_type: 'cod',
      delivery_fee_payment_method: 'pay_on_delivery', payment_method: 'pay_on_delivery',
      items: [internalItem(stockProduct.id, 1, 900)]
    }, attendant.accessToken)
    await advance(first.id, ['confirmed', 'in_transit', 'delivered'])
    await advance(second.id, ['confirmed', 'in_transit', 'delivered'])

    await request('POST', '/deliveries/cod/batches', attendant.accessToken, {
      order_ids: [first.id, second.id], net_amount: 1200, payment_date: isoDate(),
      payment_method: 'bank_transfer', notes: 'Selection exceeds the allowed fee tolerance'
    }, 400)
    assert.equal(await count(
      `SELECT COUNT(*) FROM speedaf_remittance_batches
       WHERE notes='Selection exceeds the allowed fee tolerance'`
    ), 0)

    const submitted = await request('POST', '/deliveries/cod/batches', attendant.accessToken, {
      order_ids: [first.id, second.id], net_amount: 1446, payment_date: isoDate(),
      payment_method: 'bank_transfer', notes: 'Phase 6 bulk Speedaf test'
    }, 201)
    assert.equal(submitted.status, 'approved')
    assert.equal(Number(submitted.gross_amount), 1500)
    assert.equal(Number(submitted.fee_amount), 54)
    assert.equal(submitted.completed_orders, 2)
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [first.id])).status, 'collected_paid')
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [second.id])).status, 'collected_paid')
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=ANY($1::uuid[]) AND transaction_type='earned'", [[first.id, second.id]]), 2)
    const fee = await row('SELECT amount,status,category FROM expenses WHERE id=$1', [submitted.fee_expense_id])
    assert.equal(Number(fee.amount), 54)
    assert.equal(fee.status, 'approved')
    assert.equal(fee.category, 'Courier Transaction Fees')

    await request('POST', '/deliveries/cod/batches', attendant.accessToken, {
      order_ids: [first.id], net_amount: 600, payment_date: isoDate(),
      payment_method: 'bank_transfer', notes: 'Duplicate active allocation'
    }, 409)
    assert.equal(await count(
      `SELECT COUNT(*) FROM speedaf_remittance_batches
       WHERE notes='Duplicate active allocation'`
    ), 0)

    assert.equal(await count('SELECT COUNT(*) FROM speedaf_remittance_allocations WHERE batch_id=$1', [submitted.id]), 2)
    assert.equal(await count("SELECT COUNT(*) FROM audit_logs WHERE entity_id=$1 AND action='speedaf_remittance_batch_recorded'", [submitted.id]), 1)

    const paymentHistory = await request('GET', '/deliveries/cod/payment-history', admin.accessToken)
    const recordedBatch = paymentHistory.find((payment: any) => payment.id === submitted.id)
    assert.ok(recordedBatch)
    assert.equal(recordedBatch.source, 'batch')
    assert.equal(recordedBatch.allocations.length, 2)
    assert.equal(recordedBatch.allocations.every((allocation: any) => allocation.tracking_url), true)
    assert.equal(recordedBatch.allocations.every((allocation: any) => allocation.salesperson_name), true)
    assert.equal(recordedBatch.allocations.reduce((sum: number, allocation: any) => sum + Number(allocation.commission_amount), 0), 100)
    assert.equal(paymentHistory.some((payment: any) => payment.source === 'legacy_single'), true)
    await request('GET', '/deliveries/cod/payment-history', attendant.accessToken, undefined, 403)

    await request('POST', `/deliveries/cod/batches/${submitted.id}/revert`, attendant.accessToken, {
      reason: 'Attendant must not be able to revert a payment'
    }, 403)
    const reverted = await request('POST', `/deliveries/cod/batches/${submitted.id}/revert`, admin.accessToken, {
      reason: 'Test payment was captured against the wrong orders'
    }, 200)
    assert.equal(reverted.status, 'reverted')
    assert.equal(reverted.reopened_orders, 2)
    assert.equal(reverted.commissions_reversed, 2)
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [first.id])).status, 'delivered')
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [second.id])).status, 'delivered')
    assert.equal((await row('SELECT status FROM cod_collections WHERE order_id=$1', [first.id])).status, 'delivered_awaiting_remittance')
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=ANY($1::uuid[]) AND transaction_type='reversal'", [[first.id, second.id]]), 2)
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=ANY($1::uuid[]) AND transaction_type='earned' AND transaction_status <> 'reversed'", [[first.id, second.id]]), 0)
    assert.equal(await count("SELECT COUNT(*) FROM order_payments WHERE reference LIKE $1", [`${submitted.batch_number}:%`]), 0)
    assert.equal(await count("SELECT COUNT(*) FROM cod_remittances WHERE reference LIKE $1", [`${submitted.batch_number}:%`]), 0)
    assert.equal((await row('SELECT status FROM expenses WHERE id=$1', [submitted.fee_expense_id])).status, 'rejected')
    assert.equal(await count('SELECT COUNT(*) FROM speedaf_remittance_allocations WHERE batch_id=$1 AND active', [submitted.id]), 0)
    assert.equal(await count("SELECT COUNT(*) FROM audit_logs WHERE entity_id=$1 AND action='speedaf_remittance_batch_reverted'", [submitted.id]), 1)

    const corrected = await request('POST', '/deliveries/cod/batches', attendant.accessToken, {
      order_ids: [first.id, second.id], net_amount: 1446, payment_date: isoDate(),
      payment_method: 'bank_transfer', notes: 'Corrected Phase 6 bulk Speedaf test'
    }, 201)
    assert.equal(corrected.status, 'approved')
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [first.id])).status, 'collected_paid')
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=ANY($1::uuid[]) AND transaction_type='earned' AND transaction_status <> 'reversed'", [[first.id, second.id]]), 2)
  })

  await t.test('5b. Speedaf item COD with delivery fee paid directly to Speedaf', async () => {
    const order = await createOrder({
      ...customer('COD Direct Fee'), delivery_type: 'courier', courier_id: courier.id,
      courier_tracking_number: 'SPD-P6-DIRECT', courier_payment_type: 'cod',
      delivery_fee_payment_method: 'paid_to_courier',
      customer_delivery_fee: 350, actual_courier_fee: 350, payment_method: 'pay_on_delivery',
      items: [internalItem(stockProduct.id, 1, 900)]
    })
    assert.equal(order.payment_status, 'pending')
    assert.equal(Number(order.paid_amount), 0)
    assert.equal(Number(order.total_amount), 900)
    assert.equal(Number(order.delivery_income), 0)
    assert.equal(Number(order.delivery_cost), 0)
    assert.equal(order.delivery_fee_payment_method, 'paid_to_courier')
    assert.equal(Number(order.delivery_fee_paid_amount), 0)
    assert.equal(Number(order.courier_customer_fee), 350)
    assert.equal(Number(order.courier_actual_fee), 350)
    assert.equal(await count('SELECT COUNT(*) FROM order_payments WHERE order_id=$1', [order.id]), 0)
    assert.equal(await count('SELECT COUNT(*) FROM cod_collections WHERE order_id=$1 AND cod_amount=900', [order.id]), 1)
    const delivery = await row('SELECT delivery_income, delivery_cost, courier_customer_fee, courier_actual_fee FROM deliveries WHERE order_id=$1', [order.id])
    assert.equal(Number(delivery.delivery_income), 0)
    assert.equal(Number(delivery.delivery_cost), 0)
    assert.equal(Number(delivery.courier_customer_fee), 350)
    assert.equal(Number(delivery.courier_actual_fee), 350)
    await assertGlobalIntegrity()
  })

  await t.test('5c. Speedaf item COD with delivery fee collected by Speedaf', async () => {
    const order = await createOrder({
      ...customer('COD Speedaf Fee'), delivery_type: 'courier', courier_id: courier.id,
      courier_tracking_number: 'SPD-P6-FEE-COD', courier_payment_type: 'cod',
      delivery_fee_payment_method: 'pay_on_delivery',
      customer_delivery_fee: 350, actual_courier_fee: 350, payment_method: 'pay_on_delivery',
      items: [internalItem(stockProduct.id, 1, 950)]
    })
    assert.equal(order.payment_status, 'pending')
    assert.equal(Number(order.paid_amount), 0)
    assert.equal(Number(order.total_amount), 950)
    assert.equal(Number(order.delivery_income), 0)
    assert.equal(Number(order.delivery_cost), 0)
    assert.equal(Number(order.courier_customer_fee), 350)
    assert.equal(Number(order.courier_actual_fee), 350)
    assert.equal(await count('SELECT COUNT(*) FROM order_payments WHERE order_id=$1', [order.id]), 0)
    assert.equal(await count('SELECT COUNT(*) FROM cod_collections WHERE order_id=$1 AND cod_amount=950', [order.id]), 1)
    const delivery = await row('SELECT delivery_fee, earned_amount, delivery_income, delivery_cost FROM deliveries WHERE order_id=$1', [order.id])
    assert.equal(Number(delivery.delivery_fee), 350)
    assert.equal(Number(delivery.earned_amount), 350)
    assert.equal(Number(delivery.delivery_income), 0)
    assert.equal(Number(delivery.delivery_cost), 0)
    await assertGlobalIntegrity()
  })

  await t.test('6. prepaid courier order', async () => {
    const order = await createOrder({
      ...customer('Prepaid'), delivery_type: 'courier', courier_id: courier.id,
      courier_tracking_number: 'SPD-P6-PRE', courier_payment_type: 'prepaid',
      customer_delivery_fee: 100, actual_courier_fee: 100, payment_method: 'mpesa',
      items: [internalItem(stockProduct.id, 1, 700)]
    })
    await advance(order.id, ['confirmed', 'in_transit', 'delivered'])
    assert.equal(await count('SELECT COUNT(*) FROM cod_collections WHERE order_id=$1', [order.id]), 0)
    assert.equal(await count(`SELECT COUNT(*) FROM order_payments WHERE order_id=$1 AND payment_method='mpesa' AND amount=800`, [order.id]), 1)
    assert.equal((await row('SELECT delivery_status FROM deliveries WHERE order_id=$1', [order.id])).delivery_status, 'delivered')
    const deliveryAmounts = await row('SELECT delivery_income,delivery_cost FROM orders WHERE id=$1', [order.id])
    assert.equal(Number(deliveryAmounts.delivery_income) - Number(deliveryAmounts.delivery_cost), 0)
    await assertGlobalIntegrity()
  })

  await t.test('6a. order and delivery workflow filters use the same canonical statuses', async () => {
    const createWorkflowDelivery = (label: string, courierPaymentType: 'prepaid' | 'cod' = 'prepaid') => createOrder({
      ...customer(`Workflow ${label}`),
      delivery_type: 'courier',
      courier_id: courier.id,
      courier_tracking_number: `SPD-P6-WORKFLOW-${label.toUpperCase()}`,
      courier_payment_type: courierPaymentType,
      customer_delivery_fee: 0,
      actual_courier_fee: 0,
      payment_method: courierPaymentType === 'cod' ? 'pay_on_delivery' : 'mpesa',
      items: [internalItem(stockProduct.id, 1, 100)]
    })

    const pendingOrder = await createWorkflowDelivery('PENDING')
    const confirmedOrder = await createWorkflowDelivery('CONFIRMED')
    await advance(confirmedOrder.id, ['confirmed'])
    const inTransitOrder = await createWorkflowDelivery('TRANSIT')
    await advance(inTransitOrder.id, ['confirmed', 'in_transit'])
    const pendingPaymentOrder = await createWorkflowDelivery('COD', 'cod')
    await advance(pendingPaymentOrder.id, ['confirmed', 'in_transit', 'delivered'])
    const completedOrder = await createWorkflowDelivery('COMPLETED')
    await advance(completedOrder.id, ['confirmed', 'in_transit', 'delivered'])
    const returnedOrder = await createWorkflowDelivery('RETURNED')
    await advance(returnedOrder.id, ['confirmed', 'in_transit', 'returned'])
    const cancelledOrder = await createWorkflowDelivery('CANCELLED')
    await advance(cancelledOrder.id, ['cancelled'])

    const expectedStages = [
      ['pending', pendingOrder],
      ['confirmed', confirmedOrder],
      ['in_transit', inTransitOrder],
      ['pending_payment', pendingPaymentOrder],
      ['completed', completedOrder],
      ['returned', returnedOrder],
      ['cancelled', cancelledOrder]
    ] as const

    for (const [stage, expectedOrder] of expectedStages) {
      const orders = await request('GET', `/orders?workflow_stage=${stage}&page=1&page_size=100`, admin.accessToken)
      assert.ok(orders.data.some((order: any) => order.id === expectedOrder.id), `Orders filter should include ${stage}`)

      const deliveries = await request('GET', `/deliveries?workflow_stage=${stage}&page=1&page_size=100`, admin.accessToken)
      const delivery = deliveries.data.find((record: any) => record.order_id === expectedOrder.id)
      assert.ok(delivery, `Deliveries filter should include ${stage}`)
      assert.equal(delivery.workflow_status, stage)
    }

    // `status` remains the physical-delivery-state filter for callers that
    // already use it. Combining it with a workflow filter must not turn a COD
    // delivery awaiting remittance into a completed delivery.
    const assignedDeliveries = await request('GET', '/deliveries?status=assigned&page=1&page_size=100', admin.accessToken)
    assert.ok(assignedDeliveries.data.some((record: any) => record.order_id === pendingOrder.id))
    assert.ok(assignedDeliveries.data.some((record: any) => record.order_id === confirmedOrder.id))
    const pendingPaymentDeliveries = await request(
      'GET',
      '/deliveries?workflow_stage=pending_payment&status=delivered&page=1&page_size=100',
      admin.accessToken
    )
    assert.ok(pendingPaymentDeliveries.data.some((record: any) => record.order_id === pendingPaymentOrder.id))
    assert.ok(pendingPaymentDeliveries.data.every((record: any) => record.workflow_status === 'pending_payment'))
    await request('GET', '/deliveries?workflow_stage=not_a_status', admin.accessToken, undefined, 400)
    await assertGlobalIntegrity()
  })

  await t.test('7. credit sale and customer payment', async () => {
    const details = customer('Credit')
    const order = await createOrder({
      ...details, delivery_type: 'walk_in', payment_method: 'credit',
      items: [internalItem(secondStockProduct.id, 1, 300)]
    })
    await advance(order.id, ['confirmed', 'delivered'])
    const linked = await row('SELECT * FROM customers WHERE id=$1', [order.customer_id])
    assert.equal(Number(linked.balance), 300)
    assert.equal(await count(`SELECT COUNT(*) FROM customer_credits WHERE order_id=$1 AND type='sale' AND amount=300`, [order.id]), 1)
    await request('POST', `/customers/${linked.id}/payments`, admin.accessToken, {
      amount: 300, order_id: order.id, payment_method: 'cash', reference: 'CREDIT-P6-001'
    }, 201)
    assert.equal(Number((await row('SELECT balance FROM customers WHERE id=$1', [linked.id])).balance), 0)
    assert.equal(await count(`SELECT COUNT(*) FROM customer_credits WHERE order_id=$1 AND type='payment' AND amount=-300`, [order.id]), 1)
    assert.equal((await row('SELECT payment_status FROM orders WHERE id=$1', [order.id])).payment_status, 'paid')
    await waitForAudit('customer_credit_payment_recorded', linked.id)
    await assertGlobalIntegrity()
  })

  await t.test('8. supplier settlement', async () => {
    const pendingItems = await request('GET', `/suppliers/${supplier.id}/payables?status=pending`, admin.accessToken)
    assert.ok(pendingItems.length > 0)
    assert.ok(pendingItems[0].product_name)
    assert.ok(pendingItems[0].order_number)
    const selectedPayable = pendingItems[0]
    const allocatedAmount = Math.min(10, Number(selectedPayable.outstanding_amount))
    const itemBalanceBefore = Number((await row('SELECT balance FROM suppliers WHERE id=$1', [supplier.id])).balance)
    const allocation = await request('POST', `/suppliers/${supplier.id}/payments/allocate`, admin.accessToken, {
      allocations: [{ payable_id: selectedPayable.id, amount: allocatedAmount }],
      payment_method: 'mpesa', reference: 'SUP-ITEM-P6-001', notes: 'Item allocation test'
    }, 201)
    assert.equal(Number(allocation.balance), itemBalanceBefore - allocatedAmount)
    const updatedPayable = await row('SELECT paid_amount, status, amount FROM supplier_payables WHERE id=$1', [selectedPayable.id])
    assert.equal(Number(updatedPayable.paid_amount), Number(selectedPayable.paid_amount) + allocatedAmount)
    assert.equal(updatedPayable.status, Number(updatedPayable.paid_amount) >= Number(updatedPayable.amount) ? 'paid' : 'partial')
    const paymentHistory = await request('GET', `/suppliers/${supplier.id}/payment-history`, admin.accessToken)
    assert.ok(paymentHistory.some((payment: any) => payment.reference === 'SUP-ITEM-P6-001' && payment.product_name))
    await waitForAudit('supplier_items_payment_recorded', supplier.id)

    const balanceBefore = Number((await row('SELECT balance FROM suppliers WHERE id=$1', [supplier.id])).balance)
    assert.ok(balanceBefore > 0)
    const amount = Math.min(500, balanceBefore)
    const settlement = await request('POST', `/suppliers/${supplier.id}/settlements`, admin.accessToken, {
      settled_amount: amount, period_start: '2026-06-01', period_end: '2026-06-30',
      total_products: 3, payment_method: 'mpesa', reference: 'SUP-P6-001'
    }, 201)
    assert.equal(Number(settlement.balance), balanceBefore - amount)
    assert.equal(await count('SELECT COUNT(*) FROM supplier_payments WHERE supplier_id=$1 AND reference=$2', [supplier.id, 'SUP-P6-001']), 1)
    assert.equal(Number((await row('SELECT balance FROM suppliers WHERE id=$1', [supplier.id])).balance), balanceBefore - amount)
    await waitForAudit('supplier_settlement_recorded', supplier.id)
    await assertGlobalIntegrity()
  })

  await t.test('9. rider settlement', async () => {
    const balanceBefore = Number((await row('SELECT balance FROM riders WHERE id=$1', [rider.id])).balance)
    assert.equal(balanceBefore, 500)
    const settlement = await request('POST', `/riders/${rider.id}/settlements`, admin.accessToken, {
      settled_amount: 500, period_start: '2026-06-01', period_end: '2026-06-30',
      total_deliveries: 1, payment_method: 'cash', reference: 'RIDER-P6-001'
    }, 201)
    assert.equal(Number(settlement.balance), 0)
    assert.equal(Number((await row('SELECT balance FROM riders WHERE id=$1', [rider.id])).balance), 0)
    assert.equal(await count('SELECT COUNT(*) FROM rider_payments WHERE rider_id=$1 AND reference=$2', [rider.id, 'RIDER-P6-001']), 1)
    await waitForAudit('rider_settlement_recorded', rider.id)
    await assertGlobalIntegrity()
  })

  await t.test('10. order cancellation reverses stock and creates refund', async () => {
    const before = Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity)
    const order = await createOrder({
      ...customer('Cancel'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [internalItem(stockProduct.id, 2, 100)]
    })
    assert.equal(Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity), before - 2)
    await advance(order.id, ['cancelled'])
    assert.equal(Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity), before)
    assert.equal(await count(`SELECT COUNT(*) FROM inventory_movements WHERE reference_id=$1 AND type='stock_in' AND quantity=2`, [order.id]), 1)
    assert.equal(await count(`SELECT COUNT(*) FROM order_refunds WHERE order_id=$1 AND status='pending' AND amount=200`, [order.id]), 1)
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [order.id])).status, 'cancelled')
    await waitForAudit('order_status_changed', order.id)
    await assertGlobalIntegrity()
  })

  await t.test('11. return and refund with paid supplier obligation', async () => {
    const order = await createOrder({
      ...customer('Return'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [supplierItem(1, 500, 200)]
    })
    const payable = await row('SELECT * FROM supplier_payables WHERE order_id=$1', [order.id])
    await request('POST', `/suppliers/${supplier.id}/payments`, admin.accessToken, {
      payable_id: payable.id, amount: 200, payment_method: 'mpesa', reference: 'RETURN-SUP-P6'
    }, 201)
    await advance(order.id, ['confirmed', 'delivered', 'returned'])
    assert.equal(await count('SELECT COUNT(*) FROM supplier_returns WHERE payable_id=$1 AND amount=200', [payable.id]), 1)
    const refund = await row(`SELECT * FROM order_refunds WHERE order_id=$1 AND status='pending'`, [order.id])
    assert.equal(Number(refund.amount), 500)
    await request('POST', `/orders/refunds/${refund.id}/pay`, admin.accessToken, {
      payment_method: 'mpesa', reference: 'REFUND-P6-001'
    })
    assert.equal((await row('SELECT status FROM order_refunds WHERE id=$1', [refund.id])).status, 'paid')
    assert.equal((await row('SELECT status FROM supplier_payables WHERE id=$1', [payable.id])).status, 'returned')
    await waitForAudit('order_refund_paid', refund.id)
    await assertGlobalIntegrity()
  })

  await t.test('12. expense workflow affects profit only after approval', async () => {
    const today = isoDate()
    const tomorrow = addDays(today, 1)
    const beforeProfit = await request('GET', `/reports/profit?date_from=${today}&date_to=${today}`, admin.accessToken)
    const pendingExpense = await request('POST', '/expenses', admin.accessToken, {
      description: 'Phase 6 Meta Ads',
      category: 'Marketing',
      amount: 1234,
      frequency: 'daily',
      expense_date: today,
      payment_method: 'mpesa',
      reference_notes: 'P6-ADS-001'
    }, 201)
    const afterPendingProfit = await request('GET', `/reports/profit?date_from=${today}&date_to=${today}`, admin.accessToken)
    assert.equal(Number(afterPendingProfit.expenses), Number(beforeProfit.expenses))

    await request('PUT', `/expenses/${pendingExpense.id}/approve`, admin.accessToken)
    const afterApprovedProfit = await request('GET', `/reports/profit?date_from=${today}&date_to=${today}`, admin.accessToken)
    assert.equal(Number(afterApprovedProfit.expenses), Number(beforeProfit.expenses) + 1234)

    const tomorrowProfit = await request('GET', `/reports/profit?date_from=${tomorrow}&date_to=${tomorrow}`, admin.accessToken)
    assert.equal(Number(tomorrowProfit.expenses), 1234)

    const endedDailyExpense = await request('POST', '/expenses', admin.accessToken, {
      description: 'Phase 6 Meta Ads Old Rate',
      category: 'Marketing',
      amount: 100,
      frequency: 'daily',
      expense_date: today,
      effective_end_date: today,
      payment_method: 'mpesa',
      reference_notes: 'P6-ADS-OLD'
    }, 201)
    await request('PUT', `/expenses/${endedDailyExpense.id}/approve`, admin.accessToken)
    const afterEndedDailyProfit = await request('GET', `/reports/profit?date_from=${today}&date_to=${today}`, admin.accessToken)
    assert.equal(Number(afterEndedDailyProfit.expenses), Number(afterApprovedProfit.expenses) + 100)
    const tomorrowAfterEndedDaily = await request('GET', `/reports/profit?date_from=${tomorrow}&date_to=${tomorrow}`, admin.accessToken)
    assert.equal(Number(tomorrowAfterEndedDaily.expenses), 1234)

    const newDailyExpense = await request('POST', '/expenses', admin.accessToken, {
      description: 'Phase 6 Meta Ads New Rate',
      category: 'Marketing',
      amount: 150,
      frequency: 'daily',
      expense_date: tomorrow,
      payment_method: 'mpesa',
      reference_notes: 'P6-ADS-NEW'
    }, 201)
    await request('PUT', `/expenses/${newDailyExpense.id}/approve`, admin.accessToken)
    const tomorrowAfterNewDaily = await request('GET', `/reports/profit?date_from=${tomorrow}&date_to=${tomorrow}`, admin.accessToken)
    assert.equal(Number(tomorrowAfterNewDaily.expenses), Number(tomorrowAfterEndedDaily.expenses) + 150)

    const monthlyAmount = daysInUtcMonth(today) * 100
    const monthlyExpense = await request('POST', '/expenses', admin.accessToken, {
      description: 'Phase 6 Monthly Rent',
      category: 'Rent',
      amount: monthlyAmount,
      frequency: 'monthly',
      expense_date: today,
      payment_method: 'bank_transfer',
      reference_notes: 'P6-RENT-001'
    }, 201)
    await request('PUT', `/expenses/${monthlyExpense.id}/approve`, admin.accessToken)
    const afterMonthlyProfit = await request('GET', `/reports/profit?date_from=${today}&date_to=${today}`, admin.accessToken)
    assert.equal(roundMoney(Number(afterMonthlyProfit.expenses)), roundMoney(Number(afterEndedDailyProfit.expenses) + 100))

    const dashboard = await request('GET', `/dashboard/stats?date_from=${today}&date_to=${today}`, admin.accessToken)
    assert.equal(roundMoney(Number(dashboard.periodExpenses)), roundMoney(Number(afterMonthlyProfit.expenses)))
    assert.equal(
      roundMoney(Number(dashboard.todayOperatingProfit)),
      roundMoney(Number(dashboard.todayGrossAfterDelivery) - Number(dashboard.todayExpenses))
    )

    const rejectedExpense = await request('POST', '/expenses', admin.accessToken, {
      description: 'Phase 6 Rejected Expense',
      category: 'Testing',
      amount: 99,
      frequency: 'one_off',
      expense_date: today,
      payment_method: 'cash',
      reference_notes: 'P6-REJECT-001'
    }, 201)
    await request('PUT', `/expenses/${rejectedExpense.id}/reject`, admin.accessToken)
    const afterRejectedProfit = await request('GET', `/reports/profit?date_from=${today}&date_to=${today}`, admin.accessToken)
    assert.equal(roundMoney(Number(afterRejectedProfit.expenses)), roundMoney(Number(afterMonthlyProfit.expenses)))

    const expenseRows = await request('GET', '/expenses?frequency=daily&status=approved&page=1&page_size=10', admin.accessToken)
    assert.ok(expenseRows.data.some((expense: any) => expense.id === pendingExpense.id))
    await waitForAudit('expense_created', pendingExpense.id)
    await waitForAudit('expense_created', monthlyExpense.id)
    await waitForAudit('expense_created', endedDailyExpense.id)
    await waitForAudit('expense_created', newDailyExpense.id)
    await waitForAudit('expense_approved', pendingExpense.id)
    await waitForAudit('expense_approved', monthlyExpense.id)
    await waitForAudit('expense_approved', endedDailyExpense.id)
    await waitForAudit('expense_approved', newDailyExpense.id)
    await waitForAudit('expense_rejected', rejectedExpense.id)
    await assertGlobalIntegrity()
  })

  await t.test('13. end-of-day reconciliation', async () => {
    const first = await request('POST', '/reports/reconciliation/daily', admin.accessToken, {
      actual_cash: 0, actual_mpesa: 0, notes: 'Phase 6 initial calculation'
    }, 201)
    const reconciled = await request('POST', '/reports/reconciliation/daily', admin.accessToken, {
      actual_cash: Number(first.expected_cash), actual_mpesa: Number(first.expected_mpesa),
      notes: 'Phase 6 balanced close'
    }, 201)
    assert.equal(Number(reconciled.cash_variance), 0)
    assert.equal(Number(reconciled.mpesa_variance), 0)
    assert.ok(Number(reconciled.cod_collections) >= 1000)
    await request('PUT', `/reports/reconciliation/daily/${reconciled.id}/close`, admin.accessToken, {})
    assert.equal((await row('SELECT status FROM daily_reconciliations WHERE id=$1', [reconciled.id])).status, 'closed')
    await waitForAudit('daily_reconciliation_closed', reconciled.id)
    await assertGlobalIntegrity()
  })

  await t.test('14. attendant restrictions and owner/admin authority', async () => {
    const attendantOrder = await createOrder({
      ...customer('Attendant'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [internalItem(stockProduct.id, 1, 100)]
    }, attendant.accessToken)
    assert.equal(attendantOrder.created_by, attendantUser.id)
    await request('PUT', `/orders/${attendantOrder.id}`, attendant.accessToken, {
      ...customer('Attendant Blocked Edit'),
      delivery_type: 'walk_in',
      payment_method: 'cash',
      sale_date: isoDate(),
      items: [internalItem(stockProduct.id, 2, 120)]
    }, 403)

    await db.query(
      `INSERT INTO user_permissions (user_id, permission_id, granted_by)
       SELECT $1, id, $2 FROM permissions WHERE module='orders' AND action='edit'
       ON CONFLICT DO NOTHING`,
      [attendantUser.id, adminUser.id]
    )
    const stockBeforeEdit = Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity)
    const editedOrder = await request('PUT', `/orders/${attendantOrder.id}`, attendant.accessToken, {
      ...customer('Attendant Granted Edit'),
      delivery_type: 'walk_in',
      payment_method: 'cash',
      sale_date: isoDate(),
      items: [internalItem(stockProduct.id, 2, 150)]
    })
    assert.equal(editedOrder.id, attendantOrder.id)
    assert.equal(Number(editedOrder.total_amount), 300)
    assert.equal(Number((await row('SELECT quantity FROM inventory WHERE product_id=$1', [stockProduct.id])).quantity), stockBeforeEdit - 1)
    assert.equal(await count('SELECT COUNT(*) FROM order_payments WHERE order_id=$1 AND amount=300', [attendantOrder.id]), 1)
    assert.equal(await count('SELECT COUNT(*) FROM order_items WHERE order_id=$1', [attendantOrder.id]), 1)
    await waitForAudit('order_updated', attendantOrder.id)

    await advance(attendantOrder.id, ['confirmed', 'delivered'])
    const adminLateEdit = await request('PUT', `/orders/${attendantOrder.id}`, admin.accessToken, {
      ...customer('Admin Late Edit'),
      delivery_type: 'walk_in',
      payment_method: 'cash',
      sale_date: isoDate(),
      items: [internalItem(stockProduct.id, 1, 100)]
    })
    assert.equal(adminLateEdit.id, attendantOrder.id)
    assert.equal(Number(adminLateEdit.total_amount), 100)
    await request('GET', '/reports/profit', attendant.accessToken, undefined, 403)
    await request('PUT', '/settings', attendant.accessToken, { company_name: 'Forbidden' }, 403)
    await request('POST', `/suppliers/${supplier.id}/settlements`, attendant.accessToken, {
      settled_amount: 1, period_start: '2026-06-01', period_end: '2026-06-30'
    }, 403)
    const adminReports = await request('GET', '/reports/profit', admin.accessToken)
    const ownerReports = await request('GET', '/reports/profit', owner.accessToken)
    assert.equal(Number(adminReports.netProfit), Number(ownerReports.netProfit))
    assert.equal(await count('SELECT COUNT(*) FROM supplier_settlements WHERE settled_amount=1'), 0)
    await waitForAudit('order_created')
    await assertGlobalIntegrity()
  })

  await t.test('15. commission accuracy, permissions, payment, and module controls', async () => {
    await db.query(
      `INSERT INTO user_permissions (user_id, permission_id, granted_by)
       SELECT $1, id, $2 FROM permissions
       WHERE (module = 'commission' AND action IN ('own_view','own_daily','own_history','own_transactions','own_potential'))
          OR (module = 'orders' AND action = 'status')
          OR (module = 'dashboard' AND action IN ('view','personal_sales','personal_orders','pending_speedaf'))
       ON CONFLICT DO NOTHING`,
      [attendantUser.id, adminUser.id]
    )

    // Create the qualifying sale in this test so the commission assertion is not
    // coupled to a prior test's workflow or timing.
    const commissionOrder = await createOrder({
      ...customer('Commission Attendant Sale'),
      delivery_type: 'walk_in',
      payment_method: 'cash',
      items: [internalItem(stockProduct.id, 3, 100)]
    }, attendant.accessToken)
    await request('PUT', `/orders/${commissionOrder.id}/status`, admin.accessToken, { status: 'confirmed' })
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'", [commissionOrder.id]), 0)
    await request('PUT', `/orders/${commissionOrder.id}/status`, admin.accessToken, { status: 'delivered' })

    const commissionItem = await row('SELECT id FROM order_items WHERE order_id = $1', [commissionOrder.id])
    const commissionEvaluation = await evaluateOrderItemFromRecords(commissionOrder.id, commissionItem.id)
    assert.ok(
      commissionEvaluation.eligible || commissionEvaluation.alreadyEarned,
      `Expected fresh attendant sale to qualify: ${JSON.stringify(commissionEvaluation)}`
    )

    const attendantCommission = await row(
      `SELECT ct.* FROM commission_transactions ct
       WHERE ct.order_id = $1 AND ct.transaction_type = 'earned'
       ORDER BY ct.created_at DESC LIMIT 1`,
      [commissionOrder.id]
    )
    assert.equal(Number(attendantCommission.eligible_quantity), 3)
    assert.equal(Number(attendantCommission.rate_per_item), 50)
    assert.equal(Number(attendantCommission.amount), 150)

    const ownSummary = await request('GET', '/commissions/own/summary', attendant.accessToken)
    assert.ok(Number(ownSummary.grossEarned) >= 100)
    await request('GET', '/commissions/summary', attendant.accessToken, undefined, 403)

    // Speedaf COD is not complete at customer delivery. It earns only after an
    // authorised user records full remittance and the order becomes completed.
    const ownCodOrder = await createOrder({
      ...customer('Own COD Remittance Separation'),
      delivery_type: 'courier', courier_id: courier.id, courier_tracking_number: 'SPD-P6-OWN-COD',
      courier_payment_type: 'cod', delivery_fee_payment_method: 'paid_to_courier',
      customer_delivery_fee: 0, actual_courier_fee: 0, payment_method: 'pay_on_delivery',
      items: [internalItem(stockProduct.id, 1, 100)]
    }, attendant.accessToken)
    await advance(ownCodOrder.id, ['confirmed', 'in_transit', 'delivered'])
    await db.query(
      `INSERT INTO user_permissions (user_id, permission_id, granted_by)
       SELECT $1, id, $2 FROM permissions WHERE module='cod' AND action='remit'
       ON CONFLICT DO NOTHING`,
      [attendantUser.id, adminUser.id]
    )
    await request('POST', `/deliveries/orders/${ownCodOrder.id}/cod`, attendant.accessToken, {
      amount: 100, payment_method: 'mpesa', reference: 'P6-OWN-COD-BLOCKED'
    }, 403)
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [ownCodOrder.id])).status, 'delivered')
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'", [ownCodOrder.id]), 0)
    await request('POST', `/deliveries/orders/${ownCodOrder.id}/cod`, admin.accessToken, {
      amount: 100, payment_method: 'mpesa', reference: 'P6-OWN-COD-ADMIN-REMIT'
    }, 201)
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [ownCodOrder.id])).status, 'collected_paid')
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'", [ownCodOrder.id]), 1)

    // The order creator owns the sale. Completion unlocks commission without a
    // second commission-specific verification step.
    const selfCompletedOrder = await createOrder({
      ...customer('Independent Commission Verification'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [internalItem(stockProduct.id, 1, 100)]
    }, attendant.accessToken)
    await request('PUT', `/orders/${selfCompletedOrder.id}/status`, attendant.accessToken, { status: 'confirmed' })
    await request('PUT', `/orders/${selfCompletedOrder.id}/status`, attendant.accessToken, { status: 'delivered' })
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'", [selfCompletedOrder.id]), 1)

    // The COD separation-of-duties scenario above also uses this stock item;
    // take the return baseline only after that independent sale has consumed
    // its item. The assertions below then isolate the three-item commission
    // order's partial/full return behaviour.
    const stockBeforeCommissionReturn = Number((await row('SELECT quantity FROM inventory WHERE product_id = $1', [stockProduct.id])).quantity)

    const personalDashboard = await request('GET', '/dashboard/stats', attendant.accessToken)
    assert.ok(Object.hasOwn(personalDashboard, 'myTodaySales'))
    assert.ok(!Object.hasOwn(personalDashboard, 'netProfit'))
    assert.ok(!Object.hasOwn(personalDashboard, 'supplierPayables'))

    // Every personal dashboard card must load, including the selected-period
    // queries that previously used a sparse PostgreSQL parameter list.
    const personalCardNames = [
      'my_sales_today',
      'my_sales_period',
      'my_orders_period',
      'my_open_orders',
      'my_completed_orders',
      'my_speedaf_pending'
    ]
    const personalCardResults: Record<string, any> = {}
    for (const card of personalCardNames) {
      personalCardResults[card] = await request(
        'GET',
        `/dashboard/drilldown?card=${card}&date_from=${isoDate()}&date_to=${isoDate()}`,
        attendant.accessToken
      )
      assert.equal(personalCardResults[card].kind, 'orders')
      assert.ok(personalCardResults[card].rows.every((item: any) => item.creator_name === 'Phase 6 Attendant'))
    }

    const completedDrilldown = personalCardResults.my_completed_orders
    assert.equal(completedDrilldown.kind, 'orders')
    assert.ok(completedDrilldown.rows.some((item: any) => item.order_id === commissionOrder.id))
    assert.equal(completedDrilldown.total, personalDashboard.myCompletedOrders)
    assert.equal(completedDrilldown.summary.completedOrders, completedDrilldown.total)
    assert.ok(completedDrilldown.summary.totalCompletedSales > 0)
    assert.ok(completedDrilldown.rows.every((item: any) => item.completion_date))
    assert.ok(completedDrilldown.rows.every((item: any) => ['earned', 'expected', 'not_eligible', 'reversed'].includes(item.commission_status)))
    for (const item of completedDrilldown.rows) {
      assert.equal((await row('SELECT created_by FROM orders WHERE id=$1', [item.order_id])).created_by, attendantUser.id)
    }
    const futureCompletedDrilldown = await request(
      'GET',
      `/dashboard/drilldown?card=my_completed_orders&date_from=${addDays(isoDate(), 1)}&date_to=${addDays(isoDate(), 1)}`,
      attendant.accessToken
    )
    assert.equal(futureCompletedDrilldown.total, 0)

    const ownCommissionCards = ['recorded', 'reversals', 'balance', 'approved', 'paid', 'outstanding', 'recovery']
    const ownCommissionResults: Record<string, any> = {}
    for (const card of ownCommissionCards) {
      ownCommissionResults[card] = await request(
        'GET',
        `/dashboard/drilldown?card=my_commission_${card}&date_from=${isoDate()}&date_to=${isoDate()}`,
        attendant.accessToken
      )
      assert.equal(ownCommissionResults[card].kind, 'commissions')
    }
    const ownCommissionDrilldown = ownCommissionResults.recorded
    assert.equal(ownCommissionDrilldown.kind, 'commissions')
    assert.ok(ownCommissionDrilldown.rows.some((item: any) => item.order_id === commissionOrder.id))
    assert.ok(ownCommissionDrilldown.rows.every((item: any) => item.salesperson_name === 'Phase 6 Attendant'))
    await request(
      'GET',
      `/dashboard/drilldown?card=company_commission_recorded&date_from=${isoDate()}&date_to=${isoDate()}`,
      attendant.accessToken,
      undefined,
      403
    )
    const companyCommissionCards = ['recorded', 'reversals', 'balance', 'approved', 'paid', 'outstanding', 'recovery', 'salespeople']
    const companyCommissionResults: Record<string, any> = {}
    for (const card of companyCommissionCards) {
      companyCommissionResults[card] = await request(
        'GET',
        `/dashboard/drilldown?card=company_commission_${card}&date_from=${isoDate()}&date_to=${isoDate()}`,
        admin.accessToken
      )
      assert.equal(companyCommissionResults[card].kind, card === 'salespeople' ? 'salespeople' : 'commissions')
    }
    const companyCommissionDrilldown = companyCommissionResults.recorded
    assert.equal(companyCommissionDrilldown.kind, 'commissions')
    await request(
      'GET',
      `/dashboard/drilldown?card=unknown_card&date_from=${isoDate()}&date_to=${isoDate()}`,
      attendant.accessToken,
      undefined,
      400
    )

    const duplicateItems = await count(
      `SELECT COUNT(*) FROM (
         SELECT order_item_id FROM commission_transactions
         WHERE transaction_type = 'earned' AND transaction_status <> 'reversed'
         GROUP BY order_item_id HAVING COUNT(*) > 1
       ) duplicates`
    )
    assert.equal(duplicateItems, 0)

    const speedafAccuracy = await row(
      `SELECT ct.qualified_at, cc.remitted_at
       FROM commission_transactions ct
       JOIN orders o ON o.id = ct.order_id
       JOIN cod_collections cc ON cc.order_id = o.id
       WHERE o.courier_payment_type = 'cod' AND ct.transaction_type = 'earned'
       ORDER BY ct.created_at DESC LIMIT 1`
    )
    assert.ok(new Date(speedafAccuracy.qualified_at).getTime() >= new Date(speedafAccuracy.remitted_at).getTime())

    await request('POST', `/commissions/transactions/${attendantCommission.id}/approve`, admin.accessToken, {})
    await request('POST', `/commissions/transactions/${attendantCommission.id}/pay`, admin.accessToken, {
      amount: 40, payment_method: 'mpesa', reference: 'P6-COMMISSION-PARTIAL'
    })
    assert.equal(await count('SELECT COUNT(*) FROM commission_payments WHERE commission_transaction_id=$1 AND reference=$2', [attendantCommission.id, 'P6-COMMISSION-PARTIAL']), 1)
    const repeatedPayment = await request('POST', `/commissions/transactions/${attendantCommission.id}/pay`, admin.accessToken, {
      amount: 40, payment_method: 'mpesa', reference: 'P6-COMMISSION-PARTIAL'
    })
    assert.equal(repeatedPayment.idempotent, true)
    assert.equal(await count('SELECT COUNT(*) FROM commission_payments WHERE commission_transaction_id=$1 AND reference=$2', [attendantCommission.id, 'P6-COMMISSION-PARTIAL']), 1)
    assert.equal((await row('SELECT transaction_status FROM commission_transactions WHERE id=$1', [attendantCommission.id])).transaction_status, 'approved')
    await request('POST', `/commissions/transactions/${attendantCommission.id}/pay`, admin.accessToken, {
      payment_method: 'mpesa', reference: 'P6-COMMISSION-FINAL'
    })
    assert.equal((await row('SELECT transaction_status FROM commission_transactions WHERE id=$1', [attendantCommission.id])).transaction_status, 'paid')

    // A partial return must reverse only the affected item quantity, including
    // after payment. It also proves the full-order return path does not restore
    // the same stock or supplier liability twice.
    await request('PUT', `/orders/${commissionOrder.id}/items/${commissionItem.id}/fulfillment-status`, admin.accessToken, {
      fulfillment_status: 'returned'
    }, 400)
    await request('POST', `/orders/${commissionOrder.id}/items/${commissionItem.id}/returns`, admin.accessToken, {
      quantity: 1,
      return_source: 'internal',
      stock_condition: 'sellable',
      reason: 'Customer returned one item after payment'
    }, 201)
    const partialReturnItem = await row('SELECT returned_quantity, fulfillment_status FROM order_items WHERE id=$1', [commissionItem.id])
    assert.equal(Number(partialReturnItem.returned_quantity), 1)
    assert.equal(partialReturnItem.fulfillment_status, 'fulfilled')
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE original_transaction_id=$1 AND transaction_type='reversal' AND eligible_quantity=1", [attendantCommission.id]), 1)
    assert.equal(Number((await row('SELECT quantity FROM inventory WHERE product_id = $1', [stockProduct.id])).quantity), stockBeforeCommissionReturn + 1)
    await request('POST', `/commissions/transactions/${attendantCommission.id}/pay`, admin.accessToken, {
      payment_method: 'mpesa', reference: 'P6-MUST-NOT-OVERPAY'
    }, 400)
    await request('PUT', `/orders/${commissionOrder.id}/status`, admin.accessToken, { status: 'returned', notes: 'Remaining items returned after partial return' })
    const returnedCommission = await row(
      `SELECT COALESCE(SUM(eligible_quantity), 0) AS quantity, COALESCE(SUM(amount), 0) AS amount
       FROM commission_transactions WHERE original_transaction_id=$1 AND transaction_type='reversal'`,
      [attendantCommission.id]
    )
    assert.equal(Number(returnedCommission.quantity), 3)
    assert.equal(Number(returnedCommission.amount), 150)
    assert.equal(Number((await row('SELECT quantity FROM inventory WHERE product_id = $1', [stockProduct.id])).quantity), stockBeforeCommissionReturn + 3)

    const adjustment = await request('POST', '/commissions/adjust', admin.accessToken, {
      salesperson_id: attendantUser.id, amount: 25, adjustment_type: 'manual_deduct',
      reason: 'Phase 6 accuracy test', period: isoDate().slice(0, 7)
    }, 201)
    assert.equal(Number(adjustment.amount), 25)

    await request('POST', '/commissions/programme', admin.accessToken, {
      status: 'disabled', effective_from: isoDate(), reason: 'Phase 6 disable test'
    }, 201)
    const disabledOrder = await createOrder({
      ...customer('Commission Disabled'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [internalItem(stockProduct.id, 1, 100)]
    }, attendant.accessToken)
    await advance(disabledOrder.id, ['confirmed', 'delivered'])
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'", [disabledOrder.id]), 0)

    // A historical earned row recorded during the disabled period must be
    // reported as invalid and corrected with a counter-entry, not hidden as
    // an ambiguous evidence gap.
    const disabledItem = await row('SELECT id, product_id, product_category_id FROM order_items WHERE order_id = $1', [disabledOrder.id])
    const disabledEvaluation = await evaluateOrderItemFromRecords(disabledOrder.id, disabledItem.id)
    assert.match(disabledEvaluation.reason || '', /programme was disabled/i)
    const disabledProgramme = await row(
      `SELECT id FROM commission_programmes WHERE status = 'disabled'
       ORDER BY effective_from DESC, created_at DESC, id DESC LIMIT 1`
    )
    const invalidDisabledEarning = await row(
      `INSERT INTO commission_transactions
        (programme_id, salesperson_id, order_id, order_item_id, product_id, category_id,
         eligible_quantity, rate_per_item, amount, transaction_type, transaction_status,
         qualification_date, qualified_at, commission_month, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 50, 50, 'earned', 'pending',
               $7::date, $8::timestamp, $9::date, 'Legacy earning recorded while disabled', $10)
       RETURNING id`,
      [
        disabledProgramme.id, attendantUser.id, disabledOrder.id, disabledItem.id,
        disabledItem.product_id, disabledItem.product_category_id || null,
        disabledEvaluation.qualificationDate, disabledEvaluation.qualificationAt,
        `${disabledEvaluation.qualificationDate!.slice(0, 7)}-01`, adminUser.id
      ]
    )
    const disabledPreview = await request('POST', '/commissions/retroactive', admin.accessToken, {
      date_from: disabledEvaluation.qualificationDate, date_to: disabledEvaluation.qualificationDate, apply: false
    })
    const disabledIssue = disabledPreview.issues.find((issue: any) => issue.transactionId === invalidDisabledEarning.id)
    assert.equal(disabledIssue?.type, 'missing_reversal')
    assert.match(disabledIssue?.message || '', /disabled/i)
    const disabledCorrection = await request('POST', '/commissions/retroactive', admin.accessToken, {
      date_from: disabledEvaluation.qualificationDate, date_to: disabledEvaluation.qualificationDate,
      apply: true, reason: 'Phase 6 disabled-programme correction'
    })
    assert.ok(disabledCorrection.reversalsCreated >= 1)
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE original_transaction_id=$1 AND transaction_type='reversal'", [invalidDisabledEarning.id]), 1)

    await request('POST', '/commissions/programme', admin.accessToken, {
      status: 'active', effective_from: isoDate(), reason: 'Phase 6 reactivation test'
    }, 201)
    const reactivatedOrder = await createOrder({
      ...customer('Commission Reactivated'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [internalItem(stockProduct.id, 1, 100)]
    }, attendant.accessToken)
    await advance(reactivatedOrder.id, ['confirmed', 'delivered'])
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'", [reactivatedOrder.id]), 1)

    // Simulate a legacy missing ledger row, then prove a retroactive apply is
    // idempotent, transactional, and linked to a reconciliation run.
    const retroMissingOrder = await createOrder({
      ...customer('Retroactive Missing Commission'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [internalItem(stockProduct.id, 1, 100)]
    }, attendant.accessToken)
    await advance(retroMissingOrder.id, ['confirmed', 'delivered'])
    await db.query("DELETE FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'", [retroMissingOrder.id])

    const retroQualification = await row(
      `SELECT qualification_date::text AS qualification_date FROM commission_transactions
       WHERE order_id = $1 AND transaction_type = 'earned'`,
      [reactivatedOrder.id]
    )
    const retroDate = retroQualification.qualification_date
    const preview = await request('POST', '/commissions/retroactive', admin.accessToken, {
      date_from: retroDate, date_to: retroDate, apply: false
    })
    assert.equal(preview.mode, 'preview')
    assert.ok(preview.alreadyEarnedItems > 0, `Expected recorded commission in retro preview: ${JSON.stringify({ retroDate, preview })}`)
    assert.ok(preview.eligibleItems > 0)
    assert.equal(preview.commissionsEarned, 0)
    const appliedRetro = await request('POST', '/commissions/retroactive', admin.accessToken, {
      date_from: retroDate, date_to: retroDate, apply: true, reason: 'Phase 6 verified legacy backfill'
    })
    assert.ok(appliedRetro.runId)
    assert.ok(appliedRetro.commissionsEarned > 0)
    assert.equal(await count("SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'", [retroMissingOrder.id]), 1)
    assert.equal(await count('SELECT COUNT(*) FROM commission_reconciliation_runs WHERE id=$1 AND status=$2', [appliedRetro.runId, 'completed']), 1)

    await db.query('UPDATE settings SET commission_module_enabled = FALSE')
    const moduleDisabledOrder = await createOrder({
      ...customer('Commission Module Disabled'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [internalItem(stockProduct.id, 1, 100)]
    }, attendant.accessToken)
    await advance(moduleDisabledOrder.id, ['confirmed', 'delivered'])
    assert.equal(await count(
      "SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'",
      [moduleDisabledOrder.id]
    ), 0)
    await db.query('UPDATE settings SET commission_module_enabled = TRUE')
  })

  await t.test('15b. an August sale completed in September uses the August rate and September earning month', async () => {
    const historicalSaleDate = '2026-08-01'
    const completionDate = '2026-09-05'
    const sourceProgramme = await row(
      `INSERT INTO commission_programmes (status, effective_from, reason, created_by)
       VALUES ('active', '2026-08-06'::date, 'Source programme for historical test', $1)
       RETURNING id`,
      [adminUser.id]
    )
    const historicalRate = await row(
      `INSERT INTO commission_rates
        (programme_id, rate_per_item, effective_from, scope_type, scope_name, created_by)
       VALUES ($1, 35, '2026-08-06'::date, 'global', 'Historical KSh 35 rate', $2)
       RETURNING id`,
      [sourceProgramme.id, adminUser.id]
    )
    const backdatedRate = await request('PUT', `/commissions/rates/${historicalRate.id}`, admin.accessToken, {
      rate_per_item: 35,
      effective_from: historicalSaleDate,
      effective_to: null
    })
    assert.equal(backdatedRate.id, historicalRate.id)
    const historicalProgramme = await request('POST', '/commissions/programme', admin.accessToken, {
      status: 'active',
      effective_from: historicalSaleDate,
      effective_to: null,
      reason: 'Commission introduced on 1 August'
    }, 201)
    assert.equal(await count(
      `SELECT COUNT(*) FROM commission_rates
       WHERE programme_id = $1 AND rate_per_item = 35 AND effective_from = $2::date`,
      [historicalProgramme.id, historicalSaleDate]
    ), 1)

    const historicalOrder = await createOrder({
      ...customer('Historical Rate Sale'), sale_date: historicalSaleDate,
      delivery_type: 'walk_in', payment_method: 'cash',
      items: [internalItem(stockProduct.id, 2, 100)]
    }, attendant.accessToken)
    await advance(historicalOrder.id, ['confirmed', 'delivered'])

    // The transition above proves the live earning path. Move its authoritative
    // completion/payment evidence to September, remove the initial ledger row,
    // and let the retroactive path rebuild it using the same policy rules.
    await db.query(
      `UPDATE audit_logs
       SET created_at = $2::timestamp
       WHERE entity_type = 'order' AND entity_id = $1
         AND action = 'order_status_changed'
         AND new_values->>'status' = 'delivered'`,
      [historicalOrder.id, `${completionDate} 10:00:00`]
    )
    await db.query(
      'UPDATE order_payments SET created_at = $2::timestamp WHERE order_id = $1',
      [historicalOrder.id, `${completionDate} 09:00:00`]
    )
    await db.query("DELETE FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'", [historicalOrder.id])

    // A retroactive run uses the same order-date policy and remains idempotent.
    const preview = await request('POST', '/commissions/retroactive', admin.accessToken, {
      date_from: historicalSaleDate, date_to: historicalSaleDate, apply: false
    })
    assert.equal(preview.eligibleItems, 1)
    assert.equal(Number(preview.totalCommissionAmount), 70)
    await request('POST', '/commissions/retroactive', admin.accessToken, {
      date_from: historicalSaleDate, date_to: historicalSaleDate,
      apply: true, reason: 'Backfill historical sale-date policy test'
    })
    const earning = await row(
      `SELECT rate_per_item, amount, policy_date::text AS policy_date,
              qualification_date::text AS qualification_date,
              commission_month::text AS commission_month
       FROM commission_transactions
       WHERE order_id = $1 AND transaction_type = 'earned'`,
      [historicalOrder.id]
    )
    assert.equal(Number(earning.rate_per_item), 35)
    assert.equal(Number(earning.amount), 70)
    assert.equal(earning.policy_date, historicalSaleDate)
    assert.equal(earning.qualification_date, completionDate)
    assert.equal(earning.commission_month, `${completionDate.slice(0, 7)}-01`)

    // Speedaf physical delivery is not final completion. A parcel delivered in
    // August and fully remitted in September belongs to September's completed
    // sales and commission accounting, while retaining its August sale rate.
    const speedafSaleDate = '2026-08-02'
    const speedafDeliveryDate = '2026-08-31'
    const speedafCompletionDate = '2026-09-02'
    const historicalSpeedafOrder = await createOrder({
      ...customer('Historical Speedaf Completion'),
      sale_date: speedafSaleDate,
      delivery_type: 'courier',
      courier_id: courier.id,
      courier_tracking_number: 'SPD-P6-HISTORICAL',
      courier_payment_type: 'cod',
      customer_delivery_fee: 0,
      actual_courier_fee: 0,
      payment_method: 'mpesa',
      items: [internalItem(stockProduct.id, 1, 100)]
    }, attendant.accessToken)
    await advance(historicalSpeedafOrder.id, ['confirmed', 'in_transit', 'delivered'])
    assert.equal((await row('SELECT commission_completion_at FROM orders WHERE id=$1', [historicalSpeedafOrder.id])).commission_completion_at, null)
    await db.query(
      `UPDATE audit_logs SET created_at=$2::timestamp
       WHERE entity_type='order' AND entity_id=$1 AND action='order_status_changed'
         AND new_values->>'status'='delivered'`,
      [historicalSpeedafOrder.id, `${speedafDeliveryDate} 10:00:00`]
    )
    await db.query(
      `UPDATE deliveries SET delivery_status='collected_paid', delivered_at=$2::timestamp
       WHERE order_id=$1`,
      [historicalSpeedafOrder.id, `${speedafDeliveryDate} 10:00:00`]
    )
    await db.query(
      `UPDATE cod_collections
       SET status='remitted', remitted_amount=cod_amount,
           delivered_at=$2::timestamp, remitted_at=$3::timestamp, closed_at=$3::timestamp
       WHERE order_id=$1`,
      [historicalSpeedafOrder.id, `${speedafDeliveryDate} 10:00:00`, `${speedafCompletionDate} 09:00:00`]
    )
    await db.query(
      `INSERT INTO order_payments (order_id, amount, payment_method, payment_date, reference, created_by, created_at)
       SELECT id, total_amount, 'bank_transfer', $2::date, 'P6-HISTORICAL-SPEEDAF', $3, $2::timestamp
       FROM orders WHERE id=$1`,
      [historicalSpeedafOrder.id, `${speedafCompletionDate} 09:00:00`, adminUser.id]
    )
    await db.query(
      `UPDATE orders
       SET status='collected_paid', payment_status='paid', paid_amount=total_amount,
           commission_completion_by=$3, commission_completion_at=$2::timestamp
       WHERE id=$1`,
      [historicalSpeedafOrder.id, `${speedafCompletionDate} 09:00:00`, adminUser.id]
    )
    await request('POST', '/commissions/retroactive', admin.accessToken, {
      date_from: speedafSaleDate,
      date_to: speedafSaleDate,
      apply: true,
      reason: 'Historical cross-month Speedaf completion test'
    })
    const speedafEarning = await row(
      `SELECT policy_date::text AS policy_date, qualification_date::text AS qualification_date,
              commission_month::text AS commission_month
       FROM commission_transactions
       WHERE order_id=$1 AND transaction_type='earned'`,
      [historicalSpeedafOrder.id]
    )
    assert.equal(speedafEarning.policy_date, speedafSaleDate)
    assert.equal(speedafEarning.qualification_date, speedafCompletionDate)
    assert.equal(speedafEarning.commission_month, '2026-09-01')

    const augustSpeedafCompleted = await request(
      'GET',
      `/dashboard/drilldown?card=my_completed_orders&date_from=${speedafDeliveryDate}&date_to=${speedafDeliveryDate}`,
      attendant.accessToken
    )
    assert.ok(!augustSpeedafCompleted.rows.some((item: any) => item.order_id === historicalSpeedafOrder.id))
    const septemberSpeedafCompleted = await request(
      'GET',
      `/dashboard/drilldown?card=my_completed_orders&date_from=${speedafCompletionDate}&date_to=${speedafCompletionDate}`,
      attendant.accessToken
    )
    const completedSpeedafRow = septemberSpeedafCompleted.rows.find((item: any) => item.order_id === historicalSpeedafOrder.id)
    assert.ok(completedSpeedafRow)
    assert.equal(String(completedSpeedafRow.delivery_date).slice(0, 10), speedafDeliveryDate)
    assert.equal(String(completedSpeedafRow.completion_date).slice(0, 10), speedafCompletionDate)
    assert.equal(completedSpeedafRow.commission_status, 'earned')

    const septemberCommissionDrilldown = await request(
      'GET',
      `/dashboard/drilldown?card=company_commission_recorded&date_from=${speedafCompletionDate}&date_to=${speedafCompletionDate}`,
      admin.accessToken
    )
    const speedafCommissionRow = septemberCommissionDrilldown.rows.find((item: any) => item.order_id === historicalSpeedafOrder.id)
    assert.ok(speedafCommissionRow)
    assert.equal(String(speedafCommissionRow.delivery_date).slice(0, 10), speedafDeliveryDate)
    assert.equal(String(speedafCommissionRow.completion_date).slice(0, 10), speedafCompletionDate)
    assert.equal(String(speedafCommissionRow.earned_date).slice(0, 10), speedafCompletionDate)

    const adminOrder = await createOrder({
      ...customer('Administrator Non Commission Sale'), delivery_type: 'walk_in', payment_method: 'cash',
      items: [internalItem(stockProduct.id, 1, 100)]
    }, admin.accessToken)
    await advance(adminOrder.id, ['confirmed', 'delivered'])
    assert.equal(await count(
      "SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'",
      [adminOrder.id]
    ), 0)
  })

  await t.test('16. commission month close is immutable and carries recovery into the next period', async () => {
    const closedMonth = '2020-01-01'
    const closedMonthEnd = '2020-01-31'
    const nextMonth = '2020-02-01'
    const programme = await row('SELECT id FROM commission_programmes ORDER BY effective_from DESC LIMIT 1')

    const approvedSource = await row(
      `INSERT INTO commission_transactions
        (programme_id, salesperson_id, amount, transaction_type, transaction_status,
         qualification_date, qualified_at, commission_month, reason, approved_by, approved_at, created_by)
       VALUES ($1, $2, 100, 'manual_add', 'approved', $3::date, $4::timestamp, $5::date,
               'Historical approved credit', $6, NOW(), $6)
       RETURNING *`,
      [programme.id, attendantUser.id, closedMonthEnd, `${closedMonthEnd} 12:00:00`, closedMonth, adminUser.id]
    )
    const pendingSource = await row(
      `INSERT INTO commission_transactions
        (programme_id, salesperson_id, amount, transaction_type, transaction_status,
         qualification_date, qualified_at, commission_month, reason, created_by)
       VALUES ($1, $2, 5, 'manual_add', 'pending', $3::date, $4::timestamp, $5::date,
               'Historical pending credit', $6)
       RETURNING *`,
      [programme.id, attendantUser.id, closedMonthEnd, `${closedMonthEnd} 13:00:00`, closedMonth, adminUser.id]
    )
    // Legacy payments without a transaction link must still reduce the close
    // balance; otherwise the operator could pay the same period twice.
    await db.query(
      `INSERT INTO commission_payments
        (salesperson_id, period_start, period_end, total_amount, paid_amount, payment_method,
         reference, paid_by, paid_at, notes, status, created_by)
       VALUES ($1, $2::date, $3::date, 150, 150, 'cash', 'P6-LEGACY-CLOSE', $4, NOW(),
               'Legacy period payment', 'paid', $4)`,
      [attendantUser.id, closedMonth, closedMonthEnd, adminUser.id]
    )

    await request('POST', '/commissions/periods/close', attendant.accessToken, {
      period: closedMonth, reason: 'Attendant must not close payroll'
    }, 403)
    await request('POST', '/commissions/periods/close', admin.accessToken, {
      period: closedMonth, reason: 'Pending item must be resolved first'
    }, 409)
    await request('POST', `/commissions/transactions/${pendingSource.id}/approve`, admin.accessToken, {})

    const closure = await request('POST', '/commissions/periods/close', admin.accessToken, {
      period: '2020-01', reason: 'Phase 6 audited historical month close'
    }, 201)
    assert.equal(closure.status, 'closed')
    assert.equal(closure.periodStart, closedMonth)
    assert.equal((await row('SELECT status FROM commission_period_closures WHERE id=$1', [closure.id])).status, 'closed')
    assert.equal(Number(closure.totalRecovery), 45)
    const attendantBalance = closure.balances.find((balance: any) => balance.salespersonId === attendantUser.id)
    assert.equal(Number(attendantBalance.closingBalance), -45)
    assert.ok(attendantBalance.sourceOffsetTransactionId)
    assert.ok(attendantBalance.carryForwardTransactionId)
    assert.equal(await count(
      `SELECT COUNT(*) FROM commission_transactions
       WHERE reference_id=$1 AND salesperson_id=$2 AND transaction_type='carry_forward'
         AND commission_month=$3::date AND carry_forward_direction='deduction'`,
      [closure.id, attendantUser.id, nextMonth]
    ), 1)
    assert.equal(await count(
      `SELECT COUNT(*) FROM commission_transactions
       WHERE reference_id=$1 AND salesperson_id=$2 AND transaction_type='carry_forward'
         AND commission_month=$3::date AND carry_forward_direction='credit'`,
      [closure.id, attendantUser.id, closedMonth]
    ), 1)
    await waitForAudit('commission_period_closed', closure.id)

    await request('GET', '/commissions/periods?limit=10', admin.accessToken)
    await request('POST', '/commissions/periods/close', admin.accessToken, {
      period: closedMonth, reason: 'Must not close twice'
    }, 409)
    await request('POST', '/commissions/periods/close', admin.accessToken, {
      period: '2020-03', reason: 'Must not skip the unclosed February period'
    }, 409)
    await request('POST', `/commissions/transactions/${approvedSource.id}/pay`, admin.accessToken, {
      payment_method: 'cash', reference: 'P6-CLOSED-PERIOD-BLOCK', idempotency_key: 'P6-CLOSED-PERIOD-BLOCK'
    }, 409)
    const closedLedgerProtection = await row(
      `SELECT ct.commission_month::text AS commission_month, closure.status
       FROM commission_transactions ct
       JOIN commission_period_closures closure ON closure.period_start = ct.commission_month
       WHERE ct.id = $1`,
      [approvedSource.id]
    )
    assert.equal(closedLedgerProtection.commission_month, closedMonth)
    assert.equal(closedLedgerProtection.status, 'closed')
    await assert.rejects(
      db.query('UPDATE commission_transactions SET reason=$2 WHERE id=$1', [approvedSource.id, 'must fail after close']),
      /closed/i
    )
    // The guard resolves any supplied date to its accounting month, so an
    // invalid intra-month period cannot bypass a January close.
    await assert.rejects(
      db.query(
        `INSERT INTO commission_transactions
          (programme_id, salesperson_id, amount, transaction_type, transaction_status,
           qualification_date, qualified_at, commission_month, reason, created_by)
         VALUES ($1, $2, 1, 'manual_add', 'pending', $3::date, $4::timestamp, $3::date,
                 'must fail after close', $5)`,
        [programme.id, attendantUser.id, closedMonthEnd, `${closedMonthEnd} 14:00:00`, adminUser.id]
      ),
      /closed/i
    )

    // The next month can only pay its new credit net of the carried recovery.
    const nextCredit = await row(
      `INSERT INTO commission_transactions
        (programme_id, salesperson_id, amount, transaction_type, transaction_status,
         qualification_date, qualified_at, commission_month, reason, approved_by, approved_at, created_by)
       VALUES ($1, $2, 100, 'manual_add', 'approved', $3::date, $4::timestamp, $3::date,
               'Next-period payable credit', $5, NOW(), $5)
       RETURNING *`,
      [programme.id, attendantUser.id, nextMonth, `${nextMonth} 12:00:00`, adminUser.id]
    )
    await request('POST', `/commissions/transactions/${nextCredit.id}/pay`, admin.accessToken, {
      amount: 56, payment_method: 'cash', reference: 'P6-CARRY-OVERPAY-BLOCK', idempotency_key: 'P6-CARRY-OVERPAY-BLOCK'
    }, 400)
    const carriedPayment = await request('POST', `/commissions/transactions/${nextCredit.id}/pay`, admin.accessToken, {
      amount: 55, payment_method: 'cash', reference: 'P6-CARRY-NET-PAY', idempotency_key: 'P6-CARRY-NET-PAY'
    })
    assert.equal(Number(carriedPayment.payment.paid_amount), 55)
  })

  await t.test('16b. commission month-end controls support external payroll settlement and guarded admin undo', async () => {
    const programme = await row('SELECT id FROM commission_programmes ORDER BY effective_from DESC LIMIT 1')

    const februaryReadiness = await request(
      'GET',
      '/commissions/periods/readiness?period=2020-02',
      admin.accessToken
    )
    assert.equal(februaryReadiness.periodStart, '2020-02-01')
    assert.equal(februaryReadiness.isReadyToClose, true)
    assert.equal(Number(februaryReadiness.totalApprovedCredits), 100)
    assert.equal(Number(februaryReadiness.totalApprovedDeductions), 45)
    assert.equal(Number(februaryReadiness.totalSettled), 55)
    assert.equal(Number(februaryReadiness.totalUnpaid), 0)
    assert.equal(Number(februaryReadiness.totalRecovery), 0)

    const februaryClosure = await request('POST', '/commissions/periods/close', admin.accessToken, {
      period: '2020-02', reason: 'Phase 6 zero-balance February close'
    }, 201)
    assert.equal(februaryClosure.status, 'closed')
    await request('POST', '/commissions/periods/reopen', attendant.accessToken, {
      period: '2020-02', reason: 'An attendant must not undo month close'
    }, 403)
    const reopened = await request('POST', '/commissions/periods/reopen', admin.accessToken, {
      period: '2020-02', reason: 'Phase 6 admin verifies the close before payroll handoff'
    })
    assert.equal(reopened.id, februaryClosure.id)
    assert.equal(reopened.status, 'reopened')
    assert.equal((await row(
      'SELECT status FROM commission_period_closures WHERE id=$1',
      [februaryClosure.id]
    )).status, 'reopened')
    assert.equal(await count(
      `SELECT COUNT(*) FROM commission_period_closure_balances WHERE closure_id=$1`,
      [februaryClosure.id]
    ), 0)
    await waitForAudit('commission_period_reopened', februaryClosure.id)

    const reclosed = await request('POST', '/commissions/periods/close', admin.accessToken, {
      period: '2020-02', reason: 'Phase 6 reviewed February reclose'
    }, 201)
    assert.equal(reclosed.id, februaryClosure.id)
    assert.equal(reclosed.status, 'closed')
    await request('POST', '/commissions/periods/reopen', admin.accessToken, {
      period: '2020-01', reason: 'Must not undo a month beneath a later closed period'
    }, 409)

    const payrollTransaction = await row(
      `INSERT INTO commission_transactions
        (programme_id, salesperson_id, amount, transaction_type, transaction_status,
         qualification_date, qualified_at, commission_month, reason, approved_by, approved_at, created_by)
       VALUES ($1, $2, 80, 'manual_add', 'approved', '2020-03-31', '2020-03-31 12:00:00', '2020-03-01',
               'External salary settlement test', $3, NOW(), $3)
       RETURNING *`,
      [programme.id, attendantUser.id, adminUser.id]
    )
    const payrollSettlement = await request(
      'POST',
      `/commissions/transactions/${payrollTransaction.id}/pay`,
      admin.accessToken,
      {
        payment_method: 'payroll',
        reference: 'SALARY-MAR-2020-P6',
        settled_at: '2020-04-02',
        idempotency_key: 'SALARY-MAR-2020-P6'
      }
    )
    assert.equal(payrollSettlement.payment.payment_method, 'payroll')
    assert.equal(Number(payrollSettlement.payment.paid_amount), 80)
    const storedSettlement = await row(
      `SELECT status, payment_method::text AS payment_method, paid_at::date::text AS settled_at
       FROM commission_payments WHERE id=$1`,
      [payrollSettlement.payment.id]
    )
    assert.equal(storedSettlement.payment_method, 'payroll')
    assert.equal(storedSettlement.settled_at, '2020-04-02')

    const marchCommissionSummary = await request(
      'GET', '/commissions/summary?date_from=2020-03-01&date_to=2020-03-31', admin.accessToken
    )
    assert.equal(Number(marchCommissionSummary.totalPayments), 80)
    assert.equal(Number(marchCommissionSummary.settledInPeriod), 0)
    const aprilCommissionSummary = await request(
      'GET', '/commissions/summary?date_from=2020-04-01&date_to=2020-04-30', admin.accessToken
    )
    assert.equal(Number(aprilCommissionSummary.settledInPeriod), 80)
    const aprilSettlements = await request(
      'GET', '/commissions/settlements?date_from=2020-04-01&date_to=2020-04-30', admin.accessToken
    )
    assert.equal(Number(aprilSettlements.totalAmount), 80)
    assert.ok(aprilSettlements.data.some((payment: any) => payment.id === payrollSettlement.payment.id && String(payment.commission_month).startsWith('2020-03')))
    const aprilSettlementDrilldown = await request(
      'GET', '/dashboard/drilldown?card=company_commission_paid&date_from=2020-04-01&date_to=2020-04-30', admin.accessToken
    )
    assert.ok(aprilSettlementDrilldown.rows.some((payment: any) => payment.payment_id === payrollSettlement.payment.id))

    await request('POST', `/commissions/transactions/${payrollTransaction.id}/revoke-approval`, admin.accessToken, {
      reason: 'Settlement must be voided first'
    }, 409)
    await request('POST', `/commissions/payments/${payrollSettlement.payment.id}/void`, attendant.accessToken, {
      reason: 'An attendant must not void a salary settlement'
    }, 403)
    const voided = await request('POST', `/commissions/payments/${payrollSettlement.payment.id}/void`, admin.accessToken, {
      reason: 'Salary sheet was entered against the wrong run'
    })
    assert.equal(voided.transaction.transaction_status, 'approved')
    assert.equal((await row(
      'SELECT status FROM commission_payments WHERE id=$1',
      [payrollSettlement.payment.id]
    )).status, 'voided')
    const revoked = await request('POST', `/commissions/transactions/${payrollTransaction.id}/revoke-approval`, admin.accessToken, {
      reason: 'Amount requires manager review'
    })
    assert.equal(revoked.transaction_status, 'pending')

    const marchReadiness = await request(
      'GET',
      '/commissions/periods/readiness?period=2020-03',
      admin.accessToken
    )
    assert.equal(marchReadiness.isReadyToClose, false)
    assert.equal(marchReadiness.pendingCount, 1)
    assert.equal(Number(marchReadiness.totalSettled), 0)

    const bulkApprovalRows = await db.query(
      `INSERT INTO commission_transactions
        (programme_id, salesperson_id, amount, transaction_type, transaction_status,
         qualification_date, qualified_at, commission_month, reason, created_by)
       VALUES
         ($1, $2, 30, 'manual_add', 'pending', '2020-03-31', '2020-03-31 12:15:00', '2020-03-01', 'Bulk approval one', $3),
         ($1, $2, 40, 'manual_add', 'pending', '2020-03-31', '2020-03-31 12:30:00', '2020-03-01', 'Bulk approval two', $3),
         ($1, $2, 50, 'manual_add', 'pending', '2020-03-31', '2020-03-31 12:45:00', '2020-03-01', 'Bulk approval rollback', $3)
       RETURNING id, amount`,
      [programme.id, attendantUser.id, adminUser.id]
    )
    const bulkApproved = await request('POST', '/commissions/bulk-approve', admin.accessToken, {
      transaction_ids: [bulkApprovalRows.rows[0].id, bulkApprovalRows.rows[1].id]
    })
    assert.equal(bulkApproved.approvedCount, 2)
    assert.equal(await count(
      `SELECT COUNT(*) FROM commission_transactions
       WHERE id=ANY($1::uuid[]) AND transaction_status='approved'`,
      [[bulkApprovalRows.rows[0].id, bulkApprovalRows.rows[1].id]]
    ), 2)
    await request('POST', '/commissions/bulk-approve', admin.accessToken, {
      transaction_ids: [bulkApprovalRows.rows[2].id, '00000000-0000-0000-0000-000000000000']
    }, 409)
    assert.equal((await row(
      'SELECT transaction_status FROM commission_transactions WHERE id=$1',
      [bulkApprovalRows.rows[2].id]
    )).transaction_status, 'pending')

    const bulkCandidate = await row(
      `INSERT INTO commission_transactions
        (programme_id, salesperson_id, amount, transaction_type, transaction_status,
         qualification_date, qualified_at, commission_month, reason, approved_by, approved_at, created_by)
       VALUES ($1, $2, 25, 'manual_add', 'approved', '2020-03-31', '2020-03-31 13:00:00', '2020-03-01',
               'Atomic salary batch test', $3, NOW(), $3)
       RETURNING *`,
      [programme.id, attendantUser.id, adminUser.id]
    )
    await request('POST', '/commissions/bulk-pay', admin.accessToken, {
      transaction_ids: [bulkCandidate.id, '00000000-0000-0000-0000-000000000000'],
      payment_method: 'payroll',
      reference: 'SALARY-MAR-2020-ATOMIC-P6',
      settled_at: '2020-03-31',
      idempotency_key: 'SALARY-MAR-2020-ATOMIC-P6'
    }, 404)
    assert.equal(await count(
      `SELECT COUNT(*) FROM commission_payments
       WHERE commission_transaction_id=$1 AND status <> 'voided'`,
      [bulkCandidate.id]
    ), 0)
    assert.equal((await row(
      'SELECT transaction_status FROM commission_transactions WHERE id=$1',
      [bulkCandidate.id]
    )).transaction_status, 'approved')
  })

  await t.test('17. legacy category gaps still apply only deterministic return reversals', async () => {
    const legacyCategory = await row("INSERT INTO categories (name) VALUES ('Legacy evidence category') RETURNING id")
    const legacyProgramme = await row(
      `SELECT id FROM commission_programmes
       WHERE status = 'active'
       ORDER BY effective_from DESC, created_at DESC, id DESC LIMIT 1`
    )
    await db.query(
      `INSERT INTO commission_rates
        (programme_id, rate_per_item, effective_from, scope_type, scope_id, scope_name, created_by)
       VALUES ($1, 75, $2::date, 'category', $3, 'Legacy evidence category', $4)`,
      [legacyProgramme.id, isoDate(), legacyCategory.id, adminUser.id]
    )

    async function createLegacyEarning(label: string, itemQuantity = 3, recordedQuantity = itemQuantity) {
      const order = await createOrder({
        ...customer(`Legacy reconciliation ${label}`),
        delivery_type: 'walk_in',
        payment_method: 'cash',
        items: [internalItem(stockProduct.id, itemQuantity, 100)]
      }, attendant.accessToken)
      await advance(order.id, ['confirmed', 'delivered'])
      const item = await row('SELECT id FROM order_items WHERE order_id = $1', [order.id])
      const earned = await row(
        `SELECT id, eligible_quantity, rate_per_item, amount, qualification_date::text AS qualification_date
         FROM commission_transactions
         WHERE order_id = $1 AND transaction_type = 'earned'
         ORDER BY created_at DESC LIMIT 1`,
        [order.id]
      )
      assert.ok(earned, `Expected a recorded earning for ${label}`)
      if (recordedQuantity !== itemQuantity) {
        await db.query(
          `UPDATE commission_transactions
           SET eligible_quantity = $2::integer, amount = rate_per_item * $3::numeric
           WHERE id = $1`,
          [earned.id, recordedQuantity, recordedQuantity]
        )
        earned.eligible_quantity = recordedQuantity
        earned.amount = Number(earned.rate_per_item) * recordedQuantity
      }
      await db.query(
        'UPDATE order_items SET product_category_snapshot_verified = FALSE WHERE id = $1',
        [item.id]
      )
      const legacyEvaluation = await evaluateOrderItemFromRecords(order.id, item.id)
      assert.equal(legacyEvaluation.categorySnapshotVerified, false)
      assert.match(legacyEvaluation.reason || '', /historic product category snapshot/i)
      return { order, item, earned }
    }

    async function assertDeterministicReversal(
      label: string,
      expectedQuantity: number,
      applyEvidence: (caseData: Awaited<ReturnType<typeof createLegacyEarning>>) => Promise<void>,
      options: { itemQuantity?: number; recordedQuantity?: number } = {}
    ) {
      const caseData = await createLegacyEarning(
        label,
        options.itemQuantity ?? 3,
        options.recordedQuantity ?? options.itemQuantity ?? 3
      )
      await applyEvidence(caseData)
      const qualificationDate = caseData.earned.qualification_date
      const preview = await request('POST', '/commissions/retroactive', admin.accessToken, {
        date_from: qualificationDate, date_to: qualificationDate, apply: false
      })
      const issue = preview.issues.find((entry: any) => entry.transactionId === caseData.earned.id)
      assert.equal(issue?.type, 'missing_reversal', `Expected a deterministic reversal issue for ${label}: ${JSON.stringify(issue)}`)

      // Two administrators can launch a correction at nearly the same time;
      // the earned-row lock must still leave exactly one counter-entry.
      await Promise.all(['A', 'B'].map(run => request('POST', '/commissions/retroactive', admin.accessToken, {
        date_from: qualificationDate,
        date_to: qualificationDate,
        apply: true,
        reason: `Phase 6 legacy ${label} correction ${run}`
      })))
      const reversals = await db.query(
        `SELECT eligible_quantity, rate_per_item, amount
         FROM commission_transactions
         WHERE original_transaction_id = $1 AND transaction_type = 'reversal'
         ORDER BY created_at ASC`,
        [caseData.earned.id]
      )
      assert.equal(reversals.rows.length, 1, `${label} should create exactly one proportional reversal`)
      assert.equal(Number(reversals.rows[0].eligible_quantity), expectedQuantity)
      assert.equal(Number(reversals.rows[0].rate_per_item), Number(caseData.earned.rate_per_item))
      assert.equal(Number(reversals.rows[0].amount), Number(caseData.earned.rate_per_item) * expectedQuantity)

      // A repeated apply may review the same legacy evidence but must never
      // create a duplicate reversal.
      await request('POST', '/commissions/retroactive', admin.accessToken, {
        date_from: qualificationDate,
        date_to: qualificationDate,
        apply: true,
        reason: `Phase 6 repeat legacy ${label} correction`
      })
      assert.equal(await count(
        "SELECT COUNT(*) FROM commission_transactions WHERE original_transaction_id=$1 AND transaction_type='reversal'",
        [caseData.earned.id]
      ), 1)
    }

    await assertDeterministicReversal('partial return', 1, async ({ item }) => {
      await db.query('UPDATE order_items SET returned_quantity = 1 WHERE id = $1', [item.id])
    })
    await assertDeterministicReversal('full returned order', 3, async ({ order }) => {
      await db.query("UPDATE orders SET status = 'returned' WHERE id = $1", [order.id])
    })
    await assertDeterministicReversal('cancelled order', 3, async ({ order }) => {
      await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [order.id])
    })
    await assertDeterministicReversal('full refund', 3, async ({ order }) => {
      await db.query(
        `INSERT INTO order_refunds (order_id, amount, reason, created_by)
         VALUES ($1, 300, 'Legacy reconciliation refund evidence', $2)`,
        [order.id, adminUser.id]
      )
    })

    // A partial return cannot prove that a historically limited earning was
    // among the returned units.  It must remain review-only rather than
    // reversing more than the lower-bound evidence supports.
    const ambiguous = await createLegacyEarning('ambiguous partial return', 4, 1)
    await db.query('UPDATE order_items SET returned_quantity = 2 WHERE id = $1', [ambiguous.item.id])
    await request('POST', '/commissions/retroactive', admin.accessToken, {
      date_from: ambiguous.earned.qualification_date,
      date_to: ambiguous.earned.qualification_date,
      apply: true,
      reason: 'Phase 6 conservative legacy partial-return check'
    })
    assert.equal(await count(
      "SELECT COUNT(*) FROM commission_transactions WHERE original_transaction_id=$1 AND transaction_type='reversal'",
      [ambiguous.earned.id]
    ), 0)

    const partialRefund = await createLegacyEarning('partial refund')
    await db.query(
      `INSERT INTO order_refunds (order_id, amount, reason, created_by)
       VALUES ($1, 100, 'Partial refund is not full invalidation evidence', $2)`,
      [partialRefund.order.id, adminUser.id]
    )
    await request('POST', '/commissions/retroactive', admin.accessToken, {
      date_from: partialRefund.earned.qualification_date,
      date_to: partialRefund.earned.qualification_date,
      apply: true,
      reason: 'Phase 6 conservative legacy partial-refund check'
    })
    assert.equal(await count(
      "SELECT COUNT(*) FROM commission_transactions WHERE original_transaction_id=$1 AND transaction_type='reversal'",
      [partialRefund.earned.id]
    ), 0)
  })

  await t.test('18. authoritative invalidity overrides a partial-return correction', async () => {
    await request('POST', '/commissions/programme', admin.accessToken, {
      status: 'disabled',
      effective_from: isoDate(),
      reason: 'Phase 6 authoritative invalidity reconciliation test'
    }, 201)
    const disabledOrder = await createOrder({
      ...customer('Disabled programme partial return'),
      delivery_type: 'walk_in',
      payment_method: 'cash',
      items: [internalItem(stockProduct.id, 3, 100)]
    }, attendant.accessToken)
    await advance(disabledOrder.id, ['confirmed', 'delivered'])

    const disabledItem = await row(
      `SELECT id, product_id, product_category_id, product_category_snapshot_verified
       FROM order_items WHERE order_id = $1`,
      [disabledOrder.id]
    )
    assert.equal(disabledItem.product_category_snapshot_verified, true)
    assert.equal(await count(
      "SELECT COUNT(*) FROM commission_transactions WHERE order_id=$1 AND transaction_type='earned'",
      [disabledOrder.id]
    ), 0)
    const disabledEvaluation = await evaluateOrderItemFromRecords(disabledOrder.id, disabledItem.id)
    assert.equal(disabledEvaluation.categorySnapshotVerified, true)
    assert.match(disabledEvaluation.reason || '', /programme was disabled/i)

    const disabledProgramme = await row(
      `SELECT id FROM commission_programmes WHERE status = 'disabled'
       ORDER BY effective_from DESC, created_at DESC, id DESC LIMIT 1`
    )
    const invalidEarning = await row(
      `INSERT INTO commission_transactions
        (programme_id, salesperson_id, order_id, order_item_id, product_id, category_id,
         eligible_quantity, rate_per_item, amount, transaction_type, transaction_status,
         qualification_date, qualified_at, commission_month, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 3, 50, 150, 'earned', 'pending',
               $7::date, $8::timestamp, $9::date, 'Legacy earning recorded while disabled', $10)
       RETURNING id`,
      [
        disabledProgramme.id,
        attendantUser.id,
        disabledOrder.id,
        disabledItem.id,
        disabledItem.product_id,
        disabledItem.product_category_id || null,
        disabledEvaluation.qualificationDate,
        disabledEvaluation.qualificationAt,
        `${disabledEvaluation.qualificationDate!.slice(0, 7)}-01`,
        adminUser.id
      ]
    )
    await db.query('UPDATE order_items SET returned_quantity = 1 WHERE id = $1', [disabledItem.id])

    const preview = await request('POST', '/commissions/retroactive', admin.accessToken, {
      date_from: disabledEvaluation.qualificationDate,
      date_to: disabledEvaluation.qualificationDate,
      apply: false
    })
    const issue = preview.issues.find((entry: any) => entry.transactionId === invalidEarning.id)
    assert.equal(issue?.type, 'missing_reversal')
    assert.match(issue?.message || '', /disabled/i)
    await Promise.all(['A', 'B'].map(run => request('POST', '/commissions/retroactive', admin.accessToken, {
      date_from: disabledEvaluation.qualificationDate,
      date_to: disabledEvaluation.qualificationDate,
      apply: true,
      reason: `Phase 6 disabled partial-return correction ${run}`
    })))
    const reversals = await db.query(
      `SELECT eligible_quantity, rate_per_item, amount
       FROM commission_transactions
       WHERE original_transaction_id = $1 AND transaction_type = 'reversal'`,
      [invalidEarning.id]
    )
    assert.equal(reversals.rows.length, 1)
    assert.equal(Number(reversals.rows[0].eligible_quantity), 3)
    assert.equal(Number(reversals.rows[0].rate_per_item), 50)
    assert.equal(Number(reversals.rows[0].amount), 150)
  })

  await t.test('19. a backdated first activation retires only the generated disabled placeholder', async () => {
    const placeholder = await row(
      `INSERT INTO commission_programmes
         (status, effective_from, reason, created_at, updated_at)
       VALUES
         ('disabled', '2050-02-01 10:00:00',
          'Initial KSh 50 commission configuration; activate only after management review.',
          NOW(), NOW())
       RETURNING id`
    )
    await db.query(
      `INSERT INTO commission_rates
         (programme_id, rate_per_item, effective_from, scope_type, scope_name, created_at)
       VALUES ($1, 50, '2049-01-01', 'global', 'Initial default rate', NOW())`,
      [placeholder.id]
    )

    const activation = await request('POST', '/commissions/programme', admin.accessToken, {
      status: 'active',
      effective_from: '2049-01-01',
      reason: 'Backdated initial activation test'
    }, 201)

    const retiredPlaceholder = await row(
      `SELECT effective_from::text, effective_to::text
       FROM commission_programmes WHERE id = $1`,
      [placeholder.id]
    )
    assert.equal(retiredPlaceholder.effective_to, retiredPlaceholder.effective_from)

    const selectedAfterPlaceholder = await row(
      `SELECT id, status
       FROM commission_programmes
       WHERE effective_from <= '2050-03-01'::timestamp
         AND (effective_to IS NULL OR effective_to >= '2050-03-01'::timestamp)
       ORDER BY effective_from DESC, created_at DESC, id DESC
       LIMIT 1`
    )
    assert.equal(selectedAfterPlaceholder.id, activation.id)
    assert.equal(selectedAfterPlaceholder.status, 'active')

    const deliberateDisabled = await row(
      `SELECT COUNT(*)::int AS count
       FROM commission_programmes
       WHERE status = 'disabled'
         AND created_by IS NOT NULL
         AND effective_to IS NULL`
    )
    assert.ok(deliberateDisabled.count > 0)
  })

  await t.test('20. accounting cutover and trial balance stay balanced after a sale', async () => {
    const before = await request('GET', '/reports/trial-balance/status', admin.accessToken)
    assert.equal(before.enabled, false)
    assert.ok(Number(before.suggestedBalances.inventory) > 0)

    const today = isoDate()
    const activated = await request('POST', '/reports/trial-balance/activate', admin.accessToken, {
      cutover_date: today,
      cash: 1000,
      mpesa: 500,
      bank: 250
    }, 201)
    assert.equal(activated.enabled, true)
    assert.equal(activated.cutoverDate, today)
    await request('POST', '/reports/trial-balance/activate', admin.accessToken, {
      cutover_date: today,
      cash: 1000,
      mpesa: 500,
      bank: 250
    }, 409)

    const order = await createOrder({
      ...customer('Trial Balance'),
      delivery_type: 'walk_in',
      payment_method: 'cash',
      items: [internalItem(stockProduct.id, 1, 175)]
    })
    await advance(order.id, ['confirmed', 'delivered'])

    const report = await request(
      'GET',
      `/reports/trial-balance?date_from=${today}&date_to=${today}`,
      admin.accessToken
    )
    assert.equal(report.enabled, true)
    assert.equal(report.totals.isBalanced, true)
    assert.equal(Number(report.totals.difference), 0)
    assert.equal(Number(report.totals.periodDebit), Number(report.totals.periodCredit))
    assert.ok(report.rows.some((entry: any) => entry.code === '1000'))
    assert.ok(report.rows.some((entry: any) => entry.code === '4000'))
    assert.ok(report.rows.some((entry: any) => entry.code === '5000'))
    assert.ok(report.rows.some((entry: any) => entry.code === '1200'))

    const correctionOrder = await createOrder({
      ...customer('Trial Balance Correction'),
      delivery_type: 'walk_in',
      payment_method: 'mpesa',
      items: [internalItem(stockProduct.id, 1, 225)]
    })
    await advance(correctionOrder.id, ['confirmed', 'delivered'])
    await request('POST', `/orders/${correctionOrder.id}/status-correction`, admin.accessToken, {
      target_status: 'confirmed',
      reason: 'Admin test correction for an order completed before customer collection'
    })
    assert.equal(await count(
      `SELECT COUNT(*) FROM journal_entries WHERE source_type='order' AND source_id=$1 AND source_event='sale_reversed'`,
      [correctionOrder.id]
    ), 1)
    assert.equal(await count('SELECT COUNT(*) FROM order_payments WHERE order_id=$1', [correctionOrder.id]), 1)
    await advance(correctionOrder.id, ['delivered'])
    for (const event of ['sale_recognized', 'sale_reversed', 'sale_recognized_2']) {
      assert.equal(await count(
        `SELECT COUNT(*) FROM journal_entries WHERE source_type='order' AND source_id=$1 AND source_event=$2`,
        [correctionOrder.id, event]
      ), 1)
    }

    const afterCorrectionCycle = await request(
      'GET',
      `/reports/trial-balance?date_from=${today}&date_to=${today}`,
      admin.accessToken
    )
    assert.equal(afterCorrectionCycle.totals.isBalanced, true)
    assert.equal(Number(afterCorrectionCycle.totals.difference), 0)

    await request('PUT', `/orders/${order.id}/status`, admin.accessToken, {
      status: 'returned',
      notes: 'Trial-balance full return'
    })
    const refund = await row(`SELECT id FROM order_refunds WHERE order_id=$1 AND status='pending'`, [order.id])
    await request('POST', `/orders/refunds/${refund.id}/pay`, admin.accessToken, {
      payment_method: 'cash',
      reference: 'TB-RETURN-REFUND'
    })
    for (const event of ['refund_due', 'converted_to_sale_reversal', 'paid']) {
      assert.equal(await count(
        `SELECT COUNT(*) FROM journal_entries WHERE source_type='order_refund' AND source_id=$1 AND source_event=$2`,
        [refund.id, event]
      ), 1)
    }
    assert.equal(await count(
      `SELECT COUNT(*) FROM journal_entries WHERE source_type='order' AND source_id=$1 AND source_event='sale_reversed'`,
      [order.id]
    ), 1)

    const afterReturn = await request(
      'GET',
      `/reports/trial-balance?date_from=${today}&date_to=${today}`,
      admin.accessToken
    )
    assert.equal(afterReturn.totals.isBalanced, true)
    assert.equal(Number(afterReturn.totals.difference), 0)

    const unbalanced = await count(`
      SELECT COUNT(*) FROM (
        SELECT je.id
        FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id
        GROUP BY je.id
        HAVING ABS(SUM(jl.debit)-SUM(jl.credit)) >= 0.005
      ) entries
    `)
    assert.equal(unbalanced, 0)
  })
})

await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
await appPool?.end()
await db.end()
await adminPool.query(`DROP DATABASE ${testDatabase} WITH (FORCE)`)
await adminPool.query('DROP DATABASE IF EXISTS dlight_pos_phase6_probe')
await adminPool.end()
