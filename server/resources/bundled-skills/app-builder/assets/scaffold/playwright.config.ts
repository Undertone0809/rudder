import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.RUDDER_APP_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  webServer: process.env.RUDDER_APP_BASE_URL
    ? undefined
    : {
        command: "pnpm exec next dev --hostname 127.0.0.1 --port 3000",
        url: "http://127.0.0.1:3000/api/__rudder/health",
        reuseExistingServer: true,
        timeout: 120_000,
      },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
      },
    },
  ],
});
