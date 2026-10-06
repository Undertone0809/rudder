import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";

import {
  E2E_BIN_DIR,
  E2E_CLAUDE_STUB,
  E2E_CODEX_ERROR_STUB,
  E2E_CODEX_STUB,
} from "./e2e-env";

// Keep existing-server setup limited to the test CLI stubs. In particular,
// this module must not import PostgreSQL cleanup or server lifecycle helpers.
const CODEX_STUB_SOURCE = String.raw`#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.on("SIGTERM", () => {
  process.exit(0);
});
process.stdin.on("end", async () => {
  if (/Respond with hello\.?/i.test(prompt)) {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-e2e", model: "gpt-5.4" }) + "\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed", result: "hello", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\n");
    return;
  }
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const finalText = "Streaming reply for chat.\n" + sentinel + JSON.stringify({
    kind: "message",
    body: "Streaming reply for chat.",
    structuredPayload: null,
  });
  const memoryToolName = /para-memory-files/i.test(prompt) ? "para-memory-files" : "command_execution";
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-e2e", model: "gpt-5.4" }) + "\n");
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: { id: "reason-1", type: "reasoning", text: "Inspecting current chat state" },
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "item.started",
      item: { type: "tool_use", id: "tool-1", name: memoryToolName, input: { command: "echo chat" } },
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: { type: "tool_result", tool_use_id: "tool-1", content: "TRANSCRIPT_TOOL_OUTPUT_E2E", status: "completed" },
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: { id: "msg-1", type: "agent_message", text: "Streaming reply " },
    }) + "\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "msg-2",
        type: "agent_message",
        text: finalText.replace("Streaming reply ", ""),
      },
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "turn.completed",
      result: finalText,
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }) + "\n",
  );
});
`;

const CLAUDE_STUB_SOURCE = String.raw`#!/usr/bin/env bash
cat >/dev/null
printf "%s\\n" "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}"
printf "%s\\n" "{\"type\":\"result\",\"result\":\"hello\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"cache_read_input_tokens\":0}}"
`;

const CODEX_ERROR_STUB_SOURCE = String.raw`#!/usr/bin/env node
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
  ].join("\n"));
  process.exit(1);
});
`;

async function writeExecutableStub(filePath: string, source: string): Promise<void> {
  try {
    const existing = await lstat(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace a non-file E2E CLI stub: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await writeFile(filePath, source, { mode: 0o755 });
  await chmod(filePath, 0o755);
}

export default async function existingServerSetup(): Promise<void> {
  await mkdir(E2E_BIN_DIR, { recursive: true });
  const binDirectory = await lstat(E2E_BIN_DIR);
  if (!binDirectory.isDirectory() || binDirectory.isSymbolicLink()) {
    throw new Error(`Refusing to prepare E2E CLI stubs in a non-directory: ${E2E_BIN_DIR}`);
  }

  await writeExecutableStub(E2E_CODEX_STUB, CODEX_STUB_SOURCE);
  await writeExecutableStub(E2E_CLAUDE_STUB, CLAUDE_STUB_SOURCE);
  await writeExecutableStub(E2E_CODEX_ERROR_STUB, CODEX_ERROR_STUB_SOURCE);
}
