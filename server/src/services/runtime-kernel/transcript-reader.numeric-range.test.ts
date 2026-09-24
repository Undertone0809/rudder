import {
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptReader,
  decodeTranscriptCursor,
  type NativeTranscriptReadInput,
  type TranscriptReader,
  type TranscriptRange,
} from "./transcript-reader.js";

function mockDatabase(spanIds: readonly string[] = ["span-1"]) {
  const rowsByTable = new Map<unknown, Record<string, unknown>[]>([
    [heartbeatRuns, [{
      id: "run-1",
      orgId: "org-1",
      chatConversationId: null,
      logStore: null,
      logRef: null,
      logCompressed: false,
      logSha256: null,
      logBytes: null,
      startedAt: new Date("2026-09-22T00:00:00.000Z"),
      createdAt: new Date("2026-09-22T00:00:00.000Z"),
      updatedAt: new Date("2026-09-22T00:00:01.000Z"),
      resultJson: null,
      contextSnapshot: null,
    }]],
    [runRuntimeSpans, spanIds.map((id, ordinal) => ({
      id,
      runId: "run-1",
      bindingId: "binding-1",
      segmentId: "segment-1",
      ordinal,
      selectorJson: { kind: "native_execution", executionRef: id },
      completeness: "complete",
      visibilityCutoffRef: null,
      supplementalObjectRef: null,
      updatedAt: new Date("2026-09-22T00:00:01.000Z"),
    }))],
    [runtimeBindings, [{
      id: "binding-1",
      orgId: "org-1",
      conversationId: null,
      principalScopeRef: "user:user-1",
      runtimeType: "process",
    }]],
    [nativeSegments, [{
      id: "segment-1",
      orgId: "org-1",
      bindingId: "binding-1",
      runtimeType: "process",
      nativeSessionId: "session-1",
    }]],
  ]);
  const select = () => {
    let table: unknown;
    let rowLimit = Number.POSITIVE_INFINITY;
    const query: Record<string, unknown> & {
      then?: (resolve: (value: Record<string, unknown>[]) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown>;
    } = {};
    query.from = vi.fn((value: unknown) => {
      table = value;
      return query;
    });
    query.innerJoin = vi.fn(() => query);
    query.where = vi.fn(() => query);
    query.orderBy = vi.fn(() => query);
    query.limit = vi.fn((value: number) => {
      rowLimit = value;
      return query;
    });
    query.then = (resolve, reject) => Promise.resolve(
      (rowsByTable.get(table) ?? []).slice(0, rowLimit),
    ).then(resolve, reject);
    return query;
  };
  return { select };
}

function readerForRange() {
  const nativeReader = vi.fn(async ({ cursor }: NativeTranscriptReadInput) => {
    const index = cursor ? Number(cursor.slice("provider-".length)) : 0;
    return {
      items: [{
        id: `item-${index}`,
        kind: "assistant",
        ts: `2026-09-22T00:00:${String(index).padStart(2, "0")}.000Z`,
        ordinal: index,
        payload: { text: `item ${index}` },
      }],
      nextCursor: index < 4 ? `provider-${index + 1}` : null,
      revision: "native-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    };
  });
  const reader = createTranscriptReader(mockDatabase() as never, {
    nativeReader: { read: nativeReader },
  });
  return { reader, nativeReader };
}

function readerForSpans(itemsPerSpan: Record<string, number>) {
  const nativeReader = vi.fn(async ({ cursor, span }: NativeTranscriptReadInput) => {
    const index = cursor ? Number(cursor.slice("provider-".length)) : 0;
    const itemCount = itemsPerSpan[span.id] ?? 0;
    return {
      items: index < itemCount ? [{
        id: `${span.id}-${index}`,
        kind: "assistant",
        ts: `2026-09-22T00:00:${String(index).padStart(2, "0")}.000Z`,
        ordinal: 100 + index,
        payload: { text: `${span.id} ${index}` },
      }] : [],
      nextCursor: index + 1 < itemCount ? `provider-${index + 1}` : null,
      revision: `native-${span.id}-r1`,
      availability: "available" as const,
      completeness: "complete" as const,
    };
  });
  const reader = createTranscriptReader(mockDatabase(Object.keys(itemsPerSpan)) as never, {
    nativeReader: { read: nativeReader },
  });
  return { reader, nativeReader };
}

async function collectPages(reader: TranscriptReader, range: TranscriptRange, spanId?: string) {
  const pages = [];
  let cursor: string | null = null;
  for (let count = 0; count < 10; count += 1) {
    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "user", id: "user-1", scopeRef: "user:user-1", orgId: "org-1" },
      ...(spanId ? { spanId } : {}),
      cursor,
      limit: 1,
      range,
    });
    pages.push(page);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return pages;
}

async function readPages(range: TranscriptRange) {
  const { reader, nativeReader } = readerForRange();
  return { pages: await collectPages(reader, range, "span-1"), nativeReader };
}

describe("Transcript Reader numeric ranges across native provider pages", () => {
  it("applies start against absolute source positions when providers return one item per cursor", async () => {
    const { pages, nativeReader } = await readPages({ start: 2 });

    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual([
      "item-2",
      "item-3",
      "item-4",
    ]);
    expect(pages).toHaveLength(5);
    expect(nativeReader).toHaveBeenCalledTimes(5);
    expect(nativeReader.mock.calls[0]?.[0].range).toBeNull();
    expect(decodeTranscriptCursor(pages[0]!.nextCursor!)).toMatchObject({
      providerPageCursor: "provider-1",
      providerOffset: 1,
    });
    expect(decodeTranscriptCursor(pages[1]!.nextCursor!)).toMatchObject({
      providerPageCursor: "provider-2",
      providerOffset: 2,
    });
  });

  it("preserves numeric end, throughInclusive, before, and fromExclusive boundaries across pages", async () => {
    const cases: Array<{ range: TranscriptRange; ids: string[]; reads: number }> = [
      { range: { start: 1, end: 2 }, ids: ["item-1", "item-2"], reads: 3 },
      { range: { throughInclusive: 2 }, ids: ["item-0", "item-1", "item-2"], reads: 3 },
      { range: { before: 2 }, ids: ["item-0", "item-1"], reads: 2 },
      { range: { fromExclusive: 1 }, ids: ["item-2", "item-3", "item-4"], reads: 5 },
    ];

    for (const { range, ids, reads } of cases) {
      const { pages, nativeReader } = await readPages(range);
      expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(ids);
      expect(nativeReader).toHaveBeenCalledTimes(reads);
    }
  });

  it("indexes one Run across provider pages and span transitions", async () => {
    const { reader, nativeReader } = readerForSpans({ "span-1": 2, "span-2": 2, "span-3": 1 });
    const pages = await collectPages(reader, { start: 2 });

    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual([
      "span-2-0", "span-2-1", "span-3-0",
    ]);
    expect(pages).toHaveLength(5);
    expect(decodeTranscriptCursor(pages[1]!.nextCursor!)).toMatchObject({
      activeSpanId: "span-2", sourceTransition: true, providerOffset: 2,
    });
    expect(decodeTranscriptCursor(pages[3]!.nextCursor!)).toMatchObject({
      activeSpanId: "span-3", sourceTransition: true, providerOffset: 4,
    });
    expect(nativeReader.mock.calls.map(([input]) => [input.span.id, input.cursor])).toEqual([
      ["span-1", null], ["span-1", "provider-1"],
      ["span-2", null], ["span-2", "provider-1"], ["span-3", null],
    ]);
  });

  it("ends the whole Run at a numeric bound without reading later pages or spans", async () => {
    const { reader, nativeReader } = readerForSpans({ "span-1": 2, "span-2": 2, "span-3": 1 });
    const pages = await collectPages(reader, { start: 2, end: 2 });

    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(["span-2-0"]);
    expect(pages).toHaveLength(3);
    expect(pages[2]!.nextCursor).toBeNull();
    expect(nativeReader.mock.calls.map(([input]) => [input.span.id, input.cursor])).toEqual([
      ["span-1", null], ["span-1", "provider-1"], ["span-2", null],
    ]);
  });

  it("keeps one absolute index while scanning spans in a single read", async () => {
    const { reader, nativeReader } = readerForSpans({ "span-1": 1, "span-2": 1, "span-3": 1 });
    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "user", id: "user-1", scopeRef: "user:user-1", orgId: "org-1" },
      limit: 2,
      range: { start: 1, end: 1 },
    });

    expect(page.items.map((item) => item.id)).toEqual(["span-2-0"]);
    expect(page.nextCursor).toBeNull();
    expect(nativeReader.mock.calls.map(([input]) => input.span.id)).toEqual(["span-1", "span-2"]);
  });

  it("starts numeric indexes at zero when a Run read selects one span", async () => {
    const { reader, nativeReader } = readerForSpans({ "span-1": 2, "span-2": 2 });
    const pages = await collectPages(reader, { start: 1 }, "span-2");

    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(["span-2-1"]);
    expect(nativeReader.mock.calls.map(([input]) => input.span.id)).toEqual(["span-2", "span-2"]);
  });
});
