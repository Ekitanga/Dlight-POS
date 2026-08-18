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

async function reportOverflow(page: Page, screen: string) {
  const report = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    offenders: Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .map(element => {
        const rect = element.getBoundingClientRect()
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className : '',
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width)
        }
      })
      .filter(item => item.right > window.innerWidth + 2 || item.left < -2)
      .slice(0, 15),
    clipped: Array.from(document.querySelectorAll<HTMLElement>('main *'))
      .filter(element => element.scrollWidth > element.clientWidth + 2)
      .map(element => ({
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === 'string' ? element.className : '',
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX
      }))
      .slice(0, 20)
  }))
  console.log(`[mobile overflow] ${screen}: ${JSON.stringify(report)}`)
  expect(report.documentWidth, `${screen} should not move the whole page sideways`).toBeLessThanOrEqual(report.viewport + 1)
  return report
}

test('audits new dashboard and commission features at phone width', async ({ page }) => {
  test.skip(!adminEmail || !adminPassword, 'Commission admin credentials are required')
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await reportOverflow(page, 'dashboard')

  const salesAgentsCard = page.getByTitle('View Sales agents')
  if (await salesAgentsCard.count()) {
    await salesAgentsCard.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    if (await dialog.getByText('No records contribute to this card.').count() === 0) {
      await expect(dialog.getByTestId('mobile-drilldown-cards')).toBeVisible()
      await expect(dialog.locator('table:visible')).toHaveCount(0)
    }
    await dialog.getByRole('button', { name: 'Close details' }).last().click()
  }

  await page.goto('/commissions')
  await expect(page.getByRole('heading', { name: 'Commission centre' })).toBeVisible()
  await reportOverflow(page, 'commission centre')
  const tabStrip = page.getByRole('tablist', { name: 'Commission sections' })
  await expect(tabStrip).toBeVisible()
  expect(await tabStrip.evaluate(element => getComputedStyle(element).overflowX)).toBe('auto')

  for (const tabName of ['Management review', 'Programme settings', 'Commission controls']) {
    const tab = page.getByRole('button', { name: tabName })
    if (await tab.count()) {
      await tab.click()
      await reportOverflow(page, `commission centre - ${tabName}`)
      const moreColumns = page.locator('button[aria-label^="Show more"]:visible').first()
      if (await moreColumns.count() && await moreColumns.isEnabled()) {
        const scroller = moreColumns.locator('xpath=ancestor::div[contains(@class,"min-w-0")][1]').locator('[data-mobile-table-scroll]')
        const before = await scroller.evaluate(element => element.scrollLeft)
        await moreColumns.click()
        await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(before)
      }
    }
  }

  await page.goto('/orders')
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible()
  await reportOverflow(page, 'orders')

  await page.goto('/deliveries')
  await expect(page.getByRole('heading', { name: 'Deliveries' })).toBeVisible()
  await reportOverflow(page, 'deliveries')
})
