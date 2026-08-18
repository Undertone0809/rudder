import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SPEECH_PROTOCOL_VERSION = 1;
export const SPEECH_MIN_SAMPLE_RATE = 8_000;
export const SPEECH_MAX_SAMPLE_RATE = 48_000;
export const SPEECH_MAX_DURATION_SECONDS = 60;
export const SPEECH_MAX_INPUT_BYTES = SPEECH_MAX_SAMPLE_RATE * SPEECH_MAX_DURATION_SECONDS * 4;
const SPEECH_MAX_RESPONSE_BYTES = 64 * 1024;
const SPEECH_MAX_TRANSCRIPT_CHARS = 16_384;
const DEFAULT_SPEECH_TIMEOUT_MS = 120_000;

export type SpeechStatusReason =
  | "disabled"
  | "unsupported_platform"
  | "native_unavailable"
  | "model_unavailable"
  | "configuration_invalid"
  | "ready";

export type DesktopSpeechStatus = {
  enabled: boolean;
  available: boolean;
  reason: SpeechStatusReason;
  maxDurationSeconds: number;
  maxBytes: number;
  minSampleRate: number;
  maxSampleRate: number;
};

export type DesktopSpeechInput = {
  requestId: string;
  pcm: ArrayBuffer;
  sampleRate: number;
  channels: 1;
  format: "f32le";
};

export type DesktopSpeechResult = {
  text: string;
  language: string | null;
};

export type SpeechErrorCode =
  | "invalid_audio"
  | "empty_audio"
  | "model_unavailable"
  | "engine_failed"
  | "cancelled";

export class SpeechRuntimeError extends Error {
  readonly code: SpeechErrorCode;

  constructor(code: SpeechErrorCode, message: string = code) {
    super(message);
    this.name = "SpeechRuntimeError";
    this.code = code;
  }
}

type SpeechResolveOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  isPackaged?: boolean;
  moduleDir?: string;
  resourcesPath?: string;
  isRegularFile?: (targetPath: string) => boolean;
};

type SpeechConfig = {
  status: DesktopSpeechStatus;
  binaryPath: string | null;
  modelPath: string | null;
};

type SpeechWorkerResponse = {
  ok?: unknown;
  text?: unknown;
  language?: unknown;
  errorCode?: unknown;
};

type SpawnProcess = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

type ActiveRequest = {
  child: ChildProcess;
  cancelled: boolean;
  timer: NodeJS.Timeout;
  settle: (error?: SpeechRuntimeError, result?: DesktopSpeechResult) => void;
};

function isSpeechFlagEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.RUDDER_EXPERIMENTAL_CHAT_VOICE_INPUT === "1";
}

function targetFor(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  return null;
}

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "rudder-speech.exe" : "rudder-speech";
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value);
}

function defaultBinaryPath(options: Required<Pick<SpeechResolveOptions, "platform" | "arch" | "moduleDir">> & {
  target: string;
  isPackaged: boolean;
  resourcesPath: string;
}): string {
  const binary = executableName(options.platform);
  if (options.isPackaged) {
    return path.join(options.resourcesPath, "native", options.target, binary);
  }
  return path.resolve(options.moduleDir, "..", ".packaged", "native", options.target, binary);
}

function defaultModelPath(options: Required<Pick<SpeechResolveOptions, "resourcesPath">> & {
  isPackaged: boolean;
  moduleDir: string;
}): string | null {
  if (options.isPackaged) {
    return path.join(options.resourcesPath, "models", "whisper", "ggml-base.bin");
  }
  const stagedPath = path.resolve(options.moduleDir, "..", ".packaged", "models", "whisper", "ggml-base.bin");
  return stagedPath;
}

function regularFile(targetPath: string, isRegularFile: (targetPath: string) => boolean): boolean {
  try {
    return isRegularFile(targetPath);
  } catch {
    return false;
  }
}

export function resolveSpeechConfig(options: SpeechResolveOptions = {}): SpeechConfig {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const isPackaged = options.isPackaged ?? false;
  const moduleDir = options.moduleDir ?? process.cwd();
  const resourcesPath = options.resourcesPath ?? process.cwd();
  const isRegularFile = options.isRegularFile ?? ((targetPath: string) => fs.statSync(targetPath).isFile());
  const baseStatus = {
    maxDurationSeconds: SPEECH_MAX_DURATION_SECONDS,
    maxBytes: SPEECH_MAX_INPUT_BYTES,
    minSampleRate: SPEECH_MIN_SAMPLE_RATE,
    maxSampleRate: SPEECH_MAX_SAMPLE_RATE,
  };

  if (!isSpeechFlagEnabled(env)) {
    return {
      status: { ...baseStatus, enabled: false, available: false, reason: "disabled" },
      binaryPath: null,
      modelPath: null,
    };
  }

  const target = targetFor(platform, arch);
  if (!target) {
    return {
      status: { ...baseStatus, enabled: true, available: false, reason: "unsupported_platform" },
      binaryPath: null,
      modelPath: null,
    };
  }

  const configuredBinaryPath = env.RUDDER_SPEECH_BINARY_PATH?.trim();
  const configuredModelPath = env.RUDDER_SPEECH_MODEL_PATH?.trim();
  if ((configuredBinaryPath && !isAbsolutePath(configuredBinaryPath))
    || (configuredModelPath && !isAbsolutePath(configuredModelPath))) {
    return {
      status: { ...baseStatus, enabled: true, available: false, reason: "configuration_invalid" },
      binaryPath: null,
      modelPath: null,
    };
  }

  const binaryPath = configuredBinaryPath
    ?? defaultBinaryPath({ target, platform, arch, isPackaged, moduleDir, resourcesPath });
  if (!regularFile(binaryPath, isRegularFile)) {
    return {
      status: { ...baseStatus, enabled: true, available: false, reason: "native_unavailable" },
      binaryPath,
      modelPath: null,
    };
  }

  const modelPath = configuredModelPath ?? defaultModelPath({ isPackaged, moduleDir, resourcesPath });
  if (!modelPath || !regularFile(modelPath, isRegularFile)) {
    return {
      status: { ...baseStatus, enabled: true, available: false, reason: "model_unavailable" },
      binaryPath,
      modelPath,
    };
  }

  return {
    status: { ...baseStatus, enabled: true, available: true, reason: "ready" },
    binaryPath,
    modelPath,
  };
}

function toBuffer(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

export function validateSpeechInput(value: unknown): {
  requestId: string;
  pcm: Buffer;
  sampleRate: number;
  channels: 1;
} {
  if (!value || typeof value !== "object") throw new SpeechRuntimeError("invalid_audio");
  const input = value as Partial<DesktopSpeechInput> & { pcm?: unknown };
  const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
  const pcm = toBuffer(input.pcm);
  const sampleRate = typeof input.sampleRate === "number" ? input.sampleRate : NaN;
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(requestId)
    || input.format !== "f32le"
    || input.channels !== 1
    || !Number.isSafeInteger(sampleRate)
    || sampleRate < SPEECH_MIN_SAMPLE_RATE
    || sampleRate > SPEECH_MAX_SAMPLE_RATE
    || !pcm
    || pcm.byteLength === 0
    || pcm.byteLength > SPEECH_MAX_INPUT_BYTES
    || pcm.byteLength % 4 !== 0
    || pcm.byteLength / 4 / sampleRate > SPEECH_MAX_DURATION_SECONDS) {
    throw new SpeechRuntimeError("invalid_audio");
  }
  return { requestId, pcm, sampleRate, channels: 1 };
}

function parseWorkerResponse(stdout: string): SpeechWorkerResponse | null {
  const line = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as SpeechWorkerResponse : null;
  } catch {
    return null;
  }
}

function errorCodeFromWorker(value: unknown): SpeechErrorCode {
  return value === "invalid_audio"
    || value === "empty_audio"
    || value === "model_unavailable"
    || value === "engine_failed"
    || value === "cancelled"
    ? value
    : "engine_failed";
}

export function createSpeechRuntime(options: SpeechResolveOptions & {
  spawnProcess?: SpawnProcess;
  timeoutMs?: number;
} = {}) {
  const activeRequests = new Map<string, ActiveRequest>();
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = Math.max(1_000, Math.min(300_000, options.timeoutMs ?? DEFAULT_SPEECH_TIMEOUT_MS));

  const cancel = (requestId: string): void => {
    const request = activeRequests.get(requestId);
    if (!request) return;
    request.cancelled = true;
    request.child.kill();
  };

  const transcribe = async (inputValue: unknown): Promise<DesktopSpeechResult> => {
    const input = validateSpeechInput(inputValue);
    if (activeRequests.has(input.requestId)) {
      throw new SpeechRuntimeError("engine_failed", "A transcription request is already active.");
    }
    const config = resolveSpeechConfig(options);
    if (!config.status.available || !config.binaryPath || !config.modelPath) {
      throw new SpeechRuntimeError(
        config.status.reason === "model_unavailable" ? "model_unavailable" : "engine_failed",
        `Speech capability is ${config.status.reason}.`,
      );
    }

    const child = spawnProcess(
      config.binaryPath,
      [
        "transcribe",
        "--model",
        config.modelPath,
        "--sample-rate",
        String(input.sampleRate),
        "--channels",
        String(input.channels),
      ],
      {
        cwd: path.dirname(config.binaryPath),
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    return await new Promise<DesktopSpeechResult>((resolve, reject) => {
      let stdout = "";
      let settled = false;
      const timer = setTimeout(() => {
        request.cancelled = true;
        child.kill();
        settle(new SpeechRuntimeError("engine_failed", "Local transcription timed out."));
      }, timeoutMs);
      const request: ActiveRequest = {
        child,
        cancelled: false,
        timer,
        settle,
      };
      activeRequests.set(input.requestId, request);

      function settle(error?: SpeechRuntimeError, result?: DesktopSpeechResult): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeRequests.delete(input.requestId);
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new SpeechRuntimeError("engine_failed"));
      }

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > SPEECH_MAX_RESPONSE_BYTES) {
          request.cancelled = true;
          child.kill();
          settle(new SpeechRuntimeError("engine_failed", "Speech worker returned an oversized response."));
        }
      });
      child.on("error", () => settle(new SpeechRuntimeError("engine_failed", "Speech worker failed to start.")));
      child.on("close", (code) => {
        if (settled) return;
        if (request.cancelled) {
          settle(new SpeechRuntimeError("cancelled", "Local transcription was cancelled."));
          return;
        }
        const response = parseWorkerResponse(stdout);
        if (!response || response.ok !== true) {
          settle(new SpeechRuntimeError(errorCodeFromWorker(response?.errorCode)));
          return;
        }
        const text = typeof response.text === "string" ? response.text.trim() : "";
        if (!text || text.length > SPEECH_MAX_TRANSCRIPT_CHARS || code !== 0) {
          settle(new SpeechRuntimeError(text ? "engine_failed" : "empty_audio"));
          return;
        }
        const language = typeof response.language === "string" && response.language.trim()
          ? response.language.trim()
          : null;
        settle(undefined, { text, language });
      });
      child.stdin?.on("error", () => settle(new SpeechRuntimeError("engine_failed", "Speech input failed.")));
      try {
        child.stdin?.end(input.pcm);
      } catch {
        settle(new SpeechRuntimeError("engine_failed", "Speech input failed."));
      }
    });
  };

  return {
    getStatus: (): DesktopSpeechStatus => resolveSpeechConfig(options).status,
    transcribe,
    cancel,
    dispose: (): void => {
      for (const requestId of activeRequests.keys()) cancel(requestId);
    },
  };
}
