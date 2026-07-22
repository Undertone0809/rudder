import { describe, expect, it, vi } from "vitest";
import {
  assertExactLocalAppSavedViewTarget,
  assertNoLocalAppRuntimeDetails,
  assertStrictLoopbackAttestation,
  expectedLocalAppPartitionId,
  proveLocalAppEmergencyOwnership,
  terminateProvenLocalAppProcessGroup,
} from "./local-app-smoke-helpers.mjs";

const definition = {
  id: "definition-a",
  desktopInstallationId: "install-a",
  appPublicId: "public-a",
  localBindingId: "binding-a",
  cwd: "/private/tmp/local-app",
  executable: "/opt/node/bin/npm",
  argv: ["run", "dev"],
  inheritedEnvNames: ["RUDDER_LOCAL_APP_TEST_SECRET"],
  readiness: { path: "/health", timeoutMs: 10_000 },
  openPath: "/outreach",
};
const expectedTarget = {
  kind: "local_app",
  desktopInstallationId: definition.desktopInstallationId,
  appPublicId: definition.appPublicId,
  localBindingId: definition.localBindingId,
  viewInstanceId: "view-a",
};

describe("Local App smoke helpers", () => {
  it("derives and independently enforces the exact loopback origin and partition", () => {
    expect(expectedLocalAppPartitionId("install-a", "definition-a"))
      .toBe("persist:rudder-local-app-26e2460901408e58ba3ac4e61b708e02");
    expect(assertStrictLoopbackAttestation({
      origin: "http://127.0.0.1:43123",
      openPath: "/outreach",
      partition: "persist:rudder-local-app-26e2460901408e58ba3ac4e61b708e02",
    }, definition, "install-a")).toEqual({
      expectedPartition: "persist:rudder-local-app-26e2460901408e58ba3ac4e61b708e02",
      expectedUrl: "http://127.0.0.1:43123/outreach",
      port: 43123,
    });
    for (const origin of [
      "https://127.0.0.1:43123",
      "http://localhost:43123",
      "http://user:password@127.0.0.1:43123",
      "http://127.0.0.1:43123/untrusted",
    ]) {
      expect(() => assertStrictLoopbackAttestation({
        origin,
        openPath: "/outreach",
        partition: expectedLocalAppPartitionId("install-a", "definition-a"),
      }, definition, "install-a")).toThrow();
    }
  });

  it("accepts only five public Saved View identity fields and never prints a secret", () => {
    expect(() => assertExactLocalAppSavedViewTarget(expectedTarget, expectedTarget, "request")).not.toThrow();
    expect(() => assertExactLocalAppSavedViewTarget({ ...expectedTarget, cwd: definition.cwd }, expectedTarget, "request"))
      .toThrow("exactly the five public identity fields");
    const secret = "never-print-this-local-app-secret";
    let error;
    try {
      assertNoLocalAppRuntimeDetails({ metadata: { token: secret } }, {
        definition,
        envNames: definition.inheritedEnvNames,
        envValues: [secret],
        label: "response",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(secret);
    expect(() => assertNoLocalAppRuntimeDetails({ savedView: { targetPayload: expectedTarget } }, {
      definition,
      envNames: definition.inheritedEnvNames,
      envValues: [secret],
      label: "response",
    })).not.toThrow();
  });

  it("requires safe registry, ps, and lsof agreement before emergency signaling", async () => {
    const descriptor = { pid: 42, pgid: 42, port: 43123 };
    const processes = [
      { pid: 42, pgid: 42, command: "npm run dev" },
      { pid: 43, pgid: 42, command: "node server.mjs" },
    ];
    expect(proveLocalAppEmergencyOwnership({ descriptor, listenerPids: [43], processes })).toBe(true);
    expect(proveLocalAppEmergencyOwnership({ descriptor: { ...descriptor, pgid: 1 }, listenerPids: [43], processes }))
      .toBe(false);
    expect(proveLocalAppEmergencyOwnership({ descriptor, listenerPids: [99], processes })).toBe(false);
    let alive = true;
    const signalGroup = vi.fn(async (_pgid, signal) => {
      if (signal === "SIGKILL") alive = false;
    });
    await terminateProvenLocalAppProcessGroup({
      descriptor,
      delay: async () => undefined,
      killTimeoutMs: 1,
      pollMs: 1,
      readListenerPids: async () => alive ? [43] : [],
      readProcesses: async () => alive ? processes : [],
      signalGroup,
      termTimeoutMs: 1,
    });
    expect(signalGroup.mock.calls).toEqual([[42, "SIGTERM"], [42, "SIGKILL"]]);
    const refusedSignal = vi.fn();
    await expect(terminateProvenLocalAppProcessGroup({
      descriptor,
      readListenerPids: async () => [99],
      readProcesses: async () => processes,
      signalGroup: refusedSignal,
    })).rejects.toThrow("ownership proof");
    expect(refusedSignal).not.toHaveBeenCalled();
  });
});
