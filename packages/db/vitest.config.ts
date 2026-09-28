import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Shared PostgreSQL setup lives above this package's test root. Keep Vite's
  // filesystem fence enabled while explicitly admitting this workspace.
  server: {
    fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] },
  },
  test: {
    environment: "node",
    // These suites create real embedded PostgreSQL clusters. Running them in
    // parallel exhausts macOS SysV shared memory before teardown can run.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    globalSetup: fileURLToPath(new URL("../../scripts/vitest-postgres-global-setup.ts", import.meta.url)),
  },
});
