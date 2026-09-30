import { describe, expect, it, vi } from "vitest";
import { createTranscriptReader, type NativeTranscriptReadInput, type TranscriptItem, type TranscriptPage } from "./transcript-reader.js";
import { databaseBinding, databaseRun, databaseSegment, databaseSpan, mockDatabase } from "./transcript-reader.test-support.js";

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
  const db = mockDatabase({ run: databaseRun({ chatConversationId: "chat-1", contextSnapshot: { transcriptSource: "native" } }),
    conversations: [{ id: "chat-1", orgId: "org-1", updatedAt: new Date("2026-09-22") }],
    spans: [databaseSpan("span-1", { supplementalObjectRef: "object-1" })],
    bindings: [databaseBinding("span-1", { continuity: "native", conversationId: "chat-1" })], segments: [databaseSegment("span-1")] });
  const reader = createTranscriptReader(db as never, { nativeReader: { read: native }, objectReader: { read: object }, ...budgets });
  return { reader, native, object, changeNative: () => { nativeRevision = "native-r2"; }, changeObject: () => { objectRevision = "object-r2"; } };
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

describe("native pagination with retained supplements", () => {
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
