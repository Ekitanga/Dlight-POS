import { test, expect } from '@playwright/test'

test('administrative browser login is available for UAT setup', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@dlight.com')
  await page.getByLabel('Password').fill('password')
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page).toHaveURL(/\/dashboard/)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})
