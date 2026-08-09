import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    fs: {
      allow: [path.resolve(__dirname, "..")],
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
