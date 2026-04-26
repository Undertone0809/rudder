import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts", "tests/**/*.spec.tsx"],
    environmentMatchGlobs: [["tests/ui.spec.tsx", "jsdom"]],
    setupFiles: ["./tests/vitest.setup.ts"],
  },
});
