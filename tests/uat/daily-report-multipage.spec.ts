import { expect, test } from '@playwright/test'

// Runs against the local dev server by default. UAT_BASE_URL can point it at a
// deployed site: every /api call is mocked, so no real data is read or written.
if (process.env.UAT_BASE_URL) test.use({ baseURL: process.env.UAT_BASE_URL })
// e.g. UAT_HOST_MAP="169-58-30-49.sslip.io 169.58.30.49" when local DNS cannot resolve the host.
if (process.env.UAT_HOST_MAP) {
  test.use({
    launchOptions: {
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: [`--host-resolver-rules=MAP ${process.env.UAT_HOST_MAP}`]
    }
  })
}

const ORDER_COUNT = 40

function busyDayReport() {
  const rows = Array.from({ length: ORDER_COUNT }, (_, index) => {
    const number = index + 1
    const itemCount = (index % 3) + 1
    return {
      orderId: `order-${number}`,
      orderNumber: `ORD-${String(number).padStart(3, '0')}`,
      location: number % 4 === 0 ? 'Shop collection' : `Location ${number}`,
      productSummary: `${itemCount} items`,
      sourceSummary: 'Essential Scents',
      items: Array.from({ length: itemCount }, (_unused, itemIndex) => ({
        quantity: 1,
        productName: `Order ${number} item ${itemIndex + 1} – Maison Francis Kurkdjian Baccarat Rouge 540 EDP 70ml Unisex`,
        sources: [itemIndex % 2 === 0 ? 'Essential Scents' : 'Shop stock']
      })),
      status: number % 5 === 0 ? 'pending_speedaf' : 'paid',
      handledBy: number % 2 === 0 ? 'Alex' : 'Brian Migot',
      riderAmount: number % 4 === 0 ? null : 350
    }
  })
  return {
    reportDate: '2026-11-16',
    generatedAt: '2026-11-16T15:00:00.000Z',
    preparedBy: 'Ann',
    summary: { totalOrders: ORDER_COUNT, paidOrders: 32, pendingSpeedafOrders: 8, totalRiderAmount: 10500 },
    rows
  }
}

test('a busy daily report downloads every page with one Download all click', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('auth-storage', JSON.stringify({
      state: { user: { id: 'mock-attendant', email: 'ann@example.test', full_name: 'Ann', role: 'attendant', permissions: ['dashboard.personal_sales', 'dashboard.personal_orders'] } },
      version: 1
    }))
  })
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/dashboard/daily-whatsapp-report') return route.fulfill({ json: busyDayReport() })
    if (pathname === '/api/auth/branding') return route.fulfill({ json: { company_name: 'Dlight Giftshop' } })
    return route.fulfill({ json: {} })
  })

  await page.goto('/dashboard')
  const button = page.getByRole('button', { name: /Download all \(\d+ pages\)/ })
  await expect(button).toBeVisible()
  const pages = Number((await button.textContent())?.match(/\((\d+) pages\)/)?.[1])
  expect(pages).toBeGreaterThan(1)

  const downloads: string[] = []
  page.on('download', async download => {
    downloads.push(download.suggestedFilename())
    await download.saveAs(`artifacts/daily-report-multipage/${download.suggestedFilename()}`)
  })
  await button.click()
  await expect(page.getByText(`Downloaded all ${pages} pages`)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(pages)
  expect(downloads.sort()).toEqual(
    Array.from({ length: pages }, (_, index) => `dlight-daily-report-2026-11-16-page-${index + 1}-of-${pages}.png`).sort()
  )
})
