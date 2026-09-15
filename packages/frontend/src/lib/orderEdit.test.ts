import test from 'node:test'
import assert from 'node:assert/strict'
import { trackingIsOnlyEdit } from './orderEdit.js'

const original = {
  delivery_type: 'courier',
  courier_tracking_number: 'SPD-OLD',
  payment_method: 'cash',
  items: [{ product_id: 'product-1', quantity: 1, supplier_cost: 300 }]
}

test('an order form with only a changed tracking number can use the safe update', () => {
  assert.equal(trackingIsOnlyEdit({ ...original, courier_tracking_number: 'SPD-NEW' }, original), true)
})

test('a changed item or payment method must use the full order edit', () => {
  assert.equal(trackingIsOnlyEdit({ ...original, courier_tracking_number: 'SPD-NEW', items: [{ ...original.items[0], quantity: 2 }] }, original), false)
  assert.equal(trackingIsOnlyEdit({ ...original, courier_tracking_number: 'SPD-NEW', payment_method: 'mpesa' }, original), false)
})

test('an unchanged or empty tracking number is not a tracking update', () => {
  assert.equal(trackingIsOnlyEdit(original, original), false)
  assert.equal(trackingIsOnlyEdit({ ...original, courier_tracking_number: ' ' }, original), false)
})
