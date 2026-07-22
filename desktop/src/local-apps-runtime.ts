import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  LocalAppDefinition,
  LocalAppRegistry,
  LocalAppRuntimeDescriptor,
} from "./local-apps-registry.js";

const execFileAsync = promisify(execFile);
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
  pid: number | null;
  pgid: number | null;
  port: number | null;
  origin: string | null;
  verified: boolean;
  logText: string;
  error?: string;
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
  probePersistedRuntimeLiveness?: (input: {
    pid: number | null;
    pgid: number | null;
    port: number | null;
  }) => Promise<PersistedRuntimeLiveness>;
};

type LivenessState = "alive" | "dead" | "unknown";

type PersistedRuntimeLiveness = {
  pid: LivenessState;
  processGroup: LivenessState;
  listener: LivenessState;
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
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function defaultIsGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function probeProcessLiveness(target: number | null): LivenessState {
  if (!Number.isInteger(target) || target === null || target === 0) return "unknown";
  try {
    process.kill(target, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}

async function probeLoopbackListenerLiveness(port: number | null): Promise<LivenessState> {
  if (!Number.isInteger(port) || port === null || port <= 0 || port > 65_535) return "unknown";
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (result: LivenessState) => {
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

async function defaultProbePersistedRuntimeLiveness(input: {
  pid: number | null;
  pgid: number | null;
  port: number | null;
}): Promise<PersistedRuntimeLiveness> {
  return {
    pid: probeProcessLiveness(input.pid),
    processGroup: probeProcessLiveness(input.pgid === null ? null : -input.pgid),
    listener: await probeLoopbackListenerLiveness(input.port),
  };
}

export async function terminateOwnedProcessGroup(
  pgid: number | null,
  options: TerminationOptions = {},
): Promise<void> {
  if (!Number.isInteger(pgid) || pgid === null || pgid <= 0) {
    throw new Error("Refusing to terminate an unverified Local App process group");
  }
  const killGroup = options.killGroup ?? defaultKillGroup;
  const isGroupAlive = options.isGroupAlive ?? defaultIsGroupAlive;
  const delay = options.delay ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const termTimeoutMs = Math.max(0, options.termTimeoutMs ?? 2_000);
  const pollMs = Math.max(1, options.pollMs ?? 50);

  killGroup(pgid, "SIGTERM");
  const attempts = Math.max(1, Math.ceil(termTimeoutMs / pollMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isGroupAlive(pgid)) return;
    await delay(pollMs);
  }
  if (isGroupAlive(pgid)) killGroup(pgid, "SIGKILL");
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

async function defaultVerifyListenerOwnership(input: { port: number; pid: number; pgid: number }): Promise<boolean> {
  try {
    const childResult = await execFileAsync("/bin/ps", ["-o", "pgid=", "-p", String(input.pid)], {
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    if (Number.parseInt(String(childResult.stdout).trim(), 10) !== input.pgid) return false;
    const { stdout } = await execFileAsync("/usr/sbin/lsof", [
      "-nP",
      `-iTCP:${input.port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ], { timeout: 2_000, maxBuffer: 64 * 1024 });
    const listenerPids = String(stdout).split(/\r?\n/)
      .filter((line) => /^p\d+$/.test(line))
      .map((line) => Number.parseInt(line.slice(1), 10));
    if (listenerPids.length === 0) return false;
    for (const listenerPid of listenerPids) {
      const result = await execFileAsync("/bin/ps", ["-o", "pgid=", "-p", String(listenerPid)], {
        timeout: 2_000,
        maxBuffer: 16 * 1024,
      });
      const listenerPgid = Number.parseInt(String(result.stdout).trim(), 10);
      if (listenerPgid === input.pgid) return true;
    }
    return false;
  } catch {
    return false;
  }
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
): Promise<string> {
  const trustedNodeBin = await trustedNodeBinForExecutable(definition.executable);
  return [...new Set([
    path.dirname(definition.executable),
    trustedNodeBin,
    path.dirname(hostExecutablePath),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((entry): entry is string => Boolean(entry)))].join(path.delimiter);
}

async function buildChildEnvironment(
  definition: LocalAppDefinition,
  port: number,
  hostExecutablePath: string,
): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {
    PATH: await trustedExecutablePath(definition, hostExecutablePath),
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
  for (const name of definition.inheritedEnvNames) {
    if (name === "PATH") continue;
    const value = process.env[name];
    if (typeof value === "string") environment[name] = value;
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
  private readonly platform: NodeJS.Platform;
  private readonly maxLogBytes: number;
  private readonly verifyListenerOwnership: (input: { port: number; pid: number; pgid: number }) => Promise<boolean>;
  private readonly killGroup: (pgid: number, signal: NodeJS.Signals) => void;
  private readonly spawnWatchdog: typeof spawn;
  private readonly watchdogRunnerPath: string;
  private readonly probePersistedRuntimeLiveness: NonNullable<RuntimeManagerOptions["probePersistedRuntimeLiveness"]>;
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly recordPromises = new Map<string, Promise<RuntimeRecord>>();
  private readonly bindingOperations = new Map<string, Promise<void>>();

  constructor(options: RuntimeManagerOptions) {
    this.registry = options.registry;
    this.hostExecutablePath = options.hostExecutablePath ?? process.execPath;
    this.platform = options.platform ?? process.platform;
    this.maxLogBytes = Math.max(256, options.maxLogBytes ?? 64 * 1024);
    this.verifyListenerOwnership = options.verifyListenerOwnership ?? defaultVerifyListenerOwnership;
    this.killGroup = options.killGroup ?? defaultKillGroup;
    this.spawnWatchdog = options.spawnWatchdog ?? spawn;
    this.watchdogRunnerPath = options.watchdogRunnerPath ?? WATCHDOG_RUNNER_PATH;
    this.probePersistedRuntimeLiveness = options.probePersistedRuntimeLiveness
      ?? defaultProbePersistedRuntimeLiveness;
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
    const record: RuntimeRecord = {
      status: persistedRunning ? "orphaned_unverified" : descriptor?.status === "failed" ? "failed" : "stopped",
      generation: descriptor?.generation ?? randomUUID(),
      definition,
      helper: null,
      pid: persistedRunning ? descriptor?.pid ?? null : null,
      pgid: persistedRunning ? descriptor?.pgid ?? null : null,
      port: persistedRunning ? descriptor?.port ?? null : null,
      origin: null,
      verified: false,
      logText: "",
      error: persistedRunning ? "Previous Local App ownership cannot be verified after restart" : undefined,
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

  private async spawnHelper(record: RuntimeRecord, port: number): Promise<{ pid: number; pgid: number }> {
    const environment = await buildChildEnvironment(record.definition, port, this.hostExecutablePath);
    return new Promise((resolve, reject) => {
      const helper = this.spawnWatchdog(process.execPath, [this.watchdogRunnerPath], {
        env: { ELECTRON_RUN_AS_NODE: "1" },
        shell: false,
        detached: false,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      record.helper = helper;
      helper.stdout?.on("data", (chunk: Buffer) => this.appendLog(record, chunk));
      helper.stderr?.on("data", (chunk: Buffer) => this.appendLog(record, chunk));
      let settled = false;
      const timeout = setTimeout(() => finish(new Error("Local App watchdog did not start in time")), 3_000);
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
        if (typed.type === "spawned" && Number.isInteger(typed.pid) && Number.isInteger(typed.pgid)) {
          finish(undefined, { pid: typed.pid as number, pgid: typed.pgid as number });
        } else if (typed.type === "error") {
          finish(new Error(typeof typed.message === "string" ? typed.message : "Local App watchdog failed"));
        }
      });
      helper.once("exit", (code, signal) => {
        finish(new Error(`Local App watchdog exited before startup (${signal ?? code ?? "unknown"})`));
        if (["starting", "running"].includes(record.status)) {
          const previousStatus = record.status;
          record.status = "failed";
          record.verified = false;
          record.error = "Local App process exited unexpectedly";
          void this.registry.recordRuntimeDescriptorIfMatch(
            record.definition.id,
            { generation: record.generation, status: previousStatus },
            { status: "failed", pid: null, pgid: null, generation: record.generation },
          ).catch(() => undefined);
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
  ): Promise<never> {
    if (record.pgid) {
      await terminateOwnedProcessGroup(record.pgid, { killGroup: this.killGroup }).catch(() => undefined);
    }
    record.helper?.stdin?.end();
    record.status = "failed";
    record.verified = false;
    record.error = error instanceof Error ? error.message : String(error);
    if (generationClaimed) {
      await this.registry.recordRuntimeDescriptorIfMatch(
        record.definition.id,
        { generation: record.generation, status: ["starting", "running"] },
        { status: "failed", pid: null, pgid: null, generation: record.generation },
      );
    } else if (this.records.get(record.definition.id) === record) {
      this.records.delete(record.definition.id);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  async start(id: string): Promise<LocalAppRuntimeView> {
    return this.withBindingOperation(id, () => this.startInternal(id));
  }

  private async startInternal(id: string): Promise<LocalAppRuntimeView> {
    if (this.platform !== "darwin") throw new Error("Local Apps are currently supported only on macOS");
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
    if (previousDescriptor && ["starting", "running", "stopping"].includes(previousDescriptor.status)) {
      this.records.delete(id);
      throw new Error("Refusing to start while previous Local App ownership is unverified");
    }
    const port = await allocateLoopbackPort();
    const record: RuntimeRecord = {
      status: "starting",
      generation: randomUUID(),
      definition,
      helper: null,
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
      return this.failStart(record, error, generationClaimed);
    }
  }

  async stop(id: string): Promise<LocalAppRuntimeView> {
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
      await terminateOwnedProcessGroup(record.pgid, { killGroup: this.killGroup });
    } catch (error) {
      record.status = "orphaned_unverified";
      record.verified = false;
      record.error = "Local App process-group termination could not be verified";
      throw error;
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

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.bindingOperations.values()]);
    const ids = [...this.records.entries()]
      .filter(([, record]) => record.status === "running" && record.verified)
      .map(([id]) => id);
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }
}
