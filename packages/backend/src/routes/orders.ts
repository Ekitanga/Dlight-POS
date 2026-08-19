import { Router } from 'express'
import { query, transaction } from '../db/index.js'
import { fallbackCustomerName, normalizeKenyanPhone } from '../utils/phone.js'
import { auditMiddleware } from '../middleware/audit.js'
import { paginatedResponse, paginationFromQuery } from '../utils/pagination.js'
import { logAudit } from '../utils/audit.js'
import { emitNotification } from '../utils/notifications.js'
import {
  commissionPeriodForTimestamp,
  evaluateAndEarnOrderItem,
  lockCommissionPeriod,
  reverseCommission
} from '../services/commission.js'

const router = Router()

function toNumber(value: unknown): number {
  const numberValue = Number(value || 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

const orderStatuses = ['pending', 'confirmed', 'in_transit', 'delivered', 'collected_paid', 'returned', 'cancelled']

function nairobiDate(value = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(value)
}

function normalizeBusinessDate(value: unknown): string {
  const rawValue = String(value || '').trim()
  if (!rawValue) return nairobiDate()
  return rawValue.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || ''
}

function normalizedWorkflowStatus(status: string): string {
  if (status === 'packed') return 'confirmed'
  if (status === 'dispatched') return 'in_transit'
  return status
}

function isSpeedafPassThroughFee(method?: string | null): boolean {
  return method === 'paid_to_courier' || method === 'pay_on_delivery'
}

function allowedNextStatuses(order: any): string[] {
  const current = normalizedWorkflowStatus(order.status)
  if (['cancelled', 'returned', 'collected_paid', 'delivered'].includes(current)) return []
  if (current === 'pending') return ['confirmed']
  if (current === 'confirmed') {
    return order.delivery_type === 'walk_in' ? ['delivered'] : ['in_transit']
  }
  if (current === 'in_transit') return ['delivered']
  return []
}

function isFinalCompletedStatus(order: any, status: string): boolean {
  if (status === 'collected_paid') return true
  return status === 'delivered' && !(order.delivery_type === 'courier' && order.courier_payment_type === 'cod')
}

function deliveryStatusForOrder(status: string, deliveryType?: string): string | null {
  if (deliveryType === 'walk_in') {
    return ['delivered', 'collected_paid'].includes(status) ? 'delivered' : null
  }

  const statusMap: Record<string, string> = {
    pending: 'assigned',
    confirmed: 'assigned',
    packed: 'assigned',
    dispatched: 'in_transit',
    in_transit: 'in_transit',
    delivered: 'delivered',
    collected_paid: 'collected_paid',
    returned: 'returned',
    cancelled: 'cancelled'
  }

  return statusMap[status] || null
}

function codStatusForOrder(status: string): string | null {
  const statusMap: Record<string, string> = {
    pending: 'assigned_to_courier',
    confirmed: 'assigned_to_courier',
    packed: 'assigned_to_courier',
    dispatched: 'in_transit',
    in_transit: 'in_transit',
    delivered: 'delivered_awaiting_remittance',
    collected_paid: 'delivered_awaiting_remittance',
    returned: 'returned',
    cancelled: 'returned'
  }

  return statusMap[status] || null
}

async function recalculateSupplierBalance(client: any, supplierId: string) {
  await client.query(
    `UPDATE suppliers s SET balance =
      COALESCE((SELECT SUM(sp.amount) FROM supplier_payables sp WHERE sp.supplier_id = s.id), 0)
      - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id = s.id), 0)
      - COALESCE((SELECT SUM(sr.amount) FROM supplier_returns sr WHERE sr.supplier_id = s.id), 0),
      updated_at = NOW()
     WHERE s.id = $1`,
    [supplierId]
  )
}

async function recalculateRiderBalance(client: any, riderId: string) {
  await client.query(
    `UPDATE riders r SET balance =
      COALESCE((SELECT SUM(re.amount) FROM rider_earnings re WHERE re.rider_id = r.id AND re.status <> 'reversed'), 0)
      - COALESCE((SELECT SUM(rp.amount) FROM rider_payments rp WHERE rp.rider_id = r.id), 0),
      updated_at = NOW()
     WHERE r.id = $1`,
    [riderId]
  )
}

async function recalculateCustomerBalance(client: any, customerId: string) {
  await client.query(
    `UPDATE customers
     SET balance = COALESCE((SELECT SUM(amount) FROM customer_credits WHERE customer_id = $1), 0),
         updated_at = NOW()
     WHERE id = $1`,
    [customerId]
  )
}

async function reverseOpenOrderRecords(client: any, req: any, order: any) {
  const paidPayables = await client.query(
    'SELECT COUNT(*)::int AS count FROM supplier_payables WHERE order_id = $1 AND paid_amount > 0',
    [order.id]
  )
  if (paidPayables.rows[0].count > 0) {
    throw Object.assign(new Error('This order has supplier payments. Reverse those payments before editing the order.'), { statusCode: 409 })
  }

  const remittedCod = await client.query(
    'SELECT COUNT(*)::int AS count FROM cod_collections WHERE order_id = $1 AND remitted_amount > 0',
    [order.id]
  )
  if (remittedCod.rows[0].count > 0) {
    throw Object.assign(new Error('This order has Speedaf remittance records. It cannot be edited directly.'), { statusCode: 409 })
  }

  const nonSaleCredits = await client.query(
    "SELECT COUNT(*)::int AS count FROM customer_credits WHERE order_id = $1 AND type <> 'sale'",
    [order.id]
  )
  if (nonSaleCredits.rows[0].count > 0) {
    throw Object.assign(new Error('This order has customer payment or adjustment records. It cannot be edited directly.'), { statusCode: 409 })
  }

  const refunds = await client.query('SELECT COUNT(*)::int AS count FROM order_refunds WHERE order_id = $1', [order.id])
  if (refunds.rows[0].count > 0) {
    throw Object.assign(new Error('This order already has refund records. It cannot be edited directly.'), { statusCode: 409 })
  }

  const previousItems = await client.query('SELECT * FROM order_items WHERE order_id = $1 FOR UPDATE', [order.id])
  for (const item of previousItems.rows) {
    const internalQuantity = toNumber(item.internal_quantity)
    if (internalQuantity > 0) {
      const inventoryResult = await client.query(
        'SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE',
        [item.product_id]
      )
      const beforeQuantity = inventoryResult.rows[0] ? toNumber(inventoryResult.rows[0].quantity) : 0
      await client.query(
        'UPDATE inventory SET quantity = quantity + $1, last_updated = NOW() WHERE product_id = $2',
        [internalQuantity, item.product_id]
      )
      const afterResult = await client.query(
        'SELECT quantity FROM inventory WHERE product_id = $1',
        [item.product_id]
      )
      const afterQuantity = afterResult.rows[0] ? toNumber(afterResult.rows[0].quantity) : beforeQuantity
      await client.query(
        'INSERT INTO inventory_movements (product_id, type, quantity, before_quantity, after_quantity, reference_id, reference_type, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [item.product_id, 'stock_in', internalQuantity, beforeQuantity, afterQuantity, order.id, 'order_edit', `Order edit reversal - ${order.order_number}`, req.user?.userId]
      )
    }
  }

  const affectedSuppliers = new Set<string>()
  const deletedPayables = await client.query('DELETE FROM supplier_payables WHERE order_id = $1 RETURNING supplier_id', [order.id])
  deletedPayables.rows.forEach((row: any) => affectedSuppliers.add(row.supplier_id))

  const affectedRiders = new Set<string>()
  const deletedEarnings = await client.query("DELETE FROM rider_earnings WHERE order_id = $1 AND status = 'payable' RETURNING rider_id", [order.id])
  deletedEarnings.rows.forEach((row: any) => affectedRiders.add(row.rider_id))

  const affectedCustomers = new Set<string>()
  const deletedCredits = await client.query('DELETE FROM customer_credits WHERE order_id = $1 RETURNING customer_id', [order.id])
  deletedCredits.rows.forEach((row: any) => affectedCustomers.add(row.customer_id))
  if (order.customer_id) affectedCustomers.add(order.customer_id)

  await client.query('DELETE FROM order_payments WHERE order_id = $1', [order.id])
  await client.query('DELETE FROM cod_collections WHERE order_id = $1', [order.id])
  await client.query('DELETE FROM deliveries WHERE order_id = $1', [order.id])
  await client.query('DELETE FROM order_items WHERE order_id = $1', [order.id])

  for (const supplierId of affectedSuppliers) await recalculateSupplierBalance(client, supplierId)
  for (const riderId of affectedRiders) await recalculateRiderBalance(client, riderId)
  for (const customerId of affectedCustomers) await recalculateCustomerBalance(client, customerId)
}

async function rebuildOpenOrder(client: any, req: any, order: any, body: any) {
  const {
    customer_id,
    sale_date,
    customer_name,
    customer_phone,
    customer_address,
    customer_notes,
    delivery_type,
    rider_id,
    courier_id,
    courier_tracking_number,
    courier_payment_type,
    delivery_fee_payment_method,
    customer_delivery_fee,
    actual_rider_fee,
    actual_courier_fee,
    delivery_notes,
    items,
    payment_method,
    notes
  } = body

  const normalizedPaymentMethod = payment_method === 'bank' ? 'bank_transfer' : (payment_method || 'cash')
  const businessSaleDate = normalizeBusinessDate(sale_date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessSaleDate)) {
    throw Object.assign(new Error('Sale date must be a valid date'), { statusCode: 400 })
  }

  const isCourierCod = delivery_type === 'courier' && courier_payment_type === 'cod'
  const isPayOnDelivery = normalizedPaymentMethod === 'pay_on_delivery' || isCourierCod
  const requestedDeliveryFeePaymentMethod = delivery_fee_payment_method === 'bank' ? 'bank_transfer' : delivery_fee_payment_method
  const normalizedDeliveryFeePaymentMethod = delivery_type === 'courier'
    ? requestedDeliveryFeePaymentMethod ||
      (isCourierCod
        ? (['cash', 'mpesa', 'bank_transfer'].includes(normalizedPaymentMethod) ? normalizedPaymentMethod : 'pay_on_delivery')
        : (['cash', 'mpesa', 'bank_transfer'].includes(normalizedPaymentMethod) ? normalizedPaymentMethod : 'paid_to_courier'))
    : null

  if (
    normalizedDeliveryFeePaymentMethod &&
    !['cash', 'mpesa', 'bank_transfer', 'pay_on_delivery', 'paid_to_courier'].includes(normalizedDeliveryFeePaymentMethod)
  ) {
    throw Object.assign(new Error('Invalid delivery fee handling method'), { statusCode: 400 })
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('At least one order item is required'), { statusCode: 400 })
  }

  const requiresDeliveryContact = ['rider', 'courier'].includes(delivery_type)
  if (requiresDeliveryContact && !customer_id && !order.customer_id && !String(customer_phone || '').trim()) {
    throw Object.assign(new Error('Customer phone is required for rider and courier deliveries'), { statusCode: 400 })
  }
  if (requiresDeliveryContact && !String(customer_address || '').trim()) {
    throw Object.assign(new Error('Customer location is required for rider and courier deliveries'), { statusCode: 400 })
  }
  if (
    normalizedPaymentMethod === 'credit' &&
    !customer_id &&
    !order.customer_id &&
    (!String(customer_name || '').trim() || !String(customer_phone || '').trim())
  ) {
    throw Object.assign(new Error('Customer name and phone are required for credit sales'), { statusCode: 400 })
  }

  let subtotal = 0
  const customerDeliveryFee = toNumber(customer_delivery_fee)
  const rawDeliveryCost = delivery_type === 'rider' ? toNumber(actual_rider_fee) : delivery_type === 'courier' ? toNumber(actual_courier_fee) : 0
  const deliveryFeePaidToShop = delivery_type === 'courier' &&
    ['cash', 'mpesa', 'bank_transfer'].includes(String(normalizedDeliveryFeePaymentMethod)) &&
    customerDeliveryFee > 0
  const deliveryFeeHandledByCourier = delivery_type === 'courier' && isSpeedafPassThroughFee(normalizedDeliveryFeePaymentMethod)
  const courierCustomerFee = delivery_type === 'courier' ? customerDeliveryFee : 0
  const courierActualFee = delivery_type === 'courier' ? rawDeliveryCost : 0
  const deliveryIncome = delivery_type === 'rider'
    ? customerDeliveryFee
    : deliveryFeePaidToShop ? customerDeliveryFee : 0
  const deliveryCost = delivery_type === 'rider'
    ? rawDeliveryCost
    : deliveryFeePaidToShop ? rawDeliveryCost : 0

  let normalizedCustomerId = customer_id || order.customer_id || null
  const normalizedCustomerPhone = normalizeKenyanPhone(customer_phone)
  const generatedCustomerName = fallbackCustomerName(normalizedCustomerPhone || customer_phone)

  if (customer_phone) {
    const existingCustomer = await client.query('SELECT * FROM customers WHERE normalized_phone = $1 FOR UPDATE', [normalizedCustomerPhone])
    if (existingCustomer.rows[0]) {
      normalizedCustomerId = existingCustomer.rows[0].id
      await client.query(
        `UPDATE customers
         SET name = COALESCE(NULLIF($1, ''), name),
             address = COALESCE(NULLIF($2, ''), address),
             notes = COALESCE(NULLIF($3, ''), notes),
             updated_at = NOW()
         WHERE id = $4`,
        [customer_name || null, customer_address || null, customer_notes || null, normalizedCustomerId]
      )
    } else {
      const newCustomer = await client.query(
        'INSERT INTO customers (name, phone, normalized_phone, address, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [String(customer_name || '').trim() || generatedCustomerName, customer_phone, normalizedCustomerPhone, customer_address || null, customer_notes || null]
      )
      normalizedCustomerId = newCustomer.rows[0].id
    }
  }

  const preparedItems = []
  for (const item of items) {
    const quantity = toNumber(item.quantity)
    if (!item.product_id || quantity < 1) {
      throw Object.assign(new Error('Invalid order item'), { statusCode: 400 })
    }

    const productResult = await client.query('SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL AND is_active = true', [item.product_id])
    const productData = productResult.rows[0]
    if (!productData) {
      throw Object.assign(new Error('Product not found'), { statusCode: 400 })
    }

    const sellingPrice = toNumber(item.selling_price || productData.selling_price)
    const itemTotal = sellingPrice * quantity
    const fulfillmentSource = item.fulfillment_source || item.fulfillment_type || (productData.is_dropship ? 'supplier' : 'internal')
    const fulfillmentType = fulfillmentSource === 'shop_stock' ? 'internal' : fulfillmentSource === 'supplier_fulfilled' ? 'supplier' : fulfillmentSource
    if (!['internal', 'supplier'].includes(fulfillmentType)) {
      throw Object.assign(new Error('Invalid fulfillment type'), { statusCode: 400 })
    }
    const supplierCost = toNumber(item.supplier_cost)
    const internalQuantity = fulfillmentType === 'internal' ? quantity : 0
    const supplierQuantity = fulfillmentType === 'supplier' ? quantity : 0

    if (fulfillmentType === 'supplier') {
      if (!item.supplier_id) {
        throw Object.assign(new Error(`Supplier is required for ${productData.name}`), { statusCode: 400 })
      }
      if (supplierCost <= 0) {
        throw Object.assign(new Error(`Supplier cost is required for ${productData.name}`), { statusCode: 400 })
      }
    }

    if (internalQuantity > 0) {
      const inventoryResult = await client.query('SELECT * FROM inventory WHERE product_id = $1 FOR UPDATE', [item.product_id])
      const inventory = inventoryResult.rows[0]
      if (!inventory) {
        throw Object.assign(new Error(`Missing inventory record for ${productData.name}`), { statusCode: 400 })
      }
      const availableStock = toNumber(inventory.quantity) - toNumber(inventory.reserved_quantity)
      if (availableStock < internalQuantity) {
        throw Object.assign(new Error(`Insufficient stock for ${productData.name}`), { statusCode: 400 })
      }
    }

    subtotal += itemTotal
    preparedItems.push({ item, productData, quantity, itemTotal, sellingPrice, fulfillmentType, supplierCost, internalQuantity, supplierQuantity })
  }

  const totalAmount = subtotal + deliveryIncome
  const codAmount = isCourierCod ? subtotal : 0

  if (normalizedPaymentMethod === 'credit') {
    const customerResult = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [normalizedCustomerId])
    const customer = customerResult.rows[0]
    if (!customer) throw Object.assign(new Error('Customer not found'), { statusCode: 400 })
    const creditLimit = toNumber(customer.credit_limit)
    const newBalance = toNumber(customer.balance) + totalAmount
    if (creditLimit > 0 && newBalance > creditLimit) {
      throw Object.assign(new Error('Credit limit exceeded'), { statusCode: 400 })
    }
  }

  await client.query(
    `UPDATE orders
     SET customer_id = $1,
         delivery_type = $2,
         delivery_fee = $3,
         rider_id = $4,
         courier_id = $5,
         courier_tracking_number = $6,
         courier_payment_type = $7,
         delivery_address = $8,
         subtotal = $9,
         total_amount = $10,
         delivery_income = $11,
         delivery_fee_payment_method = $12,
         delivery_fee_paid_amount = $13,
         courier_customer_fee = $14,
         courier_actual_fee = $15,
         delivery_cost = $16,
         notes = $17,
         sale_date = $18,
         payment_status = 'pending',
         paid_amount = 0,
         updated_at = NOW()
     WHERE id = $19`,
    [
      normalizedCustomerId,
      delivery_type || 'walk_in',
      deliveryIncome,
      rider_id || null,
      courier_id || null,
      courier_tracking_number || null,
      delivery_type === 'courier' ? courier_payment_type : null,
      customer_address || null,
      subtotal,
      totalAmount,
      deliveryIncome,
      delivery_type === 'courier' ? normalizedDeliveryFeePaymentMethod : null,
      deliveryFeePaidToShop ? customerDeliveryFee : 0,
      courierCustomerFee,
      courierActualFee,
      deliveryCost,
      notes || null,
      businessSaleDate,
      order.id
    ]
  )

  const affectedSuppliers = new Set<string>()
  for (const prepared of preparedItems) {
    const { productData, quantity, itemTotal, sellingPrice, fulfillmentType, supplierCost, internalQuantity, supplierQuantity } = prepared
    const orderItem = await client.query(
      'INSERT INTO order_items (order_id, product_id, product_category_id, product_category_snapshot_verified, supplier_id, quantity, internal_quantity, supplier_quantity, unit_cost, supplier_cost, unit_price, total_price, fulfillment_type, fulfillment_status) VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *',
      [
        order.id,
        productData.id,
        productData.category_id || null,
        prepared.item.supplier_id || null,
        quantity,
        internalQuantity,
        supplierQuantity,
        fulfillmentType === 'internal' ? productData.cost_price : 0,
        fulfillmentType === 'internal' ? 0 : supplierCost,
        sellingPrice,
        itemTotal,
        fulfillmentType,
        'fulfilled'
      ]
    )

    if (internalQuantity > 0) {
      await client.query('UPDATE inventory SET quantity = quantity - $1, last_updated = NOW() WHERE product_id = $2', [internalQuantity, productData.id])
      await client.query(
        'INSERT INTO inventory_movements (product_id, type, quantity, reference_id, reference_type, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [productData.id, 'stock_out', internalQuantity, order.id, 'order_edit', `Edited sale - Order ${order.order_number}`, req.user?.userId]
      )
    }

    if (supplierQuantity > 0) {
      const payableAmount = supplierCost * supplierQuantity
      const payable = await client.query(
        'INSERT INTO supplier_payables (supplier_id, order_id, order_item_id, amount, description, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [prepared.item.supplier_id, order.id, orderItem.rows[0].id, payableAmount, 'Edited order supplier payable', req.user?.userId]
      )
      await client.query('UPDATE order_items SET payable_id = $1 WHERE id = $2', [payable.rows[0].id, orderItem.rows[0].id])
      affectedSuppliers.add(prepared.item.supplier_id)
    }
  }

  if (delivery_type === 'rider') {
    if (!rider_id) throw Object.assign(new Error('Rider is required for rider delivery'), { statusCode: 400 })
    const delivery = await client.query(
      'INSERT INTO deliveries (order_id, rider_id, delivery_status, delivery_fee, earned_amount, delivery_income, delivery_cost, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [order.id, rider_id, deliveryStatusForOrder(order.status, delivery_type) || 'assigned', deliveryIncome, deliveryCost, deliveryIncome, deliveryCost, delivery_notes || null]
    )
    if (deliveryCost > 0) {
      await client.query(
        'INSERT INTO rider_earnings (rider_id, delivery_id, order_id, amount, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [rider_id, delivery.rows[0].id, order.id, deliveryCost, 'Edited order delivery earning', req.user?.userId]
      )
      await recalculateRiderBalance(client, rider_id)
    }
  }

  if (delivery_type === 'courier') {
    if (!courier_id) throw Object.assign(new Error('Courier is required for courier delivery'), { statusCode: 400 })
    await client.query(
      'INSERT INTO deliveries (order_id, delivery_status, delivery_fee, earned_amount, courier_id, courier_tracking_number, courier_payment_type, delivery_income, delivery_cost, courier_customer_fee, courier_actual_fee, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
      [
        order.id,
        deliveryStatusForOrder(order.status, delivery_type) || 'assigned',
        deliveryFeeHandledByCourier ? courierCustomerFee : deliveryIncome,
        deliveryFeeHandledByCourier ? courierActualFee : deliveryCost,
        courier_id,
        courier_tracking_number || null,
        courier_payment_type,
        deliveryIncome,
        deliveryCost,
        courierCustomerFee,
        courierActualFee,
        delivery_notes || null
      ]
    )
    if (isPayOnDelivery) {
      await client.query(
        'INSERT INTO cod_collections (order_id, courier_id, tracking_number, cod_amount, status, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [order.id, courier_id, courier_tracking_number || null, codAmount, codStatusForOrder(order.status) || 'assigned_to_courier', req.user?.userId]
      )
    }
  }

  if (normalizedPaymentMethod === 'credit') {
    await client.query(
      'INSERT INTO customer_credits (customer_id, order_id, amount, type, created_by) VALUES ($1, $2, $3, $4, $5)',
      [normalizedCustomerId, order.id, totalAmount, 'sale', req.user?.userId]
    )
    await recalculateCustomerBalance(client, normalizedCustomerId)
  } else if (isCourierCod && deliveryFeePaidToShop) {
    await client.query(
      'INSERT INTO order_payments (order_id, amount, payment_method, payment_date, created_by) VALUES ($1, $2, $3, $4, $5)',
      [order.id, customerDeliveryFee, normalizedDeliveryFeePaymentMethod, businessSaleDate, req.user?.userId]
    )
    await client.query("UPDATE orders SET payment_status='partially_paid', paid_amount=$1 WHERE id=$2", [customerDeliveryFee, order.id])
  } else if (!isPayOnDelivery) {
    await client.query(
      'INSERT INTO order_payments (order_id, amount, payment_method, payment_date, created_by) VALUES ($1, $2, $3, $4, $5)',
      [order.id, totalAmount, normalizedPaymentMethod, businessSaleDate, req.user?.userId]
    )
    await client.query('UPDATE orders SET payment_status = $1, paid_amount = $2 WHERE id = $3', ['paid', totalAmount, order.id])
  }

  for (const supplierId of affectedSuppliers) await recalculateSupplierBalance(client, supplierId)

  const finalOrder = await client.query('SELECT * FROM orders WHERE id = $1', [order.id])
  const finalItems = await client.query('SELECT * FROM order_items WHERE order_id = $1', [order.id])
  return { ...finalOrder.rows[0], items: finalItems.rows }
}

router.get('/', async (req, res) => {
  try {
    const { search, status, payment_status, delivery_type, date_from, date_to, workflow_stage } = req.query
    
    let sql = `SELECT o.*, c.name as customer_name,
        COALESCE(NULLIF(o.delivery_address, ''), c.address) as customer_address,
        r.name as rider_name
      FROM orders o 
      LEFT JOIN customers c ON o.customer_id = c.id 
      LEFT JOIN riders r ON o.rider_id = r.id`
    
    const params: any[] = []
    const conditions: string[] = []

    if (search) {
      conditions.push('(o.order_number ILIKE $' + (params.length + 1) + ' OR c.name ILIKE $' + (params.length + 1) + ' OR o.delivery_address ILIKE $' + (params.length + 1) + ' OR c.address ILIKE $' + (params.length + 1) + ')')
      params.push(`%${search}%`)
    }

    if (status) {
      conditions.push('o.status = $' + (params.length + 1))
      params.push(status)
    }

    if (payment_status) {
      conditions.push('o.payment_status = $' + (params.length + 1))
      params.push(payment_status)
    }

    if (delivery_type) {
      conditions.push('o.delivery_type = $' + (params.length + 1))
      params.push(delivery_type)
    }
    if (workflow_stage === 'pending') {
      conditions.push("o.status = 'pending'")
    } else if (workflow_stage === 'confirmed') {
      conditions.push("o.status IN ('confirmed', 'packed')")
    } else if (workflow_stage === 'in_transit') {
      conditions.push("o.status IN ('in_transit', 'dispatched')")
    } else if (workflow_stage === 'pending_payment') {
      conditions.push(`o.delivery_type = 'courier' AND o.courier_payment_type = 'cod' AND o.status = 'delivered'
        AND NOT EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id = o.id AND r.status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM cod_collections cc WHERE cc.order_id = o.id AND cc.status IN ('returned', 'lost'))
        AND NOT EXISTS (SELECT 1 FROM order_item_returns oir WHERE oir.order_id = o.id)`)
    } else if (workflow_stage === 'completed') {
      conditions.push("((o.status = 'delivered' AND NOT (o.delivery_type = 'courier' AND o.courier_payment_type = 'cod')) OR o.status = 'collected_paid')")
    } else if (workflow_stage === 'returned') {
      conditions.push("o.status = 'returned'")
    } else if (workflow_stage === 'cancelled') {
      conditions.push("o.status = 'cancelled'")
    }

    if (date_from) {
      conditions.push('COALESCE(o.sale_date, o.created_at::date) >= $' + (params.length + 1))
      params.push(date_from)
    }

    if (date_to) {
      conditions.push('COALESCE(o.sale_date, o.created_at::date) <= $' + (params.length + 1))
      params.push(date_to)
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ')
    }

    const pagination = paginationFromQuery(req.query)
    let total = 0
    if (pagination) {
      const countResult = await query(`SELECT COUNT(*)::int AS total FROM (${sql}) orders_list`, params)
      total = countResult.rows[0].total
      params.push(pagination.pageSize, pagination.offset)
      sql += ` ORDER BY COALESCE(o.sale_date, o.created_at::date) DESC, o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`
    } else {
      sql += ' ORDER BY COALESCE(o.sale_date, o.created_at::date) DESC, o.created_at DESC LIMIT 100'
    }

    const result = await query(sql, params)
    res.json(pagination ? paginatedResponse(result.rows, total, pagination) : result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    const result = await query(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone,
        COALESCE(NULLIF(o.delivery_address, ''), c.address) as customer_address,
        r.name as rider_name, cr.name as courier_name,
        cc.cod_amount, cc.remitted_amount,
        GREATEST(cc.cod_amount-cc.remitted_amount, 0) AS cod_outstanding,
        cc.status AS cod_status,
        op.payment_method AS last_payment_method
       FROM orders o 
       LEFT JOIN customers c ON o.customer_id = c.id 
       LEFT JOIN riders r ON o.rider_id = r.id 
       LEFT JOIN couriers cr ON o.courier_id = cr.id
       LEFT JOIN cod_collections cc ON cc.order_id = o.id
       LEFT JOIN LATERAL (
         SELECT payment_method
         FROM order_payments
         WHERE order_id = o.id
         ORDER BY created_at DESC
         LIMIT 1
       ) op ON true
       WHERE o.id = $1`,
      [id]
    )

    const items = await query(
      `SELECT oi.*, p.name as product_name, p.sku, p.category_id, pc.name AS category_name,
          COALESCE(i.quantity - i.reserved_quantity, 0) AS available_stock,
          COALESCE((SELECT SUM(oir.internal_quantity) FROM order_item_returns oir WHERE oir.order_item_id = oi.id), 0) AS returned_internal_quantity,
          COALESCE((SELECT SUM(oir.supplier_quantity) FROM order_item_returns oir WHERE oir.order_item_id = oi.id), 0) AS returned_supplier_quantity
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       LEFT JOIN categories pc ON p.category_id = pc.id
       LEFT JOIN inventory i ON i.product_id = p.id
       WHERE order_id = $1`,
      [id]
    )

    res.json({ order: result.rows[0], items: items.rows })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const updatedOrder = await transaction(async (client) => {
      const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id])
      const order = orderResult.rows[0]
      if (!order) {
        throw Object.assign(new Error('Order not found'), { statusCode: 404 })
      }

      const editableStage = normalizedWorkflowStatus(order.status)
      if (!['pending', 'confirmed'].includes(editableStage)) {
        throw Object.assign(
          new Error('Only pending or confirmed orders can be edited directly. Use status changes, returns, refunds, or adjustments for dispatched and completed orders.'),
          { statusCode: 409 }
        )
      }

      const oldItems = await client.query('SELECT * FROM order_items WHERE order_id = $1', [id])
      await reverseOpenOrderRecords(client, req, order)
      const rebuiltOrder = await rebuildOpenOrder(client, req, order, req.body)

      await logAudit({
        req,
        client,
        action: 'order_updated',
        entityType: 'order',
        entityId: id,
        oldValues: { ...order, items: oldItems.rows },
        newValues: rebuiltOrder,
        metadata: {
          order_number: order.order_number,
          edit_stage: editableStage
        }
      })

      return rebuiltOrder
    })

    res.json(updatedOrder)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    if (statusCode === 500) console.error('Order update error:', err)
    const message = statusCode === 500 && process.env.NODE_ENV === 'production' ? 'Database error' : (err as Error).message
    res.status(statusCode).json({ error: { message } })
  }
})

router.put('/:orderId/items/:itemId/supplier', async (req, res) => {
  try {
    const { orderId, itemId } = req.params
    const { supplier_id, supplier_cost, supplier_quantity, internal_quantity } = req.body

    const item = await transaction(async (client) => {
      const itemResult = await client.query(
        'SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE',
        [itemId, orderId]
      )
      const existingItem = itemResult.rows[0]
      if (!existingItem) {
        throw Object.assign(new Error('Order item not found'), { statusCode: 404 })
      }

      if (!supplier_id) {
        throw Object.assign(new Error('Supplier is required'), { statusCode: 400 })
      }

      const supplierResult = await client.query('SELECT id FROM suppliers WHERE id = $1 AND is_active = true', [supplier_id])
      if (supplierResult.rows.length === 0) {
        throw Object.assign(new Error('Supplier not found'), { statusCode: 404 })
      }

      const totalQuantity = Number(existingItem.quantity || 0)
      const nextInternalQuantity = internal_quantity !== undefined ? Number(internal_quantity) : Number(existingItem.internal_quantity || 0)
      const nextSupplierQuantity = supplier_quantity !== undefined ? Number(supplier_quantity) : (totalQuantity - nextInternalQuantity)
      if (nextInternalQuantity < 0 || nextSupplierQuantity < 1 || nextInternalQuantity + nextSupplierQuantity !== totalQuantity) {
        throw Object.assign(new Error('Invalid supplier/internal quantities'), { statusCode: 400 })
      }

      const fulfillmentType = nextInternalQuantity > 0 && nextSupplierQuantity > 0 ? 'hybrid' : 'supplier'
      const result = await client.query(
        'UPDATE order_items SET supplier_id = $1, supplier_cost = $2, internal_quantity = $3, supplier_quantity = $4, fulfillment_type = $5, fulfillment_status = $6 WHERE id = $7 RETURNING *',
        [supplier_id, Number(supplier_cost || existingItem.supplier_cost || existingItem.unit_cost || 0), nextInternalQuantity, nextSupplierQuantity, fulfillmentType, 'assigned', itemId]
      )

      return result.rows[0]
    })

    res.json(item)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.put('/:orderId/items/:itemId/fulfillment-status', async (req, res) => {
  try {
    const { orderId, itemId } = req.params
    const { fulfillment_status } = req.body

    const item = await transaction(async (client) => {
      const itemResult = await client.query(
        'SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE',
        [itemId, orderId]
      )
      const existingItem = itemResult.rows[0]
      if (!existingItem) {
        throw Object.assign(new Error('Order item not found'), { statusCode: 404 })
      }

      if (['cancelled', 'returned'].includes(fulfillment_status)) {
        throw Object.assign(new Error('Use the order cancellation or item-return workflow so financial records and commission are updated together'), { statusCode: 400 })
      }
      if (!['assigned', 'confirmed', 'fulfilled'].includes(fulfillment_status)) {
        throw Object.assign(new Error('Invalid fulfillment status'), { statusCode: 400 })
      }

      let payableId = existingItem.payable_id
      if (fulfillment_status === 'fulfilled' && Number(existingItem.supplier_quantity || 0) > 0) {
        if (!existingItem.supplier_id) {
          throw Object.assign(new Error('Supplier must be assigned before fulfillment'), { statusCode: 400 })
        }

        if (!payableId) {
          const payableAmount = Number(existingItem.supplier_cost || 0) * Number(existingItem.supplier_quantity || 0)
          if (payableAmount <= 0) {
            throw Object.assign(new Error('Supplier cost must be captured before fulfillment'), { statusCode: 400 })
          }

          const payable = await client.query(
            'INSERT INTO supplier_payables (supplier_id, order_id, order_item_id, amount, description, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [existingItem.supplier_id, orderId, itemId, payableAmount, 'Supplier fulfillment payable', req.user?.userId]
          )
          payableId = payable.rows[0].id
          await client.query('UPDATE suppliers SET balance = balance + $1, updated_at = NOW() WHERE id = $2', [payableAmount, existingItem.supplier_id])
        }
      }

      const result = await client.query(
        'UPDATE order_items SET fulfillment_status = $1, payable_id = $2 WHERE id = $3 RETURNING *',
        [fulfillment_status, payableId || null, itemId]
      )

      return result.rows[0]
    })

    res.json(item)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

// Records a return against one order item without changing the status of the
// remaining items. This is the authoritative operational event that drives a
// proportional commission reversal.
router.post('/:orderId/items/:itemId/returns', async (req, res) => {
  try {
    const { orderId, itemId } = req.params
    const { quantity, reason, return_source, stock_condition = 'sellable' } = req.body
    const returnQuantity = Number(quantity)
    const returnReason = String(reason || '').trim()

    if (!Number.isInteger(returnQuantity) || returnQuantity <= 0) {
      throw Object.assign(new Error('Return quantity must be a whole number greater than zero'), { statusCode: 400 })
    }
    if (!returnReason) {
      throw Object.assign(new Error('A return reason is required'), { statusCode: 400 })
    }
    if (return_source && !['internal', 'supplier'].includes(return_source)) {
      throw Object.assign(new Error('Return source must be shop stock or supplier'), { statusCode: 400 })
    }
    if (stock_condition && !['sellable', 'damaged'].includes(stock_condition)) {
      throw Object.assign(new Error('Returned shop stock must be sellable or damaged'), { statusCode: 400 })
    }

    const returned = await transaction(async client => {
      const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
      const order = orderResult.rows[0]
      if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 })
      if (!['in_transit', 'delivered', 'collected_paid'].includes(normalizedWorkflowStatus(order.status))) {
        throw Object.assign(new Error('Items can only be returned from an in-transit, completed, or collected-and-paid order'), { statusCode: 400 })
      }

      const itemResult = await client.query(
        'SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE',
        [itemId, orderId]
      )
      const item = itemResult.rows[0]
      if (!item) throw Object.assign(new Error('Order item not found'), { statusCode: 404 })

      const alreadyReturned = toNumber(item.returned_quantity)
      const remainingQuantity = Math.max(0, toNumber(item.quantity) - alreadyReturned)
      if (returnQuantity > remainingQuantity) {
        throw Object.assign(new Error(`Only ${remainingQuantity} item(s) remain available to return`), { statusCode: 400 })
      }

      const priorSources = await client.query(
        `SELECT
           COALESCE(SUM(internal_quantity), 0) AS internal_quantity,
           COALESCE(SUM(supplier_quantity), 0) AS supplier_quantity
         FROM order_item_returns
         WHERE order_item_id = $1`,
        [itemId]
      )
      const returnedInternal = toNumber(priorSources.rows[0]?.internal_quantity)
      const returnedSupplier = toNumber(priorSources.rows[0]?.supplier_quantity)
      const remainingInternal = Math.max(0, toNumber(item.internal_quantity) - returnedInternal)
      const remainingSupplier = Math.max(0, toNumber(item.supplier_quantity) - returnedSupplier)
      const isHybrid = remainingInternal > 0 && remainingSupplier > 0
      const source = isHybrid ? return_source : (remainingInternal > 0 ? 'internal' : 'supplier')
      if (!source) {
        throw Object.assign(new Error('This item has no remaining fulfilment quantity to return'), { statusCode: 400 })
      }
      if (isHybrid && !return_source) {
        throw Object.assign(new Error('Choose whether this returned item came from shop stock or a supplier'), { statusCode: 400 })
      }

      const availableForSource = source === 'internal' ? remainingInternal : remainingSupplier
      if (returnQuantity > availableForSource) {
        throw Object.assign(new Error(`Only ${availableForSource} ${source === 'internal' ? 'shop-stock' : 'supplier'} item(s) remain available to return`), { statusCode: 400 })
      }

      const internalReturnQuantity = source === 'internal' ? returnQuantity : 0
      const supplierReturnQuantity = source === 'supplier' ? returnQuantity : 0
      const returnRecord = await client.query(
        `INSERT INTO order_item_returns
          (order_id, order_item_id, quantity, internal_quantity, supplier_quantity, stock_condition, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          orderId,
          itemId,
          returnQuantity,
          internalReturnQuantity,
          supplierReturnQuantity,
          internalReturnQuantity > 0 ? stock_condition : null,
          returnReason,
          req.user?.userId || null
        ]
      )

      if (internalReturnQuantity > 0) {
        const inventoryResult = await client.query('SELECT * FROM inventory WHERE product_id = $1 FOR UPDATE', [item.product_id])
        const inventory = inventoryResult.rows[0]
        if (!inventory) throw Object.assign(new Error('Missing inventory record for returned shop-stock item'), { statusCode: 409 })
        const beforeQuantity = toNumber(inventory.quantity)
        const movementType = stock_condition === 'damaged' ? 'return_damaged' : 'return_sellable'
        const afterQuantity = stock_condition === 'damaged' ? beforeQuantity : beforeQuantity + internalReturnQuantity
        if (stock_condition === 'damaged') {
          await client.query(
            'UPDATE inventory SET returned_quantity = returned_quantity + $1, damaged_quantity = damaged_quantity + $1, last_updated = NOW() WHERE product_id = $2',
            [internalReturnQuantity, item.product_id]
          )
        } else {
          await client.query(
            'UPDATE inventory SET returned_quantity = returned_quantity + $1, quantity = quantity + $1, last_updated = NOW() WHERE product_id = $2',
            [internalReturnQuantity, item.product_id]
          )
        }
        await client.query(
          `INSERT INTO inventory_movements
            (product_id, type, quantity, before_quantity, after_quantity, reference_id, reference_type, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'order_item_return', $7, $8)`,
          [item.product_id, movementType, internalReturnQuantity, beforeQuantity, afterQuantity, returnRecord.rows[0].id, returnReason, req.user?.userId || null]
        )
      }

      if (supplierReturnQuantity > 0 && item.payable_id) {
        const payableResult = await client.query('SELECT * FROM supplier_payables WHERE id = $1 FOR UPDATE', [item.payable_id])
        const payable = payableResult.rows[0]
        if (payable && item.supplier_id) {
          const supplierReturnAmount = toNumber(item.supplier_cost) * supplierReturnQuantity
          if (supplierReturnAmount > 0) {
            await client.query(
              `INSERT INTO supplier_returns (supplier_id, payable_id, order_item_id, amount, reason, created_by)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [item.supplier_id, payable.id, itemId, supplierReturnAmount, returnReason, req.user?.userId || null]
            )
            await recalculateSupplierBalance(client, item.supplier_id)
          }
        }
      }

      const updatedItem = await client.query(
        `UPDATE order_items
         SET returned_quantity = returned_quantity + $1,
             fulfillment_status = CASE WHEN returned_quantity + $1 >= quantity THEN 'returned' ELSE fulfillment_status END
         WHERE id = $2
         RETURNING *`,
        [returnQuantity, itemId]
      )

      const existingEarnings = await client.query(
        `SELECT id FROM commission_transactions
         WHERE order_item_id = $1 AND transaction_type = 'earned'
         FOR UPDATE`,
        [itemId]
      )
      const reversals = []
      for (const earning of existingEarnings.rows) {
        const reversal = await reverseCommission(
          earning.id,
          orderId,
          itemId,
          returnQuantity,
          returnReason,
          req.user?.userId || null,
          client,
          'order_item_return',
          returnRecord.rows[0].id
        )
        if (reversal) reversals.push(reversal)
      }

      await logAudit({
        req,
        client,
        action: 'order_item_returned',
        entityType: 'order_item_return',
        entityId: returnRecord.rows[0].id,
        oldValues: {
          returned_quantity: alreadyReturned,
          fulfillment_status: item.fulfillment_status
        },
        newValues: {
          order_id: orderId,
          order_item_id: itemId,
          quantity: returnQuantity,
          source,
          stock_condition: internalReturnQuantity > 0 ? stock_condition : null,
          returned_quantity: updatedItem.rows[0].returned_quantity,
          commission_reversal_count: reversals.length
        },
        metadata: { order_number: order.order_number, reason: returnReason }
      })

      return { item: updatedItem.rows[0], return: returnRecord.rows[0], reversals }
    })

    res.status(201).json(returned)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.post('/', auditMiddleware('order', 'order_created'), async (req, res) => {
  try {
    const {
      customer_id,
      sale_date,
      customer_name,
      customer_phone,
      customer_address,
      customer_notes,
      delivery_type,
      rider_id,
      courier_id,
      courier_tracking_number,
      courier_payment_type,
      delivery_fee_payment_method,
      customer_delivery_fee,
      actual_rider_fee,
      actual_courier_fee,
      delivery_notes,
      items,
      payment_method,
      notes
    } = req.body
    const normalizedPaymentMethod = payment_method === 'bank' ? 'bank_transfer' : (payment_method || 'cash')
    const businessSaleDate = normalizeBusinessDate(sale_date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessSaleDate)) {
      return res.status(400).json({ error: { message: 'Sale date must be a valid date' } })
    }
    const isCourierCod = delivery_type === 'courier' && courier_payment_type === 'cod'
    const isPayOnDelivery = normalizedPaymentMethod === 'pay_on_delivery' || isCourierCod
    const requestedDeliveryFeePaymentMethod = delivery_fee_payment_method === 'bank' ? 'bank_transfer' : delivery_fee_payment_method
    const normalizedDeliveryFeePaymentMethod = delivery_type === 'courier'
      ? requestedDeliveryFeePaymentMethod ||
        (isCourierCod
          ? (['cash', 'mpesa', 'bank_transfer'].includes(normalizedPaymentMethod) ? normalizedPaymentMethod : 'pay_on_delivery')
          : (['cash', 'mpesa', 'bank_transfer'].includes(normalizedPaymentMethod) ? normalizedPaymentMethod : 'paid_to_courier'))
      : null

    if (
      normalizedDeliveryFeePaymentMethod &&
      !['cash', 'mpesa', 'bank_transfer', 'pay_on_delivery', 'paid_to_courier'].includes(normalizedDeliveryFeePaymentMethod)
    ) {
      return res.status(400).json({ error: { message: 'Invalid delivery fee handling method' } })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: { message: 'At least one order item is required' } })
    }

    const requiresDeliveryContact = ['rider', 'courier'].includes(delivery_type)
    if (requiresDeliveryContact && !customer_id && !String(customer_phone || '').trim()) {
      return res.status(400).json({ error: { message: 'Customer phone is required for rider and courier deliveries' } })
    }
    if (requiresDeliveryContact && !customer_id && !String(customer_address || '').trim()) {
      return res.status(400).json({ error: { message: 'Customer location is required for rider and courier deliveries' } })
    }
    if (
      normalizedPaymentMethod === 'credit' &&
      !customer_id &&
      (!String(customer_name || '').trim() || !String(customer_phone || '').trim())
    ) {
      return res.status(400).json({ error: { message: 'Customer name and phone are required for credit sales' } })
    }
    if ((normalizedPaymentMethod === 'credit' || isPayOnDelivery) && !customer_id && !customer_phone) {
      return res.status(400).json({ error: { message: 'Customer phone is required for credit or pay-on-delivery orders' } })
    }

    const settingsResult = await query('SELECT order_prefix FROM settings ORDER BY created_at DESC LIMIT 1')
    const orderPrefix = String(settingsResult.rows[0]?.order_prefix || 'ORD').replace(/[^A-Z0-9]/gi, '').toUpperCase() || 'ORD'
    const orderNumber = orderPrefix + '-' + Date.now().toString().slice(-8)

    const createdOrder = await transaction(async (client) => {
      const commissionOwnerResult = await client.query(
        `SELECT commission_eligible, role
         FROM users WHERE id = $1`,
        [req.user?.userId]
      )
      const commissionOwner = commissionOwnerResult.rows[0]
      const commissionSalespersonEligible = Boolean(
        commissionOwner?.commission_eligible === true &&
        !['admin', 'owner'].includes(String(commissionOwner?.role || '').toLowerCase())
      )
      let subtotal = 0
      const customerDeliveryFee = toNumber(customer_delivery_fee)
      const rawDeliveryCost = delivery_type === 'rider' ? toNumber(actual_rider_fee) : delivery_type === 'courier' ? toNumber(actual_courier_fee) : 0
      const deliveryFeePaidToShop = delivery_type === 'courier' &&
        ['cash', 'mpesa', 'bank_transfer'].includes(String(normalizedDeliveryFeePaymentMethod)) &&
        customerDeliveryFee > 0
      const deliveryFeeHandledByCourier = delivery_type === 'courier' && isSpeedafPassThroughFee(normalizedDeliveryFeePaymentMethod)
      const courierCustomerFee = delivery_type === 'courier' ? customerDeliveryFee : 0
      const courierActualFee = delivery_type === 'courier' ? rawDeliveryCost : 0
      const deliveryIncome = delivery_type === 'rider'
        ? customerDeliveryFee
        : deliveryFeePaidToShop ? customerDeliveryFee : 0
      const deliveryCost = delivery_type === 'rider'
        ? rawDeliveryCost
        : deliveryFeePaidToShop ? rawDeliveryCost : 0
      const preparedItems = []
      let normalizedCustomerId = customer_id || null
      const normalizedCustomerPhone = normalizeKenyanPhone(customer_phone)
      const generatedCustomerName = fallbackCustomerName(normalizedCustomerPhone || customer_phone)

      if (!normalizedCustomerId && customer_phone) {
        const existingCustomer = await client.query('SELECT * FROM customers WHERE normalized_phone = $1 FOR UPDATE', [normalizedCustomerPhone])
        if (existingCustomer.rows[0]) {
          normalizedCustomerId = existingCustomer.rows[0].id
          await client.query(
            `UPDATE customers
             SET name = COALESCE(NULLIF($1, ''), name),
                 address = COALESCE(NULLIF($2, ''), address),
                 notes = COALESCE(NULLIF($3, ''), notes),
                 updated_at = NOW()
             WHERE id = $4`,
            [customer_name || null, customer_address || null, customer_notes || null, normalizedCustomerId]
          )
        } else {
          const newCustomer = await client.query(
            'INSERT INTO customers (name, phone, normalized_phone, address, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [String(customer_name || '').trim() || generatedCustomerName, customer_phone, normalizedCustomerPhone, customer_address || null, customer_notes || null]
          )
          normalizedCustomerId = newCustomer.rows[0].id
        }
      }

      for (const item of items) {
        const quantity = toNumber(item.quantity)
        if (!item.product_id || quantity < 1) {
          throw Object.assign(new Error('Invalid order item'), { statusCode: 400 })
        }

        const productResult = await client.query('SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL AND is_active = true', [item.product_id])
        const productData = productResult.rows[0]
        if (!productData) {
          throw Object.assign(new Error('Product not found'), { statusCode: 400 })
        }

        const sellingPrice = toNumber(item.selling_price || productData.selling_price)
        const discount = toNumber(item.discount)
        const itemTotal = sellingPrice * quantity - discount
        if (itemTotal < 0) {
          throw Object.assign(new Error('Item discount cannot exceed item total'), { statusCode: 400 })
        }

        const fulfillmentSource = item.fulfillment_source || item.fulfillment_type || (productData.is_dropship ? 'supplier' : 'internal')
        const fulfillmentType = fulfillmentSource === 'shop_stock' ? 'internal' : fulfillmentSource === 'supplier_fulfilled' ? 'supplier' : fulfillmentSource
        if (!['internal', 'supplier'].includes(fulfillmentType)) {
          throw Object.assign(new Error('Invalid fulfillment type'), { statusCode: 400 })
        }
        const supplierCost = toNumber(item.supplier_cost)
        const internalQuantity = fulfillmentType === 'internal' ? quantity : 0
        const supplierQuantity = fulfillmentType === 'supplier' ? quantity : 0

        if (fulfillmentType === 'supplier') {
          if (!item.supplier_id) {
            throw Object.assign(new Error(`Supplier is required for ${productData.name}`), { statusCode: 400 })
          }
          if (supplierCost <= 0) {
            throw Object.assign(new Error(`Supplier cost is required for ${productData.name}`), { statusCode: 400 })
          }
        }

        if (internalQuantity > 0) {
          const inventoryResult = await client.query('SELECT * FROM inventory WHERE product_id = $1 FOR UPDATE', [item.product_id])
          const inventory = inventoryResult.rows[0]
          if (!inventory) {
            throw Object.assign(new Error(`Missing inventory record for ${productData.name}`), { statusCode: 400 })
          }

          const availableStock = toNumber(inventory.quantity) - toNumber(inventory.reserved_quantity)
          if (availableStock < internalQuantity) {
            throw Object.assign(new Error(`Insufficient stock for ${productData.name}`), { statusCode: 400 })
          }
        }

        subtotal += itemTotal
        preparedItems.push({ item, productData, quantity, itemTotal, sellingPrice, fulfillmentType, supplierCost, internalQuantity, supplierQuantity })
      }

      const totalAmount = subtotal + deliveryIncome
      const codAmount = isCourierCod ? subtotal : 0

      if (normalizedPaymentMethod === 'credit') {
        const customerResult = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [normalizedCustomerId])
        const customer = customerResult.rows[0]
        if (!customer) {
          throw Object.assign(new Error('Customer not found'), { statusCode: 400 })
        }

        const creditLimit = toNumber(customer.credit_limit)
        const newBalance = toNumber(customer.balance) + totalAmount
        if (creditLimit > 0 && newBalance > creditLimit) {
          throw Object.assign(new Error('Credit limit exceeded'), { statusCode: 400 })
        }
      }

      const result = await client.query(
        `INSERT INTO orders (
          order_number, customer_id, delivery_type, delivery_fee, rider_id, courier_id,
          courier_tracking_number, courier_payment_type, delivery_address, subtotal, total_amount,
          delivery_income, delivery_fee_payment_method, delivery_fee_paid_amount,
          courier_customer_fee, courier_actual_fee, delivery_cost, notes, created_by, sale_date,
          commission_salesperson_eligible
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
        [
          orderNumber,
          normalizedCustomerId,
          delivery_type || 'walk_in',
          deliveryIncome,
          rider_id || null,
          courier_id || null,
          courier_tracking_number || null,
          delivery_type === 'courier' ? courier_payment_type : null,
          customer_address || null,
          subtotal,
          totalAmount,
          deliveryIncome,
          delivery_type === 'courier' ? normalizedDeliveryFeePaymentMethod : null,
          deliveryFeePaidToShop ? customerDeliveryFee : 0,
          courierCustomerFee,
          courierActualFee,
          deliveryCost,
          notes || null,
          req.user?.userId,
          businessSaleDate,
          commissionSalespersonEligible
        ]
      )

      const orderId = result.rows[0].id

      for (const prepared of preparedItems) {
        const { productData, quantity, itemTotal, sellingPrice, fulfillmentType, supplierCost, internalQuantity, supplierQuantity } = prepared
        const orderItem = await client.query(
          'INSERT INTO order_items (order_id, product_id, product_category_id, product_category_snapshot_verified, supplier_id, quantity, internal_quantity, supplier_quantity, unit_cost, supplier_cost, unit_price, total_price, fulfillment_type, fulfillment_status) VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *',
          [
            orderId,
            productData.id,
            productData.category_id || null,
            prepared.item.supplier_id || null,
            quantity,
            internalQuantity,
            supplierQuantity,
            fulfillmentType === 'internal' ? productData.cost_price : 0,
            fulfillmentType === 'internal' ? 0 : supplierCost,
            sellingPrice,
            itemTotal,
            fulfillmentType,
            'fulfilled'
          ]
        )

        if (internalQuantity > 0) {
          await client.query(
            'UPDATE inventory SET quantity = quantity - $1, last_updated = NOW() WHERE product_id = $2',
            [internalQuantity, productData.id]
          )

          await client.query(
            'INSERT INTO inventory_movements (product_id, type, quantity, reference_id, reference_type, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [productData.id, 'stock_out', internalQuantity, orderId, 'order', 'Sale - Order ' + orderNumber, req.user?.userId]
          )
        }

        if (supplierQuantity > 0) {
          const payableAmount = supplierCost * supplierQuantity
          const payable = await client.query(
            'INSERT INTO supplier_payables (supplier_id, order_id, order_item_id, amount, description, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [prepared.item.supplier_id, orderId, orderItem.rows[0].id, payableAmount, 'Order-first supplier payable', req.user?.userId]
          )
          await client.query('UPDATE order_items SET payable_id = $1 WHERE id = $2', [payable.rows[0].id, orderItem.rows[0].id])
          await client.query('UPDATE suppliers SET balance = balance + $1, updated_at = NOW() WHERE id = $2', [payableAmount, prepared.item.supplier_id])
        }
      }

      if (delivery_type === 'rider') {
        if (!rider_id) {
          throw Object.assign(new Error('Rider is required for rider delivery'), { statusCode: 400 })
        }
        const delivery = await client.query(
          'INSERT INTO deliveries (order_id, rider_id, delivery_status, delivery_fee, earned_amount, delivery_income, delivery_cost, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
          [orderId, rider_id, 'assigned', deliveryIncome, deliveryCost, deliveryIncome, deliveryCost, delivery_notes || null]
        )
        if (deliveryCost > 0) {
          await client.query(
            'INSERT INTO rider_earnings (rider_id, delivery_id, order_id, amount, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
            [rider_id, delivery.rows[0].id, orderId, deliveryCost, 'Order delivery earning', req.user?.userId]
          )
          await client.query('UPDATE riders SET balance = balance + $1, updated_at = NOW() WHERE id = $2', [deliveryCost, rider_id])
        }
      }

      if (delivery_type === 'courier') {
        if (!courier_id) {
          throw Object.assign(new Error('Courier is required for courier delivery'), { statusCode: 400 })
        }
        await client.query(
          'INSERT INTO deliveries (order_id, delivery_status, delivery_fee, earned_amount, courier_id, courier_tracking_number, courier_payment_type, delivery_income, delivery_cost, courier_customer_fee, courier_actual_fee, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
          [
            orderId,
            'assigned',
            deliveryFeeHandledByCourier ? courierCustomerFee : deliveryIncome,
            deliveryFeeHandledByCourier ? courierActualFee : deliveryCost,
            courier_id,
            courier_tracking_number || null,
            courier_payment_type,
            deliveryIncome,
            deliveryCost,
            courierCustomerFee,
            courierActualFee,
            delivery_notes || null
          ]
        )
        if (isPayOnDelivery) {
          await client.query(
            'INSERT INTO cod_collections (order_id, courier_id, tracking_number, cod_amount, status, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
            [orderId, courier_id, courier_tracking_number || null, codAmount, 'assigned_to_courier', req.user?.userId]
          )
        }
      }

      if (normalizedPaymentMethod === 'credit') {
        await client.query(
          'INSERT INTO customer_credits (customer_id, order_id, amount, type, created_by) VALUES ($1, $2, $3, $4, $5)',
          [normalizedCustomerId, orderId, totalAmount, 'sale', req.user?.userId]
        )

        await client.query(
          'UPDATE customers SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
          [totalAmount, normalizedCustomerId]
        )
      } else if (isCourierCod && deliveryFeePaidToShop) {
        await client.query(
          'INSERT INTO order_payments (order_id, amount, payment_method, payment_date, created_by) VALUES ($1, $2, $3, $4, $5)',
          [orderId, customerDeliveryFee, normalizedDeliveryFeePaymentMethod, businessSaleDate, req.user?.userId]
        )
        await client.query(
          "UPDATE orders SET payment_status='partially_paid', paid_amount=$1 WHERE id=$2",
          [customerDeliveryFee, orderId]
        )
      } else if (!isPayOnDelivery) {
        await client.query(
          'INSERT INTO order_payments (order_id, amount, payment_method, payment_date, created_by) VALUES ($1, $2, $3, $4, $5)',
          [orderId, totalAmount, normalizedPaymentMethod, businessSaleDate, req.user?.userId]
        )

        await client.query('UPDATE orders SET payment_status = $1, paid_amount = $2 WHERE id = $3', ['paid', totalAmount, orderId])
      }

    const finalOrder = await client.query('SELECT * FROM orders WHERE id = $1', [orderId])
    const finalItems = await client.query('SELECT * FROM order_items WHERE order_id = $1', [orderId])
    return { ...finalOrder.rows[0], items: finalItems.rows }
    })

    res.status(201).json(createdOrder)

    const newOrderNumber = createdOrder.order_number
    const newOrderId = createdOrder.id
    const deliveryTypeLabel = createdOrder.delivery_type || 'walk_in'
    const totalAmount = toNumber(createdOrder.total_amount)
    const customerId = createdOrder.customer_id
    const paymentMethod = createdOrder.payment_method || 'pending'
    let customerName: string | null = null
    if (customerId) {
      const customerResult = await query('SELECT name FROM customers WHERE id = $1', [customerId])
      customerName = customerResult.rows[0]?.name || null
    }
    const customerLabel = customerName ? customerName : 'Guest / Walk-in'
    void emitNotification({
      title: `New order ${newOrderNumber}`,
      message: `${newOrderNumber} | ${customerLabel} | ${deliveryTypeLabel.toUpperCase()} | KSh ${totalAmount.toLocaleString()} | ${paymentMethod.toUpperCase()}`,
      type: 'order_status',
      entityType: 'order',
      entityId: newOrderId
    }).catch(() => {})
  } catch (err) {
    console.error('Order creation error:', err)
    const statusCode = (err as any).statusCode || 500
    const message = statusCode === 500 && process.env.NODE_ENV === 'production' ? 'Database error' : (err as Error).message
    res.status(statusCode).json({ error: { message } })
  }
})

router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params
    const { status, notes, completion_payment_method } = req.body

    if (!orderStatuses.includes(status)) {
      return res.status(400).json({ error: { message: 'Invalid order status' } })
    }
    if (status === 'returned' && !String(notes || '').trim()) {
      return res.status(400).json({ error: { message: 'A return reason is required' } })
    }

    const updatedOrder = await transaction(async (client) => {
      const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id])
      const order = orderResult.rows[0]
      if (!order) {
        throw Object.assign(new Error('Order not found'), { statusCode: 404 })
      }

      const previousStatus = order.status
      const normalizedPreviousStatus = normalizedWorkflowStatus(previousStatus)
      const exceptionTransition =
        status === 'cancelled'
          ? ['pending', 'confirmed'].includes(normalizedPreviousStatus)
          : status === 'returned'
            ? ['in_transit', 'delivered', 'collected_paid'].includes(normalizedPreviousStatus)
            : false
      if (status !== previousStatus && !allowedNextStatuses(order).includes(status) && !exceptionTransition) {
        throw Object.assign(new Error('This status change is not valid for the current order stage'), { statusCode: 400 })
      }
      if (
        status === 'collected_paid' &&
        order.delivery_type === 'courier' &&
        order.courier_payment_type === 'cod' &&
        order.payment_status !== 'paid'
      ) {
        throw Object.assign(new Error('Record the full Speedaf payment before completing this COD order'), { statusCode: 400 })
      }

      if (status === 'delivered' && order.delivery_type === 'rider' && order.payment_status !== 'paid') {
        const paymentMethod = completion_payment_method === 'bank' ? 'bank_transfer' : completion_payment_method
        if (!['cash', 'mpesa', 'bank_transfer'].includes(paymentMethod)) {
          throw Object.assign(new Error('Select how payment was received before completing this rider order'), { statusCode: 400 })
        }
        const outstandingAmount = Math.max(0, toNumber(order.total_amount) - toNumber(order.paid_amount))
        if (outstandingAmount > 0) {
          await client.query(
            'INSERT INTO order_payments (order_id, amount, payment_method, reference, created_by) VALUES ($1, $2, $3, $4, $5)',
            [id, outstandingAmount, paymentMethod, 'Collected on rider delivery', req.user?.userId]
          )
          await client.query(
            "UPDATE orders SET paid_amount = total_amount, payment_status = 'paid', updated_at = NOW() WHERE id = $1",
            [id]
          )
          if (order.customer_id) {
            const creditSale = await client.query(
              "SELECT id FROM customer_credits WHERE order_id = $1 AND customer_id = $2 AND type = 'sale' LIMIT 1",
              [id, order.customer_id]
            )
            if (creditSale.rows[0]) {
              await client.query(
                "INSERT INTO customer_credits (customer_id, order_id, amount, type, created_by) VALUES ($1, $2, $3, 'payment', $4)",
                [order.customer_id, id, -outstandingAmount, req.user?.userId]
              )
              await client.query(
                'UPDATE customers SET balance = GREATEST(balance - $1, 0), updated_at = NOW() WHERE id = $2',
                [outstandingAmount, order.customer_id]
              )
            }
          }
        }
      }
      const enteringClosedState = ['cancelled', 'returned'].includes(status) && !['cancelled', 'returned'].includes(previousStatus)
      // A courier COD parcel is only physically delivered at `delivered`.
      // Its final completion is recorded by the remittance transaction when
      // the full verified amount moves the order to `collected_paid`.
      const enteringCompleted = isFinalCompletedStatus(order, status) && !isFinalCompletedStatus(order, previousStatus)
      let commissionProgrammeActiveForSale = false
      if (enteringCompleted) {
        // Serialize a just-completed sale with a close operation for its exact
        // Nairobi business month. This prevents a month-close query from
        // missing a still-uncommitted completed order and creating an earning
        // in a period that has just been closed.
        const clock = await client.query('SELECT NOW() AS timestamp')
        const completionPeriod = commissionPeriodForTimestamp(clock.rows[0].timestamp)
        const programmeState = await client.query(
          `SELECT status FROM commission_programmes
           WHERE effective_from <= $1::date
             AND (effective_to IS NULL OR effective_to >= $1::date)
           ORDER BY effective_from DESC, created_at DESC, id DESC
           LIMIT 1`,
          [order.sale_date]
        )
        // Status policy versions intentionally overlap at their handover
        // instant; only the latest version is authoritative.
        commissionProgrammeActiveForSale = programmeState.rows[0]?.status === 'active'
        if (commissionProgrammeActiveForSale) {
          await lockCommissionPeriod(client, completionPeriod)
          const closedPeriod = await client.query(
            `SELECT id FROM commission_period_closures
             WHERE period_start = $1::date AND status = 'closed'`,
            [completionPeriod]
          )
          if (closedPeriod.rows.length > 0) {
            throw Object.assign(
              new Error(`Commission period ${completionPeriod} is closed; complete this historical order through a reviewed correction instead`),
              { statusCode: 409 }
            )
          }
        }
      }
      const deliveryStatus = deliveryStatusForOrder(status, order.delivery_type)
      const codStatus = codStatusForOrder(status)

      if (deliveryStatus) {
        const deliveryResult = await client.query('SELECT * FROM deliveries WHERE order_id = $1 FOR UPDATE', [id])
        const delivery = deliveryResult.rows[0]
        if (delivery) {
          await client.query(
            `UPDATE deliveries
             SET delivery_status = $1,
                 notes = COALESCE(NULLIF($2::text, ''), notes),
                 delivered_at = CASE WHEN $4 THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END
             WHERE id = $3`,
            [deliveryStatus, notes || null, delivery.id, ['delivered', 'collected_paid'].includes(deliveryStatus)]
          )

          if (['delivered', 'collected_paid'].includes(deliveryStatus) && delivery.rider_id && toNumber(delivery.earned_amount) > 0) {
            const existingEarning = await client.query(
              "SELECT id FROM rider_earnings WHERE delivery_id = $1 AND rider_id = $2 AND status != 'reversed'",
              [delivery.id, delivery.rider_id]
            )
            if (existingEarning.rows.length === 0) {
              await client.query(
                'INSERT INTO rider_earnings (rider_id, delivery_id, order_id, amount, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
                [delivery.rider_id, delivery.id, id, toNumber(delivery.earned_amount), 'Delivery earning from order status update', req.user?.userId]
              )
              await client.query('UPDATE riders SET balance = balance + $1, updated_at = NOW() WHERE id = $2', [toNumber(delivery.earned_amount), delivery.rider_id])
            }
          }
        }
      }

      if (codStatus) {
        await client.query(
          `UPDATE cod_collections
           SET status = CASE WHEN status IN ('remitted', 'closed') THEN status ELSE $1 END,
               delivered_at = CASE WHEN $4 THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
               notes = COALESCE(NULLIF($2::text, ''), notes)
           WHERE order_id = $3`,
          [codStatus, notes || null, id, codStatus === 'delivered_awaiting_remittance']
        )
      }

      if (enteringClosedState) {
        const items = await client.query('SELECT * FROM order_items WHERE order_id = $1 FOR UPDATE', [id])
        for (const item of items.rows) {
          const priorReturnResult = await client.query(
            `SELECT COALESCE(SUM(internal_quantity), 0) AS returned_internal_quantity
             FROM order_item_returns WHERE order_item_id = $1`,
            [item.id]
          )
          const internalQuantity = Math.max(0, toNumber(item.internal_quantity) - toNumber(priorReturnResult.rows[0]?.returned_internal_quantity))
          if (internalQuantity > 0) {
            await client.query(
              'UPDATE inventory SET quantity = quantity + $1, last_updated = NOW() WHERE product_id = $2',
              [internalQuantity, item.product_id]
            )
            await client.query(
              'INSERT INTO inventory_movements (product_id, type, quantity, reference_id, reference_type, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
              [item.product_id, 'stock_in', internalQuantity, id, 'order', `Order ${status} - stock restored`, req.user?.userId]
            )
          }

          await client.query(
            `UPDATE order_items
             SET fulfillment_status = $1,
                 returned_quantity = CASE WHEN $3::boolean THEN quantity ELSE returned_quantity END
             WHERE id = $2`,
            [status === 'returned' ? 'returned' : 'cancelled', item.id, status === 'returned']
          )
        }

        const payables = await client.query(
          "SELECT * FROM supplier_payables WHERE order_id = $1 AND status IN ('open', 'partial', 'paid') FOR UPDATE",
          [id]
        )
        for (const payable of payables.rows) {
          const previousSupplierReturns = await client.query(
            'SELECT COALESCE(SUM(amount), 0) AS amount FROM supplier_returns WHERE payable_id = $1',
            [payable.id]
          )
          const reversalAmount = Math.max(0, toNumber(payable.amount) - toNumber(previousSupplierReturns.rows[0]?.amount))
          if (reversalAmount > 0) {
            await client.query(
              `INSERT INTO supplier_returns
                (supplier_id, payable_id, order_item_id, amount, reason, created_by)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                payable.supplier_id, payable.id, payable.order_item_id, reversalAmount,
                `Order ${status} liability reversal`, req.user?.userId
              ]
            )
          }
          await client.query('UPDATE supplier_payables SET status = $1 WHERE id = $2', [status === 'returned' ? 'returned' : 'cancelled', payable.id])
          await client.query(
            `UPDATE suppliers s SET balance =
              COALESCE((SELECT SUM(sp.amount) FROM supplier_payables sp WHERE sp.supplier_id = s.id), 0)
              - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id = s.id), 0)
              - COALESCE((SELECT SUM(sr.amount) FROM supplier_returns sr WHERE sr.supplier_id = s.id), 0),
              updated_at = NOW()
             WHERE s.id = $1`,
            [payable.supplier_id]
          )
        }

        const riderEarnings = await client.query(
          "SELECT * FROM rider_earnings WHERE order_id = $1 AND status = 'payable' FOR UPDATE",
          [id]
        )
        for (const earning of riderEarnings.rows) {
          await client.query(
            'UPDATE rider_earnings SET status = $1, notes = COALESCE($2, notes) WHERE id = $3',
            ['reversed', notes || `Order ${status}`, earning.id]
          )
          await client.query(
            `UPDATE riders r SET balance =
              COALESCE((SELECT SUM(re.amount) FROM rider_earnings re WHERE re.rider_id = r.id AND re.status <> 'reversed'), 0)
              - COALESCE((SELECT SUM(rp.amount) FROM rider_payments rp WHERE rp.rider_id = r.id), 0),
              updated_at = NOW()
             WHERE r.id = $1`,
            [earning.rider_id]
          )
        }

        if (toNumber(order.paid_amount) > 0) {
          await client.query(
            `INSERT INTO order_refunds (order_id, amount, reason, created_by)
             SELECT $1, $2, $3, $4
             WHERE NOT EXISTS (
               SELECT 1 FROM order_refunds WHERE order_id = $1 AND status = 'pending'
             )`,
            [id, toNumber(order.paid_amount), notes || `Refund due for ${status} order`, req.user?.userId]
          )
        }

        if (order.customer_id) {
          const creditTotals = await client.query(
            `SELECT
              COALESCE(SUM(CASE WHEN type = 'sale' THEN amount ELSE 0 END), 0)
              + COALESCE(SUM(CASE WHEN type IN ('payment', 'adjustment') THEN amount ELSE 0 END), 0)
              AS outstanding
             FROM customer_credits
             WHERE order_id = $1 AND customer_id = $2`,
            [id, order.customer_id]
          )
          const outstandingCredit = Math.max(0, toNumber(creditTotals.rows[0].outstanding))
          if (outstandingCredit > 0) {
            await client.query(
              `INSERT INTO customer_credits (customer_id, order_id, amount, type, created_by)
               VALUES ($1, $2, $3, 'adjustment', $4)`,
              [order.customer_id, id, -outstandingCredit, req.user?.userId]
            )
            await client.query(
              'UPDATE customers SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
              [outstandingCredit, order.customer_id]
            )
          }
        }
      }

      const result = await client.query(
        `UPDATE orders
         SET status = $1,
             confirmed_by = CASE WHEN $4 THEN $2 ELSE confirmed_by END,
             cancelled_by = CASE WHEN $5 THEN $2 ELSE cancelled_by END,
             cancelled_at = CASE WHEN $5 THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
             commission_completion_by = CASE WHEN $6 THEN $2 ELSE commission_completion_by END,
             commission_completion_at = CASE WHEN $6 THEN NOW() ELSE commission_completion_at END,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [status, req.user?.userId || null, id, status === 'confirmed', status === 'cancelled', enteringCompleted]
      )

      await logAudit({
        req,
        client,
        action: 'order_status_changed',
        entityType: 'order',
        entityId: id,
        oldValues: { status: previousStatus, payment_status: order.payment_status, paid_amount: order.paid_amount },
        newValues: { status, notes: notes || null, payment_status: result.rows[0].payment_status, paid_amount: result.rows[0].paid_amount },
        metadata: {
          order_number: order.order_number,
          delivery_type: order.delivery_type,
          courier_payment_type: order.courier_payment_type,
          completion_payment_method: completion_payment_method || null
        }
      })

      const statusLabel = status === 'delivered'
        ? (order.delivery_type === 'courier' && order.courier_payment_type === 'cod' ? 'pending payment' : 'completed')
        : status
      const previousStatusLabel = normalizedWorkflowStatus(previousStatus)
      const deliveryTypeLabel = (order.delivery_type || 'walk_in').toUpperCase()
      const totalAmount = toNumber(order.total_amount)
      let customerName: string | null = null
      if (order.customer_id) {
        const customerResult = await client.query('SELECT name FROM customers WHERE id = $1', [order.customer_id])
        customerName = customerResult.rows[0]?.name || null
      }
      const customerLabel = customerName ? customerName : 'Guest / Walk-in'
      void emitNotification({
        title: `Order ${order.order_number} → ${statusLabel.toUpperCase()}`,
        message: `${order.order_number} | ${customerLabel} | ${deliveryTypeLabel} | KSh ${totalAmount.toLocaleString()} | ${previousStatusLabel} → ${statusLabel}`,
        type: 'order_status',
        entityType: 'order',
        entityId: id
      }).catch(() => {})

      if (enteringCompleted || enteringClosedState) {
        const items = await client.query('SELECT oi.*, p.category_id FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 FOR UPDATE OF oi', [id])
        for (const item of items.rows) {
          if (enteringCompleted) {
            await evaluateAndEarnOrderItem(id, item.id, req.user?.userId || null, client)
          }
          if (enteringClosedState) {
            const existingResult = await client.query(
              `SELECT id FROM commission_transactions WHERE order_item_id = $1 AND transaction_type = 'earned' AND transaction_status <> 'reversed' FOR UPDATE`,
              [item.id]
            )
            for (const existing of existingResult.rows) {
              await reverseCommission(existing.id, id, item.id, toNumber(item.quantity), `Order ${status}`, req.user?.userId || null, client, 'order_status', id)
            }
          }
        }
      }

      return result.rows[0]
    })

    res.json(updatedOrder)
  } catch (err) {
    console.error('Order status update error:', err)
    const statusCode = (err as any).statusCode || 500
    if (statusCode >= 400 && statusCode < 500) {
      try {
        await logAudit({
          req,
          userId: req.user?.userId || null,
          action: 'order_status_change_rejected',
          entityType: 'order',
          entityId: req.params.id || null,
          newValues: { requested_status: req.body?.status || null },
          metadata: { status_code: statusCode, outcome: 'rejected' }
        })
      } catch (auditError) {
        console.error('Unable to record rejected order status attempt:', auditError)
      }
    }
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.get('/refunds/pending', async (_req, res) => {
  try {
    const result = await query(
      `SELECT r.*, o.order_number, c.name AS customer_name, c.phone AS customer_phone
       FROM order_refunds r
       JOIN orders o ON o.id = r.order_id
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE r.status = 'pending'
       ORDER BY r.created_at DESC`
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/refunds/:refundId/pay', async (req, res) => {
  try {
    const { payment_method, reference } = req.body
    if (!['cash', 'mpesa', 'bank_transfer'].includes(payment_method)) {
      return res.status(400).json({ error: { message: 'Select cash, M-Pesa, or bank transfer' } })
    }
    const result = await transaction(async (client) => {
      const updated = await client.query(
        `UPDATE order_refunds
         SET status = 'paid', payment_method = $1, reference = $2, refunded_at = NOW()
         WHERE id = $3 AND status = 'pending'
         RETURNING *`,
        [payment_method, reference || null, req.params.refundId]
      )
      if (updated.rows.length === 0) {
        throw Object.assign(new Error('Refund is not pending'), { statusCode: 409 })
      }
      await logAudit({
        req,
        client,
        action: 'order_refund_paid',
        entityType: 'order_refund',
        entityId: req.params.refundId,
        newValues: updated.rows[0],
        metadata: { order_id: updated.rows[0].order_id, amount: updated.rows[0].amount, payment_method }
      })
      return updated.rows[0]
    })
    res.json(result)
  } catch (err) {
    const status = (err as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (err as Error).message } })
  }
})

export { router as orderRoutes }
