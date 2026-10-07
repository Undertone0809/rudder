import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  E2E_BIN_DIR,
  E2E_CLAUDE_STUB,
  E2E_CODEX_ERROR_STUB,
  E2E_CODEX_STUB,
  E2E_HOME,
  E2E_ROOT,
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

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function realPathAllowingMissingTail(filePath: string): Promise<string> {
  let current = path.resolve(filePath);
  const missingTail: string[] = [];

  while (true) {
    try {
      return path.resolve(await realpath(current), ...missingTail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingTail.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function assertNoSymlinkBelow(root: string, candidate: string): Promise<void> {
  const relative = path.relative(root, candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === "..") {
    throw new Error(`Refusing an E2E path outside its approved root: ${candidate}`);
  }

  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing a symbolic link in the E2E path: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertSafeE2EHome(): Promise<string> {
  const requestedHome = path.resolve(E2E_HOME);
  const allowedRoots = [path.join(E2E_ROOT, ".tmp"), os.tmpdir(), "/tmp", "/private/tmp"]
    .map((root) => path.resolve(root));
  const allowedRoot = allowedRoots.find((root) => isWithin(root, requestedHome));
  if (!allowedRoot) {
    throw new Error(`Refusing an E2E home outside approved temporary roots: ${requestedHome}`);
  }

  const trustedRootAliases = new Set([path.resolve(os.tmpdir()), path.resolve("/tmp")]);
  try {
    const rootEntry = await lstat(allowedRoot);
    if (rootEntry.isSymbolicLink() && !trustedRootAliases.has(allowedRoot)) {
      throw new Error(`Refusing a symbolic link for the approved E2E root: ${allowedRoot}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await assertNoSymlinkBelow(allowedRoot, requestedHome);
  try {
    const homeEntry = await lstat(requestedHome);
    if (homeEntry.isSymbolicLink() || !homeEntry.isDirectory()) {
      throw new Error(`Refusing a non-directory or symbolic-link E2E home: ${requestedHome}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const canonicalRoot = await realPathAllowingMissingTail(allowedRoot);
  const canonicalHome = await realPathAllowingMissingTail(requestedHome);
  if (!isWithin(canonicalRoot, canonicalHome)) {
    throw new Error(`Refusing an E2E home whose real path escapes its approved root: ${requestedHome}`);
  }
  return canonicalHome;
}

async function writeExecutableStub(filePath: string, source: string): Promise<void> {
  try {
    const existing = await lstat(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace a non-file E2E CLI stub: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow,
    0o755,
  );
  try {
    await handle.writeFile(source);
    await handle.chmod(0o755);
  } finally {
    await handle.close();
  }
}

export default async function existingServerSetup(): Promise<void> {
  const expectedHome = await assertSafeE2EHome();
  await assertNoSymlinkBelow(E2E_HOME, E2E_BIN_DIR);
  try {
    const existingBinDirectory = await lstat(E2E_BIN_DIR);
    if (!existingBinDirectory.isDirectory() || existingBinDirectory.isSymbolicLink()) {
      throw new Error(`Refusing to prepare E2E CLI stubs in a non-directory: ${E2E_BIN_DIR}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(E2E_BIN_DIR, { recursive: true });
  const canonicalHome = await assertSafeE2EHome();
  if (canonicalHome !== expectedHome) {
    throw new Error(`E2E home changed while preparing test stubs: ${E2E_HOME}`);
  }

  await assertNoSymlinkBelow(E2E_HOME, E2E_BIN_DIR);
  const binDirectory = await lstat(E2E_BIN_DIR);
  if (!binDirectory.isDirectory() || binDirectory.isSymbolicLink()) {
    throw new Error(`Refusing to prepare E2E CLI stubs in a non-directory: ${E2E_BIN_DIR}`);
  }
  const [realHome, realBinDirectory] = await Promise.all([
    realpath(E2E_HOME),
    realpath(E2E_BIN_DIR),
  ]);
  if (!isWithin(realHome, realBinDirectory)) {
    throw new Error(`Refusing an E2E CLI bin directory outside its home: ${E2E_BIN_DIR}`);
  }

  await writeExecutableStub(E2E_CODEX_STUB, CODEX_STUB_SOURCE);
  await writeExecutableStub(E2E_CLAUDE_STUB, CLAUDE_STUB_SOURCE);
  await writeExecutableStub(E2E_CODEX_ERROR_STUB, CODEX_ERROR_STUB_SOURCE);
}
