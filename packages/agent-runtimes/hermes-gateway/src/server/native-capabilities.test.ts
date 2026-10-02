import type { AgentRuntimeControlHandle } from "@rudderhq/agent-runtime-utils";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHermesAcpProviderCapabilities,
  createHermesAcpProviderCapabilityResolver,
  createHermesGatewayProviderCapabilities,
  createHermesGatewayProviderCapabilityResolver,
  type HermesGatewayProfileTransport,
  type HermesNativeTranscriptReadRequest,
} from "./native-capabilities.js";
import * as nativeProtocol from "./native-protocol.js";
import * as productRpc from "./product-rpc.js";
import {
  buildHermesProductRpcSessionParams,
  HERMES_PRODUCT_RPC_TRANSPORT,
  type HermesProductRpcProfile,
} from "./product-rpc.js";

// Exercise the server consumer without pulling server sources into this package's tsc rootDir.
const driverModulePath = "../../../../../server/src/services/runtime-kernel/runtime-driver.js";
const capabilityModulePath = "../../../../../server/src/services/runtime-kernel/provider-capabilities.js";

const binding = {
  hostId: "host-hermes-1",
  profileId: "profile-hermes-1",
  capabilityRevision: "hermes-api-v1",
};

describe("Hermes profile resolver to public Runtime Driver fork", () => {
  async function driverFor(profile: Parameters<typeof createHermesAcpProviderCapabilities>[0], unknownFork = false) {
    const { createRuntimeDriver } = await import(driverModulePath);
    const { createProfileBoundRuntimeProviderCapabilityResolver } = await import(capabilityModulePath);
    return createRuntimeDriver("hermes_gateway", {
      providerBinding: binding,
      providerCapabilityResolver: createProfileBoundRuntimeProviderCapabilityResolver({
        hermes_gateway: (runtimeType: string, requestedBinding: typeof binding) => {
          const adapter = createHermesAcpProviderCapabilityResolver(() => profile)(runtimeType, requestedBinding);
          // Isolate the driver's UNKNOWN gate while retaining actual profile resolution and helper wiring.
          if (adapter && unknownFork) adapter.fork.evidence = { ...adapter.fork.evidence, status: "unknown" };
          return adapter;
        },
      }),
    });
  }

  const profile = {
    binding,
    command: process.execPath,
    args: ["-e", ""],
    cwd: "/fixture/hermes-workspace",
    providerVersion: "0.21.0",
    protocolVersion: 1,
    hermesPythonCommand: "/fixture/python",
    hermesSourcePath: "/fixture/hermes-source",
    hermesHome: "/fixture/hermes-home",
  };
  const session = {
    sessionId: "historical-parent",
    sessionDisplayId: "historical-parent",
    sessionParams: { transport: HERMES_PRODUCT_RPC_TRANSPORT },
  };

  it("forwards exact historical boundary, parent binding and signal to the Product fork helper", async () => {
    const child = {
      session: { ...session, sessionId: "independent-child", sessionDisplayId: "independent-child" },
      boundary: "hermes:db:independent-child:7",
      sourceBoundary: "hermes:db:historical-parent:7",
      identityMap: { "hermes:db:historical-parent:7": "hermes:db:independent-child:7" },
      continuity: "native" as const,
    };
    const helper = vi.spyOn(productRpc, "forkHermesProductRpcNativeSession").mockResolvedValue(child);
    try {
      const driver = await driverFor(profile);
      const signal = new AbortController().signal;
      expect(driver.capabilities.fork.status).toBe("supported");
      await expect(driver.fork({ session, boundary: child.sourceBoundary, binding, signal }))
        .resolves.toEqual({ status: "supported", value: child });
      expect(helper).toHaveBeenCalledTimes(1);
      expect(helper).toHaveBeenCalledWith({
        runtimeType: "hermes_gateway", profile, session,
        boundary: child.sourceBoundary, binding, signal, workspace: null,
      });
      expect(helper.mock.calls[0]?.[0].signal).toBe(signal);
      expect(helper.mock.calls[0]?.[0].session).toBe(session);
    } finally {
      helper.mockRestore();
    }
  });

  it.each(["unsupported", "unknown"] as const)("does not invoke a helper for %s fork evidence", async (status) => {
    const helper = vi.spyOn(productRpc, "forkHermesProductRpcNativeSession")
      .mockRejectedValue(new Error("unexpected Product helper dispatch"));
    const acpHelper = vi.spyOn(nativeProtocol, "forkHermesAcpNativeSession")
      .mockRejectedValue(new Error("unexpected ACP helper dispatch"));
    try {
      const driver = await driverFor(status === "unsupported"
        ? { ...profile, hermesPythonCommand: undefined, hermesSourcePath: undefined, hermesHome: undefined }
        : profile, status === "unknown");
      expect(driver.capabilities.fork.status).toBe(status);
      await expect(driver.fork({ session, boundary: "hermes:db:historical-parent:7", binding }))
        .resolves.toMatchObject({ status, capability: "fork" });
      expect(helper).not.toHaveBeenCalled();
      expect(acpHelper).not.toHaveBeenCalled();
    } finally {
      helper.mockRestore();
      acpHelper.mockRestore();
    }
  });
});

function request(overrides: Partial<HermesNativeTranscriptReadRequest> = {}): HermesNativeTranscriptReadRequest {
  return {
    runtimeType: "hermes_gateway",
    binding,
    session: {
      sessionId: "hermes-session-1",
      sessionDisplayId: "hermes-session-1",
      sessionParams: {
        sessionId: "hermes-session-1",
        hermesSessionId: "hermes-session-1",
        hermesBaseUrl: "http://127.0.0.1:43121",
        hermesTransport: "hermes-http-sse",
        hermesProviderVersion: "0.19.1",
        profileHostId: binding.hostId,
        profileId: binding.profileId,
        capabilityRevision: binding.capabilityRevision,
      },
    },
    ...overrides,
  };
}

function profile(fetch: NonNullable<HermesGatewayProfileTransport["fetch"]>): HermesGatewayProfileTransport {
  return {
    binding,
    baseUrl: "http://127.0.0.1:43121",
    providerVersion: "0.19.1",
    apiKey: "secret-hermes-key",
    fetch,
  };
}

const HISTORY_FAKE_SESSION_DB = String.raw`
import json
from pathlib import Path
from contextlib import contextmanager

class SessionDB:
    def __init__(self, db_path=None, read_only=False):
        if not read_only:
            raise AssertionError("history reader must open SessionDB read-only")
        self.state = json.loads(Path(db_path).read_text(encoding="utf-8"))

    def _read_ctx(self):
        import sqlite3
        @contextmanager
        def context():
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            sessions = list(self.state.get("sessions", {}).values())
            messages = [row for rows in self.state.get("messages", {}).values() for row in rows]
            for table, rows, required in [
                ("sessions", sessions, ["id","source","parent_session_id","profile_name","cwd","started_at","ended_at","end_reason","message_count","tool_call_count"]),
                ("messages", messages, ["id","session_id","role","content"])]:
                columns = list(dict.fromkeys(required + [key for row in rows for key in row]))
                conn.execute("CREATE TABLE " + table + " (" + ",".join('"' + col + '"' for col in columns) + ")")
                for row in rows:
                    values = [json.dumps(row.get(col), ensure_ascii=False) if isinstance(row.get(col), (dict,list)) else row.get(col) for col in columns]
                    conn.execute("INSERT INTO " + table + " VALUES (" + ",".join("?" for _ in columns) + ")", values)
            conn.commit()
            try:
                yield conn
            finally:
                conn.close()
        return context()

    def _row_to_message_dict(self, row, **kwargs):
        result = dict(row)
        for key in ["content", "tool_calls", "display_metadata"]:
            if isinstance(result.get(key), str):
                try:
                    result[key] = json.loads(result[key])
                except ValueError:
                    pass
        return result

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

    def get_compression_lineage(self, session_id):
        return self.state.get("compression_lineage", {}).get(session_id, [session_id])

    def close(self):
        return None
`;

const HERMES_ACP_021_SUBSCRIPTION_403_FIXTURE = {
  providerVersion: "0.21.0",
  providerError: true,
  providerHttpStatus: 403,
  sessionId: "hermes-session-http-403",
  rows: [
    { id: 1, role: "user", content: "provider HTTP 403", timestamp: 1, active: 1, compacted: 0 },
  ],
};

const historyPythonCommand = (() => {
  try {
    return execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

const historyRoots: string[] = [];

async function historyFixture(options: {
  sessionId?: string;
  providerVersion?: string;
  rows?: Array<Record<string, unknown>>;
} = {}): Promise<{
  root: string;
  profile: HermesGatewayProfileTransport;
  sessionId: string;
}> {
  if (!historyPythonCommand) throw new Error("python3 is unavailable for the Hermes history fixture");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-native-reader-"));
  historyRoots.push(root);
  const sessionId = options.sessionId ?? "same-session";
  const rows: Array<Record<string, unknown>> = options.rows ?? [
    { role: "user", content: "before", timestamp: 1 },
    { role: "assistant", content: "run one", timestamp: 2 },
    { role: "assistant", content: "run two", timestamp: 3 },
  ].map((row, index) => ({ ...row, id: index + 1 }));
  const sourcePath = path.join(root, "source");
  const hermesHome = path.join(root, "home");
  await fs.mkdir(sourcePath);
  await fs.mkdir(hermesHome);
  await fs.mkdir(path.join(sourcePath, "tui_gateway"));
  await fs.writeFile(path.join(sourcePath, "hermes_state.py"), HISTORY_FAKE_SESSION_DB, "utf8");
  await fs.writeFile(path.join(sourcePath, "tui_gateway", "entry.py"), "# test fixture\n", "utf8");
  await fs.writeFile(path.join(hermesHome, "state.db"), JSON.stringify({
    sessions: {
      [sessionId]: { id: sessionId, source: "acp", message_count: rows.length },
    },
    messages: {
      [sessionId]: rows.map((row) => ({
        ...row,
        session_id: sessionId,
        active: row.active ?? 1,
        compacted: row.compacted ?? 0,
      })),
    },
  }), "utf8");
  return {
    root,
    profile: {
      binding,
      baseUrl: "http://127.0.0.1:43121",
      providerVersion: options.providerVersion ?? "0.19.1",
      apiKey: "secret-hermes-key",
      pythonCommand: historyPythonCommand,
      sourcePath,
      hermesHome,
      fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    },
    sessionId,
  };
}

function acpHistoryProfile(fixture: Awaited<ReturnType<typeof historyFixture>>): HermesProductRpcProfile {
  const { pythonCommand, sourcePath, hermesHome } = fixture.profile;
  if (!pythonCommand || !sourcePath || !hermesHome) {
    throw new Error("Hermes history fixture requires explicit provider paths");
  }
  return {
    binding,
    command: process.execPath,
    args: ["-e", ""],
    cwd: fixture.root,
    providerVersion: fixture.profile.providerVersion,
    protocolVersion: 1,
    hermesPythonCommand: pythonCommand,
    hermesSourcePath: sourcePath,
    hermesHome,
  };
}

function acpReadRequest(
  sessionId: string,
  selector?: Record<string, unknown>,
): HermesNativeTranscriptReadRequest {
  return request({
    session: {
      ...request().session,
      sessionId,
      sessionDisplayId: sessionId,
      sessionParams: {
        transport: "hermes-acp-stdio",
        sessionId,
        hermesSessionId: sessionId,
        hermesProviderVersion: "0.21.0",
        profileHostId: binding.hostId,
        profileId: binding.profileId,
        capabilityRevision: binding.capabilityRevision,
      },
    },
    ...(selector ? { selector } : {}),
  });
}

function persistedHermesReaderInput(
  sessionId: string,
  selector: Record<string, unknown>,
  segment: { state: "open" | "sealed" | "pending" | "superseded"; sealedAt: string | null } = {
    state: "sealed",
    sealedAt: "2026-09-29T00:00:00.000Z",
  },
  writerLeaseReleasedAt: string | null = "2026-09-29T00:00:00.000Z",
) {
  const orgId = "org-hermes-reader-test";
  const runId = "run-hermes-reader-test";
  const bindingId = "binding-hermes-reader-test";
  const segmentId = "segment-hermes-reader-test";
  const spanId = "span-hermes-reader-test";
  return {
    readonly: true,
    scope: "run",
    orgId,
    principal: { orgId, authorized: true },
    run: {
      id: runId,
      orgId,
      sessionIdBefore: null,
      sessionIdAfter: sessionId,
      sessionReuseScope: "none",
      sessionIntentJson: {
        kind: "fresh",
        reuseScope: "none",
        sourceRunId: null,
        sessionId: null,
        sessionParams: null,
      },
    },
    binding: { id: bindingId, orgId, runtimeType: "hermes_gateway", ...binding },
    segment: {
      id: segmentId,
      orgId,
      bindingId,
      runtimeType: "hermes_gateway",
      nativeSessionId: sessionId,
      state: segment.state,
      sealedAt: segment.sealedAt,
    },
    span: {
      id: spanId,
      orgId,
      runId,
      bindingId,
      segmentId,
      state: "sealed",
      completeness: "complete",
      closedAt: "2026-09-29T00:00:00.000Z",
      writerLeaseReleasedAt,
      selectorJson: selector,
    },
    selector,
    cursor: null,
  };
}

function exactAcpRunSelector(sessionId: string, endInclusive: number) {
  return {
    kind: "hermes_execution",
    providerExecutionRef: "run-http-403",
    sourceRangeRef: JSON.stringify({
      version: 1,
      status: "exact",
      sessionId,
      startExclusive: null,
      endInclusive,
    }),
  };
}

afterEach(async () => {
  await Promise.all(historyRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Hermes profile-bound native capabilities", () => {
  it("does not fall back to whole-session HTTP history for an unproven Reader span", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const adapter = createHermesGatewayProviderCapabilities(profile(fetch));

    const result = await adapter.transcript.readRange(request({ readerInput: { readonly: true, scope: "run" } }));

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      availability: "available",
      completeness: "unknown",
      revision: "execution-proof-unavailable:reader-selector-missing",
      items: [],
    });
  });

  it("routes the unified Reader through the host-authorized product history source", async () => {
    if (!historyPythonCommand) return;
    const fixture = await historyFixture();
    const fetch = async () => {
      throw new Error("profile-bound product history must not fall back to HTTP");
    };
    const adapter = createHermesGatewayProviderCapabilities({ ...fixture.profile, fetch });
    const selector = {
      kind: "hermes_execution",
      sessionRef: fixture.sessionId,
      providerExecutionRef: "run-1",
      sourceRangeRef: JSON.stringify({
        version: 1,
        status: "exact",
        sessionId: fixture.sessionId,
        startExclusive: null,
        endInclusive: 2,
      }),
    };
    const readerBinding = { ...binding, id: "binding-hermes-reader-test", orgId: "org-hermes-reader-test" };
    const readerSession = {
      ...request().session,
      sessionId: fixture.sessionId,
      sessionDisplayId: fixture.sessionId,
      sessionParams: {
        ...request().session.sessionParams,
        hermesSessionId: fixture.sessionId,
        pythonCommand: "/attacker/python",
        sourcePath: "/attacker/source",
        hermesHome: "/attacker/home",
      },
    };
    const readerInput = persistedHermesReaderInput(fixture.sessionId, selector);

    const result = await adapter.transcript.readRange(request({ binding: readerBinding, session: readerSession, selector, readerInput }));
    const bounded = await adapter.transcript.readRange(request({
      binding: readerBinding,
      session: readerSession,
      selector,
      readerInput: { ...readerInput, maxBytes: 4096, maxItemBytes: 1 },
    }));
    const unproven = await adapter.transcript.readRange(request({ selector }));
    const mismatched = await adapter.transcript.readRange(request({
      binding: readerBinding,
      session: readerSession,
      selector,
      readerInput: { ...readerInput, span: { ...readerInput.span, runId: "another-run" } },
    }));

    expect(adapter.transcript.evidence).toMatchObject({
      status: "supported",
      transport: "hermes-session-db-read-only",
      profileBound: true,
    });
    expect(result).toMatchObject({
      source: "native",
      availability: "available",
      completeness: "complete",
      revision: expect.stringMatching(/^execution-span:/),
    });
    expect(result.items.map((item) => item.payload.rowId)).toEqual([1, 2]);
    expect(bounded).toMatchObject({ items: [], nextCursor: null, completeness: "partial", limitReached: { reason: "item_bytes", maximum: 1 } });
    expect(unproven).toMatchObject({ availability: "available", completeness: "unknown", revision: "execution-proof-unavailable:reader-input-missing", items: [] });
    expect(mismatched).toMatchObject({ availability: "available", completeness: "unknown", revision: "execution-proof-unavailable:reader-run-span", items: [] });
  });

  it("invalidates a Unified Reader continuation when an existing Hermes row changes", async () => {
    const fixture = await historyFixture({
      rows: Array.from({ length: 101 }, (_, index) => ({
        id: index + 1,
        role: index % 2 ? "assistant" : "user",
        content: `history row ${index + 1}`,
        timestamp: index + 1,
      })),
    });
    const adapter = createHermesGatewayProviderCapabilities(fixture.profile);
    const readRequest = request({
      session: {
        ...request().session,
        sessionId: fixture.sessionId,
        sessionDisplayId: fixture.sessionId,
        sessionParams: {
          ...request().session.sessionParams,
          hermesSessionId: fixture.sessionId,
        },
      },
    });

    const first = await adapter.transcript.readRange(readRequest);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();

    const databasePath = path.join(fixture.profile.hermesHome!, "state.db");
    const database = JSON.parse(await fs.readFile(databasePath, "utf8"));
    database.messages[fixture.sessionId][0].content = "mutated after the first page";
    await fs.writeFile(databasePath, JSON.stringify(database), "utf8");

    const continuation = await adapter.transcript.readRange({ ...readRequest, cursor: first.nextCursor });
    expect(continuation).toMatchObject({
      items: [],
      nextCursor: null,
      availability: "offline",
      completeness: "unknown",
      revision: "history-error:cursor_snapshot_mismatch",
    });
  });

  it("keeps a same-session Run without an exact boundary unknown instead of reading the whole session", async () => {
    if (!historyPythonCommand) return;
    const fixture = await historyFixture();
    const adapter = createHermesGatewayProviderCapabilities(fixture.profile);

    const result = await adapter.transcript.readRange(request({
      session: {
        ...request().session,
        sessionId: fixture.sessionId,
        sessionDisplayId: fixture.sessionId,
        sessionParams: { ...request().session.sessionParams, hermesSessionId: fixture.sessionId },
      },
      selector: { kind: "hermes_execution", providerExecutionRef: "run-1" },
    }));

    expect(result).toMatchObject({
      availability: "available",
      completeness: "unknown",
      revision: "execution-proof-unavailable:reader-input-missing",
      items: [],
    });
  });

  it("keeps an unknown boundary for a second Run in the same session unknown", async () => {
    if (!historyPythonCommand) return;
    const fixture = await historyFixture();
    const adapter = createHermesGatewayProviderCapabilities(fixture.profile);

    const result = await adapter.transcript.readRange(request({
      session: {
        ...request().session,
        sessionId: fixture.sessionId,
        sessionDisplayId: fixture.sessionId,
        sessionParams: { ...request().session.sessionParams, hermesSessionId: fixture.sessionId },
      },
      selector: {
        kind: "hermes_execution",
        providerExecutionRef: "run-2",
        sourceRangeRef: JSON.stringify({
          version: 1,
          status: "unknown",
          sessionId: fixture.sessionId,
          startExclusive: null,
          endInclusive: null,
        }),
      },
    }));

    expect(result).toMatchObject({
      availability: "available",
      completeness: "unknown",
      revision: expect.stringContaining("execution-proof-unavailable:"),
      items: [],
    });
  });

  it("reads the confirmed Sessions API with profile identity and bearer auth", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const transport = profile(async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      calls.push({ url, authorization: headers.get("authorization") });
      if (url.endsWith("/api/sessions/hermes-session-1")) {
        return new Response(JSON.stringify({ session: { id: "hermes-session-1" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        session_id: "hermes-session-1",
        data: [
          { id: "message-1", role: "user", content: "hello", created_at: "2026-09-22T00:00:00Z" },
          { id: "message-2", role: "assistant", content: "world" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = createHermesGatewayProviderCapabilities(transport);

    const result = await adapter.transcript.readRange(request());

    expect(result).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    expect(result.items.map((item) => item.sourceEntryId)).toEqual(["message-1", "message-2"]);
    expect(result.items[0]).toMatchObject({ kind: "hermes:message:user", text: "hello", origin: "native" });
    expect(calls).toEqual([{
      url: "http://127.0.0.1:43121/api/sessions/hermes-session-1",
      authorization: "Bearer secret-hermes-key",
    }, {
      url: "http://127.0.0.1:43121/api/sessions/hermes-session-1/messages",
      authorization: "Bearer secret-hermes-key",
    }]);
  });

  it("enforces the HTTP transcript byte bound before parsing oversized JSON", async () => {
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    });
    const transport = profile(async (input) => String(input).endsWith("/api/sessions/hermes-session-1")
      ? new Response(JSON.stringify({ session: { id: "hermes-session-1" } }), { status: 200 })
      : new Response(responseBody, { status: 200 }));
    const adapter = createHermesGatewayProviderCapabilities(transport);

    const result = await adapter.transcript.readRange(request());

    expect(result).toMatchObject({ availability: "offline", completeness: "unknown", revision: "transport-error", items: [] });
    expect(cancelled).toBe(true);
    expect(responseBody.locked).toBe(false);
  });

  it("reads confirmed run SSE events and marks malformed application data partial", async () => {
    const transport = profile(async (input) => {
      if (String(input).endsWith("/api/sessions/hermes-session-1")) {
        return new Response(JSON.stringify({ id: "hermes-session-1" }), { status: 200 });
      }
      expect(String(input)).toBe("http://127.0.0.1:43121/v1/runs/run-1/events");
      return new Response([
        `data: ${JSON.stringify({ event: "message.delta", delta: "hello", run_id: "run-1" })}`,
        "",
        "data: not-json",
        "",
        `data: ${JSON.stringify({ event: "run.completed", output: "done", run_id: "run-1" })}`,
        "",
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const adapter = createHermesGatewayProviderCapabilities(transport);

    const result = await adapter.transcript.readRange(request({
      selector: { kind: "hermes_execution", providerExecutionRef: "run-1" },
    }));

    expect(result).toMatchObject({ availability: "available", completeness: "partial" });
    expect(result.items.map((item) => item.kind)).toEqual([
      "hermes:event:message.delta",
      "hermes:event:run.completed",
    ]);
  });

  it.each([
    { label: "invalid", bytes: new Uint8Array([0xff]) },
    { label: "truncated", bytes: new Uint8Array([0xe4, 0xbd]) },
  ])("rejects $label UTF-8 in run SSE bodies", async ({ bytes }) => {
    const transport = profile(async (input) => String(input).endsWith("/api/sessions/hermes-session-1")
      ? new Response(JSON.stringify({ id: "hermes-session-1" }), { status: 200 })
      : new Response(bytes, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const adapter = createHermesGatewayProviderCapabilities(transport);

    const result = await adapter.transcript.readRange(request({
      selector: { kind: "hermes_execution", providerExecutionRef: "run-1" },
    }));

    expect(result).toMatchObject({ availability: "offline", completeness: "unknown", revision: "transport-error", items: [] });
  });

  it("marks a successful run SSE response without a body partial", async () => {
    const transport = profile(async (input) => String(input).endsWith("/api/sessions/hermes-session-1")
      ? new Response(JSON.stringify({ id: "hermes-session-1" }), { status: 200 })
      : new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const adapter = createHermesGatewayProviderCapabilities(transport);

    const result = await adapter.transcript.readRange(request({
      selector: { kind: "hermes_execution", providerExecutionRef: "run-1" },
    }));

    expect(result).toMatchObject({ availability: "available", completeness: "partial", items: [] });
  });

  it("fails closed when a run event explicitly belongs to another session", async () => {
    const transport = profile(async (input) => {
      if (String(input).endsWith("/api/sessions/hermes-session-1")) {
        return new Response(JSON.stringify({ id: "hermes-session-1" }), { status: 200 });
      }
      return new Response(`data: ${JSON.stringify({ event: "run.completed", run_id: "run-1", session_id: "other-session" })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const adapter = createHermesGatewayProviderCapabilities(transport);

    await expect(adapter.transcript.readRange(request({
      selector: { kind: "hermes_execution", providerExecutionRef: "run-1" },
    }))).resolves.toMatchObject({
      availability: "incompatible",
      revision: "event-session-mismatch",
      items: [],
    });
  });

  it("redacts provider credentials from native transcript payloads while preserving interaction text", async () => {
    const secret = "secret-hermes-key";
    const transport = profile(async (input) => {
      if (String(input).endsWith("/api/sessions/hermes-session-1")) {
        return new Response(JSON.stringify({ id: "hermes-session-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        session_id: "hermes-session-1",
        data: [{
          id: "message-secret",
          role: "assistant",
          content: "safe interaction text",
          authorization: secret,
          credentials: { api_key: secret },
          metadata: { nested: { access_token: secret } },
          output: { provider_note: secret },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = createHermesGatewayProviderCapabilities(transport);

    const result = await adapter.transcript.readRange(request());
    const item = result.items[0];

    expect(item).toMatchObject({ text: "safe interaction text" });
    expect(JSON.stringify(item?.payload)).not.toContain(secret);
    expect(item?.payload).toMatchObject({
      record: {
        authorization: "[REDACTED]",
        credentials: "[REDACTED]",
        metadata: { nested: { access_token: "[REDACTED]" } },
      },
    });
  });

  it("applies the driver range aliases and rejects persisted transport drift", async () => {
    const fetch = async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/sessions/hermes-session-1")) {
        return new Response(JSON.stringify({ id: "hermes-session-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        session_id: "hermes-session-1",
        data: [
          { id: "message-1", role: "user", content: "first" },
          { id: "message-2", role: "assistant", content: "second" },
        ],
      }), { status: 200 });
    };
    const adapter = createHermesGatewayProviderCapabilities(profile(fetch));

    const ranged = await adapter.transcript.readRange(request({ from: "message-1" }));
    const wrongTransport = await adapter.transcript.readRange(request({
      session: {
        ...request().session,
        sessionParams: { ...request().session.sessionParams, hermesTransport: "other-transport" },
      },
    }));
    const wrongRuntime = await adapter.transcript.readRange(request({ runtimeType: "cursor" }));

    expect(ranged.items.map((item) => item.sourceEntryId)).toEqual(["message-2"]);
    expect(wrongTransport).toMatchObject({ availability: "incompatible", revision: "transport-mismatch" });
    expect(wrongRuntime).toMatchObject({ availability: "incompatible", revision: "runtime-mismatch" });
  });

  it("fails closed for identity mismatch and records the real fork limitation", async () => {
    const fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const adapter = createHermesGatewayProviderCapabilities(profile(fetch));
    const mismatch = await adapter.transcript.readRange(request({
      binding: { ...binding, profileId: "other-profile" },
    }));

    expect(mismatch).toMatchObject({ availability: "incompatible", revision: "profile-mismatch" });
    expect(adapter.fork.evidence).toMatchObject({
      status: "unsupported",
      providerVersion: "0.19.1",
      transport: "hermes-http-sse",
    });
    expect(adapter.fork.evidence.reason).toContain("no verified boundary-fork endpoint");
    expect(adapter.control.interrupt.evidence.status).toBe("supported");
  });

  it("keeps fork and steer unclassified when the gateway version is not verified", () => {
    const adapter = createHermesGatewayProviderCapabilities({
      ...profile(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
      providerVersion: "0.20.0",
    });

    expect(adapter.fork.evidence).toMatchObject({ status: "unknown", profileBound: true });
    expect(adapter.control.steer.evidence).toMatchObject({ status: "unknown", profileBound: true });
  });

  it("does not report a profile-bound native source without bearer transport", () => {
    const adapter = createHermesGatewayProviderCapabilities({
      ...profile(async () => new Response(JSON.stringify({ id: "hermes-session-1" }), { status: 200 })),
      apiKey: undefined,
    });

    expect(adapter.transcript.evidence).toMatchObject({ status: "unknown", profileBound: true });
    expect(adapter.transcript.evidence.reason).toContain("Bearer API credential");
  });

  it("exposes a profile resolver without turning the unbound declaration into a native hook", () => {
    const resolver = createHermesGatewayProviderCapabilityResolver(() => profile(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));

    expect(resolver("hermes_gateway", binding)?.transcript.readRange).toBeTypeOf("function");
    expect(resolver("hermes_gateway", null)?.transcript.evidence.status).toBe("unknown");
    expect(resolver("cursor", binding)).toBeNull();
  });

  it("routes only an advertised HTTP run steer through the profile-bound live handle", async () => {
    const session = request().session;
    session.sessionParams.hermesRunSteerAdvertised = true;
    const resolver = createHermesGatewayProviderCapabilityResolver(() => profile(async () => new Response("{}", { status: 200 })));
    const adapter = resolver("hermes_gateway", binding, { session });
    const handle: AgentRuntimeControlHandle = {
      runtimeType: "hermes_gateway",
      providerThreadId: session.sessionId,
      providerTurnId: "hermes-run-1",
      capabilities: { steer: "native", interrupt: "remote" },
      steer: vi.fn().mockResolvedValue({
        disposition: "accepted_current",
        providerThreadId: session.sessionId,
        providerTurnId: "hermes-run-1",
      }),
      interrupt: vi.fn().mockResolvedValue("acknowledged"),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    expect(adapter?.control.steer).toMatchObject({
      mode: "native",
      requiresHandle: true,
      evidence: { status: "supported", profileBound: true, transport: "hermes-http-sse" },
    });
    await expect(adapter?.control.steer.execute?.({
      runtimeType: "hermes_gateway",
      handle,
      operation: { kind: "steer", input: { text: "continue", clientMessageId: "message-1" } },
      session,
      binding,
    })).resolves.toMatchObject({ disposition: "accepted_current", providerTurnId: "hermes-run-1" });
    expect(handle.steer).toHaveBeenCalledOnce();
  });

  it.each(["runtimeType", "missingThread", "mismatchedThread"] as const)(
    "does not forward an advertised run steer when the live handle has a mismatched %s",
    async (mismatch) => {
      const session = request().session;
      session.sessionParams.hermesRunSteerAdvertised = true;
      const resolver = createHermesGatewayProviderCapabilityResolver(() => profile(async () => new Response("{}", { status: 200 })));
      const adapter = resolver("hermes_gateway", binding, { session });
      const steer = vi.fn();
      const handle: AgentRuntimeControlHandle = {
        runtimeType: mismatch === "runtimeType" ? "cursor" : "hermes_gateway",
        providerThreadId: mismatch === "missingThread"
          ? null
          : mismatch === "mismatchedThread"
            ? "another-hermes-session"
            : session.sessionId,
        providerTurnId: "hermes-run-1",
        capabilities: { steer: "native", interrupt: "remote" },
        steer,
        interrupt: vi.fn().mockResolvedValue("acknowledged"),
        dispose: vi.fn().mockResolvedValue(undefined),
      };

      await expect(adapter?.control.steer.execute?.({
        runtimeType: "hermes_gateway",
        handle,
        operation: { kind: "steer", input: { text: "continue", clientMessageId: "message-1" } },
        session,
        binding,
      })).resolves.toMatchObject({
        disposition: "acceptance_unknown",
        reason: expect.stringContaining("was not forwarded"),
      });
      expect(steer).not.toHaveBeenCalled();
    },
  );

  it("keeps a non-advertised HTTP run steer unsupported and does not call its handle", async () => {
    const session = request().session;
    session.sessionParams.hermesRunSteerAdvertised = false;
    const resolver = createHermesGatewayProviderCapabilityResolver(() => profile(async () => new Response("{}", { status: 200 })));
    const adapter = resolver("hermes_gateway", binding, { session });
    const handle: AgentRuntimeControlHandle = {
      runtimeType: "hermes_gateway",
      providerThreadId: session.sessionId,
      providerTurnId: "hermes-run-1",
      capabilities: { steer: "interrupt_continue", interrupt: "remote" },
      steer: vi.fn(),
      interrupt: vi.fn().mockResolvedValue("acknowledged"),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    expect(adapter?.control.steer.evidence).toMatchObject({ status: "unsupported", profileBound: true });
    await expect(adapter?.control.steer.execute?.({
      runtimeType: "hermes_gateway",
      handle,
      operation: { kind: "steer", input: { text: "continue", clientMessageId: "message-1" } },
      session,
      binding,
    })).resolves.toMatchObject({ disposition: "unsupported" });
    expect(handle.steer).not.toHaveBeenCalled();
  });
});

describe("Hermes ACP profile-bound native capabilities", () => {
  it("keeps persisted Run transcript ownership unknown even within one session generation", () => {
    const acpProfile = {
      binding: { hostId: binding.hostId, profileId: binding.profileId, capabilityRevision: "acp-v1" },
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
      providerVersion: "0.21.0",
      protocolVersion: 1,
      hermesPythonCommand: process.execPath,
      hermesSourcePath: path.resolve("."),
      hermesHome: os.tmpdir(),
    };
    const adapter = createHermesAcpProviderCapabilities(acpProfile);

    expect(adapter.transcript.evidence).toMatchObject({ status: "supported", profileBound: true });
    expect(adapter.transcript.evidence.reason).toContain("no prompt-scoped row locator");
    expect(adapter.transcript.evidence.reason).toContain("advertises and enforces per_session_exclusive_submit");
    expect(adapter.transcript.evidence.reason).toContain("before-history snapshot precedes prompt.submit");
    expect(adapter.transcript.evidence.reason).toContain("release its lease in the gap");
    expect(adapter.transcript.evidence.reason).toContain("foreign assistant/tool rows");
    expect(adapter.transcript.evidence.reason).toContain("compacted handoff");
    expect(adapter.transcript.evidence.reason).toContain("source-row locators");
    expect(adapter.transcript.evidence.reason).toContain("cap selection at 200 rows");
    expect(adapter.transcript.evidence.reason).toContain("raw payloads");
  });

  it("advertises only the verified ACP session and control methods for an explicit profile", () => {
    const acpProfile = {
      binding: { hostId: binding.hostId, profileId: binding.profileId, capabilityRevision: "acp-v1" },
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
      providerVersion: "0.21.0",
      protocolVersion: 1,
    };
    const adapter = createHermesAcpProviderCapabilities(acpProfile);
    const resolved = createHermesAcpProviderCapabilityResolver(() => acpProfile)("hermes_gateway", acpProfile.binding);

    expect(adapter.sessionResume.evidence).toMatchObject({ status: "supported", transport: "hermes-acp-stdio", profileBound: true });
    expect(adapter.fork.evidence.reason).toContain("session/fork");
    expect(adapter.fork.fork).toBeTypeOf("function");
    expect(adapter.control.steer).toMatchObject({ mode: "native", requiresHandle: true, evidence: { status: "unsupported" } });
    expect(adapter.control.steer.evidence.reason).toContain("queued as a follow-up");
    expect(adapter.fork.evidence.status).toBe("unsupported");
    expect(adapter.transcript.evidence.status).toBe("unknown");
    expect(adapter.control.interrupt).toMatchObject({ mode: "native", requiresHandle: true, evidence: { status: "supported" } });
    expect(resolved?.transcript.readRange).toBeTypeOf("function");
  });

  it("rejects historical boundaries on ACP without invoking session/fork", async () => {
    const acpProfile = {
      binding,
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
      providerVersion: "0.21.0",
      protocolVersion: 1,
    };
    const adapter = createHermesAcpProviderCapabilities(acpProfile);

    await expect(adapter.fork.fork({
      runtimeType: "hermes_gateway",
      binding,
      session: {
        sessionId: "hermes-session-1",
        sessionDisplayId: "hermes-session-1",
        sessionParams: { transport: "hermes-acp-stdio" },
      },
      boundary: "hermes:db:hermes-session-1:7",
    })).rejects.toThrow("historical message boundary");
  });

  it("does not expose ACP support without a bound profile version", () => {
    const adapter = createHermesAcpProviderCapabilities({
      binding,
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
    });

    expect(adapter.transcript.evidence).toMatchObject({ status: "unknown", profileBound: true });
    expect(adapter.transcript.evidence.reason).toContain("provider version");
  });

  it("does not treat interleaved Product RPC assistant/tool rows as Run-owned and binds the range revision to raw rows", async () => {
    const fixture = await historyFixture({
      providerVersion: "0.21.0",
      sessionId: "hermes-product-session",
      rows: [
        { id: 1, role: "user", content: "previous prompt", timestamp: 1 },
        { id: 2, role: "assistant", content: "previous Run output", timestamp: 2 },
        { id: 3, role: "tool", tool_name: "foreign-tool", content: "foreign tool result", timestamp: 3 },
        { id: 4, role: "user", content: "current Run prompt", timestamp: 4 },
        { id: 5, role: "assistant", content: "interleaved foreign assistant", timestamp: 5 },
        { id: 6, role: "tool", tool_name: "foreign-tool-2", content: "interleaved foreign tool", timestamp: 6 },
        { id: 7, role: "assistant", content: "possible current Run output", timestamp: 7 },
      ],
    });
    try {
      const profile = {
        ...acpHistoryProfile(fixture),
        hermesPythonCommand: fixture.profile.pythonCommand!,
        hermesSourcePath: fixture.profile.sourcePath!,
        hermesHome: fixture.profile.hermesHome!,
        providerVersion: "0.21.0",
      };
      const sessionParams = buildHermesProductRpcSessionParams({ sessionId: fixture.sessionId, profile });
      const sourceRangeRef = JSON.stringify({
        version: 1,
        status: "exact",
        sessionId: fixture.sessionId,
        startExclusive: 2,
        endInclusive: 7,
      });
      const selector = {
        kind: "hermes_execution",
        sessionRef: fixture.sessionId,
        providerExecutionRef: "run-hermes-product-test",
        sourceRangeRef,
      };
      const readerBinding = { ...binding, id: "binding-hermes-reader-test", orgId: "org-hermes-reader-test" };
      const readerInput = persistedHermesReaderInput(fixture.sessionId, selector);
      const adapter = createHermesAcpProviderCapabilities(profile);
      const result = await adapter.transcript.readRange({
        runtimeType: "hermes_gateway",
        binding: readerBinding,
        session: {
          sessionId: fixture.sessionId,
          sessionDisplayId: fixture.sessionId,
          sessionParams,
        },
        selector,
        readerInput,
      });

      expect(adapter.sessionResume.evidence).toMatchObject({
        status: "supported",
        transport: HERMES_PRODUCT_RPC_TRANSPORT,
        profileBound: true,
        profileRequired: true,
      });
      expect(adapter.transcript.evidence).toMatchObject({
        status: "supported",
        transport: "hermes-session-db-read-only",
        profileBound: true,
      });
      expect(result).toMatchObject({
        availability: "available",
        completeness: "complete",
        revision: expect.stringMatching(/^execution-span:/),
      });
      expect(result.items.map((item) => item.payload.rowId)).toEqual([3, 4, 5, 6, 7]);

      const databasePath = path.join(fixture.profile.hermesHome!, "state.db");
      const database = JSON.parse(await fs.readFile(databasePath, "utf8"));
      const foreignRow = database.messages[fixture.sessionId].find((row: Record<string, unknown>) => row.id === 5);
      if (!foreignRow) throw new Error("interleaved foreign assistant row is missing");
      foreignRow.content = "changed foreign assistant payload";
      await fs.writeFile(databasePath, JSON.stringify(database), "utf8");
      const changed = await adapter.transcript.readRange({
        runtimeType: "hermes_gateway",
        binding: readerBinding,
        session: { sessionId: fixture.sessionId, sessionDisplayId: fixture.sessionId, sessionParams },
        selector,
        readerInput,
      });
      expect(changed.revision).not.toBe(result.revision);

      database.messages[fixture.sessionId].push({
        id: 8,
        session_id: fixture.sessionId,
        role: "assistant",
        content: "outside the requested range",
        timestamp: 8,
        active: 1,
        compacted: 0,
      });
      await fs.writeFile(databasePath, JSON.stringify(database), "utf8");
      const withForeignTail = await adapter.transcript.readRange({
        runtimeType: "hermes_gateway",
        binding: readerBinding,
        session: { sessionId: fixture.sessionId, sessionDisplayId: fixture.sessionId, sessionParams },
        selector,
        readerInput,
      });
      expect(withForeignTail.revision).toBe(changed.revision);

      const mismatched = await adapter.transcript.readRange({
        runtimeType: "hermes_gateway",
        binding: readerBinding,
        session: {
          sessionId: fixture.sessionId,
          sessionDisplayId: fixture.sessionId,
          sessionParams: { ...sessionParams, profileId: "another-profile" },
        },
        selector,
        readerInput,
      });
      expect(mismatched).toMatchObject({ availability: "incompatible", revision: "session-profile-mismatch" });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("applies exact-range cursor and 200-row restrictions to the Product RPC Reader", async () => {
    const fixture = await historyFixture({
      providerVersion: "0.21.0",
      sessionId: "hermes-product-bounded-session",
      rows: Array.from({ length: 201 }, (_, index) => ({
        id: index + 1,
        role: index % 2 ? "assistant" : "tool",
        content: `interleaved row ${index + 1}`,
        timestamp: index + 1,
      })),
    });
    try {
      const profile = acpHistoryProfile(fixture);
      const sessionParams = buildHermesProductRpcSessionParams({ sessionId: fixture.sessionId, profile });
      const adapter = createHermesAcpProviderCapabilities(profile);
      const selector = {
        kind: "hermes_execution",
        sessionRef: fixture.sessionId,
        providerExecutionRef: "run-hermes-product-bounded-test",
        sourceRangeRef: JSON.stringify({
          version: 1,
          status: "exact",
          sessionId: fixture.sessionId,
          startExclusive: 0,
          endInclusive: 201,
        }),
      };
      const requestInput = {
        runtimeType: "hermes_gateway",
        binding: { ...binding, id: "binding-hermes-reader-test", orgId: "org-hermes-reader-test" },
        session: { sessionId: fixture.sessionId, sessionDisplayId: fixture.sessionId, sessionParams },
        selector,
        readerInput: persistedHermesReaderInput(fixture.sessionId, selector),
      };
      const withCursor = await adapter.transcript.readRange({ ...requestInput, cursor: "unexpected-cursor" });
      const oversized = await adapter.transcript.readRange(requestInput);

      expect(withCursor).toMatchObject({ items: [], nextCursor: null, revision: "execution-cursor-unsupported", completeness: "unknown" });
      expect(oversized).toMatchObject({ items: [], nextCursor: null, revision: "execution-range-too-large", completeness: "unknown" });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("advertises versioned exact-prefix Product Gateway Fork only for verified Hermes 0.21.0", async () => {
    if (!historyPythonCommand) return;
    const fixture = await historyFixture({ providerVersion: "0.21.0", sessionId: "hermes-product-fork-parent" });
    try {
      const profile = acpHistoryProfile(fixture);
      const adapter = createHermesAcpProviderCapabilities(profile);
      expect(adapter.fork.evidence).toMatchObject({
        status: "supported",
        transport: HERMES_PRODUCT_RPC_TRANSPORT,
      });
      expect(adapter.fork.evidence.reason).toContain("exact assistant row boundary");

      const unverified = createHermesAcpProviderCapabilities({ ...profile, providerVersion: "0.22.0" });
      expect(unverified.fork.evidence).toMatchObject({ status: "unknown", profileBound: true });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps unverified provider versions and ACP protocol versions unknown", () => {
    const versionAdapter = createHermesAcpProviderCapabilities({
      binding,
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
      providerVersion: "0.22.0",
      protocolVersion: 1,
    });
    const protocolAdapter = createHermesAcpProviderCapabilities({
      binding,
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
      providerVersion: "0.21.0",
      protocolVersion: 2,
    });

    expect(versionAdapter.sessionResume.evidence).toMatchObject({ status: "unknown", profileBound: true });
    expect(versionAdapter.sessionResume.evidence.reason).toContain("version 0.22.0 is unverified");
    expect(protocolAdapter.sessionResume.evidence).toMatchObject({ status: "unknown", profileBound: true });
    expect(protocolAdapter.sessionResume.evidence.reason).toContain("protocol 2 has not been verified");
  });

  it("does not advertise ACP history for non-absolute host paths", () => {
    const adapter = createHermesAcpProviderCapabilities({
      binding,
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
      providerVersion: "0.21.0",
      hermesPythonCommand: "python3",
      hermesSourcePath: "./hermes-agent",
      hermesHome: "./hermes-home",
    });

    expect(adapter.transcript.evidence).toMatchObject({ status: "unknown", profileBound: true });
    expect(adapter.transcript.evidence.reason).toContain("host-authorized Python/source/HERMES_HOME history profile");
  });

  it("does not promote a v0.21.0 user row to Run-owned output after a provider error", async () => {
    if (!historyPythonCommand) return;
    const fixture = await historyFixture(HERMES_ACP_021_SUBSCRIPTION_403_FIXTURE);
    const acpProfile = acpHistoryProfile(fixture);
    const adapter = createHermesAcpProviderCapabilities(acpProfile);

    const result = await adapter.transcript.readRange(acpReadRequest(
      fixture.sessionId,
      exactAcpRunSelector(fixture.sessionId, 1),
    ));

    expect(HERMES_ACP_021_SUBSCRIPTION_403_FIXTURE).toMatchObject({
      providerError: true,
      providerHttpStatus: 403,
      providerVersion: "0.21.0",
    });
    expect(result).toMatchObject({
      availability: "available",
      completeness: "unknown",
      revision: "execution-boundary-unknown",
      items: [],
    });
  });

  it("keeps empty exact Run spans unknown because empty history cannot prove ownership", async () => {
    if (!historyPythonCommand) return;
    const fixture = await historyFixture({
      sessionId: "empty-run-session",
      providerVersion: "0.21.0",
      rows: [],
    });
    const adapter = createHermesAcpProviderCapabilities(acpHistoryProfile(fixture));

    const result = await adapter.transcript.readRange(acpReadRequest(
      fixture.sessionId,
      exactAcpRunSelector(fixture.sessionId, 2),
    ));

    expect(result).toMatchObject({
      availability: "available",
      completeness: "unknown",
      revision: "execution-boundary-unknown",
      items: [],
    });
  });

  it("keeps a legitimate empty session complete when there is no Run selector", async () => {
    if (!historyPythonCommand) return;
    const fixture = await historyFixture({
      sessionId: "legitimately-empty-session",
      providerVersion: "0.21.0",
      rows: [],
    });
    const adapter = createHermesAcpProviderCapabilities(acpHistoryProfile(fixture));

    const result = await adapter.transcript.readRange(acpReadRequest(fixture.sessionId));

    expect(result).toMatchObject({
      availability: "available",
      completeness: "complete",
      items: [],
    });
  });

  it("does not accept assistant/tool rows as exact Run proof and keeps missing boundaries unknown", async () => {
    if (!historyPythonCommand) return;
    const fixture = await historyFixture({ providerVersion: "0.21.0" });
    const adapter = createHermesAcpProviderCapabilities(acpHistoryProfile(fixture));

    const complete = await adapter.transcript.readRange(acpReadRequest(
      fixture.sessionId,
      exactAcpRunSelector(fixture.sessionId, 3),
    ));
    const unknownBoundary = await adapter.transcript.readRange(acpReadRequest(fixture.sessionId, {
      kind: "hermes_execution",
      providerExecutionRef: "run-without-boundary",
      boundaryStatus: "unknown",
    }));

    expect(complete).toMatchObject({
      availability: "available",
      completeness: "unknown",
      revision: "execution-boundary-unknown",
      items: [],
    });
    expect(unknownBoundary).toMatchObject({
      availability: "missing",
      completeness: "unknown",
      revision: "execution-boundary-unknown",
      items: [],
    });
  });

  it("does not accept a tool-only row as Run evidence", async () => {
    if (!historyPythonCommand) return;
    const fixture = await historyFixture({
      sessionId: "tool-only-run-session",
      providerVersion: "0.21.0",
      rows: [{ id: 1, role: "tool", tool_name: "lookup", content: "result" }],
    });
    const adapter = createHermesAcpProviderCapabilities(acpHistoryProfile(fixture));

    const result = await adapter.transcript.readRange(acpReadRequest(
      fixture.sessionId,
      exactAcpRunSelector(fixture.sessionId, 1),
    ));

    expect(result).toMatchObject({
      availability: "available",
      completeness: "unknown",
      revision: "execution-boundary-unknown",
      items: [],
    });
  });
});
