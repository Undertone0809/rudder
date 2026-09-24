import type {
  AgentRuntimeApprovalDecision,
  AgentRuntimeApprovalRequest,
  AgentRuntimeExecutionContext,
} from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findServerAdapter } from "../agent-runtimes/registry.js";

const HERMES_ACP_MOCK = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
let promptId = null;
const approvalId = 71;
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
function update(sessionId, update) { send({ method: "session/update", params: { sessionId, update } }); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes-agent", version: "0.21.0" }, agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } } } });
    } else if (message.method === "session/new") {
      send({ id: message.id, result: { sessionId: "server-hermes-session" } });
    } else if (message.method === "session/prompt") {
      promptId = message.id;
      send({ id: approvalId, method: "session/request_permission", params: {
        sessionId: message.params.sessionId,
        toolCall: { toolCallId: "tool-71", title: "clientSecret=" + process.env.OPENAI_API_KEY, rawInput: { value: process.env.OPENAI_API_KEY } },
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow once", description: "Proceed" },
          { optionId: "reject_once", kind: "reject_once", name: "Deny", description: "Stop" }
        ]
      } });
    } else if (message.id === approvalId && message.result) {
      if (message.result.outcome?.outcome !== "selected" || message.result.outcome.optionId !== "allow_once") process.exitCode = 9;
      update("server-hermes-session", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "completed with clientSecret=" + process.env.OPENAI_API_KEY } });
      update("server-hermes-session", { sessionUpdate: "usage_update", size: 8000, used: 144 });
      send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } } });
    }
  }
});
`;

const HERMES_PRODUCT_RPC_MOCK = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const historyPath = path.join(process.env.HERMES_HOME || process.cwd(), "history.json");
if (process.argv[2] === "-c") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const request = JSON.parse(input || "{}");
    const state = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, "utf8")) : null;
    if (!state || state.session.id !== request.sessionId) {
      process.stdout.write(JSON.stringify({ ok: false, helperVersion: request.helperVersion, error: { code: "session_missing", message: "session not found" } }) + "\n");
      return;
    }
    const rows = state.rows.filter((row) => request.afterId === null || row.id > request.afterId).slice(0, request.limit);
    process.stdout.write(JSON.stringify({ ok: true, helperVersion: request.helperVersion, sessionId: request.sessionId, rows, tailRowId: state.rows.at(-1)?.id ?? null, session: state.session, compressionTipSessionId: null, resolvedResumeSessionId: request.sessionId, successorSession: null }) + "\n");
  });
} else {
process.stdin.setEncoding("utf8");
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
function event(sessionId, type, payload = {}) {
  send({ method: "event", params: { type, session_id: sessionId, payload } });
}
send({ method: "event", params: { type: "gateway.ready", payload: {} } });
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const params = message.params || {};
    if (message.method === "ping") send({ id: message.id, result: { pong: true } });
    else if (message.method === "gateway.capabilities") send({ id: message.id, result: { per_session_exclusive_submit: true } });
    else if (message.method === "session.create") {
      fs.mkdirSync(process.env.HERMES_HOME, { recursive: true });
      fs.writeFileSync(historyPath, JSON.stringify({
        session: { id: "product-session-key-1", source: "tui", parent_session_id: null, profile_name: "default", cwd: params.cwd, started_at: Date.now() / 1000, ended_at: null, end_reason: null, message_count: 0, tool_call_count: 0 },
        rows: []
      }));
      send({ id: message.id, result: { session_id: "product-session-1", stored_session_id: "product-session-key-1" } });
    }
    else if (message.method === "prompt.submit") {
      const state = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      state.rows.push(
        { id: 1, session_id: "product-session-key-1", role: "user", content: params.text, timestamp: new Date().toISOString() },
        { id: 2, session_id: "product-session-key-1", role: "assistant", content: "Product Gateway response", timestamp: new Date().toISOString() }
      );
      state.session.message_count = state.rows.length;
      fs.writeFileSync(historyPath, JSON.stringify(state));
      event(params.session_id, "message.start");
      event(params.session_id, "message.complete", { text: "Product Gateway response", status: "complete" });
      event(params.session_id, "session.info", { running: false, model: "hermes-product-test" });
      send({ id: message.id, result: { status: "streaming" } });
    } else send({ id: message.id, result: {} });
  }
});
}
`;

function context(
  config: Record<string, unknown>,
  overrides: Partial<AgentRuntimeExecutionContext> = {},
): AgentRuntimeExecutionContext {
  return {
    runId: "run-hermes-native-integration",
    agent: {
      id: "agent-hermes-native-integration",
      orgId: "org-hermes-native-integration",
      name: "Hermes native integration",
      agentRuntimeType: "hermes_gateway",
      agentRuntimeConfig: config,
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: { chatMode: true, chatPrompt: "Exercise the native Hermes session." },
    onLog: async () => undefined,
    ...overrides,
  };
}

describe("Hermes gateway native server integration", () => {
  it("creates an ACP session, round-trips permission input, projects usage, and redacts secrets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-native-server-"));
    const secret = "provider-secret-for-hermes-test";
    const logs: string[] = [];
    let approval: AgentRuntimeApprovalRequest | null = null;
    const adapter = findServerAdapter("hermes_gateway");
    if (!adapter) throw new Error("Hermes gateway adapter is not registered");

    try {
      const config = {
        hermesChatBackend: "acp",
        hermesAcpCommand: process.execPath,
        hermesAcpArgs: ["-e", HERMES_ACP_MOCK],
        hermesProviderVersion: "0.21.0",
        cwd: root,
        env: { OPENAI_API_KEY: secret },
        providerHostId: "host-hermes-native-test",
        providerProfileId: "profile-hermes-native-test",
        capabilityRevision: "hermes-acp-test-v1",
      };
      const result = await adapter.execute(context(config, {
        onLog: async (_stream, chunk) => { logs.push(chunk); },
        requestApproval: async (request) => {
          approval = request;
          return { id: "rudder-approval-71", status: "pending" };
        },
        waitForApproval: async (id) => ({
          id,
          status: "approved",
          inputResponse: { answers: [{ questionId: "hermes_permission", optionIds: ["option-1"] }] },
        } satisfies AgentRuntimeApprovalDecision),
      }));

      expect(result).toMatchObject({
        exitCode: 0,
        sessionId: "server-hermes-session",
        provider: "hermes",
        usage: { inputTokens: 5, outputTokens: 7 },
        resultJson: {
          nativeSession: true,
          transport: "hermes-acp-stdio",
          updates: [
            { sessionUpdate: "agent_message_chunk" },
            { contextUsage: { size: 8000, used: 144 } },
          ],
        },
      });
      expect(result.sessionParams).toMatchObject({
        sessionId: "server-hermes-session",
        transport: "hermes-acp-stdio",
        profileHostId: "host-hermes-native-test",
        profileId: "profile-hermes-native-test",
      });
      expect(result.summary).toBe("completed with clientSecret=[REDACTED]");
      expect(approval).toMatchObject({
        type: "agent_runtime",
        inputRequest: {
          questions: [{
            id: "hermes_permission",
            options: [{ id: "option-1", label: "Allow once" }, { id: "option-2", label: "Deny" }],
          }],
        },
      });
      expect(JSON.stringify(approval)).not.toContain(secret);
      expect(JSON.stringify(result.resultJson)).not.toContain(secret);
      expect(JSON.stringify(result.sessionParams)).not.toContain(secret);

      const projected = logs.flatMap((line) => {
        try { return [JSON.parse(line) as Record<string, unknown>]; }
        catch { return []; }
      });
      const interactions = projected.filter((event) => event.type === "hermes_acp_interaction");
      expect(interactions).toHaveLength(2);
      expect(interactions.map((event) => event.status)).toEqual(["requested", "resolved"]);
      expect(logs.join("\n")).not.toContain(secret);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("routes a new Chat through the Product Gateway when a complete authorized profile is present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-product-server-"));
    const source = path.join(root, "source");
    const gatewayPath = path.join(root, "hermes-python-mock");
    const logs: string[] = [];
    const adapter = findServerAdapter("hermes_gateway");
    if (!adapter) throw new Error("Hermes gateway adapter is not registered");

    try {
      await fs.mkdir(path.join(source, "tui_gateway"), { recursive: true });
      await fs.writeFile(path.join(source, "tui_gateway", "entry.py"), "# test fixture\n");
      await fs.writeFile(gatewayPath, HERMES_PRODUCT_RPC_MOCK, { mode: 0o755 });
      await fs.chmod(gatewayPath, 0o755);
      const config = {
        hermesPythonCommand: gatewayPath,
        hermesSourcePath: source,
        hermesHome: path.join(root, "hermes-home"),
        hermesProviderVersion: "0.21.0",
        cwd: root,
        providerHostId: "host-hermes-product-test",
        providerProfileId: "profile-hermes-product-test",
      };

      const result = await adapter.execute(context(config, {
        onLog: async (_stream, chunk) => { logs.push(chunk); },
      }));

      expect(result).toMatchObject({
        exitCode: 0,
        sessionId: "product-session-key-1",
        provider: "hermes",
        summary: "Product Gateway response",
        sessionParams: {
          transport: "hermes-tui-gateway-stdio",
          profileHostId: "host-hermes-product-test",
          profileId: "profile-hermes-product-test",
        },
        resultJson: {
          backend: "native_product_rpc",
          transport: "hermes-tui-gateway-stdio",
          transcriptBoundary: {
            status: "exact",
            sessionId: "product-session-key-1",
            startExclusive: null,
            endInclusive: 2,
          },
        },
      });
      expect(logs.join("\n")).toContain("hermes_product_rpc_event");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
