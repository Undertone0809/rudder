import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Vite 6.4.3 checks filesystem access for the shared setup module too.
  server: {
    fs: { allow: [fileURLToPath(new URL("../", import.meta.url))] },
  },
  test: {
    environment: "node",
    // Many server suites own an embedded PostgreSQL instance. Keep lifecycle
    // cleanup deterministic and avoid exhausting macOS SysV shared memory.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    globalSetup: fileURLToPath(new URL("../scripts/vitest-postgres-global-setup.ts", import.meta.url)),
    exclude: [
      ...configDefaults.exclude,
      "resources/bundled-skills/app-builder/assets/scaffold/**",
    ],
  },
});
