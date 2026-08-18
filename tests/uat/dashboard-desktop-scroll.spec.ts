import { expect, test, type Page } from '@playwright/test'

const adminEmail = process.env.COMMISSION_ADMIN_EMAIL || process.env.PREOPEN_EMAIL
const adminPassword = process.env.COMMISSION_ADMIN_PASSWORD || process.env.PREOPEN_PASSWORD

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(adminEmail!)
  await page.getByLabel('Password', { exact: true }).fill(adminPassword!)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page).toHaveURL(/\/dashboard/)
}

test('keeps desktop drilldown navigation visible while records scroll', async ({ page }) => {
  test.skip(!adminEmail || !adminPassword, 'Commission admin credentials are required')
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)

  const recordedCard = page.getByTitle('View Recorded')
  await expect(recordedCard).toBeVisible()
  await recordedCard.click()

  const dialog = page.getByRole('dialog', { name: 'Company recorded commission sales' })
  await expect(dialog).toBeVisible()
  const scroller = dialog.locator('[data-desktop-table-scroll="commission sales"]')
  await expect(scroller).toBeVisible()

  const dimensions = await scroller.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    top: element.getBoundingClientRect().top,
    bottom: element.getBoundingClientRect().bottom,
  }))
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth)

  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
  const afterVerticalScroll = await scroller.evaluate(element => ({
    top: element.getBoundingClientRect().top,
    bottom: element.getBoundingClientRect().bottom,
    scrollTop: element.scrollTop,
  }))
  expect(afterVerticalScroll.scrollTop).toBeGreaterThan(0)
  expect(afterVerticalScroll.top).toBe(dimensions.top)
  expect(afterVerticalScroll.bottom).toBe(dimensions.bottom)

  const stickyHeader = scroller.locator('thead')
  expect(await stickyHeader.evaluate(element => getComputedStyle(element).position)).toBe('sticky')

  const moveRight = dialog.getByRole('button', { name: 'Show more commission sales columns' })
  await expect(moveRight).toBeVisible()
  await expect(moveRight).toBeEnabled()
  await moveRight.click()
  await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
})
