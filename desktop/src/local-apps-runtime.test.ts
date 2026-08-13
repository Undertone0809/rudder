import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { spawnNativeProcessHost, type NativeProcessHost } from "./local-app-native-host.js";
import { createLocalAppProcessPlatform } from "./local-app-process-platform.js";
import { LocalAppRegistry } from "./local-apps-registry.js";
import {
  LocalAppRuntimeManager,
  buildChildEnvironment,
  installControlPipeEofCleanup,
  localAppPartitionId,
  parseLsofListenerProcessRecords,
  terminateOwnedProcessGroup,
} from "./local-apps-runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/local-app-http-fixture.mjs", import.meta.url));
const floodFixturePath = fileURLToPath(new URL("./fixtures/local-app-http-flood-fixture.mjs", import.meta.url));
const wildcardFixturePath = fileURLToPath(new URL("./fixtures/local-app-http-wildcard-fixture.mjs", import.meta.url));
const watchdogPath = fileURLToPath(new URL("./local-app-watchdog-runner.mjs", import.meta.url));
const nativeHostPath = process.env.RUDDER_NATIVE_PROCESS_HOST_PATH;
const nativeCapabilities = [
  "process_spawn",
  "process_group_cleanup",
  "parent_eof_cleanup",
  "listener_owner_attestation",
  "owner_receipt",
  "output_order_index",
  "stdout_relay",
  "stderr_relay",
];

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
  serverFixturePath?: string;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-runtime-"));
  const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
  const prepared = await registry.prepareDefinition({
    title: "HTTP fixture",
    executable: process.execPath,
    argv: [options.serverFixturePath ?? fixturePath],
    cwd: root,
    inheritedEnvNames: options.inheritedEnvNames ?? [],
    readiness: { path: options.readinessPath ?? "/health", timeoutMs: options.readinessTimeoutMs ?? 4_000 },
    openPath: "/app",
  });
  const definition = await registry.createDefinition({ ...prepared, approvedFingerprint: prepared.trustFingerprint });
  await registry.approveDefinition(definition.id, prepared.trustFingerprint);
  return { root, registry, definition };
}

async function assertWildcardPortCanBeRebound(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
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

function killFixtureProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function acceptFixtureListenerOwnership(): Promise<boolean> {
  return true;
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

function watchdogEmittingAfter(message: unknown, milliseconds: number) {
  const helper = watchdogEmitting(message);
  helper.send = vi.fn((_payload: unknown, callback?: (error: Error | null) => void) => {
    setTimeout(() => helper.emit("message", message), milliseconds);
    callback?.(null);
  });
  return helper;
}

function nativeHostEmitting(onStart?: (message: Record<string, unknown>, helper: NativeProcessHost) => void) {
  const helper = new EventEmitter() as NativeProcessHost;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  Object.defineProperties(helper, {
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: stderr },
    pid: { get: () => 88_881 },
    connected: { get: () => !stdin.destroyed },
    exitCode: { get: () => exitCode },
    signalCode: { get: () => signalCode },
  });
  helper.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
    if (message && typeof message === "object" && (message as { type?: unknown }).type === "start") {
      onStart?.(message as Record<string, unknown>, helper);
    }
    callback?.(null);
    return true;
  });
  helper.kill = vi.fn(() => true);
  const emitExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    exitCode = code;
    signalCode = signal;
    helper.emit("exit", code, signal);
  };
  return { helper, emitExit };
}

describe("Desktop Local App runtime", () => {
  it("injects Electron Node mode for the managed host executable even when the parent env omits it", async () => {
    const { registry, definition } = await approvedFixture({
      inheritedEnvNames: ["ELECTRON_RUN_AS_NODE"],
    });
    const previous = process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ELECTRON_RUN_AS_NODE;
    try {
      const environment = await buildChildEnvironment(
        definition,
        43_123,
        definition.executable,
        createLocalAppProcessPlatform({ platform: process.platform }),
      );
      expect(environment.ELECTRON_RUN_AS_NODE).toBe("1");
    } finally {
      if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = previous;
      await registry.recordRuntimeDescriptor(definition.id, null);
    }
  });
  it("parses every process and listener address from structured lsof output", () => {
    expect(parseLsofListenerProcessRecords([
      "p42",
      "f14",
      "n127.0.0.1:43123",
      "f15",
      "n127.0.0.1:43123",
      "p43",
      "f16",
      "n127.0.0.1:43123",
      "",
    ].join("\n"), 43_123)).toEqual([
      { pid: 42, addresses: ["127.0.0.1:43123", "127.0.0.1:43123"] },
      { pid: 43, addresses: ["127.0.0.1:43123"] },
    ]);
  });

  it.each([
    ["wildcard", "*:43123"],
    ["IPv4 wildcard", "0.0.0.0:43123"],
    ["IPv6 wildcard", "[::]:43123"],
    ["unbracketed IPv6 wildcard", ":::43123"],
    ["IPv6 loopback", "[::1]:43123"],
    ["hostname alias", "localhost:43123"],
    ["other interface", "192.168.1.20:43123"],
    ["wrong port", "127.0.0.1:43124"],
  ])("rejects a %s listener address from structured lsof output", (_label, address) => {
    expect(parseLsofListenerProcessRecords(`p42\nf14\nn${address}\n`, 43_123)).toBeNull();
  });

  it.each([
    ["address without a process", "n127.0.0.1:43123\n"],
    ["process without an address", "p42\nf14\n"],
    ["empty address", "p42\nf14\nn\n"],
    ["unexpected field", "p42\nf14\ncnode\nn127.0.0.1:43123\n"],
    ["duplicate process record", "p42\nf14\nn127.0.0.1:43123\np42\nf15\nn127.0.0.1:43123\n"],
    ["mixed exact and wildcard listeners", "p42\nf14\nn127.0.0.1:43123\np43\nf15\nn*:43123\n"],
  ])("rejects ambiguous lsof structure: %s", (_label, output) => {
    expect(parseLsofListenerProcessRecords(output, 43_123)).toBeNull();
  });

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
      verifyListenerOwnership: acceptFixtureListenerOwnership,
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
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      verifyListenerOwnership: acceptFixtureListenerOwnership,
    });
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

  it.runIf(process.platform === "darwin")(
    "spawns shell-free on an automatic loopback port, deduplicates start, bounds logs, and attests origin/partition",
    async () => {
      const { registry, definition } = await approvedFixture();
      const events: Array<{ type: string; monotonicNs: bigint }> = [];
      const manager = new LocalAppRuntimeManager({
        registry,
        platform: "darwin",
        maxLogBytes: 256,
        observeLifecycleEvent: (event) => events.push(event),
      });
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
      const stopStartedNs = process.hrtime.bigint();
      await manager.stop(definition.id);
      expect(events.some((event) => event.type === "stop-accepted"
        && event.monotonicNs >= stopStartedNs)).toBe(true);
      expect((await manager.status(definition.id)).status).toBe("stopped");
    },
  );

  it.runIf(process.platform === "darwin")(
    "rejects and fully cleans an approved fixture that exposes its allocated port on every interface",
    { timeout: 30_000 },
    async () => {
      const { root, registry, definition } = await approvedFixture({ serverFixturePath: wildcardFixturePath });
      const manager = new LocalAppRuntimeManager({ registry, platform: "darwin" });
      const markerPath = path.join(root, "wildcard-listener.json");
      try {
        await expect(manager.start(definition.id)).rejects.toThrow(
          /listener ownership could not be proven|exited before readiness succeeded/,
        );
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as { pid: number; port: number };
        await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
          status: "failed",
          pid: null,
          pgid: null,
        });
        expect((await manager.status(definition.id)).status).toBe("failed");
        expect(() => process.kill(marker.pid, 0)).toThrow();
        await expect(assertWildcardPortCanBeRebound(marker.port)).resolves.toBeUndefined();
      } finally {
        await manager.shutdown().catch(() => undefined);
      }
    },
  );

  it("serializes a real start followed immediately by stop for one binding", async () => {
    const { root, registry, definition } = await approvedFixture();
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      verifyListenerOwnership: acceptFixtureListenerOwnership,
    });
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
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      verifyListenerOwnership: acceptFixtureListenerOwnership,
    });
    const starting = manager.start(definition.id);
    const shuttingDown = manager.shutdown();

    await expect(starting).resolves.toMatchObject({ status: "running" });
    await expect(shuttingDown).resolves.toBeUndefined();
    expect((await manager.status(definition.id)).status).toBe("stopped");
    expect(await registry.getRuntimeDescriptor(definition.id)).toBeNull();
  });

  it("serializes a real stop followed immediately by a new start generation", async () => {
    const { registry, definition } = await approvedFixture();
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      verifyListenerOwnership: acceptFixtureListenerOwnership,
    });
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
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      killGroup,
      verifyListenerOwnership: acceptFixtureListenerOwnership,
    });
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

  it("keeps complete ownership orphaned when stop cannot prove the group died", async () => {
    const { registry, definition } = await approvedFixture();
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      killGroup: vi.fn(),
      verifyListenerOwnership: acceptFixtureListenerOwnership,
      terminationOptions: {
        isGroupAlive: () => true,
        delay: async () => undefined,
        termTimeoutMs: 1,
        pollMs: 1,
      },
    });
    const running = await manager.start(definition.id);
    const ownership = await registry.getRuntimeDescriptor(definition.id);
    try {
      await expect(manager.stop(definition.id)).rejects.toThrow("could not be proven dead");
      await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
        status: "orphaned_unverified",
        pid: ownership?.pid,
        pgid: ownership?.pgid,
        port: ownership?.port,
        generation: running.generation,
      });
      expect((await manager.status(definition.id)).status).toBe("orphaned_unverified");
      await expect(manager.start(definition.id)).rejects.toThrow("unverified");
    } finally {
      killFixtureProcess(ownership?.pid);
    }
  });

  it("aggregates shutdown cleanup failures with the binding id and preserves orphan ownership", async () => {
    const { registry, definition } = await approvedFixture();
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      killGroup: vi.fn(),
      verifyListenerOwnership: acceptFixtureListenerOwnership,
      terminationOptions: {
        isGroupAlive: () => true,
        delay: async () => undefined,
        termTimeoutMs: 1,
        pollMs: 1,
      },
    });
    await manager.start(definition.id);
    const ownership = await registry.getRuntimeDescriptor(definition.id);
    try {
      await expect(manager.shutdown()).rejects.toSatisfy((error: unknown) =>
        error instanceof AggregateError
        && error.message.includes(definition.id)
        && error.errors.length === 1);
      await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
        status: "orphaned_unverified",
        pid: ownership?.pid,
        pgid: ownership?.pgid,
        port: ownership?.port,
      });
    } finally {
      killFixtureProcess(ownership?.pid);
    }
  });

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
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      killGroup,
      verifyListenerOwnership: acceptFixtureListenerOwnership,
    });
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
      verifyListenerOwnership: acceptFixtureListenerOwnership,
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
      listenerOwnershipRetryTimeoutMs: 750,
    });
    await expect(ownershipManager.start(unowned.definition.id)).rejects.toThrow("ownership");
    expect((await ownershipManager.status(unowned.definition.id)).status).toBe("failed");
  });

  it("waits for a fresh process snapshot to prove listener ownership after readiness", async () => {
    const owned = await approvedFixture({ readinessTimeoutMs: 1_000 });
    const verifyListenerOwnership = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const manager = new LocalAppRuntimeManager({
      registry: owned.registry,
      platform: "darwin",
      verifyListenerOwnership,
    });
    try {
      await expect(manager.start(owned.definition.id)).resolves.toMatchObject({ status: "running" });
      expect(verifyListenerOwnership).toHaveBeenCalledTimes(2);
    } finally {
      await manager.stop(owned.definition.id).catch(() => undefined);
    }
  });

  it("allows a bounded slow Windows process snapshot to prove listener ownership", async () => {
    const owned = await approvedFixture({ readinessTimeoutMs: 30_000 });
    const verifyListenerOwnership = vi.fn(async (input: { timeoutMs: number }) => {
      expect(input.timeoutMs).toBeGreaterThan(20_000);
      await new Promise((resolve) => setTimeout(resolve, 900));
      return true;
    });
    const manager = new LocalAppRuntimeManager({
      registry: owned.registry,
      platform: "win32",
      verifyListenerOwnership,
    });
    try {
      await expect(manager.start(owned.definition.id)).resolves.toMatchObject({ status: "running" });
      expect(verifyListenerOwnership).toHaveBeenCalledTimes(1);
    } finally {
      await manager.stop(owned.definition.id).catch(() => undefined);
    }
  });

  it("rejects ownership proven after the watchdog exits during the snapshot", async () => {
    const owned = await approvedFixture({ readinessTimeoutMs: 2_000 });
    const ownership = deferred<boolean>();
    const helper = watchdogEmitting({ type: "ignored" });
    let healthServer: ReturnType<typeof createServer> | null = null;
    const healthSockets = new Set<import("node:net").Socket>();
    helper.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
      const typed = message as { type?: string; env?: NodeJS.ProcessEnv };
      if (typed.type === "start") {
        const port = Number.parseInt(typed.env?.PORT ?? "", 10);
        healthServer = createServer((socket) => {
          healthSockets.add(socket);
          socket.once("close", () => healthSockets.delete(socket));
          socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}");
        });
        healthServer.listen(port, "127.0.0.1", () => {
          helper.emit("message", { type: "spawned", pid: 88_881, pgid: 88_881 });
        });
      }
      callback?.(null);
      return true;
    });
    const processPlatform = {
      platform: "win32" as const,
      systemPathEntries: [],
      terminate: vi.fn(async () => undefined),
      probePersistedRuntime: vi.fn(async () => ({
        pid: "dead" as const,
        processGroup: "dead" as const,
        listener: "dead" as const,
      })),
      verifyListenerOwnership: vi.fn(() => ownership.promise),
    };
    const manager = new LocalAppRuntimeManager({
      registry: owned.registry,
      processPlatform,
      spawnWatchdog: (() => helper) as unknown as typeof spawn,
    });
    try {
      const start = manager.start(owned.definition.id);
      await vi.waitFor(() => expect(processPlatform.verifyListenerOwnership).toHaveBeenCalledOnce());
      helper.emit("exit", 1, null);
      ownership.resolve(true);
      await expect(start).rejects.toThrow("exited before listener ownership could be proven");
      expect(processPlatform.terminate).toHaveBeenCalledWith(88_881);
    } finally {
      if (healthServer?.listening) {
        for (const socket of healthSockets) socket.destroy();
        await new Promise<void>((resolve, reject) => {
          healthServer!.close((error) => error ? reject(error) : resolve());
        });
      }
    }
  });

  it("bounds a listener ownership probe that never returns", async () => {
    const owned = await approvedFixture({ readinessTimeoutMs: 2_000 });
    const manager = new LocalAppRuntimeManager({
      registry: owned.registry,
      platform: "darwin",
      verifyListenerOwnership: () => new Promise(() => undefined),
      listenerOwnershipRetryTimeoutMs: 250,
    });
    const startedAt = Date.now();
    await expect(manager.start(owned.definition.id)).rejects.toThrow(
      "listener ownership could not be proven",
    );
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("accepts an explicit watchdog stop acknowledgement before using Windows fallback cleanup", async () => {
    const { registry, definition } = await approvedFixture({ readinessTimeoutMs: 250 });
    const helper = watchdogEmitting({ type: "spawned", pid: 88_881, pgid: 88_881 });
    (helper as unknown as { connected: boolean }).connected = true;
    const messages: unknown[] = [];
    helper.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
      messages.push(message);
      const typed = message as { type?: string };
      if (typed.type === "start") {
        queueMicrotask(() => helper.emit("message", { type: "spawned", pid: 88_881, pgid: 88_881 }));
      }
      if (typed.type === "cleanup") {
        queueMicrotask(() => {
          helper.emit("message", { type: "stopped" });
          helper.emit("exit", 0, null);
        });
      }
      callback?.(null);
      return true;
    });
    const processPlatform = {
      platform: "win32" as const,
      systemPathEntries: [],
      terminate: vi.fn(async () => undefined),
      probePersistedRuntime: vi.fn(async () => ({ pid: "dead" as const, processGroup: "dead" as const, listener: "dead" as const })),
      verifyListenerOwnership: vi.fn(async () => false),
    };
    const manager = new LocalAppRuntimeManager({
      registry,
      processPlatform,
      spawnWatchdog: (() => helper) as unknown as typeof spawn,
    });

    await expect(manager.start(definition.id)).rejects.toThrow("readiness");
    expect(messages).toContainEqual({ type: "cleanup" });
    expect(helper.stdin.end).not.toHaveBeenCalled();
    expect(processPlatform.terminate).not.toHaveBeenCalled();
    await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
      status: "failed",
      pid: null,
      pgid: null,
    });
  });

  it("accepts a disconnecting Windows watchdog's clean exit without parent fallback", async () => {
    const { registry, definition } = await approvedFixture({ readinessTimeoutMs: 250 });
    const helper = watchdogEmitting({ type: "spawned", pid: 88_881, pgid: 88_881 });
    (helper as unknown as { connected: boolean }).connected = true;
    helper.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
      const typed = message as { type?: string };
      if (typed.type === "start") {
        queueMicrotask(() => helper.emit("message", { type: "spawned", pid: 88_881, pgid: 88_881 }));
        setTimeout(() => {
          (helper as unknown as { connected: boolean }).connected = false;
          helper.emit("disconnect");
        }, 200);
        setTimeout(() => {
          helper.emit("exit", 0, null);
        }, 275);
      }
      callback?.(null);
      return true;
    });
    const processPlatform = {
      platform: "win32" as const,
      systemPathEntries: [],
      terminate: vi.fn(async () => undefined),
      probePersistedRuntime: vi.fn(async () => ({ pid: "dead" as const, processGroup: "dead" as const, listener: "dead" as const })),
      verifyListenerOwnership: vi.fn(async () => false),
    };
    const manager = new LocalAppRuntimeManager({
      registry,
      processPlatform,
      spawnWatchdog: (() => helper) as unknown as typeof spawn,
      cleanupTimeoutMs: 200,
    });

    await expect(manager.start(definition.id)).rejects.toThrow("readiness");
    expect(helper.stdin.end).not.toHaveBeenCalled();
    expect(processPlatform.terminate).not.toHaveBeenCalled();
    await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
      status: "failed",
      pid: null,
      pgid: null,
    });
  });

  it("waits for a Windows watchdog exit after it acknowledges cleanup before fallback", async () => {
    const { registry, definition } = await approvedFixture({ readinessTimeoutMs: 250 });
    const helper = watchdogEmitting({ type: "spawned", pid: 88_881, pgid: 88_881 });
    (helper as unknown as { connected: boolean }).connected = true;
    helper.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
      const typed = message as { type?: string };
      if (typed.type === "start") {
        queueMicrotask(() => helper.emit("message", { type: "spawned", pid: 88_881, pgid: 88_881 }));
      }
      if (typed.type === "cleanup") {
        queueMicrotask(() => helper.emit("message", { type: "stopped" }));
        setTimeout(() => helper.emit("exit", 0, null), 25);
      }
      callback?.(null);
      return true;
    });
    const processPlatform = {
      platform: "win32" as const,
      systemPathEntries: [],
      terminate: vi.fn(async () => undefined),
      probePersistedRuntime: vi.fn(async () => ({ pid: "dead" as const, processGroup: "dead" as const, listener: "dead" as const })),
      verifyListenerOwnership: vi.fn(async () => false),
    };
    const manager = new LocalAppRuntimeManager({
      registry,
      processPlatform,
      spawnWatchdog: (() => helper) as unknown as typeof spawn,
      cleanupTimeoutMs: 200,
    });

    await expect(manager.start(definition.id)).rejects.toThrow("readiness");
    expect(helper.stdin.end).not.toHaveBeenCalled();
    expect(processPlatform.terminate).not.toHaveBeenCalled();
    await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
      status: "failed",
      pid: null,
      pgid: null,
    });
  });

  it("uses parent termination only after an exited Windows watchdog fails to prove cleanup", async () => {
    const { registry, definition } = await approvedFixture({ readinessTimeoutMs: 250 });
    const helper = watchdogEmitting({ type: "spawned", pid: 88_881, pgid: 88_881 });
    (helper as unknown as { connected: boolean }).connected = true;
    helper.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
      const typed = message as { type?: string };
      if (typed.type === "start") {
        queueMicrotask(() => helper.emit("message", { type: "spawned", pid: 88_881, pgid: 88_881 }));
        setTimeout(() => helper.emit("exit", 1, null), 275);
      }
      callback?.(null);
      return true;
    });
    const processPlatform = {
      platform: "win32" as const,
      systemPathEntries: [],
      terminate: vi.fn(async () => undefined),
      probePersistedRuntime: vi.fn(async () => ({ pid: "dead" as const, processGroup: "dead" as const, listener: "dead" as const })),
      verifyListenerOwnership: vi.fn(async () => false),
    };
    const manager = new LocalAppRuntimeManager({
      registry,
      processPlatform,
      spawnWatchdog: (() => helper) as unknown as typeof spawn,
      cleanupTimeoutMs: 200,
    });

    await expect(manager.start(definition.id)).rejects.toThrow("cleanup could not be verified");
    expect(helper.stdin.end).not.toHaveBeenCalled();
    expect(processPlatform.terminate).toHaveBeenCalledWith(88_881);
    await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
      status: "orphaned_unverified",
      pid: 88_881,
      pgid: 88_881,
    });
  });

  it("never races a still-running Windows watchdog after cleanup proof times out", async () => {
    const { registry, definition } = await approvedFixture({ readinessTimeoutMs: 250 });
    const helper = watchdogEmitting({ type: "spawned", pid: 88_881, pgid: 88_881 });
    (helper as unknown as { connected: boolean }).connected = true;
    helper.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
      const typed = message as { type?: string };
      if (typed.type === "start") {
        queueMicrotask(() => helper.emit("message", { type: "spawned", pid: 88_881, pgid: 88_881 }));
      }
      callback?.(null);
      return true;
    });
    const processPlatform = {
      platform: "win32" as const,
      systemPathEntries: [],
      terminate: vi.fn(async () => undefined),
      probePersistedRuntime: vi.fn(async () => ({ pid: "dead" as const, processGroup: "dead" as const, listener: "dead" as const })),
      verifyListenerOwnership: vi.fn(async () => false),
    };
    const manager = new LocalAppRuntimeManager({
      registry,
      processPlatform,
      spawnWatchdog: (() => helper) as unknown as typeof spawn,
      cleanupTimeoutMs: 20,
    });

    await expect(manager.start(definition.id)).rejects.toThrow("cleanup could not be verified");
    expect(helper.stdin.end).not.toHaveBeenCalled();
    expect(processPlatform.terminate).not.toHaveBeenCalled();
    await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
      status: "orphaned_unverified",
      pid: 88_881,
      pgid: 88_881,
    });
  });

  it("preserves full ownership and blocks restart when failed-start cleanup hits EPERM", async () => {
    const { registry, definition } = await approvedFixture();
    const permissionError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const helper = watchdogEmitting({ type: "spawned", pid: 88_881, pgid: 88_881 });
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      verifyListenerOwnership: async () => false,
      killGroup: () => { throw permissionError; },
      spawnWatchdog: (() => helper) as unknown as typeof spawn,
      cleanupTimeoutMs: 20,
    });

    await expect(manager.start(definition.id)).rejects.toThrow("cleanup could not be verified");
    const descriptor = await registry.getRuntimeDescriptor(definition.id);
    expect(descriptor).toMatchObject({
      status: "orphaned_unverified",
      pid: expect.any(Number),
      pgid: expect.any(Number),
      port: expect.any(Number),
    });
    expect((await manager.status(definition.id)).status).toBe("orphaned_unverified");
    await expect(manager.start(definition.id)).rejects.toThrow("unverified");
  });

  it("captures a late watchdog spawn after startup timeout and never overlaps a new generation", async () => {
    const { registry, definition } = await approvedFixture({ readinessTimeoutMs: 250 });
    const helper = watchdogEmittingAfter({ type: "spawned", pid: 88_881, pgid: 88_881 }, 30);
    const spawnWatchdog = vi.fn(() => helper) as unknown as typeof spawn;
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      spawnWatchdog,
      watchdogStartTimeoutMs: 10,
      cleanupTimeoutMs: 60,
      killGroup: vi.fn(),
      terminationOptions: {
        isGroupAlive: () => true,
        delay: async () => undefined,
        termTimeoutMs: 1,
        pollMs: 1,
      },
    });

    await expect(manager.start(definition.id)).rejects.toThrow("cleanup could not be verified");
    await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
      status: "orphaned_unverified",
      pid: 88_881,
      pgid: 88_881,
      port: expect.any(Number),
    });
    await expect(manager.start(definition.id)).rejects.toThrow("unverified");
    expect(spawnWatchdog).toHaveBeenCalledTimes(1);
  });

  it("keeps watchdog startup and cleanup deadlines referenced while start is pending", async () => {
    const { registry, definition } = await approvedFixture({ readinessTimeoutMs: 250 });
    const helper = watchdogEmitting({ type: "ignored" });
    helper.send = vi.fn((_payload: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null);
    });
    const spawnWatchdog = vi.fn(() => helper) as unknown as typeof spawn;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      spawnWatchdog,
      watchdogStartTimeoutMs: 60_001,
      cleanupTimeoutMs: 60_002,
    });

    try {
      const pendingStart = manager.start(definition.id);
      await vi.waitFor(() => expect(spawnWatchdog).toHaveBeenCalledOnce());
      const startupCallIndex = timeoutSpy.mock.calls.findIndex(([, delay]) => delay === 60_001);
      expect(startupCallIndex).toBeGreaterThanOrEqual(0);
      const startupTimer = timeoutSpy.mock.results[startupCallIndex]?.value as NodeJS.Timeout;
      expect(startupTimer.hasRef()).toBe(true);

      helper.emit("error", new Error("watchdog fixture failed"));
      await vi.waitFor(() => {
        expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 60_002)).toBe(true);
      });
      const cleanupCallIndex = timeoutSpy.mock.calls.findIndex(([, delay]) => delay === 60_002);
      const cleanupTimer = timeoutSpy.mock.results[cleanupCallIndex]?.value as NodeJS.Timeout;
      expect(cleanupTimer.hasRef()).toBe(true);

      helper.emit("message", { type: "stopped" });
      helper.emit("exit", 1, null);
      await expect(pendingStart).rejects.toThrow("watchdog fixture failed");
    } finally {
      timeoutSpy.mockRestore();
      await manager.shutdown();
    }
  }, 30_000);

  it("keeps ownership orphaned when a running watchdog exits without acknowledging cleanup", async () => {
    const { registry, definition } = await approvedFixture();
    let watchdog: ChildProcess | null = null;
    const spawnWatchdog = ((command: string, args: readonly string[], options: SpawnOptions) => {
      watchdog = spawn(command, [...args], options);
      return watchdog;
    }) as unknown as typeof spawn;
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: "darwin",
      spawnWatchdog,
      cleanupTimeoutMs: 100,
      verifyListenerOwnership: acceptFixtureListenerOwnership,
    });
    await manager.start(definition.id);
    const ownership = await registry.getRuntimeDescriptor(definition.id);
    try {
      expect(watchdog).not.toBeNull();
      watchdog!.kill("SIGKILL");
      await vi.waitFor(async () => {
        await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
          status: "orphaned_unverified",
          pid: ownership?.pid,
          pgid: ownership?.pgid,
          port: ownership?.port,
        });
      }, { timeout: 3_000 });
      expect((await manager.status(definition.id)).status).toBe("orphaned_unverified");
      await expect(manager.start(definition.id)).rejects.toThrow("unverified");
    } finally {
      killFixtureProcess(ownership?.pid);
    }
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

  it("rejects when TERM and KILL cannot prove the process group is dead", async () => {
    const signals: NodeJS.Signals[] = [];
    await expect(terminateOwnedProcessGroup(42, {
      killGroup: (_pgid, signal) => { signals.push(signal); },
      isGroupAlive: () => true,
      delay: async () => undefined,
      termTimeoutMs: 1,
      pollMs: 1,
    })).rejects.toThrow("could not be proven dead");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
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
      cleanupTimeoutMs: 10,
    });

    await expect(manager.start(definition.id)).rejects.toThrow("cleanup could not be verified");
    expect(killGroup).not.toHaveBeenCalled();
    await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
      status: "quarantined",
      pid: null,
      pgid: null,
    });
    await expect(manager.start(definition.id)).rejects.toThrow("unverified");
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
    await registry.recordRuntimeDescriptor(definition.id, {
      status: "stopping", pid: 999_999, pgid: 999_999, generation: "old", port: 31_999,
    });
    const persisted = JSON.parse(await readFile(registryPath, "utf8")) as {
      runtimeDescriptors: Record<string, { port?: number }>;
    };
    delete persisted.runtimeDescriptors[definition.id].port;
    await writeFile(registryPath, JSON.stringify(persisted), { mode: 0o600 });
    const reloaded = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    const killGroup = vi.fn();
    const manager = new LocalAppRuntimeManager({ registry: reloaded, platform: "darwin", killGroup });
    expect((await manager.status(definition.id)).status).toBe("orphaned_unverified");
    await expect(manager.stop(definition.id)).rejects.toThrow("unverified");
    expect(killGroup).not.toHaveBeenCalled();
    await expect(reloaded.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
      status: "quarantined",
      generation: "old",
      pid: null,
      pgid: null,
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

  it.skipIf(!nativeHostPath)("runs an approved Local App through the opt-in Rust process host", async () => {
    const { root, registry, definition } = await approvedFixture();
    const nativeRuntimeRoot = path.join(root, "native-runtime");
    await mkdir(nativeRuntimeRoot);
    const manager = new LocalAppRuntimeManager({
      registry,
      platform: process.platform,
      nativeProcessHostPath: nativeHostPath,
      nativeRuntimeRoot,
      useNativeProcessHost: true,
      verifyListenerOwnership: async () => true,
    });

    const running = await manager.start(definition.id);
    expect(running.status).toBe("running");
    expect(running.generation).toBeTruthy();
    const operationRoot = path.join(nativeRuntimeRoot, running.generation!);
    await expect(readFile(path.join(operationRoot, "owner-descriptor.json"), "utf8"))
      .resolves.toContain(`"opaqueOwnerToken":"${running.generation}"`);
    await vi.waitFor(async () => {
      expect(await manager.logs(definition.id)).toEqual(expect.arrayContaining([
        expect.stringContaining("fixture listening"),
      ]));
    }, { timeout: 3_000 });

    await expect(manager.stop(definition.id)).resolves.toMatchObject({ status: "stopped" });
    await expect(manager.status(definition.id)).resolves.toMatchObject({ status: "stopped" });
    const terminal = JSON.parse(await readFile(path.join(operationRoot, "terminal-receipt.json"), "utf8")) as {
      terminal?: { status?: string; cleanupProven?: boolean };
    };
    expect(terminal.terminal).toMatchObject({ status: "succeeded", cleanupProven: true });
    const outputIndex = (await readFile(path.join(operationRoot, "output-index.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stream?: string; offset?: number; sha256?: string });
    expect(outputIndex).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "stdout", offset: 0, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    ]));
  });

  it.skipIf(!nativeHostPath || process.platform !== "darwin" || process.arch !== "arm64")(
    "keeps manager Stop responsive during a 10 MiB/s native Local App log flood",
    async () => {
      const { root, registry, definition } = await approvedFixture({ serverFixturePath: floodFixturePath });
      const nativeRuntimeRoot = path.join(root, "native-runtime");
      const events: Array<{ type: string; monotonicNs: bigint }> = [];
      const manager = new LocalAppRuntimeManager({
        registry,
        platform: process.platform,
        nativeProcessHostPath: nativeHostPath,
        nativeRuntimeRoot,
        useNativeProcessHost: true,
        maxLogBytes: 64 * 1024,
        observeLifecycleEvent: (event) => events.push(event),
      });

      const running = await manager.start(definition.id);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const stopStartNs = process.hrtime.bigint();
      await expect(manager.stop(definition.id)).resolves.toMatchObject({ status: "stopped" });
      const terminalNs = process.hrtime.bigint();
      const stopAccepted = events.find((event) => event.type === "stop-accepted"
        && event.monotonicNs >= stopStartNs);

      expect(stopAccepted).toBeDefined();
      expect(Number(stopAccepted!.monotonicNs - stopStartNs) / 1e6).toBeLessThan(250);
      expect(Number(terminalNs - stopStartNs) / 1e6).toBeLessThan(5_000);
      expect(Buffer.byteLength((await manager.logs(definition.id)).join("\n"))).toBeLessThanOrEqual(64 * 1024);
      await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toBeNull();
      expect(running.generation).toBeTruthy();
      const operationRoot = path.join(nativeRuntimeRoot, running.generation!);
      const receipt = JSON.parse(await readFile(path.join(operationRoot, "terminal-receipt.json"), "utf8")) as {
        terminal?: { cleanupProven?: boolean };
      };
      expect(receipt.terminal?.cleanupProven).toBe(true);
      const index = (await readFile(path.join(operationRoot, "output-index.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { sequence: number; offset: number; length: number; stream: string });
      expect(index.length).toBeGreaterThan(10);
      expect(index.every((entry, position) => entry.sequence === position)).toBe(true);
      const stdoutEntries = index.filter((entry) => entry.stream === "stdout");
      expect(stdoutEntries.every((entry, position) => position === 0
        || entry.offset === stdoutEntries[position - 1]!.offset + stdoutEntries[position - 1]!.length)).toBe(true);
    },
  );

  it.runIf(process.platform === "darwin" && process.arch === "arm64")(
    "uses the native host Stop protocol as the manager-level cleanup authority",
    async () => {
      const { root, registry, definition } = await approvedFixture();
      const messages: Array<Record<string, unknown>> = [];
      const healthServer = createHttpServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      const native = nativeHostEmitting();
      native.helper.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
        const typed = message as Record<string, unknown>;
        messages.push(typed);
        if (typed.type === "start") {
          const protocolVersion = { major: 1, minor: 0 };
          const requestId = typed.requestId as string;
          const ownerToken = typed.ownerToken as string;
          healthServer.listen(Number(typed.port), "127.0.0.1", () => queueMicrotask(() => {
            native.helper.emit("message", {
              type: "handshake",
              protocolVersion,
              requestId: "bootstrap",
              capabilities: nativeCapabilities,
            });
            native.helper.emit("message", { type: "accepted", port: typed.port, protocolVersion, requestId, ownerToken });
            native.helper.emit("message", { type: "spawned", pid: 88_881, pgid: 88_881, protocolVersion, requestId, ownerToken });
            native.helper.emit("message", { type: "listener-verified", port: typed.port, protocolVersion, requestId, ownerToken });
          }));
        } else if (typed.type === "stop") {
          queueMicrotask(() => {
            native.helper.emit("message", {
              type: "stop-accepted",
              protocolVersion: typed.protocolVersion,
              requestId: typed.requestId,
              ownerToken: typed.requestId,
            });
            native.helper.emit("message", {
              type: "app-exit",
              code: 0,
              signal: null,
              protocolVersion: typed.protocolVersion,
              requestId: typed.requestId,
              ownerToken: typed.requestId,
            });
            native.helper.emit("message", {
              type: "stopped",
              protocolVersion: typed.protocolVersion,
              requestId: typed.requestId,
              ownerToken: typed.requestId,
            });
            native.helper.emit("message", {
              type: "terminal",
              status: "succeeded",
              cleanupProven: true,
              receiptWritten: true,
              protocolVersion: typed.protocolVersion,
              requestId: typed.requestId,
              ownerToken: typed.requestId,
            });
            native.helper.emit("disconnect");
            native.emitExit(0);
          });
        }
        callback?.(null);
        return true;
      });
      const processPlatform = {
        platform: "darwin" as const,
        systemPathEntries: [],
        terminate: vi.fn(async () => undefined),
        probePersistedRuntime: vi.fn(async () => ({ pid: "dead" as const, processGroup: "dead" as const, listener: "dead" as const })),
        verifyListenerOwnership: vi.fn(async () => true),
      };
      const manager = new LocalAppRuntimeManager({
        registry,
        processPlatform,
        nativeProcessHostPath: "/tmp/rudder-process-host-test",
        nativeRuntimeRoot: path.join(root, "native-runtime"),
        useNativeProcessHost: true,
        spawnNativeProcessHost: (() => native.helper) as typeof spawnNativeProcessHost,
        verifyListenerOwnership: async () => true,
      });

      await expect(manager.start(definition.id)).resolves.toMatchObject({ status: "running" });
      await expect(manager.stop(definition.id)).resolves.toMatchObject({ status: "stopped" });

      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "stop", requestId: expect.any(String) }),
      ]));
      expect(processPlatform.terminate).not.toHaveBeenCalled();
      await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toBeNull();
      await new Promise<void>((resolve, reject) => healthServer.close((error) => error ? reject(error) : resolve()));
    },
  );

  it.runIf(process.platform === "darwin" && process.arch === "arm64")(
    "keeps native ownership orphaned when manager Stop lacks terminal cleanup proof",
    async () => {
      const { root, registry, definition } = await approvedFixture();
      const healthServer = createHttpServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      const native = nativeHostEmitting();
      native.helper.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
        const typed = message as Record<string, unknown>;
        if (typed.type === "start") {
          const protocolVersion = { major: 1, minor: 0 };
          const requestId = typed.requestId as string;
          const ownerToken = typed.ownerToken as string;
          healthServer.listen(Number(typed.port), "127.0.0.1", () => queueMicrotask(() => {
            native.helper.emit("message", {
              type: "handshake",
              protocolVersion,
              requestId: "bootstrap",
              capabilities: nativeCapabilities,
            });
            native.helper.emit("message", { type: "accepted", port: typed.port, protocolVersion, requestId, ownerToken });
            native.helper.emit("message", { type: "spawned", pid: 88_881, pgid: 88_881, protocolVersion, requestId, ownerToken });
            native.helper.emit("message", { type: "listener-verified", port: typed.port, protocolVersion, requestId, ownerToken });
          }));
        }
        callback?.(null);
        return true;
      });
      const processPlatform = {
        platform: "darwin" as const,
        systemPathEntries: [],
        terminate: vi.fn(async () => undefined),
        probePersistedRuntime: vi.fn(async () => ({ pid: "alive" as const, processGroup: "alive" as const, listener: "alive" as const })),
        verifyListenerOwnership: vi.fn(async () => true),
      };
      const manager = new LocalAppRuntimeManager({
        registry,
        processPlatform,
        nativeProcessHostPath: "/tmp/rudder-process-host-test",
        nativeRuntimeRoot: path.join(root, "native-runtime"),
        useNativeProcessHost: true,
        spawnNativeProcessHost: (() => native.helper) as typeof spawnNativeProcessHost,
        verifyListenerOwnership: async () => true,
        cleanupTimeoutMs: 20,
      });

      await expect(manager.start(definition.id)).resolves.toMatchObject({ status: "running" });
      await expect(manager.stop(definition.id)).rejects.toThrow("process-host cleanup could not be verified");

      expect(processPlatform.terminate).not.toHaveBeenCalled();
      await expect(manager.status(definition.id)).resolves.toMatchObject({ status: "orphaned_unverified" });
      await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
        status: "orphaned_unverified",
        pid: 88_881,
        pgid: 88_881,
      });
      native.helper.emit("disconnect");
      native.emitExit(1);
      await new Promise<void>((resolve, reject) => healthServer.close((error) => error ? reject(error) : resolve()));
    },
  );

  it.skipIf(!nativeHostPath || process.platform !== "darwin" || process.arch !== "arm64")(
    "proves Rust process-host stop kills a surviving Local App descendant",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rudder-native-process-host-descendant-"));
      const nativeRuntimeRoot = path.join(root, "native-runtime");
      await mkdir(nativeRuntimeRoot);
      const descendantPath = path.join(root, "descendant.pid");
      const helper = spawnNativeProcessHost(nativeHostPath!, { cwd: root });
      const messages: Array<{ type?: unknown; pid?: unknown; pgid?: unknown }> = [];
      const exited = once(helper, "exit");
      helper.on("message", (message: unknown) => {
        if (message && typeof message === "object") messages.push(message as { type?: unknown; pid?: unknown; pgid?: unknown });
      });
      const script = `sleep 30 & echo $! > ${JSON.stringify(descendantPath)}; wait`;
      helper.send({
        type: "start",
        protocolVersion: { major: 1, minor: 0 },
        requestId: "descendant-stop",
        executable: "/bin/sh",
        argv: ["-c", script],
        cwd: root,
        env: {},
        ownerToken: "descendant-stop",
        port: await unusedLoopbackPort(),
        runtimeRoot: nativeRuntimeRoot,
      });
      await vi.waitFor(async () => {
        expect((await readFile(descendantPath, "utf8")).trim()).toMatch(/^\d+$/u);
      }, { timeout: 3_000 });
      const descendantPid = Number.parseInt((await readFile(descendantPath, "utf8")).trim(), 10);
      helper.send({
        type: "stop",
        protocolVersion: { major: 1, minor: 0 },
        requestId: "descendant-stop",
      });
      const [exitCode, signal] = await exited as [number | null, NodeJS.Signals | null];
      expect(exitCode).toBe(0);
      expect(signal).toBeNull();
      expect(messages.map((message) => message.type)).toEqual(expect.arrayContaining([
        "handshake",
        "spawned",
        "stopped",
        "terminal",
      ]));
      await vi.waitFor(() => {
        expect(() => process.kill(descendantPid, 0)).toThrow();
      }, { timeout: 3_000 });
    },
  );

  it.skipIf(!nativeHostPath || process.platform !== "darwin" || process.arch !== "arm64")(
    "fails closed when a Local App exits while leaving a descendant",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rudder-native-process-host-natural-exit-"));
      const nativeRuntimeRoot = path.join(root, "native-runtime");
      await mkdir(nativeRuntimeRoot);
      const descendantPath = path.join(root, "descendant.pid");
      const helper = spawnNativeProcessHost(nativeHostPath!, { cwd: root });
      const messages: Array<{ type?: unknown; errorCode?: unknown }> = [];
      const exited = once(helper, "exit");
      helper.on("message", (message: unknown) => {
        if (message && typeof message === "object") messages.push(message as { type?: unknown; errorCode?: unknown });
      });
      const script = `sleep 30 & echo $! > ${JSON.stringify(descendantPath)}; exit 0`;
      helper.send({
        type: "start",
        protocolVersion: { major: 1, minor: 0 },
        requestId: "natural-exit",
        executable: "/bin/sh",
        argv: ["-c", script],
        cwd: root,
        env: {},
        ownerToken: "natural-exit",
        port: await unusedLoopbackPort(),
        runtimeRoot: nativeRuntimeRoot,
      });
      await vi.waitFor(async () => {
        expect((await readFile(descendantPath, "utf8")).trim()).toMatch(/^\d+$/u);
      }, { timeout: 3_000 });
      const descendantPid = Number.parseInt((await readFile(descendantPath, "utf8")).trim(), 10);
      const [exitCode, signal] = await exited as [number | null, NodeJS.Signals | null];
      expect(exitCode).toBe(1);
      expect(signal).toBeNull();
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "terminal", errorCode: "descendant_cleanup" }),
      ]));
      await vi.waitFor(() => {
        expect(() => process.kill(descendantPid, 0)).toThrow();
      }, { timeout: 3_000 });
    },
  );

  it.runIf(process.platform === "darwin" && process.arch === "arm64")(
    "records failed native child exits as failed when cleanup is proven",
    async () => {
      const { root, registry, definition } = await approvedFixture();
      const generationMessages: Array<Record<string, unknown>> = [];
      const healthServer = createHttpServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      const native = nativeHostEmitting((message, helper) => {
        const ownerToken = message.ownerToken as string;
        const requestId = message.requestId as string;
        const protocolVersion = { major: 1, minor: 0 };
        healthServer.listen(Number(message.port), "127.0.0.1", () => queueMicrotask(() => {
          helper.emit("message", {
            type: "handshake",
            protocolVersion,
            requestId: "bootstrap",
            capabilities: nativeCapabilities,
          });
          helper.emit("message", { type: "accepted", port: message.port, protocolVersion, requestId, ownerToken });
          helper.emit("message", { type: "spawned", pid: 88_881, pgid: 88_881, protocolVersion, requestId, ownerToken });
          helper.emit("message", { type: "listener-verified", port: message.port, protocolVersion, requestId, ownerToken });
        }));
        generationMessages.push({ ownerToken, requestId });
      });
      const manager = new LocalAppRuntimeManager({
        registry,
        platform: "darwin",
        nativeProcessHostPath: "/tmp/rudder-process-host-test",
        nativeRuntimeRoot: path.join(root, "native-runtime"),
        useNativeProcessHost: true,
        spawnNativeProcessHost: (() => native.helper) as typeof spawnNativeProcessHost,
        verifyListenerOwnership: async () => true,
        processPlatform: {
          platform: "darwin",
          systemPathEntries: [],
          terminate: vi.fn(async () => undefined),
          probePersistedRuntime: vi.fn(async () => ({ pid: "dead", processGroup: "dead", listener: "dead" })),
          verifyListenerOwnership: vi.fn(async () => true),
        },
      });
      await expect(manager.start(definition.id)).resolves.toMatchObject({ status: "running" });
      const identity = generationMessages[0]!;
      native.helper.emit("message", {
        type: "app-exit",
        code: 17,
        signal: null,
        protocolVersion: { major: 1, minor: 0 },
        requestId: identity.requestId,
        ownerToken: identity.ownerToken,
      });
      native.helper.emit("message", {
        type: "terminal",
        status: "failed",
        errorCode: "child_exit",
        cleanupProven: true,
        receiptWritten: true,
        protocolVersion: { major: 1, minor: 0 },
        requestId: identity.requestId,
        ownerToken: identity.ownerToken,
      });
      native.helper.emit("disconnect");
      native.emitExit(1);
      await vi.waitFor(async () => {
        expect((await manager.status(definition.id)).status).toBe("failed");
      });
      await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
        status: "failed",
        pid: null,
        pgid: null,
      });
      await new Promise<void>((resolve, reject) => healthServer.close((error) => error ? reject(error) : resolve()));
    },
  );

  it.runIf(process.platform === "darwin" && process.arch === "arm64")(
    "keeps native cleanup untrusted after a post-start lifecycle identity violation",
    async () => {
      const { root, registry, definition } = await approvedFixture();
      const healthServer = createHttpServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      const native = nativeHostEmitting((message, helper) => {
        const protocolVersion = { major: 1, minor: 0 };
        healthServer.listen(Number(message.port), "127.0.0.1", () => queueMicrotask(() => {
          helper.emit("message", {
            type: "handshake",
            protocolVersion,
            requestId: "bootstrap",
            capabilities: nativeCapabilities,
          });
          helper.emit("message", {
            type: "accepted",
            port: message.port,
            protocolVersion,
            requestId: message.requestId,
            ownerToken: message.ownerToken,
          });
          helper.emit("message", {
            type: "listener-verified",
            port: message.port,
            protocolVersion,
            requestId: message.requestId,
            ownerToken: message.ownerToken,
          });
          helper.emit("message", {
            type: "spawned",
            pid: 88_881,
            pgid: 88_881,
            protocolVersion,
            requestId: message.requestId,
            ownerToken: message.ownerToken,
          });
          native.emitExit(1);
          helper.emit("disconnect");
        }));
      });
      const processPlatform = {
        platform: "darwin" as const,
        systemPathEntries: [],
        terminate: vi.fn(async () => undefined),
        probePersistedRuntime: vi.fn(async () => ({ pid: "dead" as const, processGroup: "dead" as const, listener: "dead" as const })),
        verifyListenerOwnership: vi.fn(async () => true),
      };
      const manager = new LocalAppRuntimeManager({
        registry,
        processPlatform,
        nativeProcessHostPath: "/tmp/rudder-process-host-test",
        nativeRuntimeRoot: path.join(root, "native-runtime"),
        useNativeProcessHost: true,
        spawnNativeProcessHost: (() => native.helper) as typeof spawnNativeProcessHost,
        verifyListenerOwnership: async () => true,
      });
      await expect(manager.start(definition.id)).rejects.toThrow("listener frame is invalid or out of order");
      expect(processPlatform.terminate).toHaveBeenCalledOnce();
      expect(processPlatform.terminate).toHaveBeenCalledWith(88_881);
      await expect(registry.getRuntimeDescriptor(definition.id)).resolves.toMatchObject({
        status: "orphaned_unverified",
      });
      await new Promise<void>((resolve, reject) => healthServer.close((error) => error ? reject(error) : resolve()));
    },
  );
});
