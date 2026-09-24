import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHermesAcpProviderCapabilities,
  createHermesAcpProviderCapabilityResolver,
  createHermesGatewayProviderCapabilities,
  createHermesGatewayProviderCapabilityResolver,
  type HermesGatewayProfileTransport,
  type HermesNativeTranscriptReadRequest,
} from "./native-capabilities.js";
import { buildHermesProductRpcSessionParams, HERMES_PRODUCT_RPC_TRANSPORT } from "./product-rpc.js";

const binding = {
  hostId: "host-hermes-1",
  profileId: "profile-hermes-1",
  capabilityRevision: "hermes-api-v1",
};

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
  const rows = options.rows ?? [
    { role: "user", content: "before", timestamp: 1 },
    { role: "assistant", content: "run one", timestamp: 2 },
    { role: "assistant", content: "run two", timestamp: 3 },
  ].map((row, index) => ({ ...row, id: index + 1 }));
  const sourcePath = path.join(root, "source");
  const hermesHome = path.join(root, "home");
  await fs.mkdir(sourcePath);
  await fs.mkdir(hermesHome);
  await fs.writeFile(path.join(sourcePath, "hermes_state.py"), HISTORY_FAKE_SESSION_DB, "utf8");
  await fs.writeFile(path.join(hermesHome, "state.db"), JSON.stringify({
    sessions: {
      [sessionId]: { id: sessionId, source: "acp", message_count: rows.length },
    },
    messages: {
      [sessionId]: rows.map((row) => ({ ...row, session_id: sessionId, active: 1, compacted: 0 })),
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

function acpHistoryProfile(fixture: Awaited<ReturnType<typeof historyFixture>>) {
  return {
    binding,
    command: process.execPath,
    args: ["-e", ""],
    cwd: fixture.root,
    providerVersion: fixture.profile.providerVersion,
    protocolVersion: 1,
    hermesPythonCommand: fixture.profile.pythonCommand,
    hermesSourcePath: fixture.profile.sourcePath,
    hermesHome: fixture.profile.hermesHome,
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
  it("routes the unified Reader through the host-authorized product history source", async () => {
    if (!historyPythonCommand) return;
    const fixture = await historyFixture();
    const fetch = async () => {
      throw new Error("profile-bound product history must not fall back to HTTP");
    };
    const adapter = createHermesGatewayProviderCapabilities({ ...fixture.profile, fetch });

    const result = await adapter.transcript.readRange(request({
      session: {
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
      },
      selector: {
        kind: "hermes_execution",
        providerExecutionRef: "run-1",
        sourceRangeRef: JSON.stringify({
          version: 1,
          status: "exact",
          sessionId: fixture.sessionId,
          startExclusive: 1,
          endInclusive: 2,
        }),
      },
    }));

    expect(adapter.transcript.evidence).toMatchObject({
      status: "supported",
      transport: "hermes-session-db-read-only",
      profileBound: true,
    });
    expect(result).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    expect(result.items.map((item) => item.sourceEntryId)).toEqual(["2"]);
    expect(result.items[0]?.text).toBe("run one");
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
      availability: "missing",
      completeness: "unknown",
      revision: "execution-boundary-unknown",
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
      availability: "missing",
      completeness: "unknown",
      revision: "execution-boundary-unknown",
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
});

describe("Hermes ACP profile-bound native capabilities", () => {
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
    expect(adapter.fork.execute).toBeTypeOf("function");
    expect(adapter.control.steer).toMatchObject({ mode: "native", requiresHandle: true, evidence: { status: "unsupported" } });
    expect(adapter.control.steer.evidence.reason).toContain("queued as a follow-up");
    expect(adapter.fork.evidence.status).toBe("unsupported");
    expect(adapter.transcript.evidence.status).toBe("unknown");
    expect(adapter.control.interrupt).toMatchObject({ mode: "native", requiresHandle: true, evidence: { status: "supported" } });
    expect(resolved?.transcript.readRange).toBeTypeOf("function");
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

  it("reads only the exact Product Gateway row interval and rejects a mismatched persisted profile", async () => {
    const fixture = await historyFixture({
      providerVersion: "0.21.0",
      sessionId: "hermes-product-session",
      rows: [
        { id: 1, role: "assistant", content: "old session history", timestamp: 1 },
        { id: 2, role: "user", content: "current Run prompt", timestamp: 2 },
        { id: 3, role: "assistant", content: "current Run output", timestamp: 3 },
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
        startExclusive: 1,
        endInclusive: 3,
      });
      const adapter = createHermesAcpProviderCapabilities(profile);
      const result = await adapter.transcript.readRange({
        runtimeType: "hermes_gateway",
        binding,
        session: {
          sessionId: fixture.sessionId,
          sessionDisplayId: fixture.sessionId,
          sessionParams,
        },
        selector: { kind: "hermes_execution", sourceRangeRef },
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
      expect(result).toMatchObject({ availability: "available", completeness: "complete" });
      expect(result.items.map((item) => item.sourceEntryId)).toEqual(["2", "3"]);
      expect(result.items.some((item) => JSON.stringify(item.payload).includes("old session history"))).toBe(false);

      const mismatched = await adapter.transcript.readRange({
        runtimeType: "hermes_gateway",
        binding,
        session: {
          sessionId: fixture.sessionId,
          sessionDisplayId: fixture.sessionId,
          sessionParams: { ...sessionParams, profileId: "another-profile" },
        },
        selector: { kind: "hermes_execution", sourceRangeRef },
      });
      expect(mismatched).toMatchObject({ availability: "incompatible", revision: "session-profile-mismatch" });
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

  it("marks a v0.21.0 subscription-403 Run with only its user row as partial and preserves that evidence", async () => {
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
      completeness: "partial",
      revision: expect.stringContaining("run-output-missing:"),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "hermes:db:user", text: "provider HTTP 403" });
  });

  it("marks an exact Run boundary with zero persisted rows missing instead of complete", async () => {
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
      availability: "missing",
      completeness: "partial",
      revision: expect.stringContaining("run-output-missing:"),
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

  it("keeps exact-boundary assistant/tool history complete and missing boundaries unknown", async () => {
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

    expect(complete).toMatchObject({ availability: "available", completeness: "complete" });
    expect(complete.items.some((item) => item.kind === "hermes:db:assistant")).toBe(true);
    expect(unknownBoundary).toMatchObject({
      availability: "missing",
      completeness: "unknown",
      revision: "execution-boundary-unknown",
      items: [],
    });
  });

  it("accepts tool-only history as complete Run evidence", async () => {
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

    expect(result).toMatchObject({ availability: "available", completeness: "complete" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe("hermes:db:tool");
  });
});
