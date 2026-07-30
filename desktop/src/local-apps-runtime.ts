import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSafeLocalAppProcessId } from "./local-app-process-identity.mjs";
import {
  createLocalAppProcessPlatform,
  type LocalAppPersistedRuntimeLiveness,
  type LocalAppProcessPlatform,
} from "./local-app-process-platform.js";
import type {
  LocalAppDefinition,
  LocalAppRegistry,
  LocalAppRuntimeDescriptor,
} from "./local-apps-registry.js";

export {
  parseLsofListenerProcessRecords,
  type LsofListenerProcessRecord
} from "./local-app-process-platform.js";

const WATCHDOG_RUNNER_PATH = fileURLToPath(new URL("./local-app-watchdog-runner.mjs", import.meta.url));

export type LocalAppRuntimeStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed"
  | "orphaned_unverified";

export type LocalAppRuntimeView = {
  status: LocalAppRuntimeStatus;
  generation: string | null;
  origin?: string;
  openPath?: string;
  partition?: string;
  error?: string;
};

type RuntimeRecord = {
  status: LocalAppRuntimeStatus;
  generation: string;
  definition: LocalAppDefinition;
  helper: ChildProcess | null;
  watchdog: WatchdogLifecycle | null;
  pid: number | null;
  pgid: number | null;
  port: number | null;
  origin: string | null;
  verified: boolean;
  logText: string;
  error?: string;
};

type WatchdogLifecycle = {
  stoppedAcknowledged: boolean;
  exited: boolean;
  spawnedPromise: Promise<void>;
  exitPromise: Promise<void>;
  cleanupPromise: Promise<void>;
  resolveSpawned: () => void;
  resolveExit: () => void;
  resolveCleanup: () => void;
};

type TerminationOptions = {
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  isGroupAlive?: (pgid: number) => boolean;
  delay?: (milliseconds: number) => Promise<void>;
  termTimeoutMs?: number;
  pollMs?: number;
};

type RuntimeManagerOptions = {
  registry: LocalAppRegistry;
  hostExecutablePath?: string;
  platform?: NodeJS.Platform;
  maxLogBytes?: number;
  verifyListenerOwnership?: (input: { port: number; pid: number; pgid: number }) => Promise<boolean>;
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  spawnWatchdog?: typeof spawn;
  watchdogRunnerPath?: string;
  watchdogStartTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  terminationOptions?: Omit<TerminationOptions, "killGroup">;
  processPlatform?: LocalAppProcessPlatform;
  probePersistedRuntimeLiveness?: (input: {
    pid: number | null;
    pgid: number | null;
    port: number | null;
  }) => Promise<LocalAppPersistedRuntimeLiveness>;
};

export function localAppPartitionId(installationId: string, definitionId: string): string {
  const digest = createHash("sha256").update(`${installationId}\0${definitionId}`).digest("hex");
  return `persist:rudder-local-app-${digest.slice(0, 32)}`;
}

export function installControlPipeEofCleanup(
  pipe: Pick<EventEmitter, "once">,
  cleanup: () => Promise<void>,
): void {
  let invoked = false;
  const run = () => {
    if (invoked) return;
    invoked = true;
    void cleanup().catch(() => undefined);
  };
  pipe.once("end", run);
  pipe.once("close", run);
}

function defaultKillGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!isSafeLocalAppProcessId(pgid)) {
    throw new Error("Refusing to terminate an unverified Local App process group");
  }
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function defaultIsGroupAlive(pgid: number): boolean {
  if (!isSafeLocalAppProcessId(pgid)) return true;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function probeLoopbackListenerLiveness(port: number | null): Promise<LocalAppPersistedRuntimeLiveness["listener"]> {
  if (!Number.isInteger(port) || port === null || port <= 0 || port > 65_535) return "unknown";
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (result: LocalAppPersistedRuntimeLiveness["listener"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => finish("unknown"), 500);
    timeout.unref();
    socket.unref();
    socket.once("connect", () => finish("alive"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? "dead" : "unknown");
    });
  });
}

export async function terminateOwnedProcessGroup(
  pgid: number | null,
  options: TerminationOptions = {},
): Promise<void> {
  if (!isSafeLocalAppProcessId(pgid)) {
    throw new Error("Refusing to terminate an unverified Local App process group");
  }
  const killGroup = options.killGroup ?? defaultKillGroup;
  const isGroupAlive = options.isGroupAlive ?? defaultIsGroupAlive;
  const delay = options.delay ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const termTimeoutMs = Math.max(0, options.termTimeoutMs ?? 2_000);
  const pollMs = Math.max(1, options.pollMs ?? 50);

  const attempts = Math.max(1, Math.ceil(termTimeoutMs / pollMs));
  const waitUntilDead = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!isGroupAlive(pgid)) return true;
      await delay(pollMs);
    }
    return !isGroupAlive(pgid);
  };
  killGroup(pgid, "SIGTERM");
  if (await waitUntilDead()) return;
  killGroup(pgid, "SIGKILL");
  if (await waitUntilDead()) return;
  throw new Error(`Local App process group ${pgid} could not be proven dead`);
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a Local App loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function trustedNodeBinForExecutable(executable: string): Promise<string | null> {
  const marker = `${path.sep}lib${path.sep}node_modules${path.sep}`;
  const markerIndex = executable.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const prefix = executable.slice(0, markerIndex) || path.parse(executable).root;
  try {
    const binDirectory = await realpath(path.join(prefix, "bin"));
    const nodeExecutable = await realpath(path.join(binDirectory, "node"));
    await access(nodeExecutable, fsConstants.X_OK);
    return binDirectory;
  } catch {
    return null;
  }
}

async function trustedExecutablePath(
  definition: LocalAppDefinition,
  hostExecutablePath: string,
  systemPathEntries: string[],
): Promise<string> {
  const trustedNodeBin = await trustedNodeBinForExecutable(definition.executable);
  return [...new Set([
    path.dirname(definition.executable),
    trustedNodeBin,
    path.dirname(hostExecutablePath),
    ...systemPathEntries,
  ].filter((entry): entry is string => Boolean(entry)))].join(path.delimiter);
}

export async function buildChildEnvironment(
  definition: LocalAppDefinition,
  port: number,
  hostExecutablePath: string,
  processPlatform: LocalAppProcessPlatform,
): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {
    PATH: await trustedExecutablePath(
      definition,
      hostExecutablePath,
      processPlatform.systemPathEntries,
    ),
  };
  if (processPlatform.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    environment.SystemRoot = systemRoot;
    environment.WINDIR = process.env.WINDIR ?? systemRoot;
    environment.TEMP = process.env.TEMP ?? process.env.TMP ?? path.win32.join(systemRoot, "Temp");
    environment.TMP = process.env.TMP ?? environment.TEMP;
  } else {
    environment.TMPDIR = process.env.TMPDIR ?? "/tmp";
  }
  const reservedEnvironmentNames = processPlatform.platform === "win32"
    ? new Set(["PATH", "HOST", "PORT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"])
    : new Set(["PATH", "HOST", "PORT"]);
  for (const name of definition.inheritedEnvNames) {
    if (reservedEnvironmentNames.has(name.toUpperCase())) continue;
    const value = process.env[name];
    if (typeof value === "string") environment[name] = value;
  }
  if (
    definition.executable === hostExecutablePath
    && definition.inheritedEnvNames.includes("ELECTRON_RUN_AS_NODE")
  ) {
    environment.ELECTRON_RUN_AS_NODE = "1";
  }
  environment.HOST = "127.0.0.1";
  environment.PORT = String(port);
  return environment;
}

function publicView(record: RuntimeRecord): LocalAppRuntimeView {
  const view: LocalAppRuntimeView = {
    status: record.status,
    generation: record.generation,
  };
  if (record.status === "running" && record.verified && record.origin) {
    view.origin = record.origin;
    view.openPath = record.definition.openPath;
  }
  if (record.error) view.error = record.error;
  return view;
}

export class LocalAppRuntimeManager {
  private readonly registry: LocalAppRegistry;
  private readonly hostExecutablePath: string;
  private readonly processPlatform: LocalAppProcessPlatform;
  private readonly maxLogBytes: number;
  private readonly verifyListenerOwnership: (input: { port: number; pid: number; pgid: number }) => Promise<boolean>;
  private readonly spawnWatchdog: typeof spawn;
  private readonly watchdogRunnerPath: string;
  private readonly watchdogStartTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly probePersistedRuntimeLiveness: NonNullable<RuntimeManagerOptions["probePersistedRuntimeLiveness"]>;
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly recordPromises = new Map<string, Promise<RuntimeRecord>>();
  private readonly bindingOperations = new Map<string, Promise<void>>();
  private acceptingLifecycleOperations = true;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: RuntimeManagerOptions) {
    this.registry = options.registry;
    this.hostExecutablePath = options.hostExecutablePath ?? process.execPath;
    if (
      options.processPlatform
      && options.platform
      && options.processPlatform.platform !== options.platform
    ) {
      throw new Error("Local App process platform does not match the requested platform");
    }
    const platform = options.processPlatform?.platform ?? options.platform ?? process.platform;
    this.processPlatform = options.processPlatform ?? createLocalAppProcessPlatform({
      platform,
      killGroup: options.killGroup,
      isGroupAlive: options.terminationOptions?.isGroupAlive,
      delay: options.terminationOptions?.delay,
      termTimeoutMs: options.terminationOptions?.termTimeoutMs,
      pollMs: options.terminationOptions?.pollMs,
      probeLoopbackListener: probeLoopbackListenerLiveness,
    });
    this.maxLogBytes = Math.max(256, options.maxLogBytes ?? 64 * 1024);
    this.verifyListenerOwnership = options.verifyListenerOwnership
      ?? this.processPlatform.verifyListenerOwnership;
    this.spawnWatchdog = options.spawnWatchdog ?? spawn;
    this.watchdogRunnerPath = options.watchdogRunnerPath ?? WATCHDOG_RUNNER_PATH;
    this.watchdogStartTimeoutMs = Math.max(1, options.watchdogStartTimeoutMs ?? 3_000);
    this.cleanupTimeoutMs = Math.max(1, options.cleanupTimeoutMs ?? 5_000);
    this.probePersistedRuntimeLiveness = options.probePersistedRuntimeLiveness
      ?? this.processPlatform.probePersistedRuntime;
  }

  private view(record: RuntimeRecord): LocalAppRuntimeView {
    const view = publicView(record);
    if (record.status === "running" && record.verified) {
      view.partition = localAppPartitionId(this.registry.installationId, record.definition.id);
    }
    return view;
  }

  private appendLog(record: RuntimeRecord, chunk: Buffer | string): void {
    record.logText += chunk.toString();
    const bytes = Buffer.byteLength(record.logText);
    if (bytes <= this.maxLogBytes) return;
    const buffer = Buffer.from(record.logText);
    record.logText = buffer.subarray(buffer.length - this.maxLogBytes).toString("utf8");
  }

  private recordFromPersistedDescriptor(
    definition: LocalAppDefinition,
    descriptor: LocalAppRuntimeDescriptor | null,
  ): RuntimeRecord {
    const persistedRunning = Boolean(descriptor && ["starting", "running", "stopping"].includes(descriptor.status));
    const persistedOrphan = descriptor?.status === "orphaned_unverified" || descriptor?.status === "quarantined";
    const record: RuntimeRecord = {
      status: persistedRunning || persistedOrphan
        ? "orphaned_unverified"
        : descriptor?.status === "failed" ? "failed" : "stopped",
      generation: descriptor?.generation ?? randomUUID(),
      definition,
      helper: null,
      watchdog: null,
      pid: persistedRunning || persistedOrphan ? descriptor?.pid ?? null : null,
      pgid: persistedRunning || persistedOrphan ? descriptor?.pgid ?? null : null,
      port: persistedRunning || persistedOrphan ? descriptor?.port ?? null : null,
      origin: null,
      verified: false,
      logText: "",
      error: persistedRunning || persistedOrphan
        ? "Previous Local App ownership cannot be verified after restart"
        : undefined,
    };
    return record;
  }

  private async persistedStatus(id: string, definition: LocalAppDefinition): Promise<RuntimeRecord> {
    let descriptor = await this.registry.getRuntimeDescriptor(id);
    if (descriptor && ["starting", "running", "stopping"].includes(descriptor.status)) {
      const liveness = await this.probePersistedRuntimeLiveness({
        pid: descriptor.pid,
        pgid: descriptor.pgid,
        port: descriptor.port ?? null,
      });
      const provablyDead = liveness.pid === "dead"
        && liveness.processGroup === "dead"
        && liveness.listener === "dead";
      if (provablyDead) {
        const cleared = await this.registry.recordRuntimeDescriptorIfMatch(
          id,
          { generation: descriptor.generation, status: descriptor.status },
          null,
        );
        descriptor = cleared ? null : await this.registry.getRuntimeDescriptor(id);
      }
    }
    const record = this.recordFromPersistedDescriptor(definition, descriptor);
    this.records.set(id, record);
    return record;
  }

  private async getRecord(id: string): Promise<RuntimeRecord> {
    const existing = this.records.get(id);
    if (existing) return existing;
    const inFlight = this.recordPromises.get(id);
    if (inFlight) return inFlight;
    const promise = this.registry.getDefinition(id)
      .then((definition) => this.persistedStatus(id, definition));
    this.recordPromises.set(id, promise);
    try {
      return await promise;
    } finally {
      if (this.recordPromises.get(id) === promise) this.recordPromises.delete(id);
    }
  }

  private async withBindingOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.bindingOperations.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const completion = result.then(() => undefined, () => undefined);
    this.bindingOperations.set(id, completion);
    try {
      return await result;
    } finally {
      if (this.bindingOperations.get(id) === completion) this.bindingOperations.delete(id);
    }
  }

  private ensureLifecycleAdmission(): void {
    if (!this.acceptingLifecycleOperations) throw new Error("Local Apps are shutting down");
  }

  private async drainBindingOperations(): Promise<void> {
    while (this.bindingOperations.size > 0) {
      await Promise.allSettled([...this.bindingOperations.values()]);
    }
  }

  private createWatchdogLifecycle(): WatchdogLifecycle {
    let resolveSpawned!: () => void;
    let resolveExit!: () => void;
    let resolveCleanup!: () => void;
    const spawnedPromise = new Promise<void>((resolve) => { resolveSpawned = resolve; });
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
    const cleanupPromise = new Promise<void>((resolve) => { resolveCleanup = resolve; });
    return {
      stoppedAcknowledged: false,
      exited: false,
      spawnedPromise,
      exitPromise,
      cleanupPromise,
      resolveSpawned,
      resolveExit,
      resolveCleanup,
    };
  }

  private noteWatchdogCleanupProgress(lifecycle: WatchdogLifecycle): void {
    if (lifecycle.stoppedAcknowledged && lifecycle.exited) lifecycle.resolveCleanup();
  }

  private waitUntilDeadline(promise: Promise<unknown>, deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => finish(false), remaining);
      timeout.unref();
      void promise.then(() => finish(true), () => finish(false));
    });
  }

  private unverifiedDescriptor(record: RuntimeRecord): LocalAppRuntimeDescriptor {
    if (isSafeLocalAppProcessId(record.pid)
      && isSafeLocalAppProcessId(record.pgid)
      && Number.isInteger(record.port)
      && record.port! > 0
      && record.port! <= 65_535) {
      return {
        status: "orphaned_unverified",
        pid: record.pid,
        pgid: record.pgid,
        port: record.port!,
        generation: record.generation,
      };
    }
    return { status: "quarantined", pid: null, pgid: null, generation: record.generation };
  }

  private async promoteLateOwnership(record: RuntimeRecord): Promise<void> {
    if (record.status !== "orphaned_unverified") return;
    const descriptor = this.unverifiedDescriptor(record);
    if (descriptor.status !== "orphaned_unverified") return;
    await this.registry.recordRuntimeDescriptorIfMatch(
      record.definition.id,
      { generation: record.generation, status: ["quarantined", "orphaned_unverified"] },
      descriptor,
    );
  }

  private async proveRecordCleanup(record: RuntimeRecord): Promise<{ proven: boolean; reason?: Error }> {
    const errors: Error[] = [];
    const lifecycle = record.watchdog;
    const deadline = Date.now() + this.cleanupTimeoutMs;

    if (record.helper?.stdin) {
      try {
        record.helper.stdin.end();
      } catch (error) {
        errors.push(new Error("Local App watchdog control pipe could not be closed", { cause: error }));
      }
    } else if (record.helper) {
      errors.push(new Error("Local App watchdog control pipe is unavailable"));
    }

    if (!record.pgid && lifecycle && !lifecycle.exited) {
      await this.waitUntilDeadline(Promise.race([
        lifecycle.spawnedPromise,
        lifecycle.exitPromise,
        lifecycle.cleanupPromise,
      ]), deadline);
    }

    let processGroupProven = record.pgid === null;
    if (record.pgid !== null) {
      try {
        await this.processPlatform.terminate(record.pgid);
        processGroupProven = true;
      } catch (error) {
        errors.push(new Error("Local App process-group termination could not be verified", { cause: error }));
      }
    }

    let watchdogProven = lifecycle === null;
    if (lifecycle) {
      if (!lifecycle.stoppedAcknowledged || !lifecycle.exited) {
        await this.waitUntilDeadline(lifecycle.cleanupPromise, deadline);
      }
      watchdogProven = lifecycle.stoppedAcknowledged && lifecycle.exited;
      if (!watchdogProven) {
        errors.push(new Error("Local App watchdog did not acknowledge cleanup and exit within the bounded timeout"));
      }
    }

    if (processGroupProven && watchdogProven && errors.length === 0) return { proven: true };
    return { proven: false, reason: new AggregateError(errors, "Local App cleanup evidence is incomplete") };
  }

  private async persistUnverifiedCleanup(
    record: RuntimeRecord,
    expected: { generation: string; status?: string | readonly string[] } | null,
    error: Error,
  ): Promise<void> {
    record.status = "orphaned_unverified";
    record.verified = false;
    record.origin = null;
    record.error = error.message;
    const descriptor = this.unverifiedDescriptor(record);
    const recorded = await this.registry.recordRuntimeDescriptorIfMatch(
      record.definition.id,
      expected,
      descriptor,
    );
    if (!recorded) {
      this.records.delete(record.definition.id);
      throw new Error("Local App runtime generation changed while recording unverified cleanup", { cause: error });
    }
    if (descriptor.status === "quarantined") await this.promoteLateOwnership(record);
  }

  private async spawnHelper(record: RuntimeRecord, port: number): Promise<{ pid: number; pgid: number }> {
    const environment = await buildChildEnvironment(
      record.definition,
      port,
      this.hostExecutablePath,
      this.processPlatform,
    );
    return new Promise((resolve, reject) => {
      const watchdogEnvironment: NodeJS.ProcessEnv = {
        ELECTRON_RUN_AS_NODE: "1",
      };
      if (this.processPlatform.platform === "win32") {
        const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
        watchdogEnvironment.SystemRoot = systemRoot;
        watchdogEnvironment.WINDIR = process.env.WINDIR ?? systemRoot;
        watchdogEnvironment.TEMP = process.env.TEMP ?? process.env.TMP ?? path.win32.join(systemRoot, "Temp");
        watchdogEnvironment.TMP = process.env.TMP ?? watchdogEnvironment.TEMP;
      }
      const helper = this.spawnWatchdog(process.execPath, [this.watchdogRunnerPath], {
        env: watchdogEnvironment,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      record.helper = helper;
      const lifecycle = this.createWatchdogLifecycle();
      record.watchdog = lifecycle;
      helper.stdout?.on("data", (chunk: Buffer) => this.appendLog(record, chunk));
      helper.stderr?.on("data", (chunk: Buffer) => this.appendLog(record, chunk));
      let settled = false;
      const timeout = setTimeout(
        () => finish(new Error("Local App watchdog did not start in time")),
        this.watchdogStartTimeoutMs,
      );
      timeout.unref();
      const finish = (error?: Error, value?: { pid: number; pgid: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value!);
      };
      helper.once("error", (error) => finish(error));
      helper.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const typed = message as { type?: unknown; pid?: unknown; pgid?: unknown; message?: unknown };
        if (typed.type === "spawned") {
          if (!isSafeLocalAppProcessId(typed.pid)
            || !isSafeLocalAppProcessId(typed.pgid)
            || typed.pid !== typed.pgid) {
            finish(new Error("Local App watchdog process identity is invalid"));
            return;
          }
          record.pid = typed.pid;
          record.pgid = typed.pgid;
          lifecycle.resolveSpawned();
          if (record.status === "orphaned_unverified") {
            void this.promoteLateOwnership(record).catch((error) => {
              record.error = `Local App late ownership could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
            });
          }
          finish(undefined, { pid: typed.pid, pgid: typed.pgid });
        } else if (typed.type === "error") {
          finish(new Error(typeof typed.message === "string" ? typed.message : "Local App watchdog failed"));
        } else if (typed.type === "stopped") {
          lifecycle.stoppedAcknowledged = true;
          this.noteWatchdogCleanupProgress(lifecycle);
        }
      });
      helper.once("exit", (code, signal) => {
        lifecycle.exited = true;
        lifecycle.resolveExit();
        this.noteWatchdogCleanupProgress(lifecycle);
        finish(new Error(`Local App watchdog exited before startup (${signal ?? code ?? "unknown"})`));
        if (record.status === "running") {
          void this.handleUnexpectedWatchdogExit(record).catch((error) => {
            record.status = "orphaned_unverified";
            record.verified = false;
            record.error = error instanceof Error ? error.message : String(error);
          });
        }
      });
      if (typeof helper.send !== "function") {
        finish(new Error("Local App watchdog control channel is unavailable"));
        return;
      }
      helper.send({
        type: "start",
        executable: record.definition.executable,
        argv: record.definition.argv,
        cwd: record.definition.cwd,
        env: environment,
      }, (error) => { if (error) finish(error); });
    });
  }

  private async handleUnexpectedWatchdogExit(record: RuntimeRecord): Promise<void> {
    const unexpectedExit = new Error("Local App process exited unexpectedly");
    await this.persistUnverifiedCleanup(
      record,
      { generation: record.generation, status: "running" },
      unexpectedExit,
    );
    const cleanup = await this.proveRecordCleanup(record);
    if (!cleanup.proven) {
      record.error = `${unexpectedExit.message}; cleanup could not be verified: ${cleanup.reason?.message ?? "unknown"}`;
      return;
    }
    const markedFailed = await this.registry.recordRuntimeDescriptorIfMatch(
      record.definition.id,
      { generation: record.generation, status: ["orphaned_unverified", "quarantined"] },
      { status: "failed", pid: null, pgid: null, generation: record.generation },
    );
    if (!markedFailed) {
      this.records.delete(record.definition.id);
      throw new Error("Local App runtime generation changed after unexpected exit");
    }
    record.status = "failed";
    record.verified = false;
    record.pid = null;
    record.pgid = null;
    record.port = null;
    record.origin = null;
    record.error = unexpectedExit.message;
  }

  private async waitForReadiness(record: RuntimeRecord): Promise<void> {
    const deadline = Date.now() + record.definition.readiness.timeoutMs;
    const url = `${record.origin}${record.definition.readiness.path}`;
    while (Date.now() < deadline) {
      if (!record.helper || record.helper.exitCode !== null || record.helper.signalCode !== null) {
        throw new Error("Local App exited before readiness succeeded");
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(500), redirect: "error" });
        if (response.ok) return;
      } catch {
        // Retry only within the configured bounded readiness window.
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    throw new Error(`Local App readiness check failed for ${record.definition.readiness.path}`);
  }

  private async failStart(
    record: RuntimeRecord,
    error: unknown,
    generationClaimed: boolean,
    previousDescriptor: LocalAppRuntimeDescriptor | null,
  ): Promise<never> {
    const startError = error instanceof Error ? error : new Error(String(error));
    const cleanup = await this.proveRecordCleanup(record);
    const expected = generationClaimed
      ? { generation: record.generation, status: ["starting", "running"] }
      : previousDescriptor === null
        ? null
        : { generation: previousDescriptor.generation, status: previousDescriptor.status };
    if (cleanup.proven) {
      const recorded = await this.registry.recordRuntimeDescriptorIfMatch(
        record.definition.id,
        expected,
        { status: "failed", pid: null, pgid: null, generation: record.generation },
      );
      if (!recorded) {
        this.records.delete(record.definition.id);
        throw new Error("Local App runtime generation changed during failed-start cleanup", { cause: startError });
      }
      record.status = "failed";
      record.verified = false;
      record.pid = null;
      record.pgid = null;
      record.port = null;
      record.origin = null;
      record.error = startError.message;
      throw startError;
    }

    const cleanupError = new Error(
      `${startError.message}; cleanup could not be verified: ${cleanup.reason?.message ?? "unknown"}`,
      { cause: cleanup.reason ?? startError },
    );
    await this.persistUnverifiedCleanup(record, expected, cleanupError);
    throw cleanupError;
  }

  async start(id: string): Promise<LocalAppRuntimeView> {
    this.ensureLifecycleAdmission();
    return this.withBindingOperation(id, () => this.startInternal(id));
  }

  private async startInternal(id: string): Promise<LocalAppRuntimeView> {
    const existing = await this.getRecord(id);
    if (existing.status === "running") return this.view(existing);
    if (existing.status === "orphaned_unverified") {
      throw new Error("Refusing to start while previous Local App ownership is unverified");
    }
    if (existing.status === "starting" || existing.status === "stopping") {
      throw new Error("Refusing to start while a Local App lifecycle transition is in progress");
    }
    const definition = await this.registry.requireApprovedDefinition(id);
    const previousDescriptor = await this.registry.getRuntimeDescriptor(id);
    if (previousDescriptor && previousDescriptor.status !== "failed") {
      this.records.delete(id);
      throw new Error("Refusing to start while previous Local App ownership is unverified");
    }
    const port = await allocateLoopbackPort();
    const record: RuntimeRecord = {
      status: "starting",
      generation: randomUUID(),
      definition,
      helper: null,
      watchdog: null,
      pid: null,
      pgid: null,
      port,
      origin: `http://127.0.0.1:${port}`,
      verified: false,
      logText: "",
    };
    this.records.set(id, record);
    let generationClaimed = false;
    try {
      const spawned = await this.spawnHelper(record, port);
      record.pid = spawned.pid;
      record.pgid = spawned.pgid;
      generationClaimed = await this.registry.recordRuntimeDescriptorIfMatch(
        id,
        previousDescriptor === null
          ? null
          : { generation: previousDescriptor.generation, status: previousDescriptor.status },
        { status: "starting", pid: record.pid, pgid: record.pgid, generation: record.generation, port },
      );
      if (!generationClaimed) throw new Error("Local App runtime generation changed during startup");
      await this.waitForReadiness(record);
      const owned = await this.verifyListenerOwnership({ port, pid: record.pid, pgid: record.pgid });
      if (!owned) throw new Error("Local App listener ownership could not be proven");
      record.status = "running";
      record.verified = true;
      const markedRunning = await this.registry.recordRuntimeDescriptorIfMatch(
        id,
        { generation: record.generation, status: "starting" },
        { status: "running", pid: record.pid, pgid: record.pgid, generation: record.generation, port },
      );
      if (!markedRunning) throw new Error("Local App runtime generation changed during startup");
      return this.view(record);
    } catch (error) {
      return this.failStart(record, error, generationClaimed, previousDescriptor);
    }
  }

  async stop(id: string): Promise<LocalAppRuntimeView> {
    this.ensureLifecycleAdmission();
    return this.withBindingOperation(id, () => this.stopInternal(id));
  }

  private async stopInternal(id: string): Promise<LocalAppRuntimeView> {
    const record = await this.getRecord(id);
    if (record.status === "orphaned_unverified" || !record.verified || !record.pgid) {
      if (record.status === "stopped" || record.status === "failed") return this.view(record);
      throw new Error("Refusing to stop an unverified Local App process group");
    }
    record.status = "stopping";
    const markedStopping = await this.registry.recordRuntimeDescriptorIfMatch(
      id,
      { generation: record.generation, status: "running" },
      {
        status: "stopping",
        pid: record.pid,
        pgid: record.pgid,
        generation: record.generation,
        ...(record.port === null ? {} : { port: record.port }),
      },
    );
    if (!markedStopping) {
      this.records.delete(id);
      throw new Error("Local App runtime generation changed while stopping");
    }
    try {
      await this.processPlatform.terminate(record.pgid);
    } catch (error) {
      try {
        record.helper?.stdin?.end();
      } catch {
        // The complete ownership descriptor remains quarantined below.
      }
      const terminationError = new Error(
        `Local App process-group termination could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      await this.persistUnverifiedCleanup(
        record,
        { generation: record.generation, status: "stopping" },
        terminationError,
      );
      throw terminationError;
    }
    record.helper?.stdin?.end();
    const cleared = await this.registry.recordRuntimeDescriptorIfMatch(
      id,
      { generation: record.generation, status: "stopping" },
      null,
    );
    if (!cleared) {
      this.records.delete(id);
      throw new Error("Local App runtime generation changed while stopping");
    }
    record.status = "stopped";
    record.verified = false;
    record.pid = null;
    record.pgid = null;
    record.port = null;
    record.origin = null;
    return this.view(record);
  }

  async status(id: string): Promise<LocalAppRuntimeView> {
    return this.view(await this.getRecord(id));
  }

  async logs(id: string): Promise<string[]> {
    const record = await this.getRecord(id);
    return record.logText ? record.logText.split(/\r?\n/).filter(Boolean) : [];
  }

  async attestedTarget(id: string): Promise<{ origin: string; openPath: string; partition: string } | null> {
    const record = await this.getRecord(id);
    if (record.status !== "running" || !record.verified || !record.origin) return null;
    return {
      origin: record.origin,
      openPath: record.definition.openPath,
      partition: localAppPartitionId(this.registry.installationId, id),
    };
  }

  attestedTargetForPartition(partition: string): { origin: string; openPath: string; partition: string } | null {
    for (const [id, record] of this.records) {
      if (record.status !== "running" || !record.verified || !record.origin) continue;
      const expectedPartition = localAppPartitionId(this.registry.installationId, id);
      if (partition === expectedPartition) {
        return { origin: record.origin, openPath: record.definition.openPath, partition: expectedPartition };
      }
    }
    return null;
  }

  isAttestedBootstrap(url: string, partition: string): boolean {
    const target = this.attestedTargetForPartition(partition);
    if (!target) return false;
    try {
      const candidate = new URL(url);
      const expected = new URL(target.openPath, target.origin);
      return candidate.protocol === "http:"
        && candidate.hostname === "127.0.0.1"
        && candidate.href === expected.href;
    } catch {
      return false;
    }
  }

  isAttestedNavigation(url: string, partition: string): boolean {
    const target = this.attestedTargetForPartition(partition);
    if (!target) return false;
    try {
      const candidate = new URL(url);
      return candidate.protocol === "http:"
        && candidate.hostname === "127.0.0.1"
        && candidate.origin === target.origin;
    } catch {
      return false;
    }
  }

  private async shutdownInternal(): Promise<void> {
    await this.drainBindingOperations();
    const failures = new Map<string, unknown>();
    const definitions = await this.registry.listDefinitions();
    const loaded = await Promise.allSettled(definitions.map((definition) => this.getRecord(definition.id)));
    loaded.forEach((result, index) => {
      if (result.status === "rejected") failures.set(definitions[index].id, result.reason);
    });
    const ids = [...this.records.entries()]
      .filter(([, record]) => record.status === "running" && record.verified)
      .map(([id]) => id);
    const stopped = await Promise.allSettled(ids.map((id) =>
      this.withBindingOperation(id, () => this.stopInternal(id))));
    stopped.forEach((result, index) => {
      if (result.status === "rejected") failures.set(ids[index], result.reason);
    });
    await this.drainBindingOperations();
    for (const [id, record] of this.records) {
      if (record.status === "orphaned_unverified") {
        failures.set(id, failures.get(id) ?? new Error(record.error ?? "Local App ownership remains unverified"));
      }
    }
    if (failures.size > 0) {
      const idsWithFailures = [...failures.keys()];
      const errors = [...failures].map(([id, cause]) => new Error(
        `Local App binding ${id} cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      ));
      throw new AggregateError(
        errors,
        `Local App cleanup failed for binding${failures.size === 1 ? "" : "s"}: ${idsWithFailures.join(", ")}`,
      );
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.acceptingLifecycleOperations = false;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }
}
