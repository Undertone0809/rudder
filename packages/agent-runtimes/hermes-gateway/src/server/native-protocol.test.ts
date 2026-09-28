import type { AgentRuntimeControlAttemptLease, AgentRuntimeControlHandle } from "@rudderhq/agent-runtime-utils";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createHermesNativeRpcClient,
  deriveHermesAcpTranscriptBoundary,
  executeHermesNativeChat,
  forkHermesAcpNativeSession,
  HERMES_ACP_NATIVE_TRANSPORT,
  readHermesAcpNativeTranscript,
  type HermesAcpProfile,
} from "./native-protocol.js";
import {
  readHermesProductHistory,
  type HermesProductHistoryProfile,
} from "./product-history.js";

const ACP_MOCK = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
let promptId = null;
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
function update(sessionId, text) {
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes", version: "0.21.0" }, agentCapabilities: { loadSession: true, listSessions: true, sessionFork: true }, authMethods: [{ id: "hermes-test-auth" }] } });
    } else if (message.method === "authenticate") {
      send({ id: message.id, result: {} });
    } else if (message.method === "session/new") {
      send({ id: message.id, result: { sessionId: "hermes-session-new" } });
    } else if (message.method === "session/load") {
      update(message.params.sessionId, "replayed");
      send({ id: message.id, result: { sessionId: message.params.sessionId } });
    } else if (message.method === "session/set_model" || message.method === "session/set_mode") {
      send({ id: message.id, result: {} });
    } else if (message.method === "session/prompt") {
      promptId = message.id;
      update(message.params.sessionId, "hello from Hermes ACP");
      send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 4 } } });
    } else if (message.method === "session/fork") {
      send({ id: message.id, result: { sessionId: "hermes-session-fork" } });
    } else if (message.method === "session/cancel" && promptId !== null) {
      send({ id: promptId, result: { stopReason: "cancelled" } });
    }
  }
});
`;

const ACP_HISTORY_MOCK = String.raw`
const fs = require("node:fs");
process.stdin.setEncoding("utf8");
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
function update(sessionId, text) {
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes-agent", version: "0.21.0" }, agentCapabilities: { loadSession: true } } });
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "hermes-history" } });
    else if (message.method === "session/prompt") {
      const databasePath = require("node:path").join(process.env.HERMES_HOME, "state.db");
      const database = JSON.parse(fs.readFileSync(databasePath, "utf8"));
      database.messages["hermes-history"].push(
        { id: 3, session_id: "hermes-history", role: "assistant", content: "interleaved foreign assistant", timestamp: 3, active: 1, compacted: 0 },
        { id: 4, session_id: "hermes-history", role: "user", content: message.params.prompt[0].text, timestamp: 4, active: 1, compacted: 0 },
        { id: 5, session_id: "hermes-history", role: "tool", tool_name: "foreign-tool", content: "interleaved foreign tool", timestamp: 5, active: 1, compacted: 0 },
        { id: 6, session_id: "hermes-history", role: "assistant", content: "history output", timestamp: 6, active: 1, compacted: 0 },
      );
      fs.writeFileSync(databasePath, JSON.stringify(database));
      update("hermes-history", "history output");
      send({ id: message.id, result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 4 } } });
    }
  }
});
`;

const ACP_MISSING_LOAD_MOCK = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes", version: "0.21.0" }, agentCapabilities: { loadSession: true } } });
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "hermes-session-missing-load" } });
    else if (message.method === "session/load") send({ id: message.id, result: null });
    else if (message.method === "session/prompt") send({ id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

const ACP_PROVIDER_ERROR_MOCK = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes", version: "0.21.0" }, agentCapabilities: { loadSession: true } } });
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "hermes-session-provider-error" } });
    else if (message.method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "error", error: { code: "provider_error", message: "Provider credentials unavailable" } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;

const ACP_PROVIDER_HTTP_403_UPDATE_MOCK = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes", version: "0.21.0" }, agentCapabilities: { loadSession: true } } });
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "hermes-session-http-403-update" } });
    else if (message.method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "non_retryable_client_error: HTTP 403 subscription required." } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;

const ACP_SUBSCRIPTION_ANSWER_MOCK = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes", version: "0.21.0" }, agentCapabilities: { loadSession: true } } });
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "hermes-session-subscription-answer" } });
    else if (message.method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The documentation explains what subscription required means for this account; the requested configuration is valid." } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;

const ACP_PROVIDER_HTTP_403_RPC_MOCK = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes", version: "0.21.0" }, agentCapabilities: { loadSession: true } } });
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "hermes-session-http-403-rpc" } });
    else if (message.method === "session/prompt") send({ id: message.id, error: { code: -32000, message: "non_retryable_client_error: HTTP 403 subscription required." } });
  }
});
`;

const ACP_EMPTY_END_TURN_MOCK = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes", version: "0.21.0" }, agentCapabilities: { loadSession: true } } });
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "hermes-session-empty-end-turn" } });
    else if (message.method === "session/prompt") send({ id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

const ACP_CONTROL_MOCK = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
let promptCount = 0;
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
function update(sessionId, text) {
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "hermes", version: "0.21.0" }, agentCapabilities: { loadSession: true } } });
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "hermes-session-control" } });
    else if (message.method === "session/prompt") {
      promptCount += 1;
      const text = promptCount === 1 ? "original prompt completed" : "unexpected second prompt";
      setTimeout(() => {
        update(message.params.sessionId, text);
        send({ id: message.id, result: { stopReason: "end_turn" } });
      }, promptCount === 1 ? 250 : 0);
    }
  }
});
`;

function profile(): HermesAcpProfile {
  return {
    binding: { hostId: "host-hermes-test", profileId: "profile-hermes-test", capabilityRevision: "acp-v1" },
    command: process.execPath,
    args: ["-e", ACP_MOCK],
    cwd: process.cwd(),
    providerVersion: "0.21.0",
    protocolVersion: 1,
  };
}

const HISTORY_FAKE_SESSION_DB = String.raw`
import json
from pathlib import Path

class SessionDB:
    def __init__(self, db_path=None, read_only=False):
        if not read_only:
            raise AssertionError("history reader must open SessionDB read-only")
        self.state = json.loads(Path(db_path).read_text(encoding="utf-8"))

    def get_session(self, session_id):
        return self.state.get("sessions", {}).get(session_id)

    def get_messages(self, session_id, include_inactive=False, include_compacted=False,
                     limit=None, offset=0, latest=False, after_id=None):
        rows = list(self.state.get("messages", {}).get(session_id, []))
        if after_id is not None:
            rows = [row for row in rows if row["id"] > after_id]
        if latest:
            rows.reverse()
        if limit is not None:
            rows = rows[:limit]
        if latest:
            rows.reverse()
        return rows

    def get_compression_tip(self, session_id):
        return self.state.get("tips", {}).get(session_id, session_id)

    def resolve_resume_session_id(self, session_id):
        return self.state.get("resume", {}).get(session_id, session_id)

    def close(self):
        return None
`;

const historyPythonCommand = (() => {
  try {
    return execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

const installedHermes021SourcePath = process.env.RUDDER_HERMES_021_SOURCE_PATH;
const installedHermes021PythonCommand = process.env.RUDDER_HERMES_021_PYTHON_COMMAND;
const installedHermes021Describe = installedHermes021SourcePath && installedHermes021PythonCommand ? describe : describe.skip;

const INSTALLED_HERMES_021_ROTATION_SEED = String.raw`
import os
from pathlib import Path
from hermes_cli import __version__
from hermes_state import SessionDB

assert __version__ == "0.21.0", __version__
home = Path(os.environ["HERMES_HOME"])
db = SessionDB(db_path=home / "state.db")
db.create_session(
    session_id="acp-root", source="acp", model="integration-model", model_config={},
    cwd=os.environ["RUDDER_TEST_CWD"], profile_name="rudder-temp",
)
db.append_messages_batch("acp-root", [
    {"role": "user", "content": "prior question", "timestamp": 1},
    {"role": "assistant", "content": "prior answer", "timestamp": 2, "finish_reason": "stop"},
])
db.close()
`;

const INSTALLED_HERMES_021_ROTATION_PUBLISH = String.raw`
import os
from pathlib import Path
from acp_adapter.provenance import build_session_provenance
from hermes_state import SessionDB

db = SessionDB(db_path=Path(os.environ["HERMES_HOME"]) / "state.db")
db.append_messages_batch("acp-root", [
    {"role": "user", "content": "current prompt", "timestamp": 3},
    {"role": "assistant", "content": "current answer", "timestamp": 4, "finish_reason": "stop"},
])
watermark = db.get_active_message_watermark("acp-root")
db.append_messages_batch("acp-root", [
    {"role": "tool", "tool_name": "concurrent_writer", "content": "concurrent parent tail", "timestamp": 5},
])
ceiling = db.get_active_message_watermark("acp-root")
db.publish_compression_child(
    parent_session_id="acp-root", child_session_id="acp-child", source="acp",
    model="integration-model", model_config={}, cwd=os.environ["RUDDER_TEST_CWD"],
    profile_name="rudder-temp", system_prompt="temporary prompt",
    messages=[
        {"role": "user", "content": "compacted prior-context handoff", "timestamp": 6},
        {"role": "user", "content": "current prompt", "timestamp": 7},
        {"role": "assistant", "content": "current answer", "timestamp": 8, "finish_reason": "stop"},
    ],
    watermark=watermark, watermark_ceiling=ceiling, require_compression_lease=False,
)
provenance = build_session_provenance(
    db, "acp-root", "acp-child", previous_hermes_session_id="acp-root",
)
assert provenance["acpSessionId"] == "acp-root", provenance
assert provenance["currentHermesSessionId"] == "acp-child", provenance
assert provenance["reason"] == "compression", provenance
db.close()
`;

const INSTALLED_HERMES_021_MUTATE_ROW_PAYLOAD = String.raw`
import os
from pathlib import Path
from hermes_state import SessionDB

db = SessionDB(db_path=Path(os.environ["HERMES_HOME"]) / "state.db")
db.set_latest_user_api_content("acp-child", "current prompt", "normalized api prompt")
db.close()
`;

async function installedHermes021HistoryFixture(): Promise<{
  root: string;
  profile: HermesProductHistoryProfile;
  runPython: (script: string) => void;
  cleanup: () => Promise<void>;
}> {
  if (!installedHermes021SourcePath || !installedHermes021PythonCommand) {
    throw new Error("Hermes 0.21.0 source fixture was not configured");
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-021-acp-rotation-"));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const env = {
    ...process.env,
    HERMES_HOME: home,
    PYTHONPATH: installedHermes021SourcePath,
    PYTHONDONTWRITEBYTECODE: "1",
    RUDDER_TEST_CWD: root,
  };
  const runPython = (script: string) => {
    execFileSync(installedHermes021PythonCommand!, ["-c", script], {
      cwd: installedHermes021SourcePath,
      env,
      encoding: "utf8",
    });
  };
  try {
    runPython(INSTALLED_HERMES_021_ROTATION_SEED);
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
  const profile: HermesProductHistoryProfile = {
    pythonCommand: installedHermes021PythonCommand,
    sourcePath: installedHermes021SourcePath,
    hermesHome: home,
    providerVersion: "0.21.0",
    hostId: "host-hermes-021-source-test",
    profileId: "profile-hermes-021-source-test",
  };
  return { root, profile, runPython, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function historyFixture(): Promise<{ root: string; profile: HermesAcpProfile }> {
  if (!historyPythonCommand) throw new Error("python3 is unavailable for the Hermes history fixture");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-acp-history-"));
  const sourcePath = path.join(root, "source");
  const hermesHome = path.join(root, "home");
  await fs.mkdir(sourcePath);
  await fs.mkdir(hermesHome);
  await fs.writeFile(path.join(sourcePath, "hermes_state.py"), HISTORY_FAKE_SESSION_DB, "utf8");
  await fs.writeFile(path.join(hermesHome, "state.db"), JSON.stringify({
    sessions: { "hermes-history": { id: "hermes-history", source: "acp", message_count: 2 } },
    messages: {
      "hermes-history": [
        { id: 1, session_id: "hermes-history", role: "user", content: "before", timestamp: 1, active: 1, compacted: 0 },
        { id: 2, session_id: "hermes-history", role: "assistant", content: "after", timestamp: 2, active: 1, compacted: 0 },
      ],
    },
  }), "utf8");
  return {
    root,
    profile: {
      ...profile(),
      hermesPythonCommand: historyPythonCommand,
      hermesSourcePath: sourcePath,
      hermesHome,
    },
  };
}

function sessionFrom(result: Awaited<ReturnType<typeof executeHermesNativeChat>>) {
  if (!result.sessionId || !result.sessionParams || !result.sessionDisplayId) throw new Error("native mock did not return a session");
  return { sessionId: result.sessionId, sessionParams: result.sessionParams, sessionDisplayId: result.sessionDisplayId };
}

describe("Hermes ACP native protocol", () => {
  it("preserves JSON-RPC Unicode split across pipe chunks", async () => {
    const code = String.raw`
      process.stdin.once("data", chunk => {
        const request = JSON.parse(chunk.toString());
        const wire = Buffer.from(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{text:"连续🐕"}})+"\n");
        const split = wire.indexOf(Buffer.from("连")) + 1;
        process.stdout.write(wire.subarray(0, split));
        setTimeout(() => process.stdout.write(wire.subarray(split)), 20);
      });
    `;
    const client = await createHermesNativeRpcClient({ ...profile(), args: ["-e", code] }, () => {}, async () => null);
    try { expect(await client.request("ping", {})).toEqual({ text: "连续🐕" }); }
    finally { await client.close(); }
  });

  it("kills a gateway that ignores SIGTERM after the bounded grace period", async () => {
    let pid = 0;
    const code = String.raw`
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      process.stdin.once("data", chunk => {
        const request = JSON.parse(chunk.toString());
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{ready:true}})+"\n");
      });
    `;
    const client = await createHermesNativeRpcClient({ ...profile(), args: ["-e", code] }, () => {}, async () => null,
      async (meta) => { pid = meta.pid; });
    try { await client.request("ping", {}); }
    finally { await client.close(); }
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2_000 });
  });

  it("confirms terminal quiescence and lets a second Run reuse the loaded ACP session", async () => {
    const logs: string[] = [];
    const first = await executeHermesNativeChat({
      profile: profile(),
      sessionId: null,
      sessionParams: null,
      prompt: "first prompt",
      timeoutMs: 2_000,
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });

    expect(first.exitCode).toBe(0);
    expect(first.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_terminal" });
    expect(first.summary).toBe("hello from Hermes ACP");
    expect(first.sessionId).toBe("hermes-session-new");
    expect(first.sessionParams).toMatchObject({
      transport: HERMES_ACP_NATIVE_TRANSPORT,
      acpProtocolVersion: 1,
      hermesProviderVersion: "0.21.0",
      profileHostId: "host-hermes-test",
      profileId: "profile-hermes-test",
    });
    expect(first.resultJson).toMatchObject({
      nativeSession: true,
      continuity: { native: true, lossless: true, loadReplay: false },
    });

    const resumed = await executeHermesNativeChat({
      profile: profile(),
      sessionId: first.sessionId ?? null,
      sessionParams: first.sessionParams ?? null,
      prompt: "resume prompt",
      timeoutMs: 2_000,
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });

    expect(resumed.exitCode).toBe(0);
    expect(resumed.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_terminal" });
    expect(resumed.summary).toBe("hello from Hermes ACP");
    expect(logs.join("")).toContain('"type":"hermes_acp_update"');
    expect(logs.join("")).not.toContain('"text":"replayed"');
    expect(resumed.sessionId).toBe("hermes-session-new");
    expect(resumed.resultJson).toMatchObject({ continuity: { loadReplay: true } });
    expect(logs.join("")).toContain("Hermes ACP native session started session=hermes-session-new");
  });

  it("fails closed on interleaved ACP rows and hashes the selected row locators and payloads", async () => {
    const fixture = await historyFixture();
    try {
      const result = await executeHermesNativeChat({
        profile: { ...fixture.profile, args: ["-e", ACP_HISTORY_MOCK] },
        sessionId: null,
        sessionParams: null,
        prompt: "exactly bounded input",
        timeoutMs: 2_000,
        onLog: async () => {},
      });
      const boundary = result.resultJson?.transcriptBoundary as Record<string, unknown> | undefined;

      expect(result.exitCode).toBe(0);
      expect(result.resultJson).not.toHaveProperty("providerTurnId");
      expect(boundary).toMatchObject({ status: "unknown", sessionId: "hermes-history", sourceRangeRef: null });
      expect(boundary?.reason).toContain("no prompt-scoped locator");
      expect(boundary?.reason).toContain("interleaved foreign rows");
      const sourceRangeRef = JSON.stringify({
        version: 1,
        status: "exact",
        sessionId: "hermes-history",
        startExclusive: 2,
        endInclusive: 6,
      });

      const transcript = await readHermesAcpNativeTranscript({
        runtimeType: "hermes_gateway",
        profile: fixture.profile,
        session: sessionFrom(result),
        selector: { kind: "hermes_execution", sourceRangeRef },
      });
      expect(transcript).toMatchObject({
        availability: "available",
        completeness: "unknown",
        revision: expect.stringContaining("execution-ownership-unproven:"),
        items: [],
      });
      const repeat = await readHermesAcpNativeTranscript({
        runtimeType: "hermes_gateway",
        profile: fixture.profile,
        session: sessionFrom(result),
        selector: { kind: "hermes_execution", sourceRangeRef },
      });
      expect(repeat.revision).toBe(transcript.revision);

      const hermesHome = fixture.profile.hermesHome;
      if (!hermesHome) throw new Error("Hermes history fixture is missing its temporary home");
      const databasePath = path.join(hermesHome, "state.db");
      const database = JSON.parse(await fs.readFile(databasePath, "utf8"));
      const promptRow = database.messages["hermes-history"].find((row: Record<string, unknown>) => row.id === 4);
      if (!promptRow) throw new Error("Hermes history fixture prompt row is missing");
      promptRow.api_content = "changed provider payload";
      await fs.writeFile(databasePath, JSON.stringify(database), "utf8");

      const changed = await readHermesAcpNativeTranscript({
        runtimeType: "hermes_gateway",
        profile: fixture.profile,
        session: sessionFrom(result),
        selector: { kind: "hermes_execution", sourceRangeRef },
      });
      expect(changed.revision).not.toBe(transcript.revision);

      database.messages["hermes-history"].push({
        id: 7,
        session_id: "hermes-history",
        role: "assistant",
        content: "outside the selected range",
        timestamp: 5,
        active: 1,
        compacted: 0,
      });
      await fs.writeFile(databasePath, JSON.stringify(database), "utf8");
      const withUnrelatedTail = await readHermesAcpNativeTranscript({
        runtimeType: "hermes_gateway",
        profile: fixture.profile,
        session: sessionFrom(result),
        selector: { kind: "hermes_execution", sourceRangeRef },
      });
      expect(withUnrelatedTail.revision).toBe(changed.revision);

      const withCursor = await readHermesAcpNativeTranscript({
        runtimeType: "hermes_gateway",
        profile: fixture.profile,
        session: sessionFrom(result),
        selector: { kind: "hermes_execution", sourceRangeRef },
        cursor: "unexpected-cursor",
      });
      expect(withCursor).toMatchObject({
        items: [],
        nextCursor: null,
        revision: "execution-cursor-unsupported",
        completeness: "unknown",
      });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when an exact execution range exceeds its bounded payload revision", async () => {
    const fixture = await historyFixture();
    try {
      const hermesHome = fixture.profile.hermesHome;
      if (!hermesHome) throw new Error("Hermes history fixture is missing its temporary home");
      const databasePath = path.join(hermesHome, "state.db");
      const database = JSON.parse(await fs.readFile(databasePath, "utf8"));
      database.messages["hermes-history"] = Array.from({ length: 201 }, (_, index) => ({
        id: index + 3,
        session_id: "hermes-history",
        role: index === 200 ? "assistant" : "tool",
        content: `bounded row ${index}`,
        timestamp: index + 3,
        active: 1,
        compacted: 0,
      }));
      await fs.writeFile(databasePath, JSON.stringify(database), "utf8");

      const result = await readHermesAcpNativeTranscript({
        runtimeType: "hermes_gateway",
        profile: fixture.profile,
        session: { sessionId: "hermes-history", sessionParams: {}, sessionDisplayId: "hermes-history" },
        selector: {
          kind: "hermes_execution",
          sourceRangeRef: JSON.stringify({
            version: 1,
            status: "exact",
            sessionId: "hermes-history",
            startExclusive: 2,
            endInclusive: 203,
          }),
        },
      });

      expect(result).toMatchObject({
        items: [],
        nextCursor: null,
        revision: "execution-range-too-large",
        availability: "available",
        completeness: "unknown",
      });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("authenticates with the explicitly bound ACP method and persists that identity", async () => {
    const result = await executeHermesNativeChat({
      profile: { ...profile(), authMethodId: "hermes-test-auth" },
      sessionId: null,
      sessionParams: null,
      prompt: "authenticated prompt",
      timeoutMs: 2_000,
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toMatchObject({ acpAuthMethodId: "hermes-test-auth" });
  });

  it("does not translate ACP steer into a queued second session/prompt", async () => {
    let publishHandle!: (handle: AgentRuntimeControlHandle) => void;
    const handleReady = new Promise<AgentRuntimeControlHandle>((resolve) => { publishHandle = resolve; });
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
    const controlAttempt: AgentRuntimeControlAttemptLease = {
      attemptEpoch: 1,
      ownerToken: "hermes-control-test",
      async register(handle) {
        publishHandle(handle);
        return { isCurrent: () => true, release: async () => {} };
      },
      async complete() {},
    };

    const execution = executeHermesNativeChat({
      profile: { ...profile(), args: ["-e", ACP_CONTROL_MOCK] },
      sessionId: null,
      sessionParams: null,
      prompt: "original prompt",
      timeoutMs: 2_000,
      controlAttempt,
      onLog: async (_stream, chunk) => {
        if (chunk.includes("Hermes ACP native session started")) markPromptStarted();
      },
    });
    const handle = await handleReady;
    await promptStarted;

    await expect(handle.steer({ text: "steer input", clientMessageId: "message-1" })).resolves.toMatchObject({
      disposition: "unsupported",
      reason: expect.stringContaining("queued as a follow-up"),
    });
    const result = await execution;

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("original prompt completed");
  });

  it("does not treat an ACP provider error update as a successful end_turn", async () => {
    const result = await executeHermesNativeChat({
      profile: { ...profile(), args: ["-e", ACP_PROVIDER_ERROR_MOCK] },
      sessionId: null,
      sessionParams: null,
      prompt: "provider error",
      timeoutMs: 2_000,
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "hermes_native_provider_error",
      errorMessage: "Hermes ACP provider returned an error response.",
      resultJson: { providerError: true },
    });
    expect(result.nativeWriterQuiescence).toBeUndefined();
  });

  it("classifies the Hermes 0.21.0 non-retryable subscription HTTP 403 diagnostic and retains session history evidence", async () => {
    const result = await executeHermesNativeChat({
      profile: { ...profile(), args: ["-e", ACP_PROVIDER_HTTP_403_UPDATE_MOCK] },
      sessionId: null,
      sessionParams: null,
      prompt: "provider HTTP 403",
      timeoutMs: 2_000,
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "hermes_native_provider_error",
      sessionId: "hermes-session-http-403-update",
      sessionParams: { sessionId: "hermes-session-http-403-update" },
      resultJson: {
        providerError: true,
        providerHttpStatus: 403,
        transcriptBoundary: { sessionId: "hermes-session-http-403-update" },
        updateCount: 1,
      },
    });
    expect(result.nativeWriterQuiescence).toBeUndefined();
  });

  it("does not classify a valid assistant answer that mentions a subscription requirement as a provider error", async () => {
    const result = await executeHermesNativeChat({
      profile: { ...profile(), args: ["-e", ACP_SUBSCRIPTION_ANSWER_MOCK] },
      sessionId: null,
      sessionParams: null,
      prompt: "explain subscription wording",
      timeoutMs: 2_000,
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: 0,
      summary: "The documentation explains what subscription required means for this account; the requested configuration is valid.",
      resultJson: { stopReason: "end_turn", providerError: false },
    });
    expect(result.errorCode).toBeUndefined();
    expect(result.resultJson).not.toHaveProperty("providerHttpStatus");
  });

  it("retains session history evidence when session/prompt returns a provider HTTP 403 RPC error", async () => {
    const result = await executeHermesNativeChat({
      profile: { ...profile(), args: ["-e", ACP_PROVIDER_HTTP_403_RPC_MOCK] },
      sessionId: null,
      sessionParams: null,
      prompt: "provider HTTP 403",
      timeoutMs: 2_000,
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "hermes_native_provider_error",
      sessionId: "hermes-session-http-403-rpc",
      sessionParams: { sessionId: "hermes-session-http-403-rpc" },
      resultJson: {
        stopReason: "error",
        providerError: true,
        providerHttpStatus: 403,
        promptFailure: { rpcCode: -32000 },
        transcriptBoundary: { sessionId: "hermes-session-http-403-rpc" },
      },
    });
    expect(result.nativeWriterQuiescence).toBeUndefined();
  });

  it("rejects end_turn without assistant output instead of completing an empty transcript", async () => {
    const result = await executeHermesNativeChat({
      profile: { ...profile(), args: ["-e", ACP_EMPTY_END_TURN_MOCK] },
      sessionId: null,
      sessionParams: null,
      prompt: "empty answer",
      timeoutMs: 2_000,
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "hermes_native_empty_response",
      errorMessage: "Hermes ACP prompt ended without assistant output.",
      sessionId: "hermes-session-empty-end-turn",
      sessionParams: { sessionId: "hermes-session-empty-end-turn" },
      resultJson: {
        stopReason: "end_turn",
        providerError: false,
        emptyResponse: true,
        updateCount: 0,
        transcriptBoundary: { sessionId: "hermes-session-empty-end-turn" },
      },
    });
    expect(result.nativeWriterQuiescence).toBeUndefined();
  });

  it("uses the provider-native fork method without treating ACP notifications as persisted history", async () => {
    const initial = await executeHermesNativeChat({
      profile: profile(),
      sessionId: null,
      sessionParams: null,
      prompt: "seed",
      timeoutMs: 2_000,
      onLog: async () => {},
    });
    const session = sessionFrom(initial);
    await expect(forkHermesAcpNativeSession({
      runtimeType: "hermes_gateway", profile: profile(), session,
      boundary: "hermes-update-boundary",
    })).rejects.toThrow("historical message boundary");
    const forked = await forkHermesAcpNativeSession({
      runtimeType: "hermes_gateway",
      profile: profile(),
      session,
      boundary: "head",
    });

    expect(forked).toMatchObject({
      continuity: "native",
      sourceBoundary: "head",
      session: { sessionId: "hermes-session-fork", sessionParams: { transport: HERMES_ACP_NATIVE_TRANSPORT } },
    });

    const transcript = await readHermesAcpNativeTranscript({
      runtimeType: "hermes_gateway",
      profile: profile(),
      session,
    });
    expect(transcript).toMatchObject({ availability: "missing", completeness: "unknown", source: "native" });
    expect(transcript.items).toEqual([]);
  });

  it("does not expose an ACP row range as Run-owned without prompt-scoped provenance", async () => {
    if (!historyPythonCommand) return;
    const fixture = await historyFixture();
    try {
      const transcript = await readHermesAcpNativeTranscript({
        runtimeType: "hermes_gateway",
        profile: fixture.profile,
        session: {
          sessionId: "hermes-history",
          sessionDisplayId: "hermes-history",
          sessionParams: { transport: HERMES_ACP_NATIVE_TRANSPORT },
        },
        selector: {
          kind: "hermes_execution",
          sourceRangeRef: JSON.stringify({ version: 1, status: "exact", sessionId: "hermes-history", startExclusive: 1, endInclusive: 2 }),
        },
      });
      expect(transcript).toMatchObject({
        availability: "available",
        completeness: "unknown",
        revision: expect.stringContaining("execution-ownership-unproven:"),
        items: [],
        source: "native",
      });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not claim an exact boundary when Hermes compression rotates the session", () => {
    const boundary = deriveHermesAcpTranscriptBoundary({
      sessionId: "session-old",
      historyProfileAvailable: true,
      before: { availability: "available", tailRowId: 10, relation: "none", successorSessionId: null },
      after: { availability: "available", tailRowId: 3, relation: "compression", successorSessionId: "session-tip" },
    });
    expect(boundary).toMatchObject({ status: "unknown", sourceRangeRef: null });
    expect(boundary.reason).toContain("compacted handoff");
    expect(boundary.reason).toContain("concurrent parent-tail rows");
    expect(boundary.reason).toContain("no source-row locators");
    expect(boundary.reason).toContain("no per-prompt Run watermark");
  });

  installedHermes021Describe("installed Hermes 0.21.0 ACP compression history", () => {
    it("keeps a cross-generation Run boundary unknown when SessionDB publishes a compacted child and clones a concurrent tail", async () => {
      const fixture = await installedHermes021HistoryFixture();
      const read = (sessionId: string) => readHermesProductHistory({
        runtimeType: "hermes_gateway",
        sessionId,
        profile: fixture.profile,
        limit: 100,
      });

      try {
        const before = await read("acp-root");
        fixture.runPython(INSTALLED_HERMES_021_ROTATION_PUBLISH);
        const after = await read("acp-root");
        expect(before.metadata.tailRowId).toBeTypeOf("number");
        expect(after.metadata.lineage).toMatchObject({
          relation: "compression",
          successorSessionId: "acp-child",
        });
        expect(after.metadata.successor).toMatchObject({ id: "acp-child", parentSessionId: "acp-root" });

        const boundary = deriveHermesAcpTranscriptBoundary({
          sessionId: "acp-root",
          historyProfileAvailable: true,
          before: {
            availability: before.availability,
            tailRowId: before.metadata.tailRowId,
            relation: before.metadata.lineage.relation,
            successorSessionId: before.metadata.lineage.successorSessionId,
          },
          after: {
            availability: after.availability,
            tailRowId: after.metadata.tailRowId,
            relation: after.metadata.lineage.relation,
            successorSessionId: after.metadata.lineage.successorSessionId,
          },
        });
        expect(boundary).toMatchObject({ status: "unknown", sourceRangeRef: null });
        expect(boundary.reason).toContain("no source-row locators");
        expect(boundary.reason).toContain("no per-prompt Run watermark");

        const parentRows = await read("acp-root");
        const childBefore = await read("acp-child");
        expect(parentRows.items.map((item) => item.text)).toContain("concurrent parent tail");
        expect(childBefore.items.map((item) => item.text)).toEqual([
          "compacted prior-context handoff",
          "current prompt",
          "current answer",
          "concurrent parent tail",
        ]);
        expect(childBefore.metadata.session).toMatchObject({ parentSessionId: "acp-root" });
        expect(childBefore.metadata.tailRowId).toBeGreaterThan(after.metadata.tailRowId!);
        const parentTailCopy = parentRows.items.find((item) => item.text === "concurrent parent tail");
        const childTailCopy = childBefore.items.find((item) => item.text === "concurrent parent tail");
        expect(childTailCopy?.sourceEntryId).not.toBe(parentTailCopy?.sourceEntryId);
        const cloneComparable = (row: Record<string, unknown>) => Object.fromEntries(
          Object.entries(row).filter(([key]) => !["id", "session_id", "active", "compacted"].includes(key)),
        );
        expect(cloneComparable(childTailCopy!.raw)).toEqual(cloneComparable(parentTailCopy!.raw));

        fixture.runPython(INSTALLED_HERMES_021_MUTATE_ROW_PAYLOAD);
        const childAfter = await read("acp-child");
        expect(childAfter.revision).toBe(childBefore.revision);
        expect(childAfter.items.find((item) => item.text === "current prompt")?.entry.apiContent)
          .toBe("normalized api prompt");
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("rejects a missing session/load result instead of silently prompting a new session", async () => {
    const first = await executeHermesNativeChat({
      profile: { ...profile(), args: ["-e", ACP_MISSING_LOAD_MOCK] },
      sessionId: null,
      sessionParams: null,
      prompt: "seed",
      timeoutMs: 2_000,
      onLog: async () => {},
    });

    await expect(executeHermesNativeChat({
      profile: { ...profile(), args: ["-e", ACP_MISSING_LOAD_MOCK] },
      sessionId: first.sessionId ?? null,
      sessionParams: first.sessionParams ?? null,
      prompt: "must not run",
      timeoutMs: 2_000,
      onLog: async () => {},
    })).rejects.toMatchObject({
      name: "HermesAcpNativeCapabilityError",
      status: "unsupported",
    });
  });

  it("sends session/cancel and reports a cancelled prompt without leaving the child owned", async () => {
    const controller = new AbortController();
    const resultPromise = executeHermesNativeChat({
      profile: profile(),
      sessionId: null,
      sessionParams: null,
      prompt: "cancel me",
      timeoutMs: 2_000,
      signal: controller.signal,
      onLog: async () => {},
    });
    controller.abort();
    const result = await resultPromise;

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_native_cancelled");
    expect(result.signal).toBe("SIGTERM");
    expect(result.nativeWriterQuiescence).toBeUndefined();
  });
});
