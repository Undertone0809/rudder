import { describe, expect, it } from "vitest";
import { buildRuntimeProviderProfileSnapshot } from "../agent-runtimes/runtime-provider-profile-snapshot.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  createHistoricalRunRuntimeProviderCapabilityResolver,
  resolveHistoricalRunRuntimeProfile,
  type HistoricalRunConfigRevision,
  type HistoricalRunProfileRun,
} from "./run-intelligence.js";
import type { RuntimeProviderCapabilityResolverContext } from "./runtime-kernel/provider-capabilities.js";

function profileRun(overrides: Partial<HistoricalRunProfileRun> = {}): HistoricalRunProfileRun {
  return {
    id: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    agentWorkspaceKey: null,
    agentRuntimeType: "process",
    agentRuntimeConfig: { command: "current-command" },
    runtimeConfig: { heartbeat: { wakeOnDemand: true } },
    contextSnapshot: null,
    createdAt: new Date("2026-09-22T00:00:00.000Z"),
    ...overrides,
  };
}

function revision(
  id: string,
  createdAt: string,
  beforeConfig: Record<string, unknown>,
  afterConfig: Record<string, unknown>,
): HistoricalRunConfigRevision {
  return { id, createdAt: new Date(createdAt), beforeConfig, afterConfig };
}

const binding = {
  orgId: "org-1",
  hostId: "local",
  profileId: "profile-1",
  capabilityRevision: "cap-1",
};

function persistedTransport(runtimeType: "opencode_local" | "pi_local") {
  if (runtimeType === "opencode_local") {
    return {
      sessionId: "opencode-session-1",
      sessionDisplayId: "opencode-session-1",
      sessionParams: {
        sessionId: "opencode-session-1",
        hostId: binding.hostId,
        profileId: binding.profileId,
        capabilityRevision: binding.capabilityRevision,
        serverUrl: "http://127.0.0.1:43123",
        cwd: "/tmp/attacker-opencode",
        directory: "/tmp/attacker-opencode",
        serverCommand: "opencode",
        exportCommand: "opencode",
        exportEnv: {},
        providerVersion: "1.0.0",
      },
    };
  }
  return {
    sessionId: "/tmp/attacker-pi/session.jsonl",
    sessionDisplayId: "attacker-pi",
    sessionParams: {
      sessionId: "/tmp/attacker-pi/session.jsonl",
      sessionFile: "/tmp/attacker-pi/session.jsonl",
      sessionDir: "/tmp/attacker-pi",
      cwd: "/tmp/attacker-pi-workspace",
      command: "pi",
      rpcArgs: ["--extension", "attacker-extension"],
      rpcEnv: {},
      hostId: binding.hostId,
      profileId: binding.profileId,
      capabilityRevision: binding.capabilityRevision,
      providerVersion: "0.1.0",
    },
  };
}

function independentTransport(runtimeType: "opencode_local" | "pi_local") {
  return runtimeType === "opencode_local"
    ? {
      command: "opencode",
      cwd: "/tmp/independent-opencode",
      serverUrl: "http://127.0.0.1:43123",
      providerVersion: "1.0.0",
      env: {},
    }
    : {
      command: "pi",
      cwd: "/tmp/independent-pi-workspace",
      sessionDir: "/tmp/independent-pi",
      rpcArgs: ["--extension", "managed-extension"],
      providerVersion: "0.1.0",
      env: {},
    };
}

describe("run intelligence historical transcript profiles", () => {
  it("reads the host-prepared Codex profile without taking transport authority from the session", () => {
    const profile = resolveHistoricalRunRuntimeProfile(profileRun({
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { command: "codex", env: { CODEX_HOME: "/shared/auth" } },
      contextSnapshot: { runtimeProviderProfile: {
        runtimeType: "codex_local", cwd: "/managed/workspace", codexHome: "/managed/codex",
        providerVersion: "0.155.0", command: "untrusted-command", env: { SECRET: "never" },
      } },
      sessionParamsAfterJson: { cwd: "/session-path", codexHome: "/session-home" },
    }), []);
    expect(profile.cwd).toBe("/managed/workspace");
    expect(profile.runtimeConfig).toMatchObject({ command: "codex", codexHome: "/managed/codex", providerVersion: "0.155.0" });
    expect(profile.runtimeConfig.env).toEqual({ CODEX_HOME: "/shared/auth" });
  });
  it("uses the server-created Hermes agent workspace when the persisted session corroborates it", () => {
    const run = profileRun({
      agentRuntimeType: "hermes_gateway",
      agentRuntimeConfig: { cwd: "/old/source-checkout", hermesHome: "/managed/hermes-home" },
      contextSnapshot: {
        runtimeProviderProfile: buildRuntimeProviderProfileSnapshot("hermes_gateway", {
          cwd: "/old/source-checkout",
          hermesHome: "/managed/hermes-home",
          hermesPythonCommand: "/installed/python",
          hermesSourcePath: "/installed/hermes",
        }),
        rudderWorkspace: {
          source: "agent_home",
          executionWorkspaceSource: "agent_home",
          cwd: "/managed/agents/agent-1",
          executionWorkspaceCwd: "/managed/agents/agent-1",
          agentHome: "/managed/agents/agent-1",
        },
      },
      sessionParamsAfterJson: { cwd: "/managed/agents/agent-1" },
    });

    expect(resolveHistoricalRunRuntimeProfile(run, []).cwd).toBe("/managed/agents/agent-1");
    expect(resolveHistoricalRunRuntimeProfile(run, []).runtimeConfig).toMatchObject({
      hermesHome: "/managed/hermes-home",
      hermesPythonCommand: "/installed/python",
      hermesSourcePath: "/installed/hermes",
    });
  });

  it("does not let Hermes session cwd alone replace a historical host profile", () => {
    const contextSnapshot = {
      runtimeProviderProfile: { runtimeType: "hermes_gateway", cwd: "/old/source-checkout" },
      rudderWorkspace: {
        source: "agent_home",
        executionWorkspaceSource: "agent_home",
        cwd: "/managed/agents/agent-1",
        executionWorkspaceCwd: "/managed/agents/agent-1",
        agentHome: "/managed/agents/agent-1",
      },
    };
    for (const run of [
      profileRun({ agentRuntimeType: "hermes_gateway", contextSnapshot, sessionParamsAfterJson: { cwd: "/attacker/path" } }),
      profileRun({ agentRuntimeType: "hermes_gateway", contextSnapshot, sessionParamsAfterJson: null }),
      profileRun({ agentRuntimeType: "hermes_gateway", contextSnapshot: {
        ...contextSnapshot,
        rudderWorkspace: { ...contextSnapshot.rudderWorkspace, agentHome: "/other/agent" },
      }, sessionParamsAfterJson: { cwd: "/managed/agents/agent-1" } }),
    ]) {
      expect(resolveHistoricalRunRuntimeProfile(run, []).cwd).toBe("/old/source-checkout");
    }
  });

  it("keeps Hermes native Reader binding and session identity checks after the cwd correction", async () => {
    const managedCwd = "/managed/agents/agent-1";
    const run = profileRun({
      agentRuntimeType: "hermes_gateway",
      agentRuntimeConfig: {
        hermesAcpCommand: "hermes",
        hermesPythonCommand: "/installed/python",
        hermesSourcePath: "/installed/hermes",
        hermesHome: "/managed/hermes-home",
        hermesProviderVersion: "0.21.0",
      },
      contextSnapshot: {
        runtimeProviderProfile: buildRuntimeProviderProfileSnapshot("hermes_gateway", {
          cwd: "/old/source-checkout",
          hermesAcpCommand: "hermes",
          hermesPythonCommand: "/installed/python",
          hermesSourcePath: "/installed/hermes",
          hermesHome: "/managed/hermes-home",
          hermesProviderVersion: "0.21.0",
        }),
        rudderWorkspace: {
          source: "agent_home", executionWorkspaceSource: "agent_home",
          cwd: managedCwd, executionWorkspaceCwd: managedCwd, agentHome: managedCwd,
        },
      },
      sessionParamsAfterJson: { cwd: managedCwd },
    });
    const resolver = createHistoricalRunRuntimeProviderCapabilityResolver(run, []);
    const session = {
      sessionId: "hermes-session-1",
      sessionDisplayId: "hermes-session-1",
      sessionParams: {
        sessionId: "hermes-session-1",
        hermesSessionId: "hermes-session-1",
        transport: "hermes-tui-gateway-stdio",
        profileHostId: binding.hostId,
        profileId: binding.profileId,
        profileOrgId: binding.orgId,
        capabilityRevision: binding.capabilityRevision,
        hermesProviderVersion: "0.21.0",
        hermesPythonCommand: "/installed/python",
        hermesSourcePath: "/installed/hermes",
        hermesHome: "/managed/hermes-home",
        cwd: managedCwd,
      },
    };
    const resolved = resolver("hermes_gateway", binding, { session });
    expect(resolved).toMatchObject({
      profileResolved: true,
      adapter: { transcript: { evidence: { status: "supported", profileBound: true } } },
    });
    expect(resolver("hermes_gateway", binding, {
      session,
      readerInput: { orgId: "other-org", run: { id: run.id, orgId: run.orgId } } as NonNullable<RuntimeProviderCapabilityResolverContext["readerInput"]>,
    })).toBeNull();
    const readRange = resolved && "adapter" in resolved
      ? resolved.adapter.transcript?.readRange
      : null;
    expect(readRange).toBeTypeOf("function");
    const rejected = await readRange!({
      runtimeType: "hermes_gateway", binding,
      session: { ...session, sessionParams: { ...session.sessionParams, cwd: "/attacker/path" } },
    });
    expect(rejected).toMatchObject({
      availability: "incompatible", revision: "session-profile-mismatch", items: [],
    });
  });
  it("recovers a Hermes managed workspace without rudderWorkspace only from matching server-owned binding and agent key", async () => {
    const orgId = "1658fedb-12d3-42ed-acc5-402129cd8e22";
    const agentId = "61775408-e020-4724-b2b3-6b1b9b3a792a";
    const managedCwd = resolveDefaultAgentWorkspaceDir(orgId, "hermes-public-typed-mcp--61775408");
    const run = profileRun({
      id: "d04d1ad7-bda9-44e0-96d8-4cff4d46d964", orgId, agentId,
      agentWorkspaceKey: "hermes-public-typed-mcp--61775408",
      agentRuntimeType: "hermes_gateway",
      agentRuntimeConfig: { hermesAcpCommand: "hermes", hermesPythonCommand: "/installed/python",
        hermesSourcePath: "/installed/hermes", hermesHome: "/managed/hermes-home",
        hermesProviderVersion: "0.21.0" },
      contextSnapshot: { runtimeBindingId: "binding-1", runtimeProviderProfile:
        buildRuntimeProviderProfileSnapshot("hermes_gateway", {
          cwd: "/old/source-checkout", hermesAcpCommand: "hermes",
          hermesPythonCommand: "/installed/python", hermesSourcePath: "/installed/hermes",
          hermesHome: "/managed/hermes-home", hermesProviderVersion: "0.21.0",
        }) },
      sessionParamsAfterJson: { cwd: managedCwd, workspaceBindingId: managedCwd },
    });
    expect(resolveHistoricalRunRuntimeProfile(run, []).cwd).toBe("/old/source-checkout");
    const bindingRecord = { id: "binding-1", orgId, agentId, runtimeType: "hermes_gateway",
      workspaceBindingId: managedCwd };
    const readerInput = { orgId, run: { id: run.id, orgId, sessionParamsAfterJson: run.sessionParamsAfterJson },
      binding: bindingRecord, span: { runId: run.id, orgId, bindingId: bindingRecord.id,
        segmentId: "segment-1" }, segment: { id: "segment-1", orgId, bindingId: bindingRecord.id } };
    const providerBinding = { ...binding, id: bindingRecord.id, orgId, workspaceBindingId: managedCwd };
    const session = { sessionId: "20261001_133837_0a2544", sessionDisplayId: "Hermes",
      sessionParams: { sessionId: "20261001_133837_0a2544", hermesSessionId: "20261001_133837_0a2544",
        transport: "hermes-tui-gateway-stdio", profileHostId: binding.hostId,
        profileId: binding.profileId, profileOrgId: orgId,
        capabilityRevision: binding.capabilityRevision, hermesProviderVersion: "0.21.0",
        hermesPythonCommand: "/installed/python", hermesSourcePath: "/installed/hermes",
        hermesHome: "/managed/hermes-home", cwd: managedCwd } };
    const resolver = createHistoricalRunRuntimeProviderCapabilityResolver(run, []);
    const context = { session, readerInput: readerInput as NonNullable<RuntimeProviderCapabilityResolverContext["readerInput"]> };
    const resolved = resolver("hermes_gateway", providerBinding, context);
    expect(resolved).toMatchObject({ profileResolved: true,
      adapter: { transcript: { evidence: { status: "supported", profileBound: true } } } });
    expect(resolver("hermes_gateway", providerBinding, {
      ...context, readerInput: { ...readerInput,
        binding: { ...bindingRecord, workspaceBindingId: null } } as unknown as NonNullable<RuntimeProviderCapabilityResolverContext["readerInput"]>,
    })).toMatchObject({ profileResolved: true });
    const readRange = resolved && "adapter" in resolved ? resolved.adapter.transcript?.readRange : null;
    expect((await readRange!({ runtimeType: "hermes_gateway", binding: providerBinding,
      session: { ...session, sessionParams: { ...session.sessionParams, cwd: "/forged/cwd" } } })))
      .toMatchObject({ availability: "incompatible", revision: "session-profile-mismatch", items: [] });
    for (const invalid of [
      { ...context, readerInput: { ...readerInput, orgId: "other-org" } },
      { ...context, readerInput: { ...readerInput, binding: { ...bindingRecord, agentId: "other-agent" } } },
      { ...context, readerInput: { ...readerInput, binding: { ...bindingRecord, workspaceBindingId: "/forged/cwd" } } },
      { ...context, readerInput: { ...readerInput, run: { ...readerInput.run,
        sessionParamsAfterJson: { cwd: "/forged/cwd" } } } },
    ]) {
      expect(resolver("hermes_gateway", providerBinding, invalid as unknown as RuntimeProviderCapabilityResolverContext)).toBeNull();
    }
  });
  it("ignores a prepared profile from a different runtime", () => {
    const profile = resolveHistoricalRunRuntimeProfile(profileRun({
      agentRuntimeType: "pi_local", agentRuntimeConfig: { cwd: "/pi" },
      contextSnapshot: { runtimeProviderProfile: { runtimeType: "codex_local", cwd: "/codex", providerVersion: "9.9.9" } },
    }), []);
    expect(profile.cwd).toBe("/pi");
    expect(profile.runtimeConfig.providerVersion).toBeUndefined();
  });

  it("projects generated non-Codex defaults without inventing dynamic transport", () => {
    const openCode = resolveHistoricalRunRuntimeProfile(profileRun({
      agentRuntimeType: "opencode_local",
      agentRuntimeConfig: { command: "opencode", serverUrl: "http://127.0.0.1:4000" },
      contextSnapshot: {
        runtimeProviderProfile: buildRuntimeProviderProfileSnapshot("opencode_local", {
          cwd: "/managed/opencode",
          providerVersion: "1.0.0",
          serverCommand: "opencode",
          exportCommand: "opencode",
          exportEnv: { XDG_CONFIG_HOME: "/managed/opencode/config" },
        }),
      },
    }), []);
    expect(openCode.runtimeConfig).toMatchObject({
      cwd: "/managed/opencode",
      providerVersion: "1.0.0",
      serverCommand: "opencode",
      exportCommand: "opencode",
      exportEnv: { XDG_CONFIG_HOME: "/managed/opencode/config" },
    });
    expect(openCode.runtimeConfig.serverUrl).toBeUndefined();

    const pi = resolveHistoricalRunRuntimeProfile(profileRun({
      agentRuntimeType: "pi_local",
      agentRuntimeConfig: { command: "pi", rpcArgs: ["--extension", "unfenced"] },
      contextSnapshot: {
        runtimeProviderProfile: buildRuntimeProviderProfileSnapshot("pi_local", {
          cwd: "/managed/pi",
          providerVersion: "0.76.0",
          sessionDir: "/managed/pi/session",
          rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/managed/pi/session" },
          rpcArgs: ["--extension", "ignored"],
        }),
      },
    }), []);
    expect(pi.runtimeConfig).toMatchObject({
      cwd: "/managed/pi",
      providerVersion: "0.76.0",
      sessionDir: "/managed/pi/session",
      rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/managed/pi/session" },
    });
    expect(pi.runtimeConfig.rpcArgs).toBeUndefined();
  });

  it("accepts dynamic Pi transport only from the host-filtered Run profile", () => {
    const profile = resolveHistoricalRunRuntimeProfile(profileRun({
      agentRuntimeType: "pi_local",
      agentRuntimeConfig: { command: "pi", rpcArgs: ["--extension", "config"] },
      contextSnapshot: {
        runtimeProviderProfile: {
          ...buildRuntimeProviderProfileSnapshot("pi_local", {
            cwd: "/managed/pi",
            providerVersion: "0.76.0",
            sessionDir: "/managed/pi/session",
            rpcEnv: { PI_CODING_AGENT_SESSION_DIR: "/managed/pi/session" },
          }),
          rpcArgs: ["--extension", "host-generated"],
        },
      },
    }), []);

    expect(profile.runtimeConfig.rpcArgs).toEqual(["--extension", "host-generated"]);
  });
  it("uses the latest persisted revision at the run boundary", () => {
    const profile = resolveHistoricalRunRuntimeProfile(
      profileRun({
        createdAt: new Date("2026-09-10T00:00:00.000Z"),
        contextSnapshot: {
          rudderWorkspace: { executionWorkspaceCwd: "/historical/worktree" },
        },
      }),
      [
        revision(
          "future",
          "2026-09-20T00:00:00.000Z",
          { agentRuntimeType: "codex_local", agentRuntimeConfig: { command: "before-future" }, runtimeConfig: {} },
          { agentRuntimeType: "claude_local", agentRuntimeConfig: { command: "future" }, runtimeConfig: {} },
        ),
        revision(
          "at-run",
          "2026-09-01T00:00:00.000Z",
          { agentRuntimeType: "process", agentRuntimeConfig: {}, runtimeConfig: {} },
          {
            agentRuntimeType: "codex_local",
            agentRuntimeConfig: { command: "historical-codex" },
            runtimeConfig: { model: "historical-model" },
          },
        ),
      ],
    );

    expect(profile).toMatchObject({
      agentRuntimeType: "codex_local",
      runtimeConfig: {
        command: "historical-codex",
        model: "historical-model",
      },
      cwd: "/historical/worktree",
      agentConfigRevisionId: "at-run",
    });
  });

  it("uses the first revision beforeConfig for runs before the revision history", () => {
    const profile = resolveHistoricalRunRuntimeProfile(
      profileRun({
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: { command: "current-command" },
        contextSnapshot: {
          rudderWorkspace: { executionWorkspaceCwd: "/context-worktree" },
        },
        sessionParamsBeforeJson: { cwd: "/untrusted-session-worktree" },
      }),
      [revision(
        "first",
        "2026-08-10T00:00:00.000Z",
        {
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: { command: "initial-codex" },
          runtimeConfig: { model: "initial-model" },
        },
        { agentRuntimeType: "claude_local", agentRuntimeConfig: {}, runtimeConfig: {} },
      )],
    );

    expect(profile).toMatchObject({
      agentRuntimeType: "codex_local",
      runtimeConfig: { command: "initial-codex", model: "initial-model" },
      cwd: "/context-worktree",
      agentConfigRevisionId: "first",
    });
  });

  it("builds a profile-bound resolver and rejects a different binding runtime", () => {
    const resolver = createHistoricalRunRuntimeProviderCapabilityResolver(
      profileRun({
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          command: process.execPath,
          cwd: "/tmp",
          codexHome: "/tmp/codex-home",
          providerVersion: "0.155.0",
          nativeCapabilityMethods: { threadRead: true, threadResume: true, threadFork: true },
        },
      }),
      [],
    );
    const binding = {
      orgId: "org-1",
      hostId: "local",
      profileId: "historical-codex",
      capabilityRevision: "cap-1",
    };

    const resolution = resolver("codex_local", binding, {
      session: {
        sessionId: "thread-1",
        sessionDisplayId: "thread-1",
        sessionParams: { cwd: "/tmp" },
      },
    });

    expect(resolution).toMatchObject({
      profileResolved: true,
      binding,
      adapter: {
        runtimeType: "codex_local",
        transcript: { evidence: { profileBound: true } },
      },
    });
    expect(resolver("claude_local", binding)).toBeNull();
  });

  it.each(["opencode_local", "pi_local"] as const)(
    "does not let persisted %s transport self-attest a historical profile",
    (runtimeType) => {
      const session = persistedTransport(runtimeType);
      const run = profileRun({
        agentRuntimeType: runtimeType,
        agentRuntimeConfig: {},
        runtimeConfig: {},
        sessionParamsBeforeJson: session.sessionParams,
      });
      expect(resolveHistoricalRunRuntimeProfile(run, []).cwd).toBeNull();

      const resolver = createHistoricalRunRuntimeProviderCapabilityResolver(run, []);
      expect(resolver(runtimeType, binding, { session })).toBeNull();
    },
  );

  it.each(["opencode_local", "pi_local"] as const)(
    "accepts an independently resolved %s historical transport",
    (runtimeType) => {
      const transport = independentTransport(runtimeType);
      const session = persistedTransport(runtimeType);
      const runtimeProviderProfile = runtimeType === "opencode_local"
        ? {
          ...buildRuntimeProviderProfileSnapshot(runtimeType, { ...transport, exportEnv: {} }),
          serverUrl: transport.serverUrl,
        }
        : {
          ...buildRuntimeProviderProfileSnapshot(runtimeType, { ...transport, rpcEnv: {} }),
          rpcArgs: Array.isArray(transport.rpcArgs) ? [...transport.rpcArgs] : [],
        };
      const matchingSession = runtimeType === "opencode_local"
        ? {
          ...session,
          sessionParams: {
            ...session.sessionParams,
            cwd: transport.cwd,
            directory: transport.cwd,
            providerVersion: transport.providerVersion,
          },
        }
        : {
          ...session,
          sessionId: `${transport.sessionDir}/session.jsonl`,
          sessionParams: {
            ...session.sessionParams,
            sessionId: `${transport.sessionDir}/session.jsonl`,
            sessionFile: `${transport.sessionDir}/session.jsonl`,
            transport: "pi-rpc-stdio",
            profileOrgId: binding.orgId,
            sessionDir: transport.sessionDir,
            cwd: transport.cwd,
            rpcArgs: "rpcArgs" in transport && Array.isArray(transport.rpcArgs)
              ? [...transport.rpcArgs]
              : [],
            command: transport.command,
            providerVersion: transport.providerVersion,
          },
        };
      const resolver = createHistoricalRunRuntimeProviderCapabilityResolver(
        profileRun({
          agentRuntimeType: runtimeType,
          agentRuntimeConfig: transport,
          runtimeConfig: {},
          contextSnapshot: { runtimeProviderProfile },
          sessionParamsBeforeJson: matchingSession.sessionParams,
        }),
        [],
      );

      const resolution = resolver(runtimeType, binding, { session: matchingSession });
      expect(resolution).toMatchObject({
        profileResolved: true,
        binding,
        adapter: {
          runtimeType,
          transcript: { evidence: { status: "supported", profileBound: true } },
        },
      });
    },
  );

  it.each(["opencode_local", "pi_local"] as const)(
    "rejects persisted %s environment drift even with an independent transport profile",
    (runtimeType) => {
      const transport = independentTransport(runtimeType);
      const session = persistedTransport(runtimeType);
      const runtimeProviderProfile = runtimeType === "opencode_local"
        ? {
          ...buildRuntimeProviderProfileSnapshot(runtimeType, { ...transport, exportEnv: {} }),
          serverUrl: transport.serverUrl,
        }
        : {
          ...buildRuntimeProviderProfileSnapshot(runtimeType, { ...transport, rpcEnv: {} }),
          rpcArgs: Array.isArray(transport.rpcArgs) ? [...transport.rpcArgs] : [],
        };
      const driftedSession = runtimeType === "opencode_local"
        ? {
          ...session,
          sessionParams: {
            ...session.sessionParams,
            cwd: transport.cwd,
            directory: transport.cwd,
            exportEnv: { HOME: "/tmp/attacker-home" },
            providerVersion: transport.providerVersion,
          },
        }
        : {
          ...session,
          sessionParams: {
            ...session.sessionParams,
            sessionDir: transport.sessionDir,
            cwd: transport.cwd,
            rpcArgs: [...transport.rpcArgs!],
            command: transport.command,
            rpcEnv: { HOME: "/tmp/attacker-home" },
            providerVersion: transport.providerVersion,
          },
        };
      const resolver = createHistoricalRunRuntimeProviderCapabilityResolver(
        profileRun({
          agentRuntimeType: runtimeType,
          agentRuntimeConfig: transport,
          runtimeConfig: {},
          contextSnapshot: { runtimeProviderProfile },
          sessionParamsBeforeJson: driftedSession.sessionParams,
        }),
        [],
      );

      expect(resolver(runtimeType, binding, { session: driftedSession })).toBeNull();
    },
  );

  it("uses the selected OpenCode Run's config path after a later turn updates the Segment", () => {
    const transport = independentTransport("opencode_local");
    const selectedRunId = "run-old";
    const laterRunId = "run-later";
    const operatorHome = "/tmp/opencode-operator-home";
    const managedHome = "/tmp/opencode-managed-home";
    const exportEnv = {
      HOME: operatorHome,
      USERPROFILE: operatorHome,
      RUDDER_OPERATOR_HOME: operatorHome,
      XDG_CONFIG_HOME: `${managedHome}/.config`,
      XDG_DATA_HOME: `${managedHome}/.local/share`,
      XDG_CACHE_HOME: `${managedHome}/.cache`,
    };
    const selectedExportEnv = {
      ...exportEnv,
      OPENCODE_CONFIG: `${managedHome}/runtime-tmp/${selectedRunId}/opencode.json`,
    };
    const laterSegmentExportEnv = {
      ...exportEnv,
      OPENCODE_CONFIG: `${managedHome}/runtime-tmp/${laterRunId}/opencode.json`,
    };
    const selectedParams = {
      ...persistedTransport("opencode_local").sessionParams,
      cwd: transport.cwd, directory: transport.cwd, providerVersion: transport.providerVersion,
      exportEnv: selectedExportEnv,
    };
    const runContext = { runtimeProviderProfile: {
      ...buildRuntimeProviderProfileSnapshot("opencode_local", { ...transport, exportEnv }),
      serverUrl: transport.serverUrl,
    } };
    const session = persistedTransport("opencode_local");
    const readerInput = {
      orgId: binding.orgId,
      run: {
        id: selectedRunId,
        orgId: binding.orgId,
        contextSnapshot: runContext,
        sessionParamsAfterJson: selectedParams,
      },
      binding: { id: "binding-1", orgId: binding.orgId },
      segment: {
        id: "segment-1",
        orgId: binding.orgId,
        bindingId: "binding-1",
        nativeSessionId: session.sessionId,
        providerStateJson: { exportEnv: laterSegmentExportEnv },
      },
      span: {
        id: "span-1",
        orgId: binding.orgId,
        runId: selectedRunId,
        bindingId: "binding-1",
        segmentId: "segment-1",
      },
    } as unknown as NonNullable<RuntimeProviderCapabilityResolverContext["readerInput"]>;
    const context: RuntimeProviderCapabilityResolverContext = {
      session: {
        ...session,
        sessionParams: { ...session.sessionParams, exportEnv: laterSegmentExportEnv },
      },
      readerInput,
    };
    const resolver = createHistoricalRunRuntimeProviderCapabilityResolver(profileRun({
      id: selectedRunId,
      orgId: binding.orgId,
      agentRuntimeType: "opencode_local",
      agentRuntimeConfig: transport,
      runtimeConfig: {},
      contextSnapshot: runContext,
      sessionParamsAfterJson: selectedParams,
    }), []);
    const resolution = resolver("opencode_local", binding, context);
    expect(resolution).toMatchObject({ profileResolved: true, adapter: {
      transcript: { evidence: { status: "supported", profileBound: true } },
    } });
    expect(resolver("opencode_local", binding, {
      ...context,
      readerInput: {
        ...readerInput,
        run: { ...readerInput.run, id: laterRunId },
      } as typeof readerInput,
    })).toBeNull();
    expect(resolver("opencode_local", binding, {
      ...context,
      readerInput: { ...readerInput, orgId: "org-2" } as typeof readerInput,
    })).toBeNull();
  });
});
