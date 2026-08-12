import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

export type NativeProcessHost = EventEmitter & {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number | undefined;
  readonly connected: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
};

type NativeProcessHostOptions = Pick<SpawnOptions, "env" | "cwd">;

const nativeTarget = process.platform === "darwin" && process.arch === "arm64"
  ? "aarch64-apple-darwin"
  : process.platform === "darwin" && process.arch === "x64"
    ? "x86_64-apple-darwin"
    : process.platform === "win32" && process.arch === "x64"
      ? "x86_64-pc-windows-msvc"
      : process.platform === "linux" && process.arch === "x64"
        ? "x86_64-unknown-linux-gnu"
        : null;
const nativeBinaryName = process.platform === "win32" ? "rudder-process-host.exe" : "rudder-process-host";
const MAX_LIFECYCLE_FRAME_BYTES = 64 * 1024;
export const nativeProcessHostRuntimeSupported = process.platform === "darwin" && process.arch === "arm64";

export function resolveNativeProcessHostPath(): string | null {
  if (!nativeProcessHostRuntimeSupported) return null;
  const configured = process.env.RUDDER_NATIVE_PROCESS_HOST_PATH?.trim();
  if (configured) return configured;
  if (!process.resourcesPath || !nativeTarget) return null;
  return path.join(process.resourcesPath, "native", nativeTarget, nativeBinaryName);
}

export function spawnNativeProcessHost(
  executablePath: string,
  options: NativeProcessHostOptions = {},
): NativeProcessHost {
  const child = spawn(executablePath, [], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: false,
    windowsHide: true,
    // fd 1 remains empty in managed mode. fd 3 is lifecycle JSONL; fd 4 and
    // fd 5 are byte-exact child stdout/stderr relays owned by the host.
    stdio: ["pipe", "ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  const stdio = child.stdio as Array<Readable | Writable | null | undefined>;
  const commandInput = child.stdin;
  const lifecycle = stdio[3] as Readable | null;
  const stdout = stdio[4] as Readable | null;
  const stderr = stdio[5] as Readable | null;
  if (!commandInput || !lifecycle || !stdout || !stderr) {
    child.kill("SIGKILL");
    throw new Error("Rust process host did not expose its inherited channels");
  }

  const client = new EventEmitter() as NativeProcessHost;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let lifecycleFrameParts: Buffer[] = [];
  let lifecycleFrameBytes = 0;
  let lifecycleErrorEmitted = false;

  const emitLifecycleError = (message: string) => {
    if (lifecycleErrorEmitted) return;
    lifecycleErrorEmitted = true;
    client.emit("error", new Error(message));
  };

  Object.defineProperties(client, {
    stdin: { enumerable: true, value: commandInput },
    stdout: { enumerable: true, value: stdout },
    stderr: { enumerable: true, value: stderr },
    pid: { enumerable: true, get: () => child.pid },
    connected: { enumerable: true, get: () => !commandInput.destroyed },
    exitCode: { enumerable: true, get: () => exitCode },
    signalCode: { enumerable: true, get: () => signalCode },
  });

  client.send = (message, callback) => {
    if (commandInput.destroyed || commandInput.writableEnded) {
      const error = new Error("Rust process host command channel is closed");
      callback?.(error);
      return false;
    }
    try {
      return commandInput.write(`${JSON.stringify(message)}\n`, (error?: Error | null) => callback?.(error ?? null));
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  };
  client.kill = (signal) => child.kill(signal);

  lifecycle.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let segmentStart = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (index < bytes.length && bytes[index] !== 0x0a) continue;
      const segment = bytes.subarray(segmentStart, index);
      segmentStart = index + 1;
      if (lifecycleFrameBytes + segment.length > MAX_LIFECYCLE_FRAME_BYTES) {
        emitLifecycleError("Rust process host lifecycle frame exceeded the byte limit");
        lifecycle.destroy();
        return;
      }
      if (segment.length > 0) {
        lifecycleFrameParts.push(Buffer.from(segment));
        lifecycleFrameBytes += segment.length;
      }
      const frame = Buffer.concat(lifecycleFrameParts, lifecycleFrameBytes);
      lifecycleFrameParts = [];
      lifecycleFrameBytes = 0;
      const text = frame[frame.length - 1] === 0x0d
        ? frame.subarray(0, frame.length - 1).toString("utf8")
        : frame.toString("utf8");
      if (!text.trim()) continue;
      try {
        client.emit("message", JSON.parse(text));
      } catch {
        emitLifecycleError("Rust process host emitted invalid lifecycle JSON");
        return;
      }
    }
    const remainder = bytes.subarray(segmentStart);
    if (remainder.length > 0) {
      if (lifecycleFrameBytes + remainder.length > MAX_LIFECYCLE_FRAME_BYTES) {
        emitLifecycleError("Rust process host lifecycle frame exceeded the byte limit");
        lifecycle.destroy();
        return;
      }
      lifecycleFrameParts.push(Buffer.from(remainder));
      lifecycleFrameBytes += remainder.length;
    }
  });
  lifecycle.once("end", () => {
    if (lifecycleFrameBytes > 0) {
      emitLifecycleError("Rust process host emitted an unterminated lifecycle frame");
    }
    client.emit("disconnect");
  });
  child.once("error", (error) => client.emit("error", error));
  child.once("exit", (code, signal) => {
    exitCode = code;
    signalCode = signal;
    client.emit("exit", code, signal);
  });
  return client;
}
