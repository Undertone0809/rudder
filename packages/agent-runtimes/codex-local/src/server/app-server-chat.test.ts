import type {
  AgentRuntimeControlHandle,
  AgentRuntimeControlHandleLease,
} from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCodexAppServerChat } from "./app-server-chat.js";
import { parseCodexStdoutLine } from "../ui/parse-stdout.js";

let root = "";
let fakeCodex = "";

async function waitFor<T>(read: () => T | null, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fake App Server state");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-app-chat-"));
  fakeCodex = path.join(root, "fake-codex.mjs");
  await fs.writeFile(fakeCodex, `#!/usr/bin/env node
import readline from "node:readline";

const threadId = "thread-app-1";
const turnId = "turn-app-1";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (status = "completed") => {
  send({ method: "thread/tokenUsage/updated", params: {
    threadId,
    turnId,
    tokenUsage: {
      total: { totalTokens: 9, inputTokens: 4, cachedInputTokens: 1, outputTokens: 5, reasoningOutputTokens: 0 },
      last: { totalTokens: 9, inputTokens: 4, cachedInputTokens: 1, outputTokens: 5, reasoningOutputTokens: 0 },
      modelContextWindow: 1000,
    },
  } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "agent-1", delta: "Steered " } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "agent-1", delta: "reply" } });
  send({ method: "item/completed", params: {
    threadId,
    turnId,
    completedAtMs: Date.now(),
    item: { type: "agentMessage", id: "agent-1", text: "Steered reply", phase: null, memoryCitation: null },
  } });
  send({ method: "turn/completed", params: {
    threadId,
    turn: { id: turnId, items: [], itemsView: { type: "full" }, status, error: null, startedAt: 1, completedAt: 2, durationMs: 1 },
  } });
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId } });
    finish("completed");
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    finish("interrupted");
  }
});
process.on("SIGTERM", () => {
  if (process.env.RUDDER_TEST_IGNORE_SIGTERM !== "1") process.exit(0);
});
`, "utf8");
  await fs.chmod(fakeCodex, 0o755);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("executeCodexAppServerChat", () => {
  it("publishes a native same-turn Steer handle and returns per-turn usage", async () => {
    let handle: AgentRuntimeControlHandle | null = null;
    const stdoutLines: string[] = [];
    const handleLease: AgentRuntimeControlHandleLease = {
      isCurrent: () => true,
      release: vi.fn(async () => handle?.dispose()),
    };
    const execution = executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: { ...process.env, PATH: process.env.PATH ?? "" } as Record<string, string>,
      prompt: "Initial request",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: true,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (stream, chunk) => {
        if (stream === "stdout") stdoutLines.push(chunk.trim());
      }),
      controlAttempt: {
        attemptEpoch: 1,
        ownerToken: "owner-1",
        register: vi.fn(async (published) => {
          handle = published;
          return handleLease;
        }),
        complete: vi.fn(async () => undefined),
      },
    });
    const activeHandle = await waitFor(() => handle);

    const steerResult = await activeHandle.steer({
      text: "Change direction",
      clientMessageId: "client-control-1",
    });
    const result = await execution;

    expect(steerResult).toEqual({
      disposition: "accepted_current",
      providerThreadId: "thread-app-1",
      providerTurnId: "turn-app-1",
    });
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      summary: "Steered reply",
      sessionId: "thread-app-1",
      providerTurnId: "turn-app-1",
      usage: { inputTokens: 4, cachedInputTokens: 1, outputTokens: 5 },
    });
    expect(result.stdout).toContain('"type":"turn.completed"');
    const assistantEntries = stdoutLines
      .filter((line) => line.includes('"type":"item.completed"'))
      .flatMap((line) => parseCodexStdoutLine(line, "2026-07-16T00:00:00.000Z"))
      .filter((entry) => entry.kind === "assistant");
    expect(assistantEntries).toEqual([
      expect.objectContaining({ kind: "assistant", text: "Steered ", delta: true }),
      expect.objectContaining({ kind: "assistant", text: "reply", delta: true }),
    ]);
    expect(stdoutLines.filter((line) => line.includes('"text":"Steered reply"'))).toEqual([]);
  });

  it("uses native interrupt before process termination when Stop aborts the turn", async () => {
    const controller = new AbortController();
    let handle: AgentRuntimeControlHandle | null = null;
    const execution = executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: { ...process.env, PATH: process.env.PATH ?? "" } as Record<string, string>,
      prompt: "Long request",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      abortSignal: controller.signal,
      onLog: vi.fn(async () => undefined),
      controlAttempt: {
        attemptEpoch: 1,
        ownerToken: "owner-1",
        register: vi.fn(async (published) => {
          handle = published;
          return {
            isCurrent: () => true,
            release: vi.fn(async () => published.dispose()),
          };
        }),
        complete: vi.fn(async () => undefined),
      },
    });
    await waitFor(() => handle);

    controller.abort();
    const result = await execution;

    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('"subtype":"interrupted"');
    expect(result.stdout).not.toContain('"text":"Steered reply"');
    expect(result.summary).toBe("");
  });

  it("force-kills an App Server process that ignores graceful shutdown", async () => {
    let handle: AgentRuntimeControlHandle | null = null;
    let childPid: number | null = null;
    const startedAt = Date.now();
    const execution = executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_IGNORE_SIGTERM: "1",
      } as Record<string, string>,
      prompt: "Initial request",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
      onSpawn: async ({ pid }) => {
        childPid = pid;
      },
      controlAttempt: {
        attemptEpoch: 1,
        ownerToken: "owner-1",
        register: vi.fn(async (published) => {
          handle = published;
          return {
            isCurrent: () => true,
            release: vi.fn(async () => undefined),
          };
        }),
        complete: vi.fn(async () => undefined),
      },
    });
    const activeHandle = await waitFor(() => handle);

    await activeHandle.steer({ text: "Finish", clientMessageId: "control-1" });
    const result = await execution;

    expect(result.exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_800);
    expect(childPid).not.toBeNull();
    expect(() => process.kill(childPid!, 0)).toThrow();
  }, 10_000);
});
