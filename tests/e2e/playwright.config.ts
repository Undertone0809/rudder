import path from "node:path";

import { defineConfig } from "@playwright/test";
import {
  E2E_BASE_URL,
  E2E_BIN_DIR,
  E2E_CLAUDE_STUB,
  E2E_CODEX_ERROR_STUB,
  E2E_CODEX_STUB,
  E2E_DB_PORT,
  E2E_HOME,
  E2E_INSTANCE_ID,
  E2E_INSTANCE_ROOT,
  E2E_PORT,
} from "./support/e2e-env";

const PORT = E2E_PORT;
const BASE_URL = E2E_BASE_URL;
const USE_EXISTING_SERVER = process.env.RUDDER_E2E_USE_EXISTING_SERVER === "1";
const E2E_CONFIG = path.join(E2E_INSTANCE_ROOT, "config.json");
const E2E_DATABASE_URL = process.env.RUDDER_E2E_DATABASE_URL?.trim() || null;

const e2eConfigJson = JSON.stringify(
  {
    $meta: {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "onboard",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(E2E_INSTANCE_ROOT, "db"),
      embeddedPostgresPort: E2E_DB_PORT,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(E2E_INSTANCE_ROOT, "data/backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(E2E_INSTANCE_ROOT, "logs"),
    },
    server: { deploymentMode: "local_trusted", host: "127.0.0.1", port: PORT },
    auth: { baseUrlMode: "auto" },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(E2E_INSTANCE_ROOT, "data/storage"),
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(E2E_INSTANCE_ROOT, "secrets/master.key"),
      },
    },
  },
  null,
  2
);
const SERVER_ENV_PREFIX = [
  `PATH="${E2E_BIN_DIR}:$PATH"`,
  E2E_DATABASE_URL ? `DATABASE_URL="${E2E_DATABASE_URL}"` : "",
  `RUDDER_HOME="${E2E_HOME}"`,
  `RUDDER_INSTANCE_ID="${E2E_INSTANCE_ID}"`,
  `RUDDER_E2E_HOME="${E2E_HOME}"`,
  `RUDDER_E2E_INSTANCE_ID="${E2E_INSTANCE_ID}"`,
  `RUDDER_E2E_PORT="${PORT}"`,
  `RUDDER_E2E_DB_PORT="${E2E_DB_PORT}"`,
  `RUDDER_E2E_BASE_URL="${BASE_URL}"`,
  "RUDDER_UI_DEV_MIDDLEWARE=true",
]
  .filter(Boolean)
  .join(" ");
const CLEAR_LANGFUSE_ENV_COMMAND =
  "unset LANGFUSE_ENABLED LANGFUSE_BASE_URL LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_ENVIRONMENT;";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // The webServer directive starts `rudder run` before tests.
  // Use an isolated Rudder home so onboarding always starts from a clean instance.
  webServer: USE_EXISTING_SERVER
    ? undefined
    : {
    command: `bash -lc 'set -euo pipefail; rm -rf "${E2E_HOME}"; mkdir -p "$(dirname "${E2E_CONFIG}")" "${E2E_BIN_DIR}"; cat > "${E2E_CODEX_STUB}" <<'"'"'EOF'"'"'
#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.on("SIGTERM", () => {
  process.exit(0);
});
process.stdin.on("end", async () => {
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const finalText = "Streaming reply for chat.\\n" + sentinel + JSON.stringify({
    kind: "message",
    body: "Streaming reply for chat.",
    structuredPayload: null,
  });
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-e2e", model: "gpt-5.4" }) + "\\n");
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: { id: "reason-1", type: "reasoning", text: "Inspecting current chat state" },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "item.started",
      item: { type: "tool_use", id: "tool-1", name: "command_execution", input: { command: "echo chat" } },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: { type: "tool_result", tool_use_id: "tool-1", content: "TRANSCRIPT_TOOL_OUTPUT_E2E", status: "completed" },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: { id: "msg-1", type: "agent_message", text: "Streaming reply " },
    }) + "\\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 5000));
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "msg-2",
        type: "agent_message",
        text: finalText.replace("Streaming reply ", ""),
      },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "turn.completed",
      result: finalText,
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    }) + "\\n",
  );
});
EOF
chmod +x "${E2E_CODEX_STUB}"
cat > "${E2E_CLAUDE_STUB}" <<'"'"'EOF'"'"'
#!/usr/bin/env bash
cat >/dev/null
printf "%s\\n" "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}"
printf "%s\\n" "{\"type\":\"result\",\"result\":\"hello\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"cache_read_input_tokens\":0}}"
EOF
chmod +x "${E2E_CLAUDE_STUB}"
cat > "${E2E_CODEX_ERROR_STUB}" <<'"'"'EOF'"'"'
#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  console.error([
    "file:///stub/codex.js:100",
    "    throw new Error(",
    "          ^",
    "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
    "    at file:///stub/codex.js:100:11",
    "    at ModuleJob.run (node:internal/modules/esm/module_job:329:25)",
    "Node.js v22.17.0",
  ].join("\\n"));
  process.exit(1);
});
EOF
chmod +x "${E2E_CODEX_ERROR_STUB}"
cat > "${E2E_CONFIG}" <<'"'"'EOF'"'"'
${e2eConfigJson}
EOF
${CLEAR_LANGFUSE_ENV_COMMAND}
${SERVER_ENV_PREFIX} pnpm --filter @rudderhq/server dev'`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
