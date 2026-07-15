import { test, expect } from '@playwright/test'

const email = process.env.PREOPEN_EMAIL
const password = process.env.PREOPEN_PASSWORD
const orderNumber = process.env.STATUS_CHECK_ORDER
const expectedAction = process.env.EXPECTED_STATUS_ACTION

test('shows only actions valid for the current order stage', async ({ page }) => {
  test.skip(!email || !password || !orderNumber || !expectedAction, 'Status check credentials and order details are required')

  await page.goto('/login')
  await page.getByLabel('Email').fill(email!)
  await page.getByLabel('Password').fill(password!)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page).toHaveURL(/\/dashboard/)

  await page.goto('/orders')
  await page.getByPlaceholder('Search orders...').fill(orderNumber!)
  const row = page.locator('tbody tr').filter({ hasText: orderNumber! }).first()
  await row.getByTitle('View order').click()

  const actions = page.getByText('Next Action', { exact: true }).locator('..').locator('select')
  await expect(actions.locator('option')).toHaveText([expectedAction!])
})
