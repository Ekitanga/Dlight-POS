import { test, expect } from '@playwright/test'

const csvPath = process.env.PRODUCT_IMPORT_CSV
const email = process.env.PREOPEN_EMAIL
const password = process.env.PREOPEN_PASSWORD
const expectedRows = process.env.EXPECTED_IMPORT_ROWS || '232'
const excludedRows = process.env.EXPECTED_EXCLUDED_ROWS
const replaceCategory = process.env.REPLACE_IMPORT_CATEGORY === 'true'

test('imports the supplied product catalogue through the browser', async ({ page }) => {
  test.skip(!csvPath || !email || !password, 'PRODUCT_IMPORT_CSV and PREOPEN credentials are required')

  await page.goto('/login')
  await page.getByLabel('Email').fill(email!)
  await page.getByLabel('Password').fill(password!)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page).toHaveURL(/\/dashboard/)

  await page.goto('/products')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await page.locator('input[type="file"]').setInputFiles(csvPath!)
  await expect(page.getByText(new RegExp(`${expectedRows} product rows ready to import`))).toBeVisible()
  if (excludedRows) {
    await expect(page.getByText(new RegExp(`${excludedRows} out-of-stock rows excluded`))).toBeVisible()
  }

  await page.getByLabel('Category for rows without a category').fill('Perfumes')
  await page.getByLabel('When an SKU or product name already exists').selectOption('update')
  if (replaceCategory) {
    await page.getByLabel('Archive products missing from this import').check()
  }
  await page.getByRole('button', { name: `Import ${expectedRows} Products` }).click()

  await expect(page.getByText('Import complete.')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/Created \d+, updated \d+, skipped \d+, archived \d+\./)).toBeVisible()
  await expect(page.getByText(/rows had errors/)).toHaveCount(0)
})
