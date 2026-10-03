import { describe, expect, it } from "vitest";
import { filterNativeTransportProfile } from "../services/runtime-kernel/native-transport-profile.js";
import { createProfileBoundRuntimeProviderCapabilityResolverFromConfig } from "./index.js";

const binding = {
  id: "binding-1", orgId: "org-1", hostId: "local", profileId: "profile-1",
  workspaceBindingId: "workspace-1", capabilityRevision: "revision-1",
};

describe("Pi first-run Host transport witness", () => {
  const preparedConfig = {
    runtimeType: "pi_local",
    providerVersion: "0.76.0",
    cwd: "/workspace",
    command: "pi",
    sessionDir: "/managed/sessions",
    rpcEnv: { HOME: "/operator", PI_CODING_AGENT_SESSION_DIR: "/managed/sessions" },
  };

  it("does not attest native retention from a version and session directory alone", () => {
    const resolution = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      runtimeType: "pi_local", runtimeConfig: preparedConfig, cwd: preparedConfig.cwd,
    })("pi_local", binding);
    expect(resolution).toMatchObject({ adapter: { transcript: { evidence: { status: "unknown" } } } });
  });

  it("attests the Adapter-reported RPC transport before the first provider session exists", () => {
    const reported = filterNativeTransportProfile({
      runtimeType: "pi_local", command: "pi", cwd: "/workspace",
      sessionDir: "/managed/sessions", rpcArgs: ["--extension", "/managed/rudder-tools.ts"],
      rpcEnv: preparedConfig.rpcEnv,
    });
    const resolution = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      runtimeType: "pi_local", runtimeConfig: { ...preparedConfig, ...reported }, cwd: preparedConfig.cwd,
    })("pi_local", binding, { session: null });
    expect(resolution).toMatchObject({
      profileResolved: true,
      adapter: { transcript: { evidence: { status: "supported", profileBound: true } } },
    });
  });
});
