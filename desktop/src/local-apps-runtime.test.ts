import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LocalAppRegistry } from "./local-apps-registry.js";
import {
  LocalAppRuntimeManager,
  installControlPipeEofCleanup,
  localAppPartitionId,
  terminateOwnedProcessGroup,
} from "./local-apps-runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/local-app-http-fixture.mjs", import.meta.url));
const watchdogPath = fileURLToPath(new URL("./local-app-watchdog-runner.mjs", import.meta.url));

async function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function approvedFixture(options: { readinessPath?: string; maxLogBytes?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-runtime-"));
  const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
  const prepared = await registry.prepareDefinition({
    title: "HTTP fixture",
    executable: process.execPath,
    argv: [fixturePath],
    cwd: root,
    inheritedEnvNames: [],
    readiness: { path: options.readinessPath ?? "/health", timeoutMs: 4_000 },
    openPath: "/app",
  });
  const definition = await registry.createDefinition({ ...prepared, approvedFingerprint: prepared.trustFingerprint });
  await registry.approveDefinition(definition.id, prepared.trustFingerprint);
  return { root, registry, definition };
}

describe("Desktop Local App runtime", () => {
  it("spawns shell-free on an automatic loopback port, deduplicates start, bounds logs, and attests origin/partition", async () => {
    const { registry, definition } = await approvedFixture();
    const manager = new LocalAppRuntimeManager({ registry, platform: "darwin", maxLogBytes: 256 });
    const [first, second] = await Promise.all([manager.start(definition.id), manager.start(definition.id)]);
    expect(first.generation).toBe(second.generation);
    expect(first.status).toBe("running");
    expect(first.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(first.openPath).toBe("/app");
    expect(first.partition).toBe(localAppPartitionId("install-a", definition.id));
    expect(manager.isAttestedBootstrap(`${first.origin}/app`, first.partition!)).toBe(true);
    expect(manager.isAttestedBootstrap(`${first.origin}/other`, first.partition!)).toBe(false);
    expect(manager.isAttestedBootstrap(`${first.origin}/app`, "persist:rudder-local-app-wrong")).toBe(false);
    expect(manager.isAttestedNavigation(`${first.origin}/asset.js`, first.partition!)).toBe(true);
    expect(manager.isAttestedNavigation(first.origin.replace("127.0.0.1", "localhost"), first.partition!)).toBe(false);
    expect((await fetch(`${first.origin}/health`)).status).toBe(200);
    const childEnvironment = await fetch(`${first.origin}/env`).then((response) => response.json()) as { path?: string };
    expect(childEnvironment.path?.split(path.delimiter)).toContain(path.dirname(process.execPath));
    expect((await manager.logs(definition.id)).join("\n").length).toBeLessThanOrEqual(256);
    await manager.stop(definition.id);
    expect((await manager.status(definition.id)).status).toBe("stopped");
  });

  it("fails closed on readiness failure or unproven listener ownership", async () => {
    const wrongHealth = await approvedFixture({ readinessPath: "/never" });
    const timeoutManager = new LocalAppRuntimeManager({ registry: wrongHealth.registry, platform: "darwin" });
    await expect(timeoutManager.start(wrongHealth.definition.id)).rejects.toThrow("readiness");
    expect((await timeoutManager.status(wrongHealth.definition.id)).status).toBe("failed");

    const unowned = await approvedFixture();
    const ownershipManager = new LocalAppRuntimeManager({
      registry: unowned.registry,
      platform: "darwin",
      verifyListenerOwnership: async () => false,
    });
    await expect(ownershipManager.start(unowned.definition.id)).rejects.toThrow("ownership");
    expect((await ownershipManager.status(unowned.definition.id)).status).toBe("failed");
  });

  it("uses TERM then bounded KILL only for a verified owned process group", async () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    let alive = true;
    await terminateOwnedProcessGroup(42, {
      killGroup: (pgid, signal) => { signals.push([pgid, signal]); if (signal === "SIGKILL") alive = false; },
      isGroupAlive: () => alive,
      delay: async () => undefined,
      termTimeoutMs: 10,
      pollMs: 5,
    });
    expect(signals).toEqual([[42, "SIGTERM"], [42, "SIGKILL"]]);
    await expect(terminateOwnedProcessGroup(null, {
      killGroup: vi.fn(), isGroupAlive: () => false, delay: async () => undefined,
    })).rejects.toThrow("unverified");
  });

  it("treats control-pipe EOF as idempotent cleanup and never kills an unverified orphan", async () => {
    const pipe = new EventEmitter();
    const cleanup = vi.fn(async () => undefined);
    installControlPipeEofCleanup(pipe, cleanup);
    pipe.emit("end");
    pipe.emit("close");
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));

    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-orphan-"));
    const registryPath = path.join(root, "registry.json");
    const registry = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    const prepared = await registry.prepareDefinition({
      title: "orphan", executable: process.execPath, argv: [fixturePath], cwd: root,
      inheritedEnvNames: [], readiness: { path: "/health", timeoutMs: 1_000 }, openPath: "/",
    });
    const definition = await registry.createDefinition({ ...prepared, approvedFingerprint: prepared.trustFingerprint });
    await registry.approveDefinition(definition.id, prepared.trustFingerprint);
    await registry.recordRuntimeDescriptor(definition.id, { status: "running", pid: 999_999, pgid: 999_999, generation: "old" });
    const reloaded = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    const killGroup = vi.fn();
    const manager = new LocalAppRuntimeManager({ registry: reloaded, platform: "darwin", killGroup });
    expect((await manager.status(definition.id)).status).toBe("orphaned_unverified");
    await expect(manager.stop(definition.id)).rejects.toThrow("unverified");
    expect(killGroup).not.toHaveBeenCalled();
  });

  it("uses a real watchdog whose parent control-pipe EOF cleans the owned app group", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-watchdog-"));
    const port = await unusedLoopbackPort();
    const watchdog = spawn(process.execPath, [watchdogPath], {
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const spawned = new Promise<{ pid: number; pgid: number }>((resolve, reject) => {
      watchdog.once("error", reject);
      watchdog.on("message", (message: unknown) => {
        const value = message as { type?: string; pid?: number; pgid?: number; message?: string };
        if (value.type === "spawned" && value.pid && value.pgid) resolve({ pid: value.pid, pgid: value.pgid });
        if (value.type === "error") reject(new Error(value.message));
      });
    });
    watchdog.send?.({
      type: "start",
      executable: process.execPath,
      argv: [fixturePath],
      cwd: root,
      env: {
        HOST: "127.0.0.1",
        PORT: String(port),
        PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      },
    });
    const child = await spawned;
    await vi.waitFor(async () => {
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    }, { timeout: 3_000 });

    watchdog.stdin?.end();
    await once(watchdog, "exit");
    expect(() => process.kill(child.pid, 0)).toThrow();
  });
});
