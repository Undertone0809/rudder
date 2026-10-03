import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

/** Pure classification only. No persistence, cleanup, or provider authority. */
export const CODEX_MIXED_COVERAGE_VERSION = "codex-mixed-supplement-v2" as const;

export type CoverageIdentity = {
  orgId: string;
  runId: string;
  spanId: string;
  attemptId: string;
  attemptEpoch: number;
  ownerToken: string;
  selector: { kind: "codex_turn"; runId: string; threadId: string; turnId: string };
};

type Entry = Record<string, unknown>;
export type CodexMixedCoverageInput = {
  expected: CoverageIdentity;
  supplement: {
    identity: CoverageIdentity;
    objectRef: string;
    /** Exact committed NDJSON bytes; never a reserialized projection. */
    bytes: Uint8Array;
    sha256: string;
    entryCount: number;
    state: "sealed";
  };
  native: {
    identity: CoverageIdentity;
    source: "native";
    availability: "available";
    completeness: "complete";
    revisionBefore: string;
    revisionAfter: string;
    entries: readonly Entry[];
  };
};

export type CodexMixedCoverageResult = {
  ok: false;
  reason: string;
  authorizesOldObjectDelete: false;
} | {
  ok: true;
  version: typeof CODEX_MIXED_COVERAGE_VERSION;
  bindingSha256: string;
  objectSha256: string;
  nativeRevision: string;
  mappings: Array<{ supplementIndices: number[]; nativeSourceEntryId: string; kind: string }>;
  /** Semantic equivalence is not byte/timeline equivalence. Until an exact
   * timeline/serialization locator exists, retain EVERY original line. */
  residualIndices: number[];
  residualBytes: Uint8Array;
  residualSha256: string;
  authorizesOldObjectDelete: false;
};

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const string = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const record = (v: unknown): v is Entry => Boolean(v && typeof v === "object" && !Array.isArray(v));
const fail = (reason: string): Extract<CodexMixedCoverageResult, { ok: false }> => ({ ok: false, reason, authorizesOldObjectDelete: false });

function validIdentity(v: CoverageIdentity): boolean {
  return [v.orgId, v.runId, v.spanId, v.attemptId, v.ownerToken].every(string)
    && Number.isSafeInteger(v.attemptEpoch) && v.attemptEpoch >= 0
    && v.selector?.kind === "codex_turn" && v.selector.runId === v.runId
    && string(v.selector.threadId) && string(v.selector.turnId);
}

const keys: Record<string, readonly string[]> = {
  assistant: ["text", "delta", "phase", "segmentId"],
  user: ["text", "messageId"],
  system: ["text"],
  stdout: ["text"],
  stderr: ["text"],
  init: ["model", "sessionId"],
  tool_call: ["name", "input", "toolUseId"],
  tool_result: ["toolName", "content", "toolUseId", "isError"],
};

function validEntry(e: Entry): boolean {
  if (!string(e.kind) || !keys[e.kind] || !string(e.sourceEntryId)
    || !string(e.ts) || !Number.isFinite(Date.parse(e.ts))) return false;
  const allowed = new Set(["kind", "ts", "sourceEntryId", ...keys[e.kind]]);
  if (Object.keys(e).some((k) => !allowed.has(k))) return false;
  if (["assistant", "user", "system", "stdout", "stderr"].includes(e.kind)
    && typeof e.text !== "string") return false;
  if (e.kind === "init" && (!string(e.model) || !string(e.sessionId))) return false;
  if (e.kind === "tool_call" && (!string(e.name) || !string(e.toolUseId) || !record(e.input))) return false;
  if (e.kind === "tool_result" && (!string(e.toolName) || !string(e.toolUseId)
    || typeof e.content !== "string" || typeof e.isError !== "boolean")) return false;
  return true;
}

function callCovered(a: Entry, b: Entry): boolean {
  if (!record(a.invocation) || !record(b.invocation) || b.invocation.status !== "completed") return false;
  if (a.invocation.status === "completed") return isDeepStrictEqual(a, b);
  // Only this observed Codex transition is admitted. Keep the original started
  // row as residual: timestamps and lifecycle evidence are NOT native-covered.
  if (a.invocation.status !== "inProgress") return false;
  const lifecycle = ["status", "result", "durationMs", "content"];
  const start = a.invocation;
  if (["result", "durationMs", "content"].some((k) => start[k] !== null)
    || typeof b.invocation.durationMs !== "number" || !Number.isFinite(b.invocation.durationMs)
    || b.invocation.durationMs < 0 || b.invocation.result === undefined || b.invocation.content === undefined) return false;
  const strip = (v: Entry) => Object.fromEntries(Object.entries(v).filter(([k]) => !lifecycle.includes(k)));
  return isDeepStrictEqual({ ...a, invocation: strip(a.invocation) }, { ...b, invocation: strip(b.invocation) });
}

/** Caller must obtain the identity and complete native range from attested
 * storage/reader sources. Hashes bind evidence, not the truth of caller input.
 * Success NEVER licenses deletion; residual handoff is a separate future gate.
 */
export function proveCodexMixedSupplementCoverage(input: CodexMixedCoverageInput): CodexMixedCoverageResult {
  try {
    if (!validIdentity(input.expected) || !isDeepStrictEqual(input.expected, input.supplement.identity)
      || !isDeepStrictEqual(input.expected, input.native.identity)) return fail("identity_mismatch");
    const { supplement: s, native: n } = input;
    if (s.state !== "sealed" || !/^tobj_v1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(s.objectRef)
      || s.bytes.byteLength > 2 * 1024 * 1024 || !Number.isSafeInteger(s.entryCount)
      || s.entryCount < 1 || s.entryCount > 256 || sha(s.bytes) !== s.sha256) return fail("object_binding_mismatch");
    if (n.source !== "native" || n.availability !== "available" || n.completeness !== "complete"
      || !string(n.revisionBefore) || n.revisionBefore !== n.revisionAfter) return fail("native_revision_or_boundary_mismatch");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(s.bytes);
    if (!text.endsWith("\n")) return fail("object_incomplete_line");
    const lines = text.slice(0, -1).split("\n");
    if (lines.length !== s.entryCount) return fail("object_count_mismatch");
    const entries: Entry[] = lines.map((line) => {
      const row: unknown = JSON.parse(line);
      if (!record(row) || row.version !== 1 || Object.keys(row).length !== 2 || !record(row.entry)) throw new Error();
      return row.entry;
    });
    if (n.entries.length < 1 || n.entries.length > 256
      || [...entries, ...n.entries].some((e) => !validEntry(e))) return fail("unknown_entry_or_scope");
    if (Buffer.byteLength(JSON.stringify(n.entries), "utf8") > 2 * 1024 * 1024) return fail("native_size_limit");
    if (new Set(entries.map((e) => e.sourceEntryId)).size !== entries.length) return fail("duplicate_supplement_id");
    const nativeKeys = n.entries.map((e) => `${e.kind}:${e.sourceEntryId}`);
    if (new Set(nativeKeys).size !== nativeKeys.length) return fail("duplicate_native_id");
    // A single tool item expands to call+result sharing a source ID. No other
    // reuse is accepted, even across different kinds.
    const bySource = new Map<unknown, Entry[]>();
    for (const e of n.entries) bySource.set(e.sourceEntryId, [...(bySource.get(e.sourceEntryId) ?? []), e]);
    if ([...bySource.values()].some((es) => es.length > 1
      && !(es.length === 2 && es[0].kind === "tool_call" && es[1].kind === "tool_result"
        && es[0].toolUseId === es[1].toolUseId))) return fail("ambiguous_native_id");

    const mappings: Extract<CodexMixedCoverageResult, { ok: true }>["mappings"] = [];
    // Ordered text concatenation and tool equivalence do not prove original
    // timestamps, chunk boundaries, projection IDs, or serialized bytes. This
    // slice intentionally saves zero bytes rather than lose those facts.
    const residual = new Set(entries.map((_entry, index) => index));
    const usedNative = new Set<number>();
    const seenSegments = new Set<string>();
    const seenCalls = new Set<string>();
    const seenResults = new Set<string>();
    let lastNativeIndex = -1;
    const map = (indices: number[], nativeIndex: number, kind: string) => {
      if (nativeIndex <= lastNativeIndex || usedNative.has(nativeIndex)) throw new Error();
      lastNativeIndex = nativeIndex;
      usedNative.add(nativeIndex);
      mappings.push({ supplementIndices: indices, nativeSourceEntryId: String(n.entries[nativeIndex].sourceEntryId), kind });
    };
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      if (["stdout", "stderr", "system", "init"].includes(String(e.kind))) {
        if (e.kind === "init" && e.sessionId !== input.expected.selector.threadId) return fail("init_session_mismatch");
        residual.add(i);
        continue;
      }
      if (e.kind === "assistant") {
        if (e.delta !== true || !string(e.segmentId)
          || !["commentary", "final_answer"].includes(String(e.phase)) || seenSegments.has(e.segmentId)) return fail("ambiguous_segment");
        seenSegments.add(e.segmentId);
        const indices = [i];
        let combined = String(e.text);
        while (i + 1 < entries.length && entries[i + 1].kind === "assistant"
          && entries[i + 1].segmentId === e.segmentId) {
          const next = entries[++i];
          if (next.delta !== true || next.phase !== e.phase) return fail("chunk_phase_mismatch");
          indices.push(i);
          combined += next.text;
        }
        const candidates = n.entries.map((v, index) => ({ v, index })).filter(({ v }) =>
          v.kind === "assistant" && v.segmentId === e.segmentId && v.phase === e.phase && v.delta !== true);
        if (candidates.length !== 1 || candidates[0].v.text !== combined) return fail("segment_text_mismatch");
        map(indices, candidates[0].index, "ordered_text");
        continue;
      }
      if (e.kind !== "tool_call" && e.kind !== "tool_result") return fail("unsupported_supplement_kind");
      const id = String(e.toolUseId);
      const seen = e.kind === "tool_call" ? seenCalls : seenResults;
      if (seen.has(id) || (e.kind === "tool_result" && !seenCalls.has(id))) return fail("duplicate_or_unpaired_tool");
      seen.add(id);
      const candidates = n.entries.map((v, index) => ({ v, index })).filter(({ v }) => v.kind === e.kind && v.toolUseId === id);
      if (candidates.length !== 1) return fail("ambiguous_tool");
      const b = candidates[0].v;
      if (e.kind === "tool_call") {
        for (const call of [e, b]) {
          const payload = call.input as Entry;
          if (!record(payload.invocation) || payload.id !== id || payload.invocation.id !== id
            || !string(payload.server) || !string(payload.tool)
            || payload.server !== payload.invocation.server || payload.tool !== payload.invocation.tool
            || call.name !== `mcp__${payload.server}__${payload.tool}`
            || !Object.hasOwn(payload, "args") || !Object.hasOwn(payload.invocation, "arguments")
            || !isDeepStrictEqual(payload.args, payload.invocation.arguments)) return fail("tool_identity_or_arguments_mismatch");
        }
        if (e.name !== b.name || !callCovered(e.input as Entry, b.input as Entry)) return fail("tool_call_mismatch");
        residual.add(i);
      } else if (e.toolName !== b.toolName || e.content !== b.content || e.isError !== b.isError
        || e.toolName !== entries.find((v) => v.kind === "tool_call" && v.toolUseId === id)?.name) return fail("tool_result_mismatch");
      map([i], candidates[0].index, String(e.kind));
    }
    if (seenCalls.size !== seenResults.size || [...seenCalls].some((id) => !seenResults.has(id))) return fail("unpaired_tool");
    if (n.entries.some((e, i) => ["assistant", "tool_call", "tool_result"].includes(String(e.kind)) && !usedNative.has(i))) return fail("native_semantic_entry_unmatched");
    const residualIndices = [...residual].sort((a, b) => a - b);
    // Copy the committed bytes, not decoded/re-encoded JSON: preserve encoding,
    // whitespace, line endings and any original UTF-8 BOM as well as all rows.
    const residualBytes = Buffer.from(s.bytes);
    // Bind complete entry snapshots as well as revision: changing content under
    // a reused revision must not yield the same proof seal.
    const bindingSha256 = sha(JSON.stringify({ version: CODEX_MIXED_COVERAGE_VERSION,
      identity: input.expected, objectRef: s.objectRef, objectSha256: s.sha256,
      nativeRevision: n.revisionBefore, nativeEntries: n.entries, mappings,
      residualIndices, residualSha256: sha(residualBytes) }));
    return { ok: true, version: CODEX_MIXED_COVERAGE_VERSION, bindingSha256,
      objectSha256: s.sha256, nativeRevision: n.revisionBefore, mappings,
      residualIndices, residualBytes, residualSha256: sha(residualBytes), authorizesOldObjectDelete: false };
  } catch {
    return fail("malformed_or_ambiguous_evidence");
  }
}

export type CodexByteTimeline = {
  version: "codex-byte-timeline-v1";
  objectRef: string;
  originalSha256: string;
  originalBytes: number;
  identitySha256: string;
  nativeRevision: string;
  nativeEntriesSha256: string;
  residualSha256: string;
  residualBytes: Uint8Array;
  references: Array<{ kind: "assistant" | "tool_result"; sourceEntryId: string; field: "text" | "content" }>;
  /** 0 = exact residual offset/length; 1 = reference index/UTF-16 slice bounds.
   * Each native slice is encoded as a JSON string token, including quotes. */
  pieces: Array<[0, number, number] | [1, number, number, number]>;
};

/** Exact storage-size model: raw binary residual plus compact UTF-8 JSON
 * metadata. No compression, database overhead, or durable handoff is claimed. */
export function codexTimelineReferenceBytes(timeline: CodexByteTimeline): number {
  const { residualBytes: _bytes, ...metadata } = timeline;
  return Buffer.byteLength(JSON.stringify(metadata), "utf8");
}

// Locate a string value without regex-matching text inside JSON strings. This
// bounded lexical walk does not change parsing/Reader semantics. Duplicate keys
// anywhere are ambiguous and rejected, not silently resolved by JSON.parse.
function stringTokenRange(line: string, field: string): [number, number] | null {
  let pos = line.charCodeAt(0) === 0xfeff ? 1 : 0;
  let found: [number, number] | null = null;
  const white = () => { while (/\s/u.test(line[pos] ?? "") && pos < line.length) pos += 1; };
  const token = (): [number, number] => {
    const start = pos++;
    while (pos < line.length) {
      const ch = line[pos++];
      if (ch === "\\") pos += 1;
      else if (ch === '"') return [start, pos];
    }
    throw new Error("unterminated string");
  };
  const value = (path: string[], depth: number): void => {
    if (depth > 40) throw new Error("json nesting limit");
    white();
    if (line[pos] === '"') {
      const range = token();
      if (path.length === 2 && path[0] === "entry" && path[1] === field) found = range;
    } else if (line[pos] === "{") {
      pos += 1;
      white();
      const seen = new Set<string>();
      while (line[pos] !== "}") {
        if (line[pos] !== '"') throw new Error("invalid key");
        const [a, b] = token();
        const key = JSON.parse(line.slice(a, b)) as string;
        if (seen.has(key)) throw new Error("duplicate key");
        seen.add(key);
        white();
        if (line[pos++] !== ":") throw new Error("invalid separator");
        value([...path, key], depth + 1);
        white();
        if (line[pos] === "}") break;
        if (line[pos++] !== ",") throw new Error("invalid separator");
        white();
      }
      pos += 1;
    } else if (line[pos] === "[") {
      pos += 1;
      white();
      while (line[pos] !== "]") {
        value([...path, "[]"], depth + 1);
        white();
        if (line[pos] === "]") break;
        if (line[pos++] !== ",") throw new Error("invalid separator");
      }
      pos += 1;
    } else {
      const start = pos;
      while (pos < line.length && !/[\s,}\]]/u.test(line[pos])) pos += 1;
      if (start === pos) throw new Error("invalid value");
    }
  };
  value([], 0);
  white();
  if (pos !== line.length) throw new Error("trailing bytes");
  return found;
}

export function reconstructCodexByteTimeline(input: {
  expected: CoverageIdentity;
  expectedObject: { objectRef: string; sha256: string };
  native: CodexMixedCoverageInput["native"];
  timeline: CodexByteTimeline;
}): { ok: true; bytes: Uint8Array; sha256: string; authorizesOldObjectDelete: false }
  | Extract<CodexMixedCoverageResult, { ok: false }> {
  try {
    const { timeline: t, native: n } = input;
    if (n.entries.length < 1 || n.entries.length > 256
      || Buffer.byteLength(JSON.stringify(n.entries), "utf8") > 2 * 1024 * 1024) return fail("timeline_native_size_limit");
    if (t.version !== "codex-byte-timeline-v1" || !validIdentity(input.expected)
      || !isDeepStrictEqual(input.expected, n.identity) || sha(JSON.stringify(input.expected)) !== t.identitySha256
      || t.objectRef !== input.expectedObject.objectRef || t.originalSha256 !== input.expectedObject.sha256
      || n.source !== "native" || n.availability !== "available" || n.completeness !== "complete"
      || n.revisionBefore !== t.nativeRevision || n.revisionAfter !== t.nativeRevision
      || sha(JSON.stringify(n.entries)) !== t.nativeEntriesSha256) return fail("timeline_identity_or_native_drift");
    if (!Number.isSafeInteger(t.originalBytes) || t.originalBytes < 1 || t.originalBytes > 2 * 1024 * 1024
      || t.residualBytes.byteLength > t.originalBytes || sha(t.residualBytes) !== t.residualSha256
      || t.references.length > 256 || t.pieces.length > 513) return fail("timeline_bounds_or_residual_digest");
    const references = t.references.map((ref) => {
      if (!((ref.kind === "assistant" && ref.field === "text") || (ref.kind === "tool_result" && ref.field === "content"))) throw new Error();
      const matches = n.entries.filter((e) => e.kind === ref.kind && e.sourceEntryId === ref.sourceEntryId);
      if (matches.length !== 1 || typeof matches[0][ref.field] !== "string") throw new Error();
      return matches[0][ref.field] as string;
    });
    if (new Set(t.references.map((r) => JSON.stringify(r))).size !== t.references.length) return fail("timeline_duplicate_reference");
    const parts: Uint8Array[] = [];
    let residualOffset = 0;
    let outputBytes = 0;
    const usedReferences = new Set<number>();
    for (const piece of t.pieces) {
      if (!piece.every(Number.isSafeInteger)) return fail("timeline_piece_bounds");
      let bytes: Uint8Array;
      if (piece[0] === 0 && piece.length === 3) {
        if (piece[1] !== residualOffset || piece[2] <= 0 || piece[1] + piece[2] > t.residualBytes.byteLength) return fail("timeline_residual_order");
        bytes = t.residualBytes.slice(piece[1], piece[1] + piece[2]);
        residualOffset += piece[2];
      } else if (piece[0] === 1 && piece.length === 4) {
        const text = references[piece[1]];
        if (text === undefined || piece[2] < 0 || piece[3] < piece[2] || piece[3] > text.length) return fail("timeline_native_slice_bounds");
        usedReferences.add(piece[1]);
        bytes = Buffer.from(JSON.stringify(text.slice(piece[2], piece[3])), "utf8");
      } else return fail("timeline_unknown_piece");
      outputBytes += bytes.byteLength;
      if (outputBytes > t.originalBytes) return fail("timeline_output_bounds");
      parts.push(bytes);
    }
    if (residualOffset !== t.residualBytes.byteLength || usedReferences.size !== references.length) return fail("timeline_unconsumed_evidence");
    const bytes = Buffer.concat(parts);
    if (bytes.byteLength !== t.originalBytes || sha(bytes) !== input.expectedObject.sha256) return fail("timeline_reconstruction_digest_mismatch");
    return { ok: true, bytes, sha256: sha(bytes), authorizesOldObjectDelete: false };
  } catch {
    return fail("timeline_malformed_or_ambiguous");
  }
}

/** Keep every unproved byte literal. Only canonical JSON string tokens already
 * proved by v2 may be replaced by native references. All timestamps, source IDs,
 * chunk boundaries, tool lifecycle snapshots and formatting remain reversible.
 * This is an in-memory representation, NEVER persistence/deletion authority. */
export function buildCodexByteTimeline(input: CodexMixedCoverageInput): {
  ok: true;
  timeline: CodexByteTimeline;
  reconstructedSha256: string;
  sizes: { originalBytes: number; residualBytes: number; referenceBytes: number; totalBytes: number; savedBytes: number };
  authorizesOldObjectDelete: false;
} | Extract<CodexMixedCoverageResult, { ok: false }> {
  const coverage = proveCodexMixedSupplementCoverage(input);
  if (!coverage.ok) return coverage;
  try {
    const source = Buffer.from(input.supplement.bytes);
    const lines: Array<{ bytes: Buffer; start: number; entry: Entry; text: string }> = [];
    let offset = 0;
    while (offset < source.byteLength) {
      const end = source.indexOf(10, offset);
      const bytes = source.subarray(offset, end + 1);
      const text = bytes.toString("utf8");
      const parsed = JSON.parse(text.replace(/^\ufeff/u, "")) as { entry: Entry };
      // Walk every row, even uncovered diagnostics; never hide ambiguous JSON.
      stringTokenRange(text, "text");
      lines.push({ bytes, start: offset, entry: parsed.entry, text });
      offset = end + 1;
    }
    const replacements: Array<{ start: number; end: number; ref: number; from: number; to: number }> = [];
    const references: CodexByteTimeline["references"] = [];
    for (const mapping of coverage.mappings) {
      if (mapping.kind !== "ordered_text" && mapping.kind !== "tool_result") continue;
      const kind = mapping.kind === "ordered_text" ? "assistant" : "tool_result";
      const field = kind === "assistant" ? "text" : "content";
      let from = 0;
      for (const index of mapping.supplementIndices) {
        const line = lines[index];
        const value = line.entry[field] as string;
        const range = stringTokenRange(line.text, field);
        const to = from + value.length;
        if (range && line.text.slice(...range) === JSON.stringify(value)) {
          const refValue = { kind, sourceEntryId: mapping.nativeSourceEntryId, field } as CodexByteTimeline["references"][number];
          let ref = references.findIndex((r) => isDeepStrictEqual(r, refValue));
          if (ref === -1) { ref = references.length; references.push(refValue); }
          replacements.push({ start: line.start + Buffer.byteLength(line.text.slice(0, range[0]), "utf8"),
            end: line.start + Buffer.byteLength(line.text.slice(0, range[1]), "utf8"), ref, from, to });
        }
        from = to;
      }
    }
    const pieces: CodexByteTimeline["pieces"] = [];
    const literals: Buffer[] = [];
    let cursor = 0;
    let residualOffset = 0;
    const literal = (end: number) => {
      if (end > cursor) {
        const bytes = source.subarray(cursor, end);
        pieces.push([0, residualOffset, bytes.byteLength]);
        literals.push(bytes);
        residualOffset += bytes.byteLength;
      }
    };
    for (const replacement of replacements) {
      if (replacement.start < cursor) return fail("timeline_overlapping_replacements");
      literal(replacement.start);
      pieces.push([1, replacement.ref, replacement.from, replacement.to]);
      cursor = replacement.end;
    }
    literal(source.byteLength);
    const residualBytes = Buffer.concat(literals);
    const timeline: CodexByteTimeline = { version: "codex-byte-timeline-v1", objectRef: input.supplement.objectRef,
      originalSha256: input.supplement.sha256, originalBytes: source.byteLength,
      identitySha256: sha(JSON.stringify(input.expected)), nativeRevision: input.native.revisionBefore,
      nativeEntriesSha256: sha(JSON.stringify(input.native.entries)), residualSha256: sha(residualBytes), residualBytes, references, pieces };
    const reconstructed = reconstructCodexByteTimeline({ expected: input.expected,
      expectedObject: { objectRef: input.supplement.objectRef, sha256: input.supplement.sha256 }, native: input.native, timeline });
    if (!reconstructed.ok) return reconstructed;
    const referenceBytes = codexTimelineReferenceBytes(timeline);
    const totalBytes = residualBytes.byteLength + referenceBytes;
    return { ok: true, timeline, reconstructedSha256: reconstructed.sha256,
      sizes: { originalBytes: source.byteLength, residualBytes: residualBytes.byteLength,
        referenceBytes, totalBytes, savedBytes: source.byteLength - totalBytes }, authorizesOldObjectDelete: false };
  } catch {
    return fail("timeline_malformed_or_ambiguous");
  }
}
