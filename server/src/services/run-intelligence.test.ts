import { describe, expect, it } from "vitest";
import { buildRuntimeProviderProfileSnapshot } from "../agent-runtimes/runtime-provider-profile-snapshot.js";
import {
  createHistoricalRunRuntimeProviderCapabilityResolver,
  resolveHistoricalRunRuntimeProfile,
  type HistoricalRunConfigRevision,
  type HistoricalRunProfileRun,
} from "./run-intelligence.js";

function profileRun(overrides: Partial<HistoricalRunProfileRun> = {}): HistoricalRunProfileRun {
  return {
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
    const exportEnv = { XDG_DATA_HOME: "/tmp/opencode-home/.local/share" };
    const selectedParams = {
      ...persistedTransport("opencode_local").sessionParams,
      cwd: transport.cwd, directory: transport.cwd, providerVersion: transport.providerVersion,
      exportEnv: { ...exportEnv, OPENCODE_CONFIG: "/tmp/opencode-home/runtime-tmp/run-old/opencode.json" },
    };
    const resolver = createHistoricalRunRuntimeProviderCapabilityResolver(profileRun({
      agentRuntimeType: "opencode_local", agentRuntimeConfig: transport, runtimeConfig: {},
      contextSnapshot: { runtimeProviderProfile: {
        ...buildRuntimeProviderProfileSnapshot("opencode_local", { ...transport, exportEnv }),
        serverUrl: transport.serverUrl,
      } },
      sessionParamsAfterJson: selectedParams,
    }), []);
    const session = persistedTransport("opencode_local");
    const resolution = resolver("opencode_local", binding, {
      session: { ...session, sessionParams: {
        ...selectedParams,
        exportEnv: { ...exportEnv, OPENCODE_CONFIG: "/tmp/opencode-home/runtime-tmp/run-later/opencode.json" },
      } },
      readerInput: { run: { id: "run-old", sessionParamsAfterJson: selectedParams } } as any,
    });
    expect(resolution).toMatchObject({ profileResolved: true, adapter: {
      transcript: { evidence: { status: "supported", profileBound: true } },
    } });
  });
});
