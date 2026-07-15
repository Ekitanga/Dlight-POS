import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/uat',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'artifacts/uat-report', open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    browserName: 'chromium',
    launchOptions: { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  outputDir: 'artifacts/uat-results'
})
