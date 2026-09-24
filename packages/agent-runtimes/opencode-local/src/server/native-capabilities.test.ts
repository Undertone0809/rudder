import { describe, expect, it } from "vitest";
import {
  createOpenCodeLocalProviderCapabilityResolver,
  type OpenCodeLocalProfileTransport,
  runtimeProviderCapabilities,
} from "./index.js";

const binding = {
  id: "binding-1",
  orgId: "org-1",
  hostId: "local",
  profileId: "opencode-profile",
  workspaceBindingId: "workspace-binding-1",
  capabilityRevision: "cap-1",
};
const profile: OpenCodeLocalProfileTransport = {
  binding,
  providerVersion: "1.0.0",
  command: "opencode",
  cwd: "/tmp/opencode-workspace",
};

function persistedSession() {
  return {
    sessionId: "session-1",
    sessionDisplayId: "session-1",
    sessionParams: {
      sessionId: "session-1",
      hostId: binding.hostId,
      profileId: binding.profileId,
      profileBindingId: binding.id,
      profileOrgId: binding.orgId,
      workspaceBindingId: binding.workspaceBindingId,
      capabilityRevision: binding.capabilityRevision,
      transport: "opencode-managed-server-http",
      serverUrl: "http://127.0.0.1:43123",
      cwd: profile.cwd,
      directory: profile.cwd,
      serverCommand: profile.command,
      exportCommand: profile.command,
      exportEnv: {},
      providerVersion: profile.providerVersion,
    },
  };
}

describe("OpenCode profile-bound capability resolver", () => {
  it("does not advertise the static declaration as profile-bound", () => {
    expect(runtimeProviderCapabilities.transcript.evidence).toMatchObject({
      status: "unknown",
      profileBound: false,
      profileRequired: true,
    });
  });

  it("attests a profile resolver while keeping transport in persisted session state", () => {
    const resolver = createOpenCodeLocalProviderCapabilityResolver(() => profile);
    const adapter = resolver("opencode_local", binding)!;

    expect(adapter.transcript.evidence).toMatchObject({ status: "supported", profileBound: true, profileRequired: true });
    expect(adapter.fork.evidence).toMatchObject({ status: "supported", profileBound: true, profileRequired: true });
    expect(resolver("opencode_local", { ...binding, profileId: "other" })?.transcript.evidence.profileBound).toBe(false);
  });

  it("rejects missing persisted transport before any native request can run", async () => {
    const resolver = createOpenCodeLocalProviderCapabilityResolver(() => profile);
    const adapter = resolver("opencode_local", binding)!;
    const session = persistedSession();
    const missingTransport = {
      ...session,
      sessionParams: { sessionId: session.sessionId, hostId: binding.hostId, profileId: binding.profileId },
    };

    await expect(adapter.transcript.readRange({
      runtimeType: "opencode_local",
      session: missingTransport,
      binding,
    })).resolves.toMatchObject({ availability: "incompatible" });
    await expect(adapter.fork.fork({
      runtimeType: "opencode_local",
      session: missingTransport,
      boundary: "message-1",
      binding,
    })).rejects.toMatchObject({ status: "unsupported" });
  });

  it("fails closed for transport, profile, workspace, and provider-version drift", async () => {
    const resolver = createOpenCodeLocalProviderCapabilityResolver(() => profile);
    const adapter = resolver("opencode_local", binding)!;
    const session = persistedSession();
    const read = (sessionParams: Record<string, unknown>, workspace?: Record<string, string>) => adapter.transcript.readRange({
      runtimeType: "opencode_local",
      session: { ...session, sessionParams },
      binding,
      workspace,
    });

    await expect(read({ ...session.sessionParams, transport: "opencode-cli" })).resolves.toMatchObject({
      availability: "incompatible",
    });
    await expect(read({ ...session.sessionParams, profileOrgId: "org-2" })).resolves.toMatchObject({
      availability: "incompatible",
    });
    await expect(read(session.sessionParams, { workspaceId: "workspace-2" })).resolves.toMatchObject({
      availability: "incompatible",
    });
    await expect(read({ ...session.sessionParams, providerVersion: "older-version" })).resolves.toMatchObject({
      availability: "incompatible",
    });
  });
});
