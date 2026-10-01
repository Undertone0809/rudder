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
import path from "node:path";
import readline from "node:readline";

const threadId = process.env.RUDDER_TEST_THREAD_ID || "thread-app-1";
const turnId = "turn-app-1";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "app-server" && process.argv[3] === "generate-json-schema") {
  const outputIndex = process.argv.indexOf("--out");
  const outputDirectory = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (!outputDirectory) process.exit(2);
  const supportsDeveloperInstructions = process.env.RUDDER_TEST_SCHEMA_SUPPORTS_DEVELOPER_INSTRUCTIONS !== "0";
  const properties = supportsDeveloperInstructions
    ? { developerInstructions: { type: ["string", "null"] } }
    : {};
  fs.mkdirSync(path.join(outputDirectory, "v2"), { recursive: true });
  for (const name of ["ThreadStartParams", "ThreadResumeParams"]) {
    fs.writeFileSync(
      path.join(outputDirectory, "v2", name + ".json"),
      JSON.stringify({ properties }),
      "utf8",
    );
  }
  process.exit(0);
}
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
  const completedTurn = {
    id: turnId,
    items: [],
    itemsView: { type: "full" },
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  };
  if (process.env.RUDDER_TEST_TURN_STATUS_MISSING !== "1") {
    completedTurn.status = process.env.RUDDER_TEST_TURN_STATUS || status;
  }
  send({ method: "turn/completed", params: { threadId, turn: completedTurn } });
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
if (process.env.RUDDER_TEST_ARGV_CAPTURE_PATH) {
  fs.writeFileSync(process.env.RUDDER_TEST_ARGV_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)), "utf8");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === "user-input-request-1") {
    if (process.env.RUDDER_TEST_SERVER_RESPONSE_CAPTURE_PATH) {
      fs.writeFileSync(process.env.RUDDER_TEST_SERVER_RESPONSE_CAPTURE_PATH, JSON.stringify(message), "utf8");
    }
    finish("completed");
    return;
  }
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
  if (process.env.RUDDER_TEST_EXIT_AFTER_REQUEST === message.method) process.exit(0);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    if (
      process.env.RUDDER_TEST_REJECT_DEVELOPER_INSTRUCTIONS === "1"
      && Object.hasOwn(message.params || {}, "developerInstructions")
    ) {
      send({ id: message.id, error: {
        code: -32602,
        message: "Invalid params: unknown field \`developerInstructions\`",
      } });
      return;
    }
    if (message.method === "thread/resume" && process.env.RUDDER_TEST_RESUME_MISSING_ROLLOUT === "1") {
      send({ id: message.id, error: { code: -32000, message: "thread/resume failed: no rollout found for thread id missing-thread" } });
      return;
    }
    send({ id: message.id, result: {
      thread: {
        id: threadId,
        sessionId: "root-session-app-1",
        forkedFromId: null,
        model: "gpt-test",
        modelProvider: "openai",
        ephemeral: false,
      },
    } });
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
    if (process.env.RUDDER_TEST_TURN_START_NO_ID === "1") {
      send({ id: message.id, result: { turn: {} } });
      return;
    }
    if (process.env.RUDDER_TEST_TURN_START_BLANK_ID === "1") {
      send({ id: message.id, result: { turn: { id: " \t " } } });
      return;
    }
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    if (process.env.RUDDER_TEST_STALL_TURN === "1") return;
    if (process.env.RUDDER_TEST_USER_INPUT_REQUEST === "1") {
      send({
        id: "user-input-request-1",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "question-item-1",
          questions: [{
            id: "provider-question-1",
            header: "Choice",
            question: "Which option?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Alpha", description: "First" },
              { label: "Beta", description: "Second" },
            ],
          }],
          isBlocking: true,
          autoResolutionMs: null,
        },
      });
      return;
    }
    if (process.env.RUDDER_TEST_AUTH_FAILURE === "1") {
      send({ method: "error", params: {
        threadId,
        turnId,
        willRetry: true,
        error: {
          message: 'unexpected status 401 Unauthorized: {"code":"API_KEY_REQUIRED","message":"API key is required"}',
        },
      } });
      return;
    }
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
    if (process.env.RUDDER_TEST_FILE_CHANGE_PATCH === "1") {
      const changes = [
        { path: "/workspace/src/first.ts", kind: { type: "update", move_path: null } },
        { path: "/workspace/src/second.ts", kind: { type: "update", move_path: null } },
      ];
      send({ method: "item/started", params: {
        threadId,
        turnId,
        item: { type: "fileChange", id: "file-change-1", status: "inProgress", changes },
      } });
      send({ method: "item/fileChange/patchUpdated", params: {
        threadId,
        turnId,
        itemId: "file-change-1",
        changes: [
          {
            path: "/workspace/src/second.ts",
            kind: { type: "update", move_path: null },
            diff: "@@ -2 +2 @@\\n-beforeSecond\\n+afterSecond",
          },
          {
            path: "/workspace/src/first.ts",
            kind: { type: "update", move_path: null },
            diff: "@@ -1 +1 @@\\n-beforeFirst\\n+afterFirst",
          },
        ],
      } });
      send({ method: "item/completed", params: {
        threadId,
        turnId,
        item: { type: "fileChange", id: "file-change-1", status: "completed", changes },
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
    if (process.env.RUDDER_TEST_UNCONFIRMED_INTERRUPT === "1") return;
    send({ id: message.id, result: {} });
    if (process.env.RUDDER_TEST_STALL_TURN !== "1") finish("interrupted");
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
  it("stops an App Server turn when its first provider auth error says it will retry", async () => {
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_AUTH_FAILURE: "1",
      } as Record<string, string>,
      prompt: "Inspect the timeline",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      errorMessage: expect.stringContaining("401 Unauthorized"),
    });
    expect(result.stdout).toContain('"type":"error"');
    expect(result.stdout).not.toContain('"type":"turn.completed"');
  });

  it.each([
    ["failed", { RUDDER_TEST_TURN_STATUS: "failed" }, "failed", "accepted"],
    ["missing", { RUDDER_TEST_TURN_STATUS_MISSING: "1" }, "unknown", "accepted"],
    ["unrecognized", { RUDDER_TEST_TURN_STATUS: "cancelled" }, "cancelled", "accepted"],
  ] as const)("fails closed when Codex reports a %s terminal Turn status", async (_kind, statusEnv, status, submissionPhase) => {
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
        ...statusEnv,
      } as Record<string, string>,
      prompt: "Inspect the timeline",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      errorMessage: `Codex turn ${status}`,
      submissionPhase,
    });
    expect(result.stdout).toContain('"type":"turn.failed"');
    expect(result.stdout).not.toContain('"type":"turn.completed"');
  });

  it("keeps turn/start acceptance indeterminate when its response has no turn id", async () => {
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_TURN_START_NO_ID: "1",
      } as Record<string, string>,
      prompt: "Inspect the timeline",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorMessage: "Codex App Server did not return a turn id",
      submissionPhase: "indeterminate",
      providerTurnId: null,
    });
  });

  it.each(["thread/start", "turn/start"] as const)(
    "keeps %s indeterminate when the request was received but the response was lost",
    async (method) => {
      const capturePath = path.join(root, "protocol.ndjson");
      const result = await executeCodexAppServerChat({
        command: fakeCodex,
        cwd: root,
        env: {
          ...process.env,
          PATH: process.env.PATH ?? "",
          RUDDER_TEST_PROTOCOL_CAPTURE_PATH: capturePath,
          RUDDER_TEST_EXIT_AFTER_REQUEST: method,
        } as Record<string, string>,
        prompt: "Inspect the timeline",
        model: "gpt-test",
        modelReasoningEffort: "high",
        search: false,
        bypassApprovalsAndSandbox: true,
        imagePaths: [],
        sessionId: null,
        timeoutSec: 5,
        onLog: vi.fn(async () => undefined),
      });

      const requests = await readProtocolRequests(capturePath);
      expect(requests.map((request) => request.method)).toEqual(
        method === "thread/start" ? ["thread/start"] : ["thread/start", "turn/start"],
      );
      expect(result).toMatchObject({
        exitCode: 1,
        submissionPhase: "indeterminate",
        providerTurnId: null,
      });
    },
  );

  it("keeps a thread/start acknowledgement pre-submission until turn/start dispatch", async () => {
    const capturePath = path.join(root, "protocol.ndjson");
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_PROTOCOL_CAPTURE_PATH: capturePath,
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
        if (stream === "stdout" && chunk.includes('"type":"thread.started"')) {
          throw new Error("local transcript writer failed before turn/start");
        }
      }),
    });

    const requests = await readProtocolRequests(capturePath);
    expect(requests.map((request) => request.method)).toEqual(["thread/start"]);
    expect(result).toMatchObject({
      exitCode: 1,
      submissionPhase: "pre_submission",
      providerTurnId: null,
    });
  });

  it("does not accept a whitespace-only turn id", async () => {
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_TURN_START_BLANK_ID: "1",
      } as Record<string, string>,
      prompt: "Inspect the timeline",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: true,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorMessage: "Codex App Server did not return a turn id",
      submissionPhase: "indeterminate",
      providerTurnId: null,
    });
  });

  it("propagates a read-only sandbox to new and resumed threads and their turns", async () => {
    const capturePath = path.join(root, "protocol.ndjson");
    const argvCapturePath = path.join(root, "argv.json");
    const executeWithSession = (sessionId: string | null) => executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
        RUDDER_TEST_PROTOCOL_CAPTURE_PATH: capturePath,
        RUDDER_TEST_ARGV_CAPTURE_PATH: argvCapturePath,
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

    await expect(executeWithSession(null)).resolves.toMatchObject({
      exitCode: 0,
      resumed: false,
      sessionParams: {
        sessionId: "thread-app-1",
        threadId: "thread-app-1",
        rootSessionId: "root-session-app-1",
        modelProvider: "openai",
      },
    });
    await expect(executeWithSession("thread-app-1")).resolves.toMatchObject({
      exitCode: 0,
      resumed: true,
      sessionParams: { rootSessionId: "root-session-app-1" },
    });

    const requests = await readProtocolRequests(capturePath);
    expect(JSON.parse(await fs.readFile(argvCapturePath, "utf8"))).toEqual(["app-server", "--stdio"]);
    expect(requests).toEqual([
      expect.objectContaining({
        method: "thread/start",
        params: expect.objectContaining({
          sandbox: "read-only",
          config: { web_search: "disabled" },
        }),
      }),
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({ sandboxPolicy: { type: "readOnly" } }),
      }),
      expect.objectContaining({
        method: "thread/resume",
        params: expect.objectContaining({
          sandbox: "read-only",
          config: { web_search: "disabled" },
        }),
      }),
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({ sandboxPolicy: { type: "readOnly" } }),
      }),
    ]);
    expect(requests.filter((request) => request.method === "turn/start").map((request) => (
      (request.params as Record<string, unknown>).input
    ))).toEqual([
      [{ type: "text", text: "Inspect and plan", text_elements: [] }],
      [{ type: "text", text: "Inspect and plan", text_elements: [] }],
    ]);
  });

  it("sends stable instructions through thread settings and only new input through each turn", async () => {
    const capturePath = path.join(root, "native-chat-prompts.ndjson");
    const executeTurn = (input: {
      prompt: string;
      sessionId: string | null;
      instructions: string;
      revision: string;
      persistedRevision?: string | null;
      threadId?: string;
    }) => executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_PROTOCOL_CAPTURE_PATH: capturePath,
        RUDDER_TEST_PHASED_AGENT_MESSAGES: "1",
        ...(input.threadId ? { RUDDER_TEST_THREAD_ID: input.threadId } : {}),
      } as Record<string, string>,
      prompt: input.prompt,
      chatDeveloperInstructions: input.instructions,
      chatDeveloperInstructionsRevision: input.revision,
      persistedChatDeveloperInstructionsRevision: input.persistedRevision ?? null,
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: false,
      sandboxMode: null,
      imagePaths: [],
      sessionId: input.sessionId,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    await expect(executeTurn({
      prompt: "First turn input only",
      sessionId: null,
      instructions: "Stable Rudder instructions for source A",
      revision: "revision-a",
    })).resolves.toMatchObject({
      exitCode: 0,
      errorMessage: null,
      resumed: false,
      chatDeveloperInstructionsRevision: "revision-a",
    });
    await expect(executeTurn({
      prompt: "Second turn input only",
      sessionId: "thread-app-1",
      instructions: "Stable Rudder instructions for source A",
      revision: "revision-a",
      persistedRevision: "revision-a",
    })).resolves.toMatchObject({
      exitCode: 0,
      errorMessage: null,
      resumed: true,
      chatDeveloperInstructionsRevision: "revision-a",
    });
    await expect(executeTurn({
      prompt: "Recovered turn input only",
      sessionId: "thread-app-1",
      instructions: "Stable Rudder instructions for source A",
      revision: "revision-a",
    })).resolves.toMatchObject({
      exitCode: 0,
      errorMessage: null,
      resumed: true,
      chatDeveloperInstructionsRevision: "revision-a",
    });
    await expect(executeTurn({
      prompt: "New source input only",
      sessionId: null,
      instructions: "Stable Rudder instructions for source B",
      revision: "revision-b",
      threadId: "thread-app-2",
    })).resolves.toMatchObject({
      exitCode: 0,
      errorMessage: null,
      resumed: false,
      sessionId: "thread-app-2",
      chatDeveloperInstructionsRevision: "revision-b",
    });

    const requests = await readProtocolRequests(capturePath);
    const threadRequests = requests.filter((request) =>
      request.method === "thread/start" || request.method === "thread/resume",
    );
    const turnRequests = requests.filter((request) => request.method === "turn/start");
    expect(threadRequests.map((request) => request.method)).toEqual([
      "thread/start",
      "thread/resume",
      "thread/resume",
      "thread/start",
    ]);
    expect(threadRequests[0]?.params).toMatchObject({
      developerInstructions: "Stable Rudder instructions for source A",
    });
    expect(threadRequests[1]?.params).not.toHaveProperty("developerInstructions");
    expect(threadRequests[2]?.params).toMatchObject({
      developerInstructions: "Stable Rudder instructions for source A",
    });
    expect(threadRequests[3]?.params).toMatchObject({
      developerInstructions: "Stable Rudder instructions for source B",
    });
    expect(threadRequests[3]?.params).not.toHaveProperty("threadId");
    expect(turnRequests.map((request) => (request.params as Record<string, unknown>).input)).toEqual([
      [{ type: "text", text: "First turn input only", text_elements: [] }],
      [{ type: "text", text: "Second turn input only", text_elements: [] }],
      [{ type: "text", text: "Recovered turn input only", text_elements: [] }],
      [{ type: "text", text: "New source input only", text_elements: [] }],
    ]);
    expect(turnRequests.every((request) => (
      !Object.hasOwn(request.params as Record<string, unknown>, "developerInstructions")
    ))).toBe(true);
  });

  it("falls back to stable turn instructions when the installed schema lacks thread developerInstructions", async () => {
    const capturePath = path.join(root, "legacy-native-chat-prompts.ndjson");
    const executeTurn = (sessionId: string | null, persistedRevision?: string | null) => executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_SCHEMA_SUPPORTS_DEVELOPER_INSTRUCTIONS: "0",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
        RUDDER_TEST_PROTOCOL_CAPTURE_PATH: capturePath,
      } as Record<string, string>,
      prompt: sessionId ? "Recovered new input only" : "First new input only",
      chatDeveloperInstructions: "Stable Rudder instructions for a legacy thread",
      chatDeveloperInstructionsRevision: "legacy-revision",
      persistedChatDeveloperInstructionsRevision: persistedRevision ?? null,
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: false,
      sandboxMode: null,
      imagePaths: [],
      sessionId,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    await expect(executeTurn(null)).resolves.toMatchObject({
      exitCode: 0,
      chatDeveloperInstructionsRevision: null,
    });
    await expect(executeTurn("thread-app-1", "legacy-revision")).resolves.toMatchObject({
      exitCode: 0,
      resumed: true,
      chatDeveloperInstructionsRevision: null,
    });

    const requests = await readProtocolRequests(capturePath);
    const threadRequests = requests.filter((request) =>
      request.method === "thread/start" || request.method === "thread/resume",
    );
    const turnRequests = requests.filter((request) => request.method === "turn/start");
    expect(threadRequests.map((request) => request.method)).toEqual(["thread/start", "thread/resume"]);
    expect(threadRequests.every((request) => (
      !Object.hasOwn(request.params as Record<string, unknown>, "developerInstructions")
    ))).toBe(true);
    expect(turnRequests.map((request) => (request.params as Record<string, unknown>).input)).toEqual([
      [{
        type: "text",
        text: "Stable Rudder instructions for a legacy thread\n\nFirst new input only",
        text_elements: [],
      }],
      [{
        type: "text",
        text: "Stable Rudder instructions for a legacy thread\n\nRecovered new input only",
        text_elements: [],
      }],
    ]);
  });

  it("retries an explicitly rejected resume field with instructions in turn input", async () => {
    const capturePath = path.join(root, "rejected-native-chat-prompts.ndjson");
    const onLog = vi.fn(async () => undefined);
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_REJECT_DEVELOPER_INSTRUCTIONS: "1",
        RUDDER_TEST_COMMAND_TRANSCRIPT: "1",
        RUDDER_TEST_PROTOCOL_CAPTURE_PATH: capturePath,
      } as Record<string, string>,
      prompt: "Resume with new input only",
      chatDeveloperInstructions: "Stable Rudder instructions for rejected resume",
      chatDeveloperInstructionsRevision: "resume-revision",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: false,
      sandboxMode: null,
      imagePaths: [],
      sessionId: "thread-app-1",
      timeoutSec: 5,
      onLog,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      resumed: true,
      chatDeveloperInstructionsRevision: null,
    });
    const requests = await readProtocolRequests(capturePath);
    const threadRequests = requests.filter((request) => request.method === "thread/resume");
    const turnRequest = requests.find((request) => request.method === "turn/start");
    expect(threadRequests).toHaveLength(2);
    expect(threadRequests[0]?.params).toMatchObject({
      developerInstructions: "Stable Rudder instructions for rejected resume",
    });
    expect(threadRequests[1]?.params).not.toHaveProperty("developerInstructions");
    expect(turnRequest?.params).toMatchObject({
      input: [{
        type: "text",
        text: "Stable Rudder instructions for rejected resume\n\nResume with new input only",
        text_elements: [],
      }],
    });
    expect(onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("stable chat instructions are included in turn input"),
    );
  });

  it("does not silently start a new thread when resume reports a missing rollout", async () => {
    const capturePath = path.join(root, "missing-rollout.ndjson");
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_RESUME_MISSING_ROLLOUT: "1",
        RUDDER_TEST_PROTOCOL_CAPTURE_PATH: capturePath,
      } as Record<string, string>,
      prompt: "Continue the existing conversation",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: false,
      sandboxMode: null,
      imagePaths: [],
      sessionId: "missing-thread",
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorMessage: expect.stringContaining("no rollout found"),
      sessionId: "missing-thread",
      resumed: false,
      clearSession: false,
    });
    expect(await readProtocolRequests(capturePath)).toEqual([
      expect.objectContaining({ method: "thread/resume" }),
    ]);
  });

  it("round-trips native user input over the App Server client", async () => {
    const responsePath = path.join(root, "user-input-response.json");
    const requestApproval = vi.fn(async () => ({ id: "rudder-approval-1", status: "pending" as const }));
    const waitForApproval = vi.fn(async () => ({
      id: "rudder-approval-1",
      status: "approved" as const,
      inputResponse: {
        answers: [{ questionId: "codex_q1", optionIds: ["codex_q1_o2"] }],
      },
    }));
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_USER_INPUT_REQUEST: "1",
        RUDDER_TEST_SERVER_RESPONSE_CAPTURE_PATH: responsePath,
      } as Record<string, string>,
      prompt: "Choose an option",
      model: "gpt-test",
      modelReasoningEffort: "high",
      search: false,
      bypassApprovalsAndSandbox: false,
      sandboxMode: null,
      imagePaths: [],
      sessionId: null,
      timeoutSec: 5,
      onLog: vi.fn(async () => undefined),
      requestApproval,
      waitForApproval,
    });

    expect(result).toMatchObject({ exitCode: 0, sessionId: "thread-app-1", providerTurnId: "turn-app-1" });
    expect(result.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_terminal" });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      inputRequest: expect.objectContaining({ questions: [expect.objectContaining({ id: "codex_q1" })] }),
      payload: expect.objectContaining({ sessionId: "thread-app-1", turnId: "turn-app-1" }),
    }));
    expect(JSON.parse(await fs.readFile(responsePath, "utf8"))).toEqual({
      id: "user-input-request-1",
      result: { answers: { "provider-question-1": { answers: ["Beta"] } } },
    });
    expect(waitForApproval).toHaveBeenCalledWith("rudder-approval-1", 30 * 60_000);
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

  it("attaches item-scoped patch updates to completed file-change evidence by path", async () => {
    const stdoutLines: string[] = [];
    const result = await executeCodexAppServerChat({
      command: fakeCodex,
      cwd: root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        RUDDER_TEST_FILE_CHANGE_PATCH: "1",
      } as Record<string, string>,
      prompt: "Edit two files",
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
    const entries = stdoutLines.flatMap((line) => (
      parseCodexStdoutLine(line, "2026-09-02T00:00:00.000Z")
    ));
    expect(entries).toContainEqual({
      kind: "tool_call",
      ts: "2026-09-02T00:00:00.000Z",
      name: "file_change",
      toolUseId: "file-change-1",
      input: {
        id: "file-change-1",
        status: "inProgress",
        changes: [
          { path: "/workspace/src/first.ts", kind: { type: "update", move_path: null } },
          { path: "/workspace/src/second.ts", kind: { type: "update", move_path: null } },
        ],
      },
    });
    const completed = entries.find((entry) => entry.kind === "tool_result" && entry.toolUseId === "file-change-1");
    expect(completed).toMatchObject({ kind: "tool_result", toolName: "file_change", isError: false });
    if (completed?.kind !== "tool_result") throw new Error("expected completed file-change evidence");
    expect(JSON.parse(completed.content)).toEqual({
      id: "file-change-1",
      status: "completed",
      changes: [
        {
          path: "/workspace/src/first.ts",
          kind: { type: "update", move_path: null },
          diff: "@@ -1 +1 @@\n-beforeFirst\n+afterFirst",
        },
        {
          path: "/workspace/src/second.ts",
          kind: { type: "update", move_path: null },
          diff: "@@ -2 +2 @@\n-beforeSecond\n+afterSecond",
        },
      ],
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
    expect(result.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_terminal" });
    expect(result.stdout).not.toContain('"text":"Steered reply"');
    expect(result.summary).toBe("");
  });

  it("requires process-tree exit to confirm Stop even when App Server acknowledges the interrupt", async () => {
    const run = async (unconfirmedInterrupt: boolean) => {
      const controller = new AbortController();
      let handle: AgentRuntimeControlHandle | null = null;
      let childPid: number | null = null;
      const execution = executeCodexAppServerChat({
        command: fakeCodex,
        cwd: root,
        env: {
          ...process.env,
          PATH: process.env.PATH ?? "",
          RUDDER_TEST_STALL_TURN: "1",
          RUDDER_TEST_IGNORE_SIGTERM: "1",
          ...(unconfirmedInterrupt ? { RUDDER_TEST_UNCONFIRMED_INTERRUPT: "1" } : {}),
        } as Record<string, string>,
        prompt: "Long request",
        model: "gpt-test",
        modelReasoningEffort: "high",
        search: false,
        bypassApprovalsAndSandbox: true,
        imagePaths: [],
        sessionId: null,
        timeoutSec: 1,
        abortSignal: controller.signal,
        onLog: vi.fn(async () => undefined),
        onSpawn: async ({ pid }) => {
          childPid = pid;
        },
        controlAttempt: {
          attemptEpoch: 1,
          ownerToken: "owner-1",
          register: vi.fn(async (published) => {
            handle = published;
            return { isCurrent: () => true, release: vi.fn(async () => undefined) };
          }),
          complete: vi.fn(async () => undefined),
        },
      });
      const activeHandle = await waitFor(() => handle?.providerTurnId ? handle : null);
      if (!unconfirmedInterrupt) {
        await expect(activeHandle.interrupt("operator_stop")).resolves.toBe("acknowledged");
        expect(childPid).not.toBeNull();
        expect(() => process.kill(childPid!, 0)).not.toThrow();
      }
      controller.abort();
      return { result: await execution, childPid };
    };

    const acknowledged = await run(false);
    expect(acknowledged.result).toMatchObject({
      timedOut: true,
      nativeWriterQuiescence: process.platform === "win32"
        ? { status: "unconfirmed" }
        : { status: "confirmed", source: "process_exit" },
    });
    expect(acknowledged.childPid).not.toBeNull();
    expect(() => process.kill(acknowledged.childPid!, 0)).toThrow();
    if (process.platform !== "win32") {
      expect(() => process.kill(-acknowledged.childPid!, 0)).toThrow();
    }

    const unacknowledged = await run(true);
    expect(unacknowledged.result).toMatchObject({
      timedOut: true,
      nativeWriterQuiescence: process.platform === "win32"
        ? { status: "unconfirmed" }
        : { status: "confirmed", source: "process_exit" },
    });
  }, 10_000);

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
    if (process.platform !== "win32") {
      expect(() => process.kill(-childPid!, 0)).toThrow();
    }
  }, 10_000);
});
