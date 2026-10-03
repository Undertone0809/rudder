import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../middleware/logger.js";
import { readManifestTranscriptSnapshot } from "../chat-work-manifest.transcript-snapshot.js";
import type { CodexMixedCoverageInput, CoverageIdentity } from "./native-transcript-coverage.js";
import { createTranscriptObjectReader, createTranscriptObjectStore } from "./transcript-object-store.js";
import { createTranscriptReader, decodeTranscriptCursor, encodeTranscriptCursor, type NativeTranscriptReadInput, type TranscriptItem, type TranscriptPage } from "./transcript-reader.js";
import { stableHash } from "./transcript-reader.normalize.js";
import { databaseBinding, databaseRun, databaseSegment, databaseSpan, mockDatabase } from "./transcript-reader.test-support.js";

vi.mock("../../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const scope = { orgId: "org-1", runId: "run-1", principal: { type: "board" as const, orgId: "org-1", authorized: true } };
const row = (id: string, ordinal: number, kind = "assistant", sourceEntryId = id) => ({
  id, sourceEntryId, ordinal, kind, ts: `2026-09-22T00:00:${String(ordinal).padStart(2, "0")}.000Z`,
  runId: "run-1", spanId: "span-1", payload: { text: id },
});
function fixture(nativeRows: ReturnType<typeof row>[], objectRows: ReturnType<typeof row>[], terminal: "complete" | "partial" = "partial", budgets = {}) {
  let nativeRevision = "native-r1", objectRevision = "object-r1";
  const native = vi.fn(async (input: NativeTranscriptReadInput) => {
    const start = Number(input.cursor ?? 0), end = Math.min(nativeRows.length, start + input.limit!);
    return { items: nativeRows.slice(start, end), nextCursor: end < nativeRows.length ? String(end) : null,
      revision: nativeRevision, availability: "available" as const, completeness: end < nativeRows.length ? "partial" as const : terminal };
  });
  const object = vi.fn(async (input: NativeTranscriptReadInput) => {
    const start = Number(input.cursor ?? 0), end = Math.min(objectRows.length, start + input.limit!);
    return { items: objectRows.slice(start, end), nextCursor: end < objectRows.length ? String(end) : null,
      revision: objectRevision, availability: "available" as const, completeness: "complete" as const };
  });
  const span = databaseSpan("span-1", { supplementalObjectRef: "object-1" });
  const db = mockDatabase({ run: databaseRun({ chatConversationId: "chat-1", contextSnapshot: { transcriptSource: "native" } }),
    conversations: [{ id: "chat-1", orgId: "org-1", updatedAt: new Date("2026-09-22") }],
    spans: [span],
    bindings: [databaseBinding("span-1", { continuity: "native", conversationId: "chat-1" })], segments: [databaseSegment("span-1")] });
  const reader = createTranscriptReader(db as never, { nativeReader: { read: native }, objectReader: { read: object }, ...budgets });
  return { reader, native, object, span, changeNative: () => { nativeRevision = "native-r2"; }, changeObject: () => { objectRevision = "object-r2"; } };
}
async function collect(read: (cursor: string | null, index: number) => Promise<TranscriptPage>) {
  const items: TranscriptItem[] = [], pages: TranscriptPage[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < 50; index++) {
    const page = await read(cursor, index); pages.push(page); items.push(...page.items);
    if (!page.nextCursor) return { items, pages };
    expect(page.nextCursor).not.toBe(cursor); cursor = page.nextCursor;
  }
  throw new Error("test exceeded bounded pages");
}

describe("public Reader Codex shadow comparison keeps authoritative sources unchanged", () => {
  it.each(["valid", "corrupt", "missing-native", "partial-native", "native-throws"])("preserves normal source/fallback for %s", async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-codex-shadow-reader-"));
    try {
      const store = createTranscriptObjectStore(root);
      const identity: CoverageIdentity = { orgId: "org-1", runId: "run-1", spanId: "span-1", attemptId: "attempt-1",
        attemptEpoch: 1, ownerToken: "owner-1", selector: { kind: "codex_turn", runId: "run-1", threadId: "thread-1", turnId: "turn-1" } };
      const ts = "2026-01-01T00:00:00.000Z";
      const handle = await store.begin(identity);
      await store.append(handle, [{ kind: "system", ts, text: "reasoning started" },
        { kind: "assistant", ts, phase: "final_answer", delta: true, segmentId: "msg-1", text: "one" },
        { kind: "assistant", ts: "2026-01-01T00:00:01.123Z", phase: "final_answer", delta: true, segmentId: "msg-1", text: "two" }]);
      await store.finalize(handle, { completeness: "partial" });
      const native: CodexMixedCoverageInput["native"] = { identity, source: "native", availability: "available", completeness: "complete",
        revisionBefore: stableHash(["native-r1"]), revisionAfter: stableHash(["native-r1"]), entries: [{ kind: "assistant", ts, phase: "final_answer",
          segmentId: "msg-1", sourceEntryId: "msg-1", text: "onetwo" }] };
      expect(await store.writeCodexTimelineShadow!({ objectRef: handle.objectRef, identity, native, beforePublish: async () => true })).toMatchObject({ ok: true });
      if (mode === "corrupt") await fs.writeFile(path.join(root, "transcript-objects", "codex-timeline-shadows", handle.objectRef, "residual.bin"), "invalid");
      const run = databaseRun({ status: "succeeded", contextSnapshot: { transcriptSource: "native" } });
      const span = databaseSpan("span-1", { orgId: "org-1", state: "sealed", attemptId: "attempt-1", ownerToken: "owner-1",
        attemptEpoch: 1, writerLeaseReleasedAt: new Date(ts), selectorJson: identity.selector, supplementalObjectRef: handle.objectRef });
      const db = mockDatabase({ run, spans: [span], bindings: [databaseBinding("span-1", { runtimeType: "codex_local", continuity: "native" })],
        segments: [databaseSegment("span-1", { runtimeType: "codex_local", nativeSessionId: "thread-1" })] });
      const resolved = vi.fn(async () => {
        if (mode === "native-throws") throw new Error("synthetic native unavailable");
        return { entries: mode === "missing-native" ? [] : native.entries, revision: "native-r1",
          availability: mode === "missing-native" ? "offline" as const : "available" as const,
          completeness: mode === "partial-native" || mode === "missing-native" ? "partial" as const : "complete" as const };
      });
      const objectReader = createTranscriptObjectReader(store);
      const originalCompare = objectReader.compareCodexTimelineShadow!;
      const compare = vi.fn(originalCompare);
      objectReader.compareCodexTimelineShadow = compare;
      const fallback = vi.spyOn(objectReader, "readRange");
      const reader = createTranscriptReader(db as never, { nativeReader: { readRange: resolved }, objectReader });
      if (mode === "native-throws") {
        await expect(reader.readRun({ ...scope, limit: 200 })).rejects.toThrow("synthetic native unavailable");
        expect(compare).not.toHaveBeenCalled();
      } else {
        const page = await reader.readRun({ ...scope, limit: 200 });
        if (mode === "valid" || mode === "corrupt") {
          expect(compare).toHaveBeenCalledOnce();
          expect(page).toMatchObject({ source: "native", availability: "available", completeness: "complete", nextCursor: null });
          expect(page.items.map((item) => item.entry?.kind)).toEqual(["assistant"]);
          expect(page.items[0].entry).toEqual(native.entries[0]);
          expect(fallback).not.toHaveBeenCalled();
          expect(await compare.mock.results[0].value).toMatchObject({ ok: mode === "valid", authorizesOldObjectDelete: false });
          if (mode === "corrupt") expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "timeline_bounds_or_residual_digest" }), expect.any(String));
        } else {
          expect(compare).not.toHaveBeenCalled();
          expect(fallback).toHaveBeenCalledOnce();
          expect(page.completeness).toBe("partial");
          expect(page.source).toBe("native_plus_objects");
          expect(page.items.some((item) => item.entry?.kind === "system")).toBe(true);
        }
      }
      expect(resolved).toHaveBeenCalledOnce(); // shadow never calls a provider
      const original = await store.readRange({ ...identity, objectRef: handle.objectRef });
      expect(original.entries).toHaveLength(3);
      expect(original.completeness).toBe("partial");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe("native pagination with retained supplements", () => {
  it.each(["supplement attached", "supplement replaced", "selector sealed"] as const)("reports retryable source drift before decoding a stale provider cursor when %s", async (change) => {
    const f = fixture([row("n0", 0), row("n1", 1)], [row("o2", 2)]);
    if (change === "supplement attached") f.span.supplementalObjectRef = null;
    const first = await f.reader.readRun({ ...scope, limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    if (change === "selector sealed") {
      f.span.selectorJson = { kind: "native_execution", executionRef: "sealed-execution" };
    } else {
      f.span.supplementalObjectRef = change === "supplement attached" ? "object-1" : "object-2";
    }

    await expect(f.reader.readRun({ ...scope, cursor: first.nextCursor, limit: 1 })).rejects.toMatchObject({
      code: "cursor_revision_mismatch", status: 409,
    });
    expect(f.native).toHaveBeenCalledOnce();
    expect(f.object).not.toHaveBeenCalled();
    const fresh = await collect(cursor => f.reader.readRun({ ...scope, cursor, limit: 1 }));
    expect(fresh.items.map(item => item.id)).toEqual(["n0", "n1", "o2"]);
  });

  it("restarts the whole manifest snapshot when a supplement attaches between native pages", async () => {
    const nativeRows = [row("stale0", 0), row("stale1", 1)];
    const f = fixture(nativeRows, [row("o2", 2)]);
    f.span.supplementalObjectRef = null;
    let switched = false;
    const snapshot = await readManifestTranscriptSnapshot(() => collect(async cursor => {
      const page = await f.reader.readRun({ ...scope, cursor, limit: 1 });
      if (!switched) {
        switched = true;
        f.span.supplementalObjectRef = "object-1";
        nativeRows.splice(0, nativeRows.length, row("current0", 0), row("current1", 1));
      }
      return page;
    }));
    expect(snapshot.items.map(item => item.id)).toEqual(["current0", "current1", "o2"]);
    expect(f.native.mock.calls.filter(([input]) => input.cursor === null)).toHaveLength(2);
  });

  it("keeps forged supplement payloads and caller scope changes as bad cursors", async () => {
    const f = fixture([row("n0", 0), row("n1", 1)], [row("o2", 2)]);
    const first = await f.reader.readRun({ ...scope, limit: 1 });
    const cursor = decodeTranscriptCursor(first.nextCursor)!;
    for (const providerPageCursor of ["forged", "rudder-supplement-v1:invalid-json"]) {
      await expect(f.reader.readRun({ ...scope, cursor: encodeTranscriptCursor({ ...cursor, providerPageCursor }), limit: 1 }))
        .rejects.toMatchObject({ code: "cursor_invalid", status: 400 });
    }
    await expect(f.reader.readRun({ ...scope, cursor: encodeTranscriptCursor({ ...cursor, orgId: "other-org" }), limit: 1 }))
      .rejects.toMatchObject({ code: "cursor_scope_mismatch", status: 400 });
    expect(f.native).toHaveBeenCalledOnce();
  });

  it("rejects a forged current window revision before classifying a stale source as retryable", async () => {
    const f = fixture([row("n0", 0), row("n1", 1)], [row("o2", 2)]);
    const first = await f.reader.readRun({ ...scope, limit: 1 });
    f.span.selectorJson = { kind: "native_execution", executionRef: "sealed-execution" };
    const current = await f.reader.readRun({ ...scope, limit: 1 });
    const oldCursor = decodeTranscriptCursor(first.nextCursor)!;
    const currentWindow = decodeTranscriptCursor(current.nextCursor)!.windowRevision!;
    expect(currentWindow).not.toBe(oldCursor.windowRevision);
    const callsBefore = f.native.mock.calls.length;

    await expect(f.reader.readRun({ ...scope, cursor: first.nextCursor, limit: 1 }))
      .rejects.toMatchObject({ code: "cursor_revision_mismatch", status: 409 });
    await expect(f.reader.readRun({ ...scope, cursor: encodeTranscriptCursor({ ...oldCursor, windowRevision: currentWindow }), limit: 1 }))
      .rejects.toMatchObject({ code: "cursor_invalid", status: 400 });
    await expect(f.reader.readRun({ ...scope, cursor: encodeTranscriptCursor({ ...oldCursor, windowRevision: 17 as never }), limit: 1 }))
      .rejects.toMatchObject({ code: "cursor_invalid", status: 400 });
    expect(f.native).toHaveBeenCalledTimes(callsBefore);
  });

  it("uses native-then-supplement order independent of page size, including ordinal holes", async () => {
    for (const limit of [1, 2, 20]) {
      const f = fixture([row("n0", 0), row("n2", 2), row("n4", 4)], [row("o1", 1), row("o3", 3)]);
      const result = await collect(cursor => f.reader.readRun({ ...scope, cursor, limit }));
      expect(result.items.map(i => [i.id, i.sequence])).toEqual([["n0", 0], ["n2", 1], ["n4", 2], ["o1", 3], ["o3", 4]]);
    }
  });

  it("drains the selected mixed page when the numeric range end has already been read", async () => {
    const f = fixture([row("n", 0)], [row("o", 1)]);
    const result = await collect(cursor => f.reader.readRun({ ...scope, cursor, limit: 1, range: { end: 1 } }));
    expect(result.items.map(i => [i.id, i.sequence])).toEqual([["n", 0], ["o", 1]]);
  });

  it("replays a mixed second span using its own page position and remaining limit", async () => {
    const db = mockDatabase({ run: databaseRun(), spans: [databaseSpan("span-1"), databaseSpan("span-2", {
      ordinal: 1, bindingId: "binding-span-1", segmentId: "segment-span-1", supplementalObjectRef: "object-2",
    })], bindings: [databaseBinding("span-1")], segments: [databaseSegment("span-1")] });
    const native = vi.fn(async (input: NativeTranscriptReadInput) => ({
      items: [{ ...row(input.span.id === "span-1" ? "a" : "b", 0), spanId: input.span.id }],
      revision: "native-r1", availability: "available" as const,
      completeness: input.span.id === "span-1" ? "complete" as const : "partial" as const,
    }));
    const object = vi.fn(async (input: NativeTranscriptReadInput) => {
      const rows = ["c", "d"].map((id, index) => ({ ...row(id, index + 1), spanId: input.span.id }));
      const start = Number(input.cursor ?? 0), end = Math.min(rows.length, start + input.limit!);
      return { items: rows.slice(start, end), revision: "object-r1", availability: "available" as const,
        completeness: "complete" as const, nextCursor: end < rows.length ? String(end) : null };
    });
    const reader = createTranscriptReader(db as never, { nativeReader: { read: native }, objectReader: { read: object } });
    const result = await collect(cursor => reader.readRun({ ...scope, cursor, limit: 2 }));
    expect(result.items.map(i => [i.id, i.sequence])).toEqual([["a", 0], ["b", 1], ["c", 2], ["d", 3]]);
    expect(object.mock.calls.slice(0, 2).map(([input]) => input.limit)).toEqual([1, 1]);
  });

  it("reads the real Codex user/reasoning/final shape through full conversation Reader without replaying stdout", async () => {
    const f = fixture([row("user", 0, "user"), row("reasoning", 1, "system"), row("final", 2)], [row("stdout", 0, "stdout")], "complete");
    // Conversation internally consumes Run pages of one. Keep the outer page
    // within this fixture's single source window (the mock does not model SQL keysets).
    const page = await f.reader.readConversation({ ...scope, conversationId: "chat-1", limit: 3 });
    const result = { items: page.items, pages: [page] };
    expect(result.items.map(i => i.id)).toEqual(["user", "reasoning", "final"]);
    expect(result.items.map(i => i.sequence)).toEqual([0, 1, 2]);
    expect(f.object).not.toHaveBeenCalled();
    const run = await collect(cursor => f.reader.readRun({ ...scope, cursor, limit: 1 }));
    expect(run.pages.at(-1)?.completeness).toBe("complete");
  });

  it("consumes a paginated supplement once, deduplicates previous native items, and retains distinct projections", async () => {
    const f = fixture([row("user", 0, "user"), row("call", 1, "tool_call", "entry")],
      [row("user", 0, "user"), row("call", 1, "tool_call", "entry"), row("result", 2, "tool_result", "entry"), row("part-a", 3, "assistant", "entry"), row("part-b", 4, "assistant", "entry")]);
    const result = await collect(cursor => f.reader.readRun({ ...scope, cursor, limit: 1 }));
    expect(result.items.map(i => i.id)).toEqual(["user", "call", "result", "part-a", "part-b"]);
    expect(result.items.map(i => i.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(f.object.mock.calls.map(([i]) => i.cursor)).toEqual([null, "1", "2", "3", "4"]);
    expect(result.pages.at(-1)?.completeness).toBe("partial");
  });

  it("keeps IDs/sequence stable when retrying an in-page cursor with a different limit", async () => {
    const f = fixture([row("n", 0)], [row("o0", 1), row("o1", 2), row("o2", 3)]);
    const first = await f.reader.readRun({ ...scope, limit: 1 });
    const narrow = await f.reader.readRun({ ...scope, cursor: first.nextCursor, limit: 1 });
    const wider = await f.reader.readRun({ ...scope, cursor: first.nextCursor, limit: 3 });
    expect(wider.items.map(i => [i.id, i.sequence])).toEqual(narrow.items.map(i => [i.id, i.sequence]));
    const rest = await collect(cursor => f.reader.readRun({ ...scope, cursor: cursor ?? wider.nextCursor, limit: 2 }));
    expect([...first.items, ...wider.items, ...rest.items].map(i => i.id)).toEqual(["n", "o0", "o1", "o2"]);
  });

  it.each(["native", "object"] as const)("rejects %s mutation while consuming an already returned mixed page", async (source) => {
    const f = fixture([row("n", 0)], [row("o", 1)]);
    const first = await f.reader.readRun({ ...scope, limit: 1 });
    (source === "native" ? f.changeNative : f.changeObject)();
    await expect(f.reader.readRun({ ...scope, cursor: first.nextCursor, limit: 1 })).rejects.toMatchObject({ code: "cursor_revision_mismatch" });
  });

  it("pins the native tail page size when object continuation requests a smaller limit", async () => {
    const f = fixture([row("n0", 0), row("n1", 1)], [row("o0", 2), row("o1", 3), row("o2", 4)]);
    const result = await collect((cursor, index) => f.reader.readRun({ ...scope, cursor, limit: index < 2 ? 2 : 1 }));
    expect(result.items.map(i => [i.id, i.sequence])).toEqual([["n0", 0], ["n1", 1], ["o0", 2], ["o1", 3], ["o2", 4]]);
  });

  it("keeps same-entry call/result projections and rejects changed cursor range", async () => {
    const f = fixture([row("entry", 0, "tool_call")], [row("entry", 1, "tool_result"), row("tail", 2)]);
    const first = await f.reader.readRun({ ...scope, limit: 1 });
    const second = await f.reader.readRun({ ...scope, cursor: first.nextCursor, limit: 1 });
    expect([...first.items, ...second.items].map(i => i.kind)).toEqual(["tool_call", "tool_result"]);
    await expect(f.reader.readRun({ ...scope, cursor: first.nextCursor, limit: 1, range: { start: 1 } })).rejects.toMatchObject({ code: "cursor_scope_mismatch" });
  });

  it("rejects object revision drift in an explicit object continuation", async () => {
    const f = fixture([], [row("o0", 0), row("o1", 1)]);
    const first = await f.reader.readRun({ ...scope, limit: 1 }); f.changeObject();
    await expect(f.reader.readRun({ ...scope, cursor: first.nextCursor, limit: 1 })).rejects.toMatchObject({ code: "cursor_revision_mismatch" });
  });

  it("keeps numeric ranges over the combined visible sequence", async () => {
    const f = fixture([row("n0", 0), row("n1", 1)], [row("n0", 0), row("o0", 2), row("o1", 3)]);
    const result = await collect(cursor => f.reader.readRun({ ...scope, cursor, limit: 1, range: { start: 1, end: 2 } }));
    expect(result.items.map(i => [i.id, i.sequence])).toEqual([["n1", 1], ["o0", 2]]);
  });

  it("shares remaining byte budget with the object reader and fails partial without consuming it when exhausted", async () => {
    const n = row("n", 0), size = Buffer.byteLength(JSON.stringify([n]));
    const f = fixture([n], [row("o", 1)], "partial", { maxNativeReadBytes: size });
    const page = await f.reader.readRun({ ...scope, limit: 1 });
    expect(page).toMatchObject({ completeness: "partial", nextCursor: null, limitReached: { reason: "page_bytes" } });
    expect(f.object).not.toHaveBeenCalled();
    const g = fixture([n], [row("o", 1)], "partial", { maxNativeReadBytes: 1000 });
    await g.reader.readRun({ ...scope, limit: 1 });
    expect(g.object.mock.calls[0]![0].maxBytes).toBeLessThan(1000);
  });

  it("bounds dedup metadata and refuses an unprovable supplement without claiming complete", async () => {
    const f = fixture(Array.from({ length: 270 }, (_, i) => row(`n${i}`, i)), [row("tail", 271)]);
    const result = await collect(cursor => f.reader.readRun({ ...scope, cursor, limit: 100 }));
    expect(result.items).toHaveLength(270);
    expect(result.pages.at(-1)).toMatchObject({ completeness: "partial", nextCursor: null, limitReached: { reason: "total_items", maximum: 512 } });
    expect(f.object).not.toHaveBeenCalled();
  });
});
