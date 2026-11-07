import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runs only the real Native Chat recovery browser workflow. The spec owns its
 * disposable PostgreSQL and Rust/Node listeners, so this config must not run
 * the general E2E global setup or start the legacy webServer.
 */
export default defineConfig({
  testDir: TEST_DIR,
  testMatch: "native-chat-*.spec.ts",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  outputDir: path.join(os.tmpdir(), `rudder-native-chat-recovery-playwright-${process.pid}`),
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
