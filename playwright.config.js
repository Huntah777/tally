import { defineConfig, devices } from '@playwright/test';

/* Unit specs (engine, importers, receipt) run in Node and need no server.
   API and UI specs run against `wrangler pages dev` with a throwaway local
   D1, so they exercise the real Functions, auth and merge code. */
const PORT = 8791;
/* The test server runs invite-only, like production. */
export const INVITE = 'Test-Invite-42';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'on-first-retry' },
  projects: [
    { name: 'unit', testMatch: /(engine|importers|receipt|dishes)\.spec\.js/ },
    { name: 'api', testMatch: /api\.spec\.js/ },
    { name: 'chromium', testMatch: /app\.spec\.js/, use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone', testMatch: /app\.spec\.js/, use: { ...devices['iPhone 15'], browserName: 'chromium' } },
    /* Rebuilds dist/ to simulate a deploy, so it runs alone, after everything else. */
    { name: 'updates', testMatch: /updates\.spec\.js/, dependencies: ['unit', 'api', 'chromium', 'iphone'], use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    /* Fresh database every run: the login throttle is per IP and every
       test shares one, so leftover failures from a previous run would lock
       later runs out. */
    command: `node -e "require('fs').rmSync('.wrangler/test-state',{recursive:true,force:true})" && npx wrangler d1 execute tally-db --local --file=schema.sql --persist-to=.wrangler/test-state && node scripts/build.mjs && npx wrangler pages dev --port ${PORT} --persist-to=.wrangler/test-state --binding SIGNUP_CODE=${INVITE}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
