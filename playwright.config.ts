import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.vite/playwright')

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/startTestServer.ts',
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.FX_E2E_EDGE === '1'
      ? [{ name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' as const } }]
      : []),
  ],
})
