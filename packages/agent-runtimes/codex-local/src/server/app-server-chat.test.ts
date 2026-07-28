import type {
  AgentRuntimeControlHandle,
  AgentRuntimeControlHandleLease,
} from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCodexStdoutLine } from "../ui/parse-stdout.js";
import { executeCodexAppServerChat } from "./app-server-chat.js";

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

async function readProtocolRequests(capturePath: string): Promise<Array<Record<string, unknown>>> {
  const content = await fs.readFile(capturePath, "utf8");
  return content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-app-chat-"));
  fakeCodex = path.join(root, "fake-codex.mjs");
  await fs.writeFile(fakeCodex, `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const threadId = "thread-app-1";
const turnId = "turn-app-1";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const commandDirectory = process.env.RUDDER_TEST_COMMAND_WORKDIR
  ? { workdir: process.env.RUDDER_TEST_COMMAND_WORKDIR }
  : process.env.RUDDER_TEST_COMMAND_CWD
    ? { cwd: process.env.RUDDER_TEST_COMMAND_CWD }
    : {};
const startedCommandDirectory = process.env.RUDDER_TEST_COMMAND_STARTED_NO_DIRECTORY === "1"
  ? {}
  : commandDirectory;
const completedCommandDirectory = process.env.RUDDER_TEST_COMMAND_COMPLETED_NO_DIRECTORY === "1"
  ? {}
  : commandDirectory;
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

if (process.env.RUDDER_TEST_APP_SERVER_STDERR) {
  process.stderr.write("real stderr before\\n");
  process.stderr.write("  in-process app-server event stream lag");
  process.stderr.write("ged; dropped 42 events\\n");
  process.stderr.write("real stderr after\\n");
}
if (process.env.RUDDER_TEST_APP_SERVER_TRAILING_STDERR) {
  process.stderr.write("trailing real stderr");
  process.stderr.write("\\n in-process app-server event stream lagged; dropped 7 events");
}
if (process.env.RUDDER_TEST_APP_SERVER_MIXED_STDERR) {
  process.stderr.write("auth failed: in-process app-server event stream lagged; dropped 9 events\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (
    process.env.RUDDER_TEST_PROTOCOL_CAPTURE_PATH
    && ["thread/start", "thread/resume", "turn/start"].includes(message.method)
  ) {
    fs.appendFileSync(
      process.env.RUDDER_TEST_PROTOCOL_CAPTURE_PATH,
      JSON.stringify(message) + "\\n",
      "utf8",
    );
  }
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (message.method === "thread/read") {
    send({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          turns: [{
            id: "turn-child-1",
            status: "completed",
            items: [
              {
                type: "userMessage",
                id: "child-user-1",
                content: [{ type: "text", text: "Review the transcript renderer for collaboration events." }],
              },
              {
                type: "reasoning",
                id: "child-reasoning-1",
                summary: ["I’ll inspect the collaboration rendering path."],
                content: [],
              },
              {
                type: "agentMessage",
                id: "child-agent-1",
                text: "Review passed.",
              },
            ],
          }],
        },
      },
    });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    if (process.env.RUDDER_TEST_USER_MESSAGE_TRANSCRIPT === "1") {
      const item = {
        type: "userMessage",
        id: "user-message-1",
        content: [{ type: "text", text: "Initial request" }],
      };
      send({ method: "item/started", params: { threadId, turnId, item } });
      send({ method: "item/completed", params: { threadId, turnId, item } });
    }
    if (process.env.RUDDER_TEST_COMMAND_TRANSCRIPT === "1") {
      send({ method: "item/started", params: {
        threadId,
        turnId,
        item: {
          type: "commandExecution",
          id: "command-1",
          command: "cat README.md",
          status: "inProgress",
          ...startedCommandDirectory,
        },
      } });
      send({ method: "item/completed", params: {
        threadId,
        turnId,
        item: {
          type: "commandExecution",
          id: "command-1",
          command: "cat README.md",
          status: "completed",
          aggregatedOutput: "Rudder",
          exitCode: 0,
          ...completedCommandDirectory,
        },
      } });
      finish("completed");
    }
    if (process.env.RUDDER_TEST_COLLAB_AGENT_TRANSCRIPT === "1") {
      const startedItem = {
        type: "collabAgentToolCall",
        id: "collab-1",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: threadId,
        receiverThreadIds: [],
        prompt: "Review the transcript renderer for collaboration events.",
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      };
      send({ method: "item/started", params: { threadId, turnId, item: startedItem } });
      send({ method: "item/completed", params: {
        threadId,
        turnId,
        item: {
          ...startedItem,
          status: "completed",
          receiverThreadIds: ["thread-child-1"],
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          agentsStates: {
            "thread-child-1": { status: "completed", message: "Review passed." },
          },
        },
      } });
      finish("completed");
    }
    if (process.env.RUDDER_TEST_SUBAGENT_ACTIVITY_TRANSCRIPT === "1") {
      send({ method: "item/completed", params: {
        threadId,
        turnId,
        item: {
          type: "subAgentActivity",
          id: "subagent-activity-1",
          kind: "started",
          agentThreadId: "thread-child-1",
          agentPath: "/root/transcript_renderer_review",
        },
      } });
      finish("completed");
    }
    if (process.env.RUDDER_TEST_DUAL_REASONING_STREAM === "1") {
      for (const delta of ["I will use ", "visualize once."]) {
        send({ method: "item/reasoning/summaryTextDelta", params: {
          threadId, turnId, itemId: "reason-1", summaryIndex: 0, delta,
        } });
        send({ method: "item/reasoning/textDelta", params: {
          threadId, turnId, itemId: "reason-1", contentIndex: 0, delta,
        } });
      }
      send({ method: "item/completed", params: {
        threadId,
        turnId,
        item: { type: "reasoning", id: "reason-1", summary: ["I will use visualize once."], content: [] },
      } });
      finish("completed");
    }
    if (process.env.RUDDER_TEST_RAW_REASONING_STREAM === "1") {
      for (const delta of ["Raw-only ", "reasoning."]) {
        send({ method: "item/reasoning/textDelta", params: {
          threadId, turnId, itemId: "reason-raw", contentIndex: 0, delta,
        } });
      }
      finish("interrupted");
    }
    if (process.env.RUDDER_TEST_MULTIPART_REASONING_STREAM === "1") {
      send({ method: "item/reasoning/summaryPartAdded", params: {
        threadId, turnId, itemId: "reason-multipart", summaryIndex: 0,
      } });
      send({ method: "item/reasoning/summaryTextDelta", params: {
        threadId, turnId, itemId: "reason-multipart", summaryIndex: 0, delta: "Inspect the state.",
      } });
      send({ method: "item/reasoning/summaryPartAdded", params: {
        threadId, turnId, itemId: "reason-multipart", summaryIndex: 1,
      } });
      send({ method: "item/reasoning/summaryTextDelta", params: {
        threadId, turnId, itemId: "reason-multipart", summaryIndex: 1, delta: "Apply the fix.",
      } });
      send({ method: "item/completed", params: {
        threadId,
        turnId,
        item: { type: "reasoning", id: "reason-multipart", summary: ["Inspect the state.", "Apply the fix."], content: [] },
      } });
      finish("completed");
    }
    if (process.env.RUDDER_TEST_PHASED_AGENT_MESSAGES === "1") {
      const commentaryItem = {
        type: "agentMessage",
        id: "commentary-1",
        text: "",
        phase: "commentary",
        memoryCitation: null,
      };
      send({ method: "item/started", params: { threadId, turnId, item: commentaryItem } });
      send({ method: "item/agentMessage/delta", params: {
        threadId, turnId, itemId: commentaryItem.id, delta: "我会先读取 \`rudder",
      } });
      send({ method: "item/agentMessage/delta", params: {
        threadId, turnId, itemId: commentaryItem.id, delta: "-docs\`，再核对源码。",
      } });
      send({ method: "item/completed", params: {
        threadId,
        turnId,
        item: { ...commentaryItem, text: "我会先读取 \`rudder-docs\`，再核对源码。" },
      } });

      const finalItem = {
        type: "agentMessage",
        id: "final-1",
        text: "",
        phase: "final_answer",
        memoryCitation: null,
      };
      send({ method: "item/started", params: { threadId, turnId, item: finalItem } });
      send({ method: "item/agentMessage/delta", params: {
        threadId, turnId, itemId: finalItem.id, delta: "Done.",
      } });
      send({ method: "item/completed", params: {
        threadId,
        turnId,
        item: { ...finalItem, text: "Done." },
      } });
      send({ method: "turn/completed", params: {
        threadId,
        turn: {
          id: turnId,
          items: [],
          itemsView: { type: "full" },
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      } });
    }
    return;
  }
  if (message.method === "turn/steer") {
    if (process.env.RUDDER_TEST_STEER_CAPTURE_PATH) {
      fs.writeFileSync(process.env.RUDDER_TEST_STEER_CAPTURE_PATH, JSON.stringify(message));
    }
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
  it("propagates a read-only sandbox to new and resumed threads and their turns", async () => {
    const capturePath = path.join(root, "protocol.ndjson");
    const executeWithSession = (sessionId: string | null) => executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
        RUDDER_TEST_PROTOCOL_CAPTURE_PATH: capturePath,
      } as Record<string, string>,
      prompt: "Inspect and plan",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: false,
      sandboxMode: "read-only",
      imagePaths: [],
      sessionId,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    await expect(executeWithSession(null)).resolves.toMatchObject({ exitCode: 0, resumed: false });
    await expect(executeWithSession("thread-app-1")).resolves.toMatchObject({ exitCode: 0, resumed: true });

    const requests = await readProtocolRequests(capturePath);
    expect(requests).toEqual([
      expect.objectContaining({
        method: "thread/start",
        params: expect.objectContaining({ sandbox: "read-only" }),
      }),
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({ sandboxPolicy: { type: "readOnly" } }),
      }),
      expect.objectContaining({
        method: "thread/resume",
        params: expect.objectContaining({ sandbox: "read-only" }),
      }),
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({ sandboxPolicy: { type: "readOnly" } }),
      }),
    ]);
  });

  it("keeps danger-full-access precedence over a structured read-only sandbox", async () => {
    const capturePath = path.join(root, "protocol.ndjson");
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
        RUDDER_TEST_PROTOCOL_CAPTURE_PATH: capturePath,
      } as Record<string, string>,
      prompt: "Implement the approved change",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      sandboxMode: "read-only",
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    expect(result.exitCode).toBe(0);
    const requests = await readProtocolRequests(capturePath);
    expect(requests).toEqual([
      expect.objectContaining({
        method: "thread/start",
        params: expect.objectContaining({
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        }),
      }),
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        }),
      }),
    ]);
  });

  it("does not emit provider user-message lifecycle items", async () => {
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_USER_MESSAGE_TRANSCRIPT: "1",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
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
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('\"type\":\"userMessage\"');
    expect(result.stdout).toContain('\"type\":\"command_execution\"');
  });

  it("hides split app-server lag diagnostics while preserving adjacent stderr", async () => {
    const stderrLines: string[] = [];
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_APP_SERVER_STDERR: "1",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
      } as Record<string, string>,
      prompt: "Initial request",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (stream, chunk) => {
        if (stream === "stderr") stderrLines.push(chunk);
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(stderrLines.join("")).toContain("real stderr before");
    expect(stderrLines.join("")).toContain("real stderr after");
    expect(stderrLines.join("")).not.toContain("app-server event stream lagged");
    expect(result.stderr).toContain("app-server event stream lagged");
  });

  it("flushes trailing real stderr and suppresses an unterminated lag diagnostic", async () => {
    const stderrLines: string[] = [];
    await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_APP_SERVER_TRAILING_STDERR: "1",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
      } as Record<string, string>,
      prompt: "Initial request",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (stream, chunk) => {
        if (stream === "stderr") stderrLines.push(chunk);
      }),
    });

    expect(stderrLines.join("")).toContain("trailing real stderr");
    expect(stderrLines.join("")).not.toContain("app-server event stream lagged");
  });

  it("keeps mixed stderr lines that merely contain the lag diagnostic", async () => {
    const stderrLines: string[] = [];
    await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_APP_SERVER_MIXED_STDERR: "1",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
      } as Record<string, string>,
      prompt: "Initial request",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (stream, chunk) => {
        if (stream === "stderr") stderrLines.push(chunk);
      }),
    });

    expect(stderrLines.join("")).toContain("auth failed: in-process app-server event stream lagged; dropped 9 events");
  });

  it("falls back to the trusted runtime cwd when a command has no execution directory", async () => {
    const stdoutLines: string[] = [];
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
      } as Record<string, string>,
      prompt: "Read README.md",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (stream, chunk) => {
        if (stream === "stdout") stdoutLines.push(chunk.trim());
      }),
    });

    expect(result.exitCode).toBe(0);
    const entries = stdoutLines.flatMap((line) => parseCodexStdoutLine(line, "2026-07-21T00:00:00.000Z"));
    expect(entries).toContainEqual({
      kind: "tool_call",
      ts: "2026-07-21T00:00:00.000Z",
      name: "command_execution",
      toolUseId: "command-1",
      input: { id: "command-1", command: "cat README.md", cwd: root },
    });
  });

  it.each([
    ["workdir", "RUDDER_TEST_COMMAND_WORKDIR"],
    ["cwd", "RUDDER_TEST_COMMAND_CWD"],
  ] as const)("preserves an absolute per-command %s across started and completed events", async (
    _field,
    envKey,
  ) => {
    const commandCwd = path.join(root, "source-workspace");
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
        RUDDER_TEST_COMMAND_COMPLETED_NO_DIRECTORY: "1",
        [envKey]: commandCwd,
      } as Record<string, string>,
      prompt: "Read doc/README.md",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    expect(result.exitCode).toBe(0);
    const commandItems = result.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { item?: Record<string, unknown> })
      .flatMap((event) => event.item?.type === "command_execution" ? [event.item] : []);
    expect(commandItems).toHaveLength(2);
    expect(commandItems.map((item) => item.cwd)).toEqual([commandCwd, commandCwd]);
    expect(commandItems.every((item) => !("workdir" in item))).toBe(true);

    const entries = result.stdout
      .split(/\r?\n/u)
      .flatMap((line) => parseCodexStdoutLine(line, "2026-07-27T00:00:00.000Z"));
    expect(entries).toContainEqual({
      kind: "tool_call",
      ts: "2026-07-27T00:00:00.000Z",
      name: "command_execution",
      toolUseId: "command-1",
      input: { id: "command-1", command: "cat README.md", cwd: commandCwd },
    });
  });

  it("keeps the started fallback when a completed event reports late directory evidence", async () => {
    const commandCwd = path.join(root, "late-source-workspace");
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
        RUDDER_TEST_COMMAND_STARTED_NO_DIRECTORY: "1",
        RUDDER_TEST_COMMAND_WORKDIR: commandCwd,
      } as Record<string, string>,
      prompt: "Read README.md",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    expect(result.exitCode).toBe(0);
    const commandItems = result.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { item?: Record<string, unknown> })
      .flatMap((event) => event.item?.type === "command_execution" ? [event.item] : []);
    expect(commandItems.map((item) => item.cwd)).toEqual([root, root]);
  });

  it.each([
    ["relative", "nested/workspace"],
    ["dynamic-posix", "/tmp/$RUDDER_WORKSPACE"],
    ["dynamic-windows", "C:\\Users\\%USERNAME%\\workspace"],
  ])("does not trust an explicit %s command working directory", async (_label, commandWorkdir) => {
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
        RUDDER_TEST_COMMAND_WORKDIR: commandWorkdir,
      } as Record<string, string>,
      prompt: "Read README.md",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    expect(result.exitCode).toBe(0);
    const entries = result.stdout
      .split(/\r?\n/u)
      .flatMap((line) => parseCodexStdoutLine(line, "2026-07-27T00:00:00.000Z"));
    expect(entries).toContainEqual({
      kind: "tool_call",
      ts: "2026-07-27T00:00:00.000Z",
      name: "command_execution",
      toolUseId: "command-1",
      input: { id: "command-1", command: "cat README.md" },
    });
  });

  it("projects Codex collaboration agent calls as structured transcript tools", async () => {
    const stdoutLines: string[] = [];
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_COLLAB_AGENT_TRANSCRIPT: "1",
      } as Record<string, string>,
      prompt: "Delegate a transcript review",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (stream, chunk) => {
        if (stream === "stdout") stdoutLines.push(chunk.trim());
      }),
    });

    expect(result.exitCode).toBe(0);
    const entries = stdoutLines.flatMap((line) => parseCodexStdoutLine(line, "2026-07-23T00:00:00.000Z"));
    expect(entries).toContainEqual({
      kind: "tool_call",
      ts: "2026-07-23T00:00:00.000Z",
      name: "spawn_agent",
      toolUseId: "collab-1",
      input: {
        id: "collab-1",
        message: "Review the transcript renderer for collaboration events.",
        sender_thread_id: "thread-app-1",
        receiver_thread_ids: [],
        agents_states: {},
      },
    });
    expect(entries).toContainEqual({
      kind: "tool_result",
      ts: "2026-07-23T00:00:00.000Z",
      toolUseId: "collab-1",
      toolName: "spawn_agent",
      content: JSON.stringify({
        status: "completed",
        message: "Review the transcript renderer for collaboration events.",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        sender_thread_id: "thread-app-1",
        receiver_thread_ids: ["thread-child-1"],
      agents_states: {
        "thread-child-1": { status: "completed", message: "Review passed." },
      },
      agent_transcripts: {
        "thread-child-1": {
          status: "completed",
          entries: [
            {
              kind: "thinking",
              ts: "2026-07-23T00:00:00.000Z",
              text: "I’ll inspect the collaboration rendering path.",
              segmentId: "child-reasoning-1",
            },
            {
              kind: "assistant",
              ts: "2026-07-23T00:00:00.000Z",
              text: "Review passed.",
              segmentId: "child-agent-1",
            },
          ],
        },
      },
    }),
    isError: false,
  });

    const collabResult = entries.find((entry) => entry.kind === "tool_result");
    const collabPayload = collabResult?.kind === "tool_result"
      ? JSON.parse(collabResult.content) as Record<string, unknown>
      : null;
    expect(collabPayload).toMatchObject({
      agent_transcripts: {
        "thread-child-1": {
          status: "completed",
          entries: [
            {
              kind: "thinking",
              text: "I’ll inspect the collaboration rendering path.",
            },
            {
              kind: "assistant",
              text: "Review passed.",
            },
          ],
        },
      },
    });
    expect(entries).not.toContainEqual(expect.objectContaining({
      kind: "system",
      text: expect.stringContaining("Collab Agent Tool Call"),
    }));
  });

  it("projects Codex sub-agent activity as an inspectable transcript row", async () => {
    const stdoutLines: string[] = [];
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_SUBAGENT_ACTIVITY_TRANSCRIPT: "1",
      } as Record<string, string>,
      prompt: "Delegate a transcript review",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (_stream, chunk) => {
        stdoutLines.push(chunk.trim());
      }),
    });

    expect(result.exitCode).toBe(0);
    const entries = stdoutLines.flatMap((line) => (
      parseCodexStdoutLine(line, "2026-07-28T00:00:00.000Z")
    ));
    expect(entries).toContainEqual({
      kind: "tool_call",
      ts: "2026-07-28T00:00:00.000Z",
      name: "subagent_activity",
      toolUseId: "subagent-activity-1",
      input: expect.objectContaining({
        id: "subagent-activity-1",
        activity_kind: "started",
        agent_path: "/root/transcript_renderer_review",
        receiver_thread_ids: ["thread-child-1"],
        agent_transcripts: {
          "thread-child-1": {
            status: "completed",
            entries: expect.arrayContaining([
              expect.objectContaining({
                kind: "assistant",
                text: "Review passed.",
              }),
            ]),
          },
        },
      }),
    });
    expect(entries).not.toContainEqual(expect.objectContaining({
      kind: "system",
      text: expect.stringContaining("subAgentActivity"),
    }));
  });

  it("keeps legacy Codex collab_tool_call events on the collaboration UI path", () => {
    const entries = parseCodexStdoutLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "legacy-collab-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Review the compatibility path.",
        receiver_thread_ids: ["thread-legacy-1"],
        agents_states: {},
        status: "completed",
      },
    }), "2026-07-28T00:00:00.000Z");

    expect(entries).toContainEqual(expect.objectContaining({
      kind: "tool_result",
      toolUseId: "legacy-collab-1",
      toolName: "spawn_agent",
      content: expect.stringContaining('"receiver_thread_ids":["thread-legacy-1"]'),
    }));
    expect(entries).not.toContainEqual(expect.objectContaining({
      kind: "system",
      text: expect.stringContaining("collab_tool_call"),
    }));
  });

  it("does not leak dispose rejection when setup logging fails before awaiting the turn", async () => {
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: { ...process.env, PATH: process.env.PATH ?? "" } as Record<string, string>,
      prompt: "Initial request",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (_stream, chunk) => {
        if (chunk.includes('"type":"thread.started"')) {
          throw new Error("thread started log failed");
        }
      }),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorMessage: "thread started log failed",
    });
  });

  it("does not leak dispose rejection when control registration fails after turn start", async () => {
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: { ...process.env, PATH: process.env.PATH ?? "" } as Record<string, string>,
      prompt: "Initial request",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
      controlAttempt: {
        attemptEpoch: 1,
        ownerToken: "owner-1",
        register: vi.fn(async () => {
          throw new Error("control registration failed");
        }),
        complete: vi.fn(async () => undefined),
      },
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorMessage: "control registration failed",
    });
  });

  it("publishes a native same-turn Steer handle and returns per-turn usage", async () => {
    let handle: AgentRuntimeControlHandle | null = null;
    const stdoutLines: string[] = [];
    const steerCapturePath = path.join(root, "steer-request.json");
    const steerImagePath = path.join(root, "steer-image.png");
    await fs.writeFile(steerImagePath, "image");
    const handleLease: AgentRuntimeControlHandleLease = {
      isCurrent: () => true,
      release: vi.fn(async () => handle?.dispose()),
    };
    const execution = executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_STEER_CAPTURE_PATH: steerCapturePath,
      } as Record<string, string>,
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

    const steerFeedback = {
      text: "Change direction",
      clientMessageId: "client-control-1",
      media: [{
        source: "chat_attachment" as const,
        attachmentId: "attachment-1",
        assetId: "asset-1",
        name: "steer-image.png",
        originalFilename: "steer-image.png",
        contentType: "image/png",
        byteSize: 5,
        localPath: steerImagePath,
      }],
    };
    const steerResult = await activeHandle.steer(steerFeedback);
    const result = await execution;
    const steerRequest = JSON.parse(await fs.readFile(steerCapturePath, "utf8"));

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
    expect(steerRequest.params.input).toEqual([
      { type: "text", text: "Change direction", text_elements: [] },
      { type: "localImage", path: steerImagePath },
    ]);
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

  it("preserves App Server message phases and uses only the final answer as the result", async () => {
    const stdoutLines: string[] = [];
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_PHASED_AGENT_MESSAGES: "1",
      } as Record<string, string>,
      prompt: "Inspect the timeline",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (stream, chunk) => {
        if (stream === "stdout") stdoutLines.push(chunk.trim());
      }),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      summary: "Done.",
    });
    const assistantEntries = stdoutLines
      .filter((line) => line.includes('"type":"item.completed"'))
      .flatMap((line) => parseCodexStdoutLine(line, "2026-07-27T00:00:00.000Z"))
      .filter((entry) => entry.kind === "assistant");
    expect(assistantEntries).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "我会先读取 `rudder",
        delta: true,
        phase: "commentary",
        segmentId: "commentary-1",
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "-docs`，再核对源码。",
        delta: true,
        phase: "commentary",
        segmentId: "commentary-1",
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "Done.",
        delta: true,
        phase: "final_answer",
        segmentId: "final-1",
      }),
    ]);
  });

  it("projects one readable reasoning stream when Codex emits summary and raw deltas", async () => {
    const stdoutLines: string[] = [];
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_DUAL_REASONING_STREAM: "1",
      } as Record<string, string>,
      prompt: "Explain your next step",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (stream, chunk) => {
        if (stream === "stdout") stdoutLines.push(chunk.trim());
      }),
    });

    expect(result.exitCode).toBe(0);
    const thinkingEntries = stdoutLines
      .filter((line) => line.includes('"type":"item.completed"'))
      .flatMap((line) => parseCodexStdoutLine(line, "2026-07-16T00:00:00.000Z"))
      .filter((entry) => entry.kind === "thinking");

    expect(thinkingEntries).toEqual([
      expect.objectContaining({ kind: "thinking", text: "I will use ", delta: true }),
      expect.objectContaining({ kind: "thinking", text: "visualize once.", delta: true }),
    ]);
    expect(thinkingEntries.map((entry) => entry.text).join("")).toBe("I will use visualize once.");
  });

  it("keeps raw-only reasoning visible when no readable summary stream exists", async () => {
    const stdoutLines: string[] = [];
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_RAW_REASONING_STREAM: "1",
      } as Record<string, string>,
      prompt: "Explain with a raw-only model",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (stream, chunk) => {
        if (stream === "stdout") stdoutLines.push(chunk.trim());
      }),
    });

    expect(result.errorMessage).toBe("Codex turn interrupted");
    const thinkingText = stdoutLines
      .filter((line) => line.includes('"type":"item.completed"'))
      .flatMap((line) => parseCodexStdoutLine(line, "2026-07-16T00:00:00.000Z"))
      .filter((entry) => entry.kind === "thinking")
      .map((entry) => entry.text)
      .join("");
    expect(thinkingText).toBe("Raw-only reasoning.");
  });

  it("preserves readable boundaries between multiple reasoning summary parts", async () => {
    const stdoutLines: string[] = [];
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_MULTIPART_REASONING_STREAM: "1",
      } as Record<string, string>,
      prompt: "Explain two steps",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async (stream, chunk) => {
        if (stream === "stdout") stdoutLines.push(chunk.trim());
      }),
    });

    expect(result.exitCode).toBe(0);
    const thinkingText = stdoutLines
      .filter((line) => line.includes('"type":"item.completed"'))
      .flatMap((line) => parseCodexStdoutLine(line, "2026-07-16T00:00:00.000Z"))
      .filter((entry) => entry.kind === "thinking")
      .map((entry) => entry.text)
      .join("");
    expect(thinkingText).toBe("Inspect the state.\nApply the fix.");
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
