import { test, expect, Page } from '@playwright/test'

test.setTimeout(240_000)

const adminEmail = 'admin@dlight.com'
const adminPassword = 'password'
const attendantEmail = 'uat.attendant@dlight.test'
const attendantPassword = 'Uat-Attendant-2026!'
const stockProduct = 'UAT Shop Stock Watch'
const supplierProduct = 'UAT Supplier Perfume'
const supplierName = 'UAT Supplier'
const riderName = 'UAT Rider'
const courierName = 'Speedaf'
const screenshotDir = 'artifacts/uat-screenshots'

async function login(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page).toHaveURL(/\/dashboard/)
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'Logout' }).click()
  await expect(page).toHaveURL(/\/login/)
}

async function ensureProduct(page: Page, name: string, sku: string, dropship: boolean) {
  await page.goto('/products')
  const search = page.getByPlaceholder('Search name, SKU, or barcode')
  await search.fill(name)
  await page.waitForTimeout(300)
  if (await page.getByText(name, { exact: true }).count()) return
  await page.getByRole('button', { name: 'Add Product' }).click()
  await page.getByPlaceholder('Product name').fill(name)
  await page.getByLabel('SKU').fill(sku)
  await page.getByLabel('Cost Price').fill(dropship ? '0' : '700')
  await page.getByLabel('Selling Price *').fill(dropship ? '2500' : '1500')
  await page.getByLabel('Reorder Level').fill('2')
  if (dropship) await page.getByLabel('Prefer Supplier Fulfillment').check()
  await page.getByRole('button', { name: 'Create Product' }).click()
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
}

async function ensureSupplier(page: Page) {
  await page.goto('/suppliers')
  await page.getByPlaceholder('Search suppliers...').fill(supplierName)
  await page.waitForTimeout(300)
  if (await page.getByText(supplierName, { exact: true }).count()) return
  await page.getByRole('button', { name: 'Add Supplier' }).click()
  await page.getByPlaceholder('Supplier name').fill(supplierName)
  await page.getByPlaceholder('0712345678').fill('0700111001')
  await page.getByRole('button', { name: 'Create Supplier' }).click()
  await expect(page.getByText(supplierName, { exact: true }).first()).toBeVisible()
}

async function ensureRider(page: Page) {
  await page.goto('/riders')
  await page.getByPlaceholder('Search riders...').fill(riderName)
  await page.waitForTimeout(300)
  if (await page.getByText(riderName, { exact: true }).count()) return
  await page.getByRole('button', { name: 'Add Rider' }).click()
  await page.getByPlaceholder('Rider name').fill(riderName)
  await page.getByPlaceholder('0712345678').fill('0700111002')
  await page.getByRole('button', { name: 'Create Rider' }).click()
  await expect(page.getByText(riderName, { exact: true }).first()).toBeVisible()
}

async function ensureCourier(page: Page) {
  await page.goto('/couriers')
  await page.getByPlaceholder('Search couriers...').fill(courierName)
  await page.waitForTimeout(300)
  if (await page.getByText(courierName, { exact: true }).count()) return
  await page.getByRole('button', { name: 'Add Courier' }).click()
  await page.getByPlaceholder('Example: Speedaf').fill(courierName)
  await page.getByPlaceholder('Example: SPD').fill('SPD')
  await page.getByRole('button', { name: 'Create Courier' }).click()
  await expect(page.getByText(courierName, { exact: true }).first()).toBeVisible()
}

async function ensureStock(page: Page) {
  await page.goto('/inventory')
  await page.getByRole('button', { name: 'Adjust Stock' }).click()
  const form = page.getByRole('heading', { name: 'Inventory Adjustment' }).locator('..')
  const productSelect = form.locator('select').nth(0)
  const productValue = await productSelect.locator('option').filter({ hasText: stockProduct }).getAttribute('value')
  if (!productValue) throw new Error('UAT stock product is missing from inventory')
  await productSelect.selectOption(productValue)
  await form.locator('select').nth(1).selectOption('stock_in')
  await form.getByPlaceholder('0').fill('50')
  await form.getByPlaceholder('Adjustment reason').fill('Frontend UAT stock setup')
  await form.getByRole('button', { name: 'Apply Adjustment' }).click()
  await page.getByPlaceholder('Search inventory...').fill(stockProduct)
  await expect(page.getByText(stockProduct, { exact: true })).toBeVisible()
}

async function ensureAttendant(page: Page) {
  await page.goto('/users')
  await page.getByPlaceholder('Search users...').fill(attendantEmail)
  await page.waitForTimeout(300)
  if (await page.getByText(attendantEmail, { exact: true }).count()) {
    const row = page.locator('tbody tr').filter({ hasText: attendantEmail }).first()
    await row.locator('button').nth(1).click()
    await page.getByRole('button', { name: 'Attendant defaults' }).click()
    await page.getByRole('button', { name: 'Update User' }).click()
    await expect(page.getByText(attendantEmail, { exact: true })).toBeVisible()
    return
  }
  await page.getByRole('button', { name: 'Add User' }).click()
  await page.getByPlaceholder('user@example.com').fill(attendantEmail)
  await page.getByPlaceholder('John Doe').fill('Frontend UAT Attendant')
  await page.locator('form select').first().selectOption('attendant')
  await page.locator('input[type="password"]').fill(attendantPassword)
  await page.getByRole('button', { name: 'Attendant defaults' }).click()
  await page.getByRole('button', { name: 'Create User' }).click()
  await expect(page.getByText(attendantEmail, { exact: true })).toBeVisible()
}

async function createOrder(page: Page, options: {
  customer: string
  phone: string
  product: string
  fulfillment?: 'internal' | 'supplier'
  delivery?: 'walk_in' | 'rider' | 'courier'
  payment?: 'cash' | 'mpesa' | 'credit' | 'pay_on_delivery'
  deliveryIncome?: string
  deliveryCost?: string
  tracking?: string
}) {
  await page.goto('/orders')
  await page.getByRole('button', { name: 'New Order' }).click()
  await page.getByPlaceholder('Customer name').fill(options.customer)
  await page.getByPlaceholder('Phone number').fill(options.phone)
  await page.getByPlaceholder('Location / address').fill('Nairobi UAT')
  const item = page.getByRole('heading', { name: 'B. Order Items' }).locator('..')
  await item.getByRole('button', { name: 'Search and select product' }).click()
  await item.getByPlaceholder('Search product name, SKU, or price').fill(options.product)
  await item.getByRole('option', { name: new RegExp(options.product) }).click()
  await item.getByPlaceholder('Quantity').fill('1')
  if (options.fulfillment === 'supplier') {
    await item.locator('select').nth(0).selectOption('supplier')
    await item.locator('select').nth(1).selectOption({ label: supplierName })
    await item.getByPlaceholder('Supplier cost per item').fill('1200')
  }
  const delivery = page.getByRole('heading', { name: 'C. Delivery Details' }).locator('..')
  await delivery.locator('select').nth(0).selectOption(options.delivery || 'walk_in')
  if (options.delivery === 'rider') {
    await delivery.getByLabel('Customer Delivery Fee Charged').fill(options.deliveryIncome || '400')
    await delivery.locator('select').nth(1).selectOption({ label: riderName })
    await delivery.getByLabel('Actual Rider Fee').fill(options.deliveryCost || '500')
  }
  if (options.delivery === 'courier') {
    await delivery.getByLabel('Customer Delivery Fee Charged').fill(options.deliveryIncome || '300')
    await delivery.locator('select').nth(1).selectOption({ label: courierName })
    await delivery.getByPlaceholder('Tracking number').fill(options.tracking || `SPD-${Date.now()}`)
    await delivery.getByLabel('Actual Courier Fee').fill(options.deliveryCost || '200')
    if (options.payment === 'pay_on_delivery') await delivery.locator('select').nth(2).selectOption('cod')
  }
  const payment = page.getByRole('heading', { name: 'D. Payment Details' }).locator('..')
  if (!(options.delivery === 'courier' && options.payment === 'pay_on_delivery')) {
    await payment.getByLabel('Payment Method').selectOption(options.payment || 'cash')
  }
  await page.getByRole('button', { name: 'Save Order' }).click()
  const orderRow = page.locator('tbody tr').filter({ hasText: options.customer }).first()
  await expect(orderRow).toBeVisible()
  return (await orderRow.locator('td').first().innerText()).trim()
}

async function completeOrder(page: Page, orderNumber: string, transitions = 1) {
  await page.goto('/orders')
  await page.getByPlaceholder('Search orders...').fill(orderNumber)
  for (let index = 0; index < transitions; index += 1) {
    const row = page.locator('tbody tr').filter({ hasText: orderNumber }).first()
    await row.getByTitle('View order').click()
    await expect(page.getByRole('heading', { name: 'Order Details' })).toBeVisible()
    await page.getByRole('button', { name: 'Update Status' }).click()
    await expect(page.getByRole('heading', { name: 'Order Details' })).toBeVisible()
    await page.getByTitle('Close').click()
    await page.waitForTimeout(250)
  }
}

test.describe.serial('Dlight Giftshop frontend UAT', () => {
  test('prepare UAT records through the administration frontend', async ({ page }) => {
    await login(page, adminEmail, adminPassword)
    await ensureProduct(page, stockProduct, 'UAT-STOCK-WATCH', false)
    await ensureProduct(page, supplierProduct, 'UAT-DROP-PERFUME', true)
    await ensureSupplier(page)
    await ensureRider(page)
    await ensureCourier(page)
    await ensureStock(page)
    await ensureAttendant(page)
  })

  test('shop attendant completes all five operational workflows', async ({ page, context }) => {
    const stamp = Date.now().toString().slice(-7)
    await login(page, attendantEmail, attendantPassword)

    await test.step('Scenario 1 - walk-in cash sale, receipt and persistence', async () => {
      const customer = `UAT Walkin ${stamp}`
      const order = await createOrder(page, {
        customer, phone: `071${stamp}`, product: stockProduct, payment: 'cash'
      })
      await completeOrder(page, order)
      await page.goto('/customers')
      await page.getByPlaceholder('Search customers...').fill(customer)
      await expect(page.getByText(customer, { exact: true })).toBeVisible()
      await page.goto('/receipts')
      await page.getByPlaceholder('Search order number').fill(order)
      const receiptRow = page.locator('tbody tr').filter({ hasText: order }).first()
      await receiptRow.getByTitle('Sales Receipt').click()
      await expect(page.getByRole('heading', { name: 'Sales Receipt Preview' })).toBeVisible()
      await expect(page.getByText(customer, { exact: true }).last()).toBeVisible()
      await page.screenshot({ path: `${screenshotDir}/01-walk-in-receipt.png`, fullPage: true })
      const popupPromise = context.waitForEvent('page')
      await page.getByRole('button', { name: 'Print' }).click()
      const printPage = await popupPromise
      await expect(printPage).toHaveTitle(new RegExp(order))
      await printPage.close()
      await page.getByTitle('Close').click()
      await page.reload()
      await expect(page.locator('tbody tr').filter({ hasText: order })).toBeVisible()
      await page.goto('/inventory')
      await page.getByPlaceholder('Search inventory...').fill(stockProduct)
      await expect(page.getByText(stockProduct, { exact: true })).toBeVisible()
    })

    await test.step('Scenario 2 - rider delivery and balances', async () => {
      const customer = `UAT Rider ${stamp}`
      const order = await createOrder(page, {
        customer, phone: `072${stamp}`, product: stockProduct, delivery: 'rider',
        payment: 'cash', deliveryIncome: '400', deliveryCost: '500'
      })
      await page.goto('/deliveries')
      await page.getByPlaceholder('Search deliveries...').fill(order)
      await expect(page.locator('tbody tr').filter({ hasText: order })).toBeVisible()
      await page.goto('/riders')
      await page.getByPlaceholder('Search riders...').fill(riderName)
      const riderRow = page.locator('tbody tr').filter({ hasText: riderName }).first()
      const riderBalance = await riderRow.locator('td').filter({ hasText: 'KES' }).innerText()
      expect(Number(riderBalance.replace(/[^0-9.-]/g, ''))).toBeGreaterThanOrEqual(500)
      await page.goto('/dashboard')
      await expect(page.getByText('Rider Payments Due')).toBeVisible()
      await page.screenshot({ path: `${screenshotDir}/02-rider-dashboard.png`, fullPage: true })
    })

    await test.step('Scenario 3 - supplier fulfillment and payable', async () => {
      const customer = `UAT Supplier ${stamp}`
      await createOrder(page, {
        customer, phone: `073${stamp}`, product: supplierProduct,
        fulfillment: 'supplier', payment: 'cash'
      })
      await page.goto('/suppliers')
      await page.getByPlaceholder('Search suppliers...').fill(supplierName)
      const row = page.locator('tbody tr').filter({ hasText: supplierName }).first()
      const balanceText = await row.locator('td').filter({ hasText: 'KES' }).innerText()
      expect(Number(balanceText.replace(/[^0-9.-]/g, ''))).toBeGreaterThanOrEqual(1200)
      await row.getByTitle('View supplier').click()
      await expect(page.getByText('Supplier details')).toBeVisible()
      await page.screenshot({ path: `${screenshotDir}/03-supplier-payable.png`, fullPage: true })
      await page.getByTitle('Close').click()
    })

    await test.step('Scenario 4 - Speedaf COD through remittance', async () => {
      const customer = `UAT COD ${stamp}`
      const order = await createOrder(page, {
        customer, phone: `074${stamp}`, product: stockProduct, delivery: 'courier',
        payment: 'pay_on_delivery', deliveryIncome: '300', deliveryCost: '200',
        tracking: `SPD-UAT-${stamp}`
      })
      await completeOrder(page, order, 3)
      await page.goto('/deliveries')
      await page.getByPlaceholder('Search deliveries...').fill(order)
      const row = page.locator('tbody tr').filter({ hasText: order }).first()
      await row.locator('button').click()
      await expect(page.getByText('Record Speedaf Payment')).toBeVisible()
      await page.screenshot({ path: `${screenshotDir}/04-cod-pending.png`, fullPage: true })
      const amount = await page.getByPlaceholder('Amount received').inputValue()
      expect(Number(amount)).toBeGreaterThan(0)
      await page.getByPlaceholder('M-Pesa or bank reference').fill(`UAT-COD-${stamp}`)
      await page.getByRole('button', { name: 'Record Payment' }).click()
      await expect(page.getByText('Record Speedaf Payment')).toHaveCount(0)
      await page.goto('/dashboard')
      await page.screenshot({ path: `${screenshotDir}/04-cod-remitted-dashboard.png`, fullPage: true })
    })

    await test.step('Scenario 5 - customer credit and payment', async () => {
      const customer = `UAT Credit ${stamp}`
      await createOrder(page, {
        customer, phone: `075${stamp}`, product: stockProduct, payment: 'credit'
      })
      await page.goto('/customers')
      await page.getByPlaceholder('Search customers...').fill(customer)
      const row = page.locator('tbody tr').filter({ hasText: customer }).first()
      await expect(row).toContainText(/1,?500/)
      await row.getByTitle('Record credit payment').click()
      await page.getByPlaceholder('M-Pesa or bank reference').fill(`UAT-CREDIT-${stamp}`)
      await page.getByRole('button', { name: 'Record Payment' }).click()
      await expect(row).toContainText('KES 0')
      await page.screenshot({ path: `${screenshotDir}/05-credit-paid.png`, fullPage: true })
    })
  })

  test('visible actions, filters, export, dashboard empty state, and mobile usability', async ({ page }) => {
    await login(page, adminEmail, adminPassword)
    await page.goto('/dashboard')
    await page.getByLabel('Period').selectOption('custom')
    await page.getByLabel('To', { exact: true }).fill('2099-01-02')
    await page.getByLabel('From', { exact: true }).fill('2099-01-01')
    await expect(page.getByText('No data available').first()).toBeVisible()
    await page.screenshot({ path: `${screenshotDir}/06-dashboard-empty-state.png`, fullPage: true })

    await page.goto('/orders')
    await page.getByPlaceholder('Search orders...').fill('UAT')
    await page.getByLabel('Period').selectOption('custom')
    await page.getByLabel('From', { exact: true }).fill('2026-01-01')
    await expect(page.getByRole('button', { name: 'Clear dates' })).toBeVisible()
    await page.getByRole('button', { name: 'New Order' }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()

    await page.goto('/reports')
    await page.getByRole('button', { name: 'Sales & Profit' }).click()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'CSV' }).click()
    expect((await download).suggestedFilename()).toMatch(/^sales-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/)

    await page.goto('/products')
    await page.getByPlaceholder('Search name, SKU, or barcode').fill(stockProduct)
    const desktopProductRow = page.locator('tbody tr').filter({ hasText: stockProduct }).first()
    await expect(desktopProductRow).toBeVisible()
    await desktopProductRow.getByTitle('View').click()
    await expect(page.getByText('Product details')).toBeVisible()
    await page.getByTitle('Close').click()
    await desktopProductRow.getByTitle('Edit').click()
    await page.getByRole('button', { name: 'Cancel' }).click()

    const temporaryCourier = `UAT Delete ${Date.now()}`
    await page.goto('/couriers')
    await page.getByRole('button', { name: 'Add Courier' }).click()
    await page.getByPlaceholder('Example: Speedaf').fill(temporaryCourier)
    await page.getByPlaceholder('Example: SPD').fill('DEL')
    await page.getByRole('button', { name: 'Create Courier' }).click()
    await page.getByPlaceholder('Search couriers...').fill(temporaryCourier)
    const temporaryRow = page.locator('tbody tr').filter({ hasText: temporaryCourier }).first()
    await expect(temporaryRow).toBeVisible()
    await temporaryRow.locator('button').nth(1).click()
    await expect(temporaryRow).toHaveCount(0)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/orders')
    await expect(page.getByRole('button', { name: 'New Order' })).toBeVisible()
    await page.getByRole('button', { name: 'New Order' }).click()
    await expect(page.getByPlaceholder('Customer name')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save Order' })).toBeVisible()
    await page.screenshot({ path: `${screenshotDir}/07-mobile-order-form.png`, fullPage: true })
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth)
    expect(bodyWidth).toBeLessThanOrEqual(390)
    await page.getByRole('button', { name: 'Cancel' }).click()

    await page.goto('/products')
    await page.getByPlaceholder('Search name, SKU, or barcode').fill(stockProduct)
    const productCard = page.locator('article').filter({ hasText: stockProduct }).first()
    await expect(productCard.getByRole('button', { name: 'View' })).toBeVisible()
    await expect(productCard.getByRole('button', { name: 'Edit' })).toBeVisible()
    await expect(productCard.getByRole('button', { name: 'Delete' })).toBeVisible()
    await productCard.getByRole('button', { name: 'View' }).click()
    await expect(page.getByText('Product details')).toBeVisible()
    await page.screenshot({ path: `${screenshotDir}/08-mobile-table-actions.png`, fullPage: true })
  })
})
