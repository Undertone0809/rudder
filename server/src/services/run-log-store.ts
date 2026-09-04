import { resolveNativeCommand } from "@rudderhq/agent-runtime-utils";
import { resolveRudderNativeCapability, resolveRudderNativeTarget, type RudderNativeDiagnostic } from "@rudderhq/shared";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
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
  signal?: AbortSignal;
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
  diagnostic?: RudderNativeDiagnostic;
}

export interface RunLogStore {
  begin(input: { orgId: string; agentId: string; runId: string; append?: boolean }): Promise<RunLogHandle>;
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
const NATIVE_EVIDENCE_READ_OUTPUT_LIMIT_BYTES = 2_100_000;
const NATIVE_EVIDENCE_TIMEOUT_MS = 30_000;
const NATIVE_EVIDENCE_MAX_READ_BYTES = 1_000_000;
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
  capability?: unknown;
  content?: unknown;
  endOffset?: unknown;
  eof?: unknown;
  nextOffset?: unknown;
  errorCode?: unknown;
  target?: unknown;
  binaryVersion?: unknown;
};

type EvidenceIndexMetadata = {
  protocolVersion: 1;
  sourceBytes: number;
  sourceSha256: string;
  recordCount: number;
  diagnostic?: RudderNativeDiagnostic;
};

function evidenceDiagnostic(input: {
  effectiveEngine: "rust" | "node";
  fallbackCode: string | null;
  target?: unknown;
  binaryVersion?: unknown;
}): RudderNativeDiagnostic {
  return {
    capability: "run-evidence",
    target: typeof input.target === "string" ? input.target : `${process.platform}-${process.arch}`,
    binaryVersion: typeof input.binaryVersion === "string" ? input.binaryVersion : "unavailable",
    protocolVersion: String(NATIVE_EVIDENCE_PROTOCOL_VERSION),
    effectiveEngine: input.effectiveEngine,
    fallbackCode: input.fallbackCode,
  };
}

function nativeTarget() {
  return resolveRudderNativeTarget();
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

function nativeEvidenceReadTimeoutMs() {
  const configured = Number(process.env.RUDDER_NATIVE_EVIDENCE_READ_TIMEOUT_MS ?? NATIVE_EVIDENCE_TIMEOUT_MS);
  return Number.isFinite(configured) ? Math.max(10, Math.min(NATIVE_EVIDENCE_TIMEOUT_MS, Math.floor(configured))) : NATIVE_EVIDENCE_TIMEOUT_MS;
}

async function runNativeEvidenceIndex(binary: string, inputPath: string, outputPath: string): Promise<NativeEvidenceIndexResponse> {
  let result: { stdout: string; stderr: string };
  try {
    const command = resolveNativeCommand(binary, [
      "evidence",
      "index",
      inputPath,
      outputPath,
      String(NATIVE_EVIDENCE_MAX_RECORD_BYTES),
      String(NATIVE_EVIDENCE_MAX_RECORDS),
    ]);
    result = await execFileAsync(command.command, command.args, {
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

async function runNativeEvidenceRead(
  binary: string,
  inputPath: string,
  offset: number,
  limitBytes: number,
  signal?: AbortSignal,
): Promise<RunLogReadResult> {
  let result: { stdout: string; stderr: string };
  try {
    const command = resolveNativeCommand(binary, [
      "evidence",
      "read",
      inputPath,
      String(offset),
      String(limitBytes),
    ]);
    result = await execFileAsync(command.command, command.args, {
      encoding: "utf8",
      timeout: nativeEvidenceReadTimeoutMs(),
      maxBuffer: NATIVE_EVIDENCE_READ_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
      signal,
    });
  } catch (error) {
    const details = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown; signal?: unknown };
    if (signal?.aborted) throw new Error("native evidence read cancelled");
    const receipt = parseNativeEvidenceFailureReceipt(details.stdout);
    if (receipt === "evidence_read_not_found") throw notFound("Run log not found");
    if (receipt) throw new Error(receipt);
    throw new Error(boundedNativeReason(
      details.stderr
      || (details.killed || details.signal === "SIGTERM" || details.code === "ETIMEDOUT" ? "native read timeout" : details.code ?? "native read failed"),
    ));
  }
  if (result.stderr.trim()) throw new Error(boundedNativeReason(result.stderr));
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error(`native read response line count ${lines.length}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]!);
  } catch {
    throw new Error("native read response is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("native read response envelope is invalid");
  }
  const response = parsed as NativeEvidenceIndexResponse;
  const clampedPastEof = response.eof === true && response.content === ""
    && Number.isSafeInteger(response.endOffset) && Number(response.endOffset) < offset
    && response.nextOffset == null;
  if (response.ok !== true || response.operation !== "readEvidence"
    || response.capability !== "evidence.read" || response.protocolVersion !== NATIVE_EVIDENCE_PROTOCOL_VERSION
    || typeof response.content !== "string" || !Number.isSafeInteger(response.endOffset)
    || (!clampedPastEof && Number(response.endOffset) < offset)
    || Number(response.endOffset) > offset + Math.max(4, limitBytes)
    || typeof response.eof !== "boolean"
    || (!response.eof && (!Number.isSafeInteger(response.nextOffset) || response.nextOffset !== response.endOffset))
    || (response.eof && response.nextOffset != null)) {
    throw new Error("native evidence read envelope mismatch");
  }
  const contentBytes = Buffer.byteLength(response.content, "utf8");
  const consumedBytes = clampedPastEof ? 0 : Number(response.endOffset) - offset;
  if (contentBytes > consumedBytes || consumedBytes - contentBytes > 3) {
    throw new Error("native evidence read byte accounting mismatch");
  }
  return {
    content: response.content,
    endOffset: Number(response.endOffset),
    eof: response.eof,
    ...(response.eof ? {} : { nextOffset: Number(response.nextOffset) }),
  };
}

function parseNativeEvidenceFailureReceipt(value: unknown) {
  const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) return null;
  try {
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    return parsed.ok === false && parsed.capability === "evidence.read"
      && typeof parsed.errorCode === "string" ? parsed.errorCode : null;
  } catch {
    return null;
  }
}

async function validateEvidenceSidecar(indexPath: string, metadataPath: string, sourcePath: string, expected: {
  sourceBytes: number;
  sourceSha256: string;
}): Promise<EvidenceIndexMetadata | null> {
  try {
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as EvidenceIndexMetadata;
    if (metadata.protocolVersion !== 1 || metadata.sourceBytes !== expected.sourceBytes
      || metadata.sourceSha256 !== expected.sourceSha256 || !Number.isSafeInteger(metadata.recordCount)
      || metadata.recordCount < 0 || metadata.recordCount > NATIVE_EVIDENCE_MAX_RECORDS) return null;
    let sequence = 0;
    let sourceOffset = 0;
    const indexLines = readline.createInterface({ input: createReadStream(indexPath), crlfDelay: Infinity });
    const sourceLines = readline.createInterface({ input: createReadStream(sourcePath), crlfDelay: Infinity });
    const sourceIterator = sourceLines[Symbol.asyncIterator]();
    try {
      for await (const line of indexLines) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const sourceLine = await sourceIterator.next();
        if (sourceLine.done) return null;
        const recordLine = String(sourceLine.value);
        const recordLength = Buffer.byteLength(recordLine) + 1;
        if (entry.sequence !== sequence || entry.sourceOffset !== sourceOffset
          || !Number.isSafeInteger(entry.sourceLength) || Number(entry.sourceLength) !== recordLength
          || recordLength < 1 || recordLength > NATIVE_EVIDENCE_MAX_RECORD_BYTES
          || !["stdout", "stderr", "system"].includes(entry.stream as string)
          || !Number.isSafeInteger(entry.chunkBytes) || Number(entry.chunkBytes) < 0
          || Number(entry.chunkBytes) > NATIVE_EVIDENCE_MAX_RECORD_BYTES
          || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) return null;
        const record = JSON.parse(recordLine) as Record<string, unknown>;
        const chunk = typeof record.chunk === "string" ? record.chunk : null;
        if (chunk === null || entry.stream !== record.stream
          || entry.chunkBytes !== Buffer.byteLength(chunk)
          || entry.sha256 !== createHash("sha256").update(chunk).digest("hex")) return null;
        sourceOffset += recordLength;
        sequence += 1;
        if (sequence > NATIVE_EVIDENCE_MAX_RECORDS) return null;
      }
      if (!(await sourceIterator.next()).done) return null;
    } finally {
      indexLines.close();
      sourceLines.close();
    }
    return sequence === metadata.recordCount && sourceOffset === metadata.sourceBytes ? metadata : null;
  } catch {
    return null;
  }
}

async function writeEvidenceIndexMetadata(metadataPath: string, metadata: EvidenceIndexMetadata) {
  const temporary = `${metadataPath}.${process.pid}-${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, metadataPath);
}

async function maybeBuildNativeEvidenceIndex(
  basePath: string,
  handle: RunLogHandle,
  sourcePath: string,
  sourceBytes: number,
  sourceSha256: string,
): Promise<RunLogEvidenceIndexSummary | undefined> {
  const policy = resolveRudderNativeCapability({
    capability: "run-evidence",
    env: process.env,
    legacyToggleEnvs: ["RUDDER_NATIVE_RUN_EVIDENCE_INDEX"],
  });
  if (!policy.enabled) return undefined;
  const indexRelativePath = `${handle.logRef}.index.ndjson`;
  const indexPath = resolveWithin(basePath, indexRelativePath);
  const metadataPath = `${indexPath}.meta.json`;
  const sourceStat = await fs.stat(sourcePath);
  const existing = await fs.lstat(indexPath).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("native evidence index path is not a regular file");
    const metadata = existing.mtimeMs >= sourceStat.mtimeMs
      ? await validateEvidenceSidecar(indexPath, metadataPath, sourcePath, { sourceBytes, sourceSha256 })
      : null;
    if (metadata) {
      return {
        protocolVersion: 1,
        status: "existing",
        indexRef: indexRelativePath,
        sourceBytes,
        recordCount: metadata.recordCount,
        sourceSha256,
        diagnostic: metadata.diagnostic ?? evidenceDiagnostic({ effectiveEngine: "rust", fallbackCode: null }),
      };
    }
    await Promise.all([fs.rm(indexPath, { force: true }), fs.rm(metadataPath, { force: true })]);
  }
  try {
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
    const diagnostic = evidenceDiagnostic({
      effectiveEngine: "rust",
      fallbackCode: null,
      target: response.target,
      binaryVersion: response.binaryVersion,
    });
    await writeEvidenceIndexMetadata(metadataPath, {
      protocolVersion: 1,
      sourceBytes,
      sourceSha256,
      recordCount: Number(response.recordCount),
      diagnostic,
    });
    return {
      protocolVersion: 1,
      status: "native",
      indexRef: indexRelativePath,
      sourceBytes,
      recordCount: Number(response.recordCount),
      sourceSha256,
      diagnostic,
    };
  } catch (error) {
    await Promise.all([
      fs.rm(indexPath, { force: true }),
      fs.rm(metadataPath, { force: true }),
    ]).catch(() => undefined);
    throw error;
  }
}

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(
    filePath: string,
    offset: number,
    limitBytes: number,
    signal?: AbortSignal,
  ): Promise<RunLogReadResult> {
    if (signal?.aborted) throw new Error("run log read cancelled");
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
      const abort = () => stream.destroy(new Error("run log read cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      stream.on("end", () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      });
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
      if (!input.append) {
        await fs.writeFile(absPath, "", "utf8");
      } else {
        await fs.appendFile(absPath, "", "utf8");
      }

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
        const policy = resolveRudderNativeCapability({
          capability: "run-evidence",
          env: process.env,
          legacyToggleEnvs: ["RUDDER_NATIVE_RUN_EVIDENCE_INDEX"],
        });
        if (!policy.fallbackAllowed) throw error;
        return {
          ...summary,
          evidenceIndex: {
            protocolVersion: 1,
            status: "fallback",
            indexRef: `${handle.logRef}.index.ndjson`,
            sourceBytes: stat.size,
            sourceSha256: hash,
            fallbackReason: boundedNativeReason(error),
            diagnostic: evidenceDiagnostic({
              effectiveEngine: "node",
              fallbackCode: error instanceof Error ? error.name : "native_index_failed",
            }),
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
      const policy = resolveRudderNativeCapability({
        capability: "run-evidence",
        env: process.env,
        legacyToggleEnvs: ["RUDDER_NATIVE_RUN_EVIDENCE_INDEX"],
      });
      // Larger internal readers are outside the bounded runs.log surface and
      // retain Node authority until they adopt explicit paging.
      if (policy.enabled && limitBytes <= NATIVE_EVIDENCE_MAX_READ_BYTES) {
        try {
          return await runNativeEvidenceRead(
            resolveNativeEvidenceIndexBinary(),
            absPath,
            offset,
            Math.max(4, limitBytes),
            opts?.signal,
          );
        } catch (error) {
          if (opts?.signal?.aborted) throw error;
          if (!policy.fallbackAllowed) throw error;
        }
      }
      return readFileRange(absPath, offset, limitBytes, opts?.signal);
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
