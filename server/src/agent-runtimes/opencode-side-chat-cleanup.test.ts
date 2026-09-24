import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeProviderCapabilityResolverContext } from "../services/runtime-kernel/provider-capabilities.js";
import { createProfileBoundRuntimeProviderCapabilityResolverFromConfig } from "./index.js";

const binding = {
  id: "side-chat-binding",
  orgId: "side-chat-org",
  hostId: "local",
  profileId: "opencode-profile",
  workspaceBindingId: "workspace-binding",
  capabilityRevision: "capability-revision",
};

const forkRunId = "side-chat-fork-run";
const managedHome = "/managed/opencode-home";
const exportEnv = {
  HOME: "/operator",
  XDG_CONFIG_HOME: path.join(managedHome, ".config"),
  XDG_DATA_HOME: path.join(managedHome, ".local", "share"),
  XDG_CACHE_HOME: path.join(managedHome, ".cache"),
};

function cleanupContext(runId = forkRunId): RuntimeProviderCapabilityResolverContext {
  return {
    cleanupRunId: runId,
    session: {
      sessionId: "opencode-side-chat-session",
      sessionDisplayId: "opencode-side-chat-session",
      sessionParams: {
        sessionId: "opencode-side-chat-session",
        profileBindingId: binding.id,
        profileOrgId: binding.orgId,
        hostId: binding.hostId,
        profileId: binding.profileId,
        workspaceBindingId: binding.workspaceBindingId,
        capabilityRevision: binding.capabilityRevision,
        transport: "opencode-managed-server-http",
        serverUrl: "http://127.0.0.1:43123",
        cwd: "/workspace",
        directory: "/workspace",
        serverCommand: "opencode",
        exportCommand: "opencode",
        providerVersion: "1.2.3",
        exportEnv: {
          ...exportEnv,
          OPENCODE_CONFIG: path.join(managedHome, "runtime-tmp", forkRunId, "opencode.json"),
        },
      },
    },
  };
}

function createResolver() {
  return createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
    runtimeType: "opencode_local",
    resolutionMode: "historical",
    cwd: "/workspace",
    runtimeConfig: {
      command: "opencode",
      serverCommand: "opencode",
      exportCommand: "opencode",
      providerVersion: "1.2.3",
      exportEnv,
    },
  });
}

describe("OpenCode Side Chat cleanup after restart", () => {
  it("resolves only the profile-bound cleanup hook without trusting the expired server URL", () => {
    const resolved = createResolver()("opencode_local", binding, cleanupContext());

    expect(resolved).toMatchObject({
      profileResolved: true,
      binding,
      adapter: {
        sideChatForkCleanup: {
          evidence: { status: "supported", profileBound: true },
          deleteForkedSession: expect.any(Function),
        },
        transcript: { evidence: { status: "unknown", profileBound: false } },
        fork: { evidence: { status: "unknown", profileBound: false } },
      },
    });
  });

  it("rejects persisted managed-config identity from a different fork run", () => {
    expect(createResolver()("opencode_local", binding, cleanupContext("another-run"))).toBeNull();
  });
});
