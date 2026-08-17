import { test, expect, type Page } from '@playwright/test'

const adminEmail = process.env.COMMISSION_ADMIN_EMAIL || process.env.PREOPEN_EMAIL
const adminPassword = process.env.COMMISSION_ADMIN_PASSWORD || process.env.PREOPEN_PASSWORD
const attendantEmail = process.env.COMMISSION_ATTENDANT_EMAIL
const attendantPassword = process.env.COMMISSION_ATTENDANT_PASSWORD

async function login(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page).toHaveURL(/\/dashboard/)
}

test('shows management commission information without personal activity on the admin dashboard', async ({ page }) => {
  test.skip(!adminEmail || !adminPassword, 'Commission admin credentials are required')
  await login(page, adminEmail!, adminPassword!)

  await expect(page.getByRole('heading', { name: 'Business overview' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'My activity' })).toHaveCount(0)
  const commission = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Commission overview' }) })
  await expect(commission.getByText('Company commission approvals and payments')).toBeVisible()
  await expect(commission.getByText('Pending approval', { exact: true })).toBeVisible()
  await expect(commission.getByText('Approved for payment', { exact: true })).toBeVisible()
  await expect(commission.getByRole('heading', { name: 'Sales agent summary' })).toBeVisible()

  await commission.getByTitle('View Pending approval').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Unable to load dashboard details')).toHaveCount(0)
  await expect(dialog.getByRole('columnheader', { name: 'Salesperson' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close details' }).last().click()
})

test('keeps personal activity and personal commission on the attendant dashboard', async ({ page }) => {
  test.skip(!attendantEmail || !attendantPassword, 'Commission attendant credentials are required')
  await login(page, attendantEmail!, attendantPassword!)

  await expect(page.getByRole('heading', { name: 'My activity' })).toBeVisible()
  await expect(page.getByText('My commission — current month', { exact: true })).toBeVisible()
  await expect(page.getByText('Company commission approvals and payments')).toHaveCount(0)
})
