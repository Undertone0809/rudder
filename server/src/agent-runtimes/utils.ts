// Re-export everything from the shared adapter-utils/server-utils package.
// This file is kept as a convenience shim so existing in-tree
// imports (process/, http/, heartbeat.ts) don't need rewriting.
import { logger } from "../middleware/logger.js";
export {
  appendWithCap, asBoolean, asNumber, asString, asStringArray, buildRudderEnv,
  defaultPathForPlatform, ensureAbsoluteDirectory,
  ensureCommandResolvable, ensurePathInEnv, killChildProcessTree, MAX_CAPTURE_BYTES, MAX_EXCERPT_BYTES, parseJson, parseObject, redactEnvForLogs, renderTemplate, resolvePathValue, runningProcesses, type RunProcessResult
} from "@rudderhq/agent-runtime-utils/server-utils";

// Re-export runChildProcess with the server's pino logger wired in.
import type { RunProcessResult } from "@rudderhq/agent-runtime-utils/server-utils";
import {
  runChildProcess as _runChildProcess,
  runNativeChildProcessV2 as _runNativeChildProcessV2,
} from "@rudderhq/agent-runtime-utils/server-utils";
import type { NativeProcessAuthority } from "@rudderhq/agent-runtime-utils";

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    stdin?: string;
    abortSignal?: AbortSignal;
  },
): Promise<RunProcessResult> {
  return _runChildProcess(runId, command, args, {
    ...opts,
    onLogError: (err, id, msg) => logger.warn({ err, runId: id }, msg),
  });
}

/**
 * Explicit authority-bound process-host v2 wrapper. The authority is supplied
 * by the trusted runtime caller and is never derived from adapter config.
 */
export async function runNativeChildProcessV2(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    stdin?: string;
    abortSignal?: AbortSignal;
    authority: NativeProcessAuthority;
  },
): Promise<RunProcessResult> {
  return _runNativeChildProcessV2(runId, command, args, {
    ...opts,
    onLogError: (err, id, msg) => logger.warn({ err, runId: id }, msg),
  });
}
