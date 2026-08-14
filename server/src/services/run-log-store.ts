import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { notFound } from "../errors.js";
import { resolveRudderInstanceRoot } from "../home-paths.js";

const execFileAsync = promisify(execFile);

export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  endOffset: number;
  eof: boolean;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
  evidenceIndex?: RunLogEvidenceIndexSummary;
}

export interface RunLogEvidenceIndexSummary {
  protocolVersion: 1;
  status: "native" | "existing" | "fallback";
  indexRef: string;
  sourceBytes: number;
  recordCount?: number;
  sourceSha256: string;
  fallbackReason?: string;
}

export interface RunLogStore {
  begin(input: { orgId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<void>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
}

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

const NATIVE_EVIDENCE_PROTOCOL_VERSION = 1;
const NATIVE_EVIDENCE_OUTPUT_LIMIT_BYTES = 256 * 1024;
const NATIVE_EVIDENCE_TIMEOUT_MS = 30_000;
const NATIVE_EVIDENCE_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const NATIVE_EVIDENCE_MAX_RECORDS = 10_000_000;

type NativeEvidenceIndexResponse = {
  ok?: unknown;
  operation?: unknown;
  protocolVersion?: unknown;
  sourceBytes?: unknown;
  recordCount?: unknown;
  sourceSha256?: unknown;
  indexPath?: unknown;
  errorCode?: unknown;
};

function nativeTarget() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : process.arch === "x64" ? "x86_64-apple-darwin" : null;
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : process.arch === "x64" ? "x86_64-unknown-linux-gnu" : null;
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : process.arch === "x64" ? "x86_64-pc-windows-msvc" : null;
  }
  return null;
}

export function resolveNativeEvidenceIndexBinary() {
  const configured = process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH?.trim();
  if (configured) return path.resolve(configured);
  const binaryName = process.platform === "win32" ? "rudder-native.exe" : "rudder-native";
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const target = nativeTarget();
  const resourcesPath = process.env.RUDDER_DESKTOP_RESOURCES_PATH?.trim()
    || (typeof (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath === "string"
      ? (process as NodeJS.Process & { resourcesPath: string }).resourcesPath
      : "");
  const candidates = [
    path.resolve(moduleDir, "../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../native", target ?? "unsupported", binaryName),
    resourcesPath && target ? path.resolve(resourcesPath, "native", target, binaryName) : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function boundedNativeReason(value: unknown) {
  const text = String(value ?? "unknown").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 180) || "unknown";
}

async function runNativeEvidenceIndex(binary: string, inputPath: string, outputPath: string): Promise<NativeEvidenceIndexResponse> {
  let result: { stdout: string; stderr: string };
  try {
    result = await execFileAsync(binary, [
      "evidence",
      "index",
      inputPath,
      outputPath,
      String(NATIVE_EVIDENCE_MAX_RECORD_BYTES),
      String(NATIVE_EVIDENCE_MAX_RECORDS),
    ], {
      encoding: "utf8",
      timeout: NATIVE_EVIDENCE_TIMEOUT_MS,
      maxBuffer: NATIVE_EVIDENCE_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
    });
  } catch (error) {
    const details = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown; signal?: unknown };
    throw new Error(boundedNativeReason(
      details.stderr
      || (details.killed || details.signal === "SIGTERM" || details.code === "ETIMEDOUT" ? "native index timeout" : details.code ?? "native index failed"),
    ));
  }
  if (result.stderr.trim()) throw new Error(boundedNativeReason(result.stderr));
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error(`native index response line count ${lines.length}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]!);
  } catch {
    throw new Error("native index response is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("native index response envelope is invalid");
  return parsed as NativeEvidenceIndexResponse;
}

async function maybeBuildNativeEvidenceIndex(
  basePath: string,
  handle: RunLogHandle,
  sourcePath: string,
  sourceBytes: number,
  sourceSha256: string,
): Promise<RunLogEvidenceIndexSummary | undefined> {
  if (process.env.RUDDER_NATIVE_RUN_EVIDENCE_INDEX !== "1") return undefined;
  const indexRelativePath = `${handle.logRef}.index.ndjson`;
  const indexPath = resolveWithin(basePath, indexRelativePath);
  const sourceStat = await fs.stat(sourcePath);
  const existing = await fs.lstat(indexPath).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("native evidence index path is not a regular file");
    if (existing.mtimeMs >= sourceStat.mtimeMs) {
      return {
        protocolVersion: 1,
        status: "existing",
        indexRef: indexRelativePath,
        sourceBytes,
        sourceSha256,
      };
    }
    await fs.rm(indexPath, { force: true });
  }
  const response = await runNativeEvidenceIndex(resolveNativeEvidenceIndexBinary(), sourcePath, indexPath);
  if (response.ok !== true || response.operation !== "indexEvidence" || response.protocolVersion !== NATIVE_EVIDENCE_PROTOCOL_VERSION) {
    throw new Error(boundedNativeReason(response.errorCode ?? "native index envelope mismatch"));
  }
  if (response.sourceBytes !== sourceBytes || response.sourceSha256 !== sourceSha256 || response.indexPath !== indexPath) {
    throw new Error("native evidence index integrity mismatch");
  }
  if (!Number.isSafeInteger(response.recordCount) || Number(response.recordCount) < 0) {
    throw new Error("native evidence index record count is invalid");
  }
  return {
    protocolVersion: 1,
    status: "native",
    indexRef: indexRelativePath,
    sourceBytes,
    recordCount: Number(response.recordCount),
    sourceSha256,
  };
}

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    if (stat.size === 0 || start >= stat.size) {
      return { content: "", endOffset: start, eof: true };
    }
    // A text page must contain enough bytes to make progress across a complete
    // UTF-8 code point. Server-generated next offsets therefore never split a
    // character, even when the requested byte limit lands inside one.
    const effectiveLimitBytes = Math.max(4, limitBytes);
    const end = Math.max(start, Math.min(start + effectiveLimitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", endOffset: start, eof: true };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const bytes = Buffer.concat(chunks);
    let leadingContinuationBytes = 0;
    while (
      leadingContinuationBytes < bytes.length
      && (bytes[leadingContinuationBytes]! & 0xc0) === 0x80
    ) {
      leadingContinuationBytes += 1;
    }
    const decodable = bytes.subarray(leadingContinuationBytes);
    let decodedBytes = decodable.length;
    let content = "";
    for (let trim = 0; trim <= Math.min(3, decodable.length); trim += 1) {
      try {
        decodedBytes = decodable.length - trim;
        content = new TextDecoder("utf-8", { fatal: true }).decode(decodable.subarray(0, decodedBytes));
        break;
      } catch {
        if (trim === Math.min(3, decodable.length)) throw new Error("Run log contains invalid UTF-8");
      }
    }
    const endOffset = start + leadingContinuationBytes + decodedBytes;
    const eof = endOffset >= stat.size;
    const nextOffset = eof ? undefined : endOffset;
    return { content, endOffset, eof, nextOffset };
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  return {
    async begin(input) {
      const [orgId, agentId] = safeSegments(input.orgId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(orgId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return;
      const absPath = resolveWithin(basePath, handle.logRef);
      const line = JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: event.chunk,
      });
      await fs.appendFile(absPath, `${line}\n`, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");

      const hash = await sha256File(absPath);
      const summary = {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
      };
      try {
        const evidenceIndex = await maybeBuildNativeEvidenceIndex(basePath, handle, absPath, stat.size, hash);
        return evidenceIndex ? { ...summary, evidenceIndex } : summary;
      } catch (error) {
        return {
          ...summary,
          evidenceIndex: {
            protocolVersion: 1,
            status: "fallback",
            indexRef: `${handle.logRef}.index.ndjson`,
            sourceBytes: stat.size,
            sourceSha256: hash,
            fallbackReason: boundedNativeReason(error),
          },
        };
      }
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      return readFileRange(absPath, offset, limitBytes);
    },
  };
}

let cachedStore: RunLogStore | null = null;

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolveRudderInstanceRoot(), "data", "run-logs");
  cachedStore = createLocalFileRunLogStore(basePath);
  return cachedStore;
}
