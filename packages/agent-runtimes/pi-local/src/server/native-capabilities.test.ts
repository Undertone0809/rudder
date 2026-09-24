import { describe, expect, it, vi } from "vitest";
import {
  createPiLocalProviderCapabilityResolver,
  type PiLocalProfileTransport,
  runtimeProviderCapabilities,
} from "./index.js";

const binding = {
  id: "binding-1",
  orgId: "org-1",
  hostId: "local",
  profileId: "pi-profile",
  workspaceBindingId: "workspace-binding-1",
  capabilityRevision: "cap-1",
};
const profile: PiLocalProfileTransport = {
  binding,
  providerVersion: "0.1.0",
  command: "pi",
  cwd: "/tmp/pi-workspace",
  sessionDir: "/tmp",
  rpcArgs: ["--extension", "managed-extension"],
  rpcEnv: {},
};

function persistedSession() {
  return {
    sessionId: "/tmp/pi-session.jsonl",
    sessionDisplayId: "pi-parent",
    sessionParams: {
      sessionId: "/tmp/pi-session.jsonl",
      sessionFile: "/tmp/pi-session.jsonl",
      sessionDir: "/tmp",
      cwd: profile.cwd,
      command: profile.command,
      rpcArgs: [...profile.rpcArgs!],
      rpcEnv: { ...profile.rpcEnv },
      hostId: binding.hostId,
      profileId: binding.profileId,
      profileBindingId: binding.id,
      profileOrgId: binding.orgId,
      workspaceBindingId: binding.workspaceBindingId,
      capabilityRevision: binding.capabilityRevision,
      transport: "pi-rpc-stdio",
      providerVersion: profile.providerVersion,
    },
  };
}

describe("Pi profile-bound capability resolver", () => {
  it("does not advertise the static declaration as profile-bound", () => {
    expect(runtimeProviderCapabilities.transcript.evidence).toMatchObject({
      status: "unknown",
      profileBound: false,
      profileRequired: true,
    });
  });

  it("attests a profile resolver while keeping RPC transport in persisted session state", () => {
    const resolver = createPiLocalProviderCapabilityResolver(() => profile);
    const adapter = resolver("pi_local", binding)!;

    expect(adapter.transcript.evidence).toMatchObject({ status: "supported", profileBound: true, profileRequired: true });
    expect(adapter.fork.evidence).toMatchObject({ status: "supported", profileBound: true, profileRequired: true });
    expect(adapter.control.steer.evidence).toMatchObject({ status: "supported", profileBound: true, profileRequired: true });
  });

  it("does not treat persisted session RPC args as host profile authority", async () => {
    const profileWithoutArgs: PiLocalProfileTransport = { ...profile, rpcArgs: undefined };
    const resolver = createPiLocalProviderCapabilityResolver(() => profileWithoutArgs);
    const session = persistedSession();
    const adapter = resolver("pi_local", binding, { session })!;

    expect(adapter.transcript.evidence).toMatchObject({ status: "unknown", profileBound: false });
    expect(adapter.fork.evidence).toMatchObject({ status: "unknown", profileBound: false });
    await expect(adapter.transcript.readRange({ runtimeType: "pi_local", session, binding }))
      .resolves.toMatchObject({ availability: "incompatible" });
    await expect(adapter.fork.fork({ runtimeType: "pi_local", session, binding, boundary: "leaf-1" }))
      .rejects.toMatchObject({ status: "unknown" });
  });

  it("requires persisted args to exactly match the host-owned profile before native operations", async () => {
    const resolver = createPiLocalProviderCapabilityResolver(() => profile);
    const session = persistedSession();
    const adapter = resolver("pi_local", binding, { session })!;

    expect(adapter.transcript.evidence).toMatchObject({ status: "supported", profileBound: true });
    const matchingRead = await adapter.transcript.readRange({ runtimeType: "pi_local", session, binding });
    expect(matchingRead.revision).not.toContain("RPC args do not match");

    const forgedSession = {
      ...session,
      sessionParams: { ...session.sessionParams, rpcArgs: ["--extension", "attacker-extension"] },
    };
    const forged = resolver("pi_local", binding, { session: forgedSession })!;
    expect(forged.transcript.evidence).toMatchObject({ status: "unknown", profileBound: false });
    await expect(forged.transcript.readRange({ runtimeType: "pi_local", session: forgedSession, binding }))
      .resolves.toMatchObject({ availability: "incompatible", revision: expect.stringContaining("RPC args do not match") });
    await expect(forged.fork.fork({ runtimeType: "pi_local", session: forgedSession, binding, boundary: "leaf-1" }))
      .rejects.toMatchObject({ status: "unknown" });
  });

  it("does not infer persisted RPC args when no session evidence is available", () => {
    const resolver = createPiLocalProviderCapabilityResolver(() => ({ ...profile, rpcArgs: undefined }));
    const adapter = resolver("pi_local", binding)!;

    expect(adapter.transcript.evidence).toMatchObject({
      status: "unknown",
      profileBound: false,
      profileRequired: true,
    });
  });

  it("rejects missing persisted transport and does not forward control to a live handle", async () => {
    const resolver = createPiLocalProviderCapabilityResolver(() => profile);
    const adapter = resolver("pi_local", binding)!;
    const session = persistedSession();
    const steer = vi.fn().mockResolvedValue({
      disposition: "accepted_current" as const,
      providerThreadId: "pi-parent",
      providerTurnId: "turn-1",
    });
    const interrupt = vi.fn().mockResolvedValue("acknowledged" as const);
    const missingTransport = {
      ...session,
      sessionParams: { sessionId: session.sessionId, hostId: binding.hostId, profileId: binding.profileId },
    };

    await expect(adapter.transcript.readRange({
      runtimeType: "pi_local",
      session: missingTransport,
      binding,
    })).resolves.toMatchObject({ availability: "incompatible" });
    await expect(adapter.fork.fork({
      runtimeType: "pi_local",
      session: missingTransport,
      boundary: "leaf-1",
      binding,
    })).rejects.toMatchObject({ status: "unsupported" });
    await expect(adapter.control.steer.execute({
      runtimeType: "pi_local",
      handle: { steer, interrupt },
      operation: { kind: "steer", input: { text: "continue", clientMessageId: "m-1" } },
      session: missingTransport,
      binding,
    })).resolves.toMatchObject({ disposition: "acceptance_unknown" });
    expect(steer).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("fails closed for transport, profile, workspace, and provider-version drift", async () => {
    const resolver = createPiLocalProviderCapabilityResolver(() => profile);
    const adapter = resolver("pi_local", binding)!;
    const session = persistedSession();
    const read = (sessionParams: Record<string, unknown>, workspace?: Record<string, string>) => adapter.transcript.readRange({
      runtimeType: "pi_local",
      session: { ...session, sessionParams },
      binding,
      workspace,
    });

    await expect(read({ ...session.sessionParams, transport: "pi-cli" })).resolves.toMatchObject({
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
