import type { AgentRuntimeControlHandle } from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPiLocalProviderCapabilityResolver,
  createPiRpcControlHandle,
  executePiNativeChat,
  forkPiNativeSession,
  readPiNativeTranscript,
  runtimeProviderCapabilities,
  sessionCodec,
} from "./index.js";

const tempDirectories: string[] = [];

async function makeFixtureDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

async function makePiFixture(directory: string, options: {
  cancelFork?: boolean;
  stateSequence?: Array<Record<string, unknown>>;
  extensionUi?: Array<Record<string, unknown>>;
  answerText?: string;
  splitUtf8Answer?: boolean;
  assistantUsages?: Array<Record<string, unknown>>;
  agentEndWillRetry?: boolean[];
  retryDelayMs?: number;
  appendParentDuringFork?: boolean;
  invalidFrameAfterUsage?: boolean;
  stallPrompt?: boolean;
  exitOnAbort?: boolean;
} = {}): Promise<string> {
  const command = path.join(directory, "pi-fixture.mjs");
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
fs.writeFileSync(path.join(process.cwd(), "argv.json"), JSON.stringify(args));
const requestLog = path.join(process.cwd(), "requests.jsonl");
const sessionIndex = args.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : "";
const childFile = path.join(path.dirname(sessionFile), "fork-child.jsonl");
const cancelFork = ${options.cancelFork ? "true" : "false"};
const fixtureOptions = ${JSON.stringify({
  stateSequence: options.stateSequence ?? [],
  extensionUi: options.extensionUi ?? [],
  answerText: options.answerText ?? "native pi answer",
  splitUtf8Answer: options.splitUtf8Answer === true,
  assistantUsages: options.assistantUsages ?? [],
  agentEndWillRetry: options.agentEndWillRetry ?? [false],
  retryDelayMs: options.retryDelayMs ?? 100,
  appendParentDuringFork: options.appendParentDuringFork === true,
  invalidFrameAfterUsage: options.invalidFrameAfterUsage === true,
  stallPrompt: options.stallPrompt === true,
  exitOnAbort: options.exitOnAbort === true,
})};
let forked = false;
let stateReadCount = 0;
const extensionUiWaiters = new Map();

function response(command, data = null) {
  process.stdout.write(JSON.stringify({ type: "response", command, success: true, data }) + "\\n");
}

function loadEntries() {
  return fs.readFileSync(sessionFile, "utf8")
    .split(/\\r?\\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function currentLeaf(entries) {
  const content = entries.filter((entry) => entry.type !== "session");
  const ids = new Set(content.map((entry) => entry.id));
  const childIds = new Set(content.map((entry) => entry.parentId).filter((id) => id && ids.has(id)));
  return [...content].reverse().find((entry) => !childIds.has(entry.id))?.id ?? null;
}

function branchFor(entries, leafId) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch = [];
  let current = byId.get(leafId);
  while (current) {
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch;
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(requestLog, JSON.stringify(request) + "\\n");
  if (request.type === "extension_ui_response") {
    extensionUiWaiters.get(request.id)?.(request);
    extensionUiWaiters.delete(request.id);
    return;
  }
  if (request.type === "get_state") {
    const sequence = fixtureOptions.stateSequence;
    const state = sequence[Math.min(stateReadCount++, sequence.length - 1)]
      ?? { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
    response("get_state", { sessionFile: forked ? childFile : sessionFile, sessionId: forked ? "pi-child" : "pi-parent", ...state });
    return;
  }
  if (request.type === "get_fork_messages") {
    response("get_fork_messages", { messages: [
      { entryId: "prev", text: "previous provider entry" },
      { entryId: "leaf", text: "current provider entry" },
      { entryId: "later", text: "later provider entry" }
    ] });
    return;
  }
  if (request.type === "fork" || request.type === "clone") {
    if (cancelFork) {
      response(request.type, { cancelled: true });
      return;
    }
    const entries = loadEntries();
    const targetId = request.type === "clone"
      ? currentLeaf(entries)
      : entries.find((entry) => entry.id === request.entryId)?.parentId;
    const branch = targetId ? branchFor(entries, targetId) : [];
    forked = true;
    fs.writeFileSync(childFile, [
      JSON.stringify({ type: "session", version: 3, id: "pi-child", timestamp: new Date(0).toISOString(), cwd: process.cwd() }),
      ...branch.map((entry) => JSON.stringify(entry)),
      "",
    ].join("\\n"));
    if (fixtureOptions.appendParentDuringFork) {
      const current = currentLeaf(entries);
      fs.appendFileSync(sessionFile, JSON.stringify({
        id: "concurrent-parent-entry", type: "message", parentId: current,
        timestamp: new Date(0).toISOString(), message: { role: "user", content: "parent continues" },
      }) + "\\n");
    }
    response(request.type, { cancelled: false });
    return;
  }
  if (request.type === "prompt") {
    process.stdout.write(JSON.stringify({ type: "provider_raw_jsonl", text: "pi-provider-stdout-secret" }) + "\\n");
    process.stderr.write("pi-provider-stderr-secret\\n");
    fs.writeFileSync(sessionFile,
      JSON.stringify({ type: "session", version: 3, id: "pi-parent", timestamp: new Date(0).toISOString(), cwd: process.cwd() }) + "\\n"
      + JSON.stringify({ id: "prev", type: "message", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "previous" } }) + "\\n"
      + JSON.stringify({ id: "leaf", type: "message", parentId: "prev", timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "current" }] } }) + "\\n"
      + JSON.stringify({ id: "new-leaf", type: "message", parentId: "leaf", timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "new" }] } }) + "\\n",
    );
    for (const event of fixtureOptions.extensionUi) {
      const reply = ["select", "confirm", "input", "editor"].includes(event.method)
        ? new Promise((resolve) => extensionUiWaiters.set(event.id, resolve))
        : null;
      process.stdout.write(JSON.stringify({ type: "extension_ui_request", ...event }) + "\\n");
      if (reply) await reply;
    }
    response("prompt", {});
    if (fixtureOptions.stallPrompt) return;
    const retryStates = fixtureOptions.agentEndWillRetry;
    for (let index = 0; index < retryStates.length; index += 1) {
      if (index > 0) process.stdout.write(JSON.stringify({ type: "auto_retry_start" }) + "\\n");
      const usage = fixtureOptions.assistantUsages[index];
      if (usage) process.stdout.write(JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [], usage },
      }) + "\\n");
      if (fixtureOptions.invalidFrameAfterUsage && index === 0) {
        process.stdout.write("not-json\\n");
        return;
      }
      if (index > 0) process.stdout.write(JSON.stringify({ type: "auto_retry_end", success: true }) + "\\n");
      const text = index === retryStates.length - 1 ? fixtureOptions.answerText : "retrying";
      const agentEnd = JSON.stringify({
        type: "agent_end",
        willRetry: retryStates[index],
        messages: [{ role: "assistant", content: [{ type: "text", text }] }],
      }) + "\\n";
      if (fixtureOptions.splitUtf8Answer && index === retryStates.length - 1) {
        const bytes = Buffer.from(agentEnd, "utf8");
        const marker = Buffer.from("😀", "utf8");
        const split = bytes.indexOf(marker) + 2;
        process.stdout.write(bytes.subarray(0, split));
        process.stdout.write(bytes.subarray(split));
      } else {
        process.stdout.write(agentEnd);
      }
      if (index < retryStates.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, fixtureOptions.retryDelayMs));
      }
    }
    return;
  }
  if (request.type === "steer" || request.type === "abort") {
    response(request.type, {});
    if (request.type === "abort" && fixtureOptions.exitOnAbort) {
      setTimeout(() => process.exit(0), 25);
    }
    return;
  }
  response(request.type, {});
});
`, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(command, 0o755);
  return command;
}

function sessionFor(directory: string, command: string, leafId = "leaf") {
  return {
    sessionId: path.join(directory, "session.jsonl"),
    sessionParams: {
      sessionId: path.join(directory, "session.jsonl"),
      sessionFile: path.join(directory, "session.jsonl"),
      sessionDir: directory,
      cwd: directory,
      command,
      rpcEnv: { HOME: directory },
      transport: "pi-rpc-stdio",
      hostId: "local",
      profileId: "pi-profile",
      previousLeafId: "prev",
      leafId,
      rpcArgs: ["--extension", "managed-extension"],
    },
    sessionDisplayId: "pi-parent",
  };
}

afterEach(async () => {
  while (tempDirectories.length > 0) {
    await fs.rm(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Pi native protocol contract", () => {
  it("does not attest a transcript when RPC startup fails", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-startup-fail-");
    const onNativeTransportProfile = vi.fn(async () => {});
    const result = await executePiNativeChat({
      command: path.join(directory, "missing-pi-command"), cwd: directory, env: { HOME: directory },
      sessionFile: path.join(directory, "session.jsonl"), sessionDir: directory,
      prompt: "must not submit", model: "provider/model", timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile" },
      rpcArgs: ["--extension", "managed-extension"], onNativeTransportProfile,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(onNativeTransportProfile).not.toHaveBeenCalled();
  });

  it("does not submit a prompt after the witnessed RPC attempt loses ownership", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-owner-loss-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    let current = true;
    const onNativeTransportProfile = vi.fn(async () => { current = false; });
    const result = await executePiNativeChat({
      command, cwd: directory, env: { HOME: directory }, sessionFile, sessionDir: directory,
      prompt: "must not submit", model: "provider/model", timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile" },
      rpcArgs: ["--extension", "managed-extension"], onNativeTransportProfile,
      controlAttempt: {
        attemptEpoch: 1, ownerToken: "owner", register: async () => ({ isCurrent: () => current, release: async () => {} }),
        complete: async () => {},
      },
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(onNativeTransportProfile).toHaveBeenCalledOnce();
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(requests.map((request) => request.type)).toEqual(["get_state"]);
  });

  it("runs a chat through --mode rpc and persists provider session/leaf identity", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-chat-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    const logs: string[] = [];
    const registered: Array<{ providerThreadId?: string | null; providerTurnId?: string | null }> = [];
    const profiles: Record<string, unknown>[] = [];
    const result = await executePiNativeChat({
      command,
      cwd: directory,
      env: { HOME: directory, PROVIDER_API_KEY: "must-not-persist" },
      sessionFile,
      sessionDir: directory,
      prompt: "hello native",
      model: "provider/model",
      timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile" },
      rpcArgs: ["--extension", "managed-extension"],
      onNativeTransportProfile: async (profile) => {
        expect(await fs.readFile(sessionFile, "utf8")).toBe("");
        profiles.push(profile);
      },
      controlAttempt: {
        attemptEpoch: 1,
        ownerToken: "owner",
        register: async (handle) => {
          registered.push(handle);
          return { isCurrent: () => true, release: async () => {} };
        },
        complete: async () => {},
      },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });
    const args = JSON.parse(await fs.readFile(path.join(directory, "argv.json"), "utf8")) as string[];
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("rpc");
    expect(args).toContain("--session-dir");
    expect(args[args.indexOf("--session-dir") + 1]).toBe(directory);
    expect(args).toContain("--session");
    expect(args[args.indexOf("--session") + 1]).toBe(sessionFile);
    expect(args).toContain("managed-extension");
    expect(profiles).toEqual([{
      runtimeType: "pi_local", command, cwd: directory, sessionDir: directory,
      rpcArgs: ["--extension", "managed-extension"], rpcEnv: { HOME: directory },
    }]);
    expect(args).not.toContain("--no-tools");
    expect(args).not.toContain("--no-extensions");
    expect(args).not.toContain("--no-builtin-tools");
    expect(result.exitCode).toBe(0);
    expect(result.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_terminal" });
    expect(result.resultJson).toMatchObject({
      transport: "pi_rpc",
      providerSessionId: "pi-parent",
      leafId: "new-leaf",
      eventCount: 5,
      lastEventType: "response",
    });
    expect(result.summary).toBe("native pi answer");
    expect(result.resultJson).not.toHaveProperty("stdout");
    expect(result.resultJson).not.toHaveProperty("stderr");
    expect(result.resultJson).not.toHaveProperty("events");
    const persistedResult = JSON.stringify(result.resultJson);
    expect(persistedResult).not.toContain("native pi answer");
    expect(persistedResult).not.toContain("pi-provider-stdout-secret");
    expect(persistedResult).not.toContain("pi-provider-stderr-secret");
    expect(logs.join("")).not.toContain("pi-provider-stdout-secret");
    expect(logs.join("")).not.toContain("pi-provider-stderr-secret");
    expect(result.sessionParams).toMatchObject({
      sessionFile,
      sessionDir: directory,
      providerSessionId: "pi-parent",
      leafId: "new-leaf",
      previousLeafId: null,
      rpcArgs: ["--extension", "managed-extension"],
      hostId: "local",
      profileId: "pi-profile",
    });
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests.map((request) => request.type)).toEqual(["get_state", "prompt", "get_state"]);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.providerTurnId).toBeNull();
    expect(logs.join("")).toContain("Pi native chat completed");
    expect(logs.join("")).not.toContain("native pi answer");
  });

  it("confirms quiescence only after Pi acknowledges an abort", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-stop-ack-");
    const command = await makePiFixture(directory, { stallPrompt: true, exitOnAbort: true });
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    let resolveControlHandle!: (handle: AgentRuntimeControlHandle) => void;
    const controlHandleReady = new Promise<AgentRuntimeControlHandle>((resolve) => {
      resolveControlHandle = resolve;
    });
    const execution = executePiNativeChat({
      command,
      cwd: directory,
      env: { HOME: directory },
      sessionFile,
      sessionDir: directory,
      prompt: "stop this native turn",
      model: "provider/model",
      timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile" },
      controlAttempt: {
        attemptEpoch: 1,
        ownerToken: "owner",
        register: async (handle) => {
          resolveControlHandle(handle);
          return { isCurrent: () => true, release: async () => {} };
        },
        complete: async () => {},
      },
      onLog: async () => {},
    });

    const handle = await controlHandleReady;
    await expect(handle.interrupt("operator_stop")).resolves.toBe("acknowledged");
    const result = await execution;

    expect(result).toMatchObject({
      exitCode: 1,
      nativeWriterQuiescence: { status: "confirmed", source: "provider_stop_ack" },
    });
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(requests.map((request) => request.type)).toContain("abort");
  });

  it("leaves a prompt timeout unconfirmed when no terminal event or stop ack arrives", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-prompt-timeout-");
    const command = await makePiFixture(directory, { stallPrompt: true });
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");

    const result = await executePiNativeChat({
      command,
      cwd: directory,
      env: { HOME: directory },
      sessionFile,
      sessionDir: directory,
      prompt: "wait for the stalled native turn",
      model: "provider/model",
      timeoutSec: 0.05,
      binding: { hostId: "local", profileId: "pi-profile" },
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      timedOut: true,
      nativeWriterQuiescence: { status: "unconfirmed", reason: expect.any(String) },
    });
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(requests.map((request) => request.type)).toContain("prompt");
    expect(requests.map((request) => request.type)).not.toContain("abort");
  });

  it("bridges Pi extension select, confirm, and text input through runtime approvals", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-extension-ui-");
    const command = await makePiFixture(directory, {
      extensionUi: [
        { id: "select-1", method: "select", title: "Choose mode", options: ["Safe", "Fast"] },
        { id: "confirm-1", method: "confirm", title: "Continue?", message: "Apply the change" },
        { id: "input-1", method: "input", title: "Project name", placeholder: "name" },
        { id: "notify-1", method: "notify", message: "Extension is ready", notifyType: "info" },
      ],
    });
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    const approvals: Array<{ payload: Record<string, unknown>; inputRequest?: { questions: Array<{ options: Array<{ id: string; label: string }> }> } }> = [];
    const replies: string[] = [];
    const result = await executePiNativeChat({
      runId: "pi-ui-run",
      command,
      cwd: directory,
      env: { HOME: directory },
      sessionFile,
      sessionDir: directory,
      prompt: "use extension UI",
      model: "provider/model",
      timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile" },
      rpcArgs: ["--extension", "managed-extension"],
      requestApproval: async (request) => {
        approvals.push(request);
        return { id: `approval-${String(request.payload.requestId)}`, status: "pending" };
      },
      waitForApproval: async (approvalId) => {
        const requestId = approvalId.replace("approval-", "");
        const answer = requestId === "select-1"
          ? { questionId: "pi_extension", optionIds: ["choice_2"] }
          : requestId === "confirm-1"
            ? { questionId: "pi_extension", optionIds: ["choice_2"] }
            : { questionId: "pi_extension", optionIds: ["choice_1"], freeformText: "rudder-project" };
        return { id: approvalId, status: "approved", inputResponse: { answers: [answer] } };
      },
      onLog: async (_stream, chunk) => { replies.push(chunk); },
    });
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(result.exitCode).toBe(0);
    expect(approvals).toHaveLength(3);
    expect(approvals.map((request) => request.payload)).toEqual([
      expect.objectContaining({ provider: "pi", runtimeType: "pi_local", runId: "pi-ui-run", interactionKind: "extension_ui", method: "select" }),
      expect.objectContaining({ provider: "pi", runtimeType: "pi_local", runId: "pi-ui-run", interactionKind: "extension_ui", method: "confirm" }),
      expect.objectContaining({ provider: "pi", runtimeType: "pi_local", runId: "pi-ui-run", interactionKind: "extension_ui", method: "input" }),
    ]);
    expect(approvals[0]?.inputRequest?.questions[0]?.options.map((option) => option.label)).toEqual(["Safe", "Fast"]);
    expect(requests.filter((request) => request.type === "extension_ui_response")).toEqual([
      { type: "extension_ui_response", id: "select-1", value: "Fast" },
      { type: "extension_ui_response", id: "confirm-1", confirmed: false },
      { type: "extension_ui_response", id: "input-1", value: "rudder-project" },
    ]);
    expect(replies.join(" ")).toContain("Extension is ready");
  });

  it("cancels extension dialogs when the approval bridge is unavailable", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-extension-cancel-");
    const command = await makePiFixture(directory, {
      extensionUi: [
        { id: "confirm-1", method: "confirm", title: "Continue?" },
        { id: "select-1", method: "select", title: "Pick", options: ["A", "B", "C", "D", "E"] },
      ],
    });
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    const logs: string[] = [];
    const result = await executePiNativeChat({
      command,
      cwd: directory,
      env: { HOME: directory },
      sessionFile,
      sessionDir: directory,
      prompt: "use extension UI",
      model: "provider/model",
      timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile" },
      rpcArgs: ["--extension", "managed-extension"],
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(result.exitCode).toBe(0);
    expect(requests).toContainEqual({ type: "extension_ui_response", id: "confirm-1", cancelled: true });
    expect(requests).toContainEqual({ type: "extension_ui_response", id: "select-1", cancelled: true });
    expect(logs.join(" ")).toContain("approval_bridge_unavailable");
    expect(logs.join(" ")).toContain("dialog_not_mappable_to_runtime_question");
  });

  it("preserves UTF-8 across RPC chunks and treats Unicode line separators as text", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-unicode-");
    const answer = "first\u2028middle\u2029 emoji 😀";
    const command = await makePiFixture(directory, { answerText: answer, splitUtf8Answer: true });
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    const result = await executePiNativeChat({
      command,
      cwd: directory,
      env: { HOME: directory },
      sessionFile,
      sessionDir: directory,
      prompt: "preserve unicode",
      model: "provider/model",
      timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile" },
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe(answer);
  });

  it("waits for native streaming, compaction, retry, and queue state to settle", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-settled-");
    const command = await makePiFixture(directory, {
      stateSequence: [
        { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
        { isStreaming: true, isCompacting: false, pendingMessageCount: 0 },
        { isStreaming: false, isCompacting: true, pendingMessageCount: 0 },
        { isStreaming: false, isCompacting: false, pendingMessageCount: 2 },
        { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
      ],
    });
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    const result = await executePiNativeChat({
      command,
      cwd: directory,
      env: { HOME: directory },
      sessionFile,
      sessionDir: directory,
      prompt: "wait for settled state",
      model: "provider/model",
      timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile" },
      onLog: async () => {},
    });
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(result.exitCode).toBe(0);
    expect(requests.filter((request) => request.type === "get_state")).toHaveLength(5);
    expect(result.sessionParams).toMatchObject({ providerSessionId: "pi-parent", leafId: "new-leaf" });
  });

  it("waits through an agent_end retry and reports only this Run's assistant usage", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-retry-usage-");
    const command = await makePiFixture(directory, {
      assistantUsages: [
        { input: 20, output: 2, cacheRead: 3, cost: { total: 0.004 } },
        { input: 7, output: 1, cacheRead: 1, cost: { total: 0.001 } },
      ],
      agentEndWillRetry: [true, false],
      retryDelayMs: 180,
    });
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    const result = await executePiNativeChat({
      command,
      cwd: directory,
      env: { HOME: directory },
      sessionFile,
      sessionDir: directory,
      prompt: "retry this native turn",
      model: "provider/model",
      timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile", providerVersion: "0.76.0" },
      onLog: async () => {},
    });
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.exitCode).toBe(0);
    expect(result.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_terminal" });
    expect(result.summary).toBe("native pi answer");
    expect(result.usage).toEqual({ inputTokens: 27, outputTokens: 3, cachedInputTokens: 4 });
    expect(result.costUsd).toBeCloseTo(0.005, 6);
    expect(result.resultJson).toMatchObject({ eventTypes: expect.arrayContaining(["agent_end:2", "auto_retry_start:1", "auto_retry_end:1"]) });
    expect(requests.filter((request) => request.type === "get_state").length).toBeGreaterThan(2);
    expect(requests.some((request) => request.type === "get_session_stats")).toBe(false);
  });

  it("retains native usage already observed when the RPC stream fails", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-partial-usage-");
    const command = await makePiFixture(directory, {
      assistantUsages: [{ input: 9, output: 2, cacheRead: 4, cost: { total: 0.006 } }],
      invalidFrameAfterUsage: true,
    });
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    const result = await executePiNativeChat({
      command,
      cwd: directory,
      env: { HOME: directory },
      sessionFile,
      sessionDir: directory,
      prompt: "fail after provider usage",
      model: "provider/model",
      timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile" },
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 2, cachedInputTokens: 4 });
    expect(result.costUsd).toBeCloseTo(0.006, 6);
  });

  it("reads the exact provider branch range without writing provider JSONL", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-read-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    const original = JSON.stringify({ type: "session", version: 3, id: "pi-parent", timestamp: new Date(0).toISOString(), cwd: directory }) + "\n"
      + JSON.stringify({ id: "prev", type: "message", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "previous" } }) + "\n"
      + JSON.stringify({ id: "leaf", type: "message", parentId: "prev", timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "current" }] } }) + "\n";
    await fs.writeFile(sessionFile, original, "utf8");
    const result = await readPiNativeTranscript({
      runtimeType: "pi_local",
      session: sessionFor(directory, command),
      selector: {
        kind: "pi_branch_range",
        sessionResourceRef: sessionFile,
        fromExclusive: "prev",
        throughInclusive: "leaf",
        leafId: "leaf",
      },
      range: { fromExclusive: null, throughInclusive: "leaf" },
      binding: { hostId: "local", profileId: "pi-profile" },
    });
    expect(result.availability).toBe("available");
    expect(result.items.map((item) => item.id)).toEqual(["leaf"]);
    expect(result.items[0]).toMatchObject({ origin: "native", sourceEntryId: "leaf" });
    expect(await fs.readFile(sessionFile, "utf8")).toBe(original);
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests).toEqual([{ type: "get_state" }]);
    const args = JSON.parse(await fs.readFile(path.join(directory, "argv.json"), "utf8")) as string[];
    expect(args).toContain("managed-extension");
  });

  it("bounds native transcript reads without parsing oversized rows or exposing provider cursors", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-bounded-page-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    const original = [
      { type: "session", version: 3, id: "pi-parent", cwd: directory },
      { id: "first", type: "message", parentId: null, message: { role: "user", content: "first" } },
      { id: "large", type: "message", parentId: "first", message: { role: "assistant", content: "x".repeat(200_081) } },
      { id: "tail", type: "message", parentId: "large", message: { role: "user", content: "tail" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await fs.writeFile(sessionFile, original, "utf8");
    const session = sessionFor(directory, command, "tail");
    session.sessionParams.previousLeafId = "";
    const request = {
      runtimeType: "pi_local",
      session,
      selector: { kind: "pi_branch_range", sessionResourceRef: sessionFile, leafId: "tail" },
      binding: { hostId: "local", profileId: "pi-profile" },
    };
    const parseSpy = vi.spyOn(JSON, "parse");
    let blocked: Awaited<ReturnType<typeof readPiNativeTranscript>>;
    try {
      blocked = await readPiNativeTranscript({
        ...request,
        readerInput: { limit: 10, maxBytes: 4096, maxItemBytes: 1024 },
      });
      expect(parseSpy.mock.calls.some(([value]) => typeof value === "string" && value.length > 1024)).toBe(false);
    } finally {
      parseSpy.mockRestore();
    }

    expect(blocked!).toMatchObject({
      availability: "available",
      completeness: "partial",
      limitReached: { reason: "item_bytes", maximum: 1024 },
      items: [expect.objectContaining({ id: "first" })],
      nextCursor: null,
    });
    expect(Buffer.byteLength(JSON.stringify(blocked!.items), "utf8")).toBeLessThanOrEqual(4096);

    const largeItem = await readPiNativeTranscript({
      ...request,
      range: { itemId: "large" },
      readerInput: { limit: 1, maxBytes: 1_000_000, maxItemBytes: 900_000 },
    });
    expect(largeItem).toMatchObject({ availability: "available", completeness: "complete", nextCursor: null });
    expect(largeItem.items.map((item) => item.id)).toEqual(["large"]);
    expect(Buffer.byteLength(JSON.stringify(largeItem.items), "utf8")).toBeLessThanOrEqual(1_000_000);

    await expect(readPiNativeTranscript({ ...request, cursor: "provider-cursor" })).rejects.toThrow("provider cursors are unsupported");
  });

  it("applies numeric ranges by branch position when provider ordinals are non-monotonic", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-non-monotonic-range-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, [
      { type: "session", version: 3, id: "pi-parent", cwd: directory },
      { id: "step-0", ordinal: 0, type: "message", parentId: null, message: { role: "user", content: "zero" } },
      { id: "step-1", ordinal: 1000, type: "message", parentId: "step-0", message: { role: "assistant", content: "one" } },
      { id: "step-2", ordinal: 2, type: "message", parentId: "step-1", message: { role: "user", content: "two" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    const session = sessionFor(directory, command, "step-2");
    session.sessionParams.previousLeafId = "";
    const result = await readPiNativeTranscript({
      runtimeType: "pi_local",
      session,
      selector: { kind: "pi_branch_range", sessionResourceRef: sessionFile, leafId: "step-2" },
      range: { end: 10 },
      readerInput: { limit: 10, maxBytes: 4096, maxItemBytes: 1024 },
      binding: { hostId: "local", profileId: "pi-profile" },
    });

    expect(result.availability).toBe("available");
    expect(result.items.map((item) => item.id)).toEqual(["step-0", "step-1", "step-2"]);
    expect(result.items.map((item) => item.ordinal)).toEqual([0, 1000, 2]);
    expect(result.completeness).toBe("complete");
  });

  it("reports a partial native snapshot when the bounded transcript index cannot reach its selected leaf", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-index-limit-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    const entries: Record<string, unknown>[] = [
      { type: "session", version: 3, id: "pi-parent", cwd: directory },
    ];
    let parentId: string | null = null;
    for (let index = 0; index <= 20_000; index += 1) {
      const id = "entry-" + index;
      entries.push({ id, type: "message", parentId, message: { role: "user", content: "x" } });
      parentId = id;
    }
    await fs.writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    const session = sessionFor(directory, command, "entry-20000");
    session.sessionParams.previousLeafId = "";
    const result = await readPiNativeTranscript({
      runtimeType: "pi_local",
      session,
      selector: { kind: "pi_branch_range", sessionResourceRef: sessionFile, leafId: "entry-20000" },
      binding: { hostId: "local", profileId: "pi-profile" },
    });

    expect(result).toMatchObject({
      items: [],
      nextCursor: null,
      availability: "available",
      completeness: "partial",
      limitReached: { reason: "total_items", maximum: 20_000 },
    });
  });

  it("selects compressed and abandoned session history by native branch and Run span", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-history-tree-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    const original = [
      { type: "session", version: 3, id: "pi-parent", cwd: directory },
      { type: "message", id: "root-user", parentId: null, message: { role: "user", content: "start" } },
      { type: "message", id: "old-assistant", parentId: "root-user", message: { role: "assistant", content: "old answer" } },
      { type: "message", id: "abandoned-user", parentId: "old-assistant", message: { role: "user", content: "abandoned branch" } },
      { type: "message", id: "abandoned-assistant", parentId: "abandoned-user", message: { role: "assistant", content: "not selected" } },
      { type: "message", id: "current-user", parentId: "old-assistant", message: { role: "user", content: "continue" } },
      { type: "compaction", id: "compact-1", parentId: "current-user", summary: "kept history summary", firstKeptEntryId: "current-user", tokensBefore: 4000 },
      { type: "message", id: "current-assistant", parentId: "compact-1", message: { role: "assistant", content: "after compaction" } },
      { type: "message", id: "next-user", parentId: "current-assistant", message: { role: "user", content: "next" } },
      { type: "message", id: "next-assistant", parentId: "next-user", message: { role: "assistant", content: "latest" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await fs.writeFile(sessionFile, original, "utf8");
    const session = sessionFor(directory, command, "next-assistant");
    const binding = { hostId: "local", profileId: "pi-profile" };
    const oldRun = await readPiNativeTranscript({
      runtimeType: "pi_local",
      session,
      selector: { kind: "pi_branch_range", sessionResourceRef: sessionFile, fromExclusive: null, throughInclusive: "old-assistant", leafId: "old-assistant" },
      binding,
    });
    const laterRun = await readPiNativeTranscript({
      runtimeType: "pi_local",
      session,
      selector: { kind: "pi_branch_range", sessionResourceRef: sessionFile, fromExclusive: "old-assistant", throughInclusive: "next-assistant", leafId: "next-assistant" },
      binding,
    });

    expect(oldRun.items.map((item) => item.sourceEntryId)).toEqual(["root-user", "old-assistant"]);
    expect(laterRun.items.map((item) => item.sourceEntryId)).toEqual([
      "current-user", "compact-1", "current-assistant", "next-user", "next-assistant",
    ]);
    expect(JSON.stringify([...oldRun.items, ...laterRun.items])).not.toContain("abandoned-");
    expect(await fs.readFile(sessionFile, "utf8")).toBe(original);
  });

  it("fails closed when Pi Run anchors were pruned or belong to another branch", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-pruned-anchor-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, [
      { type: "session", version: 3, id: "pi-parent", cwd: directory },
      { type: "message", id: "root-user", parentId: null, message: { role: "user", content: "start" } },
      { type: "message", id: "abandoned-user", parentId: "root-user", message: { role: "user", content: "abandoned" } },
      { type: "message", id: "abandoned-assistant", parentId: "abandoned-user", message: { role: "assistant", content: "other branch" } },
      { type: "message", id: "kept-user", parentId: "pruned-assistant", message: { role: "user", content: "continue" } },
      { type: "compaction", id: "compact-1", parentId: "kept-user", summary: "compacted history", firstKeptEntryId: "kept-user" },
      { type: "message", id: "latest-assistant", parentId: "compact-1", message: { role: "assistant", content: "latest" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    const session = sessionFor(directory, command, "latest-assistant");
    const binding = { hostId: "local", profileId: "pi-profile" };
    const selector = {
      kind: "pi_branch_range",
      sessionResourceRef: sessionFile,
      fromExclusive: "pruned-assistant",
      throughInclusive: "latest-assistant",
      leafId: "latest-assistant",
    };

    const prunedStart = await readPiNativeTranscript({
      runtimeType: "pi_local", session, selector, binding,
    });
    const otherBranchStart = await readPiNativeTranscript({
      runtimeType: "pi_local",
      session,
      selector: { ...selector, fromExclusive: "abandoned-assistant" },
      binding,
    });
    const otherBranchEnd = await readPiNativeTranscript({
      runtimeType: "pi_local",
      session,
      selector: { ...selector, fromExclusive: null },
      range: { throughInclusive: "abandoned-assistant" },
      binding,
    });
    const prunedPersistedLeafSession = {
      ...session,
      sessionParams: {
        ...session.sessionParams,
        leafId: "pruned-assistant",
        previousLeafId: null,
      },
    };
    const prunedPersistedLeaf = await readPiNativeTranscript({
      runtimeType: "pi_local",
      session: prunedPersistedLeafSession,
      range: {},
      binding,
    });

    for (const result of [prunedStart, otherBranchStart, otherBranchEnd, prunedPersistedLeaf]) {
      expect(result).toMatchObject({
        items: [],
        availability: "incompatible",
        completeness: "unknown",
      });
    }
  });

  it("reports a truly empty session-scope history as complete", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-empty-session-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    const validHeader = JSON.stringify({
      type: "session", version: 3, id: "pi-parent", cwd: directory,
    });
    const readSessionScope = () => {
      const initialSession = sessionFor(directory, command);
      const session = {
        ...initialSession,
        sessionParams: { ...initialSession.sessionParams, leafId: null, previousLeafId: null },
      };
      return readPiNativeTranscript({
        runtimeType: "pi_local",
        session,
        binding: { hostId: "local", profileId: "pi-profile" },
      });
    };

    await fs.writeFile(sessionFile, `${validHeader}\n`, "utf8");
    await expect(readSessionScope()).resolves.toMatchObject({
      items: [],
      availability: "available",
      completeness: "complete",
    });

    for (const invalidHistory of [
      "",
      `${validHeader}\n${validHeader}\n`,
      `${JSON.stringify({ type: "session", version: 3, id: "different-session", cwd: directory })}\n`,
      `${validHeader}\n{\"type\":\"message\"`,
    ]) {
      await fs.writeFile(sessionFile, invalidHistory, "utf8");
      await expect(readSessionScope()).resolves.toMatchObject({
        items: [],
        availability: "incompatible",
        completeness: "unknown",
      });
    }
  });

  it("projects native thinking, tool calls, and failed results into renderable entries", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-tools-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    const original = [
      { type: "session", version: 3, id: "pi-parent", cwd: directory },
      { type: "message", id: "prev", parentId: null, message: { role: "user", content: "inspect" } },
      { type: "message", id: "call", parentId: "prev", message: { role: "assistant", content: [
        { type: "thinking", thinking: "Check the file" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "missing.txt" } },
      ] } },
      { type: "message", id: "leaf", parentId: "call", message: {
        role: "toolResult", toolCallId: "call-1", toolName: "read", isError: true,
        content: [{ type: "text", text: "File not found" }],
      } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await fs.writeFile(sessionFile, original, "utf8");
    const request = {
      runtimeType: "pi_local", session: sessionFor(directory, command),
      selector: { kind: "pi_branch_range", sessionResourceRef: sessionFile, fromExclusive: "prev", throughInclusive: "leaf" },
      binding: { hostId: "local", profileId: "pi-profile" },
    };
    const result = await readPiNativeTranscript(request);
    expect(result.items.map((item) => item.entry)).toMatchObject([
      { kind: "thinking", text: "Check the file", sourceEntryId: "call" },
      { kind: "tool_call", toolUseId: "call-1", name: "read", input: { path: "missing.txt" } },
      { kind: "tool_result", toolUseId: "call-1", content: "File not found", isError: true },
    ]);
    const throughCall = await readPiNativeTranscript({ ...request, range: { throughInclusive: "call" } });
    expect(throughCall.items.map((item) => item.kind)).toEqual(["thinking", "tool_call"]);
    const afterCall = await readPiNativeTranscript({ ...request, range: { fromExclusive: "call" } });
    expect(afterCall.items.map((item) => item.kind)).toEqual(["tool_result"]);
    expect(await fs.readFile(sessionFile, "utf8")).toBe(original);
  });

  it("preserves the first Run's explicit null start after the shared session advances", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-first-range-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, [
      { type: "session", version: 3, id: "pi-parent", cwd: directory },
      { type: "message", id: "first-user", parentId: null, message: { role: "user", content: "one" } },
      { type: "message", id: "first-answer", parentId: "first-user", message: { role: "assistant", content: "answer" } },
      { type: "message", id: "second-user", parentId: "first-answer", message: { role: "user", content: "two" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    const session = sessionFor(directory, command);
    session.sessionParams.previousLeafId = "first-answer";
    const result = await readPiNativeTranscript({ runtimeType: "pi_local", session,
      selector: { kind: "pi_branch_range", sessionResourceRef: sessionFile, fromExclusive: null, throughInclusive: "first-answer" },
      binding: { hostId: "local", profileId: "pi-profile" },
    });
    expect(result.availability).toBe("available");
    expect(result.items.map((item) => item.id)).toEqual(["first-user", "first-answer"]);
  });

  it("reuses persisted session-file params across a second Pi RPC process", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-resume-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    const first = await executePiNativeChat({
      command,
      cwd: directory,
      env: { HOME: directory },
      sessionFile,
      sessionDir: directory,
      prompt: "resume native",
      model: "provider/model",
      timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile", providerVersion: "0.76.0" },
      rpcArgs: ["--extension", "managed-extension"],
      onLog: async () => {},
    });
    const persisted = sessionCodec.deserialize(sessionCodec.serialize(first.sessionParams ?? null) ?? null)!;
    const persistedEnv = persisted.rpcEnv as Record<string, string>;
    const second = await executePiNativeChat({
      command: String(persisted.command),
      cwd: String(persisted.cwd),
      env: persistedEnv,
      sessionFile: String(persisted.sessionFile),
      sessionDir: String(persisted.sessionDir),
      prompt: "resume native",
      model: "provider/model",
      timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile", providerVersion: "0.76.0" },
      sessionParams: persisted,
      rpcArgs: persisted.rpcArgs as string[],
      onLog: async () => {},
    });
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(second.sessionParams).toMatchObject({
      sessionFile,
      sessionDir: directory,
      previousLeafId: "new-leaf",
      providerSessionId: "pi-parent",
    });
    const args = JSON.parse(await fs.readFile(path.join(directory, "argv.json"), "utf8")) as string[];
    expect(args[args.indexOf("--session") + 1]).toBe(sessionFile);
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests.map((request) => request.type)).toEqual([
      "get_state", "prompt", "get_state", "get_state", "prompt", "get_state",
    ]);
  });

  it("forks a selected assistant while a parent append races, without inheriting later entries", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-fork-");
    const command = await makePiFixture(directory, { appendParentDuringFork: true });
    const sessionFile = path.join(directory, "session.jsonl");
    const original = JSON.stringify({ type: "session", version: 3, id: "pi-parent", timestamp: new Date(0).toISOString(), cwd: directory }) + "\n"
      + JSON.stringify({ id: "previous-user", type: "message", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "previous" } }) + "\n"
      + JSON.stringify({ id: "selected-assistant", type: "message", parentId: "previous-user", timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "selected" }] } }) + "\n"
      + JSON.stringify({ id: "later-user", type: "message", parentId: "selected-assistant", timestamp: new Date(0).toISOString(), message: { role: "user", content: "later" } }) + "\n"
      + JSON.stringify({ id: "later-assistant", type: "message", parentId: "later-user", timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "later answer" }] } }) + "\n";
    await fs.writeFile(
      sessionFile,
      original,
      "utf8",
    );
    const forkBinding = { hostId: "local", profileId: "pi-profile" };
    const forkProvider = createPiLocalProviderCapabilityResolver(() => ({
      binding: forkBinding, providerVersion: "0.76.0", command, cwd: directory,
      sessionDir: directory, rpcArgs: ["--extension", "managed-extension"],
    }))("pi_local", forkBinding)!;
    const sourceSession = sessionFor(directory, command, "selected-assistant");
    const result = await forkProvider.fork.fork({
      runtimeType: "pi_local",
      session: { ...sourceSession, sessionParams: { ...sourceSession.sessionParams, providerVersion: "0.76.0", workspaceId: "workspace-1" } },
      boundary: "selected-assistant",
      selector: { kind: "pi_branch_range", throughInclusive: "selected-assistant", leafId: "selected-assistant" },
      binding: { hostId: "local", profileId: "pi-profile" },
    });
    expect(result.continuity).toBe("native");
    expect(result.session.sessionId).toContain("fork-child.jsonl");
    expect(result.session.sessionParams).toMatchObject({
      sessionFile: result.session.sessionId,
      providerSessionId: "pi-child",
      hostId: "local",
      profileId: "pi-profile",
      transport: "pi-rpc-stdio",
      providerVersion: "0.76.0",
      workspaceId: "workspace-1",
    });
    const parentAfterFork = await fs.readFile(sessionFile, "utf8");
    expect(parentAfterFork.startsWith(original)).toBe(true);
    expect(parentAfterFork).toContain("concurrent-parent-entry");
    const childEntries = (await fs.readFile(result.session.sessionId, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string });
    expect(childEntries.map((entry) => entry.id)).toEqual([
      "pi-child",
      "previous-user",
      "selected-assistant",
    ]);
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests).toEqual([
      { type: "get_state" },
      { type: "fork", entryId: "later-user" },
      { type: "get_state" },
    ]);
    const args = JSON.parse(await fs.readFile(path.join(directory, "argv.json"), "utf8")) as string[];
    expect(args).toContain("managed-extension");
    await expect(forkPiNativeSession({
      runtimeType: "pi_local",
      session: sessionFor(directory, command),
      boundary: "selected-assistant",
      binding: { hostId: "local", profileId: "other-profile" },
    })).rejects.toMatchObject({ status: "unsupported" });
  });

  it("uses native clone for a current assistant head", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-clone-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    const original = JSON.stringify({ type: "session", version: 3, id: "pi-parent", timestamp: new Date(0).toISOString(), cwd: directory }) + "\n"
      + JSON.stringify({ id: "user", type: "message", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "question" } }) + "\n"
      + JSON.stringify({ id: "assistant", type: "message", parentId: "user", timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }) + "\n";
    await fs.writeFile(sessionFile, original, "utf8");
    const result = await forkPiNativeSession({
      runtimeType: "pi_local",
      session: sessionFor(directory, command, "assistant"),
      boundary: "assistant",
      selector: { kind: "pi_branch_range", throughInclusive: "assistant", leafId: "assistant" },
      binding: { hostId: "local", profileId: "pi-profile" },
    });
    expect(result.boundary).toBe("assistant");
    expect(await fs.readFile(sessionFile, "utf8")).toBe(original);
    const childEntries = (await fs.readFile(result.session.sessionId, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string });
    expect(childEntries.map((entry) => entry.id)).toEqual(["pi-child", "user", "assistant"]);
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests).toEqual([{ type: "get_state" }, { type: "clone" }, { type: "get_state" }]);
  });

  it("reports provider-extension fork cancellation explicitly", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-fork-cancel-");
    const command = await makePiFixture(directory, { cancelFork: true });
    const sessionFile = path.join(directory, "session.jsonl");
    const original = JSON.stringify({ type: "session", version: 3, id: "pi-parent", timestamp: new Date(0).toISOString(), cwd: directory }) + "\n"
      + JSON.stringify({ id: "user", type: "message", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "question" } }) + "\n"
      + JSON.stringify({ id: "assistant", type: "message", parentId: "user", timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }) + "\n"
      + JSON.stringify({ id: "later-user", type: "message", parentId: "assistant", timestamp: new Date(0).toISOString(), message: { role: "user", content: "later" } }) + "\n"
      + JSON.stringify({ id: "later-assistant", type: "message", parentId: "later-user", timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "later answer" }] } }) + "\n";
    await fs.writeFile(sessionFile, original, "utf8");
    await expect(forkPiNativeSession({
      runtimeType: "pi_local",
      session: sessionFor(directory, command, "later-assistant"),
      boundary: "assistant",
      selector: { kind: "pi_branch_range", throughInclusive: "assistant", leafId: "assistant" },
      binding: { hostId: "local", profileId: "pi-profile" },
    })).rejects.toMatchObject({
      status: "unsupported",
      message: expect.stringContaining("cancelled by a provider extension"),
    });
    expect(await fs.readFile(sessionFile, "utf8")).toBe(original);
    await expect(fs.access(path.join(directory, "fork-child.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    const requests = (await fs.readFile(path.join(directory, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests).toEqual([{ type: "get_state" }, { type: "fork", entryId: "later-user" }]);
  });

  it("refuses an unknown assistant boundary before starting the provider", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-fork-unknown-");
    const command = await makePiFixture(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({ type: "session", version: 3, id: "pi-parent", timestamp: new Date(0).toISOString(), cwd: directory }) + "\n"
        + JSON.stringify({ id: "user", type: "message", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "question" } }) + "\n"
        + JSON.stringify({ id: "assistant", type: "message", parentId: "user", timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }) + "\n",
      "utf8",
    );
    await expect(forkPiNativeSession({
      runtimeType: "pi_local",
      session: sessionFor(directory, command, "assistant"),
      boundary: "missing-assistant",
      binding: { hostId: "local", profileId: "pi-profile" },
    })).rejects.toMatchObject({
      status: "unsupported",
      message: expect.stringContaining("not on the persisted provider head branch"),
    });
    await expect(fs.access(path.join(directory, "argv.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("forwards live Pi steer and abort RPC commands and keeps boundary identity real", async () => {
    const command = vi.fn(async () => null);
    const handle = createPiRpcControlHandle({ rpc: { command }, sessionId: "pi-parent", providerTurnId: "leaf" });
    await expect(handle.steer({ text: "steer now", clientMessageId: "rudder-message" })).resolves.toEqual({
      disposition: "accepted_current",
      providerThreadId: "pi-parent",
      providerTurnId: "leaf",
    });
    await expect(handle.interrupt("operator_stop")).resolves.toBe("acknowledged");
    expect(command).toHaveBeenNthCalledWith(1, "steer", { message: "steer now" });
    expect(command).toHaveBeenNthCalledWith(2, "abort");
  });

  it("keeps native hooks unresolved until a profile resolver attests persisted transport state", () => {
    expect(runtimeProviderCapabilities.transcript.evidence).toMatchObject({ status: "unknown", profileBound: false, profileRequired: true });
    expect(runtimeProviderCapabilities.transcript.readRange).toBeTypeOf("function");
    expect(runtimeProviderCapabilities.fork.evidence).toMatchObject({ status: "unknown", profileBound: false, profileRequired: true });
    expect(runtimeProviderCapabilities.fork.fork).toBeTypeOf("function");
    expect(runtimeProviderCapabilities.control.steer).toMatchObject({ mode: "native", requiresHandle: true });
    expect(runtimeProviderCapabilities.control.interrupt).toMatchObject({ mode: "native", requiresHandle: true });
  });

  it("round-trips managed Pi session parameters through the codec", () => {
    const encoded = sessionCodec.serialize({
      sessionId: "/tmp/pi-session.jsonl",
      sessionFile: "/tmp/pi-session.jsonl",
      sessionDir: "/tmp",
      cwd: "/tmp/work",
      command: "pi",
      rpcArgs: ["--extension", "managed-extension"],
      rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/tmp" },
      providerSessionId: "pi-parent",
      leafId: "leaf",
      previousLeafId: "prev",
      hostId: "local",
      profileId: "pi-profile",
      transport: "pi-rpc-stdio",
    });
    expect(encoded).toMatchObject({
      sessionFile: "/tmp/pi-session.jsonl",
      sessionDir: "/tmp",
      rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/tmp" },
      rpcArgs: ["--extension", "managed-extension"],
      providerSessionId: "pi-parent",
      leafId: "leaf",
      profileId: "pi-profile",
    });
  });

  it("rejects unknown RPC env before persisted resume and drops opaque bindings", async () => {
    const encoded = sessionCodec.serialize({
      sessionId: "/tmp/pi-session.jsonl",
      sessionFile: "/tmp/pi-session.jsonl",
      sessionDir: "/tmp",
      cwd: "/tmp/work",
      command: "pi",
      rpcArgs: ["--extension", "managed-extension"],
      rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/tmp" },
      opaqueBinding: { token: "do-not-persist" },
      hostId: "local",
      profileId: "pi-profile",
    });
    expect(encoded).not.toHaveProperty("opaqueBinding");
    expect(encoded?.rpcEnv).toEqual({ PI_CODING_AGENT_SESSION_DIR: "/tmp" });
    expect(sessionCodec.serialize({
      sessionId: "/tmp/pi-session.jsonl",
      rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/tmp", PI_API_KEY: "do-not-persist" },
    })).toBeNull();

    const incomplete = {
      sessionId: "/tmp/pi-session.jsonl",
      sessionDisplayId: "pi-parent",
      sessionParams: {
        sessionId: "/tmp/pi-session.jsonl",
        sessionFile: "/tmp/pi-session.jsonl",
        sessionDir: "/tmp",
        cwd: "/tmp/work",
        command: "pi",
        rpcEnv: {},
        hostId: "local",
        profileId: "pi-profile",
      },
    };
    await expect(readPiNativeTranscript({
      runtimeType: "pi_local",
      session: incomplete,
      binding: { hostId: "local", profileId: "pi-profile" },
    })).rejects.toMatchObject({ status: "unknown" });
  });

  it("requires the profile-bound resolver to attest persisted cwd, RPC args, and session transport", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-profile-drift-");
    const command = await makePiFixture(directory);
    const binding = { hostId: "local", profileId: "pi-profile" };
    const resolver = createPiLocalProviderCapabilityResolver(() => ({
      binding,
      command,
      cwd: directory,
      sessionDir: directory,
      rpcArgs: ["--extension", "managed-extension"],
    }));
    const adapter = resolver("pi_local", binding)!;
    const drifted = sessionFor(directory, command);
    drifted.sessionParams.rpcArgs = ["--extension", "different-extension"];
    await expect(adapter.transcript.readRange({
      runtimeType: "pi_local",
      session: drifted,
      binding,
    })).resolves.toMatchObject({ availability: "incompatible" });
  });

  it("fails closed before spawning for persisted identity drift and unknown native sessions", async () => {
    const directory = await makeFixtureDirectory("rudder-pi-native-fail-closed-");
    const command = await makePiFixture(directory);
    const session = sessionFor(directory, command);
    const sessionFile = session.sessionId;
    await fs.writeFile(
      sessionFile,
      JSON.stringify({ type: "session", version: 3, id: "pi-parent", timestamp: new Date(0).toISOString(), cwd: directory }) + "\n",
      "utf8",
    );
    const base = {
      command,
      cwd: directory,
      env: { HOME: directory },
      sessionFile,
      sessionDir: directory,
      prompt: "must not reach provider",
      model: "provider/model",
      timeoutSec: 10,
      binding: { hostId: "local", profileId: "pi-profile" },
      sessionParams: session.sessionParams,
      rpcArgs: ["--extension", "managed-extension"],
      onLog: async () => {},
    } as const;

    await expect(executePiNativeChat({
      ...base,
      binding: { hostId: "other-host", profileId: "pi-profile" },
    })).rejects.toMatchObject({ status: "unsupported" });
    await expect(executePiNativeChat({
      ...base,
      binding: { hostId: "local", profileId: "other-profile" },
    })).rejects.toMatchObject({ status: "unsupported" });
    await expect(executePiNativeChat({
      ...base,
      cwd: path.join(directory, "other-cwd"),
    })).rejects.toMatchObject({ status: "unsupported" });
    await expect(executePiNativeChat({
      ...base,
      workspace: { workspaceId: "workspace-b" },
    })).rejects.toMatchObject({ status: "unsupported" });
    await expect(executePiNativeChat({
      ...base,
      sessionParams: { ...session.sessionParams, transport: "pi-cli" },
    })).rejects.toMatchObject({ status: "unsupported" });

    await fs.rm(sessionFile);
    await expect(executePiNativeChat(base)).rejects.toMatchObject({ status: "unknown" });
    await expect(fs.access(path.join(directory, "argv.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
