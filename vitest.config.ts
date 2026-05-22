import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/shared",
      "packages/agent-runtime-utils",
      "packages/agent-runtimes/claude-local",
      "packages/agent-runtimes/opencode-local",
      "server",
      "ui",
      "cli",
      "desktop",
      "scripts",
    ],
  },
});
