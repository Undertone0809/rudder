import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { LocalAppDefinition, LocalAppRegistry } from "./local-apps-registry.js";

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
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly startPromises = new Map<string, Promise<LocalAppRuntimeView>>();

  constructor(options: RuntimeManagerOptions) {
    this.registry = options.registry;
    this.hostExecutablePath = options.hostExecutablePath ?? process.execPath;
    this.platform = options.platform ?? process.platform;
    this.maxLogBytes = Math.max(256, options.maxLogBytes ?? 64 * 1024);
    this.verifyListenerOwnership = options.verifyListenerOwnership ?? defaultVerifyListenerOwnership;
    this.killGroup = options.killGroup ?? defaultKillGroup;
    this.spawnWatchdog = options.spawnWatchdog ?? spawn;
    this.watchdogRunnerPath = options.watchdogRunnerPath ?? WATCHDOG_RUNNER_PATH;
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

  private async persistedStatus(id: string, definition: LocalAppDefinition): Promise<RuntimeRecord> {
    const descriptor = await this.registry.getRuntimeDescriptor(id);
    const persistedRunning = descriptor && ["starting", "running", "stopping"].includes(descriptor.status);
    const record: RuntimeRecord = {
      status: persistedRunning ? "orphaned_unverified" : descriptor?.status === "failed" ? "failed" : "stopped",
      generation: descriptor?.generation ?? randomUUID(),
      definition,
      helper: null,
      pid: persistedRunning ? descriptor.pid : null,
      pgid: persistedRunning ? descriptor.pgid : null,
      port: null,
      origin: null,
      verified: false,
      logText: "",
      error: persistedRunning ? "Previous Local App ownership cannot be verified after restart" : undefined,
    };
    this.records.set(id, record);
    return record;
  }

  private async getRecord(id: string): Promise<RuntimeRecord> {
    const existing = this.records.get(id);
    if (existing) return existing;
    const definition = await this.registry.getDefinition(id);
    return this.persistedStatus(id, definition);
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
          record.status = "failed";
          record.verified = false;
          record.error = "Local App process exited unexpectedly";
          void this.registry.recordRuntimeDescriptor(record.definition.id, {
            status: "failed", pid: null, pgid: null, generation: record.generation,
          }).catch(() => undefined);
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

  private async failStart(record: RuntimeRecord, error: unknown): Promise<never> {
    if (record.pgid) {
      await terminateOwnedProcessGroup(record.pgid, { killGroup: this.killGroup }).catch(() => undefined);
    }
    record.helper?.stdin?.end();
    record.status = "failed";
    record.verified = false;
    record.error = error instanceof Error ? error.message : String(error);
    await this.registry.recordRuntimeDescriptor(record.definition.id, {
      status: "failed", pid: null, pgid: null, generation: record.generation,
    });
    throw error instanceof Error ? error : new Error(String(error));
  }

  async start(id: string): Promise<LocalAppRuntimeView> {
    const inFlight = this.startPromises.get(id);
    if (inFlight) return inFlight;
    const promise = this.startInternal(id);
    this.startPromises.set(id, promise);
    try {
      return await promise;
    } finally {
      this.startPromises.delete(id);
    }
  }

  private async startInternal(id: string): Promise<LocalAppRuntimeView> {
    if (this.platform !== "darwin") throw new Error("Local Apps are currently supported only on macOS");
    const existing = await this.getRecord(id);
    if (existing.status === "running") return this.view(existing);
    if (existing.status === "orphaned_unverified") {
      throw new Error("Refusing to start while previous Local App ownership is unverified");
    }
    const definition = await this.registry.requireApprovedDefinition(id);
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
    try {
      const spawned = await this.spawnHelper(record, port);
      record.pid = spawned.pid;
      record.pgid = spawned.pgid;
      await this.registry.recordRuntimeDescriptor(id, {
        status: "starting", pid: record.pid, pgid: record.pgid, generation: record.generation, port,
      });
      await this.waitForReadiness(record);
      const owned = await this.verifyListenerOwnership({ port, pid: record.pid, pgid: record.pgid });
      if (!owned) throw new Error("Local App listener ownership could not be proven");
      record.status = "running";
      record.verified = true;
      await this.registry.recordRuntimeDescriptor(id, {
        status: "running", pid: record.pid, pgid: record.pgid, generation: record.generation, port,
      });
      return this.view(record);
    } catch (error) {
      return this.failStart(record, error);
    }
  }

  async stop(id: string): Promise<LocalAppRuntimeView> {
    const record = await this.getRecord(id);
    if (record.status === "orphaned_unverified" || !record.verified || !record.pgid) {
      if (record.status === "stopped" || record.status === "failed") return this.view(record);
      throw new Error("Refusing to stop an unverified Local App process group");
    }
    record.status = "stopping";
    await this.registry.recordRuntimeDescriptor(id, {
      status: "stopping", pid: record.pid, pgid: record.pgid, generation: record.generation,
    });
    await terminateOwnedProcessGroup(record.pgid, { killGroup: this.killGroup });
    record.helper?.stdin?.end();
    record.status = "stopped";
    record.verified = false;
    record.pid = null;
    record.pgid = null;
    record.port = null;
    record.origin = null;
    await this.registry.recordRuntimeDescriptor(id, null);
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
    const ids = [...this.records.entries()]
      .filter(([, record]) => record.status === "running" && record.verified)
      .map(([id]) => id);
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }
}
