import { defineConfig, devices } from '@playwright/test';

// BASE_URL=<preview or live url> npm run test:e2e   — or locally it starts the dev servers.
const baseURL = process.env.BASE_URL || 'http://localhost:5173';
export default defineConfig({
  testDir: 'e2e',
  timeout: 30000,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.BASE_URL ? undefined : { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60000 },
});
