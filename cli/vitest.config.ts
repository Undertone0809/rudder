import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 180000,
    hookTimeout: 180000,
    globalSetup: fileURLToPath(new URL("../scripts/vitest-postgres-global-setup.ts", import.meta.url)),
  },
});
