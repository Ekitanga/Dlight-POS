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
  'database/production_stabilization_phase1.sql',
  'database/permissions_migration.sql',
  'database/production_stabilization_permissions.sql'
]) {
  await db.query(await fs.readFile(path.join(root, file), 'utf8'))
}

const password = 'Phase6-Test-Password!'
const passwordHash = await bcrypt.hash(password, 4)
const users = await db.query(
  `INSERT INTO users (email, password_hash, full_name, role) VALUES
   ('admin.phase6@dlight.test', $1, 'Phase 6 Admin', 'admin'),
   ('owner.phase6@dlight.test', $1, 'Phase 6 Owner', 'owner'),
   ('attendant.phase6@dlight.test', $1, 'Phase 6 Attendant', 'attendant')
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
      OR (p.module = 'cod' AND p.action = 'view')`,
  [attendantUser.id, adminUser.id]
)
await db.query(
  `INSERT INTO settings (company_name, currency, tax_rate, order_prefix)
   VALUES ('Dlight Phase 6', 'KES', 0, 'TST')`
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
    order = await request('PUT', `/orders/${orderId}/status`, admin.accessToken, { status, ...extra })
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

  await t.test('5. Speedaf COD lifecycle and remittance', async () => {
    const order = await createOrder({
      ...customer('COD'), delivery_type: 'courier', courier_id: courier.id,
      courier_tracking_number: 'SPD-P6-COD', courier_payment_type: 'cod',
      customer_delivery_fee: 200, actual_courier_fee: 150, payment_method: 'mpesa',
      items: [internalItem(stockProduct.id, 1, 1000)]
    })
    assert.equal(order.payment_status, 'partially_paid')
    assert.equal(Number(order.paid_amount), 200)
    assert.equal(order.delivery_fee_payment_method, 'mpesa')
    assert.equal(Number(order.delivery_fee_paid_amount), 200)
    assert.equal(await count('SELECT COUNT(*) FROM order_payments WHERE order_id=$1 AND amount=200 AND payment_method=$2', [order.id, 'mpesa']), 1)
    assert.equal(await count('SELECT COUNT(*) FROM cod_collections WHERE order_id=$1 AND cod_amount=1000', [order.id]), 1)
    await advance(order.id, ['confirmed', 'in_transit', 'delivered'])
    assert.equal((await row('SELECT status FROM cod_collections WHERE order_id=$1', [order.id])).status, 'delivered_awaiting_remittance')
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
    assert.equal(await count('SELECT COUNT(*) FROM cod_remittances WHERE order_id=$1', [order.id]), 2)
    await waitForAudit('cod_remittance_recorded', order.id)
    await assertGlobalIntegrity()
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
    await request('PUT', `/orders/${attendantOrder.id}`, admin.accessToken, {
      ...customer('Admin Late Edit'),
      delivery_type: 'walk_in',
      payment_method: 'cash',
      sale_date: isoDate(),
      items: [internalItem(stockProduct.id, 1, 100)]
    }, 409)
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
})

await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
await appPool?.end()
await db.end()
await adminPool.query(`DROP DATABASE ${testDatabase} WITH (FORCE)`)
await adminPool.query('DROP DATABASE IF EXISTS dlight_pos_phase6_probe')
await adminPool.end()
