import { test, expect } from '@playwright/test'

test('pre-opening browser smoke check', async ({ page, context }) => {
  const email = process.env.PREOPEN_EMAIL
  const password = process.env.PREOPEN_PASSWORD
  if (!email || !password) throw new Error('PREOPEN_EMAIL and PREOPEN_PASSWORD are required')

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page).toHaveURL(/\/dashboard/)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.goto('/products')
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible()
  await expect(page.getByText('Failed to load products')).toHaveCount(0)

  await page.goto('/orders')
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New Order' })).toBeVisible()

  await page.goto('/receipts')
  await expect(page.getByRole('heading', { name: 'Customer Receipts' })).toBeVisible()
  const printButton = page.getByTitle('Print').first()
  if (await printButton.count()) {
    const popupPromise = context.waitForEvent('page')
    await printButton.click()
    const receipt = await popupPromise
    await expect(receipt).toHaveTitle(/Receipt/)
    await receipt.close()
  }
})
