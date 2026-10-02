import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolver-to-driver regressions load the real server consumer. Vite 6
  // otherwise rejects that source outside this package's test root.
  server: {
    fs: { allow: [fileURLToPath(new URL("../../../", import.meta.url))] },
  },
  test: {
    environment: "node",
  },
});
