import { expect, test, type Page } from '@playwright/test'

const stats = {
  myTodaySales: 40397,
  myPeriodSales: 1014481,
  myPeriodOrders: 127,
  myOpenOrders: 4,
  myCompletedOrders: 133,
  myPendingSpeedafOrders: 7,
  myPendingSpeedafValue: 34847,
  shopStockValue: 250000,
  todayOperatingProfit: 12000,
  monthToDateNetProfit: 90000,
  periodSales: 300000,
  periodOrders: 42,
  periodExpenses: 45000,
  periodDeliveryProfit: 12000,
  totalOrders: 55,
  outstandingCOD: 25000,
  supplierPayables: 60000,
  riderPayables: 5000,
  lowStockCount: 3,
  grossProfit: 140000,
  netProfit: 95000
}

const commissionSummary = {
  dateFrom: '2026-09-01',
  dateTo: '2026-09-04',
  grossEarned: 600,
  reversals: 0,
  carryForwardCredits: 0,
  netCommission: 600,
  approvedPayable: 0,
  settledInPeriod: 0,
  recoveryDue: 0,
  outstandingAmount: 600
}

async function openMockedDashboard(page: Page, role: 'admin' | 'attendant') {
  const permissions = role === 'attendant'
    ? ['dashboard.personal_sales', 'dashboard.personal_orders', 'dashboard.pending_speedaf', 'commission.own_view']
    : []
  await page.addInitScript(({ selectedRole, selectedPermissions }) => {
    localStorage.setItem('auth-storage', JSON.stringify({
      state: {
        user: { id: `mock-${selectedRole}`, email: `${selectedRole}@example.test`, full_name: selectedRole === 'admin' ? 'Admin User' : 'Ann Attendant', role: selectedRole, permissions: selectedPermissions },
        token: 'mock-access-token',
        refreshToken: 'mock-refresh-token'
      },
      version: 0
    }))
  }, { selectedRole: role, selectedPermissions: permissions })

  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/dashboard/stats') return route.fulfill({ json: stats })
    if (pathname === '/api/dashboard/daily-whatsapp-report') {
      return route.fulfill({ json: {
        reportDate: '2026-09-04',
        generatedAt: '2026-09-04T08:00:00.000Z',
        preparedBy: 'Ann Attendant',
        summary: { totalOrders: 2, paidOrders: 1, pendingSpeedafOrders: 1, totalRiderAmount: 200 },
        rows: [
          { orderId: 'order-1', orderNumber: 'ORD-001', location: 'Westlands', productSummary: '1 x Perfume', status: 'paid', handledBy: 'Brian', riderAmount: 200 },
          { orderId: 'order-2', orderNumber: 'ORD-002', location: 'Mombasa', productSummary: '2 x Perfume', status: 'pending_speedaf', handledBy: 'Speedaf', riderAmount: null }
        ]
      } })
    }
    if (pathname === '/api/commissions/status') return route.fulfill({ json: { status: 'active' } })
    if (pathname === '/api/commissions/own/summary') return route.fulfill({ json: commissionSummary })
    if (pathname === '/api/commissions/periods/readiness') return route.fulfill({ json: null })
    if (pathname === '/api/commissions/summary') {
      return route.fulfill({ json: { totalEarned: 5000, totalReversals: 100, totalPayments: 3000, settledInPeriod: 3000, approvedUnpaid: 500, approvedPayable: 500, pendingAmount: 1400, outstandingAmount: 1900, netCommission: 4900, recoveryDue: 0, salespersonCount: 2, orderCount: 20, itemCount: 24 } })
    }
    if (pathname === '/api/commissions/by-salesperson') return route.fulfill({ json: { salespeople: [] } })
    return route.fulfill({ json: {} })
  })

  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

async function expectTwoColumns(page: Page, testId: string) {
  const columns = await page.getByTestId(testId).evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  expect(columns).toBe(2)
}

test('keeps the attendant dashboard compact while leaving reports obvious', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openMockedDashboard(page, 'attendant')

  await expectTwoColumns(page, 'personal-stats-grid')
  await expectTwoColumns(page, 'personal-commission-grid')
  await expect(page.getByRole('button', { name: /Download image/ })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Location / Order' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.getByRole('columnheader', { name: 'Location / Order' })).toBeVisible()
  await page.getByRole('button', { name: /Hide preview/ }).click()
  await expect(page.getByRole('columnheader', { name: 'Location / Order' })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('keeps the admin dashboard compact and all detail cards clickable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openMockedDashboard(page, 'admin')

  await expectTwoColumns(page, 'business-stats-grid')
  await expectTwoColumns(page, 'company-commission-grid')
  await expect(page.getByTitle('View Period Sales')).toBeVisible()
  await expect(page.getByTitle('View Pending approval')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'My activity' })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
