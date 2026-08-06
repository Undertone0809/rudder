import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // These suites create real embedded PostgreSQL clusters. Running them in
    // parallel exhausts macOS SysV shared memory before teardown can run.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
