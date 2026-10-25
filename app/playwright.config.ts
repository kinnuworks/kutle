import { defineConfig, devices } from "@playwright/test";

// Smoke tests against the seeded local chain. Start it first:
//   node scripts/dev-chain.mjs        (writes .env.development.local)
//   pnpm test:e2e                     (starts the dev server if needed)
export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  retries: 0,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "pnpm dev", url: "http://localhost:5173", reuseExistingServer: true, timeout: 60_000 },
});
