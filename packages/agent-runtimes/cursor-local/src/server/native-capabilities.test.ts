import type { AgentRuntimeControlHandle, ChatAskUserRequest } from "@rudderhq/agent-runtime-utils";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";
import {
  createCursorLocalProviderCapabilities,
  createCursorLocalProviderCapabilityResolver,
  executeCursorNativeChat,
  normalizeCursorAcpMcpServers,
  type CursorLocalProfileTransport,
  type CursorNativeTranscriptReadRequest,
  type CursorProviderBindingRef,
} from "./native-capabilities.js";

type JsonRecord = Record<string, unknown>;
type SpawnFn = NonNullable<CursorLocalProfileTransport["spawn"]>;

const binding: CursorProviderBindingRef = {
  hostId: "host-cursor-1",
  profileId: "profile-cursor-1",
  capabilityRevision: "acp-v1",
};

function createSpawnFixture(
  respond: (request: JsonRecord, output: PassThrough) => void,
): { spawn: SpawnFn; requests: JsonRecord[] } {
  const requests: JsonRecord[] = [];
  const spawn = ((_command: string, _args: readonly string[], _options: unknown) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>;
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString()) as JsonRecord;
        requests.push(request);
        queueMicrotask(() => respond(request, stdout));
        callback();
      },
    });
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      killed: false,
      kill: () => {
        Object.defineProperty(child, "killed", { configurable: true, value: true, writable: true });
        Object.defineProperty(child, "exitCode", { configurable: true, value: 0, writable: true });
        child.emit("close", 0, null);
        return true;
      },
    });
    return child as ChildProcessWithoutNullStreams;
  }) as unknown as SpawnFn;
  return { spawn, requests };
}

function initializeResult(authMethods: JsonRecord[] = []): JsonRecord {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {} },
    },
    authMethods,
  };
}

function loadedSessionResult(): JsonRecord {
  return { modes: {}, models: [], configOptions: [] };
}

function profile(spawn: SpawnFn): CursorLocalProfileTransport {
  return {
    binding,
    cwd: "/tmp/cursor-project",
    providerVersion: "2026.06.19-20-24-33-653a7fb",
    command: "agent",
    spawn,
  };
}

function requestForSession(_spawn: SpawnFn, sessionId = "cursor-session-1"): CursorNativeTranscriptReadRequest {
  return {
    runtimeType: "cursor",
      session: {
        sessionId,
        sessionDisplayId: sessionId,
      sessionParams: {
        sessionId,
        cwd: "/tmp/cursor-project",
        cursorAcpTransport: "cursor-agent-acp-stdio",
        cursorAcpCommand: "agent",
        cursorAcpProtocolVersion: 1,
        cursorAcpAuthMethodId: "cursor_login",
        cursorProviderVersion: "2026.06.19-20-24-33-653a7fb",
        workspaceId: "workspace-1",
        profileHostId: binding.hostId,
        profileId: binding.profileId,
          capabilityRevision: binding.capabilityRevision,
        },
      },
      selector: {
        kind: "cursor_execution",
        sessionId,
        executionRef: "cursor-execution-1",
        nativeRangeRef: null,
      },
      binding,
    };
}

describe("Cursor ACP native capabilities", () => {
  it("loads real ACP session replay and preserves the protocol request contract", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "authenticate") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
      } else if (request.method === "session/load") {
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "cursor-session-1",
            update: {
            sessionUpdate: "user_message_chunk",
              executionRef: "cursor-execution-1",
              content: { type: "text", text: "Inspect this repository." },
            },
          },
        })}\n`);
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "cursor-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              executionRef: "cursor-execution-1",
              content: { type: "text", text: "Repository inspected." },
            },
          },
        })}\n`);
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "cursor-session-1",
            update: {
              sessionUpdate: "tool_call",
              executionRef: "cursor-execution-1",
              toolCallId: "tool-1",
              title: "read_file",
              status: "completed",
              _meta: { apiKey: "cursor-replay-secret" },
            },
          },
        })}\n`);
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: loadedSessionResult() })}\n`);
      }
    });
    const adapter = createCursorLocalProviderCapabilities({
      ...profile(fixture.spawn),
      env: { CURSOR_API_KEY: "cursor-replay-secret" },
    });

    const result = await adapter.transcript.readRange(requestForSession(fixture.spawn));

    expect(result).toMatchObject({
      source: "native",
      availability: "available",
      completeness: "partial",
    });
    expect(result.items.map((item) => item.kind)).toEqual([
      "cursor:acp:user_message_chunk",
      "cursor:acp:agent_message_chunk",
      "cursor:acp:tool_call",
    ]);
    expect(result.items[0]).toMatchObject({
      origin: "native",
      visibility: "visible",
      text: "Inspect this repository.",
    });
    expect(JSON.stringify(result.items)).not.toContain("cursor-replay-secret");
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "session/load",
    ]);
    expect(fixture.requests[1]).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
    expect(fixture.requests[2]?.params).toEqual({
      sessionId: "cursor-session-1",
      cwd: "/tmp/cursor-project",
      mcpServers: [],
    });
  });

  it("filters a shared ACP session to the persisted execution and native range", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "authenticate") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
      } else if (request.method === "session/load") {
        const emit = (update: JsonRecord) => output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "cursor-session-1", update },
        })}\n`);
        emit({
          sessionUpdate: "user_message_chunk",
          executionRef: "cursor-execution-1",
          nativeRangeRef: "cursor-range-1",
          content: { type: "text", text: "Turn one input." },
        });
        emit({
          sessionUpdate: "agent_message_chunk",
          executionRef: "cursor-execution-1",
          nativeRangeRef: "cursor-range-1",
          content: { type: "text", text: "Turn one answer." },
        });
        emit({
          sessionUpdate: "user_message_chunk",
          executionRef: "cursor-execution-2",
          nativeRangeRef: "cursor-range-2",
          content: { type: "text", text: "Turn two input." },
        });
        emit({
          sessionUpdate: "agent_message_chunk",
          executionRef: "cursor-execution-2",
          nativeRangeRef: "cursor-range-2",
          content: { type: "text", text: "Turn two answer." },
        });
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: loadedSessionResult() })}\n`);
      }
    });
    const adapter = createCursorLocalProviderCapabilities(profile(fixture.spawn));
    const base = requestForSession(fixture.spawn);

    const result = await adapter.transcript.readRange({
      ...base,
      selector: {
        kind: "cursor_execution",
        sessionId: "cursor-session-1",
        executionRef: "cursor-execution-2",
        nativeRangeRef: "cursor-range-2",
      },
    });

    expect(result).toMatchObject({
      source: "native",
      availability: "available",
      completeness: "partial",
    });
    expect(result.items.map((item) => item.text)).toEqual(["Turn two input.", "Turn two answer."]);
    expect(result.items.map((item) => item.ordinal)).toEqual([2, 3]);
    expect(JSON.stringify(result.items)).not.toContain("Turn one");
  });

  it("keeps distinct update IDs stable when a partial replay omits an earlier update", async () => {
    let omitPrefix = false;
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "session/load") {
        const emit = (text: string) => output.write(`${JSON.stringify({
          jsonrpc: "2.0", method: "session/update", params: {
            sessionId: "cursor-session-1",
            update: omitPrefix
              ? { content: { text, type: "text" }, executionRef: "cursor-execution-1", sessionUpdate: "agent_message_chunk" }
              : { sessionUpdate: "agent_message_chunk", executionRef: "cursor-execution-1",
                  content: { type: "text", text } },
          },
        })}\n`);
        if (!omitPrefix) emit("Earlier chunk. ");
        emit("Retained chunk.");
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: loadedSessionResult() })}\n`);
      }
    });
    const adapter = createCursorLocalProviderCapabilities(profile(fixture.spawn));
    const first = await adapter.transcript.readRange(requestForSession(fixture.spawn));
    omitPrefix = true;
    const partial = await adapter.transcript.readRange(requestForSession(fixture.spawn));
    expect(first.items.map((item) => item.ordinal)).toEqual([0, 1]);
    expect(partial.items.map((item) => item.ordinal)).toEqual([0]);
    expect(partial.items[0]?.sourceEntryId).toBe(first.items[1]?.sourceEntryId);
    expect(partial.items[0]?.id).toBe(first.items[1]?.id);
    expect(partial).toMatchObject({ availability: "available", completeness: "partial" });
  });

  it("preserves repeated identical updates without assigning an ambiguous durable occurrence ID", async () => {
    let omitPrefix = false;
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "session/load") {
        const event = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "cursor-session-1",
          update: { sessionUpdate: "agent_message_chunk", executionRef: "cursor-execution-1",
            content: { type: "text", text: "Repeated" } },
        } });
        output.write(omitPrefix ? `${event}\n` : `${event}\n${event}\n`);
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: loadedSessionResult() })}\n`);
      }
    });
    const adapter = createCursorLocalProviderCapabilities(profile(fixture.spawn));
    const result = await adapter.transcript.readRange(requestForSession(fixture.spawn));
    expect(result).toMatchObject({ availability: "available", completeness: "partial" });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.text)).toEqual(["Repeated", "Repeated"]);
    expect(new Set(result.items.map((item) => item.sourceEntryId)).size).toBe(2);
    expect(result.items.every((item) => item.sourceEntryId.startsWith(`acp:replay-window:${result.revision}:`))).toBe(true);
    omitPrefix = true;
    const partial = await adapter.transcript.readRange(requestForSession(fixture.spawn));
    expect(partial.items).toHaveLength(1);
    expect(partial).toMatchObject({ availability: "available", completeness: "partial" });
    expect(partial.items[0]?.sourceEntryId).not.toBe(result.items[0]?.sourceEntryId);
  });

  it("returns an explicit partial result when ACP replay has no exact Run boundary", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "authenticate") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
      } else if (request.method === "session/load") {
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "cursor-session-1",
            update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Unscoped input." } },
          },
        })}\n`);
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "cursor-session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Unscoped answer." } },
          },
        })}\n`);
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: loadedSessionResult() })}\n`);
      }
    });
    const adapter = createCursorLocalProviderCapabilities(profile(fixture.spawn));
    const base = requestForSession(fixture.spawn);

    const missingSelector = await adapter.transcript.readRange({ ...base, selector: null });
    const unknownBoundary = await adapter.transcript.readRange({
      ...base,
      selector: {
        kind: "cursor_execution",
        sessionId: "cursor-session-1",
        executionRef: "cursor-execution-2",
        nativeRangeRef: null,
      },
    });

    expect(missingSelector).toMatchObject({
      items: [],
      availability: "missing",
      completeness: "partial",
    });
    expect(missingSelector.revision).toContain("missing-run-range-boundary");
    expect(unknownBoundary).toMatchObject({
      items: [],
      availability: "incompatible",
      completeness: "partial",
    });
    expect(unknownBoundary.revision).toContain("ambiguous-run-range-boundary");
  });

  it("classifies provider authentication failure instead of returning an empty transcript", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult([{ id: "cursor_login", name: "Cursor Login" }]) })}\n`);
      } else if (request.method === "authenticate") {
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: "Authentication required. apiKey=cursor-auth-secret. Please run 'agent login' first.",
          },
        })}\n`);
      }
    });
    const adapter = createCursorLocalProviderCapabilities({
      ...profile(fixture.spawn),
      env: { CURSOR_API_KEY: "cursor-auth-secret" },
    });

    const result = await adapter.transcript.readRange(requestForSession(fixture.spawn));

    expect(result).toMatchObject({ availability: "incompatible", completeness: "unknown" });
    expect(result.revision).toContain("auth-required");
    expect(result.revision).not.toContain("cursor-auth-secret");
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "authenticate",
    ]);
  });

  it("authenticates the advertised Cursor method before opening a session", async () => {
    let authenticated = false;
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult([{ id: "cursor_login", name: "Cursor Login" }]) })}\n`);
      } else if (request.method === "authenticate") {
        authenticated = true;
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
      } else if (request.method === "session/new") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: authenticated ? "authenticated-session" : "unauthenticated-session" } })}\n`);
      } else if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "authenticated-session",
            update: { sessionUpdate: "agent_message_chunk", executionRef: "authenticated-execution", content: { type: "text", text: "ok" } },
          },
        })}\n`);
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })}\n`);
      }
    });

    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn),
      binding,
      prompt: "hello",
      model: "",
      onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 0, sessionId: "authenticated-session" });
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "authenticate",
      "session/new",
      "session/prompt",
    ]);
    expect(fixture.requests.find((request) => request.method === "authenticate")?.params).toEqual({ methodId: "cursor_login" });
  });

  it("redacts provider credentials from authentication errors and logs", async () => {
    const secret = "cursor-auth-test-secret";
    const logs: string[] = [];
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult([{ id: "cursor_login", name: "Cursor Login" }]) })}\n`);
      } else if (request.method === "authenticate") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: {
          code: -32000, message: `Authentication required. apiKey=${secret}.`,
        } })}\n`);
      }
    });
    const result = await executeCursorNativeChat({
      profile: { ...profile(fixture.spawn), env: { CURSOR_API_KEY: secret } },
      binding,
      prompt: "hello",
      model: "",
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });

    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_auth-required" });
    expect(result.errorMessage).toContain("[REDACTED]");
    expect(result.errorMessage).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
    expect(JSON.stringify(result.resultJson ?? {})).not.toContain(secret);
    expect(fixture.requests.map((request) => request.method)).toEqual(["initialize", "initialized", "authenticate"]);
  });

  it("uses a configured alternative authentication method when advertised", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult([
          { id: "cursor_login", name: "Cursor Login" },
          { id: "workspace_sso", name: "Workspace SSO" },
        ]) })}\n`);
      } else if (request.method === "authenticate") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
      } else if (request.method === "session/new") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "sso-session" } })}\n`);
      } else if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "sso-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        } })}\n`);
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })}\n`);
      }
    });
    const result = await executeCursorNativeChat({
      profile: { ...profile(fixture.spawn), authMethodId: "workspace_sso" },
      binding,
      prompt: "hello",
      model: "",
      onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 0, sessionId: "sso-session" });
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize", "initialized", "authenticate", "session/new", "session/prompt",
    ]);
    expect(fixture.requests.find((request) => request.method === "authenticate")?.params).toEqual({ methodId: "workspace_sso" });
    expect(result.sessionParams).toMatchObject({ cursorAcpAuthMethodId: "workspace_sso" });
  });

  it("selects a sole advertised alternative when no method is configured", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult([
          { id: "organization_login", name: "Organization Login" },
        ]) })}\n`);
      } else if (request.method === "authenticate") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
      } else if (request.method === "session/new") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "organization-session" } })}\n`);
      } else if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })}\n`);
      }
    });
    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn),
      binding,
      prompt: "hello",
      model: "",
      onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 0, sessionId: "organization-session" });
    expect(fixture.requests.find((request) => request.method === "authenticate")?.params).toEqual({ methodId: "organization_login" });
  });

  it("reuses a persisted alternative method when resuming a session", async () => {
    const createdFixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult([
          { id: "organization_login", name: "Organization Login" },
        ]) })}\n`);
      } else if (request.method === "authenticate") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
      } else if (request.method === "session/new") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "organization-session" } })}\n`);
      } else if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })}\n`);
      }
    });
    const created = await executeCursorNativeChat({
      profile: profile(createdFixture.spawn),
      binding,
      prompt: "first turn",
      model: "",
      onLog: async () => {},
    });
    expect(created).toMatchObject({ exitCode: 0, sessionId: "organization-session" });

    const resumedFixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult([
          { id: "cursor_login", name: "Cursor Login" },
          { id: "organization_login", name: "Organization Login" },
        ]) })}\n`);
      } else if (request.method === "authenticate") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
      } else if (request.method === "session/load") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "organization-session", modes: {} } })}\n`);
      } else if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })}\n`);
      }
    });
    const resumed = await executeCursorNativeChat({
      profile: profile(resumedFixture.spawn),
      binding,
      sessionId: created.sessionId,
      sessionParams: created.sessionParams,
      prompt: "second turn",
      model: "",
      onLog: async () => {},
    });

    expect(resumed).toMatchObject({ exitCode: 0, sessionId: "organization-session" });
    expect(resumedFixture.requests.map((request) => request.method)).toEqual([
      "initialize", "initialized", "authenticate", "session/load", "session/prompt",
    ]);
    expect(resumedFixture.requests.find((request) => request.method === "authenticate")?.params).toEqual({ methodId: "organization_login" });
  });

  it("reuses the persisted authentication method before transcript replay", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult([
          { id: "cursor_login", name: "Cursor Login" },
          { id: "organization_login", name: "Organization Login" },
        ]) })}\n`);
      } else if (request.method === "authenticate") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
      } else if (request.method === "session/load") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "cursor-session-1", modes: {} } })}\n`);
      }
    });
    const adapter = createCursorLocalProviderCapabilities(profile(fixture.spawn));
    const request = requestForSession(fixture.spawn);

    await adapter.transcript.readRange({
      ...request,
      session: {
        ...request.session,
        sessionParams: { ...request.session.sessionParams, cursorAcpAuthMethodId: "organization_login" },
      },
    });

    expect(fixture.requests.map((item) => item.method)).toEqual([
      "initialize", "initialized", "authenticate", "session/load",
    ]);
    expect(fixture.requests.find((item) => item.method === "authenticate")?.params).toEqual({ methodId: "organization_login" });
  });

  it("fails closed when multiple alternative methods need an explicit choice", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult([
          { id: "organization_login", name: "Organization Login" },
          { id: "device_code", name: "Device Code" },
        ]) })}\n`);
      }
    });
    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn),
      binding,
      prompt: "hello",
      model: "",
      onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_protocol-mismatch" });
    expect(result.errorMessage).toContain("configure one explicitly");
    expect(fixture.requests.map((request) => request.method)).toEqual(["initialize", "initialized"]);
  });

  it("does not authenticate when the provider advertises no auth methods", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult([]) })}\n`);
      } else if (request.method === "session/new") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "no-auth-session" } })}\n`);
      } else if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "no-auth-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        } })}\n`);
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })}\n`);
      }
    });
    const result = await executeCursorNativeChat({
      profile: { ...profile(fixture.spawn), authMethodId: "cursor_login" },
      binding,
      prompt: "hello",
      model: "",
      onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 0, sessionId: "no-auth-session" });
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize", "initialized", "session/new", "session/prompt",
    ]);
    expect(result.sessionParams).not.toHaveProperty("cursorAcpAuthMethodId");
  });

  it("reports request timeouts accurately with secret-free diagnostics", async () => {
    const secret = "cursor-acp-test-secret";
    const logs: string[] = [];
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      }
    });
    const result = await executeCursorNativeChat({
      profile: { ...profile(fixture.spawn), requestTimeoutMs: 250, env: { CURSOR_API_KEY: secret } },
      binding,
      prompt: "hello",
      model: "",
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: true,
      errorCode: "cursor_native_timeout",
    });
    expect(result.errorMessage).toContain("session/new timed out after 250ms");
    expect(result.errorMessage).not.toContain(secret);
    expect(result.resultJson).toMatchObject({
      acpTimeout: { method: "session/new", timeoutMs: 250, durationMs: expect.any(Number) },
      acpRequestTrace: [
        { method: "initialize", status: "completed", durationMs: expect.any(Number) },
        { method: "session/new", status: "timed_out", durationMs: expect.any(Number) },
      ],
    });
    expect(JSON.stringify(result.resultJson)).not.toContain(secret);
    expect(logs.join("\n")).toContain("session/new timed out after 250ms");
    expect(logs.join("\n")).not.toContain(secret);
    expect(fixture.requests.map((request) => request.method)).toEqual(["initialize", "initialized", "session/new"]);
  });

  it("retains the exact authentication timeout boundary without request or response payloads", async () => {
    const secret = "cursor-login-test-secret";
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult([{ id: "cursor_login" }]) })}\n`);
      }
    });
    const result = await executeCursorNativeChat({
      profile: { ...profile(fixture.spawn), requestTimeoutMs: 250, env: { CURSOR_API_KEY: secret } },
      binding,
      prompt: secret,
      model: "",
      onLog: async () => {},
    });

    expect(result).toMatchObject({ timedOut: true, errorCode: "cursor_native_timeout" });
    expect(result.resultJson).toMatchObject({
      acpTimeout: { method: "authenticate", timeoutMs: 250, durationMs: expect.any(Number) },
      acpRequestTrace: [
        { method: "initialize", status: "completed", durationMs: expect.any(Number) },
        { method: "authenticate", status: "timed_out", durationMs: expect.any(Number) },
      ],
    });
    expect(JSON.stringify(result.resultJson)).not.toContain(secret);
    expect(fixture.requests.map((request) => request.method)).toEqual(["initialize", "initialized", "authenticate"]);
  });

  it("classifies a missing provider session and refuses profile/cwd mismatches", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "session/load") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Session not found" } })}\n`);
      }
    });
    const adapter = createCursorLocalProviderCapabilities(profile(fixture.spawn));

    const missing = await adapter.transcript.readRange(requestForSession(fixture.spawn));
    const wrongProfile = await adapter.transcript.readRange({
      ...requestForSession(fixture.spawn),
      binding: { ...binding, profileId: "other-profile" },
    });
    const wrongCwd = await adapter.transcript.readRange({
      ...requestForSession(fixture.spawn),
      session: {
        ...requestForSession(fixture.spawn).session,
        sessionParams: { ...requestForSession(fixture.spawn).session.sessionParams, cwd: "/tmp/other-project" },
      },
    });

    expect(missing.availability).toBe("missing");
    expect(missing.revision).toContain("missing-session");
    expect(wrongProfile).toMatchObject({ availability: "incompatible", revision: "profile-mismatch" });
    expect(wrongCwd).toMatchObject({ availability: "incompatible", revision: "session-cwd-mismatch" });
    expect(fixture.requests.filter((request) => typeof request.id === "number")).toHaveLength(2);
  });

  it("reports the ACP-backed control limits as unsupported with provider evidence", () => {
    const fixture = createSpawnFixture(() => undefined);
    const adapter = createCursorLocalProviderCapabilities(profile(fixture.spawn));

    expect(adapter.fork.evidence).toMatchObject({
      status: "unsupported",
      providerVersion: "2026.06.19-20-24-33-653a7fb",
      transport: "cursor-agent-acp-stdio",
    });
    expect(adapter.fork.evidence.reason).toContain("no verified native boundary fork");
    expect(adapter.control.steer.evidence.status).toBe("unsupported");
    expect(adapter.control.steer.evidence.reason).toContain("no verified native steer");
    expect(adapter.control.steer.mode).toBeUndefined();
    expect(adapter.control.interrupt.mode).toBeUndefined();
  });

  it("persists only non-secret ACP profile metadata with the session", () => {
    const serialized = sessionCodec.serialize({
      sessionId: "cursor-session-1",
      cwd: "/tmp/cursor-project",
      profileHostId: binding.hostId,
      profileId: binding.profileId,
      capabilityRevision: binding.capabilityRevision,
      cursorAcpTransport: "cursor-agent-acp-stdio",
      cursorAcpCommand: "agent",
      cursorAcpProtocolVersion: 1,
      cursorAcpAuthMethodId: "cursor_login",
      cursorProviderVersion: "2026.06.19-20-24-33-653a7fb",
      CURSOR_API_KEY: "must-not-persist",
    });

    expect(serialized).toMatchObject({
      sessionId: "cursor-session-1",
      profileHostId: binding.hostId,
      profileId: binding.profileId,
      cursorAcpTransport: "cursor-agent-acp-stdio",
      cursorAcpProtocolVersion: 1,
      cursorAcpAuthMethodId: "cursor_login",
    });
    expect(serialized).not.toHaveProperty("CURSOR_API_KEY");
    expect(sessionCodec.deserialize(serialized)).toMatchObject({ cursorAcpCommand: "agent" });
  });

  it("rejects persisted ACP command, protocol, auth, and provider-version drift", async () => {
    const fixture = createSpawnFixture(() => undefined);
    const adapter = createCursorLocalProviderCapabilities({ ...profile(fixture.spawn), authMethodId: "cursor_login" });
    const base = requestForSession(fixture.spawn);
    const mismatch = async (field: string, value: unknown) => adapter.transcript.readRange({
      ...base,
      session: { ...base.session, sessionParams: { ...base.session.sessionParams, [field]: value } },
    });

    await expect(mismatch("cursorAcpCommand", "cursor-agent")).resolves.toMatchObject({ revision: "command-mismatch" });
    await expect(mismatch("cursorAcpProtocolVersion", 2)).resolves.toMatchObject({ revision: "protocol-version-mismatch" });
    await expect(mismatch("cursorAcpAuthMethodId", "other-login")).resolves.toMatchObject({ revision: "auth-method-mismatch" });
    await expect(mismatch("cursorProviderVersion", "older-version")).resolves.toMatchObject({ revision: "provider-version-mismatch" });
    expect(fixture.requests).toHaveLength(0);
  });

  it("binds session resume to ACP while keeping CLI input evidence separate", () => {
    const fixture = createSpawnFixture(() => undefined);
    const adapter = createCursorLocalProviderCapabilities(profile(fixture.spawn));

    expect(adapter.sessionResume.evidence).toMatchObject({
      status: "supported",
      transport: "cursor-agent-acp-stdio",
      profileBound: true,
      profileRequired: true,
    });
    expect(adapter.input.evidence.transport).toBe("cursor-agent-cli");
    expect(adapter.contextHandoff.evidence.transport).toBe("cursor-agent-cli");
    expect(adapter.transcript.evidence.transport).toBe("cursor-agent-acp-stdio");
  });

  it("does not claim CLI support when the profile version is not available", () => {
    const fixture = createSpawnFixture(() => undefined);
    const adapter = createCursorLocalProviderCapabilities({ ...profile(fixture.spawn), providerVersion: "" });

    expect(adapter.input.evidence).toMatchObject({ status: "unknown", profileBound: true, transport: "cursor-agent-cli" });
    expect(adapter.sessionResume.evidence.status).toBe("unknown");
    expect(adapter.transcript.evidence.status).toBe("unknown");
  });

  it("exposes a profile resolver while preserving unknown before binding", () => {
    const fixture = createSpawnFixture(() => undefined);
    const resolver = createCursorLocalProviderCapabilityResolver(() => profile(fixture.spawn));

    expect(resolver("cursor", binding)?.transcript.readRange).toBeTypeOf("function");
    expect(resolver("cursor", null)?.transcript.evidence.status).toBe("unknown");
    expect(resolver("hermes_gateway", binding)).toBeNull();
  });

  it("cancels the live ACP prompt without claiming a successful turn", async () => {
    let handle: AgentRuntimeControlHandle | null = null;
    let promptId: unknown;
    let released = false;
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "session/prompt") {
        promptId = request.id;
        void handle!.interrupt("operator_stop");
        return;
      }
      if (request.method === "session/cancel") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } })}\n`);
        return;
      }
      const result = request.method === "initialize" ? initializeResult()
        : request.method === "session/new" ? { sessionId: "cancel-session" } : {};
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
    const result = await executeCursorNativeChat({ profile: profile(fixture.spawn), binding,
      prompt: "run", model: "", onLog: async () => {},
      controlAttempt: { ownerToken: "owner-1", attemptEpoch: 1, complete: async () => {},
        register: async (value) => { handle = value; return { isCurrent: () => true, release: async () => { released = true; } }; } },
    });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_incomplete_turn", sessionId: "cancel-session" });
    expect(fixture.requests.filter((request) => request.method === "session/cancel")).toEqual([
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "cancel-session" } },
    ]);
    expect(released).toBe(true);
  });

  it.each(["approved", "rejected", "stale"])("fences ACP permission response: %s", async (decision) => {
    let promptId: unknown;
    let current = true;
    const approvals: unknown[] = [];
    const fixture = createSpawnFixture((request, output) => {
      if (!request.method) {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } })}\n`);
        return;
      }
      if (request.method === "session/prompt") {
        promptId = request.id;
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "permission-session", update: { sessionUpdate: "agent_message_chunk", executionRef: "permission-execution", content: { type: "text", text: "done" } } },
        })}\n`);
        const permission = { jsonrpc: "2.0", id: request.id, method: "session/request_permission", params: {
          sessionId: "permission-session", toolCall: { title: "Read file", token: "secret-value" },
          options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }],
        } };
        output.write(`${JSON.stringify(permission)}\n${JSON.stringify(permission)}\n`);
        return;
      }
      const result = request.method === "initialize" ? initializeResult()
        : request.method === "session/new" ? { sessionId: "permission-session" } : {};
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
    const result = await executeCursorNativeChat({ profile: profile(fixture.spawn), binding,
      prompt: "read", model: "", onLog: async () => {},
      controlAttempt: { ownerToken: "owner-1", attemptEpoch: 1, complete: async () => {},
        register: async () => ({ isCurrent: () => current, release: async () => {} }) },
      requestApproval: async (request) => { approvals.push(request); return { id: "approval-1", status: "pending" }; },
      waitForApproval: async () => {
        if (decision === "stale") current = false;
        return { id: "approval-1", status: decision === "rejected" ? "rejected" : "approved" };
      },
    });
    expect(result.sessionId).toBe("permission-session");
    expect(approvals).toHaveLength(1);
    expect(JSON.stringify(approvals)).not.toContain("secret-value");
    const responses = fixture.requests.filter((request) => !request.method);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.result).toEqual({ outcome: decision === "approved"
      ? { outcome: "selected", optionId: "once" } : { outcome: "cancelled" } });
  });

  it("replays a completed permission response for a late duplicate request ID", async () => {
    const permissionId = "permission-retry";
    let promptId: unknown;
    let permissionResponseCount = 0;
    const permission = { jsonrpc: "2.0", id: permissionId, method: "session/request_permission", params: {
      sessionId: "permission-retry-session",
      toolCall: { title: "Read file" },
      options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }],
    } };
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "session/new") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "permission-retry-session" } })}\n`);
      } else if (request.method === "session/prompt") {
        promptId = request.id;
        output.write(`${JSON.stringify(permission)}\n`);
      } else if (!request.method && request.id === permissionId) {
        permissionResponseCount += 1;
        if (permissionResponseCount === 1) {
          queueMicrotask(() => output.write(`${JSON.stringify(permission)}\n`));
        } else if (permissionResponseCount === 2) {
          output.write(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "permission-retry-session", update: { sessionUpdate: "agent_message_chunk", executionRef: "permission-retry-execution", content: { type: "text", text: "done" } } },
          })}\n`);
          output.write(`${JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } })}\n`);
        }
      }
    });
    const approvals: unknown[] = [];
    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn),
      binding,
      prompt: "read",
      model: "",
      onLog: async () => {},
      controlAttempt: {
        ownerToken: "owner-1",
        attemptEpoch: 1,
        complete: async () => {},
        register: async () => ({ isCurrent: () => true, release: async () => {} }),
      },
      requestApproval: async (request) => {
        approvals.push(request);
        return { id: "approval-retry", status: "approved" };
      },
      waitForApproval: async () => ({ id: "approval-retry", status: "approved" }),
    });

    expect(result.exitCode).toBe(0);
    expect(approvals).toHaveLength(1);
    const responses = fixture.requests.filter((request) => !request.method && request.id === permissionId);
    expect(responses).toHaveLength(2);
    expect(responses[0]?.result).toEqual(responses[1]?.result);
  });

  it("returns an internal JSON-RPC error when the approval bridge fails", async () => {
    const permissionId = "permission-error";
    let promptId: unknown;
    const permission = { jsonrpc: "2.0", id: permissionId, method: "session/request_permission", params: {
      sessionId: "permission-error-session",
      toolCall: { title: "Read file" },
      options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }],
    } };
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "session/new") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "permission-error-session" } })}\n`);
      } else if (request.method === "session/prompt") {
        promptId = request.id;
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "permission-error-session", update: { sessionUpdate: "agent_message_chunk", executionRef: "permission-error-execution", content: { type: "text", text: "done" } } },
        })}\n`);
        output.write(`${JSON.stringify(permission)}\n`);
      } else if (!request.method && request.id === permissionId) {
        if ((request.error as JsonRecord | undefined)?.code === -32603) {
          output.write(`${JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } })}\n`);
        }
      }
    });
    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn),
      binding,
      prompt: "read",
      model: "",
      onLog: async () => {},
      controlAttempt: {
        ownerToken: "owner-1",
        attemptEpoch: 1,
        complete: async () => {},
        register: async () => ({ isCurrent: () => true, release: async () => {} }),
      },
      requestApproval: async () => { throw new Error("approval bridge unavailable"); },
      waitForApproval: async () => ({ id: "unused", status: "approved" }),
    });

    expect(result.exitCode).toBe(0);
    const response = fixture.requests.find((request) => !request.method && request.id === permissionId);
    expect(response?.error).toMatchObject({ code: -32603 });
  });

  it.each(["cancelled", "max_tokens", "refusal", null])("does not mark stop reason %s as a completed turn", async (stopReason) => {
    const fixture = createSpawnFixture((request, output) => {
      const result = request.method === "initialize" ? initializeResult()
        : request.method === "session/new" ? { sessionId: "incomplete-session" }
        : request.method === "session/prompt" ? { stopReason } : {};
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
    const result = await executeCursorNativeChat({ profile: profile(fixture.spawn), binding,
      prompt: "hello", model: "", onLog: async () => {} });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_incomplete_turn", sessionId: "incomplete-session" });
  });

  it("preserves a newly created session when its first prompt fails", async () => {
    const fixture = createSpawnFixture((request, output) => {
      const result = request.method === "initialize" ? initializeResult()
        : request.method === "session/new" ? { sessionId: "accepted-session" } : {};
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
        ...(request.method === "session/prompt" ? { error: { code: -32000, message: "provider unavailable" } } : { result }),
      })}\n`);
    });
    const result = await executeCursorNativeChat({ profile: profile(fixture.spawn), binding,
      prompt: "hello", model: "", onLog: async () => {} });
    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBe("accepted-session");
    expect(result.sessionParams?.sessionId).toBe("accepted-session");
  });

  it("does not confuse provider request IDs or replayed history with current execution", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (!request.method) return;
      if (request.method === "session/load" || request.method === "session/prompt") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "cursor-session-1", update: { sessionUpdate: "agent_message_chunk", ...(request.method === "session/prompt" ? { executionRef: "cursor-execution-2" } : {}), content: {
            type: "text", text: request.method === "session/load" ? "OLD RESPONSE" : "new answer",
          } },
        } })}\n`);
      }
      if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, method: "unimplemented/provider_request", params: {} })}\n`);
      }
      const result = request.method === "initialize" ? initializeResult()
        : request.method === "session/load" ? loadedSessionResult()
          : request.method === "session/prompt" ? { stopReason: "end_turn" } : {};
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
    const session = requestForSession(fixture.spawn).session;
    const result = await executeCursorNativeChat({ profile: profile(fixture.spawn), binding,
      sessionId: session.sessionId, sessionParams: session.sessionParams,
      prompt: "next", model: "", onLog: async () => {} });
    expect(result).toMatchObject({ exitCode: 0, summary: "new answer" });
    expect(fixture.requests.some((request) => (request.error as JsonRecord)?.code === -32601)).toBe(true);
  });

  it("executes chat through ACP session/new and session/prompt without CLI fallback", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "authenticate") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
      } else if (request.method === "session/new") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "cursor-native-new" } })}\n`);
      } else if (request.method === "session/set_model") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
      } else if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "cursor-native-new",
            update: { sessionUpdate: "agent_message_chunk", executionRef: "cursor-native-execution", content: { type: "text", text: " ACP answer " } },
          },
        })}\n`);
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })}\n`);
      }
    });
    const logs: string[] = [];
    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn),
      binding,
      workspace: { workspaceId: "workspace-1", repoUrl: "https://example.invalid/repo", repoRef: "main" },
      prompt: "Inspect this repository.",
      model: "auto",
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });

    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "cursor-native-new",
      summary: " ACP answer ",
      resultJson: { transport: "cursor-agent-acp-stdio", nativeSession: true },
    });
    expect(result.sessionParams).toMatchObject({
      sessionId: "cursor-native-new",
      cursorAcpTransport: "cursor-agent-acp-stdio",
      workspaceId: "workspace-1",
      repoUrl: "https://example.invalid/repo",
      repoRef: "main",
    });
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "session/new",
      "session/set_model",
      "session/prompt",
    ]);
    expect(fixture.requests[3]?.params).toEqual({ sessionId: "cursor-native-new", modelId: "auto" });
    expect(fixture.requests[4]?.params).toEqual({
      sessionId: "cursor-native-new",
      prompt: [{ type: "text", text: "Inspect this repository." }],
    });
    expect(logs.join(" ")).toContain("Cursor native chat completed");
  });

  it("passes configured HTTP/SSE MCP servers to session/new and session/load without persisting credentials", async () => {
    const mcpServers = [
      { name: "docs", type: "http", url: "https://docs.example.test/mcp", headers: { Authorization: "Bearer mcp-secret" } },
      { name: "events", type: "sse", url: "https://events.example.test/sse" },
    ];
    expect(normalizeCursorAcpMcpServers(mcpServers)).toEqual(mcpServers);
    expect(() => normalizeCursorAcpMcpServers([
      { name: "local", type: "stdio", url: "https://local.example.test/mcp", command: "node", args: ["server.js"] },
    ])).toThrow("only advertises HTTP/SSE");

    const makeFixture = () => createSpawnFixture((request, output) => {
      const result = request.method === "initialize" ? initializeResult()
        : request.method === "session/new" ? { sessionId: "mcp-session" }
          : request.method === "session/load" ? { sessionId: "mcp-session", modes: {} }
            : request.method === "session/prompt" ? { stopReason: "end_turn" } : {};
      if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "mcp-session", update: {
            sessionUpdate: "agent_message_chunk", executionRef: "mcp-execution",
            content: { type: "text", text: "done" },
          },
        } })}\n`);
      }
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });

    const createdFixture = makeFixture();
    const mcpProfile = { ...profile(createdFixture.spawn), mcpServers };
    const created = await executeCursorNativeChat({
      profile: mcpProfile,
      binding,
      prompt: "Use the configured MCPs.",
      model: "",
      onLog: async () => {},
    });
    expect(created.exitCode).toBe(0);
    expect(createdFixture.requests.find((request) => request.method === "session/new")?.params).toMatchObject({ mcpServers });
    expect(JSON.stringify(created.sessionParams)).not.toContain("mcp-secret");
    expect(JSON.stringify(created.sessionParams)).not.toContain("mcpServers");

    const loadedFixture = makeFixture();
    const loaded = await executeCursorNativeChat({
      profile: { ...profile(loadedFixture.spawn), mcpServers },
      binding,
      sessionId: "mcp-session",
      sessionParams: created.sessionParams,
      prompt: "Continue.",
      model: "",
      onLog: async () => {},
    });
    expect(loaded.exitCode).toBe(0);
    expect(loadedFixture.requests.find((request) => request.method === "session/load")?.params).toMatchObject({ mcpServers });
  });

  it("redacts configured MCP header secrets from provider errors", async () => {
    const secret = "opaque-mcp-secret";
    const fixture = createSpawnFixture((request, output) => {
      const result = request.method === "initialize" ? initializeResult()
        : request.method === "session/new" ? { sessionId: "mcp-error-session" }
          : {};
      if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({
          jsonrpc: "2.0", id: request.id, error: { code: -32000, message: `MCP failed: ${secret}` },
        })}\n`);
      } else {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      }
    });

    const result = await executeCursorNativeChat({
      profile: {
        ...profile(fixture.spawn),
        mcpServers: [{ name: "docs", url: "https://docs.example.test/mcp", headers: { Authorization: `Bearer ${secret}` } }],
      },
      binding,
      prompt: "Use docs.",
      model: "",
      onLog: async () => {},
    });

    expect(result.errorMessage).toBeTruthy();
    expect(result.errorMessage).not.toContain(secret);
  });

  it("applies an explicitly selected ACP mode before sending the prompt", async () => {
    const fixture = createSpawnFixture((request, output) => {
      const result = request.method === "initialize" ? initializeResult()
        : request.method === "session/new" ? { sessionId: "mode-session", modes: {
          currentModeId: "agent",
          availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }],
        } }
          : request.method === "session/prompt" ? { stopReason: "end_turn" } : {};
      if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "mode-session", update: { sessionUpdate: "agent_message_chunk", executionRef: "mode-execution", content: { type: "text", text: "plan" } },
        } })}\n`);
      }
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn), binding, prompt: "Plan this change.", model: "", mode: "plan", onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 0, resultJson: { modeId: "plan" } });
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize", "initialized", "session/new", "session/set_mode", "session/prompt",
    ]);
    expect(fixture.requests[3]?.params).toEqual({ sessionId: "mode-session", modeId: "plan" });
  });

  it("fails closed when the requested ACP mode is not advertised", async () => {
    const fixture = createSpawnFixture((request, output) => {
      const result = request.method === "initialize" ? initializeResult()
        : request.method === "session/new" ? { sessionId: "mode-session", modes: {
          currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }],
        } } : {};
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn), binding, prompt: "Ask this question.", model: "", mode: "ask", onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_unsupported" });
    expect(fixture.requests.some((request) => request.method === "session/prompt")).toBe(false);
  });

  it.each(["approved", "cancelled", "invalid-answer"] as const)("bridges cursor/ask_question as a typed user request (%s)", async (status) => {
    const nativeRequestId = "cursor-question-request";
    let providerResponse: JsonRecord | undefined;
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "session/new") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "question-session" } })}\n`);
      } else if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: nativeRequestId, method: "cursor/ask_question", params: {
          toolCallId: "tool-question", title: "Choose a direction", questions: [{ id: "q1", prompt: "Which mode?", options: [
            { id: "plan", label: "Plan" }, { id: "agent", label: "Agent" },
          ], allowMultiple: false }],
        } })}\n`);
      } else if (!request.method && request.id === nativeRequestId) {
        providerResponse = request;
        output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "question-session", update: { sessionUpdate: "agent_message_chunk", executionRef: "question-execution", content: { type: "text", text: "done" } },
        } })}\n`);
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: fixture.requests.find((entry) => entry.method === "session/prompt")?.id, result: { stopReason: "end_turn" } })}\n`);
      }
    });
    const approvals: Array<{ inputRequest?: ChatAskUserRequest }> = [];
    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn), binding, prompt: "Choose.", model: "", onLog: async () => {},
      requestApproval: async (approval) => { approvals.push(approval); return { id: "ask-approval", status: "pending" }; },
      waitForApproval: async () => ({
        id: "ask-approval",
        status: status === "cancelled" ? "cancelled" : "approved",
        ...(status !== "cancelled" ? { inputResponse: { answers: [{
          questionId: "q1", optionIds: [status === "invalid-answer" ? "not-offered" : "plan"],
        }] } } : {}),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(approvals[0]?.inputRequest).toEqual({ questions: [{
      id: "q1", header: "Choose a direction", question: "Which mode?",
      options: [{ id: "plan", label: "Plan" }, { id: "agent", label: "Agent" }],
      selectionMode: "single", allowFreeform: false,
    }] });
    expect(providerResponse?.result).toEqual(status === "approved"
      ? { outcome: { outcome: "answered", answers: [{ questionId: "q1", selectedOptionIds: ["plan"] }] } }
      : status === "cancelled"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "skipped", reason: "Rudder structured answer could not be validated." } });
  });

  it.each(["approved", "rejected", "cancelled"] as const)("bridges cursor/create_plan approval (%s)", async (status) => {
    const nativeRequestId = "cursor-plan-request";
    let providerResponse: JsonRecord | undefined;
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "session/new") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "plan-session" } })}\n`);
      } else if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: nativeRequestId, method: "cursor/create_plan", params: {
          toolCallId: "tool-plan", name: "Change settings", overview: "Preserve behavior.", plan: "1. Inspect\n2. Test",
          todos: [{ id: "todo-1", content: "Inspect", status: "in_progress" }], isProject: false,
        } })}\n`);
      } else if (!request.method && request.id === nativeRequestId) {
        providerResponse = request;
        output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "plan-session", update: { sessionUpdate: "agent_message_chunk", executionRef: "plan-execution", content: { type: "text", text: "done" } },
        } })}\n`);
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: fixture.requests.find((entry) => entry.method === "session/prompt")?.id, result: { stopReason: "end_turn" } })}\n`);
      }
    });
    const approvals: unknown[] = [];
    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn), binding, prompt: "Work.", model: "", onLog: async () => {},
      requestApproval: async (approval) => { approvals.push(approval); return { id: "plan-approval", status: "pending" }; },
      waitForApproval: async () => ({ id: "plan-approval", status, decisionNote: "Not yet" }),
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(approvals)).toContain("1. Inspect\\n2. Test");
    expect(providerResponse?.result).toEqual(status === "approved"
      ? { outcome: { outcome: "accepted" } }
      : status === "cancelled"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "rejected", reason: "Not yet" } });
  });

  it("logs Cursor extension notifications during the active prompt", async () => {
    const fixture = createSpawnFixture((request, output) => {
      const result = request.method === "initialize" ? initializeResult()
        : request.method === "session/new" ? { sessionId: "notification-session" }
          : request.method === "session/prompt" ? { stopReason: "end_turn" } : {};
      if (request.method === "session/prompt") {
        for (const method of ["cursor/update_todos", "cursor/task", "cursor/generate_image"]) {
          output.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: { description: "Visible notification" } })}\n`);
        }
        output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "notification-session", update: { sessionUpdate: "agent_message_chunk", executionRef: "notification-execution", content: { type: "text", text: "done" } },
        } })}\n`);
      }
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
    const logs: string[] = [];
    await executeCursorNativeChat({
      profile: profile(fixture.spawn), binding, prompt: "Work.", model: "", onLog: async (_stream, chunk) => { logs.push(chunk); },
    });

    expect(logs.join("")).toContain("cursor/update_todos");
    expect(logs.join("")).toContain("cursor/task");
    expect(logs.join("")).toContain("cursor/generate_image");
  });

  it("keeps provider turn success separate from an unavailable exact Run transcript boundary", async () => {
    const fixture = createSpawnFixture((request, output) => {
      const result = request.method === "initialize" ? initializeResult()
        : request.method === "session/new" ? { sessionId: "unscoped-session" }
          : request.method === "session/prompt" ? { stopReason: "end_turn" } : {};
      if (request.method === "session/prompt") {
        output.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "unscoped-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "unscoped answer" } } },
        })}\n`);
      }
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });

    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn),
      binding,
      prompt: "hello",
      model: "",
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      resultJson: {
        boundaryStatus: "missing",
        transcriptBoundary: { status: "missing" },
      },
    });
  });

  it("fails closed for unknown ACP sessions and never retries with session/new", async () => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "session/load") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Session not found" } })}\n`);
      }
    });
    const base = requestForSession(fixture.spawn);
    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn),
      binding,
      sessionId: base.session.sessionId,
      sessionParams: base.session.sessionParams,
      prompt: "must not become a fresh session",
      model: "auto",
      onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_missing-session" });
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "session/load",
    ]);
    expect(fixture.requests.some((request) => request.method === "session/new")).toBe(false);
    expect(fixture.requests.some((request) => request.method === "session/prompt")).toBe(false);
  });

  it.each([null, {}])("fails closed for an empty persisted session/load result %#", async (loadResult) => {
    const fixture = createSpawnFixture((request, output) => {
      if (request.method === "initialize") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initializeResult() })}\n`);
      } else if (request.method === "session/load") {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: loadResult })}\n`);
      }
    });
    const base = requestForSession(fixture.spawn);
    const result = await executeCursorNativeChat({
      profile: profile(fixture.spawn),
      binding,
      sessionId: base.session.sessionId,
      sessionParams: base.session.sessionParams,
      prompt: "must not run",
      model: "",
      onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 1, errorCode: "cursor_native_protocol-mismatch" });
    expect(fixture.requests.map((request) => request.method)).toEqual(["initialize", "initialized", "session/load"]);
    expect(fixture.requests.some((request) => request.method === "session/prompt")).toBe(false);
  });

  it("rejects host/profile/cwd/workspace/transport drift before starting ACP", async () => {
    const fixture = createSpawnFixture(() => undefined);
    const base = requestForSession(fixture.spawn);
    const run = (overrides: Partial<Parameters<typeof executeCursorNativeChat>[0]>) => executeCursorNativeChat({
      profile: profile(fixture.spawn),
      binding,
      sessionId: base.session.sessionId,
      sessionParams: base.session.sessionParams,
      workspace: { workspaceId: "workspace-1" },
      prompt: "must not spawn",
      model: "auto",
      onLog: async () => {},
      ...overrides,
    });

    await expect(run({ binding: { ...binding, hostId: "other-host" } })).resolves.toMatchObject({ errorCode: "cursor_native_protocol-mismatch" });
    await expect(run({ binding: { ...binding, profileId: "other-profile" } })).resolves.toMatchObject({ errorCode: "cursor_native_protocol-mismatch" });
    await expect(run({ sessionParams: { ...base.session.sessionParams, cwd: "/tmp/other-project" } })).resolves.toMatchObject({ errorCode: "cursor_native_protocol-mismatch" });
    await expect(run({ sessionParams: { ...base.session.sessionParams, workspaceId: "workspace-2" } })).resolves.toMatchObject({ errorCode: "cursor_native_protocol-mismatch" });
    await expect(run({ sessionParams: { ...base.session.sessionParams, cursorAcpTransport: "cursor-agent-cli" } })).resolves.toMatchObject({ errorCode: "cursor_native_protocol-mismatch" });
    expect(fixture.requests).toHaveLength(0);
  });
});
