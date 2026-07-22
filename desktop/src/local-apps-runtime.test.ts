import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { access, chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

async function approvedFixture(options: {
  inheritedEnvNames?: string[];
  readinessPath?: string;
  readinessTimeoutMs?: number;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-runtime-"));
  const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
  const prepared = await registry.prepareDefinition({
    title: "HTTP fixture",
    executable: process.execPath,
    argv: [fixturePath],
    cwd: root,
    inheritedEnvNames: options.inheritedEnvNames ?? [],
    readiness: { path: options.readinessPath ?? "/health", timeoutMs: options.readinessTimeoutMs ?? 4_000 },
    openPath: "/app",
  });
  const definition = await registry.createDefinition({ ...prepared, approvedFingerprint: prepared.trustFingerprint });
  await registry.approveDefinition(definition.id, prepared.trustFingerprint);
  return { root, registry, definition };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function watchdogEmitting(message: unknown) {
  const helper = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn> };
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    send: ReturnType<typeof vi.fn>;
  };
  helper.stdout = new EventEmitter();
  helper.stderr = new EventEmitter();
  helper.stdin = { end: vi.fn() };
  helper.exitCode = null;
  helper.signalCode = null;
  helper.send = vi.fn((_payload: unknown, callback?: (error: Error | null) => void) => {
    queueMicrotask(() => helper.emit("message", message));
    callback?.(null);
  });
  return helper;
}

describe("Desktop Local App runtime", () => {
  it("derives a trusted Node bin for a realpathed npm CLI when the Desktop executable has no node", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-npm-prefix-"));
    const prefix = path.join(root, "node-prefix");
    const npmBin = path.join(prefix, "lib", "node_modules", "npm", "bin");
    const trustedBin = path.join(prefix, "bin");
    await mkdir(npmBin, { recursive: true });
    await mkdir(trustedBin, { recursive: true });
    const trustedNode = path.join(trustedBin, "node");
    await writeFile(trustedNode, [
      "#!/bin/sh",
      "export RUDDER_TRUSTED_NODE_PREFIX=1",
      `exec '${process.execPath}' "$@"`,
      "",
    ].join("\n"));
    await chmod(trustedNode, 0o755);
    const npmCli = path.join(npmBin, "npm-cli.js");
    await writeFile(npmCli, [
      "#!/usr/bin/env node",
      "if (process.env.RUDDER_TRUSTED_NODE_PREFIX !== '1') process.exit(86);",
      `await import(${JSON.stringify(pathToFileURL(fixturePath).href)});`,
      "",
    ].join("\n"));
    await chmod(npmCli, 0o755);

    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition({
      title: "npm shebang fixture",
      executable: npmCli,
      argv: [],
      cwd: root,
      inheritedEnvNames: [],
      readiness: { path: "/health", timeoutMs: 4_000 },
      openPath: "/app",
    });
    const definition = await registry.createDefinition({ ...prepared, approvedFingerprint: prepared.trustFingerprint });
    await registry.approveDefinition(definition.id, prepared.trustFingerprint);
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      hostExecutablePath: path.join(root, "Rudder.app", "Contents", "MacOS", "Rudder"),
    });
    try {
      const running = await manager.start(definition.id);
      expect((await fetch(`${running.origin}/health`)).status).toBe(200);
    } finally {
      await manager.stop(definition.id).catch(() => undefined);
    }
  });

  it("keeps an inherited attacker PATH from replacing the trusted executable path", async () => {
    const attackerRoot = await mkdtemp(path.join(tmpdir(), "rudder-local-app-path-attacker-"));
    const attackerExecutable = path.join(attackerRoot, "node");
    const attackerMarker = path.join(attackerRoot, "executed");
    await writeFile(attackerExecutable, [
      "#!/bin/sh",
      `printf attacked > '${attackerMarker}'`,
      "printf attacker-node",
      "",
    ].join("\n"));
    await chmod(attackerExecutable, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = attackerRoot;
    const { registry, definition } = await approvedFixture({ inheritedEnvNames: ["PATH"] });
    const manager = new LocalAppRuntimeManager({ registry, platform: "darwin" });
    try {
      const running = await manager.start(definition.id);
      const probe = await fetch(`${running.origin}/path-probe`).then((response) => response.text());
      const childEnvironment = await fetch(`${running.origin}/env`).then((response) => response.json()) as {
        path?: string;
      };
      const childPath = childEnvironment.path?.split(path.delimiter) ?? [];

      expect(probe).toBe(await realpath(process.execPath));
      expect(childPath[0]).toBe(path.dirname(definition.executable));
      expect(childPath).toContain(path.dirname(process.execPath));
      expect(childPath).toEqual(expect.arrayContaining(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]));
      expect(childPath).not.toContain(attackerRoot);
      await expect(access(attackerMarker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await manager.stop(definition.id).catch(() => undefined);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

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

  it("serializes a real start followed immediately by stop for one binding", async () => {
    const { registry, definition } = await approvedFixture();
    const manager = new LocalAppRuntimeManager({ registry, platform: "darwin" });
    try {
      const starting = manager.start(definition.id);
      const stopping = manager.stop(definition.id);
      const [started, stopped] = await Promise.all([starting, stopping]);

      expect(started.status).toBe("running");
      expect(stopped.status).toBe("stopped");
      expect((await manager.status(definition.id)).status).toBe("stopped");
      expect(await registry.getRuntimeDescriptor(definition.id)).toBeNull();
    } finally {
      await manager.shutdown();
    }
  });

  it("waits for an in-flight start and then stops it during shutdown", async () => {
    const { registry, definition } = await approvedFixture();
    const manager = new LocalAppRuntimeManager({ registry, platform: "darwin" });
    const starting = manager.start(definition.id);
    const shuttingDown = manager.shutdown();

    await expect(starting).resolves.toMatchObject({ status: "running" });
    await expect(shuttingDown).resolves.toBeUndefined();
    expect((await manager.status(definition.id)).status).toBe("stopped");
    expect(await registry.getRuntimeDescriptor(definition.id)).toBeNull();
  });

  it("serializes a real stop followed immediately by a new start generation", async () => {
    const { registry, definition } = await approvedFixture();
    const manager = new LocalAppRuntimeManager({ registry, platform: "darwin" });
    try {
      const first = await manager.start(definition.id);
      const stopping = manager.stop(definition.id);
      const restarting = manager.start(definition.id);
      const [stopped, restarted] = await Promise.all([stopping, restarting]);

      expect(stopped.status).toBe("stopped");
      expect(restarted.status).toBe("running");
      expect(restarted.generation).not.toBe(first.generation);
      expect((await manager.status(definition.id)).generation).toBe(restarted.generation);
      expect(await registry.getRuntimeDescriptor(definition.id)).toMatchObject({
        status: "running",
        generation: restarted.generation,
      });
    } finally {
      await manager.shutdown();
    }
  });

  it("does not start a new generation until an in-flight stop has finished clearing the old one", async () => {
    const { registry, definition } = await approvedFixture();
    const terminationEntered = deferred<void>();
    const releaseTermination = deferred<void>();
    const killGroup = vi.fn((pgid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        terminationEntered.resolve();
        void releaseTermination.promise.then(() => {
          try {
            process.kill(-pgid, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        });
        return;
      }
      process.kill(-pgid, signal);
    });
    const manager = new LocalAppRuntimeManager({ registry, platform: "darwin", killGroup });
    try {
      const first = await manager.start(definition.id);
      const stopping = manager.stop(definition.id);
      await terminationEntered.promise;
      const restarting = manager.start(definition.id);
      let restartSettled = false;
      void restarting.then(
        () => { restartSettled = true; },
        () => { restartSettled = true; },
      );

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(restartSettled).toBe(false);
      releaseTermination.resolve();

      const [stopped, restarted] = await Promise.all([stopping, restarting]);
      expect(stopped.status).toBe("stopped");
      expect(restarted.status).toBe("running");
      expect(restarted.generation).not.toBe(first.generation);
      await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
        status: "running",
        generation: restarted.generation,
      });
    } finally {
      releaseTermination.resolve();
      await manager.shutdown();
    }
  }, 10_000);

  it("closes runtime admission while shutdown drains a blocked stop and leaves no later generation", async () => {
    const { registry, definition } = await approvedFixture();
    const terminationEntered = deferred<void>();
    const releaseTermination = deferred<void>();
    const killGroup = vi.fn((pgid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        terminationEntered.resolve();
        void releaseTermination.promise.then(() => {
          try {
            process.kill(-pgid, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        });
        return;
      }
      process.kill(-pgid, signal);
    });
    const manager = new LocalAppRuntimeManager({ registry, platform: "darwin", killGroup });
    const first = await manager.start(definition.id);
    const ownedPid = (await registry.getRuntimeDescriptor(definition.id))?.pid;
    try {
      const stopping = manager.stop(definition.id);
      await terminationEntered.promise;
      const shuttingDown = manager.shutdown();
      const restarting = manager.start(definition.id);
      const restartRejected = expect(restarting).rejects.toThrow("shutting down");
      releaseTermination.resolve();

      await expect(stopping).resolves.toMatchObject({ status: "stopped" });
      await restartRejected;
      await expect(shuttingDown).resolves.toBeUndefined();
      expect((await manager.status(definition.id)).status).toBe("stopped");
      expect(await registry.getRuntimeDescriptor(definition.id)).toBeNull();
      expect(first.status).toBe("running");
      expect(ownedPid).toBeTypeOf("number");
      await vi.waitFor(() => expect(() => process.kill(ownedPid!, 0)).toThrow());
    } finally {
      releaseTermination.resolve();
      await manager.stop(definition.id).catch(() => undefined);
      await manager.shutdown();
    }
  }, 10_000);

  it("atomically reconciles nonexistent persisted PID, PGID, and listener once, then permits a new start", async () => {
    const { registry, definition } = await approvedFixture();
    await registry.recordRuntimeDescriptor(definition.id, {
      status: "running", pid: 991_001, pgid: 991_001, generation: "dead-generation", port: 31_991,
    });
    const probeEntered = deferred<void>();
    const releaseProbe = deferred<void>();
    const probePersistedRuntimeLiveness = vi.fn(async () => {
      probeEntered.resolve();
      await releaseProbe.promise;
      return { pid: "dead" as const, processGroup: "dead" as const, listener: "dead" as const };
    });
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      probePersistedRuntimeLiveness,
    });
    try {
      const firstStatus = manager.status(definition.id);
      await probeEntered.promise;
      const secondStatus = manager.status(definition.id);
      releaseProbe.resolve();

      await expect(Promise.all([firstStatus, secondStatus])).resolves.toEqual([
        expect.objectContaining({ status: "stopped" }),
        expect.objectContaining({ status: "stopped" }),
      ]);
      expect(probePersistedRuntimeLiveness).toHaveBeenCalledOnce();
      expect(probePersistedRuntimeLiveness).toHaveBeenCalledWith({
        pid: 991_001,
        pgid: 991_001,
        port: 31_991,
      });
      expect(await registry.getRuntimeDescriptor(definition.id)).toBeNull();

      const restarted = await manager.start(definition.id);
      expect(restarted.status).toBe("running");
      expect(restarted.generation).not.toBe("dead-generation");
    } finally {
      await manager.shutdown();
    }
  });

  it.each([
    {
      label: "a live process group",
      liveness: { pid: "alive" as const, processGroup: "alive" as const, listener: "alive" as const },
    },
    {
      label: "an EPERM or otherwise ambiguous probe",
      liveness: { pid: "unknown" as const, processGroup: "unknown" as const, listener: "unknown" as const },
    },
  ])("keeps persisted ownership orphaned and never signals for $label", async ({ liveness }) => {
    const { registry, definition } = await approvedFixture();
    await registry.recordRuntimeDescriptor(definition.id, {
      status: "running", pid: 991_002, pgid: 991_002, generation: "unverified-generation", port: 31_992,
    });
    const killGroup = vi.fn();
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      killGroup,
      probePersistedRuntimeLiveness: vi.fn(async () => liveness),
    });

    expect((await manager.status(definition.id)).status).toBe("orphaned_unverified");
    await expect(manager.start(definition.id)).rejects.toThrow("unverified");
    await expect(manager.stop(definition.id)).rejects.toThrow("unverified");
    expect(killGroup).not.toHaveBeenCalled();
    await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
      generation: "unverified-generation",
    });
  });

  it("fails closed on readiness failure or unproven listener ownership", async () => {
    const wrongHealth = await approvedFixture({ readinessPath: "/never", readinessTimeoutMs: 1_000 });
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

  it.each([1, Number.MAX_SAFE_INTEGER + 1])(
    "never signals an unsafe process group identity %s",
    async (pgid) => {
      const killGroup = vi.fn();
      const isGroupAlive = vi.fn(() => false);
      await expect(terminateOwnedProcessGroup(pgid, {
        killGroup,
        isGroupAlive,
        delay: async () => undefined,
      })).rejects.toThrow("unverified");
      expect(killGroup).not.toHaveBeenCalled();
      expect(isGroupAlive).not.toHaveBeenCalled();
    },
  );

  it.each([
    { pid: 2, pgid: 1 },
    { pid: 1, pgid: 1 },
    { pid: Number.MAX_SAFE_INTEGER + 1, pgid: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects an unsafe watchdog IPC ownership result without signaling $pid/$pgid", async (message) => {
    const { registry, definition } = await approvedFixture({ readinessTimeoutMs: 250 });
    const helper = watchdogEmitting({ type: "spawned", ...message });
    const killGroup = vi.fn();
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      killGroup,
      spawnWatchdog: (() => helper) as unknown as typeof spawn,
    });

    await expect(manager.start(definition.id)).rejects.toThrow("watchdog process identity");
    expect(killGroup).not.toHaveBeenCalled();
    expect(await registry.getRuntimeDescriptor(definition.id)).toBeNull();
  });

  it("treats control-pipe EOF as idempotent cleanup and never guesses about a legacy orphan without a port", async () => {
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
    await registry.recordRuntimeDescriptor(definition.id, { status: "stopping", pid: 999_999, pgid: 999_999, generation: "old" });
    const reloaded = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    const killGroup = vi.fn();
    const manager = new LocalAppRuntimeManager({ registry: reloaded, platform: "darwin", killGroup });
    expect((await manager.status(definition.id)).status).toBe("orphaned_unverified");
    await expect(manager.stop(definition.id)).rejects.toThrow("unverified");
    expect(killGroup).not.toHaveBeenCalled();
    await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
      status: "stopping",
      generation: "old",
    });
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
