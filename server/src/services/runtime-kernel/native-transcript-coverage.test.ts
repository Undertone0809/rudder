import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCodexByteTimeline,
  type CodexMixedCoverageInput,
  proveCodexMixedSupplementCoverage,
  reconstructCodexByteTimeline,
} from "./native-transcript-coverage.js";

const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const ts = "2026-01-01T00:00:00.000Z";
const identity = { orgId: "org-test", runId: "run-test", spanId: "span-test", attemptId: "attempt-test",
  attemptEpoch: 1, ownerToken: "synthetic-owner", selector: { kind: "codex_turn" as const,
    runId: "run-test", threadId: "synthetic-thread", turnId: "synthetic-turn" } };

function fixture(shape: 61 | 78 = 61): CodexMixedCoverageInput {
  const counts = shape === 61 ? [12, 16] : [17, 28];
  const invocation = { id: "tool-1", server: "synthetic", tool: "lookup", arguments: { query: "界🌍" },
    status: "inProgress", result: null, durationMs: null, content: null };
  const input = { id: "tool-1", server: "synthetic", tool: "lookup", invocation, args: invocation.arguments };
  const rows: Record<string, unknown>[] = Array.from({ length: 27 }, (_, i) => ({ kind: "stdout", text: `diagnostic-${i}`, ts }));
  rows.push({ kind: "init", model: "synthetic-model", sessionId: identity.selector.threadId, ts });
  rows.push(...["turn started", "reasoning started", "reasoning completed"].map((text) => ({ kind: "system", text, ts })));
  const chunks = (phase: string, count: number) => Array.from({ length: count }, (_, i) => ({ kind: "assistant", ts,
    text: `界${i}🌍`, delta: true, phase, segmentId: phase }));
  rows.push(...chunks("commentary", counts[0]));
  rows.push({ kind: "tool_call", ts, name: "mcp__synthetic__lookup", toolUseId: "tool-1", input });
  rows.push({ kind: "tool_result", ts, toolName: "mcp__synthetic__lookup", toolUseId: "tool-1", content: '{"ok":true}', isError: false });
  rows.push(...chunks("final_answer", counts[1]));
  rows.forEach((row, i) => { row.sourceEntryId = `supplement-${i}`; });
  const native = [
    { kind: "user", text: "synthetic request", ts, sourceEntryId: "native-user" },
    { kind: "system", text: "reasoning completed", ts, sourceEntryId: "native-reasoning" },
    { kind: "assistant", ts, phase: "commentary", segmentId: "commentary", sourceEntryId: "native-commentary",
      text: chunks("commentary", counts[0]).map((e) => e.text).join("") },
    { ...rows.find((e) => e.kind === "tool_call"), sourceEntryId: "tool-1", input: { ...input,
      invocation: { ...invocation, status: "completed", durationMs: 10, result: { content: "ok" }, content: ["ok"] } } },
    { ...rows.find((e) => e.kind === "tool_result"), sourceEntryId: "tool-1" },
    { kind: "assistant", ts, phase: "final_answer", segmentId: "final_answer", sourceEntryId: "native-final",
      text: chunks("final_answer", counts[1]).map((e) => e.text).join("") },
  ];
  const bytes = Buffer.from(rows.map((entry) => JSON.stringify({ version: 1, entry })).join("\n") + "\n");
  return { expected: structuredClone(identity), supplement: { identity: structuredClone(identity),
    objectRef: "tobj_v1_00000000-0000-0000-0000-000000000001", bytes, sha256: sha(bytes), entryCount: rows.length, state: "sealed" },
  native: { identity: structuredClone(identity), source: "native", availability: "available", completeness: "complete",
    revisionBefore: "revision-1", revisionAfter: "revision-1", entries: native } };
}

function edit(input: CodexMixedCoverageInput, change: (entries: Record<string, unknown>[]) => void) {
  const rows = Buffer.from(input.supplement.bytes).toString().trimEnd().split("\n").map((line) => JSON.parse(line).entry);
  change(rows);
  input.supplement.bytes = Buffer.from(rows.map((entry) => JSON.stringify({ version: 1, entry })).join("\n") + "\n");
  input.supplement.sha256 = sha(input.supplement.bytes);
  input.supplement.entryCount = rows.length;
}

describe("Codex mixed supplement coverage: classification, never deletion", () => {
  it.each([61, 78] as const)("proves synthetic %i shape, preserving exact diagnostics/lifecycle bytes", (shape) => {
    const input = fixture(shape);
    expect(input.supplement.entryCount).toBe(shape);
    const result = proveCodexMixedSupplementCoverage(input);
    expect(result.ok).toBe(true);
    expect(result.authorizesOldObjectDelete).toBe(false);
    if (!result.ok) return;
    expect(result.mappings).toHaveLength(4);
    expect(result.residualIndices).toHaveLength(shape);
    expect(Buffer.from(result.residualBytes)).toEqual(Buffer.from(input.supplement.bytes));
    expect(result.residualSha256).toBe(input.supplement.sha256);
    const lines = Buffer.from(input.supplement.bytes).toString().trimEnd().split("\n");
    expect(Buffer.from(result.residualBytes).toString()).toBe(result.residualIndices.map((i) => lines[i] + "\n").join(""));
    expect(result.residualSha256).toBe(sha(result.residualBytes));
    expect(proveCodexMixedSupplementCoverage(input)).toEqual(result);
    expect(proveCodexMixedSupplementCoverage(input)).not.toHaveProperty("cleanupAuthorized", true);
  });

  const failures: Array<[string, (input: CodexMixedCoverageInput) => void]> = [
    ["cross Run", (x) => { x.native.identity.runId = "other"; }],
    ["org", (x) => { x.supplement.identity.orgId = "other"; }],
    ["span", (x) => { x.native.identity.spanId = "other"; }],
    ["attempt", (x) => { x.native.identity.attemptId = "other"; }],
    ["owner", (x) => { x.native.identity.ownerToken = "other"; }],
    ["epoch", (x) => { x.native.identity.attemptEpoch += 1; }],
    ["selector", (x) => { x.native.identity.selector.turnId = "other"; }],
    ["revision drift", (x) => { x.native.revisionAfter = "other"; }],
    ["partial native", (x) => { Object.assign(x.native, { completeness: "partial" }); }],
    ["object digest", (x) => { x.supplement.sha256 = "bad"; }],
    ["object count", (x) => { x.supplement.entryCount += 1; }],
    ["missing line terminator", (x) => { x.supplement.bytes = x.supplement.bytes.slice(0, -1); x.supplement.sha256 = sha(x.supplement.bytes); }],
    ["invalid UTF8", (x) => { x.supplement.bytes = Uint8Array.from([255, 10]); x.supplement.sha256 = sha(x.supplement.bytes); }],
    ["unknown", (x) => edit(x, (r) => { r[0].kind = "unknown"; })],
    ["unrecognized reasoning kind", (x) => edit(x, (r) => { r[29].kind = "reasoning"; })],
    ["unrecognized field", (x) => edit(x, (r) => { r[0].privateExtra = "not discardable"; })],
    ["row scope", (x) => edit(x, (r) => { r[0].runId = "other"; })],
    ["duplicate source ID", (x) => edit(x, (r) => { r[1].sourceEntryId = r[0].sourceEntryId; })],
    ["missing chunk", (x) => edit(x, (r) => { r.splice(32, 1); })],
    ["chunk order", (x) => edit(x, (r) => { [r[32], r[33]] = [r[33], r[32]]; })],
    ["chunk phase", (x) => edit(x, (r) => { r[32].phase = "final_answer"; })],
    ["noncontiguous segment", (x) => edit(x, (r) => { [r[32], r[43]] = [r[43], r[32]]; })],
    ["duplicate native segment", (x) => { x.native.entries = [...x.native.entries, x.native.entries[2]]; }],
    ["duplicate call", (x) => edit(x, (r) => { r.splice(44, 0, { ...r[43], sourceEntryId: "duplicate" }); })],
    ["duplicate result", (x) => edit(x, (r) => { r.splice(45, 0, { ...r[44], sourceEntryId: "duplicate" }); })],
    ["native source ID ambiguity", (x) => { x.native.entries[2].sourceEntryId = x.native.entries[0].sourceEntryId; }],
    ["missing result", (x) => edit(x, (r) => { r.splice(44, 1); })],
    ["tool args", (x) => { (x.native.entries[3].input as { args: unknown }).args = { changed: true }; }],
    ["tool name", (x) => { x.native.entries[3].name = "other"; }],
    ["payload tool ID", (x) => { (x.native.entries[3].input as Record<string, unknown>).id = "other"; }],
    ["incomplete native tool", (x) => { ((x.native.entries[3].input as Record<string, unknown>).invocation as Record<string, unknown>).status = "inProgress"; }],
    ["tool result", (x) => { x.native.entries[4].content = "other"; }],
    ["tool error", (x) => { x.native.entries[4].isError = true; }],
    ["unknown lifecycle", (x) => { ((x.native.entries[3].input as Record<string, unknown>).invocation as Record<string, unknown>).status = "failed"; }],
    ["started snapshot already has result", (x) => edit(x, (r) => {
      ((r[43].input as Record<string, unknown>).invocation as Record<string, unknown>).result = { diagnostic: "must not discard" };
    })],
    ["init session", (x) => edit(x, (r) => { r[27].sessionId = "other"; })],
  ];
  it.each(failures)("fails closed for %s", (_name, change) => {
    const input = fixture();
    change(input);
    expect(proveCodexMixedSupplementCoverage(input)).toMatchObject({ ok: false, authorizesOldObjectDelete: false });
  });
  it("binds residual byte changes and native snapshots in the proof seal", () => {
    const input = fixture();
    const before = proveCodexMixedSupplementCoverage(input);
    edit(input, (r) => { r[0].text = "different retained diagnostic"; });
    const after = proveCodexMixedSupplementCoverage(input);
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok) {
      expect(before.bindingSha256).not.toBe(after.bindingSha256);
      expect(before.residualSha256).not.toBe(after.residualSha256);
      expect(after.authorizesOldObjectDelete).toBe(false);
    }
  });

  it.each(["chunk", "result"])("retains unproved %s timestamps and original chunk boundaries", (kind) => {
    const input = fixture();
    const index = kind === "chunk" ? 32 : 44;
    edit(input, (rows) => { rows[index].ts = "2026-01-01T00:00:01.123Z"; });
    const result = proveCodexMixedSupplementCoverage(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.residualIndices).toContain(index);
    const originalLines = Buffer.from(input.supplement.bytes).toString().trimEnd().split("\n");
    expect(Buffer.from(result.residualBytes).toString()).toContain(originalLines[index] + "\n");
    expect(result.authorizesOldObjectDelete).toBe(false);
  });

  it("retains original serialization bytes including BOM, whitespace and CRLF", () => {
    const input = fixture();
    const rows = Buffer.from(input.supplement.bytes).toString().trimEnd().split("\n").map((line) => JSON.parse(line));
    input.supplement.bytes = Buffer.from("\ufeff" + rows.map((row) => JSON.stringify({ entry: row.entry, version: row.version }) + " ").join("\r\n") + "\r\n");
    input.supplement.sha256 = sha(input.supplement.bytes);
    const result = proveCodexMixedSupplementCoverage(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.residualBytes)).toEqual(Buffer.from(input.supplement.bytes));
    expect(result.residualSha256).toBe(input.supplement.sha256);
  });
});

describe("reversible byte-exact Codex timeline, no cleanup authority", () => {
  function reconstruct(input: CodexMixedCoverageInput, timeline: Parameters<typeof reconstructCodexByteTimeline>[0]["timeline"]) {
    return reconstructCodexByteTimeline({ expected: input.expected, native: input.native,
      expectedObject: { objectRef: input.supplement.objectRef, sha256: input.supplement.sha256 }, timeline });
  }
  it.each([61, 78] as const)("reconstructs every original byte of synthetic %i mixed rows", (shape) => {
    const input = fixture(shape);
    edit(input, (rows) => { rows[32].ts = "2026-01-01T00:00:01.123Z"; rows[44].ts = "2026-01-01T00:00:02.456Z"; });
    const result = buildCodexByteTimeline(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reconstructedSha256).toBe(input.supplement.sha256);
    const read = reconstruct(input, result.timeline);
    expect(read.ok).toBe(true);
    if (read.ok) expect(Buffer.from(read.bytes)).toEqual(Buffer.from(input.supplement.bytes));
    expect(result.sizes.totalBytes).toBe(result.sizes.residualBytes + result.sizes.referenceBytes);
    expect(result.sizes.savedBytes).toBe(result.sizes.originalBytes - result.sizes.totalBytes);
    const { residualBytes: _residual, ...metadata } = result.timeline;
    const serialized = JSON.stringify(metadata);
    expect(result.sizes.referenceBytes).toBe(Buffer.byteLength(serialized, "utf8"));
    const reopened = reconstruct(input, { ...JSON.parse(serialized), residualBytes: Uint8Array.from(result.timeline.residualBytes) });
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(Buffer.from(reopened.bytes)).toEqual(Buffer.from(input.supplement.bytes));
    expect(result.authorizesOldObjectDelete).toBe(false);
    expect(read.authorizesOldObjectDelete).toBe(false);
    const residual = Buffer.from(result.timeline.residualBytes).toString();
    expect(residual).toContain("2026-01-01T00:00:01.123Z");
    expect(residual).toContain("2026-01-01T00:00:02.456Z");
    expect(residual).toContain("diagnostic-26");
    expect(residual).toContain('"status":"inProgress"');
  });

  it.each(["canonical", "noncanonical"])("preserves BOM, reordered keys, CRLF and %s Unicode encoding", (encoding) => {
    const input = fixture();
    const rows = Buffer.from(input.supplement.bytes).toString().trimEnd().split("\n").map((line) => JSON.parse(line));
    let text = "\ufeff" + rows.map((row) => JSON.stringify({ entry: row.entry, version: row.version }) + " \t").join("\r\n") + "\r\n";
    if (encoding === "noncanonical") text = text.replaceAll("界", "\\u754c");
    input.supplement.bytes = Buffer.from(text);
    input.supplement.sha256 = sha(input.supplement.bytes);
    const result = buildCodexByteTimeline(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const read = reconstruct(input, result.timeline);
    expect(read.ok).toBe(true);
    if (read.ok) expect(Buffer.from(read.bytes)).toEqual(Buffer.from(input.supplement.bytes));
    if (encoding === "noncanonical") expect(Buffer.from(result.timeline.residualBytes).toString()).toContain("\\u754c");
  });

  it("preserves chunks splitting a surrogate pair and JSON escapes", () => {
    const input = fixture();
    edit(input, (rows) => {
      rows[31].text = "\ud83c";
      rows[32].text = "\udf0d\n\"\\";
      input.native.entries[2].text = rows.filter((row) => row.kind === "assistant" && row.phase === "commentary").map((row) => row.text).join("");
    });
    const result = buildCodexByteTimeline(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const read = reconstruct(input, result.timeline);
    expect(read.ok).toBe(true);
    if (read.ok) expect(Buffer.from(read.bytes)).toEqual(Buffer.from(input.supplement.bytes));
  });

  it("counts all reference overhead and saves bytes for a large synthetic tool result", () => {
    const input = fixture();
    const content = "synthetic-safe-result界🌍".repeat(1000);
    edit(input, (rows) => { rows[44].content = content; });
    input.native.entries[4].content = content;
    const result = buildCodexByteTimeline(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sizes.savedBytes).toBeGreaterThan(0);
    expect(result.reconstructedSha256).toBe(input.supplement.sha256);
    expect(result.authorizesOldObjectDelete).toBe(false);
  });

  it("does not claim savings for tiny native fields", () => {
    const result = buildCodexByteTimeline(fixture());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sizes.savedBytes).toBeLessThan(0);
  });

  it("rejects duplicate JSON keys instead of dropping the hidden original value", () => {
    const input = fixture();
    input.supplement.bytes = Buffer.from(Buffer.from(input.supplement.bytes).toString().replace('"text":"diagnostic-0"', '"text":"hidden","text":"diagnostic-0"'));
    input.supplement.sha256 = sha(input.supplement.bytes);
    expect(buildCodexByteTimeline(input)).toMatchObject({ ok: false, reason: "timeline_malformed_or_ambiguous", authorizesOldObjectDelete: false });
  });

  it("rejects unknown reasoning rather than filtering it", () => {
    const input = fixture();
    edit(input, (rows) => { rows[29].kind = "reasoning"; });
    expect(buildCodexByteTimeline(input)).toMatchObject({ ok: false, reason: "unknown_entry_or_scope", authorizesOldObjectDelete: false });
  });

  const mutations: Array<[string, (input: CodexMixedCoverageInput, t: Parameters<typeof reconstructCodexByteTimeline>[0]["timeline"]) => void]> = [
    ["residual byte corruption", (_input, t) => { t.residualBytes[0] ^= 1; }],
    ["residual corruption with updated residual digest", (_input, t) => { t.residualBytes[0] ^= 1; t.residualSha256 = sha(t.residualBytes); }],
    ["residual reorder", (_input, t) => { t.pieces.reverse(); }],
    ["wrong slice", (_input, t) => { const p = t.pieces.find((p) => p[0] === 1); if (p?.[0] === 1) p[3] += 1; }],
    ["unknown piece", (_input, t) => { Object.assign(t.pieces[0], { 0: 9 }); }],
    ["source ID drift", (_input, t) => { t.references[0].sourceEntryId = "missing"; }],
    ["ambiguous ref", (_input, t) => { t.references.push(t.references[0]); }],
    ["scope drift", (input) => { input.native.identity.runId = "other"; }],
    ["revision drift", (input) => { input.native.revisionAfter = "other"; }],
    ["content drift under same revision", (input) => { input.native.entries[2].text = "other"; }],
    ["original digest change", (input) => { input.supplement.sha256 = "other"; }],
  ];
  it.each(mutations)("fails closed on %s", (_name, mutate) => {
    const input = fixture();
    const result = buildCodexByteTimeline(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    mutate(input, result.timeline);
    expect(reconstruct(input, result.timeline)).toMatchObject({ ok: false, authorizesOldObjectDelete: false });
  });
});
