import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  reporter: process.env.CI ? 'github' : 'list',
  use: { browserName: 'chromium' },
});
