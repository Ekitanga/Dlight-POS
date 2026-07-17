import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

dotenv.config()

const { Pool } = pg

const batch = process.env.DLIGHT_DUMMY_BATCH || `DUMMY-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`
const marker = `[DUMMY_BATCH:${batch}]`
const today = process.env.DLIGHT_DUMMY_DATE || new Date().toISOString().slice(0, 10)
const safeBatch = batch.replace(/[^a-zA-Z0-9_-]/g, '_')

function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Set it in .env or in your shell before running this script.')
  }

  const databaseUrl = new URL(process.env.DATABASE_URL)
  const sslMode = databaseUrl.searchParams.get('sslmode') || process.env.PGSSLMODE
  const databaseSsl = process.env.DATABASE_SSL
  const useSsl =
    databaseSsl === 'true' ||
    (process.env.NODE_ENV === 'production' &&
      databaseSsl !== 'false' &&
      sslMode !== 'disable' &&
      databaseUrl.hostname !== 'db')

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false
  })
}

function money(value) {
  return Math.max(0, Math.round(Number(value || 0)))
}

function supplierCostFor(product) {
  const storedCost = Number(product.cost_price || 0)
  const sellingPrice = Number(product.selling_price || 0)
  return money(storedCost > 0 ? storedCost : sellingPrice * 0.65)
}

function orderNo(suffix) {
  const compact = batch.replace(/[^0-9a-zA-Z]/g, '').slice(-10)
  return `DUMMY-${compact}-${suffix}`.slice(0, 100)
}

async function one(client, sql, params = [], label = 'record') {
  const result = await client.query(sql, params)
  if (!result.rows[0]) throw new Error(`Missing required ${label}`)
  return result.rows[0]
}

async function insertCustomer(client, { name, phone, address }) {
  const notes = `${marker} Test customer created for workflow simulation.`
  const existing = await client.query(`SELECT id FROM customers WHERE normalized_phone = $1 FOR UPDATE`, [phone])

  if (existing.rows[0]) {
    return one(
      client,
      `
        UPDATE customers
        SET name = $1, phone = $2, address = $3, notes = $4, updated_at = NOW()
        WHERE id = $5
        RETURNING id, name, phone
      `,
      [name, phone, address, notes, existing.rows[0].id],
      'customer'
    )
  }

  return one(
    client,
    `
      INSERT INTO customers (name, phone, normalized_phone, address, notes)
      VALUES ($1, $2, $2, $3, $4)
      RETURNING id, name, phone
    `,
    [name, phone, address, notes],
    'customer'
  )
}

async function insertOrder(client, data) {
  return one(
    client,
    `
      INSERT INTO orders (
        order_number, customer_id, delivery_type, delivery_fee, rider_id, courier_id,
        courier_tracking_number, courier_payment_type, delivery_address, status,
        payment_status, subtotal, total_amount, paid_amount, delivery_income,
        delivery_fee_payment_method, delivery_fee_paid_amount, courier_customer_fee,
        courier_actual_fee, delivery_cost, notes, created_by, confirmed_by, sale_date
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18,
        $19, $20, $21, $22, $22, $23
      )
      RETURNING id, order_number
    `,
    [
      data.orderNumber,
      data.customerId,
      data.deliveryType,
      data.deliveryFee,
      data.riderId || null,
      data.courierId || null,
      data.trackingNumber || null,
      data.courierPaymentType || null,
      data.deliveryAddress,
      data.status,
      data.paymentStatus,
      data.subtotal,
      data.totalAmount,
      data.paidAmount,
      data.deliveryIncome,
      data.deliveryFeePaymentMethod || null,
      data.deliveryFeePaidAmount || 0,
      data.courierCustomerFee || 0,
      data.courierActualFee || 0,
      data.deliveryCost,
      `${marker} ${data.notes}`,
      data.createdBy,
      data.saleDate
    ],
    'order'
  )
}

async function insertInternalItem(client, order, product, quantity, unitPrice, createdBy) {
  const unitCost = money(product.cost_price)
  const total = money(unitPrice * quantity)
  await client.query(
    `
      INSERT INTO order_items (
        order_id, product_id, quantity, internal_quantity, supplier_quantity,
        unit_cost, supplier_cost, unit_price, total_price, fulfillment_type, fulfillment_status
      )
      VALUES ($1, $2, $3, $3, 0, $4, 0, $5, $6, 'internal', 'fulfilled')
    `,
    [order.id, product.id, quantity, unitCost, unitPrice, total]
  )

  await client.query(
    `UPDATE inventory SET quantity = quantity - $1, last_updated = NOW() WHERE product_id = $2`,
    [quantity, product.id]
  )
  await client.query(
    `
      INSERT INTO inventory_movements (product_id, type, quantity, reference_id, reference_type, notes, created_by)
      VALUES ($1, 'stock_out', $2, $3, 'order', $4, $5)
    `,
    [product.id, quantity, order.id, `${marker} Dummy internal-stock order stock-out.`, createdBy]
  )
}

async function insertSupplierItem(client, order, product, supplier, quantity, unitPrice, supplierCost, createdBy) {
  const total = money(unitPrice * quantity)
  const supplierAmount = money(supplierCost * quantity)
  const item = await one(
    client,
    `
      INSERT INTO order_items (
        order_id, product_id, supplier_id, quantity, internal_quantity, supplier_quantity,
        unit_cost, supplier_cost, unit_price, total_price, fulfillment_type, fulfillment_status
      )
      VALUES ($1, $2, $3, $4, 0, $4, 0, $5, $6, $7, 'supplier', 'assigned')
      RETURNING id
    `,
    [order.id, product.id, supplier.id, quantity, supplierCost, unitPrice, total],
    'supplier order item'
  )

  const payable = await one(
    client,
    `
      INSERT INTO supplier_payables (supplier_id, order_id, order_item_id, amount, description, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `,
    [supplier.id, order.id, item.id, supplierAmount, `${marker} Dummy supplier payable for ${product.name}.`, createdBy],
    'supplier payable'
  )

  await client.query(`UPDATE order_items SET payable_id = $1 WHERE id = $2`, [payable.id, item.id])
  await client.query(`UPDATE suppliers SET balance = balance + $1, updated_at = NOW() WHERE id = $2`, [
    supplierAmount,
    supplier.id
  ])
}

async function insertPayment(client, order, amount, method, createdBy, referenceSuffix) {
  await client.query(
    `
      INSERT INTO order_payments (order_id, amount, payment_method, payment_date, reference, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [order.id, amount, method, today, `${marker} ${referenceSuffix}`, createdBy]
  )
}

async function main() {
  const pool = createPool()
  const client = await pool.connect()
  const created = { batch, marker, businessDate: today, orders: [], customers: [], ledgers: [], expenses: [] }

  try {
    await client.query('BEGIN')

    const actor = await one(
      client,
      `
        SELECT id, email
        FROM users
        WHERE is_active = true
        ORDER BY CASE WHEN role IN ('owner', 'admin') THEN 0 ELSE 1 END, created_at
        LIMIT 1
      `,
      [],
      'active user'
    )

    const internalProducts = (
      await client.query(
        `
          SELECT p.id, p.name, p.selling_price, p.cost_price, i.quantity, i.reserved_quantity
          FROM products p
          JOIN inventory i ON i.product_id = p.id
          WHERE p.deleted_at IS NULL
            AND p.is_active = true
            AND (i.quantity - i.reserved_quantity) > 0
            AND p.selling_price > 0
          ORDER BY (i.quantity - i.reserved_quantity) DESC, p.name
          LIMIT 2
        `
      )
    ).rows

    if (internalProducts.length < 1) {
      throw new Error('No existing product with available shop stock was found. Add stock first, then rerun.')
    }

    const supplierProduct = await one(
      client,
      `
        SELECT id, name, selling_price, cost_price
        FROM products
        WHERE deleted_at IS NULL AND is_active = true AND selling_price > 0
        ORDER BY is_dropship DESC, selling_price DESC, name
        LIMIT 1
      `,
      [],
      'existing product for supplier fulfillment'
    )
    const supplier = await one(client, `SELECT id, name FROM suppliers WHERE is_active = true ORDER BY name LIMIT 1`, [], 'active supplier')
    const rider = await one(client, `SELECT id, name FROM riders WHERE is_active = true ORDER BY name LIMIT 1`, [], 'active rider')
    const courier = await one(
      client,
      `
        SELECT id, name
        FROM couriers
        WHERE is_active = true
        ORDER BY CASE WHEN LOWER(name) LIKE '%speedaf%' THEN 0 ELSE 1 END, name
        LIMIT 1
      `,
      [],
      'active courier'
    )

    const customers = {
      walkin: await insertCustomer(client, {
        name: 'DUMMY Walk-in Customer',
        phone: `0709${Date.now().toString().slice(-6)}`,
        address: 'DUMMY Walk-in counter'
      }),
      rider: await insertCustomer(client, {
        name: 'DUMMY Rider Customer',
        phone: `0710${Date.now().toString().slice(-6)}`,
        address: 'DUMMY Kilimani rider delivery'
      }),
      supplier: await insertCustomer(client, {
        name: 'DUMMY Supplier Fulfilled Customer',
        phone: `0711${Date.now().toString().slice(-6)}`,
        address: 'DUMMY Supplier dispatch'
      }),
      cod: await insertCustomer(client, {
        name: 'DUMMY Speedaf COD Customer',
        phone: `0712${Date.now().toString().slice(-6)}`,
        address: 'DUMMY Nairobi COD'
      }),
      credit: await insertCustomer(client, {
        name: 'DUMMY Credit Customer',
        phone: `0713${Date.now().toString().slice(-6)}`,
        address: 'DUMMY Customer credit'
      })
    }
    created.customers = Object.values(customers).map((customer) => ({ id: customer.id, name: customer.name, phone: customer.phone }))

    const internalOne = internalProducts[0]
    const internalTwo = internalProducts[1] || internalProducts[0]
    const walkinSubtotal = money(internalOne.selling_price)
    const walkin = await insertOrder(client, {
      orderNumber: orderNo('WALK'),
      customerId: customers.walkin.id,
      deliveryType: 'walk_in',
      deliveryFee: 0,
      deliveryAddress: customers.walkin.address,
      status: 'delivered',
      paymentStatus: 'paid',
      subtotal: walkinSubtotal,
      totalAmount: walkinSubtotal,
      paidAmount: walkinSubtotal,
      deliveryIncome: 0,
      deliveryCost: 0,
      notes: 'Walk-in cash sale.',
      createdBy: actor.id,
      saleDate: today
    })
    await insertInternalItem(client, walkin, internalOne, 1, walkinSubtotal, actor.id)
    await insertPayment(client, walkin, walkinSubtotal, 'cash', actor.id, 'cash payment')
    created.orders.push({ order_number: walkin.order_number, scenario: 'Walk-in cash sale' })

    const riderSubtotal = money(internalTwo.selling_price)
    const riderFee = 300
    const riderOrder = await insertOrder(client, {
      orderNumber: orderNo('RIDER'),
      customerId: customers.rider.id,
      deliveryType: 'rider',
      deliveryFee: riderFee,
      riderId: rider.id,
      deliveryAddress: customers.rider.address,
      status: 'delivered',
      paymentStatus: 'paid',
      subtotal: riderSubtotal,
      totalAmount: riderSubtotal + riderFee,
      paidAmount: riderSubtotal + riderFee,
      deliveryIncome: riderFee,
      deliveryFeePaymentMethod: 'cash',
      deliveryFeePaidAmount: riderFee,
      deliveryCost: riderFee,
      notes: `Rider delivery assigned to ${rider.name}.`,
      createdBy: actor.id,
      saleDate: today
    })
    await insertInternalItem(client, riderOrder, internalTwo, 1, riderSubtotal, actor.id)
    await insertPayment(client, riderOrder, riderSubtotal + riderFee, 'cash', actor.id, 'rider delivery cash payment')
    const riderDelivery = await one(
      client,
      `
        INSERT INTO deliveries (order_id, rider_id, delivery_status, delivery_fee, earned_amount, delivery_income, delivery_cost, delivered_at, notes)
        VALUES ($1, $2, 'delivered', $3, $3, $3, $3, NOW(), $4)
        RETURNING id
      `,
      [riderOrder.id, rider.id, riderFee, `${marker} Dummy rider delivery.`],
      'rider delivery'
    )
    await client.query(
      `
        INSERT INTO rider_earnings (rider_id, delivery_id, order_id, amount, notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [rider.id, riderDelivery.id, riderOrder.id, riderFee, `${marker} Dummy rider earning.`, actor.id]
    )
    await client.query(`UPDATE riders SET balance = balance + $1, updated_at = NOW() WHERE id = $2`, [riderFee, rider.id])
    created.orders.push({ order_number: riderOrder.order_number, scenario: 'Rider delivery' })
    created.ledgers.push({ type: 'rider_earning', rider: rider.name, amount: riderFee })

    const supplierUnitPrice = money(supplierProduct.selling_price)
    const supplierUnitCost = supplierCostFor(supplierProduct)
    const supplierOrder = await insertOrder(client, {
      orderNumber: orderNo('SUPP'),
      customerId: customers.supplier.id,
      deliveryType: 'walk_in',
      deliveryFee: 0,
      deliveryAddress: customers.supplier.address,
      status: 'confirmed',
      paymentStatus: 'paid',
      subtotal: supplierUnitPrice,
      totalAmount: supplierUnitPrice,
      paidAmount: supplierUnitPrice,
      deliveryIncome: 0,
      deliveryCost: 0,
      notes: `Supplier fulfilled by ${supplier.name}.`,
      createdBy: actor.id,
      saleDate: today
    })
    await insertSupplierItem(client, supplierOrder, supplierProduct, supplier, 1, supplierUnitPrice, supplierUnitCost, actor.id)
    await insertPayment(client, supplierOrder, supplierUnitPrice, 'mpesa', actor.id, 'supplier fulfilled customer payment')
    created.orders.push({ order_number: supplierOrder.order_number, scenario: 'Supplier fulfilled order' })
    created.ledgers.push({ type: 'supplier_payable', supplier: supplier.name, amount: supplierUnitCost })

    const codSubtotal = money(supplierProduct.selling_price)
    const codTrackingNumber = `DUMMY${Date.now().toString().slice(-8)}`
    const codOrder = await insertOrder(client, {
      orderNumber: orderNo('COD'),
      customerId: customers.cod.id,
      deliveryType: 'courier',
      deliveryFee: 350,
      courierId: courier.id,
      trackingNumber: codTrackingNumber,
      courierPaymentType: 'cod',
      deliveryAddress: customers.cod.address,
      status: 'delivered',
      paymentStatus: 'pending',
      subtotal: codSubtotal,
      totalAmount: codSubtotal,
      paidAmount: 0,
      deliveryIncome: 0,
      deliveryFeePaymentMethod: 'paid_to_courier',
      deliveryFeePaidAmount: 350,
      courierCustomerFee: 350,
      courierActualFee: 350,
      deliveryCost: 0,
      notes: `Speedaf-style COD awaiting courier remittance through ${courier.name}.`,
      createdBy: actor.id,
      saleDate: today
    })
    await insertSupplierItem(client, codOrder, supplierProduct, supplier, 1, codSubtotal, supplierUnitCost, actor.id)
    await client.query(
      `
        INSERT INTO deliveries (
          order_id, courier_id, delivery_status, delivery_fee, courier_tracking_number,
          courier_payment_type, delivery_income, delivery_cost, courier_customer_fee,
          courier_actual_fee, delivered_at, notes
        )
        VALUES ($1, $2, 'pending_payment', 350, $3, 'cod', 0, 0, 350, 350, NOW(), $4)
      `,
      [codOrder.id, courier.id, codTrackingNumber, `${marker} Dummy Speedaf COD delivery.`]
    )
    await client.query(
      `
        INSERT INTO cod_collections (
          order_id, courier_id, tracking_number, cod_amount, status, delivered_at,
          due_date, notes, created_by
        )
        VALUES ($1, $2, $3, $4, 'delivered_awaiting_remittance', NOW(), $5::date + INTERVAL '2 days', $6, $7)
      `,
      [codOrder.id, courier.id, codTrackingNumber, codSubtotal, today, `${marker} Dummy COD pending remittance.`, actor.id]
    )
    created.orders.push({ order_number: codOrder.order_number, scenario: 'Speedaf/Courier COD pending remittance' })
    created.ledgers.push({ type: 'cod_collection', courier: courier.name, amount: codSubtotal })

    const creditSubtotal = money(internalOne.selling_price)
    const creditOrder = await insertOrder(client, {
      orderNumber: orderNo('CREDIT'),
      customerId: customers.credit.id,
      deliveryType: 'walk_in',
      deliveryFee: 0,
      deliveryAddress: customers.credit.address,
      status: 'delivered',
      paymentStatus: 'pending',
      subtotal: creditSubtotal,
      totalAmount: creditSubtotal,
      paidAmount: 0,
      deliveryIncome: 0,
      deliveryCost: 0,
      notes: 'Customer credit sale.',
      createdBy: actor.id,
      saleDate: today
    })
    await insertInternalItem(client, creditOrder, internalOne, 1, creditSubtotal, actor.id)
    await client.query(`UPDATE customers SET balance = balance + $1, updated_at = NOW() WHERE id = $2`, [
      creditSubtotal,
      customers.credit.id
    ])
    await client.query(
      `
        INSERT INTO customer_credits (customer_id, order_id, amount, type, due_date, created_by)
        VALUES ($1, $2, $3, 'sale', $4::date + INTERVAL '7 days', $5)
      `,
      [customers.credit.id, creditOrder.id, creditSubtotal, today, actor.id]
    )
    created.orders.push({ order_number: creditOrder.order_number, scenario: 'Customer credit sale' })
    created.ledgers.push({ type: 'customer_credit', customer: customers.credit.name, amount: creditSubtotal })

    const expense = await one(
      client,
      `
        INSERT INTO expenses (
          category, description, amount, frequency, expense_date, payment_method,
          reference_notes, status, approved_by, approved_at, created_by
        )
        VALUES ('Meta Ads', 'DUMMY Meta Ads Simulation', 250, 'one_off', $1, 'mpesa', $2, 'approved', $3, NOW(), $3)
        RETURNING id, description, amount
      `,
      [today, `${marker} Dummy approved one-off expense.`, actor.id],
      'dummy expense'
    )
    created.expenses.push(expense)

    await client.query(
      `
        INSERT INTO audit_logs (user_id, action, entity_type, new_values, metadata)
        VALUES ($1, 'dummy_seed_created', 'dummy_batch', $2::jsonb, $3::jsonb)
      `,
      [
        actor.id,
        JSON.stringify(created),
        JSON.stringify({ dummy_batch: batch, marker, source: 'scripts/seed-dummy-business-data.mjs' })
      ]
    )

    await client.query('COMMIT')

    const manifestDir = path.resolve('database', 'backups')
    fs.mkdirSync(manifestDir, { recursive: true })
    const manifestPath = path.join(manifestDir, `dummy-data-manifest-${safeBatch}.json`)
    fs.writeFileSync(manifestPath, `${JSON.stringify(created, null, 2)}\n`)

    console.log('Dummy data seeded successfully.')
    console.log(`Batch: ${batch}`)
    console.log(`Business date: ${today}`)
    console.log(`Manifest: ${manifestPath}`)
    console.log('Created records summary:')
    console.table(created.orders)
    console.table(created.ledgers)
    console.log('Run cleanup with:')
    console.log(`DLIGHT_DUMMY_BATCH="${batch}" npm run cleanup:dummy`)
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Dummy seed failed:', error.message)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

main()
