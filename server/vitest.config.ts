import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [
      ...configDefaults.exclude,
      "resources/bundled-skills/app-builder/assets/scaffold/**",
    ],
  },
});
