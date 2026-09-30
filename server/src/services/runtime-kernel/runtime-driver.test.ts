import {
  createCursorLocalProviderCapabilityResolver,
  sessionCodec as cursorSessionCodec,
  executeCursorNativeChat,
  type CursorLocalProfileTransport,
  type CursorProviderBindingRef,
} from "@rudderhq/agent-runtime-cursor-local/server";
import type {
  AgentRuntimeControlHandle,
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { executeAdapterWithModelFallbacks } from "./model-fallback.js";
import type { NativeSessionState, RuntimeBindingRecord } from "./native-session.js";
import {
  createRuntimeNativeTranscriptReaderHook,
  REGISTERED_RUNTIME_PROVIDER_CAPABILITY_ADAPTERS,
  type NativeTranscriptReadInput,
  type RuntimeProviderBindingRef,
  type RuntimeProviderCapabilityAdapter,
  type RuntimeProviderCapabilityResolverContext,
} from "./provider-capabilities.js";
import {
  createRuntimeDriver,
  getRuntimeDriver,
  listRuntimeDrivers,
  NATIVE_CHAT_RUNTIME_TYPES,
  type NativeChatRuntimeType,
  type RuntimeDriverRetentionService,
} from "./runtime-driver.js";
import type { UnifiedAgentRunEntry, UnifiedOwnerFence, UnifiedSubmission } from "./unified-agent-run.js";

const emptyResult: AgentRuntimeExecutionResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  summary: "ok",
};

function fakeContext(overrides: Partial<AgentRuntimeExecutionContext> = {}): AgentRuntimeExecutionContext {
  return {
    runId: "run-driver-test",
    agent: {
      id: "agent-driver-test",
      orgId: "org-driver-test",
      name: "Driver Test",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {},
    context: { chatMode: true, chatPrompt: "original" },
    onLog: async () => undefined,
    ...overrides,
  };
}

function fakeAdapter(
  type: NativeChatRuntimeType,
  execute: ServerAgentRuntimeModule["execute"] = async () => emptyResult,
): ServerAgentRuntimeModule {
  return {
    type,
    execute,
    testEnvironment: async () => ({
      agentRuntimeType: type,
      status: "pass",
      checks: [],
      testedAt: new Date().toISOString(),
    }),
  };
}

type CursorSpawn = NonNullable<CursorLocalProfileTransport["spawn"]>;

function createCursorAcpFixture(
  sessionId: string,
  responseText: string,
): { spawn: CursorSpawn; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  const spawn = ((_command: string, _args: readonly string[], _options: unknown) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>;
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
        requests.push(request);
        queueMicrotask(() => {
          const method = request.method;
          const id = request.id;
          let result: unknown = {};
          if (method === "initialize") {
            result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
          } else if (method === "session/new") {
            result = { sessionId };
          } else if (method === "session/load") {
            result = { sessionId, modes: {} };
          } else if (method === "session/prompt") {
            stdout.write(`${JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  executionRef: `execution-${responseText}`,
                  content: { type: "text", text: responseText },
                },
              },
            })}\n`);
            result = { stopReason: "end_turn" };
          } else if (typeof method !== "string" || id === undefined) {
            return;
          }
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
        });
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
  }) as unknown as CursorSpawn;
  return { spawn, requests };
}

describe("runtime driver facade", () => {
  it("covers exactly the requested native-chat runtimes", () => {
    expect(NATIVE_CHAT_RUNTIME_TYPES).toEqual([
      "codex_local",
      "claude_local",
      "hermes_gateway",
      "opencode_local",
      "pi_local",
      "cursor",
    ]);
    expect(listRuntimeDrivers().map((driver) => driver.runtimeType)).toEqual(NATIVE_CHAT_RUNTIME_TYPES);
  });

  it("publishes capability gaps instead of treating every adapter as fully native", () => {
    const expected = {
      codex_local: { input: "supported", context: "supported", resume: "unknown", control: "unknown", steer: "unknown", fork: "unknown", transcript: "unknown" },
      claude_local: { input: "supported", context: "supported", resume: "unknown", control: "unknown", steer: "unknown", fork: "unknown", transcript: "unknown" },
      hermes_gateway: { input: "supported", context: "supported", resume: "unknown", control: "unknown", steer: "unsupported", fork: "unknown", transcript: "unknown" },
      opencode_local: { input: "unknown", context: "unknown", resume: "unknown", control: "unknown", steer: "unknown", fork: "unknown", transcript: "unknown" },
      pi_local: { input: "unknown", context: "unknown", resume: "unknown", control: "unknown", steer: "unknown", fork: "unknown", transcript: "unknown" },
      cursor: { input: "supported", context: "supported", resume: "unknown", control: "unknown", steer: "unknown", fork: "unknown", transcript: "unknown" },
    } as const;

    expect(REGISTERED_RUNTIME_PROVIDER_CAPABILITY_ADAPTERS.map((adapter) => adapter.runtimeType)).toEqual([
      "codex_local",
      "claude_local",
      "hermes_gateway",
      "opencode_local",
      "pi_local",
      "cursor",
    ]);
    const codexRegistration = REGISTERED_RUNTIME_PROVIDER_CAPABILITY_ADAPTERS.find((adapter) => adapter.runtimeType === "codex_local");
    const hermesRegistration = REGISTERED_RUNTIME_PROVIDER_CAPABILITY_ADAPTERS.find((adapter) => adapter.runtimeType === "hermes_gateway");
    expect(codexRegistration?.control?.steer?.execute).toEqual(expect.any(Function));
    expect(codexRegistration?.control?.interrupt?.execute).toEqual(expect.any(Function));
    expect(hermesRegistration?.control?.interrupt?.execute).toEqual(expect.any(Function));
    expect(hermesRegistration?.control?.steer?.evidence.status).toBe("unsupported");
    for (const runtimeType of NATIVE_CHAT_RUNTIME_TYPES) {
      const driver = getRuntimeDriver(runtimeType);
      expect(driver).not.toBeNull();
      expect(driver?.capabilities.input.status).toBe(expected[runtimeType].input ?? "supported");
      expect(driver?.capabilities.sessionResume.status).toBe(expected[runtimeType].resume);
      expect(driver?.capabilities.control.status).toBe(expected[runtimeType].control);
      expect(driver?.capabilities.control.steer.status).toBe(expected[runtimeType].steer);
      expect(driver?.capabilities.fork.status).toBe(expected[runtimeType].fork);
      expect(driver?.capabilities.transcriptRange.status).toBe(expected[runtimeType].transcript);
      expect(driver?.capabilities.contextHandoff.status).toBe(expected[runtimeType].context ?? "supported");
    }
  });

  it("rejects non-native runtimes at the direct factory boundary", () => {
    for (const runtimeType of ["openclaw_gateway", "hermes_local", "process", "http"]) {
      expect(() => createRuntimeDriver(runtimeType)).toThrow(
        `Runtime type is not supported by the native chat driver: ${runtimeType}`,
      );
      expect(getRuntimeDriver(runtimeType)).toBeNull();
    }
  });

  it("does not infer capabilities from a registry codec when no provider declaration is resolved", () => {
    const driver = createRuntimeDriver("codex_local", {
      providerCapabilityResolver: vi.fn(() => null),
    });

    expect(driver.capabilities.sessionResume).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("provider-declared"),
    });
    expect(driver.capabilities.input).toMatchObject({ status: "unsupported" });
    expect(driver.resume({ sessionId: "thread-without-provider-declaration" })).toMatchObject({
      status: "unsupported",
      capability: "session_resume",
    });
  });

  it("passes the concrete binding to the injected profile resolver", () => {
    const binding = { hostId: "local", profileId: "codex-profile" };
    const resolver = vi.fn((_runtimeType: string, resolvedBinding?: { hostId: string; profileId: string } | null) => ({
      adapter: {
        runtimeType: "codex_local" as const,
        sessionResume: {
          evidence: {
            status: "supported" as const,
            reason: `thread/resume verified for ${resolvedBinding?.profileId ?? "missing"}`,
            transport: "app-server-stdio",
            profileBound: Boolean(resolvedBinding),
            profileRequired: true,
          },
        },
      },
      binding: resolvedBinding ?? null,
      profileResolved: Boolean(resolvedBinding),
    }));
    const driver = createRuntimeDriver("codex_local", {
      providerBinding: binding,
      providerCapabilityResolver: resolver,
    });

    expect(resolver).toHaveBeenCalledWith("codex_local", binding);
    expect(driver.capabilities.sessionResume).toMatchObject({ status: "supported" });
    expect(driver.resume({ sessionId: "thread-1" })).toMatchObject({
      status: "supported",
      value: { sessionId: "thread-1" },
    });
  });

  it("does not promote static declarations when a binding is present without a resolver", () => {
    const binding = { hostId: "local", profileId: "profile-1" };
    for (const runtimeType of [
      "codex_local",
      "claude_local",
      "hermes_gateway",
      "opencode_local",
      "pi_local",
      "cursor",
    ] as const) {
      const driver = getRuntimeDriver(runtimeType, { providerBinding: binding });
      expect(driver?.capabilities.transcriptRange.status).not.toBe("supported");
      expect(driver?.capabilities.fork.status).not.toBe("supported");
      expect(driver?.capabilities.control.status).not.toBe("supported");
    }
  });

  it("rejects an injected resolution whose attested profile does not match the requested binding", () => {
    const adapter: RuntimeProviderCapabilityAdapter = {
      runtimeType: "codex_local",
      transcript: {
        evidence: {
          status: "supported",
          reason: "bound transcript",
          profileBound: true,
          profileRequired: true,
        },
        readRange: vi.fn(),
      },
    };
    const driver = createRuntimeDriver("codex_local", {
      providerBinding: { hostId: "local", profileId: "requested" },
      providerCapabilityResolver: () => ({
        adapter,
        binding: { hostId: "local", profileId: "different" },
        profileResolved: true,
      }),
    });

    expect(driver.capabilities.transcriptRange.status).toBe("unsupported");
    expect(driver.capabilities.transcriptRange.reason).toMatch(/provider-declared|transcript/i);
  });

  it("normalizes provider session state through the adapter codec", () => {
    const providerBinding = { hostId: "local", profileId: "codex-profile" };
    const providerCapabilities: RuntimeProviderCapabilityAdapter = {
      runtimeType: "codex_local",
      sessionResume: {
        evidence: {
          status: "supported",
          reason: "Codex App Server thread/resume is verified for this profile.",
          transport: "app-server-stdio",
          profileBound: true,
          profileRequired: true,
        },
      },
    };
    const driver = createRuntimeDriver("codex_local", {
      providerBinding,
      providerCapabilityResolver: () => ({ adapter: providerCapabilities, binding: providerBinding, profileResolved: true }),
    });

    const resumed = driver?.resume({
      sessionParams: { session_id: "thread-1", cwd: "/workspace" },
    });
    expect(resumed).toEqual({
      status: "supported",
      value: {
        sessionId: "thread-1",
        sessionDisplayId: "thread-1",
        sessionParams: { sessionId: "thread-1", cwd: "/workspace" },
      },
    });
    expect(driver?.resume({ sessionParams: { cwd: "/workspace" } })).toMatchObject({
      status: "invalid",
      capability: "session_resume",
    });
  });

  it("re-resolves a persisted session and keeps an unknown resume capability closed", () => {
    const binding = { hostId: "local", profileId: "codex-profile", capabilityRevision: "cap-1" };
    const resolver = vi.fn((
      _runtimeType: string,
      resolvedBinding: RuntimeProviderBindingRef | null | undefined,
      context?: RuntimeProviderCapabilityResolverContext,
    ) => ({
      adapter: {
        runtimeType: "codex_local" as const,
        sessionResume: {
          evidence: {
            status: context?.session ? "unknown" as const : "supported" as const,
            reason: context?.session
              ? "The persisted Codex transport could not be verified."
              : "Codex resume is available for the profile.",
            transport: "codex-app-server-stdio",
            profileBound: true,
            profileRequired: true,
          },
        },
      },
      binding: resolvedBinding ?? null,
      profileResolved: Boolean(resolvedBinding),
    }));
    const driver = createRuntimeDriver("codex_local", {
      providerBinding: binding,
      providerCapabilityResolver: resolver,
    });

    const resumed = driver.resume({
      sessionParams: {
        sessionId: "thread-unknown",
        capabilityRevision: "cap-1",
        nativeTransport: "codex-app-server-stdio",
      },
    });

    expect(resumed).toMatchObject({
      status: "unknown",
      capability: "session_resume",
    });
    expect(resolver).toHaveBeenLastCalledWith(
      "codex_local",
      binding,
      { session: expect.objectContaining({ sessionId: "thread-unknown" }) },
    );
  });

  it("rejects persisted native session capability and transport mismatches", () => {
    const binding = { hostId: "local", profileId: "codex-profile", capabilityRevision: "cap-1" };
    const providerCapabilities: RuntimeProviderCapabilityAdapter = {
      runtimeType: "codex_local",
      sessionResume: {
        evidence: {
          status: "supported",
          reason: "Codex resume is verified for the profile.",
          transport: "codex-app-server-stdio",
          profileBound: true,
          profileRequired: true,
        },
      },
    };
    const driver = createRuntimeDriver("codex_local", {
      providerBinding: binding,
      providerCapabilityResolver: () => ({ adapter: providerCapabilities, binding, profileResolved: true }),
    });

    expect(driver.resume({
      sessionParams: {
        sessionId: "thread-revision-mismatch",
        capabilityRevision: "cap-old",
        nativeTransport: "codex-app-server-stdio",
      },
    })).toMatchObject({
      status: "unsupported",
      capability: "session_resume",
      reason: expect.stringContaining("capability revision"),
    });
    expect(driver.resume({
      sessionParams: {
        sessionId: "thread-transport-mismatch",
        capabilityRevision: "cap-1",
        nativeTransport: "different-transport",
      },
    })).toMatchObject({
      status: "unsupported",
      capability: "session_resume",
      reason: expect.stringContaining("transport"),
    });
  });

  it("resumes a persisted Claude CLI session with the verified profile transport", () => {
    const binding = { hostId: "local", profileId: "claude-profile", capabilityRevision: "cap-1" };
    const driver = createRuntimeDriver("claude_local", {
      providerBinding: binding,
      providerCapabilityResolver: () => ({
        binding,
        profileResolved: true,
        adapter: {
          runtimeType: "claude_local",
          sessionResume: { evidence: {
            status: "supported",
            reason: "Claude CLI profile is verified.",
            transport: "claude-cli",
            profileBound: true,
            profileRequired: true,
          } },
        },
      }),
    });

    expect(driver.resume({ sessionParams: {
      sessionId: "claude-existing", transport: "claude_cli", capabilityRevision: "cap-1",
      lastUuid: "completed-assistant-1",
    } })).toMatchObject({
      status: "supported",
      value: { sessionId: "claude-existing", sessionParams: { lastUuid: "completed-assistant-1" } },
    });
  });

  it("admits the profile-bound legacy Cursor CLI handoff only when CLI is declared", () => {
    const binding = {
      id: "cursor-binding-1",
      orgId: "org-driver-test",
      hostId: "local",
      profileId: "cursor-profile",
      workspaceBindingId: "workspace-1",
      capabilityRevision: "cursor-cap-1",
    };
    const providerCapabilities: RuntimeProviderCapabilityAdapter = {
      runtimeType: "cursor",
      sessionResume: {
        evidence: {
          status: "supported",
          reason: "Cursor CLI resume is verified for this profile.",
          transport: "cursor-agent-cli",
          profileBound: true,
          profileRequired: true,
        },
      },
    };
    const driver = createRuntimeDriver("cursor", {
      adapter: { ...fakeAdapter("cursor"), sessionCodec: cursorSessionCodec },
      providerBinding: binding,
      providerCapabilityResolver: () => ({ adapter: providerCapabilities, binding, profileResolved: true }),
    });
    const resume = (cursorAcpTransport: string) => driver.resume({
      sessionParams: {
        sessionId: "cursor-session-1",
        profileHostId: "local",
        profileId: "cursor-profile",
        workspaceBindingId: "workspace-1",
        capabilityRevision: "cursor-cap-1",
        cursorAcpTransport,
      },
    });

    expect(resume("cursor-agent-cli-context-handoff")).toMatchObject({
      status: "supported",
      value: {
        sessionId: "cursor-session-1",
        sessionParams: { cursorAcpTransport: "cursor-agent-cli-context-handoff" },
      },
    });
    expect(resume("cursor-agent-acp-stdio")).toMatchObject({
      status: "unsupported",
      capability: "session_resume",
      reason: expect.stringContaining("transport"),
    });
    expect(resume("cursor-agent-cli-unverified")).toMatchObject({
      status: "unsupported",
      capability: "session_resume",
      reason: expect.stringContaining("transport"),
    });
  });

  it("submits two Cursor ACP turns through the driver with profile-bound resume", async () => {
    const binding: CursorProviderBindingRef = {
      id: "cursor-binding-driver-test",
      orgId: "org-driver-test",
      hostId: "local",
      profileId: "cursor-profile-driver-test",
      workspaceBindingId: "cursor-workspace-driver-test",
      capabilityRevision: "cursor-acp-v1",
    };
    const cwd = "/tmp/cursor-runtime-driver-test";
    const version = "2026.06.19-20-24-33-653a7fb";
    const firstFixture = createCursorAcpFixture("driver-acp-session", "first turn");
    const secondFixture = createCursorAcpFixture("driver-acp-session", "second turn");
    const fixtures = [firstFixture, secondFixture];
    let executionIndex = 0;
    const execute = async (context: AgentRuntimeExecutionContext) => {
      const fixture = fixtures[executionIndex++];
      if (!fixture) throw new Error("Unexpected Cursor ACP adapter execution.");
      return executeCursorNativeChat({
        profile: { binding, cwd, providerVersion: version, command: "agent", spawn: fixture.spawn },
        binding,
        sessionId: context.runtime.sessionId,
        sessionParams: context.runtime.sessionParams as Record<string, unknown> | null,
        workspace: { workspaceBindingId: binding.workspaceBindingId },
        prompt: String(context.context.chatPrompt ?? ""),
        model: "",
        onLog: context.onLog,
      });
    };
    const nativeResolver = createCursorLocalProviderCapabilityResolver((requestedBinding) => ({
      binding: requestedBinding,
      cwd,
      providerVersion: version,
      command: "agent",
      spawn: firstFixture.spawn,
    }));
    const providerCapabilityResolver = (
      runtimeType: string,
      resolvedBinding: RuntimeProviderBindingRef | null | undefined,
    ) => {
      const adapter = nativeResolver(runtimeType, resolvedBinding);
      return adapter && resolvedBinding
        ? { adapter, binding: resolvedBinding, profileResolved: true }
        : null;
    };
    const driver = createRuntimeDriver("cursor", {
      adapter: { ...fakeAdapter("cursor", execute), sessionCodec: cursorSessionCodec },
      providerBinding: binding,
      providerCapabilityResolver,
    });
    const context = fakeContext({
      agent: {
        id: "agent-driver-test",
        orgId: "org-driver-test",
        name: "Cursor Driver Test",
        agentRuntimeType: "cursor",
        agentRuntimeConfig: {},
      },
    });

    const first = await driver.submitInput({ context, input: { text: "first turn" } });
    expect(first).toMatchObject({ exitCode: 0, sessionId: "driver-acp-session" });
    expect(first.sessionParams).toMatchObject({
      cursorAcpTransport: "cursor-agent-acp-stdio",
      profileHostId: binding.hostId,
      profileId: binding.profileId,
      capabilityRevision: binding.capabilityRevision,
    });

    const cursorCapabilities = nativeResolver("cursor", binding);
    expect(cursorCapabilities).not.toBeNull();
    expect(cursorCapabilities!.sessionResume.evidence.status).toBe("unknown");
    await cursorCapabilities!.transcript.readRange({
      runtimeType: "cursor",
      session: {
        sessionId: "driver-acp-session",
        sessionParams: first.sessionParams ?? {},
        sessionDisplayId: "driver-acp-session",
      },
      binding,
      workspace: { workspaceBindingId: binding.workspaceBindingId },
    });
    expect(cursorCapabilities!.sessionResume.evidence).toMatchObject({
      status: "supported",
      profileBound: true,
      transport: "cursor-agent-acp-stdio",
    });
    expect(firstFixture.requests.map((request) => request.method)).toContain("session/load");

    const resumed = driver.resume({ sessionParams: first.sessionParams });
    expect(resumed).toMatchObject({ status: "supported", value: { sessionId: "driver-acp-session" } });
    if (resumed.status !== "supported") throw new Error("Cursor ACP session was not admitted for resume.");
    expect(driver.resume({
      sessionParams: {
        ...first.sessionParams,
        cursorAcpTransport: "cursor-agent-cli-context-handoff",
      },
    })).toMatchObject({ status: "supported" });
    expect(driver.resume({
      sessionParams: {
        ...first.sessionParams,
        cursorAcpTransport: "cursor-agent-acp-unknown",
      },
    })).toMatchObject({ status: "unsupported", capability: "session_resume" });
    expect(driver.resume({
      sessionParams: {
        ...first.sessionParams,
        profileId: "different-cursor-profile",
      },
    })).toMatchObject({
      status: "unsupported",
      capability: "session_resume",
      reason: expect.stringContaining("provider profile"),
    });
    const second = await driver.submitInput({
      context,
      session: resumed.value,
      input: { text: "second turn" },
    });

    expect(second).toMatchObject({ exitCode: 0, sessionId: "driver-acp-session" });
    expect(secondFixture.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "session/load",
      "session/prompt",
    ]);
    expect(secondFixture.requests.some((request) => request.method === "session/new")).toBe(false);
    expect(executionIndex).toBe(2);
  });

  it("treats an unknown capability revision as unavailable, not as a concrete mismatch", () => {
    const binding = { hostId: "local", profileId: "codex-profile", capabilityRevision: "unknown" };
    const providerCapabilities: RuntimeProviderCapabilityAdapter = {
      runtimeType: "codex_local",
      sessionResume: {
        evidence: {
          status: "supported",
          reason: "Codex resume is verified for the profile.",
          transport: "codex-app-server-stdio",
          profileBound: true,
          profileRequired: true,
        },
      },
    };
    const driver = createRuntimeDriver("codex_local", {
      providerBinding: binding,
      providerCapabilityResolver: () => ({ adapter: providerCapabilities, binding, profileResolved: true }),
    });

    expect(driver.resume({ sessionParams: { sessionId: "legacy-thread" } })).toMatchObject({ status: "supported" });
    expect(driver.resume({
      sessionParams: { sessionId: "revision-bound-thread", capabilityRevision: "cap-1" },
    })).toMatchObject({
      status: "unknown",
      capability: "session_resume",
      reason: expect.stringContaining("current provider binding does not"),
    });
  });

  it("does not turn an unknown native resume into a fresh driver submission", async () => {
    const execute = vi.fn(async () => emptyResult);
    const adapter = fakeAdapter("codex_local", execute);
    const binding = { hostId: "local", profileId: "codex-profile", capabilityRevision: "cap-1" };
    const resolver = (
      _runtimeType: string,
      resolvedBinding: RuntimeProviderBindingRef | null | undefined,
      context?: RuntimeProviderCapabilityResolverContext,
    ) => ({
      adapter: {
        runtimeType: "codex_local" as const,
        sessionResume: {
          evidence: {
            status: context?.session ? "unknown" as const : "supported" as const,
            reason: "The persisted Codex resume capability is not verified.",
            transport: "codex-app-server-stdio",
            profileBound: true,
            profileRequired: true,
          },
        },
      },
      binding: resolvedBinding ?? null,
      profileResolved: Boolean(resolvedBinding),
    });
    const driver = createRuntimeDriver("codex_local", {
      adapter,
      providerBinding: binding,
      providerCapabilityResolver: resolver,
    });

    const result = await executeAdapterWithModelFallbacks(adapter, fakeContext({
      runtime: {
        sessionId: "thread-unknown",
        sessionParams: {
          sessionId: "thread-unknown",
          capabilityRevision: "cap-1",
          nativeTransport: "codex-app-server-stdio",
        },
        sessionDisplayId: "thread-unknown",
        taskKey: null,
      },
      config: { model: "gpt-primary" },
    }), {
      resolveDriver: () => driver,
      submitInputThroughDriver: true,
    });
    expect(result).toMatchObject({
      errorCode: "runtime_session_resume_rejected",
      errorMessage: expect.stringContaining("Runtime Driver cannot resume codex_local (unknown)"),
      clearSession: false,
      resultJson: {
        resumeRejected: true,
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps Hermes Gateway session state explicit even though its registry entry has no codec", () => {
    const providerBinding = { hostId: "gateway-1", profileId: "hermes-profile" };
    const providerCapabilities: RuntimeProviderCapabilityAdapter = {
      runtimeType: "hermes_gateway",
      sessionResume: {
        evidence: {
          status: "supported",
          reason: "Hermes session API is verified for this profile.",
          transport: "hermes-http",
          profileBound: true,
          profileRequired: true,
        },
      },
    };
    const driver = createRuntimeDriver("hermes_gateway", {
      providerBinding,
      providerCapabilityResolver: () => ({ adapter: providerCapabilities, binding: providerBinding, profileResolved: true }),
    });
    expect(driver?.sessionCodec).toBeNull();
    expect(driver?.resume({ sessionParams: { hermesSessionId: "hermes-1" } })).toEqual({
      status: "supported",
      value: {
        sessionId: "hermes-1",
        sessionDisplayId: "hermes-1",
        sessionParams: { hermesSessionId: "hermes-1" },
      },
    });
    expect(driver?.resume({ sessionId: "hermes-2" })).toEqual({
      status: "supported",
      value: {
        sessionId: "hermes-2",
        sessionDisplayId: "hermes-2",
        sessionParams: { sessionId: "hermes-2" },
      },
    });
    expect(driver?.resume({ sessionParams: { sessionId: "legacy", hermesSessionId: "hermes-3" } })).toMatchObject({
      status: "supported",
      value: { sessionId: "hermes-3", sessionDisplayId: "hermes-3" },
    });
  });

  it("delegates new input and explicit session state to the existing execute adapter", async () => {
    const execute = vi.fn(async (context: AgentRuntimeExecutionContext) => {
      expect(context.runtime).toMatchObject({
        sessionId: "session-1",
        sessionParams: { sessionId: "session-1" },
        sessionDisplayId: "session-1",
      });
      expect(context.context).toMatchObject({ chatMode: true, chatPrompt: "new input" });
      return emptyResult;
    });
    const driver = createRuntimeDriver("claude_local", { adapter: fakeAdapter("claude_local", execute) });

    await expect(driver.submitInput({
      context: fakeContext(),
      session: {
        sessionId: "session-1",
        sessionParams: { sessionId: "session-1" },
        sessionDisplayId: "session-1",
      },
      input: { text: "new input" },
    })).resolves.toBe(emptyResult);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("passes the admitted binding to execution instead of trusting config identity overrides", async () => {
    const binding = { id: "binding-1", orgId: "org-1", hostId: "local", profileId: "profile-1", workspaceBindingId: "workspace-1", capabilityRevision: "revision-1" };
    const execute = vi.fn(async (context: AgentRuntimeExecutionContext) => {
      expect(context.config).toMatchObject({
        providerBindingId: binding.id, providerOrgId: binding.orgId,
        providerHostId: binding.hostId, providerProfileId: binding.profileId,
        providerWorkspaceBindingId: binding.workspaceBindingId,
        capabilityRevision: binding.capabilityRevision,
        model: "selected-model",
      });
      return emptyResult;
    });
    const driver = createRuntimeDriver("claude_local", {
      adapter: fakeAdapter("claude_local", execute), providerBinding: binding,
      providerCapabilityResolver: () => ({ binding, profileResolved: true, adapter: {
        runtimeType: "claude_local", input: { evidence: { status: "supported", profileBound: true, profileRequired: true, reason: "bound test profile" } },
      } }),
    });
    const context = fakeContext({ config: { model: "selected-model", providerBindingId: "forged", providerOrgId: "other-org" } });
    await driver.submitInput({ context, session: null, input: { text: "hello" } });
    await driver.execute(context);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(context.config.providerBindingId).toBe("forged");
  });

  it("requires new input and clears an explicitly null session instead of replaying context", async () => {
    const execute = vi.fn(async (context: AgentRuntimeExecutionContext) => {
      expect(context.runtime).toMatchObject({
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
      });
      expect(context.context).toMatchObject({ chatMode: true, chatPrompt: "fresh input" });
      expect(context.media).toBeUndefined();
      return emptyResult;
    });
    const driver = createRuntimeDriver("claude_local", { adapter: fakeAdapter("claude_local", execute) });

    await expect(driver.submitInput({
      context: fakeContext({
        runtime: {
          sessionId: "stale-session",
          sessionParams: { sessionId: "stale-session" },
          sessionDisplayId: "stale-session",
          taskKey: null,
        },
        media: [{
          source: "chat_attachment",
          attachmentId: "stale-media",
          assetId: "stale-asset",
          name: "stale.txt",
          originalFilename: "stale.txt",
          contentType: "text/plain",
          byteSize: 1,
          localPath: "/tmp/stale.txt",
        }],
      }),
      session: null,
      input: { text: "fresh input" },
    })).resolves.toBe(emptyResult);
    await expect(driver.submitInput({
      context: fakeContext(),
      input: { text: "  " },
    })).rejects.toThrow("Runtime input must be non-empty");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not infer native control from a live handle without a profile resolver", async () => {
    const handle: AgentRuntimeControlHandle = {
      runtimeType: "codex_local",
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
      capabilities: { steer: "native", interrupt: "native" },
      steer: vi.fn(async () => ({
        disposition: "accepted_current" as const,
        providerThreadId: "thread-1",
        providerTurnId: "turn-2",
      })),
      interrupt: vi.fn(async () => "acknowledged" as const),
      dispose: vi.fn(async () => undefined),
    };
    const codex = getRuntimeDriver("codex_local");
    const hermes = getRuntimeDriver("hermes_gateway");

    await expect(codex?.control(handle, {
      kind: "steer",
      input: { text: "continue", clientMessageId: "message-1" },
    })).resolves.toMatchObject({ status: "unknown", capability: "control" });
    await expect(hermes?.control(handle, {
      kind: "steer",
      input: { text: "continue", clientMessageId: "message-2" },
    })).resolves.toMatchObject({ status: "unsupported", capability: "control" });
    expect(handle.steer).not.toHaveBeenCalled();
  });

  it("creates an explicit visible-only context handoff and rejects empty input", () => {
    const binding = { hostId: "local", profileId: "pi-profile" };
    const driver = getRuntimeDriver("pi_local", {
      providerBinding: binding,
      providerCapabilityResolver: () => ({
        adapter: {
          runtimeType: "pi_local" as const,
          contextHandoff: {
            evidence: {
              status: "supported" as const,
              reason: "Pi context handoff is a bounded visible prompt projection.",
              profileBound: true,
              profileRequired: false,
            },
          },
        },
        binding,
        profileResolved: true,
      }),
    });
    const source = {
      sessionId: "pi-1",
      sessionDisplayId: "pi-1",
      sessionParams: { sessionId: "pi-1" },
    };
    expect(driver?.contextHandoff({
      source,
      visibleContext: [{ kind: "assistant", text: "Visible answer", sourceId: "message-1" }],
      input: "Follow up",
    })).toEqual({
      status: "supported",
      value: {
        mode: "context_handoff",
        source,
        visibleContext: [{ kind: "assistant", text: "Visible answer", sourceId: "message-1" }],
        input: "Follow up",
      },
    });
    expect(driver?.contextHandoff({ source, visibleContext: [], input: "  " })).toMatchObject({
      status: "invalid",
      capability: "context_handoff",
    });
  });

  it("keeps unbound transcript range and native fork explicitly unknown", async () => {
    const driver = getRuntimeDriver("codex_local");
    const session = {
      sessionId: "thread-1",
      sessionDisplayId: "thread-1",
      sessionParams: { sessionId: "thread-1" },
    };
    await expect(driver?.readTranscriptRange({ session })).resolves.toMatchObject({
      status: "unknown",
      capability: "transcript_range",
    });
    await expect(driver?.fork({ session, boundary: "turn-1" })).resolves.toMatchObject({
      status: "unknown",
      capability: "fork",
    });
  });

  it("delegates profile-bound transcript and fork hooks without changing provider results", async () => {
    const readRange = vi.fn(async () => ({
      items: [{ kind: "assistant", ts: "2026-09-22T00:00:00.000Z", text: "native" }],
      nextCursor: "provider-cursor-2",
      source: "native" as const,
      revision: "provider-revision-1",
      availability: "available" as const,
      completeness: "complete" as const,
    }));
    const fork = vi.fn(async (input: { boundary: string }) => ({
      session: {
        sessionId: "child-session",
        sessionParams: { sessionId: "child-session" },
        sessionDisplayId: "child-session",
      },
      boundary: input.boundary,
      sourceBoundary: "turn-1",
      identityMap: { "turn-1": "child-turn-1" },
      continuity: "native" as const,
    }));
    const providerCapabilities: RuntimeProviderCapabilityAdapter = {
      runtimeType: "codex_local",
      transcript: {
        evidence: {
          status: "supported",
          reason: "Codex App Server transport and managed profile are bound for this driver.",
          providerVersion: "0.155.0-alpha.9.2",
          transport: "app-server-stdio",
          profileBound: true,
        },
        readRange,
      },
      fork: {
        evidence: {
          status: "supported",
          reason: "Codex App Server boundary fork is bound for this driver.",
          providerVersion: "0.155.0-alpha.9.2",
          transport: "app-server-stdio",
          profileBound: true,
        },
        fork,
      },
    };
    const binding = { hostId: "local", profileId: "profile-1" };
    const driver = createRuntimeDriver("codex_local", {
      providerBinding: binding,
      providerCapabilityResolver: () => ({ adapter: providerCapabilities, binding, profileResolved: true }),
    });
    const session = {
      sessionId: "thread-1",
      sessionDisplayId: "thread-1",
      sessionParams: { sessionId: "thread-1" },
    };

    await expect(driver.readTranscriptRange({
      session,
      from: "turn-0",
      through: "turn-1",
      cursor: "cursor-1",
      binding,
    })).resolves.toMatchObject({
      status: "supported",
      value: { revision: "provider-revision-1", nextCursor: "provider-cursor-2" },
    });
    await expect(driver.fork({
      session,
      boundary: "turn-1",
      binding: { hostId: "local", profileId: "profile-1" },
    })).resolves.toMatchObject({
      status: "supported",
      value: { session: { sessionId: "child-session" }, boundary: "turn-1" },
    });
    await expect(driver.branchAt({ session, boundary: "turn-1", binding })).resolves.toMatchObject({
      status: "supported",
      value: { session: { sessionId: "child-session" }, boundary: "turn-1", continuity: "native" },
    });
    expect(readRange).toHaveBeenCalledWith(expect.objectContaining({
      runtimeType: "codex_local",
      session,
      from: "turn-0",
      through: "turn-1",
      cursor: "cursor-1",
    }));
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      runtimeType: "codex_local",
      session,
      boundary: "turn-1",
    }));
  });

  it("uses a verified provider control hook for runtimes without a registry handle", async () => {
    const execute = vi.fn(async () => ({
      disposition: "accepted_current" as const,
      providerThreadId: "claude-thread",
      providerTurnId: "claude-turn-2",
    }));
    const providerCapabilities: RuntimeProviderCapabilityAdapter = {
      runtimeType: "claude_local",
      control: {
        steer: {
          evidence: {
            status: "supported",
            reason: "Claude live query transport is bound to the managed profile.",
            providerVersion: "2.1.216",
            transport: "sdk-query",
            profileBound: true,
          },
          mode: "native",
          execute,
        },
      },
    };
    const binding = { hostId: "local", profileId: "profile-1" };
    const driver = createRuntimeDriver("claude_local", {
      adapter: fakeAdapter("claude_local"),
      providerBinding: binding,
      providerCapabilityResolver: () => ({ adapter: providerCapabilities, binding, profileResolved: true }),
    });

    await expect(driver.control(null, {
      kind: "steer",
      input: { text: "continue", clientMessageId: "message-1" },
    }, {
      session: {
        sessionId: "claude-session",
        sessionParams: { sessionId: "claude-session" },
        sessionDisplayId: "claude-session",
      },
      binding,
    })).resolves.toMatchObject({
      status: "supported",
      value: { disposition: "accepted_current", providerThreadId: "claude-thread" },
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      runtimeType: "claude_local",
      handle: null,
      binding: { hostId: "local", profileId: "profile-1" },
      operation: { kind: "steer", input: { text: "continue", clientMessageId: "message-1" } },
    }));
  });

  it("does not enable or call a hook whose profile binding evidence is missing", async () => {
    const readRange = vi.fn(async () => ({ items: [] }));
    const providerCapabilities: RuntimeProviderCapabilityAdapter = {
      runtimeType: "opencode_local",
      transcript: {
        evidence: {
          status: "supported",
          reason: "OpenCode server was discovered but not bound to a Rudder profile.",
          transport: "loopback-http",
          profileBound: false,
        },
        readRange,
      },
    };
    const driver = createRuntimeDriver("opencode_local", {
      adapter: fakeAdapter("opencode_local"),
      providerCapabilities,
    });
    const session = {
      sessionId: "session-1",
      sessionDisplayId: "session-1",
      sessionParams: { sessionId: "session-1" },
    };

    expect(driver.capabilities.transcriptRange).toMatchObject({ status: "unknown" });
    await expect(driver.readTranscriptRange({ session })).resolves.toMatchObject({
      status: "unknown",
      capability: "transcript_range",
    });
    expect(readRange).not.toHaveBeenCalled();

    const verifiedButUnbound: RuntimeProviderCapabilityAdapter = {
      runtimeType: "opencode_local",
      transcript: {
        evidence: {
          status: "supported",
          reason: "OpenCode server transport is verified for an explicit profile.",
          transport: "loopback-http",
          profileBound: true,
        },
        readRange,
      },
    };
    const boundDriver = createRuntimeDriver("opencode_local", {
      adapter: fakeAdapter("opencode_local"),
      providerCapabilities: verifiedButUnbound,
    });
    expect(boundDriver.capabilities.transcriptRange.status).toBe("unknown");
    await expect(boundDriver.readTranscriptRange({ session })).resolves.toMatchObject({
      status: "unknown",
      capability: "transcript_range",
      reason: expect.stringContaining("provider resolver"),
    });
    expect(readRange).not.toHaveBeenCalled();
  });

  it("bridges only an authorized span into the Transcript Reader hook", async () => {
    const readRange = vi.fn(async (input: { readerInput?: unknown }) => ({
      items: [{ kind: "assistant", ts: "2026-09-22T00:00:00.000Z", text: "from provider" }],
      nextCursor: null,
      source: "native" as const,
      revision: "native-r1",
      availability: "available" as const,
      completeness: "complete" as const,
      readerInputSeen: Boolean(input.readerInput),
    }));
    const adapter: RuntimeProviderCapabilityAdapter = {
      runtimeType: "pi_local",
      transcript: {
        evidence: {
          status: "supported",
          reason: "Pi RPC session file is explicitly bound to this profile.",
          providerVersion: "0.76.0",
          transport: "rpc-stdio",
          profileBound: true,
        },
        readRange,
      },
    };
    const binding = {
      id: "binding-1",
      orgId: "org-1",
      hostId: "local",
      profileId: "profile-1",
      workspaceBindingId: null,
      capabilityRevision: "cap-1",
    };
    const hook = createRuntimeNativeTranscriptReaderHook((runtimeType) => runtimeType === "pi_local"
      ? { adapter, binding, profileResolved: true }
      : null);
    const input = {
      readonly: true,
      scope: "run",
      orgId: "org-1",
      principal: { id: "user-1", principalScopeRef: "scope-1" },
      run: { id: "run-1" },
      binding: {
        id: "binding-1",
        orgId: "org-1",
        runtimeType: "pi_local",
        hostId: "local",
        profileId: "profile-1",
        workspaceBindingId: null,
        capabilityRevision: "cap-1",
      },
      segment: {
        id: "segment-1",
        nativeSessionId: "pi-session-1",
        providerStateJson: { leafId: "leaf-1" },
      },
      span: { id: "span-1", completeness: "complete" },
      selector: {
        kind: "pi_branch_range",
        sessionResourceRef: "pi-session-1",
        fromExclusive: "entry-1",
        throughInclusive: "entry-2",
        leafId: "leaf-1",
      },
      cursor: null,
      range: null,
      visibilityCutoffRef: null,
    } as unknown as NativeTranscriptReadInput;

    await expect(hook.readRange!(input)).resolves.toMatchObject({
      source: "native",
      revision: "native-r1",
      availability: "available",
    });
    expect(readRange).toHaveBeenCalledWith(expect.objectContaining({
      runtimeType: "pi_local",
      session: expect.objectContaining({ sessionId: "pi-session-1" }),
      binding: { id: "binding-1", orgId: "org-1", hostId: "local", profileId: "profile-1", workspaceBindingId: null, capabilityRevision: "cap-1" },
      readerInput: input,
    }));

    const missingBindingInput = { ...input, binding: null };
    await expect(hook.readRange!(missingBindingInput)).resolves.toMatchObject({
      availability: "missing",
      items: [],
    });
    expect(readRange).toHaveBeenCalledTimes(1);
  });

  it("probes the adapter and reports resolved provider evidence while submit preserves acceptance identity", async () => {
    const binding = { id: "probe-binding", orgId: "org-1", hostId: "local", profileId: "profile-1", capabilityRevision: "rev-1" };
    const environment = {
      agentRuntimeType: "codex_local",
      status: "pass" as const,
      checks: [],
      testedAt: "2026-09-24T00:00:00.000Z",
    };
    const testEnvironment = vi.fn(async () => environment);
    const execution = {
      ...emptyResult,
      submissionPhase: "indeterminate" as const,
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
    };
    const execute = vi.fn(async () => execution);
    const providerCapabilities: RuntimeProviderCapabilityAdapter = {
      runtimeType: "codex_local",
      input: { evidence: {
        status: "supported",
        reason: "Input is verified for this profile.",
        providerVersion: "0.155.0",
        transport: "app-server-stdio",
        profileBound: true,
        profileRequired: true,
      } },
    };
    const driver = createRuntimeDriver("codex_local", {
      adapter: { ...fakeAdapter("codex_local", execute), testEnvironment },
      providerBinding: binding,
      providerCapabilityResolver: () => ({ adapter: providerCapabilities, binding, profileResolved: true }),
    });

    const probe = await driver.probe({
      orgId: "org-1",
      agentRuntimeType: "codex_local",
      config: { apiKey: "not-returned" },
      binding,
    });
    expect(probe).toMatchObject({
      status: "supported",
      value: {
        environment,
        binding,
        capabilities: { input: { status: "supported" } },
        providerEvidence: [{
          capability: "input",
          status: "supported",
          providerVersion: "0.155.0",
          transport: "app-server-stdio",
          profileBound: true,
        }],
      },
    });
    expect(JSON.stringify(probe)).not.toContain("not-returned");
    expect(testEnvironment).toHaveBeenCalledWith({
      orgId: "org-1",
      agentRuntimeType: "codex_local",
      config: { apiKey: "not-returned" },
      deployment: undefined,
    });

    await expect(driver.submit({
      context: fakeContext(),
      input: { text: "new input" },
    })).resolves.toMatchObject({
      status: "supported",
      value: {
        phase: "indeterminate",
        execution: {
          runId: "run-driver-test",
          binding,
          providerThreadId: "thread-1",
          providerTurnId: "turn-1",
        },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("ensures a Rudder binding and pending segment without starting provider execution", async () => {
    const binding = {
      id: "binding-1",
      orgId: "org-1",
      runtimeType: "codex_local",
      hostId: "local",
      profileId: "profile-1",
      workspaceBindingId: null,
      capabilityRevision: "rev-1",
    } as RuntimeBindingRecord;
    const state = {
      binding,
      segment: { id: "segment-1", bindingId: binding.id, runtimeType: "codex_local", state: "pending" },
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
    } as NativeSessionState;
    const owner = {
      ensureBinding: vi.fn(async () => binding),
      currentSession: vi.fn(async () => state),
    };
    const execute = vi.fn(async () => emptyResult);
    const driver = createRuntimeDriver("codex_local", {
      adapter: fakeAdapter("codex_local", execute),
      sessionBindingOwner: owner,
    });
    const intent = {
      orgId: "org-1",
      target: { type: "chat_conversation" as const, id: "conversation-1" },
      agentId: "agent-1",
      runtimeType: "codex_local",
      hostId: "local",
      profileId: "profile-1",
    };

    await expect(driver.ensureSession(intent)).resolves.toMatchObject({
      status: "supported",
      value: {
        binding: { id: "binding-1", orgId: "org-1", profileId: "profile-1" },
        segmentId: "segment-1",
        segmentState: "pending",
        providerSession: null,
      },
    });
    expect(owner.ensureBinding).toHaveBeenCalledWith(intent);
    expect(owner.currentSession).toHaveBeenCalledWith(binding);
    expect(execute).not.toHaveBeenCalled();
    expect(getRuntimeDriver("codex_local")?.capabilities.sessionBinding.status).toBe("unknown");

    const pinnedDriver = createRuntimeDriver("codex_local", {
      providerBinding: {
        id: binding.id,
        orgId: binding.orgId,
        hostId: binding.hostId,
        profileId: binding.profileId,
        workspaceBindingId: binding.workspaceBindingId,
        capabilityRevision: binding.capabilityRevision,
      },
      sessionBindingOwner: owner,
    });
    await expect(pinnedDriver.ensureSession({ ...intent, profileId: "other-profile" })).resolves.toMatchObject({
      status: "invalid",
      capability: "session_binding",
    });
    expect(owner.ensureBinding).toHaveBeenCalledTimes(1);
  });

  it("inspects and reconciles only the current durable Unified Run attempt", async () => {
    const fence: UnifiedOwnerFence = {
      id: "span-1",
      ownerToken: "owner-1",
      attemptEpoch: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const unknownSubmission: UnifiedSubmission = {
      key: "operation-1",
      state: "acceptance_unknown",
      phase: "indeterminate",
      retry: "blocked_until_reconciled",
      providerThreadId: null,
      providerTurnId: null,
      reason: "provider response was lost",
    };
    const entry = {
      runId: "run-1",
      orgId: "org-1",
      status: "running",
      ownerFence: fence,
      attempt: {
        ref: { id: "attempt-1", attemptIndex: 0 },
        runtimeType: "codex_local",
        submission: unknownSubmission,
      },
    } as unknown as UnifiedAgentRunEntry;
    const accepted: UnifiedSubmission = {
      ...unknownSubmission,
      state: "accepted",
      phase: "accepted",
      retry: "not_allowed",
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
      reason: null,
    };
    const get = vi.fn(async () => entry);
    const reconcileAcceptance = vi.fn(async () => ({ ok: true as const, value: accepted }));
    const driver = createRuntimeDriver("codex_local", {
      unifiedRunReader: { get },
      unifiedRunReconciler: { reconcileAcceptance },
    });

    await expect(driver.inspectExecution({ runId: "run-1", attemptId: "attempt-1" })).resolves.toMatchObject({
      status: "supported",
      value: { state: "found", entry: { attempt: { submission: { retry: "blocked_until_reconciled" } } } },
    });
    await expect(driver.reconcileExecution({
      runId: "run-1",
      attemptId: "attempt-1",
      fence,
      outcome: { state: "accepted", submissionKey: "operation-1", providerThreadId: "thread-1", providerTurnId: "turn-1" },
    })).resolves.toMatchObject({ status: "supported", value: { ok: true, value: accepted } });
    expect(reconcileAcceptance).toHaveBeenCalledWith("run-1", fence, expect.objectContaining({ state: "accepted" }));

    const staleDriver = createRuntimeDriver("codex_local", {
      unifiedRunReader: { get: vi.fn(async () => ({
        ...entry,
        ownerFence: { ...fence, attemptEpoch: fence.attemptEpoch + 1 },
      })) },
      unifiedRunReconciler: { reconcileAcceptance },
    });
    await expect(staleDriver.reconcileExecution({
      runId: "run-1",
      attemptId: "attempt-1",
      fence,
      outcome: { state: "rejected", submissionKey: "operation-1" },
    })).resolves.toMatchObject({ status: "invalid", capability: "execution_reconciliation" });
    expect(reconcileAcceptance).toHaveBeenCalledTimes(1);
  });

  it("delegates human requests, authorized transcript pages, and retention mutations to their owners", async () => {
    const request = {
      type: "agent_runtime" as const,
      payload: { requestId: "request-1" },
      inputRequest: { questions: [{ id: "q1", question: "Continue?", options: [{ id: "yes", label: "Yes" }] }] },
    };
    const approvalBridge = {
      requestApproval: vi.fn(async () => ({ id: "approval-1", status: "pending" as const })),
      waitForApproval: vi.fn(async () => ({
        id: "approval-1",
        status: "approved" as const,
        inputResponse: { answers: [{ questionId: "q1", optionIds: ["yes"] }] },
      })),
    };
    const page = {
      items: [],
      nextCursor: null,
      source: "native" as const,
      revision: "revision-1",
      availability: "available" as const,
      completeness: "complete" as const,
    };
    const transcriptReader = {
      readRun: vi.fn(async () => page),
      readConversation: vi.fn(async () => page),
    };
    const runtimeRetention = {
      inspect: vi.fn(async () => ({
        resourceRefs: ["source-1"], activeClaimIds: [], activeAliasIds: [], keptConversationIds: [],
        inFlightSpanIds: [], inFlightRunIds: [], collectable: true, blockedBy: null,
      })),
      releaseClaims: vi.fn(async () => [{ id: "claim-1" }]),
      releaseSourceAliases: vi.fn(async () => [{ id: "alias-1" }]),
    } as unknown as RuntimeDriverRetentionService;
    const driver = createRuntimeDriver("codex_local", {
      providerBinding: { orgId: "org-1", hostId: "local", profileId: "profile-1" },
      approvalBridge,
      transcriptReader,
      retentionService: runtimeRetention,
    });

    await expect(driver.respondToRequest(request, 1_000)).resolves.toMatchObject({
      status: "supported",
      value: { handle: { id: "approval-1" }, decision: { status: "approved", inputResponse: request.inputRequest && { answers: [{ questionId: "q1", optionIds: ["yes"] }] } } },
    });
    expect(approvalBridge.requestApproval).toHaveBeenCalledWith(request);
    expect(approvalBridge.waitForApproval).toHaveBeenCalledWith("approval-1", 1_000);

    const spanRequest = {
      orgId: "org-1",
      principal: { id: "user-1", orgId: "org-1", authorized: true },
      runId: "run-1",
      spanId: "span-1",
      cursor: null,
    };
    await expect(driver.readSpan(spanRequest)).resolves.toMatchObject({ status: "supported", value: page });
    const conversationRequest = {
      orgId: "org-1",
      principal: { id: "user-1", orgId: "org-1", authorized: true },
      conversationId: "conversation-1",
    };
    await expect(driver.readConversation(conversationRequest)).resolves.toMatchObject({ status: "supported", value: page });
    expect(transcriptReader.readRun).toHaveBeenCalledWith(spanRequest);
    expect(transcriptReader.readConversation).toHaveBeenCalledWith(conversationRequest);

    await expect(driver.inspectRetention({ orgId: "org-1", resourceRefs: ["source-1"] })).resolves.toMatchObject({
      status: "supported",
      value: { collectable: true, blockedBy: null },
    });
    await expect(driver.release({
      kind: "claims",
      input: { orgId: "org-1", purpose: "side_chat:live", principalScopeRef: "scope-1" },
    })).resolves.toEqual({ status: "supported", value: { kind: "claims", releasedIds: ["claim-1"] } });
    await expect(driver.release({
      kind: "source_aliases",
      input: { orgId: "org-1", principalScopeRef: "scope-1", sourceRefs: ["source-1"] },
    })).resolves.toEqual({ status: "supported", value: { kind: "source_aliases", releasedIds: ["alias-1"] } });
    expect(runtimeRetention.inspect).toHaveBeenCalledWith({ orgId: "org-1", resourceRefs: ["source-1"] });
    expect(runtimeRetention.releaseClaims).toHaveBeenCalledTimes(1);
    expect(runtimeRetention.releaseSourceAliases).toHaveBeenCalledTimes(1);
  });

  it("keeps unbound owner operations unknown instead of succeeding as no-ops", async () => {
    const driver = getRuntimeDriver("codex_local");
    expect(driver?.capabilities.sessionBinding.status).toBe("unknown");
    expect(driver?.capabilities.executionInspection.status).toBe("unknown");
    expect(driver?.capabilities.requestResponse.status).toBe("unknown");
    expect(driver?.capabilities.transcriptRead.status).toBe("unknown");
    expect(driver?.capabilities.retentionRelease.status).toBe("unknown");
    await expect(driver?.ensureSession({
      orgId: "org-1",
      target: { type: "chat_conversation", id: "conversation-1" },
      agentId: "agent-1",
      runtimeType: "codex_local",
    })).resolves.toMatchObject({ status: "unknown", capability: "session_binding" });
    await expect(driver?.respondToRequest({ type: "agent_runtime", payload: {} }, 1_000)).resolves.toMatchObject({
      status: "unknown",
      capability: "request_response",
    });
  });
});
