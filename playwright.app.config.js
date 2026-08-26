import { defineConfig } from '@playwright/test'

const baseURL = 'http://127.0.0.1:5174/'

const project = (name, identity) => ({
  name,
  grep: new RegExp(`@(?:all|${name})\\b`),
  use: {
    extraHTTPHeaders: {
      'X-BWM-Local-Identity': identity,
    },
  },
})

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/app-*.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    project('owner', 'owner@example.test'),
    project('coordinator', 'coordinator@example.test'),
    project('specialist', 'specialist@example.test'),
  ],
  webServer: {
    command: 'npm run dev:app:e2e',
    gracefulShutdown: {
      signal: 'SIGTERM',
      timeout: 30_000,
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
