import { expect, test } from '@playwright/test'

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@dlight.com')
  await page.getByLabel('Password').fill('password')
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page).toHaveURL(/\/dashboard/)
}

test('opens a populated product editor from the catalogue', async ({ page }) => {
  await login(page)
  await page.goto('/products')
  const edit = page.getByTitle('Edit').first()
  await expect(edit).toBeVisible()
  await edit.click()

  await expect(page.getByRole('heading', { name: 'Edit Product' })).toBeVisible()
  await expect(page.getByLabel('Name *')).not.toHaveValue('')
  await expect(page.getByRole('button', { name: 'Update Product' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('heading', { name: 'Edit Product' })).toBeHidden()
})

test('keeps core operations thumb-friendly on a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)

  const primaryNav = page.getByRole('navigation', { name: 'Primary navigation' })
  await expect(primaryNav).toBeVisible()
  await primaryNav.getByRole('link', { name: 'Products' }).click()
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible()

  const edit = page.getByRole('button', { name: 'Edit' }).first()
  await expect(edit).toBeVisible()
  await edit.click()
  await expect(page.getByRole('heading', { name: 'Edit Product' })).toBeVisible()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  const productName = (await page.locator('article h3').first().textContent())?.trim() || ''
  const searchWord = productName.split(/\s+/).find(word => word.length >= 4) || productName.slice(0, 4)

  await primaryNav.getByRole('link', { name: 'Orders' }).click()
  await page.getByRole('button', { name: 'New Order' }).click()
  await expect(page.getByRole('heading', { name: 'New Order' })).toBeVisible()
  await page.getByRole('button', { name: 'Search and select product' }).click()
  await page.getByPlaceholder('Search product name, SKU, or price').fill(searchWord)
  const firstProduct = page.getByRole('listbox').getByRole('option').first()
  await expect(firstProduct).toBeVisible()
  await firstProduct.click()
  await expect(page.getByRole('button', { name: /KES/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save Order' })).toBeVisible()
  await page.getByRole('button', { name: 'Close new order' }).click()
})

test('shows configured M-PESA details on delivery receipts without handwritten fields', async ({ page }) => {
  await login(page)
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}')?.state?.token)
  const apiResponse = await page.request.get('/api/receipts?page=1&page_size=100', {
    headers: { Authorization: `Bearer ${token}` }
  })
  const receiptData = await apiResponse.json()
  const pendingRider = receiptData.data.find((receipt: any) => receipt.delivery_type === 'rider' && receipt.payment_status !== 'paid')
  test.skip(!pendingRider, 'A pending rider delivery receipt is required')

  const receiptsResponse = page.waitForResponse(response => response.url().includes('/api/receipts?') && response.ok())
  await page.goto('/receipts')
  await receiptsResponse
  const filteredResponse = page.waitForResponse(response => response.url().includes(encodeURIComponent(pendingRider.order_number)) && response.ok())
  await page.getByPlaceholder('Search order number').fill(pendingRider.order_number)
  await filteredResponse
  const deliveryReceiptRow = page.getByRole('row').filter({ hasText: pendingRider.order_number }).first()

  await deliveryReceiptRow.getByTitle('Delivery Receipt').click()
  await expect(page.getByRole('heading', { name: 'Delivery Receipt Preview' })).toBeVisible()
  await expect(page.getByText('Amount to Pay', { exact: true })).toBeVisible()
  await expect(page.getByText('247247', { exact: true })).toBeVisible()
  await expect(page.getByText('074061146', { exact: true })).toBeVisible()
  await expect(page.getByText('8109502', { exact: true })).toBeVisible()
  await expect(page.getByText('Customer signature')).toHaveCount(0)
  await expect(page.getByText('Amount received')).toHaveCount(0)
})

test('keeps delivery receipt and unlocks sales receipt after full payment', async ({ page }) => {
  await login(page)
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}')?.state?.token)
  const apiResponse = await page.request.get('/api/orders?workflow_stage=completed&page=1&page_size=100', {
    headers: { Authorization: `Bearer ${token}` }
  })
  const orderData = await apiResponse.json()
  const completedDelivery = orderData.data.find((order: any) =>
    order.delivery_type !== 'walk_in' && order.payment_status === 'paid'
  )
  test.skip(!completedDelivery, 'A fully paid delivery order is required')

  const receiptsResponse = page.waitForResponse(response => response.url().includes('/api/receipts?') && response.ok())
  await page.goto('/receipts')
  await receiptsResponse
  const filteredResponse = page.waitForResponse(response => response.url().includes(encodeURIComponent(completedDelivery.order_number)) && response.ok())
  await page.getByPlaceholder('Search order number').fill(completedDelivery.order_number)
  await filteredResponse
  const row = page.getByRole('row').filter({ hasText: completedDelivery.order_number }).first()

  await expect(row.getByTitle('Delivery Receipt')).toBeVisible()
  await expect(row.getByTitle('Sales Receipt')).toBeVisible()
  await row.getByTitle('Sales Receipt').click()
  await expect(page.getByRole('heading', { name: 'Sales Receipt Preview' })).toBeVisible()
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible()
})
