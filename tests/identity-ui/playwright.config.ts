import { defineConfig } from "@playwright/test";

const port = 3211;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: [
      `IDENTITY_BASE_URL=${baseURL}`,
      "IDENTITY_GOOGLE_CLIENT_ID=identity-ui-google-fixture",
      "IDENTITY_GITHUB_CLIENT_ID=identity-ui-github-fixture",
      "pnpm --filter @rudderhq/identity dev",
    ].join(" "),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  outputDir: "./test-results",
  reporter: [["list"]],
});
