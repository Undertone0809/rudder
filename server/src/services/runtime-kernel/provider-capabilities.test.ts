import {
  createCodexLocalProviderCapabilities,
  createCodexLocalProviderCapabilityResolver,
  type CodexAppServerProfileTransport,
  type CodexProviderBindingRef,
} from "@rudderhq/agent-runtime-codex-local/server";
import type { AgentRuntimeControlHandle } from "@rudderhq/agent-runtime-utils";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createProfileBoundRuntimeProviderCapabilityResolverFromConfig,
  piSessionRpcArgsMatchHostProfile,
} from "../../agent-runtimes/index.js";
import {
  adaptRuntimeProviderCapabilityResolver,
  createProfileBoundRuntimeProviderCapabilityResolver,
  normalizeRuntimeProviderCapabilityResolution,
  REGISTERED_RUNTIME_PROVIDER_CAPABILITY_ADAPTERS,
  resolveRegisteredRuntimeProviderCapabilities,
  type RuntimeProviderAdapterResolver,
  type RuntimeProviderCapabilityAdapter,
  type RuntimeProviderCapabilityResolver,
  type RuntimeProviderCapabilityResolverContext,
} from "./provider-capabilities.js";
import { createRuntimeDriver } from "./runtime-driver.js";

const binding: CodexProviderBindingRef = {
  hostId: "local",
  profileId: "codex-profile",
  capabilityRevision: "cap-1",
};

const profile: CodexAppServerProfileTransport = {
  binding,
  command: process.execPath,
  cwd: path.resolve("/tmp"),
  env: { CODEX_HOME: path.resolve("/tmp/codex-home") },
  providerVersion: "0.155.0-alpha.9.2",
  methods: { threadResume: true, threadRead: true, threadFork: true },
};

const session = {
  sessionId: "thread-1",
  sessionDisplayId: "thread-1",
  sessionParams: { sessionId: "thread-1" },
};

describe("provider capability package contract", () => {
  it("requires a host-owned Pi RPC args witness before resuming a persisted session", () => {
    const hostArgs = ["--append-system-prompt", "managed prompt", "--tools", "read,rudder_agent_me"];

    expect(piSessionRpcArgsMatchHostProfile({ rpcArgs: [...hostArgs] }, hostArgs)).toBe(true);
    expect(piSessionRpcArgsMatchHostProfile({ rpcArgs: ["--extension", "attacker"] }, hostArgs)).toBe(false);
    expect(piSessionRpcArgsMatchHostProfile({ rpcArgs: [...hostArgs] }, undefined)).toBe(false);
  });

  it("uses Hermes ACP for new Chat bindings and preserves historical transport identity", () => {
    const config = { runtimeType: "hermes_gateway", runtimeConfig: { cwd: "/tmp", command: "hermes", providerVersion: "0.21.0" } };
    const live = createProfileBoundRuntimeProviderCapabilityResolverFromConfig(config);
    const acpResolution = { adapter: { sessionResume: { evidence: { transport: "hermes-acp-stdio" } } } };
    expect(live("hermes_gateway", binding)).toMatchObject(acpResolution);
    const historical = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({ ...config, resolutionMode: "historical" });
    expect(historical("hermes_gateway", binding, {
      session: { ...session, sessionParams: { transport: "hermes-acp-stdio" } },
    })).toMatchObject(acpResolution);
    expect(historical("hermes_gateway", binding, {
      session: { ...session, sessionParams: { transport: "http" } },
    })).not.toMatchObject(acpResolution);
  });

  it("keeps the Codex resolver and bound adapter assignable to server contracts", () => {
    const packageResolver: RuntimeProviderAdapterResolver = createCodexLocalProviderCapabilityResolver(
      () => profile,
    );
    const resolver: RuntimeProviderCapabilityResolver = adaptRuntimeProviderCapabilityResolver(packageResolver);
    const adapter: RuntimeProviderCapabilityAdapter = createCodexLocalProviderCapabilities(profile);

    expect(resolver("codex_local", binding)).toBeTruthy();
    expect(resolver("codex_local", binding)).toMatchObject({
      binding,
      profileResolved: true,
      adapter: { runtimeType: "codex_local" },
    });
    expect(adapter.runtimeType).toBe("codex_local");
    expect(adapter.transcript?.evidence).toMatchObject({ status: "supported", profileBound: true });
    expect(adapter.fork?.evidence).toMatchObject({ status: "supported", profileBound: true });
  });

  it("constructs a profile-bound resolver map without treating binding metadata as credentials", () => {
    const packageResolver: RuntimeProviderAdapterResolver = createCodexLocalProviderCapabilityResolver(() => profile);
    const resolver = createProfileBoundRuntimeProviderCapabilityResolver({ codex_local: packageResolver });

    expect(resolver("codex_local", binding)).toMatchObject({
      profileResolved: true,
      binding,
      adapter: { runtimeType: "codex_local" },
    });
    expect(resolver("pi_local", binding)).toBeNull();
    expect(resolver("codex_local", null)).toBeNull();
  });

  it("does not attest a raw static or pre-resolved adapter", () => {
    const rawAdapter = createCodexLocalProviderCapabilities(profile);
    expect(normalizeRuntimeProviderCapabilityResolution(rawAdapter, "codex_local", binding)).toMatchObject({
      binding: null,
      profileResolved: false,
    });
    expect(resolveRegisteredRuntimeProviderCapabilities("codex_local", binding)).toMatchObject({
      binding: null,
      profileResolved: false,
    });
  });

  it("does not attest a profile-bound adapter whose evidence is still unknown", () => {
    const resolver = adaptRuntimeProviderCapabilityResolver(() => ({
      runtimeType: "codex_local",
      sessionResume: {
        evidence: {
          status: "unknown",
          reason: "provider profile transport was not independently resolved",
          profileBound: true,
          profileRequired: true,
        },
      },
    }));

    expect(resolver("codex_local", binding)).toBeNull();
  });

  it("does not register provider capabilities for non-native runtimes", () => {
    const nonNativeRuntimeTypes = ["gemini_local", "openclaw_gateway", "hermes_local", "process", "http"];
    const registeredRuntimeTypes = REGISTERED_RUNTIME_PROVIDER_CAPABILITY_ADAPTERS.map((adapter) => adapter.runtimeType);

    for (const runtimeType of nonNativeRuntimeTypes) {
      expect(registeredRuntimeTypes).not.toContain(runtimeType);
      expect(resolveRegisteredRuntimeProviderCapabilities(runtimeType)).toBeNull();
    }
  });

  it("builds the production six-runtime resolver from host-owned profile callbacks", () => {
    const resolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      codex_local: () => profile,
    });
    expect(resolver("codex_local", binding)).toMatchObject({
      profileResolved: true,
      binding,
      adapter: { runtimeType: "codex_local" },
    });
    expect(resolver("opencode_local", binding)).toBeNull();
    expect(resolver("pi_local", binding)).toBeNull();
    for (const runtimeType of ["gemini_local", "openclaw_gateway", "hermes_local", "process", "http"]) {
      expect(resolver(runtimeType, binding)).toBeNull();
    }
  });

  it("keeps live Chat input available while withholding incomplete OpenCode and Pi native transport", () => {
    const openCodeBinding = {
      hostId: "local",
      profileId: "opencode-live",
    };
    const openCodeResolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      runtimeType: "opencode_local",
      runtimeConfig: { command: "opencode" },
      cwd: "/tmp/live-opencode",
    });
    const openCode = openCodeResolver("opencode_local", openCodeBinding, {
      session: {
        sessionId: "attacker-session",
        sessionDisplayId: "attacker-session",
        sessionParams: {
          sessionId: "attacker-session",
          cwd: "/tmp/attacker",
          serverUrl: "http://127.0.0.1:43123",
          serverCommand: "opencode",
          exportCommand: "opencode",
        },
      },
    });
    const openCodeResolution = normalizeRuntimeProviderCapabilityResolution(
      openCode,
      "opencode_local",
      openCodeBinding,
    );
    expect(openCodeResolution).toMatchObject({
      profileResolved: true,
      adapter: {
        input: { evidence: { status: "supported" } },
        transcript: { evidence: { status: "unknown", profileBound: false } },
        fork: { evidence: { status: "unknown", profileBound: false } },
      },
    });
    expect(openCodeResolution?.adapter.transcript?.readRange).toBeUndefined();
    expect(openCodeResolution?.adapter.fork?.fork).toBeUndefined();

    const piBinding = {
      hostId: "local",
      profileId: "pi-live",
    };
    const piResolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      runtimeType: "pi_local",
      runtimeConfig: { command: "pi" },
      cwd: "/tmp/live-pi",
    });
    const pi = piResolver("pi_local", piBinding, {
      session: {
        sessionId: "/tmp/attacker/session.jsonl",
        sessionDisplayId: "attacker-session",
        sessionParams: {
          sessionId: "/tmp/attacker/session.jsonl",
          sessionFile: "/tmp/attacker/session.jsonl",
          sessionDir: "/tmp/attacker",
          cwd: "/tmp/attacker",
          command: "pi",
          rpcArgs: ["--extension", "attacker-extension"],
          rpcEnv: {},
        },
      },
    });
    const piResolution = normalizeRuntimeProviderCapabilityResolution(
      pi,
      "pi_local",
      piBinding,
    );
    expect(piResolution).toMatchObject({
      profileResolved: true,
      adapter: {
        input: { evidence: { status: "supported" } },
        transcript: { evidence: { status: "unknown", profileBound: false } },
        fork: { evidence: { status: "unknown", profileBound: false } },
        control: {
          steer: { evidence: { status: "unknown", profileBound: false } },
          interrupt: { evidence: { status: "unknown", profileBound: false } },
        },
      },
    });
    expect(piResolution?.adapter.transcript?.readRange).toBeUndefined();
    expect(piResolution?.adapter.fork?.fork).toBeUndefined();
    expect(piResolution?.adapter.control?.steer?.execute).toBeUndefined();
    expect(piResolution?.adapter.control?.interrupt?.execute).toBeUndefined();
  });

  it.each(["parent first Run", "Side Chat first Run"])(
    "does not attest %s from a later persisted Pi argv without a host witness",
    () => {
      const piBinding = { id: "binding-1", orgId: "org-1", hostId: "local", profileId: "default" };
      const sessionId = "/tmp/pi-home/.pi/paperclips/session.jsonl";
      const rpcArgs = ["--append-system-prompt", "run-scoped instructions", "--tools", "read,rudder_agent_me"];
      const preparedConfig = {
        command: "pi", cwd: "/tmp/workspace", sessionDir: "/tmp/pi-home/.pi/paperclips",
        providerVersion: "0.76.0", rpcEnv: { HOME: "/tmp/operator" },
      };
      const session = {
        sessionId, sessionDisplayId: sessionId,
        sessionParams: {
          sessionId, sessionFile: sessionId, sessionDir: preparedConfig.sessionDir,
          cwd: preparedConfig.cwd, command: preparedConfig.command, rpcArgs,
          rpcEnv: preparedConfig.rpcEnv, hostId: piBinding.hostId,
          profileId: piBinding.profileId, profileBindingId: piBinding.id,
          profileOrgId: piBinding.orgId, transport: "pi-rpc-stdio",
          providerVersion: preparedConfig.providerVersion,
        },
      };
      const resolve = (runtimeConfig: Record<string, unknown>, persistedSession: typeof session | null) => {
        const resolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
          runtimeType: "pi_local", runtimeConfig, cwd: preparedConfig.cwd,
        });
        return normalizeRuntimeProviderCapabilityResolution(
          resolver("pi_local", piBinding, { session: persistedSession }), "pi_local", piBinding,
        );
      };

      expect(resolve(preparedConfig, null)?.adapter.transcript?.evidence).toMatchObject({
        status: "unknown", profileBound: false,
      });
      const selfAttested = resolve(preparedConfig, session);
      expect(selfAttested?.adapter.transcript?.evidence).toMatchObject({ status: "unknown", profileBound: false });
      expect(selfAttested?.adapter.transcript?.readRange).toBeUndefined();
      expect(selfAttested?.adapter.fork?.fork).toBeUndefined();
      expect(resolve({ ...preparedConfig, rpcArgs }, session)?.adapter.transcript?.evidence).toMatchObject({
        status: "supported", profileBound: true,
      });
      expect(resolve({ ...preparedConfig, rpcArgs: ["--extension", "forged"] }, session)?.adapter.transcript?.evidence)
        .toMatchObject({ status: "unknown", profileBound: false });
    },
  );

  it.each(["parent continuation", "Side Chat continuation"])(
    "attests Pi native transport for a %s from its host-owned profile snapshot",
    (scenario) => {
      const piBinding = {
        id: `binding-${scenario}`,
        orgId: "org-1",
        hostId: "local",
        profileId: "pi-live",
        workspaceBindingId: "workspace-1",
        capabilityRevision: "pi-cap-1",
      };
      const sessionId = "/tmp/live-pi/.pi/sessions/session.jsonl";
      const session = {
        sessionId,
        sessionDisplayId: "pi-session",
        sessionParams: {
          sessionId,
          sessionFile: sessionId,
          sessionDir: "/tmp/live-pi/.pi/sessions",
          cwd: "/tmp/live-pi",
          command: "pi",
          rpcArgs: ["--append-system-prompt", "persisted system prompt", "--tools", "read,rudder_agent_me"],
          rpcEnv: { HOME: "/tmp/pi-home" },
          hostId: piBinding.hostId,
          profileId: piBinding.profileId,
          profileBindingId: piBinding.id,
          profileOrgId: piBinding.orgId,
          workspaceBindingId: piBinding.workspaceBindingId,
          capabilityRevision: piBinding.capabilityRevision,
          transport: "pi-rpc-stdio",
          providerVersion: "0.76.0",
          workspaceId: "workspace-1",
          repoUrl: "https://example.test/repo.git",
          repoRef: "main",
        },
      };
      const resolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
        runtimeType: "pi_local",
        resolutionMode: scenario === "parent continuation" ? "historical" : "live",
        runtimeConfig: {
          command: "pi",
          sessionDir: "/tmp/live-pi/.pi/sessions",
          providerVersion: "0.76.0",
          rpcArgs: ["--append-system-prompt", "persisted system prompt", "--tools", "read,rudder_agent_me"],
          rpcEnv: { HOME: "/tmp/pi-home" },
        },
        cwd: "/tmp/live-pi",
      });
      const context: RuntimeProviderCapabilityResolverContext = {
        session,
        readerInput: {
          run: {
            contextSnapshot: {
              rudderWorkspace: {
                workspaceId: "workspace-1",
                repoUrl: "https://example.test/repo.git",
                repoRef: "main",
                workspaceBindingId: "workspace-1",
              },
            },
          },
        } as unknown as RuntimeProviderCapabilityResolverContext["readerInput"],
      };
      const resolution = normalizeRuntimeProviderCapabilityResolution(
        resolver("pi_local", piBinding, context),
        "pi_local",
        piBinding,
      );

      expect(resolution).toMatchObject({
        profileResolved: true,
        adapter: {
          transcript: { evidence: { status: "supported", profileBound: true } },
          fork: { evidence: { status: "supported", profileBound: true } },
        },
      });
      expect(resolution?.adapter.transcript?.readRange).toBeTypeOf("function");
      expect(resolution?.adapter.fork?.fork).toBeTypeOf("function");

      const sessionOnlyResolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
        runtimeType: "pi_local",
        runtimeConfig: {
          command: "pi",
          sessionDir: "/tmp/live-pi/.pi/sessions",
          providerVersion: "0.76.0",
          rpcEnv: { HOME: "/tmp/pi-home" },
        },
        cwd: "/tmp/live-pi",
      });
      const sessionOnlyResolution = normalizeRuntimeProviderCapabilityResolution(
        sessionOnlyResolver("pi_local", piBinding, context),
        "pi_local",
        piBinding,
      );
      expect(sessionOnlyResolution).toMatchObject({
        profileResolved: true,
        adapter: {
          transcript: { evidence: { status: "unknown", profileBound: false } },
          fork: { evidence: { status: "unknown", profileBound: false } },
        },
      });
      expect(sessionOnlyResolution?.adapter.transcript?.readRange).toBeUndefined();
      expect(sessionOnlyResolution?.adapter.fork?.fork).toBeUndefined();

      const drifted = resolver("pi_local", piBinding, {
        ...context,
        session: {
          ...session,
          sessionParams: { ...session.sessionParams, profileId: "other-profile" },
        },
      });
      expect(normalizeRuntimeProviderCapabilityResolution(drifted, "pi_local", piBinding)).toMatchObject({
        adapter: {
          input: { evidence: { status: "supported" } },
          transcript: { evidence: { status: "unknown", profileBound: false } },
          fork: { evidence: { status: "unknown", profileBound: false } },
        },
      });
    },
  );

  it("passes persisted session and reader context through the resolver boundary", () => {
    const resolveProfile = vi.fn((runtimeType: string, requested?: CodexProviderBindingRef | null, context?: { session?: unknown }) => {
      expect(runtimeType).toBe("codex_local");
      expect(requested).toEqual(binding);
      expect(context?.session).toEqual(session);
      return createCodexLocalProviderCapabilities(profile);
    });
    const resolver = createProfileBoundRuntimeProviderCapabilityResolver({ codex_local: resolveProfile });
    expect(resolver("codex_local", binding, { session })).toMatchObject({ profileResolved: true });
    expect(resolveProfile).toHaveBeenCalledWith("codex_local", binding, { session });
  });

  it("lets the server driver invoke the profile-bound transcript, fork, and control hooks", async () => {
    const readRange = vi.fn().mockResolvedValue({
      items: [{ id: "item-1", kind: "codex_agent_message" }],
      source: "native" as const,
      revision: "codex:r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const fork = vi.fn().mockResolvedValue({
      session,
      boundary: "turn-1",
      sourceBoundary: "turn-1",
      continuity: "native" as const,
    });
    const resolveProfile = vi.fn((requested: CodexProviderBindingRef) => {
      expect(requested).toEqual(binding);
      return profile;
    });
    const packageResolver = createCodexLocalProviderCapabilityResolver(resolveProfile);
    const attestedResolver = adaptRuntimeProviderCapabilityResolver(packageResolver);
    const resolverImpl: RuntimeProviderCapabilityResolver = (runtimeType, requested) => {
      const resolution = normalizeRuntimeProviderCapabilityResolution(
        attestedResolver(runtimeType, requested),
        runtimeType,
        requested,
      );
      if (resolution) {
        resolution.adapter.transcript!.readRange = readRange;
        resolution.adapter.fork!.fork = fork;
      }
      return resolution;
    };
    const resolver = vi.fn(resolverImpl);
    const driver = createRuntimeDriver("codex_local", {
      providerBinding: binding,
      providerCapabilityResolver: resolver,
    });
    const handle = {
      runtimeType: "codex_local",
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
      capabilities: { steer: "native" as const, interrupt: "native" as const },
      steer: vi.fn().mockResolvedValue({
        disposition: "accepted_current" as const,
        providerThreadId: "thread-1",
        providerTurnId: "turn-1",
      }),
      interrupt: vi.fn().mockResolvedValue("acknowledged" as const),
      dispose: vi.fn().mockResolvedValue(undefined),
    } satisfies AgentRuntimeControlHandle;

    await expect(driver.readTranscriptRange({ session, binding })).resolves.toMatchObject({
      status: "supported",
      value: { revision: "codex:r1" },
    });
    await expect(driver.fork({ session, boundary: "turn-1", binding })).resolves.toMatchObject({
      status: "supported",
      value: { continuity: "native" },
    });
    await expect(driver.control(handle, {
      kind: "steer",
      input: { text: "continue", clientMessageId: "message-1" },
    }, { session, binding })).resolves.toMatchObject({ status: "supported" });
    await expect(driver.control(handle, {
      kind: "interrupt",
      reason: "operator_stop",
    }, { session, binding })).resolves.toMatchObject({ status: "supported", value: "acknowledged" });

    expect(readRange).toHaveBeenCalledWith(expect.objectContaining({ runtimeType: "codex_local", session, binding }));
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ runtimeType: "codex_local", session, binding }));
    expect(resolver).toHaveBeenCalledWith("codex_local", binding);
    // The driver resolves the profile again for each session-aware operation so
    // persisted transport fields can be validated after a restart.
    expect(resolveProfile).toHaveBeenCalledTimes(5);
    expect(handle.steer).toHaveBeenCalledWith({ text: "continue", clientMessageId: "message-1" });
    expect(handle.interrupt).toHaveBeenCalledWith("operator_stop");
  });

  it("returns unknown before calling native hooks when the profile binding is absent", async () => {
    const resolver = createCodexLocalProviderCapabilityResolver(() => profile);
    const driver = createRuntimeDriver("codex_local", {
      providerCapabilities: resolver("codex_local", null),
    });

    expect(driver.capabilities.transcriptRange).toMatchObject({ status: "unknown" });
    expect(driver.capabilities.fork).toMatchObject({ status: "unknown" });
    await expect(driver.readTranscriptRange({ session })).resolves.toMatchObject({
      status: "unknown",
      capability: "transcript_range",
    });
    await expect(driver.fork({ session, boundary: "turn-1" })).resolves.toMatchObject({
      status: "unknown",
      capability: "fork",
    });
  });
});
