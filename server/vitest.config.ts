import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Many server suites own an embedded PostgreSQL instance. Keep lifecycle
    // cleanup deterministic and avoid exhausting macOS SysV shared memory.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    exclude: [
      ...configDefaults.exclude,
      "resources/bundled-skills/app-builder/assets/scaffold/**",
    ],
  },
});
