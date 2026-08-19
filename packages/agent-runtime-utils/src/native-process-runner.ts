import {
  createRudderNativeDiagnostic,
  resolveRudderNativeCapability,
  resolveRudderNativeTarget,
  type RudderNativeDiagnostic,
} from "@rudderhq/shared";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendWithCap,
  runningProcesses,
  type ChildProcessWithEvents,
  type RunProcessResult,
} from "./server-utils.process.js";

const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
const MAX_LIFECYCLE_FRAME_BYTES = 64 * 1024;
const MAX_OUTPUT_QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_QUEUE_ITEMS = 1_024;
const HANDSHAKE_TIMEOUT_MS = 5_000;

type NativeHostSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface NativeProcessRunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onLogError: (err: unknown, runId: string, message: string) => void;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  stdin?: string;
  abortSignal?: AbortSignal;
  binaryPath?: string | null;
  runtimeRoot?: string;
  spawnHost?: NativeHostSpawn;
}

export class NativeProcessUnavailableError extends Error {
  readonly fallbackCode: string;
  readonly accepted: boolean;
  readonly diagnostic: RudderNativeDiagnostic;

  constructor(message: string, fallbackCode: string, accepted = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeProcessUnavailableError";
    this.fallbackCode = fallbackCode;
    this.accepted = accepted;
    this.diagnostic = createRudderNativeDiagnostic({
      capability: "agent-run-process",
      effectiveEngine: accepted ? "rust" : "node",
      fallbackCode,
      protocolVersion: `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`,
    });
  }
}

export function nativeAgentRunPolicy(env: NodeJS.ProcessEnv = process.env) {
  return resolveRudderNativeCapability({
    capability: "agent-run-process",
    env,
    legacyToggleEnvs: ["RUDDER_NATIVE_PROCESS_HOST", "RUDDER_NATIVE_AGENT_RUN_PROCESS"],
  });
}

export async function runNativeChildProcessOrFallback(
  runId: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: Omit<NativeProcessRunOptions, "env">,
): Promise<RunProcessResult | null> {
  const policy = nativeAgentRunPolicy();
  if (!policy.enabled) return null;
  try {
    return await runNativeChildProcess(runId, command, args, {
      ...opts,
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    });
  } catch (error) {
    const nativeError = error instanceof NativeProcessUnavailableError ? error : null;
    if (policy.required || nativeError?.accepted !== false) throw error;
    opts.onLogError(
      error,
      runId,
      `Rust agent-run process host unavailable before acceptance; using Node (${nativeError.fallbackCode})`,
    );
    return null;
  }
}

function nativeTarget(): string | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  return null;
}

export function resolveNativeProcessHostPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.RUDDER_NATIVE_PROCESS_HOST_PATH?.trim();
  if (configured) return path.resolve(configured);
  const target = nativeTarget();
  if (!target) return null;
  const binary = process.platform === "win32" ? "rudder-process-host.exe" : "rudder-process-host";
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "native", target, binary);
    if (existsSync(packaged)) return packaged;
  }

  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(current, "native", "target", "debug", binary);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function defaultRuntimeRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.RUDDER_NATIVE_PROCESS_RUNTIME_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const base = env.RUDDER_HOME?.trim()
    ? path.resolve(env.RUDDER_HOME)
    : path.join(os.tmpdir(), `rudder-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
  return path.join(base, "native", "process-runs");
}

function ownerToken(runId: string): string {
  return createHash("sha256").update(`${runId}\0${randomUUID()}`).digest("hex");
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function proveCleanupAfterHostLoss(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolveCleanup) => {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolveCleanup());
      killer.once("close", () => resolveCleanup());
    });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { /* Already gone. */ }
    const termDeadline = Date.now() + 500;
    while (processGroupAlive(pid) && Date.now() < termDeadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    if (processGroupAlive(pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
  const deadline = Date.now() + 2_000;
  while (processGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  if (processGroupAlive(pid)) throw new Error(`Native-owned process tree ${pid} survived host loss`);
}

function asFrame(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compatibleProtocol(value: unknown): boolean {
  const version = asFrame(value);
  return version?.major === PROTOCOL_VERSION.major
    && typeof version.minor === "number"
    && version.minor <= PROTOCOL_VERSION.minor;
}

function protocolVersion(value: unknown): { major: number; minor: number } | null {
  const version = asFrame(value);
  return version
    && typeof version.major === "number"
    && typeof version.minor === "number"
    ? { major: version.major, minor: version.minor }
    : null;
}

function nativeChildProxy(
  pid: number,
  sendStop: () => void,
  host: ChildProcess,
): ChildProcessWithEvents {
  const proxy = new EventEmitter() as ChildProcessWithEvents & { terminateTree?: (force: boolean) => void };
  Object.defineProperties(proxy, {
    pid: { enumerable: true, value: pid },
    exitCode: { enumerable: true, get: () => host.exitCode },
    signalCode: { enumerable: true, get: () => host.signalCode },
  });
  proxy.kill = (() => {
    sendStop();
    return true;
  }) as ChildProcessWithEvents["kill"];
  proxy.terminateTree = () => sendStop();
  return proxy;
}

export async function runNativeChildProcess(
  runId: string,
  executable: string,
  args: string[],
  opts: NativeProcessRunOptions,
): Promise<RunProcessResult> {
  const configuredBinaryPath = opts.binaryPath === undefined
    ? resolveNativeProcessHostPath()
    : opts.binaryPath;
  const binaryPath = configuredBinaryPath && path.resolve(configuredBinaryPath);
  if (!binaryPath) {
    throw new NativeProcessUnavailableError(
      "Rust process host binary is unavailable for this platform",
      nativeTarget() ? "binary_unavailable" : "target_unsupported",
    );
  }
  const runtimeRoot = path.resolve(opts.runtimeRoot ?? defaultRuntimeRoot(process.env));
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 }).catch((error) => {
    throw new NativeProcessUnavailableError(
      "Rust process host receipt root is unavailable",
      "runtime_root_unavailable",
      false,
      { cause: error },
    );
  });

  return await new Promise<RunProcessResult>((resolve, reject) => {
    const spawnHost = opts.spawnHost ?? ((command, argv, options) => spawn(command, argv, options));
    let host: ChildProcess;
    try {
      host = spawnHost(binaryPath, [], {
        cwd: opts.cwd,
        env: { ...process.env },
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe", "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new NativeProcessUnavailableError(
        "Rust process host could not be launched",
        "host_spawn_failed",
        false,
        { cause: error },
      ));
      return;
    }
    const stdio = host.stdio as Array<NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined>;
    const commandInput = host.stdin;
    const lifecycle = stdio[3] as NodeJS.ReadableStream | null;
    const rawStdout = stdio[4] as NodeJS.ReadableStream | null;
    const rawStderr = stdio[5] as NodeJS.ReadableStream | null;
    if (!commandInput || !lifecycle || !rawStdout || !rawStderr) {
      host.kill("SIGKILL");
      reject(new NativeProcessUnavailableError(
        "Rust process host did not expose managed channels",
        "channel_unavailable",
      ));
      return;
    }
    rawStdout.resume();
    rawStderr.resume();

    const requestId = ownerToken(runId);
    const startedAt = new Date().toISOString();
    let accepted = false;
    let nativeIdentity: Pick<RudderNativeDiagnostic, "target" | "binaryVersion" | "protocolVersion"> = {
      target: resolveRudderNativeTarget() ?? "unsupported",
      binaryVersion: "unavailable",
      protocolVersion: `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`,
    };
    let spawnedPid: number | null = null;
    let appExitCode: number | null = null;
    let appSignal: string | null = null;
    let terminalSeen = false;
    let cleanupReceiptTrusted = false;
    let timedOut = false;
    let aborted = false;
    let operatorInterrupted = false;
    let stopSent = false;
    let rawOutputTransport: boolean | null = null;
    let rawStdoutEnded = false;
    let rawStderrEnded = false;
    let rawOutputWaiters: Array<() => void> = [];
    let settled = false;
    let stdout = "";
    let stderr = "";
    let logDeliveryActive = false;
    let logDeliveryWaiters: Array<() => void> = [];
    let frameParts: Buffer[] = [];
    let frameBytes = 0;
    const pendingOutput: Array<{ stream: "stdout" | "stderr"; data: string }> = [];
    const pendingRawOutput: Array<{ stream: "stdout" | "stderr"; data: string }> = [];
    let pendingRawOutputBytes = 0;
    const outputQueue: Array<{ stream: "stdout" | "stderr"; data: string }> = [];
    let queuedOutputBytes = 0;
    let fatalError: Error | null = null;

    const rejectImmediately = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimeout);
      if (timeout) clearTimeout(timeout);
      abortCleanup?.();
      reject(error);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      if (error instanceof NativeProcessUnavailableError) Object.assign(error.diagnostic, nativeIdentity);
      if (accepted) {
        fatalError ??= error;
        sendStop(Math.max(1, opts.graceSec) * 1_000);
        return;
      }
      host.kill("SIGKILL");
      rejectImmediately(error);
    };
    const waitForLogDelivery = () => {
      if (!logDeliveryActive && outputQueue.length === 0) return Promise.resolve();
      return new Promise<void>((resolveDelivery) => logDeliveryWaiters.push(resolveDelivery));
    };
    const waitForRawOutput = () => {
      if (rawOutputTransport !== true || (rawStdoutEnded && rawStderrEnded)) return Promise.resolve();
      return new Promise<void>((resolveDelivery) => rawOutputWaiters.push(resolveDelivery));
    };
    const markRawOutputEnded = (stream: "stdout" | "stderr") => {
      if (stream === "stdout") rawStdoutEnded = true;
      else rawStderrEnded = true;
      if (rawStdoutEnded && rawStderrEnded) {
        for (const resolveDelivery of rawOutputWaiters.splice(0)) resolveDelivery();
      }
    };
    const finish = () => {
      if (settled || !terminalSeen) return;
      settled = true;
      clearTimeout(handshakeTimeout);
      if (timeout) clearTimeout(timeout);
      abortCleanup?.();
      void Promise.all([waitForLogDelivery(), waitForRawOutput()]).finally(() => {
        if (fatalError) reject(fatalError);
        else resolve({
          exitCode: appExitCode,
          signal: aborted || timedOut ? "SIGTERM" : appSignal,
          timedOut,
          stdout,
          stderr,
          pid: spawnedPid,
          startedAt,
          diagnostic: createRudderNativeDiagnostic({
            capability: "agent-run-process",
            target: nativeIdentity.target,
            binaryVersion: nativeIdentity.binaryVersion,
            protocolVersion: nativeIdentity.protocolVersion,
            effectiveEngine: "rust",
            fallbackCode: null,
          }),
        });
      });
    };
    const drainOutput = async () => {
      if (logDeliveryActive) return;
      logDeliveryActive = true;
      while (outputQueue.length > 0) {
        const output = outputQueue.shift()!;
        queuedOutputBytes -= Buffer.byteLength(output.data);
        if (!operatorInterrupted) {
          try {
            await opts.onLog(output.stream, output.data);
          } catch (error) {
            opts.onLogError(error, runId, `failed to append native ${output.stream} log chunk`);
          }
        }
      }
      logDeliveryActive = false;
      for (const resolveDelivery of logDeliveryWaiters.splice(0)) resolveDelivery();
    };
    const queueOutput = (output: { stream: "stdout" | "stderr"; data: string }) => {
      const outputBytes = Buffer.byteLength(output.data);
      const queuedItems = pendingOutput.length + outputQueue.length;
      if (queuedItems >= MAX_OUTPUT_QUEUE_ITEMS || queuedOutputBytes + outputBytes > MAX_OUTPUT_QUEUE_BYTES) {
        settleReject(new NativeProcessUnavailableError(
          "Rust process host output spool exceeded its bounded capacity",
          "output_spool_overflow",
          accepted,
        ));
        return;
      }
      queuedOutputBytes += outputBytes;
      if (accepted) {
        outputQueue.push(output);
        void drainOutput();
      } else {
        pendingOutput.push(output);
      }
    };
    const appendOutput = (stream: "stdout" | "stderr", data: string) => {
      if (stream === "stdout") stdout = appendWithCap(stdout, data);
      else stderr = appendWithCap(stderr, data);
      if (operatorInterrupted) return;
      queueOutput({ stream, data });
    };
    // Agent Run output is byte-relayed on the host's dedicated fd 4/5
    // channels. Keep accepting lifecycle output frames for older hosts, but
    // consume the dedicated channels so large writes cannot fill lifecycle.
    const handleRawOutput = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const data = String(chunk);
      if (rawOutputTransport === true) {
        appendOutput(stream, data);
        return;
      }
      if (rawOutputTransport === false) return;
      const outputBytes = Buffer.byteLength(data);
      if (pendingRawOutput.length >= MAX_OUTPUT_QUEUE_ITEMS
        || pendingRawOutputBytes + outputBytes > MAX_OUTPUT_QUEUE_BYTES) {
        settleReject(new NativeProcessUnavailableError(
          "Rust process host pre-negotiation output spool exceeded its bounded capacity",
          "output_spool_overflow",
          accepted,
        ));
        return;
      }
      pendingRawOutput.push({ stream, data });
      pendingRawOutputBytes += outputBytes;
    };
    rawStdout.on("data", (chunk: Buffer | string) => handleRawOutput("stdout", chunk));
    rawStderr.on("data", (chunk: Buffer | string) => handleRawOutput("stderr", chunk));
    rawStdout.once("end", () => markRawOutputEnded("stdout"));
    rawStderr.once("end", () => markRawOutputEnded("stderr"));
    rawStdout.once("close", () => markRawOutputEnded("stdout"));
    rawStderr.once("close", () => markRawOutputEnded("stderr"));
    const send = (message: Record<string, unknown>) => {
      if (commandInput.destroyed || commandInput.writableEnded) return false;
      return commandInput.write(`${JSON.stringify(message)}\n`);
    };
    const sendStop = (graceMs?: number) => {
      if (stopSent || !accepted) return;
      stopSent = true;
      send({
        type: "stop",
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        ...(graceMs === undefined ? {} : { graceMs: Math.max(1, Math.min(60_000, Math.floor(graceMs))) }),
      });
    };

    const handshakeTimeout = setTimeout(() => {
      host.kill("SIGKILL");
      settleReject(new NativeProcessUnavailableError(
        "Rust process host handshake timed out",
        "handshake_timeout",
        accepted,
      ));
    }, HANDSHAKE_TIMEOUT_MS);
    let timeout: NodeJS.Timeout | null = null;
    let abortCleanup: (() => void) | null = null;

    const handleFrame = (frame: Record<string, unknown>) => {
      const type = frame.type;
      if (type === "handshake") {
        const version = protocolVersion(frame.protocolVersion);
        if (accepted || !version || !compatibleProtocol(version)) {
          settleReject(new NativeProcessUnavailableError(
            "Rust process host handshake is incompatible",
            "protocol_mismatch",
            accepted,
          ));
          return;
        }
        const capabilities = frame.capabilities;
        nativeIdentity = {
          target: typeof frame.target === "string" ? frame.target : nativeIdentity.target,
          binaryVersion: typeof frame.binaryVersion === "string" ? frame.binaryVersion : nativeIdentity.binaryVersion,
          protocolVersion: `${version.major}.${version.minor}`,
        };
        if (!Array.isArray(capabilities)
          || !["process_spawn", "process_group_cleanup", "parent_eof_cleanup", "owner_receipt", "stdout_relay", "stderr_relay"]
            .every((capability) => capabilities.includes(capability))) {
          settleReject(new NativeProcessUnavailableError(
            "Rust process host capabilities are incomplete",
            "capability_mismatch",
          ));
          return;
        }
        clearTimeout(handshakeTimeout);
        send({
          type: "startProcess",
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          executable,
          argv: args,
          cwd: opts.cwd,
          env: opts.env,
          ownerToken: requestId,
          runtimeRoot,
          ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
          graceMs: Math.max(1, Math.min(60_000, Math.floor(opts.graceSec * 1_000))),
        });
        return;
      }
      if (type !== "handshake"
        && (!compatibleProtocol(frame.protocolVersion)
          || frame.requestId !== requestId
          || (accepted ? frame.ownerToken !== requestId : frame.ownerToken !== undefined && frame.ownerToken !== requestId))) {
        settleReject(new NativeProcessUnavailableError(
          "Rust process host lifecycle identity is invalid",
          "lifecycle_identity_invalid",
          accepted,
        ));
        return;
      }
      if (type === "output") {
        if ((frame.stream !== "stdout" && frame.stream !== "stderr") || typeof frame.data !== "string") {
          settleReject(new NativeProcessUnavailableError(
            "Rust process host emitted invalid output",
            "output_invalid",
            accepted,
          ));
          return;
        }
        const output: { stream: "stdout" | "stderr"; data: string } = {
          stream: frame.stream,
          data: frame.data,
        };
        appendOutput(output.stream, output.data);
        return;
      }
      if (type === "accepted") {
        if (accepted) {
          settleReject(new NativeProcessUnavailableError("Rust process host accepted twice", "accepted_twice", true));
          return;
        }
        accepted = true;
        rawOutputTransport = frame.outputTransport === "raw";
        if (rawOutputTransport) {
          for (const output of pendingRawOutput.splice(0)) appendOutput(output.stream, output.data);
        }
        pendingRawOutputBytes = 0;
        outputQueue.push(...pendingOutput.splice(0));
        void drainOutput();
        return;
      }
      if (type === "spawned") {
        if (!accepted || typeof frame.pid !== "number" || frame.pid < 2 || spawnedPid !== null) {
          settleReject(new NativeProcessUnavailableError("Rust process host spawn frame is invalid", "spawn_frame_invalid", accepted));
          return;
        }
        spawnedPid = frame.pid;
        const proxy = nativeChildProxy(frame.pid, sendStop, host);
        if (!settled) runningProcesses.set(runId, { child: proxy, graceSec: opts.graceSec });
        if (opts.onSpawn) {
          void opts.onSpawn({ pid: frame.pid, startedAt }).catch((error) => {
            opts.onLogError(error, runId, "failed to record native child process metadata");
          });
        }
        return;
      }
      if (type === "app-exit") {
        appExitCode = typeof frame.code === "number" ? frame.code : null;
        appSignal = typeof frame.signal === "string" ? frame.signal : null;
        return;
      }
      if (type === "terminal") {
        if (!accepted) {
          settleReject(new NativeProcessUnavailableError(
            typeof frame.errorCode === "string" ? `Rust process host rejected launch: ${frame.errorCode}` : "Rust process host rejected launch",
            typeof frame.errorCode === "string" ? frame.errorCode : "launch_rejected",
          ));
          return;
        }
        if (frame.cleanupProven !== true || frame.receiptWritten !== true) {
          fatalError ??= new NativeProcessUnavailableError(
            "Rust process host could not prove process-tree cleanup and receipt durability",
            typeof frame.errorCode === "string" ? frame.errorCode : "cleanup_unproven",
            true,
          );
          terminalSeen = true;
          return;
        }
        cleanupReceiptTrusted = true;
        terminalSeen = true;
        return;
      }
      if (type === "error" || type === "stop-accepted" || type === "stopped" || type === "listener-verified") return;
      settleReject(new NativeProcessUnavailableError(
        "Rust process host emitted an unknown lifecycle frame",
        "unknown_frame",
        accepted,
      ));
    };

    lifecycle.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0x0a) continue;
        const segment = bytes.subarray(start, index);
        start = index + 1;
        if (frameBytes + segment.length > MAX_LIFECYCLE_FRAME_BYTES) {
          settleReject(new NativeProcessUnavailableError("Rust process host lifecycle frame exceeded its bound", "frame_too_large", accepted));
          return;
        }
        frameParts.push(Buffer.from(segment));
        frameBytes += segment.length;
        const frame = Buffer.concat(frameParts, frameBytes).toString("utf8").replace(/\r$/u, "");
        frameParts = [];
        frameBytes = 0;
        if (!frame.trim()) continue;
        try {
          const parsed = asFrame(JSON.parse(frame));
          if (!parsed) throw new Error("not an object");
          handleFrame(parsed);
        } catch (error) {
          settleReject(new NativeProcessUnavailableError("Rust process host emitted invalid lifecycle JSON", "invalid_json", accepted, { cause: error }));
        }
      }
      const remainder = bytes.subarray(start);
      if (remainder.length > 0) {
        frameParts.push(Buffer.from(remainder));
        frameBytes += remainder.length;
      }
    });
    host.stderr?.on("data", (chunk) => {
      stderr = appendWithCap(stderr, String(chunk));
    });
    host.once("error", (error) => {
      settleReject(new NativeProcessUnavailableError(
        "Rust process host failed",
        "host_error",
        accepted,
        { cause: error },
      ));
    });
    host.once("close", (code, signal) => {
      runningProcesses.delete(runId);
      if (terminalSeen && cleanupReceiptTrusted) {
        finish();
        return;
      }
      const controlError = fatalError ?? new NativeProcessUnavailableError(
        `Rust process host exited before a terminal receipt (${signal ?? code ?? "unknown"})`,
        accepted ? "control_lost" : "host_exit_before_accept",
        accepted,
      );
      if (!accepted) {
        rejectImmediately(controlError);
        return;
      }
      void (async () => {
        let ownedPid = spawnedPid;
        if (ownedPid === null) {
          try {
            const descriptor = JSON.parse(
              await readFile(path.join(runtimeRoot, requestId, "owner-descriptor.json"), "utf8"),
            ) as { childPid?: unknown };
            if (typeof descriptor.childPid === "number") ownedPid = descriptor.childPid;
          } catch {
            // The host may have died before persisting ownership.
          }
        }
        if (ownedPid !== null) await proveCleanupAfterHostLoss(ownedPid);
      })().then(
        () => rejectImmediately(controlError),
        (cleanupError) => rejectImmediately(new NativeProcessUnavailableError(
          "Rust process host was lost and emergency process-tree cleanup was not proven",
          "control_lost_cleanup_unproven",
          true,
          { cause: cleanupError },
        )),
      );
    });

    if (opts.timeoutSec > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        sendStop(Math.max(1, opts.graceSec) * 1_000);
      }, opts.timeoutSec * 1_000);
    }
    if (opts.abortSignal) {
      const onAbort = () => {
        aborted = true;
        const reason = opts.abortSignal?.reason;
        operatorInterrupted = Boolean(reason
          && typeof reason === "object"
          && (reason as { kind?: unknown }).kind === "operator_interrupt");
        const operatorDeadline = operatorInterrupted
          && typeof reason === "object"
          && reason !== null
          && typeof (reason as { hardDeadlineMs?: unknown }).hardDeadlineMs === "number"
          ? (reason as { hardDeadlineMs: number }).hardDeadlineMs
          : null;
        sendStop(operatorDeadline ?? Math.max(1, opts.graceSec) * 1_000);
      };
      if (opts.abortSignal.aborted) onAbort();
      else {
        opts.abortSignal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => opts.abortSignal?.removeEventListener("abort", onAbort);
      }
    }
  });
}
