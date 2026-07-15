import { test, expect } from '@playwright/test'

const email = process.env.PREOPEN_EMAIL
const password = process.env.PREOPEN_PASSWORD
const searchTerm = process.env.PRODUCT_SEARCH_TERM
const expectedProduct = process.env.EXPECTED_PRODUCT_NAME || searchTerm

test('searches and selects a product while creating an order', async ({ page }) => {
  test.skip(!email || !password || !searchTerm, 'PREOPEN credentials and PRODUCT_SEARCH_TERM are required')

  await page.goto('/login')
  await page.getByLabel('Email').fill(email!)
  await page.getByLabel('Password').fill(password!)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page).toHaveURL(/\/dashboard/)

  await page.goto('/orders')
  await page.getByRole('button', { name: 'New Order' }).click()
  await page.getByRole('button', { name: 'Search and select product' }).click()
  await page.getByPlaceholder('Search product name, SKU, or price').fill(searchTerm!)

  const result = page.getByRole('option').filter({ hasText: expectedProduct! }).first()
  await expect(result).toContainText('KES')
  await expect(result).toContainText('Available')
  await result.click()

  await expect(page.getByRole('button', { name: new RegExp(expectedProduct!, 'i') })).toBeVisible()
  await expect(page.getByPlaceholder('Selling price')).not.toHaveValue('')
})
