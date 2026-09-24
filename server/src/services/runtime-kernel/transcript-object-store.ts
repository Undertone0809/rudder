import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { syncDirectory, syncFileHandle } from "../../file-system-durability.js";
import { resolveDefaultStorageDir } from "../../home-paths.js";
import type {
  NativeTranscriptReadInput,
  NativeTranscriptReadResult,
  NativeTranscriptReaderHook,
  TranscriptAvailability,
  TranscriptCompleteness,
} from "./transcript-reader.js";

const OBJECT_ROOT_NAME = "transcript-objects";
const OBJECT_REF_PREFIX = "tobj_v1_";
const OBJECT_REF_RE = /^tobj_v1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CURSOR_VERSION = 1;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_APPEND_ENTRIES = 200;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_APPEND_BYTES = 4 * 1024 * 1024;
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_OBJECT_ENTRIES = 10_000_000;
const DEFAULT_SWEEP_LIMIT = 500;
const MAX_SWEEP_LIMIT = 500;
const MAX_SWEEP_DIRECTORY_ENTRIES = MAX_SWEEP_LIMIT * 4;

export type TranscriptObjectStoreType = "local_file";

export interface TranscriptObjectBeginInput {
  orgId: string;
  runId: string;
  spanId: string;
  ownerToken: string;
}

export interface TranscriptObjectResumeInput extends TranscriptObjectBeginInput {
  objectRef: string;
}

export interface TranscriptObjectHandle extends TranscriptObjectBeginInput {
  store: TranscriptObjectStoreType;
  objectRef: string;
}

export interface TranscriptObjectFinalizeOptions {
  completeness?: TranscriptCompleteness;
}

export interface TranscriptObjectFinalizeReceipt {
  objectRef: string;
  bytes: number;
  entryCount: number;
  sha256: string;
  completeness: TranscriptCompleteness;
}

export interface TranscriptObjectReadRangeInput {
  objectRef: string;
  orgId: string;
  runId: string;
  spanId: string;
  ownerToken: string;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
  /**
   * Reader-only recovery path: the database span already owns this exact ref,
   * but a recovered attempt may have a new owner token. Writes remain fenced
   * to the original handle owner.
   */
  allowOwnerRecovery?: boolean;
}

export interface TranscriptObjectReadRangeResult {
  entries: readonly TranscriptEntry[];
  nextCursor: string | null;
  revision: string;
  source: "native_plus_objects";
  availability: TranscriptAvailability;
  completeness: TranscriptCompleteness;
}

export type TranscriptObjectSweepCandidate = Pick<StoredObjectMetadata, "objectRef" | "orgId" | "runId" | "spanId"> & {
  payloadMissing: boolean;
};

export type TranscriptObjectSweepGuardResult = "deleted" | "protected" | "skipped";

export type TranscriptObjectSweepRetentionGuard = (
  candidate: TranscriptObjectSweepCandidate,
  collect: () => Promise<boolean>,
) => Promise<TranscriptObjectSweepGuardResult>;

export interface TranscriptObjectSweepInput {
  /** Object references that are still reachable from the durable runtime graph. */
  protectedObjectRefs?: ReadonlySet<string> | readonly string[];
  /** Run collection inside the owning organization's retention lock. */
  withRetentionGuard?: TranscriptObjectSweepRetentionGuard;
  now?: Date;
  /** Keep a grace period for objects created by a writer that has not attached its span yet. */
  minAgeMs?: number;
  limit?: number;
}

export interface TranscriptObjectSweepResult {
  scanned: number;
  protected: number;
  skipped: number;
  deletedObjectRefs: string[];
}

export interface TranscriptObjectStore {
  begin(input: TranscriptObjectBeginInput): Promise<TranscriptObjectHandle>;
  /** Reopen an existing open object after a durable owner recovery. */
  resume(input: TranscriptObjectResumeInput): Promise<TranscriptObjectHandle>;
  append(handle: TranscriptObjectHandle, entries: TranscriptEntry | readonly TranscriptEntry[]): Promise<void>;
  finalize(handle: TranscriptObjectHandle, options?: TranscriptObjectFinalizeOptions): Promise<TranscriptObjectFinalizeReceipt>;
  write(input: TranscriptObjectBeginInput & { entries: readonly TranscriptEntry[] }): Promise<string>;
  readRange(input: TranscriptObjectReadRangeInput): Promise<TranscriptObjectReadRangeResult>;
  sweepUnreferenced(input?: TranscriptObjectSweepInput): Promise<TranscriptObjectSweepResult>;
}

type StoredObjectMetadata = {
  version: 1;
  objectRef: string;
  orgId: string;
  runId: string;
  spanId: string;
  sourceOwnerHash: string;
  state: "open" | "sealed";
  completeness: TranscriptCompleteness;
  entryCount: number;
  bytes: number;
  createdAt: string;
  updatedAt: string;
};

type StoredTranscriptLine = {
  version: 1;
  entry: TranscriptEntry;
};

type ObjectCursor = {
  version: typeof CURSOR_VERSION;
  objectRef: string;
  offset: number;
};

const appendLocks = new Map<string, Promise<unknown>>();

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`Transcript object ${label} is required`);
  }
  return value.trim();
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(value!)));
}

function normalizeSweepLimit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return DEFAULT_SWEEP_LIMIT;
  return Math.max(1, Math.min(MAX_SWEEP_LIMIT, Math.floor(value!)));
}

function jsonStringByteLength(value: string, maxBytes = Number.POSITIVE_INFINITY): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return bytes;
  }
  return bytes;
}

type JsonSizeFrame = {
  childCount: number;
} & (
  | { kind: "object"; value: object; keys: Iterator<string> }
  | { kind: "array"; value: readonly unknown[]; index: number }
);

type JsonSizeWork =
  | { kind: "value"; value: unknown; key: string; parent: JsonSizeFrame | null }
  | { kind: "frame"; frame: JsonSizeFrame }
  | { kind: "exit"; value: object };

function * enumerableOwnStringKeys(value: object): Generator<string> {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) yield key;
  }
}

function unboxJsonPrimitive(value: object): unknown {
  if (value instanceof Number) return Number.prototype.valueOf.call(value);
  if (value instanceof String) return String.prototype.valueOf.call(value);
  if (value instanceof Boolean) return Boolean.prototype.valueOf.call(value);
  return value;
}

function measureJsonValueBytes(value: unknown, maxBytes: number, limitMessage: string): number {
  let bytes = 0;
  const activeObjects = new WeakSet<object>();
  const work: JsonSizeWork[] = [{ kind: "value", value, key: "", parent: null }];
  const addBytes = (count: number) => {
    bytes += count;
    if (bytes > maxBytes) throw badRequest(limitMessage);
  };
  const addJsonString = (string: string) => addBytes(jsonStringByteLength(string, maxBytes - bytes));

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === "exit") {
      activeObjects.delete(item.value);
      continue;
    }
    if (item.kind === "frame") {
      const { frame } = item;
      if (frame.kind === "array") {
        if (frame.index >= frame.value.length) continue;
        if (frame.index > 0) addBytes(1);
        const index = frame.index++;
        work.push(item);
        work.push({
          kind: "value",
          value: frame.value[index],
          key: String(index),
          parent: frame,
        });
        continue;
      }
      const next = frame.keys.next();
      if (next.done) continue;
      work.push(item);
      work.push({
        kind: "value",
        value: (frame.value as Record<string, unknown>)[next.value],
        key: next.value,
        parent: frame,
      });
      continue;
    }

    let current = item.value;
    if ((typeof current === "object" && current !== null)
      || typeof current === "function" || typeof current === "bigint") {
      const toJSON = (current as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") current = toJSON.call(current, item.key);
    }
    if (current !== null && typeof current === "object") current = unboxJsonPrimitive(current);

    const omitted = current === undefined || typeof current === "function" || typeof current === "symbol";
    if (omitted && item.parent?.kind !== "array") continue;
    if (item.parent?.kind === "object") {
      if (item.parent.childCount > 0) addBytes(1);
      addJsonString(item.key);
      addBytes(1);
      item.parent.childCount += 1;
    }

    if (omitted || current === null) {
      addBytes(4);
    } else if (typeof current === "string") {
      addJsonString(current);
    } else if (typeof current === "number") {
      addBytes(Number.isFinite(current) ? (Object.is(current, -0) ? 1 : String(current).length) : 4);
    } else if (typeof current === "boolean") {
      addBytes(current ? 4 : 5);
    } else if (typeof current === "bigint") {
      throw new TypeError("Do not know how to serialize a BigInt");
    } else if (typeof current === "object") {
      if (activeObjects.has(current)) throw new TypeError("Converting circular structure to JSON");
      activeObjects.add(current);
      addBytes(2);
      work.push({ kind: "exit", value: current });
      if (Array.isArray(current)) {
        const frame: JsonSizeFrame = { kind: "array", value: current, index: 0, childCount: 0 };
        if (bytes + Math.max(0, current.length * 2 - 1) > maxBytes) throw badRequest(limitMessage);
        work.push({ kind: "frame", frame });
      } else {
        const frame: JsonSizeFrame = {
          kind: "object",
          value: current,
          keys: enumerableOwnStringKeys(current),
          childCount: 0,
        };
        work.push({ kind: "frame", frame });
      }
    }
  }
  return bytes;
}

const JSON_SIZE_LIMIT = Symbol("transcript object JSON size limit");

function stringifyJsonWithinLimit(value: unknown, maxBytes: number, limitMessage: string): string {
  let bytes = 0;
  const containers: Array<{ value: object; childCount: number }> = [];
  const addBytes = (count: number) => {
    bytes += count;
    if (bytes > maxBytes) throw JSON_SIZE_LIMIT;
  };
  const addJsonString = (string: string) => addBytes(jsonStringByteLength(string, maxBytes - bytes));
  let serialized: string | undefined;
  try {
    // The preflight pass bounds ordinary values; this also covers stateful toJSON/getter results.
    serialized = JSON.stringify(value, function (key, current) {
      const holder = this as object;
      while (containers.length > 0 && containers[containers.length - 1]!.value !== holder) containers.pop();
      const parent = containers[containers.length - 1];
      const arrayParent = Array.isArray(holder);
      const omitted = current === undefined || typeof current === "function" || typeof current === "symbol";
      if (parent?.value === holder) {
        if (omitted && !arrayParent) return current;
        if (parent.childCount > 0) addBytes(1);
        if (!arrayParent) {
          addJsonString(key);
          addBytes(1);
        }
        parent.childCount += 1;
      }

      if (omitted) {
        if (arrayParent) addBytes(4);
        return current;
      }
      if (current === null) addBytes(4);
      else if (typeof current === "string") addJsonString(current);
      else if (typeof current === "number") {
        addBytes(Number.isFinite(current) ? (Object.is(current, -0) ? 1 : String(current).length) : 4);
      } else if (typeof current === "boolean") addBytes(current ? 4 : 5);
      else if (typeof current === "object") {
        const primitive = unboxJsonPrimitive(current);
        if (primitive !== current) {
          if (typeof primitive === "string") addJsonString(primitive);
          else if (typeof primitive === "number") {
            addBytes(Number.isFinite(primitive) ? (Object.is(primitive, -0) ? 1 : String(primitive).length) : 4);
          } else if (typeof primitive === "boolean") addBytes(primitive ? 4 : 5);
          else if (typeof primitive === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
        } else {
          addBytes(2);
          containers.push({ value: current, childCount: 0 });
        }
      }
      return current;
    });
  } catch (error) {
    if (error === JSON_SIZE_LIMIT) throw badRequest(limitMessage);
    throw error;
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw badRequest(limitMessage);
  }
  return serialized;
}

class TranscriptObjectLineLimitError extends Error {
  constructor() {
    super("Transcript object line limit exceeded");
    this.name = "TranscriptObjectLineLimitError";
  }
}

async function * readBoundedLines(
  stream: AsyncIterable<Buffer>,
  maxLineBytes: number,
  onChunk?: (chunk: Buffer) => void,
): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let lineBytes = 0;
  const decodeLine = () => {
    const buffer = parts.length === 0
      ? Buffer.alloc(0)
      : parts.length === 1
        ? parts[0]!
        : Buffer.concat(parts, lineBytes);
    const line = buffer.toString("utf8");
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  };

  for await (const chunk of stream) {
    onChunk?.(chunk);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (lineBytes + part.length > maxLineBytes) throw new TranscriptObjectLineLimitError();
      if (part.length > 0) {
        parts.push(part);
        lineBytes += part.length;
      }
      if (newline < 0) break;
      yield decodeLine();
      parts = [];
      lineBytes = 0;
      start = newline + 1;
    }
  }
  if (lineBytes > 0) yield decodeLine();
}

function ownerTokenSha256(ownerToken: string): string {
  return createHash("sha256").update(ownerToken, "utf8").digest("hex");
}

function objectRevision(objectRef: string): string {
  return createHash("sha256").update(`rudder-transcript-object:${objectRef}`, "utf8").digest("hex");
}

function objectRef(): string {
  return `${OBJECT_REF_PREFIX}${randomUUID()}`;
}

function assertObjectRef(value: unknown): string {
  const ref = requiredString(value, "reference");
  if (!OBJECT_REF_RE.test(ref)) throw forbidden("Transcript object access denied");
  return ref;
}

function assertTranscriptEntry(value: unknown): asserts value is TranscriptEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("Transcript object entry is invalid");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.kind !== "string" || entry.kind.trim().length === 0 || typeof entry.ts !== "string") {
    throw badRequest("Transcript object entry is invalid");
  }
}

function resolveWithin(root: string, relativePath: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw forbidden("Transcript object path is invalid");
  }
  return resolved;
}

function objectPaths(basePath: string, refValue: unknown) {
  const ref = assertObjectRef(refValue);
  const root = path.resolve(basePath, OBJECT_ROOT_NAME);
  return {
    ref,
    root,
    payloadPath: resolveWithin(root, `${ref}.ndjson`),
    metadataPath: resolveWithin(root, `${ref}.json`),
  };
}

async function assertRegularFile(filePath: string, message: string): Promise<void> {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat) throw notFound(message);
  if (stat.isSymbolicLink() || !stat.isFile()) throw forbidden("Transcript object access denied");
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await syncFileHandle(handle);
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createEmptyFile(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await syncFileHandle(handle);
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

function parseCursor(value: string | null | undefined, expectedRef: string): number {
  if (!value) return 0;
  let parsed: Partial<ObjectCursor>;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ObjectCursor>;
  } catch {
    throw badRequest("Transcript object cursor is invalid");
  }
  if (parsed.version !== CURSOR_VERSION || parsed.objectRef !== expectedRef
    || typeof parsed.offset !== "number" || !Number.isSafeInteger(parsed.offset)
    || parsed.offset < 0 || parsed.offset > MAX_OBJECT_ENTRIES) {
    throw badRequest("Transcript object cursor is invalid");
  }
  return parsed.offset;
}

function encodeCursor(objectRef: string, offset: number): string {
  return Buffer.from(JSON.stringify({ version: CURSOR_VERSION, objectRef, offset }), "utf8").toString("base64url");
}

function parseStoredLine(line: string): TranscriptEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Transcript object line is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Transcript object line is invalid");
  }
  const record = parsed as Partial<StoredTranscriptLine>;
  if (record.version !== 1) throw new Error("Transcript object line version is invalid");
  assertTranscriptEntry(record.entry);
  return record.entry;
}

function parseStoredObjectMetadata(value: unknown): StoredObjectMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Transcript object metadata is invalid");
  }
  const metadata = value as Partial<StoredObjectMetadata>;
  if (metadata.version !== 1 || typeof metadata.objectRef !== "string"
    || !OBJECT_REF_RE.test(metadata.objectRef)
    || typeof metadata.orgId !== "string" || metadata.orgId.trim().length === 0
    || typeof metadata.runId !== "string" || metadata.runId.trim().length === 0
    || typeof metadata.spanId !== "string" || metadata.spanId.trim().length === 0
    || typeof metadata.sourceOwnerHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(metadata.sourceOwnerHash)
    || (metadata.state !== "open" && metadata.state !== "sealed")
    || !["complete", "partial", "terminal_only", "unknown"].includes(metadata.completeness as string)
    || !Number.isSafeInteger(metadata.entryCount) || Number(metadata.entryCount) < 0
    || !Number.isSafeInteger(metadata.bytes) || Number(metadata.bytes) < 0
    || typeof metadata.createdAt !== "string" || !Number.isFinite(Date.parse(metadata.createdAt))
    || typeof metadata.updatedAt !== "string" || !Number.isFinite(Date.parse(metadata.updatedAt))) {
    throw new Error("Transcript object metadata is invalid");
  }
  return metadata as StoredObjectMetadata;
}

async function loadMetadata(
  metadataPath: string,
  expected: TranscriptObjectBeginInput & { objectRef: string },
  options: { allowOwnerRecovery?: boolean } = {},
): Promise<StoredObjectMetadata> {
  await assertRegularFile(metadataPath, "Transcript object not found");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch {
    throw forbidden("Transcript object access denied");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw forbidden("Transcript object access denied");
  }
  let metadata: StoredObjectMetadata;
  try {
    metadata = parseStoredObjectMetadata(parsed);
  } catch {
    throw forbidden("Transcript object access denied");
  }
  if (metadata.objectRef !== expected.objectRef
    || metadata.orgId !== expected.orgId || metadata.runId !== expected.runId
    || metadata.spanId !== expected.spanId
    || (!options.allowOwnerRecovery && metadata.sourceOwnerHash !== ownerTokenSha256(expected.ownerToken))) {
    throw forbidden("Transcript object access denied");
  }
  return metadata;
}

async function withObjectLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = appendLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  appendLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (appendLocks.get(key) === current) appendLocks.delete(key);
  }
}

async function scanObjectFile(filePath: string): Promise<{ entryCount: number; sha256: string; bytes: number }> {
  await assertRegularFile(filePath, "Transcript object not found");
  const stat = await fs.stat(filePath);
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  let entryCount = 0;
  try {
    for await (const line of readBoundedLines(stream, MAX_ENTRY_BYTES, (chunk) => hash.update(chunk))) {
      if (line.length === 0) continue;
      parseStoredLine(line);
      entryCount += 1;
      if (entryCount > MAX_OBJECT_ENTRIES) throw new Error("Transcript object entry limit exceeded");
    }
  } finally {
    stream.destroy();
  }
  return { entryCount, sha256: hash.digest("hex"), bytes: stat.size };
}

async function reconcileOpenPayload(filePath: string, committedBytes: number): Promise<void> {
  await assertRegularFile(filePath, "Transcript object not found");
  const file = await fs.open(filePath, "r+");
  try {
    const stat = await file.stat();
    if (stat.size < committedBytes) throw new Error("Transcript object payload is shorter than committed metadata");
    if (stat.size > committedBytes) {
      await file.truncate(committedBytes);
      await syncFileHandle(file);
    }
  } finally {
    await file.close();
  }
}

function defaultBasePath(): string {
  return process.env.RUDDER_TRANSCRIPT_OBJECT_BASE_PATH?.trim()
    || process.env.RUDDER_STORAGE_LOCAL_DIR?.trim()
    || resolveDefaultStorageDir();
}

function createLocalTranscriptObjectStore(basePath: string): TranscriptObjectStore {
  const root = path.resolve(basePath);
  const ownerRecoveryHandles = new WeakSet<object>();
  // Keep the directory cursor between bounded batches so protected objects cannot starve later refs.
  let sweepDirectory: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  let sweepTail = Promise.resolve();

  async function withSweepLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = sweepTail;
    let release!: () => void;
    sweepTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function sweepUnreferencedUnlocked(
    input: TranscriptObjectSweepInput = {},
  ): Promise<TranscriptObjectSweepResult> {
    const now = input.now ?? new Date();
    const minAgeMs = input.minAgeMs ?? 60 * 60 * 1000;
    if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
      throw badRequest("Transcript object sweep age is invalid");
    }
    const limit = normalizeSweepLimit(input.limit);
    const protectedRefs = new Set(
      [...(input.protectedObjectRefs ?? [])]
        .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
        .map((ref) => ref.trim()),
    );
    const objectRoot = path.resolve(root, OBJECT_ROOT_NAME);
    const result: TranscriptObjectSweepResult = {
      scanned: 0,
      protected: 0,
      skipped: 0,
      deletedObjectRefs: [],
    };
    if (!sweepDirectory) {
      try {
        sweepDirectory = await fs.opendir(objectRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return result;
        throw error;
      }
    }

    const directory = sweepDirectory;
    if (!directory) return result;
    let directoryEntriesScanned = 0;
    try {
      while (directoryEntriesScanned < Math.min(MAX_SWEEP_DIRECTORY_ENTRIES, limit * 4)
        && result.scanned < limit) {
        const entry = await directory.read();
        if (!entry) {
          await directory.close();
          sweepDirectory = null;
          break;
        }
        directoryEntriesScanned += 1;
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const ref = entry.name.slice(0, -5);
        if (!OBJECT_REF_RE.test(ref)) continue;
        result.scanned += 1;
        if (protectedRefs.has(ref)) {
          result.protected += 1;
          continue;
        }
        const paths = objectPaths(root, ref);
        let metadata: StoredObjectMetadata;
        try {
          await assertRegularFile(paths.metadataPath, "Transcript object metadata not found");
          metadata = parseStoredObjectMetadata(JSON.parse(await fs.readFile(paths.metadataPath, "utf8")));
          if (metadata.objectRef !== ref) throw new Error("Transcript object reference mismatch");
          if (!input.withRetentionGuard) await assertRegularFile(paths.payloadPath, "Transcript object payload not found");
        } catch {
          // A malformed or incomplete object is evidence for recovery, not a
          // reason for a scheduler to destroy potentially recoverable data.
          result.skipped += 1;
          continue;
        }
        if (now.getTime() - Date.parse(metadata.updatedAt) < minAgeMs) {
          result.skipped += 1;
          continue;
        }

        try {
          const deleted = await withObjectLock(paths.payloadPath, async () => {
            if (protectedRefs.has(ref)) return false;
            let payloadMissing = false;
            try {
              await fs.lstat(paths.payloadPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
              payloadMissing = true;
            }
            const collect = async () => {
              let latest: StoredObjectMetadata;
              try {
                latest = parseStoredObjectMetadata(JSON.parse(await fs.readFile(paths.metadataPath, "utf8")));
                const payloadStat = await fs.lstat(paths.payloadPath).catch((error: NodeJS.ErrnoException) => {
                  if (error.code === "ENOENT" && input.withRetentionGuard) return null;
                  throw error;
                });
                if (payloadStat && (!payloadStat.isFile() || payloadStat.isSymbolicLink())) return false;
                if (!payloadStat && !input.withRetentionGuard) return false;
                if ((payloadStat === null) !== payloadMissing) return false;
              } catch {
                return false;
              }
              if (
                latest.objectRef !== ref
                || latest.orgId !== metadata.orgId
                || latest.runId !== metadata.runId
                || latest.spanId !== metadata.spanId
                || now.getTime() - Date.parse(latest.updatedAt) < minAgeMs
              ) return false;
              await fs.rm(paths.payloadPath, { force: true });
              await fs.rm(paths.metadataPath);
              await syncDirectory(paths.root);
              return true;
            };
            if (!input.withRetentionGuard) return await collect() ? "deleted" : "skipped";
            return input.withRetentionGuard({
              objectRef: ref,
              orgId: metadata.orgId,
              runId: metadata.runId,
              spanId: metadata.spanId,
              payloadMissing,
            }, collect);
          });
          if (deleted === "deleted") result.deletedObjectRefs.push(ref);
          else if (deleted === "protected") result.protected += 1;
          else result.skipped += 1;
        } catch {
          result.skipped += 1;
        }
      }
    } catch (error) {
      sweepDirectory = null;
      await directory.close().catch(() => undefined);
      throw error;
    }
    return result;
  }

  async function sweepUnreferenced(input: TranscriptObjectSweepInput = {}): Promise<TranscriptObjectSweepResult> {
    return withSweepLock(() => sweepUnreferencedUnlocked(input));
  }

  async function appendUnlocked(
    handle: TranscriptObjectHandle,
    entries: readonly TranscriptEntry[],
    allowOwnerRecovery: boolean,
  ): Promise<void> {
    const paths = objectPaths(root, handle.objectRef);
    const metadata = await loadMetadata(paths.metadataPath, { ...handle, objectRef: paths.ref }, { allowOwnerRecovery });
    if (metadata.state !== "open") throw conflict("Transcript object is finalized");
    await reconcileOpenPayload(paths.payloadPath, metadata.bytes);
    if (entries.length > MAX_APPEND_ENTRIES) throw badRequest("Transcript object append is too large");

    const preparedEntries: StoredTranscriptLine[] = [];
    let estimatedPayloadBytes = 0;
    for (const entry of entries) {
      assertTranscriptEntry(entry);
      const sourceEntryId = typeof entry.sourceEntryId === "string" && entry.sourceEntryId.trim().length > 0
        ? entry.sourceEntryId
        : `${paths.ref}:entry:${randomUUID()}`;
      const storedEntry = typeof entry.sourceEntryId === "string" && entry.sourceEntryId.trim().length > 0
        ? entry
        : { ...entry, sourceEntryId };
      const value = { version: 1, entry: storedEntry } satisfies StoredTranscriptLine;
      const appendRemaining = MAX_APPEND_BYTES - estimatedPayloadBytes;
      const jsonLimit = Math.min(MAX_ENTRY_BYTES - 1, appendRemaining - 1);
      if (jsonLimit < 0) throw badRequest("Transcript object append is too large");
      const limitMessage = appendRemaining < MAX_ENTRY_BYTES ? "Transcript object append is too large" : "Transcript object entry is too large";
      const estimatedLineBytes = measureJsonValueBytes(value, jsonLimit, limitMessage) + 1;
      if (estimatedLineBytes > MAX_ENTRY_BYTES) throw badRequest("Transcript object entry is too large");
      if (estimatedLineBytes > appendRemaining) throw badRequest("Transcript object append is too large");
      estimatedPayloadBytes += estimatedLineBytes;
      preparedEntries.push(value);
    }
    if (metadata.bytes + estimatedPayloadBytes > MAX_OBJECT_BYTES || metadata.entryCount + entries.length > MAX_OBJECT_ENTRIES) {
      throw badRequest("Transcript object size limit exceeded");
    }

    const storedLines: string[] = [];
    let payloadBytes = 0;
    for (const value of preparedEntries) {
      const appendRemaining = MAX_APPEND_BYTES - payloadBytes;
      const jsonLimit = Math.min(MAX_ENTRY_BYTES - 1, appendRemaining - 1);
      const limitMessage = appendRemaining < MAX_ENTRY_BYTES ? "Transcript object append is too large" : "Transcript object entry is too large";
      const line = stringifyJsonWithinLimit(value, jsonLimit, limitMessage);
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (lineBytes > MAX_ENTRY_BYTES) throw badRequest("Transcript object entry is too large");
      if (lineBytes > appendRemaining) {
        throw badRequest("Transcript object append is too large");
      }
      payloadBytes += lineBytes;
      storedLines.push(`${line}\n`);
    }
    if (metadata.bytes + payloadBytes > MAX_OBJECT_BYTES || metadata.entryCount + entries.length > MAX_OBJECT_ENTRIES) {
      throw badRequest("Transcript object size limit exceeded");
    }
    if (payloadBytes === 0) return;

    const payload = storedLines.join("");
    const file = await fs.open(paths.payloadPath, "a");
    try {
      await file.writeFile(payload, "utf8");
      await syncFileHandle(file);
    } finally {
      await file.close();
    }
    await writeJsonAtomically(paths.metadataPath, {
      ...metadata,
      entryCount: metadata.entryCount + entries.length,
      bytes: metadata.bytes + payloadBytes,
      updatedAt: new Date().toISOString(),
    } satisfies StoredObjectMetadata);
  }

  return {
    async begin(input) {
      const binding = {
        orgId: requiredString(input.orgId, "organization"),
        runId: requiredString(input.runId, "run"),
        spanId: requiredString(input.spanId, "span"),
        ownerToken: requiredString(input.ownerToken, "owner"),
      };
      await fs.mkdir(path.resolve(root, OBJECT_ROOT_NAME), { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ref = objectRef();
        const paths = objectPaths(root, ref);
        try {
          await createEmptyFile(paths.payloadPath);
          const now = new Date().toISOString();
          await writeJsonAtomically(paths.metadataPath, {
            version: 1,
            objectRef: ref,
            orgId: binding.orgId,
            runId: binding.runId,
            spanId: binding.spanId,
            sourceOwnerHash: ownerTokenSha256(binding.ownerToken),
            state: "open",
            completeness: "partial",
            entryCount: 0,
            bytes: 0,
            createdAt: now,
            updatedAt: now,
          } satisfies StoredObjectMetadata);
          return { store: "local_file", ...binding, objectRef: ref };
        } catch (error) {
          if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST" || attempt === 2) throw error;
        }
      }
      throw new Error("Unable to allocate transcript object reference");
    },

    async resume(input) {
      const binding = {
        orgId: requiredString(input.orgId, "organization"),
        runId: requiredString(input.runId, "run"),
        spanId: requiredString(input.spanId, "span"),
        ownerToken: requiredString(input.ownerToken, "owner"),
      };
      const paths = objectPaths(root, input.objectRef);
      await withObjectLock(paths.payloadPath, async () => {
        const metadata = await loadMetadata(
          paths.metadataPath,
          { ...binding, objectRef: paths.ref },
          { allowOwnerRecovery: true },
        );
        if (metadata.state !== "open") throw conflict("Transcript object is finalized");
        await reconcileOpenPayload(paths.payloadPath, metadata.bytes);
      });
      const handle = { store: "local_file" as const, ...binding, objectRef: paths.ref };
      ownerRecoveryHandles.add(handle);
      return handle;
    },

    async append(handle, entries) {
      if (handle.store !== "local_file") throw badRequest("Transcript object store is unsupported");
      const normalizedEntries = Array.isArray(entries) ? entries : [entries];
      const paths = objectPaths(root, handle.objectRef);
      await withObjectLock(
        paths.payloadPath,
        () => appendUnlocked(handle, normalizedEntries, ownerRecoveryHandles.has(handle)),
      );
    },

    async finalize(handle, options) {
      if (handle.store !== "local_file") throw badRequest("Transcript object store is unsupported");
      const paths = objectPaths(root, handle.objectRef);
      return withObjectLock(paths.payloadPath, async () => {
        const metadata = await loadMetadata(
          paths.metadataPath,
          { ...handle, objectRef: paths.ref },
          { allowOwnerRecovery: ownerRecoveryHandles.has(handle) },
        );
        if (metadata.state !== "open") {
          const summary = await scanObjectFile(paths.payloadPath);
          return {
            objectRef: paths.ref,
            ...summary,
            completeness: metadata.completeness,
          };
        }
        await reconcileOpenPayload(paths.payloadPath, metadata.bytes);
        const summary = await scanObjectFile(paths.payloadPath);
        const completeness = options?.completeness ?? "complete";
        await writeJsonAtomically(paths.metadataPath, {
          ...metadata,
          state: "sealed",
          completeness,
          entryCount: summary.entryCount,
          bytes: summary.bytes,
          updatedAt: new Date().toISOString(),
        } satisfies StoredObjectMetadata);
        return { objectRef: paths.ref, ...summary, completeness };
      });
    },

    async write(input) {
      const handle = await this.begin(input);
      await this.append(handle, input.entries);
      const receipt = await this.finalize(handle);
      return receipt.objectRef;
    },

    sweepUnreferenced,

    async readRange(input) {
      const ref = assertObjectRef(input.objectRef);
      const binding = {
        orgId: requiredString(input.orgId, "organization"),
        runId: requiredString(input.runId, "run"),
        spanId: requiredString(input.spanId, "span"),
        ownerToken: requiredString(input.ownerToken, "owner"),
      };
      const paths = objectPaths(root, ref);
      const metadata = await loadMetadata(paths.metadataPath, { ...binding, objectRef: ref }, {
        allowOwnerRecovery: input.allowOwnerRecovery,
      });
      await assertRegularFile(paths.payloadPath, "Transcript object not found");
      const payloadStat = await fs.stat(paths.payloadPath);
      if (payloadStat.size < metadata.bytes || (metadata.state === "sealed" && payloadStat.size !== metadata.bytes)) {
        throw new Error("Transcript object payload does not match committed metadata");
      }
      const start = parseCursor(input.cursor, ref);
      const limit = normalizeLimit(input.limit);
      if (metadata.bytes === 0) {
        if (start !== 0) throw badRequest("Transcript object cursor is past the end");
        return {
          entries: [],
          nextCursor: null,
          revision: objectRevision(ref),
          source: "native_plus_objects",
          availability: "available",
          completeness: metadata.state === "open" ? "partial" : metadata.completeness,
        } satisfies TranscriptObjectReadRangeResult;
      }
      const entries: TranscriptEntry[] = [];
      let validEntries = 0;
      let hasMore = false;
      let incompleteTail = false;
      const stream = createReadStream(paths.payloadPath, { start: 0, end: metadata.bytes - 1 });
      try {
        for await (const line of readBoundedLines(stream, MAX_ENTRY_BYTES)) {
          if (input.signal?.aborted) throw new Error("transcript object read cancelled");
          if (line.length === 0) continue;
          let entry: TranscriptEntry;
          try {
            entry = parseStoredLine(line);
          } catch (error) {
            if (metadata.state === "open") {
              incompleteTail = true;
              break;
            }
            throw error;
          }
          if (validEntries < start) {
            validEntries += 1;
            continue;
          }
          if (entries.length >= limit) {
            hasMore = true;
            break;
          }
          entries.push(entry);
          validEntries += 1;
          if (validEntries > MAX_OBJECT_ENTRIES) throw new Error("Transcript object entry limit exceeded");
        }
      } catch (error) {
        if (error instanceof TranscriptObjectLineLimitError && metadata.state === "open") {
          incompleteTail = true;
        } else {
          throw error;
        }
      } finally {
        stream.destroy();
      }
      if (start > validEntries && !incompleteTail) throw badRequest("Transcript object cursor is past the end");
      const nextCursor = hasMore ? encodeCursor(ref, start + entries.length) : null;
      return {
        entries,
        nextCursor,
        revision: objectRevision(ref),
        source: "native_plus_objects",
        availability: "available",
        completeness: metadata.state === "open" || incompleteTail ? "partial" : metadata.completeness,
      } satisfies TranscriptObjectReadRangeResult;
    },
  };
}

let cachedStore: TranscriptObjectStore | null = null;
let cachedBasePath: string | null = null;

export function createTranscriptObjectStore(basePath: string): TranscriptObjectStore {
  return createLocalTranscriptObjectStore(basePath);
}

export function getTranscriptObjectStore(): TranscriptObjectStore {
  const basePath = path.resolve(defaultBasePath());
  if (!cachedStore || cachedBasePath !== basePath) {
    cachedStore = createLocalTranscriptObjectStore(basePath);
    cachedBasePath = basePath;
  }
  return cachedStore;
}

export function createTranscriptObjectReader(
  store: TranscriptObjectStore = getTranscriptObjectStore(),
): NativeTranscriptReaderHook {
  function missingObjectResult(): NativeTranscriptReadResult {
    return {
      items: [],
      source: "native_plus_objects",
      availability: "missing",
      completeness: "unknown",
      revision: "transcript-object-missing",
    };
  }

  async function readRange(input: NativeTranscriptReadInput): Promise<NativeTranscriptReadResult> {
    const objectRef = typeof input.span.supplementalObjectRef === "string"
      ? input.span.supplementalObjectRef.trim()
      : "";
    if (!objectRef) {
      return {
        items: [],
        source: "native_plus_objects",
        availability: "missing",
        completeness: "unknown",
        revision: "transcript-object-missing",
      };
    }
    let result: TranscriptObjectReadRangeResult;
    try {
      result = await store.readRange({
        objectRef,
        orgId: input.orgId,
        runId: input.run.id,
        spanId: input.span.id,
        ownerToken: input.span.ownerToken,
        cursor: input.cursor,
        limit: input.limit,
        signal: input.signal,
        allowOwnerRecovery: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/transcript object(?: metadata| payload)? not found|ENOENT/u.test(message)) {
        return missingObjectResult();
      }
      throw error;
    }
    return {
      entries: result.entries,
      nextCursor: result.nextCursor,
      revision: result.revision,
      source: result.source,
      availability: result.availability,
      completeness: result.completeness,
    };
  }

  return { readRange };
}
