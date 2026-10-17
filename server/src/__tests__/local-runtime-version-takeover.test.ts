import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startManagedLocalServer } from "../index.js";
import { resolveLocalRuntimePaths } from "../local-runtime.js";
import { serverVersion } from "../version.js";

describe("local runtime version takeover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { nativeRequired: false, version: "0.0.0-active-run", expected: "already running version 0.0.0-active-run" },
    { nativeRequired: true, version: serverVersion, expected: "does not provide Rust Native Chat" },
  ])("preserves an existing runtime rather than attaching with an incompatible contract ($nativeRequired)", async ({ nativeRequired, version, expected }) => {
    const previousIngressMode = process.env.RUDDER_RUST_PUBLIC_INGRESS_MODE;
    process.env.RUDDER_RUST_PUBLIC_INGRESS_MODE = nativeRequired ? "required" : "off";
    const previousHome = process.env.RUDDER_HOME;
    const previousInstanceId = process.env.RUDDER_INSTANCE_ID;
    const previousLocalEnv = process.env.RUDDER_LOCAL_ENV;
    const home = await mkdtemp(path.join(tmpdir(), "rudder-runtime-version-guard."));
    const oldVersion = version;
    const healthServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        status: "ok",
        version: oldVersion,
        instanceId: "default",
        localEnv: "prod_local",
        runtimeOwnerKind: "desktop",
        activeRunCount: 1,
      }));
    });

    process.env.RUDDER_HOME = home;
    process.env.RUDDER_INSTANCE_ID = "default";
    process.env.RUDDER_LOCAL_ENV = "prod_local";
    await new Promise<void>((resolve, reject) => {
      healthServer.once("error", reject);
      healthServer.listen(0, "127.0.0.1", resolve);
    });
    const address = healthServer.address();
    if (!address || typeof address === "string") throw new Error("Test health server did not expose a TCP address.");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const paths = resolveLocalRuntimePaths("default");
    await mkdir(paths.runtimeDir, { recursive: true });
    await writeFile(paths.descriptorPath, `${JSON.stringify({
      instanceId: "default",
      localEnv: "prod_local",
      pid: process.pid,
      listenPort: address.port,
      apiUrl,
      version: oldVersion,
      ownerKind: "desktop",
      startedAt: new Date().toISOString(),
      activeRunCount: 1,
    })}\n`, "utf8");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      await expect(startManagedLocalServer({
        ownerKind: "cli",
        takeoverOnVersionMismatch: false,
      })).rejects.toThrow(expected);
      expect(killSpy.mock.calls.some(([, signal]) => signal === "SIGTERM")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
      if (previousIngressMode === undefined) delete process.env.RUDDER_RUST_PUBLIC_INGRESS_MODE;
      else process.env.RUDDER_RUST_PUBLIC_INGRESS_MODE = previousIngressMode;
      if (previousHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = previousHome;
      if (previousInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = previousInstanceId;
      if (previousLocalEnv === undefined) delete process.env.RUDDER_LOCAL_ENV;
      else process.env.RUDDER_LOCAL_ENV = previousLocalEnv;
    }
  });
});
