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
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Error: provider credentials unavailable" } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
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

  it("runs initialize/new/prompt, persists identity, and resumes through session/load", async () => {
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
    expect(resumed.summary).toBe("hello from Hermes ACP");
    expect(logs.join("")).toContain('"type":"hermes_acp_update"');
    expect(logs.join("")).not.toContain('"text":"replayed"');
    expect(resumed.sessionId).toBe("hermes-session-new");
    expect(resumed.resultJson).toMatchObject({ continuity: { loadReplay: true } });
    expect(logs.join("")).toContain("Hermes ACP native session started session=hermes-session-new");
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

  it("reads an exact ACP Run row range through the host-authorized Hermes product history reader", async () => {
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
      expect(transcript).toMatchObject({ availability: "available", completeness: "complete", source: "native" });
      expect(transcript.items.map((item) => item.sourceEntryId)).toEqual(["2"]);
      expect(transcript.items[0]?.text).toBe("after");
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
    expect(boundary.reason).toContain("successor");
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
  });
});
