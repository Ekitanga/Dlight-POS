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
          { orderId: 'order-1', orderNumber: 'ORD-001', location: 'Westlands', productSummary: '1 x Perfume', sourceSummary: 'Shop stock', items: [
            { quantity: 1, productName: 'A very long perfume product name that remains fully visible in the report', sources: ['Shop stock'] },
            { quantity: 1, productName: 'Bvlgari Man in Black Eau de Parfum 100ml – Men, Spicy Amber Fragrance', sources: ['Essential Scents'] },
            { quantity: 2, productName: 'Carolina Herrera Good Girl Eau de Parfum Suprême', sources: ['Prompt Scents'] },
            { quantity: 1, productName: 'Giorgio Armani My Way Eau de Parfum', sources: ['Aroma House'] },
            { quantity: 1, productName: 'Valentino Donna Born In Roma Yellow Dream Eau de Parfum', sources: ['Fragrance Hub'] },
            { quantity: 3, productName: 'Burberry Goddess Eau de Parfum 100ml', sources: ['Nairobi Perfumes'] },
            { quantity: 1, productName: 'Dolce & Gabbana Light Blue Eau de Toilette', sources: ['Luxury Scents'] }
          ], status: 'paid', handledBy: 'Brian', riderAmount: 200 },
          { orderId: 'order-2', orderNumber: 'ORD-002', location: 'Mombasa', productSummary: '2 x Perfume', sourceSummary: 'Scent Supplier', items: [{ quantity: 2, productName: 'Perfume', sources: ['Scent Supplier'] }], status: 'pending_speedaf', handledBy: 'Speedaf', riderAmount: null }
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
  await expect(page.getByRole('columnheader', { name: 'Item(s) and source' })).toBeVisible()
  await expect(page.getByText('A very long perfume product name that remains fully visible in the report')).toBeVisible()
  await expect(page.getByText('Shop stock', { exact: true })).toBeVisible()
  await expect(page.getByText('Scent Supplier', { exact: true })).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /Download image/ }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('dlight-daily-report-2026-09-04.png')
  await download.saveAs('artifacts/daily-report-layout-preview.png')
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

test('shows every sales-analysis item with its matching supplier tag', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('auth-storage', JSON.stringify({
      state: {
        user: { id: 'mock-admin', email: 'admin@example.test', full_name: 'Admin User', role: 'admin', permissions: [] },
        token: 'mock-access-token',
        refreshToken: 'mock-refresh-token'
      },
      version: 0
    }))
  })
  await page.route('**/api/**', async route => {
    const requestUrl = new URL(route.request().url())
    const pathname = requestUrl.pathname
    if (pathname === '/api/reports/sales') {
      expect(requestUrl.searchParams.get('structured_items')).toBe('1')
      return route.fulfill({ json: [{
        order_number: 'ORD-ITEM-TAGS', sale_date: '2026-10-06', customer: 'Report Customer', status: 'delivered', payment_status: 'paid', delivery_type: 'rider', revenue: 12000, delivery_cost: 400,
        items: '1 x Long product [Essential Scents]',
        item_details: [
          { quantity: 1, productName: 'A complete long product name that must wrap without being shortened or hidden', sources: ['Essential Scents'], saleTotal: 6200, productCost: 2500, grossProfit: 3700 },
          { quantity: 2, productName: 'Second product supplied from another business', sources: ['Prompt Scents'], saleTotal: 4000, productCost: 1800, grossProfit: 2200 },
          { quantity: 1, productName: 'Hybrid fulfilled product', sources: ['Shop stock', 'Luxury Scents'], saleTotal: 1800, productCost: 700, grossProfit: 1100 }
        ],
        product_cost: 5000, profit: 6600, margin_percent: 55, payment_methods: 'cash'
      }] })
    }
    return route.fulfill({ json: {} })
  })

  await page.goto('/reports?department=sales&report=sales&date_from=2026-10-06&date_to=2026-10-06')
  await expect(page.getByRole('heading', { name: 'Business Intelligence' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Items and Profitability' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Total Product Cost' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Net Order Profit' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Item Details' })).toHaveCount(0)
  await expect(page.getByText('A complete long product name that must wrap without being shortened or hidden')).toBeVisible()
  await expect(page.getByText('Essential Scents', { exact: true })).toBeVisible()
  await expect(page.getByText('Prompt Scents', { exact: true })).toBeVisible()
  await expect(page.getByText('Shop stock', { exact: true })).toBeVisible()
  await expect(page.getByText('Luxury Scents', { exact: true })).toBeVisible()
  await expect(page.getByText('KES 6,200', { exact: true })).toBeVisible()
  await expect(page.getByText('KES 2,500', { exact: true })).toBeVisible()
  await expect(page.getByText('KES 3,700', { exact: true })).toBeVisible()
  await expect(page.getByText('KES 2,000 each', { exact: true })).toBeVisible()
  await expect(page.getByText('KES 900 each', { exact: true })).toBeVisible()
  await expect(page.getByText('KES 1,100 each', { exact: true })).toBeVisible()
  await page.getByText('A complete long product name that must wrap without being shortened or hidden').scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'artifacts/sales-analysis-profitability.png', fullPage: true })
})
