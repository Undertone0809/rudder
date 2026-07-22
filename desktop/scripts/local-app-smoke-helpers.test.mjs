import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  assertExactLocalAppSavedViewTarget,
  assertNoLocalAppRuntimeDetails,
  assertStrictLoopbackAttestation,
  expectedLocalAppPartitionId,
  parseLocalAppLsofListenerProcessRecords,
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
  it("requires the smoke lsof proof to inspect every structured listener address", () => {
    const smokeSource = readFileSync(new URL("./smoke.mjs", import.meta.url), "utf8");
    const readerStart = smokeSource.indexOf("async function readLocalAppListeners");
    const readerEnd = smokeSource.indexOf("\nasync function readLocalAppRuntimeDescriptor", readerStart);
    expect(readerStart).toBeGreaterThanOrEqual(0);
    expect(readerEnd).toBeGreaterThan(readerStart);
    const readerSource = smokeSource.slice(readerStart, readerEnd);
    expect(readerSource).toContain('"-Fpn"');
    expect(readerSource).toContain("parseLocalAppLsofListenerProcessRecords");

    const assertionStart = smokeSource.indexOf("async function assertLocalAppRuntimeRunning");
    const assertionEnd = smokeSource.indexOf("\nasync function assertLocalAppRuntimeStopped", assertionStart);
    const assertionSource = smokeSource.slice(assertionStart, assertionEnd);
    expect(assertionSource).toContain("expectedListenerAddress");
    expect(assertionSource).toContain("listener.addresses.every");
  });

  it("independently parses exact IPv4 loopback lsof records and rejects ambiguous process records", () => {
    expect(parseLocalAppLsofListenerProcessRecords(
      "p42\nf14\nn127.0.0.1:43123\np43\nf15\nn127.0.0.1:43123\n",
      43_123,
    )).toEqual([
      { pid: 42, addresses: ["127.0.0.1:43123"] },
      { pid: 43, addresses: ["127.0.0.1:43123"] },
    ]);
    expect(() => parseLocalAppLsofListenerProcessRecords(
      "p42\nf14\nn127.0.0.1:43123\np42\nf15\nn127.0.0.1:43123\n",
      43_123,
    )).toThrow("duplicate");
  });

  it.each(["*:43123", "0.0.0.0:43123", "[::]:43123", "localhost:43123", "127.0.0.1:43124"])(
    "independently rejects the unsafe lsof listener address %s",
    (address) => {
      expect(() => parseLocalAppLsofListenerProcessRecords(`p42\nf14\nn${address}\n`, 43_123))
        .toThrow("exact IPv4 loopback");
    },
  );

  it("wires the independently derived partition into the webview probe", () => {
    const smokeSource = readFileSync(new URL("./smoke.mjs", import.meta.url), "utf8");
    const functionStart = smokeSource.indexOf("async function waitForLocalAppWebview");
    const functionEnd = smokeSource.indexOf("\nasync function runLocalAppsScenario", functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const probeSource = smokeSource.slice(functionStart, functionEnd);
    expect(probeSource).toContain("expectedPartition,\n    expectedUrl,");
    expect(probeSource).not.toContain("attested.partition");
  });

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
