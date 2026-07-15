import { expect, test } from '@playwright/test'

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@dlight.com')
  await page.getByLabel('Password').fill('password')
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page).toHaveURL(/\/dashboard/)
}

test('previews controlled business appearance settings', async ({ page }) => {
  await login(page)
  await page.goto('/settings')

  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await expect(page.getByText('Dlight Gold')).toBeVisible()
  await expect(page.getByText('Live appearance preview')).toBeVisible()

  await page.getByText('Dark', { exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)

  await page.getByRole('button', { name: /Emerald/ }).click()
  await expect(page.getByText('Live appearance preview')).toBeVisible()
})

test('keeps navigation and appearance settings usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.getByRole('button', { name: /menu/i }).click()
  await page.getByRole('link', { name: 'Settings' }).click()

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
})
