import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { syncDirectory, syncFileHandle } from "../../file-system-durability.js";
import { resolveDefaultStorageDir } from "../../home-paths.js";
import {
  type CodexMixedCoverageInput,
  type CoverageIdentity,
} from "./native-transcript-coverage.js";
import {
  CODEX_GAP_ENCODING,
  CodexGapDictionary,
  createCodexGapObjectMetadata,
  isCodexGapObjectMetadata,
} from "./transcript-object-compact.js";
import type {
  NativeTranscriptReadInput,
  NativeTranscriptReadResult,
  NativeTranscriptReaderHook,
  TranscriptAvailability,
  TranscriptCompleteness,
} from "./transcript-reader.js";

import { createCodexTimelineShadowStore } from "./transcript-object-shadow.js";

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
  /** Host-attested NEW object only. Recovery never upgrades a legacy object. */
  compactIdentity?: CoverageIdentity | null;
  /** Mark a NEW raw object as eligible for an owner-fenced compact handoff. */
  earlyHandoffEligible?: boolean;
  /** Internal reverse edge used only while constructing a compact handoff child. */
  compactHandoffParentRef?: string;
}

export interface TranscriptObjectResumeInput extends TranscriptObjectBeginInput {
  objectRef: string;
}

export interface TranscriptObjectHandle extends TranscriptObjectBeginInput {
  store: TranscriptObjectStoreType;
  objectRef: string;
  earlyHandoffEligible?: boolean;
}

export type TranscriptObjectFenceCommit = (commit: () => Promise<void>) => Promise<boolean>;

export interface TranscriptObjectCompactHandoffInput {
  handle: TranscriptObjectHandle;
  compactIdentity: CoverageIdentity;
  /** The callback must publish while holding the active Run/Attempt owner fence. */
  withPublishFence: TranscriptObjectFenceCommit;
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
  append(handle: TranscriptObjectHandle, entries: TranscriptEntry | readonly TranscriptEntry[], options?: {
    withOwnerFence?: TranscriptObjectFenceCommit;
  }): Promise<void>;
  /** Atomically link a copied, identity-bound compact child from a new raw root. */
  handoffCompact?(input: TranscriptObjectCompactHandoffInput): Promise<{
    activated: boolean;
    objectRef: string | null;
  }>;
  finalize(handle: TranscriptObjectHandle, options?: TranscriptObjectFinalizeOptions): Promise<TranscriptObjectFinalizeReceipt>;
  removeSealed(input: TranscriptObjectReadRangeInput): Promise<void>;
  stageSealedRemoval?(input: TranscriptObjectReadRangeInput): Promise<{ objectRef: string; stageId: string }>;
  restoreStagedRemoval?(input: TranscriptObjectReadRangeInput & { stageId: string }): Promise<void>;
  purgeStagedRemoval?(input: TranscriptObjectBeginInput & {
    objectRef: string;
    stageId: string;
    allowOwnerRecovery?: boolean;
  }): Promise<void>;
  write(input: TranscriptObjectBeginInput & { entries: readonly TranscriptEntry[] }): Promise<string>;
  readRange(input: TranscriptObjectReadRangeInput): Promise<TranscriptObjectReadRangeResult>;
  /** Optional shadow-only capability. Original ref, writer and reads stay authoritative. */
  writeCodexTimelineShadow?(input: CodexTimelineShadowInput & {
    beforePublish: () => Promise<boolean>;
  }): Promise<CodexTimelineShadowResult>;
  compareCodexTimelineShadow?(input: CodexTimelineShadowInput): Promise<CodexTimelineShadowResult>;
  /** Object lock first; caller may then acquire retention advisory/row locks. */
  withCodexTimelineShadowLock?<T>(objectRef: string, operation: (
    write: (input: CodexTimelineShadowInput & { beforePublish: () => Promise<boolean> }) => Promise<CodexTimelineShadowResult>,
  ) => Promise<T>): Promise<T>;
  isSelfContainedCompact?(input: TranscriptObjectBeginInput & { objectRef: string }): Promise<boolean>;
  sweepUnreferenced(input?: TranscriptObjectSweepInput): Promise<TranscriptObjectSweepResult>;
}

export type CodexTimelineShadowInput = {
  objectRef: string;
  identity: CoverageIdentity;
  native: CodexMixedCoverageInput["native"];
};

export type CodexTimelineShadowResult = {
  ok: false;
  reason: string;
  authorizesOldObjectDelete: false;
} | {
  ok: true;
  originalSha256: string;
  reconstructedSha256: string;
  manifestSha256: string;
  residualSha256: string;
  originalBytes: number;
  residualBytes: number;
  authorizesOldObjectDelete: false;
};

export type CodexTimelineShadowReader = NativeTranscriptReaderHook & {
  compareCodexTimelineShadow?: (input: NativeTranscriptReadInput,
    native: CodexMixedCoverageInput["native"]) => Promise<CodexTimelineShadowResult>;
};

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
  encoding?: typeof CODEX_GAP_ENCODING;
  compactIdentitySha256?: string;
  logicalBytes?: number;
  earlyHandoffEligible?: true;
  compactHandoffParentRef?: string;
  compactHandoff?: {
    objectRef: string;
    prefixEntryCount: number;
    prefixSha256: string;
    compactIdentitySha256: string;
  };
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

function parseStoredLine(line: string, codec?: CodexGapDictionary, compact = false): TranscriptEntry {
  if (codec) line = codec.decode(line, MAX_ENTRY_BYTES - 1, compact);
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
  if (metadata.encoding !== undefined) {
    const validGapMetadata = isCodexGapObjectMetadata(value);
    if (!validGapMetadata || typeof metadata.logicalBytes !== "number"
      || metadata.logicalBytes > MAX_OBJECT_BYTES) {
      throw new Error("Transcript object encoding is invalid");
    }
  }
  if (metadata.earlyHandoffEligible !== undefined && metadata.earlyHandoffEligible !== true) {
    throw new Error("Transcript object handoff eligibility is invalid");
  }
  if (metadata.compactHandoffParentRef !== undefined
    && (typeof metadata.compactHandoffParentRef !== "string"
      || !OBJECT_REF_RE.test(metadata.compactHandoffParentRef)
      || metadata.compactHandoffParentRef === metadata.objectRef)) {
    throw new Error("Transcript object handoff parent is invalid");
  }
  if (metadata.compactHandoff !== undefined) {
    const handoff = metadata.compactHandoff;
    if (!handoff || typeof handoff !== "object"
      || typeof handoff.objectRef !== "string" || !OBJECT_REF_RE.test(handoff.objectRef)
      || handoff.objectRef === metadata.objectRef
      || !Number.isSafeInteger(handoff.prefixEntryCount) || handoff.prefixEntryCount < 0
      || typeof handoff.prefixSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(handoff.prefixSha256)
      || typeof handoff.compactIdentitySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(handoff.compactIdentitySha256)
      || metadata.earlyHandoffEligible !== true || metadata.encoding !== undefined) {
      throw new Error("Transcript object handoff metadata is invalid");
    }
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

async function scanObjectFile(filePath: string, compact = false, codec = new CodexGapDictionary()): Promise<{ entryCount: number; sha256: string; bytes: number }> {
  await assertRegularFile(filePath, "Transcript object not found");
  const stat = await fs.stat(filePath);
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  let entryCount = 0;
  try {
    for await (const line of readBoundedLines(stream, MAX_ENTRY_BYTES, (chunk) => hash.update(chunk))) {
      if (line.length === 0) continue;
      parseStoredLine(line, codec, compact);
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
  // At most 64 * 32KiB cached recovery dictionaries. Commit-bound cache only;
  // reopen/failed append rebuilds from the authoritative committed payload.
  const dictionaries = new Map<string, { bytes: number; entries: number; dictionary: Buffer }>();
  // Keep the directory cursor between bounded batches so protected objects cannot starve later refs.
  let sweepDirectory: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  let sweepTail = Promise.resolve();

  const { writeShadow, compareShadow, withShadowLock } = createCodexTimelineShadowStore({
    root, objectPaths, parseStoredObjectMetadata, ownerTokenSha256, withObjectLock,
  });

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
    for (const protectedRef of [...protectedRefs]) {
      if (!OBJECT_REF_RE.test(protectedRef)) continue;
      try {
        const protectedPaths = objectPaths(root, protectedRef);
        const protectedMetadata = parseStoredObjectMetadata(JSON.parse(
          await fs.readFile(protectedPaths.metadataPath, "utf8"),
        ));
        if (protectedMetadata.objectRef === protectedRef && protectedMetadata.compactHandoff) {
          protectedRefs.add(protectedMetadata.compactHandoff.objectRef);
        }
      } catch {
        // A missing or malformed root cannot make an unverified child reachable.
      }
    }
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
        let retentionMetadata = metadata;
        if (metadata.compactHandoffParentRef) {
          try {
            const parentPaths = objectPaths(root, metadata.compactHandoffParentRef);
            const parentMetadata = parseStoredObjectMetadata(JSON.parse(
              await fs.readFile(parentPaths.metadataPath, "utf8"),
            ));
            if (parentMetadata.objectRef === metadata.compactHandoffParentRef
              && parentMetadata.orgId === metadata.orgId
              && parentMetadata.runId === metadata.runId
              && parentMetadata.spanId === metadata.spanId
              && parentMetadata.compactHandoff?.objectRef === ref
              && parentMetadata.compactHandoff.compactIdentitySha256 === metadata.compactIdentitySha256) {
              retentionMetadata = parentMetadata;
              if (protectedRefs.has(parentMetadata.objectRef) || !input.withRetentionGuard) {
                protectedRefs.add(ref);
                result.protected += 1;
                continue;
              }
            }
          } catch {
            // An unpublished child is not reachable from its raw root.
          }
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
              objectRef: retentionMetadata.objectRef,
              orgId: retentionMetadata.orgId,
              runId: retentionMetadata.runId,
              spanId: retentionMetadata.spanId,
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
    if ((metadata.logicalBytes ?? metadata.bytes) + estimatedPayloadBytes > MAX_OBJECT_BYTES || metadata.entryCount + entries.length > MAX_OBJECT_ENTRIES) {
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
    if ((metadata.logicalBytes ?? metadata.bytes) + payloadBytes > MAX_OBJECT_BYTES || metadata.entryCount + entries.length > MAX_OBJECT_ENTRIES) {
      throw badRequest("Transcript object size limit exceeded");
    }
    if (payloadBytes === 0) return;

    let codec: CodexGapDictionary | undefined;
    if (metadata.encoding === CODEX_GAP_ENCODING) {
      const cached = dictionaries.get(paths.payloadPath);
      codec = new CodexGapDictionary(cached?.bytes === metadata.bytes && cached.entries === metadata.entryCount ? cached.dictionary : undefined);
      if (!cached || cached.bytes !== metadata.bytes || cached.entries !== metadata.entryCount) {
        const scanned = await scanObjectFile(paths.payloadPath, true, codec);
        if (scanned.bytes !== metadata.bytes || scanned.entryCount !== metadata.entryCount) throw new Error("Compact committed payload mismatch");
      }
    }
    const logicalAppendBytes = payloadBytes;
    const payload = codec ? storedLines.map(line => codec!.encode(line.slice(0, -1)) + "\n").join("") : storedLines.join("");
    payloadBytes = Buffer.byteLength(payload, "utf8");
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
      ...(codec ? { logicalBytes: metadata.logicalBytes! + logicalAppendBytes } : {}),
      updatedAt: new Date().toISOString(),
    } satisfies StoredObjectMetadata);
    if (codec) {
      dictionaries.delete(paths.payloadPath);
      if (dictionaries.size >= 64) dictionaries.delete(dictionaries.keys().next().value!);
      dictionaries.set(paths.payloadPath, { bytes: metadata.bytes + payloadBytes, entries: metadata.entryCount + entries.length, dictionary: codec.snapshot() });
    }
  }

  return {
    async begin(input) {
      const binding = {
        orgId: requiredString(input.orgId, "organization"),
        runId: requiredString(input.runId, "run"),
        spanId: requiredString(input.spanId, "span"),
        ownerToken: requiredString(input.ownerToken, "owner"),
      };
      const compactMetadata = createCodexGapObjectMetadata(input.compactIdentity, binding);
      if (input.earlyHandoffEligible && compactMetadata) {
        throw badRequest("A compact transcript object cannot be an early handoff root");
      }
      const compactHandoffParentRef = input.compactHandoffParentRef
        ? assertObjectRef(input.compactHandoffParentRef)
        : undefined;
      if (compactHandoffParentRef && (!compactMetadata || compactHandoffParentRef === "")) {
        throw badRequest("A compact handoff child requires a compact identity");
      }
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
            ...(compactMetadata ?? {}),
            ...(input.earlyHandoffEligible ? { earlyHandoffEligible: true as const } : {}),
            ...(compactHandoffParentRef ? { compactHandoffParentRef } : {}),
          } satisfies StoredObjectMetadata);
          return {
            store: "local_file",
            ...binding,
            objectRef: ref,
            ...(input.earlyHandoffEligible ? { earlyHandoffEligible: true } : {}),
          };
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
      const metadata = await withObjectLock(paths.payloadPath, async () => {
        const current = await loadMetadata(
          paths.metadataPath,
          { ...binding, objectRef: paths.ref },
          { allowOwnerRecovery: true },
        );
        if (current.state !== "open") throw conflict("Transcript object is finalized");
        await reconcileOpenPayload(paths.payloadPath, current.bytes);
        return current;
      });
      const handle = {
        store: "local_file" as const,
        ...binding,
        objectRef: paths.ref,
        ...(metadata.earlyHandoffEligible ? { earlyHandoffEligible: true } : {}),
      };
      ownerRecoveryHandles.add(handle);
      return handle;
    },

    async handoffCompact(input) {
      const { handle } = input;
      if (handle.store !== "local_file") throw badRequest("Transcript object store is unsupported");
      const binding = {
        orgId: requiredString(handle.orgId, "organization"),
        runId: requiredString(handle.runId, "run"),
        spanId: requiredString(handle.spanId, "span"),
        ownerToken: requiredString(handle.ownerToken, "owner"),
      };
      const rootPaths = objectPaths(root, handle.objectRef);
      const compactMetadata = createCodexGapObjectMetadata(input.compactIdentity, binding);
      if (!compactMetadata) throw badRequest("Compact transcript identity is incomplete");
      return withObjectLock(rootPaths.payloadPath, async () => {
        const allowOwnerRecovery = ownerRecoveryHandles.has(handle);
        const rootMetadata = await loadMetadata(rootPaths.metadataPath, {
          ...binding,
          objectRef: rootPaths.ref,
        }, { allowOwnerRecovery });
        const digestObjectEntries = async (
          objectRef: string,
          entryLimit: number,
          allowRecovery: boolean,
        ) => {
          const digest = createHash("sha256");
          let entryCount = 0;
          let cursor: string | null = null;
          while (entryCount < entryLimit) {
            const page = await this.readRange({
              ...binding,
              objectRef,
              cursor,
              limit: Math.min(MAX_PAGE_LIMIT, entryLimit - entryCount),
              allowOwnerRecovery: allowRecovery,
            });
            for (const entry of page.entries) digest.update(JSON.stringify(entry)).update("\n");
            entryCount += page.entries.length;
            cursor = page.nextCursor;
            if (!cursor) break;
          }
          return { entryCount, sha256: digest.digest("hex"), cursor };
        };

        if (rootMetadata.compactHandoff) {
          const childPaths = objectPaths(root, rootMetadata.compactHandoff.objectRef);
          const childMetadata = await loadMetadata(childPaths.metadataPath, {
            ...binding,
            objectRef: childPaths.ref,
          }, { allowOwnerRecovery: true });
          if (childMetadata.compactHandoffParentRef !== rootPaths.ref
            || childMetadata.compactIdentitySha256 !== compactMetadata.compactIdentitySha256
            || rootMetadata.compactHandoff.compactIdentitySha256 !== compactMetadata.compactIdentitySha256
            || childMetadata.encoding !== CODEX_GAP_ENCODING
            || childMetadata.entryCount < rootMetadata.compactHandoff.prefixEntryCount) {
            throw conflict("Transcript compact handoff identity does not match its root");
          }
          const childPrefix = await digestObjectEntries(
            childPaths.ref,
            rootMetadata.compactHandoff.prefixEntryCount,
            true,
          );
          if (childPrefix.entryCount !== rootMetadata.compactHandoff.prefixEntryCount
            || childPrefix.sha256 !== rootMetadata.compactHandoff.prefixSha256) {
            throw new Error("Transcript compact handoff prefix digest does not match its root");
          }
          const active = await input.withPublishFence(async () => undefined);
          return { activated: active, objectRef: active ? childPaths.ref : null };
        }
        if (rootMetadata.state !== "open" || rootMetadata.earlyHandoffEligible !== true
          || rootMetadata.encoding !== undefined) {
          return { activated: false, objectRef: null };
        }
        await reconcileOpenPayload(rootPaths.payloadPath, rootMetadata.bytes);

        const pendingChildren: Array<{ objectRef: string; entryCount: number }> = [];
        for (const item of await fs.readdir(rootPaths.root, { withFileTypes: true })) {
          if (!item.isFile() || !item.name.endsWith(".json")) continue;
          const candidateRef = item.name.slice(0, -".json".length);
          if (!OBJECT_REF_RE.test(candidateRef) || candidateRef === rootPaths.ref) continue;
          try {
            const candidate = parseStoredObjectMetadata(JSON.parse(await fs.readFile(
              objectPaths(root, candidateRef).metadataPath,
              "utf8",
            )));
            if (candidate.objectRef === candidateRef
              && candidate.orgId === binding.orgId
              && candidate.runId === binding.runId
              && candidate.spanId === binding.spanId
              && candidate.compactHandoffParentRef === rootPaths.ref
              && candidate.compactIdentitySha256 === compactMetadata.compactIdentitySha256
              && candidate.encoding === CODEX_GAP_ENCODING
              && candidate.state === "open"
              && candidate.entryCount <= rootMetadata.entryCount) {
              pendingChildren.push({ objectRef: candidateRef, entryCount: candidate.entryCount });
            }
          } catch {
            // An incomplete or malformed child is retained but never linked.
          }
        }

        let childHandle: TranscriptObjectHandle | null = null;
        let copiedEntryCount = 0;
        for (const candidate of pendingChildren) {
          try {
            const candidateHandle = await this.resume({ ...binding, objectRef: candidate.objectRef });
            const [sourcePrefix, childPrefix] = await Promise.all([
              digestObjectEntries(rootPaths.ref, candidate.entryCount, allowOwnerRecovery),
              digestObjectEntries(candidate.objectRef, candidate.entryCount, true),
            ]);
            if (sourcePrefix.entryCount !== candidate.entryCount
              || childPrefix.entryCount !== candidate.entryCount
              || sourcePrefix.sha256 !== childPrefix.sha256) continue;
            childHandle = candidateHandle;
            copiedEntryCount = candidate.entryCount;
            break;
          } catch {
            // Keep searching; the raw root remains the authoritative evidence.
          }
        }
        childHandle ??= await this.begin({
          ...binding,
          compactIdentity: input.compactIdentity,
          compactHandoffParentRef: rootPaths.ref,
        });

        let cursor = copiedEntryCount > 0 ? encodeCursor(rootPaths.ref, copiedEntryCount) : null;
        while (copiedEntryCount < rootMetadata.entryCount) {
          const page = await this.readRange({
            ...binding,
            objectRef: rootPaths.ref,
            cursor,
            limit: Math.min(MAX_PAGE_LIMIT, rootMetadata.entryCount - copiedEntryCount),
            allowOwnerRecovery,
          });
          if (page.entries.length === 0) break;
          await this.append(childHandle, page.entries);
          copiedEntryCount += page.entries.length;
          cursor = page.nextCursor;
        }

        const sourcePrefix = await digestObjectEntries(rootPaths.ref, rootMetadata.entryCount, allowOwnerRecovery);
        if (sourcePrefix.entryCount !== rootMetadata.entryCount) {
          throw new Error("Transcript early handoff source count does not match committed metadata");
        }
        const childMetadata = await loadMetadata(objectPaths(root, childHandle.objectRef).metadataPath, {
          ...binding,
          objectRef: childHandle.objectRef,
        }, { allowOwnerRecovery: ownerRecoveryHandles.has(childHandle) });
        const childPrefix = await digestObjectEntries(childHandle.objectRef, rootMetadata.entryCount, true);
        if (childMetadata.entryCount !== rootMetadata.entryCount
          || childPrefix.entryCount !== rootMetadata.entryCount
          || childPrefix.sha256 !== sourcePrefix.sha256) {
          throw new Error("Transcript compact handoff did not preserve its committed prefix");
        }

        let published = false;
        const publish = async () => {
          if (published) throw new Error("Transcript compact handoff was published more than once");
          await writeJsonAtomically(rootPaths.metadataPath, {
            ...rootMetadata,
            compactHandoff: {
              objectRef: childHandle.objectRef,
              prefixEntryCount: rootMetadata.entryCount,
              prefixSha256: sourcePrefix.sha256,
              compactIdentitySha256: compactMetadata.compactIdentitySha256,
            },
            updatedAt: new Date().toISOString(),
          } satisfies StoredObjectMetadata);
          published = true;
        };
        const ownerFenced = await input.withPublishFence(publish);
        return {
          activated: ownerFenced && published,
          objectRef: ownerFenced && published ? childHandle.objectRef : null,
        };
      });
    },

    async append(handle, entries, options) {
      if (handle.store !== "local_file") throw badRequest("Transcript object store is unsupported");
      const normalizedEntries = Array.isArray(entries) ? entries : [entries];
      const paths = objectPaths(root, handle.objectRef);
      await withObjectLock(paths.payloadPath, async () => {
        const allowOwnerRecovery = ownerRecoveryHandles.has(handle);
        const commit = async () => {
          const metadata = await loadMetadata(paths.metadataPath, { ...handle, objectRef: paths.ref }, {
            allowOwnerRecovery,
          });
          const handoff = metadata.compactHandoff;
          if (!handoff) {
            await appendUnlocked(handle, normalizedEntries, allowOwnerRecovery);
            return;
          }
          const childPaths = objectPaths(root, handoff.objectRef);
          const childHandle = { ...handle, objectRef: childPaths.ref, earlyHandoffEligible: undefined };
          const childMetadata = await loadMetadata(childPaths.metadataPath, {
            ...childHandle,
            objectRef: childPaths.ref,
          }, { allowOwnerRecovery: true });
          if (childMetadata.compactHandoffParentRef !== paths.ref
            || childMetadata.compactIdentitySha256 !== handoff.compactIdentitySha256
            || childMetadata.encoding !== CODEX_GAP_ENCODING) {
            throw conflict("Transcript compact handoff child is unavailable");
          }
          await withObjectLock(childPaths.payloadPath, () => appendUnlocked(
            childHandle,
            normalizedEntries,
            allowOwnerRecovery,
          ));
        };
        if (!options?.withOwnerFence) {
          await commit();
          return;
        }
        let committed = false;
        const ownerFenced = await options.withOwnerFence(async () => {
          if (committed) throw new Error("Transcript append was committed more than once");
          await commit();
          committed = true;
        });
        if (!ownerFenced || !committed) throw new Error("Transcript append lost its active Run owner fence");
      });
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
        if (metadata.compactHandoff) {
          const childPaths = objectPaths(root, metadata.compactHandoff.objectRef);
          const childHandle = { ...handle, objectRef: childPaths.ref, earlyHandoffEligible: undefined };
          if (ownerRecoveryHandles.has(handle)) ownerRecoveryHandles.add(childHandle);
          const childReceipt = await this.finalize(childHandle, options);
          if (metadata.state === "open") {
            await writeJsonAtomically(paths.metadataPath, {
              ...metadata,
              state: "sealed",
              completeness: childReceipt.completeness,
              updatedAt: new Date().toISOString(),
            } satisfies StoredObjectMetadata);
          }
          return { ...childReceipt, objectRef: paths.ref };
        }
        if (metadata.state !== "open") {
          const summary = await scanObjectFile(paths.payloadPath, metadata.encoding === CODEX_GAP_ENCODING);
          return {
            objectRef: paths.ref,
            ...summary,
            completeness: metadata.completeness,
          };
        }
        await reconcileOpenPayload(paths.payloadPath, metadata.bytes);
        const summary = await scanObjectFile(paths.payloadPath, metadata.encoding === CODEX_GAP_ENCODING);
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

    async removeSealed(input) {
      const ref = assertObjectRef(input.objectRef);
      const binding = {
        orgId: requiredString(input.orgId, "organization"),
        runId: requiredString(input.runId, "run"),
        spanId: requiredString(input.spanId, "span"),
        ownerToken: requiredString(input.ownerToken, "owner"),
      };
      const paths = objectPaths(root, ref);
      await withObjectLock(paths.payloadPath, async () => {
        const metadataStat = await fs.lstat(paths.metadataPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        const payloadStat = await fs.lstat(paths.payloadPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!metadataStat && !payloadStat) return;
        if (!metadataStat) throw new Error("Transcript object metadata is missing; object identity cannot be verified");
        if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) throw forbidden("Transcript object access denied");
        const metadata = await loadMetadata(paths.metadataPath, { ...binding, objectRef: ref }, {
          allowOwnerRecovery: input.allowOwnerRecovery,
        });
        if (metadata.compactHandoff) throw conflict("Transcript handoff removal requires both references");
        if (metadata.state !== "sealed") throw conflict("Transcript object is not sealed");
        if (!payloadStat) {
          await fs.unlink(paths.metadataPath);
          await syncDirectory(paths.root);
          return;
        }
        if (payloadStat.isSymbolicLink() || !payloadStat.isFile()) throw forbidden("Transcript object access denied");
        const summary = await scanObjectFile(paths.payloadPath, metadata.encoding === CODEX_GAP_ENCODING);
        if (summary.bytes !== metadata.bytes || summary.entryCount !== metadata.entryCount) {
          throw new Error("Transcript object does not match its committed metadata");
        }
        await fs.unlink(paths.payloadPath);
        await fs.unlink(paths.metadataPath);
        await syncDirectory(paths.root);
      });
    },

    async stageSealedRemoval(input) {
      const ref = assertObjectRef(input.objectRef);
      const binding = {
        orgId: requiredString(input.orgId, "organization"),
        runId: requiredString(input.runId, "run"),
        spanId: requiredString(input.spanId, "span"),
        ownerToken: requiredString(input.ownerToken, "owner"),
      };
      const paths = objectPaths(root, ref);
      const stageId = randomUUID();
      const stageDir = resolveWithin(paths.root, `.retention-${ref}-${stageId}`);
      await withObjectLock(paths.payloadPath, async () => {
        const metadataStat = await fs.lstat(paths.metadataPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        const payloadStat = await fs.lstat(paths.payloadPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!metadataStat && !payloadStat) return;
        if (!metadataStat || metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
          throw new Error("Transcript object metadata is missing; object identity cannot be verified");
        }
        const metadata = await loadMetadata(paths.metadataPath, { ...binding, objectRef: ref }, {
          allowOwnerRecovery: input.allowOwnerRecovery,
        });
        if (metadata.compactHandoff) throw conflict("Transcript handoff removal requires both references");
        if (metadata.state !== "sealed") throw conflict("Transcript object is not sealed");
        if (payloadStat) {
          if (payloadStat.isSymbolicLink() || !payloadStat.isFile()) throw forbidden("Transcript object access denied");
          const summary = await scanObjectFile(paths.payloadPath, metadata.encoding === CODEX_GAP_ENCODING);
          if (summary.bytes !== metadata.bytes || summary.entryCount !== metadata.entryCount) {
            throw new Error("Transcript object does not match its committed metadata");
          }
        }
        await fs.mkdir(stageDir, { mode: 0o700 });
        let movedMetadata = false;
        let movedPayload = false;
        try {
          await fs.rename(paths.metadataPath, path.join(stageDir, `${ref}.json`));
          movedMetadata = true;
          if (payloadStat) {
            await fs.rename(paths.payloadPath, path.join(stageDir, `${ref}.ndjson`));
            movedPayload = true;
          }
          await syncDirectory(paths.root);
        } catch (error) {
          if (movedPayload) await fs.rename(path.join(stageDir, `${ref}.ndjson`), paths.payloadPath).catch(() => undefined);
          if (movedMetadata) await fs.rename(path.join(stageDir, `${ref}.json`), paths.metadataPath).catch(() => undefined);
          await fs.rmdir(stageDir).catch(() => undefined);
          throw error;
        }
      });
      return { objectRef: ref, stageId };
    },

    async restoreStagedRemoval(input) {
      const ref = assertObjectRef(input.objectRef);
      if (!/^[0-9a-f-]{36}$/iu.test(input.stageId)) throw forbidden("Transcript object staging identity is invalid");
      const binding = {
        orgId: requiredString(input.orgId, "organization"),
        runId: requiredString(input.runId, "run"),
        spanId: requiredString(input.spanId, "span"),
        ownerToken: requiredString(input.ownerToken, "owner"),
      };
      const paths = objectPaths(root, ref);
      const stageDir = resolveWithin(paths.root, `.retention-${ref}-${input.stageId}`);
      await withObjectLock(paths.payloadPath, async () => {
        const stageStat = await fs.lstat(stageDir).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!stageStat) return;
        if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) throw forbidden("Transcript object access denied");
        const metadataPath = path.join(stageDir, `${ref}.json`);
        const payloadPath = path.join(stageDir, `${ref}.ndjson`);
        const metadataStat = await fs.lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        const payloadStat = await fs.lstat(payloadPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!metadataStat || metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
          throw new Error("Staged transcript metadata is missing");
        }
        await loadMetadata(metadataPath, { ...binding, objectRef: ref }, { allowOwnerRecovery: input.allowOwnerRecovery });
        if (payloadStat) {
          if (payloadStat.isSymbolicLink() || !payloadStat.isFile()) throw forbidden("Transcript object access denied");
          const metadata = await loadMetadata(metadataPath, { ...binding, objectRef: ref }, { allowOwnerRecovery: input.allowOwnerRecovery });
          const summary = await scanObjectFile(payloadPath, metadata.encoding === CODEX_GAP_ENCODING);
          if (summary.bytes !== metadata.bytes || summary.entryCount !== metadata.entryCount) {
            throw new Error("Staged transcript object does not match its committed metadata");
          }
        }
        if (await fs.lstat(paths.metadataPath).catch(() => null) || await fs.lstat(paths.payloadPath).catch(() => null)) {
          throw conflict("Transcript object destination already exists");
        }
        let restoredMetadata = false;
        let restoredPayload = false;
        try {
          await fs.rename(metadataPath, paths.metadataPath);
          restoredMetadata = true;
          if (payloadStat) {
            await fs.rename(payloadPath, paths.payloadPath);
            restoredPayload = true;
          }
          await fs.rmdir(stageDir);
          await syncDirectory(paths.root);
        } catch (error) {
          await fs.mkdir(stageDir, { mode: 0o700 }).catch(() => undefined);
          if (restoredPayload) await fs.rename(paths.payloadPath, payloadPath).catch(() => undefined);
          if (restoredMetadata) await fs.rename(paths.metadataPath, metadataPath).catch(() => undefined);
          throw error;
        }
      });
    },

    async purgeStagedRemoval(input) {
      const ref = assertObjectRef(input.objectRef);
      if (!/^[0-9a-f-]{36}$/iu.test(input.stageId)) throw forbidden("Transcript object staging identity is invalid");
      const binding = {
        orgId: requiredString(input.orgId, "organization"),
        runId: requiredString(input.runId, "run"),
        spanId: requiredString(input.spanId, "span"),
        ownerToken: requiredString(input.ownerToken, "owner"),
      };
      const paths = objectPaths(root, ref);
      const stageDir = resolveWithin(paths.root, `.retention-${ref}-${input.stageId}`);
      await withObjectLock(paths.payloadPath, async () => {
        const stageStat = await fs.lstat(stageDir).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!stageStat) return;
        if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) throw forbidden("Transcript object access denied");
        const payloadPath = path.join(stageDir, `${ref}.ndjson`);
        const metadataPath = path.join(stageDir, `${ref}.json`);
        const [payloadStat, metadataStat] = await Promise.all([payloadPath, metadataPath].map(async (filePath) =>
          await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          })
        ));
        if (!payloadStat && !metadataStat) {
          await fs.rmdir(stageDir);
          await syncDirectory(paths.root);
          return;
        }
        if (!metadataStat || metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
          throw new Error("Staged transcript metadata is missing or invalid");
        }
        const metadata = await loadMetadata(metadataPath, { ...binding, objectRef: ref }, {
          allowOwnerRecovery: input.allowOwnerRecovery,
        });
        if (metadata.state !== "sealed") throw conflict("Staged transcript object is not sealed");
        if (payloadStat) {
          if (payloadStat.isSymbolicLink() || !payloadStat.isFile()) throw forbidden("Transcript object access denied");
          const summary = await scanObjectFile(payloadPath, metadata.encoding === CODEX_GAP_ENCODING);
          if (summary.bytes !== metadata.bytes || summary.entryCount !== metadata.entryCount) {
            throw new Error("Staged transcript object does not match its committed metadata");
          }
        }
        await fs.unlink(payloadPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await fs.unlink(metadataPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await fs.rmdir(stageDir);
        await syncDirectory(paths.root);
      });
    },

    sweepUnreferenced,
    writeCodexTimelineShadow: writeShadow,
    compareCodexTimelineShadow: compareShadow,
    withCodexTimelineShadowLock: withShadowLock,
    async isSelfContainedCompact(input) {
      const paths = objectPaths(root, input.objectRef);
      const metadata = await loadMetadata(paths.metadataPath, { ...input, objectRef: paths.ref }, { allowOwnerRecovery: true });
      return metadata.encoding === CODEX_GAP_ENCODING;
    },

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
      if (metadata.compactHandoff) {
        const childRef = metadata.compactHandoff.objectRef;
        const childPaths = objectPaths(root, childRef);
        const childMetadata = await loadMetadata(childPaths.metadataPath, {
          ...binding,
          objectRef: childRef,
        }, { allowOwnerRecovery: input.allowOwnerRecovery });
        if (childMetadata.compactHandoffParentRef !== ref
          || childMetadata.compactIdentitySha256 !== metadata.compactHandoff.compactIdentitySha256
          || childMetadata.encoding !== CODEX_GAP_ENCODING
          || childMetadata.entryCount < metadata.compactHandoff.prefixEntryCount) {
          throw new Error("Transcript compact handoff references an invalid child");
        }
        const offset = parseCursor(input.cursor, ref);
        const childPage = await this.readRange({
          ...input,
          objectRef: childRef,
          cursor: encodeCursor(childRef, offset),
        });
        return {
          ...childPage,
          nextCursor: childPage.nextCursor
            ? encodeCursor(ref, parseCursor(childPage.nextCursor, childRef))
            : null,
          revision: `${objectRevision(ref)}:${childPage.revision}`,
        } satisfies TranscriptObjectReadRangeResult;
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
      const codec = metadata.encoding === CODEX_GAP_ENCODING ? new CodexGapDictionary() : undefined;
      try {
        for await (const line of readBoundedLines(stream, MAX_ENTRY_BYTES)) {
          if (input.signal?.aborted) throw new Error("transcript object read cancelled");
          if (line.length === 0) continue;
          let entry: TranscriptEntry;
          try {
            entry = parseStoredLine(line, codec, metadata.encoding === CODEX_GAP_ENCODING);
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
): CodexTimelineShadowReader {
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

  const reader: CodexTimelineShadowReader = { readRange };
  if (store.compareCodexTimelineShadow) reader.compareCodexTimelineShadow = async (input, native) => {
    if (input.orgId !== native.identity.orgId || input.run.id !== native.identity.runId
      || input.span.id !== native.identity.spanId || input.span.attemptId !== native.identity.attemptId
      || input.span.ownerToken !== native.identity.ownerToken || input.span.attemptEpoch !== native.identity.attemptEpoch) {
      return { ok: false, reason: "shadow_reader_identity_mismatch", authorizesOldObjectDelete: false };
    }
    return store.compareCodexTimelineShadow!({
      objectRef: String(input.span.supplementalObjectRef ?? ""), identity: native.identity, native,
    });
  };
  return reader;
}
