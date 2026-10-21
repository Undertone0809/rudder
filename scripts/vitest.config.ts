import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    environment: "node",
    include: ["release-*.test.mjs", "runtime-*.test.mjs", "perf/*.test.ts"],
    exclude: [...configDefaults.exclude, "release-candidate-manifest.test.mjs"],
  },
});
