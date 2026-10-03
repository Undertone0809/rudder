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
const fail = (reason: string): CodexMixedCoverageResult => ({ ok: false, reason, authorizesOldObjectDelete: false });

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
