import { realpathSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    fs: {
      // pnpm may resolve this worker through a dependency store outside the
      // checkout. Allow only the PDF build assets, not the external workspace.
      allow: [
        path.resolve(__dirname, ".."),
        realpathSync(path.resolve(__dirname, "node_modules/pdfjs-dist/build")),
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
  },
});
