import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/shared",
      "packages/agent-runtime-utils",
      "packages/agent-runtimes/claude-local",
      "packages/agent-runtimes/codex-local",
      "packages/agent-runtimes/cursor-local",
      "packages/agent-runtimes/gemini-local",
      "packages/agent-runtimes/opencode-local",
      "packages/agent-runtimes/pi-local",
      "server",
      "ui",
      "cli",
      "desktop",
      "scripts",
    ],
  },
});
