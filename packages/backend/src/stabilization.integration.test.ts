import test from 'node:test'
import assert from 'node:assert/strict'
import dotenv from 'dotenv'
import { pool } from './db/pool.js'
import { normalizeKenyanPhone } from './utils/phone.js'

dotenv.config({ path: '../../.env' })
if (!pool) throw new Error('Test database is not configured')
const testPool = pool

test('Kenyan phone variants normalize to one customer key', () => {
  const expected = '254712345678'
  assert.equal(normalizeKenyanPhone('0712345678'), expected)
  assert.equal(normalizeKenyanPhone('254712345678'), expected)
  assert.equal(normalizeKenyanPhone('+254 712 345 678'), expected)
})

test('critical production constraints are installed and validated', async () => {
  const names = [
    'chk_cod_amounts', 'chk_delivery_amounts_nonnegative', 'chk_inventory_nonnegative',
    'chk_order_amounts_nonnegative', 'chk_order_item_amounts_nonnegative',
    'chk_product_prices_nonnegative', 'chk_rider_earning_positive',
    'chk_rider_payment_positive', 'chk_supplier_payable_amounts',
    'chk_supplier_payment_positive', 'chk_supplier_return_positive'
  ]
  const result = await testPool.query(
    `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1::text[])`,
    [names]
  )
  assert.equal(result.rows.length, names.length)
  assert.ok(result.rows.every(row => row.convalidated))
})

test('one-record business invariants have unique indexes', async () => {
  const expected = [
    'uq_inventory_product', 'uq_deliveries_order', 'uq_cod_collections_order',
    'uq_supplier_payable_order_item', 'uq_active_rider_earning_delivery',
    'uq_customers_normalized_phone'
  ]
  const result = await testPool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
    [expected]
  )
  assert.equal(result.rows.length, expected.length)
})

test('there are no duplicate deliveries or COD records', async () => {
  const result = await testPool.query(`
    SELECT
      (SELECT COUNT(*) FROM (SELECT order_id FROM deliveries GROUP BY order_id HAVING COUNT(*) > 1) d) AS deliveries,
      (SELECT COUNT(*) FROM (SELECT order_id FROM cod_collections GROUP BY order_id HAVING COUNT(*) > 1) c) AS cod
  `)
  assert.equal(Number(result.rows[0].deliveries), 0)
  assert.equal(Number(result.rows[0].cod), 0)
})

test('supplier and rider stored balances reconcile to signed ledgers', async () => {
  const result = await testPool.query(`
    SELECT
      (SELECT COUNT(*) FROM suppliers s
       WHERE s.balance <> COALESCE((SELECT SUM(p.amount) FROM supplier_payables p WHERE p.supplier_id=s.id),0)
         - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id=s.id),0)
         - COALESCE((SELECT SUM(r.amount) FROM supplier_returns r WHERE r.supplier_id=s.id),0)) AS suppliers,
      (SELECT COUNT(*) FROM riders r
       WHERE r.balance <> COALESCE((SELECT SUM(e.amount) FROM rider_earnings e WHERE e.rider_id=r.id AND e.status <> 'reversed'),0)
         - COALESCE((SELECT SUM(p.amount) FROM rider_payments p WHERE p.rider_id=r.id),0)) AS riders
  `)
  assert.equal(Number(result.rows[0].suppliers), 0)
  assert.equal(Number(result.rows[0].riders), 0)
})

test('walk-in orders never have delivery records', async () => {
  const result = await testPool.query(`
    SELECT COUNT(*) FROM deliveries d JOIN orders o ON o.id=d.order_id WHERE o.delivery_type='walk_in'
  `)
  assert.equal(Number(result.rows[0].count), 0)
})

test.after(async () => {
  await testPool.end()
})
