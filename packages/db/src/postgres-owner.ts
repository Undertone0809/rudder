import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "rudder.postgres-owner.v1";
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_OWNER_ERROR_MESSAGE_BYTES = 12 * 1024;
const STARTUP_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 45_000;

export type PostgresOwnerReady = {
  schema: typeof SCHEMA;
  op: "ready";
  instance_id: string;
  lease_id: string;
  data_dir: string;
  port: number;
  postgres_version: string;
  connection_string: string;
  bin_dir: string;
  cluster_created: boolean;
  database_created: boolean;
  owned: boolean;
};

export type PostgresOwnerOptions = {
  instanceId: string;
  dataDir: string;
  port: number;
  signal?: AbortSignal;
  binaryPath?: string;
  binDir?: string;
  onUnexpectedExit?: (error: Error) => void;
};

function targetName(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  const platform = { darwin: "apple-darwin", linux: "unknown-linux-gnu", win32: "pc-windows-msvc" }[process.platform as "darwin"];
  if (!arch || !platform) throw new Error("Unsupported PostgreSQL owner platform");
  return `${arch}-${platform}`;
}

export function resolvePostgresOwnerBinary(): string {
  const configured = process.env.RUDDER_POSTGRES_OWNER_PATH?.trim();
  if (configured) return path.resolve(configured);
  const target = targetName();
  const name = `rudder-postgres-owner${process.platform === "win32" ? ".exe" : ""}`;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources && existsSync(path.join(resources, "native", target, name))) {
    return path.join(resources, "native", target, name);
  }
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    for (const relative of [
      path.join("resources", "native", target, name),
      path.join("server", "resources", "native", target, name),
      path.join("native", "target", "debug", name),
    ]) {
      const candidate = path.join(directory, relative);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Required Rust PostgreSQL owner is missing; reinstall the runtime assets");
}

/** Resolve supplied assets only. Rust validates and owns all use of PostgreSQL. */
export function resolvePostgresRuntimeDirectory(): string {
  const configured = process.env.RUDDER_POSTGRES_BIN_DIR?.trim();
  if (configured) return path.resolve(configured);
  const require = createRequire(import.meta.url);
  const providerRequire = createRequire(require.resolve("embedded-postgres"));
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const entry = providerRequire.resolve(`@embedded-postgres/${platform}-${process.arch}`);
  return path.resolve(path.dirname(entry), "..", "native", "bin");
}

function isReady(value: Record<string, unknown>): value is PostgresOwnerReady {
  return value.schema === SCHEMA && value.op === "ready"
    && typeof value.instance_id === "string" && value.instance_id.length > 0
    && typeof value.lease_id === "string" && value.lease_id.length > 0
    && typeof value.data_dir === "string" && typeof value.bin_dir === "string"
    && typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
    && typeof value.postgres_version === "string" && typeof value.connection_string === "string"
    && typeof value.cluster_created === "boolean" && typeof value.database_created === "boolean"
    && typeof value.owned === "boolean";
}

export async function startPostgresOwner(options: PostgresOwnerOptions): Promise<PostgresOwnerReady & { stop(): Promise<void> }> {
  options.signal?.throwIfAborted();
  const binaryPath = options.binaryPath ?? resolvePostgresOwnerBinary();
  const binDir = options.binDir ?? resolvePostgresRuntimeDirectory();
  const child = spawn(binaryPath, [], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let ready: PostgresOwnerReady | undefined;
  let cleanupRequested = false;
  let stopped = false;
  let startupAbandoned = false;
  let startupCancellationAcknowledged = false;
  let unexpectedReported = false;
  let readinessResolved = false;
  let signalCleanupConfirmed = false;
  let transportFailure: Error | undefined;
  let stopPromise: Promise<void> | undefined;
  let buffer = "";
  let rejectReady!: (error: Error) => void;
  let resolveReady!: (value: PostgresOwnerReady) => void;
  const readiness = new Promise<PostgresOwnerReady>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void aborted.catch(() => {});
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // The stop path observes the same rejection; prevent an unhandled rejection before stop.
  void closed.catch(() => {});

  function reportUnexpected(error: Error) {
    if (unexpectedReported) return;
    unexpectedReported = true;
    try { options.onUnexpectedExit?.(error); } catch { /* Keep child event handling fail-closed. */ }
  }

  function requestCleanupEof() {
    if (cleanupRequested) return;
    cleanupRequested = true;
    try { child.stdin.end(); } catch (error) {
      transportFailure ??= error instanceof Error ? error : new Error("PostgreSQL owner control pipe failed");
    }
  }

  const fail = (error: Error) => {
    transportFailure ??= error;
    rejectReady(transportFailure);
    if (!ready) startupAbandoned = true;
    else if (!cleanupRequested) reportUnexpected(transportFailure);
    requestCleanupEof();
  };

  function waitForClosed(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Rust PostgreSQL owner cleanup confirmation timed out")), CLEANUP_TIMEOUT_MS);
      closed.then(
        () => { clearTimeout(timer); resolve(); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  function beginStop(): Promise<void> {
    if (!stopPromise) {
      if (!cleanupRequested) {
        if (!ready) return Promise.reject(new Error("Rust PostgreSQL owner is not ready"));
        cleanupRequested = true;
        child.stdin.end(`${JSON.stringify({ schema: SCHEMA, op: "stop", lease_id: ready.lease_id })}\n`);
      }
      stopPromise = waitForClosed().then(() => {
        if (transportFailure) throw transportFailure;
      }).catch((cleanupError: unknown) => {
        const error = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
        if (transportFailure && transportFailure !== error) {
          throw new AggregateError([transportFailure, error], `${transportFailure.message}; cleanup failed: ${error.message}`, { cause: transportFailure });
        }
        throw error;
      });
    }
    return stopPromise;
  }

  child.once("error", (error) => {
    fail(error);
    rejectClosed(error);
  });
  child.once("close", (code) => {
    options.signal?.removeEventListener("abort", abort);
    if ((code === 0 && stopped && cleanupRequested)
      || (code === 1 && startupAbandoned && startupCancellationAcknowledged)) resolveClosed();
    else {
      const error = new Error(`Rust PostgreSQL owner exited without confirmed cleanup (exit ${code})`);
      if (!transportFailure) transportFailure = error;
      rejectReady(transportFailure);
      if (ready && !cleanupRequested) reportUnexpected(transportFailure);
      rejectClosed(error);
    }
  });
  child.stderr.resume(); // Never forward credential-bearing subprocess diagnostics into Node logs.
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return fail(new Error("PostgreSQL owner response exceeds protocol limit"));
    let readyFrameReceived = false;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const frame = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const value: Record<string, unknown> = JSON.parse(frame);
        const readyCandidate = isReady(value) ? value : undefined;
        if (!value || value.schema !== SCHEMA) throw new Error("schema");
        if (!ready && readyCandidate && readyCandidate.instance_id === options.instanceId) {
          ready = readyCandidate;
          readyFrameReceived = true;
        }
        else if (value.op === "stopped" && ready && cleanupRequested && !stopped && value.lease_id === ready.lease_id) stopped = true;
        else if (value.op === "signal_stopped" && ready && !cleanupRequested && !stopped
          && value.signal === "SIGTERM"
          && value.instance_id === ready.instance_id
          && value.lease_id === ready.lease_id
          && value.data_dir === ready.data_dir
          && value.port === ready.port
          && Number.isInteger(value.owner_pid)
          && value.owner_pid === child.pid) {
          signalCleanupConfirmed = true;
          cleanupRequested = true;
          stopped = true;
          const error = new Error("Rust PostgreSQL owner received SIGTERM and confirmed session cleanup");
          reportUnexpected(error);
          if (readyFrameReceived && !readinessResolved) {
            startupAbandoned = true;
            rejectReady(error);
          }
        }
        else if (value.op === "error") {
          if (startupAbandoned && value.code === "protocol_start_cancelled") startupCancellationAcknowledged = true;
          const code = typeof value.code === "string" ? value.code.replace(/[^a-z0-9_]/gi, "").slice(0, 80) : "unknown";
          const message = typeof value.message === "string"
            && Buffer.byteLength(value.message) <= MAX_OWNER_ERROR_MESSAGE_BYTES
            && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value.message)
            ? `: ${value.message}`
            : "";
          fail(new Error(`Rust PostgreSQL owner rejected operation (${code})${message}`));
          return;
        }
        else throw new Error("unexpected frame");
      } catch { fail(new Error("Invalid PostgreSQL owner response")); return; }
    }
    // Resolve only after validating every complete frame in this chunk, so a ready
    // frame followed immediately by an unsolicited stopped frame fails startup.
    if (readyFrameReceived && !transportFailure && !startupAbandoned && !signalCleanupConfirmed) {
      readinessResolved = true;
      resolveReady(ready!);
    }
  });
  child.stdin.on("error", () => fail(new Error("PostgreSQL owner control pipe closed")));
  function abort() {
    const reason = options.signal?.reason;
    const error = reason instanceof Error ? reason : new Error("Rust PostgreSQL owner startup aborted", { cause: reason });
    if (!ready) {
      startupAbandoned = true;
      fail(error);
      rejectAbort(error);
      return;
    }
    void beginStop().catch((stopError: unknown) => reportUnexpected(stopError instanceof Error ? stopError : error));
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    child.stdin.write(`${JSON.stringify({ schema: SCHEMA, op: "start", instance_id: options.instanceId,
      data_dir: path.resolve(options.dataDir), port: options.port, bin_dir: binDir,
      database: "rudder", user: "rudder", password: "rudder", fallback_passwords: ["password"], parent_pid: process.pid })}\n`);
  } catch (error) { fail(error instanceof Error ? error : new Error("PostgreSQL owner start request failed")); }
  const timer = setTimeout(() => { fail(new Error("Rust PostgreSQL owner startup timed out")); }, STARTUP_TIMEOUT_MS);
  try {
    const result = await Promise.race([readiness, aborted]);
    options.signal?.throwIfAborted();
    return { ...result, stop: beginStop };
  } catch (error) {
    const original = error instanceof Error ? error : new Error(String(error));
    requestCleanupEof();
    if (child.pid !== undefined) {
      try { await waitForClosed(); }
      catch (cleanupError: unknown) {
        const cleanup = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
        if (cleanup !== original) throw new AggregateError([original, cleanup], `${original.message}; cleanup failed: ${cleanup.message}`, { cause: original });
      }
    }
    throw original;
  } finally { clearTimeout(timer); }
}
