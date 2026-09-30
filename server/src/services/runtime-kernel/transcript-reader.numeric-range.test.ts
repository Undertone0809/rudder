import { readPiNativeTranscript } from "@rudderhq/agent-runtime-pi-local/server";
import {
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptReader,
  decodeTranscriptCursor,
  type NativeTranscriptReadInput,
  type TranscriptRange,
  type TranscriptReader,
} from "./transcript-reader.js";
import {
  databaseBinding,
  databaseRun,
  databaseSegment,
  databaseSpan,
  mockDatabase as mockReaderDatabase,
} from "./transcript-reader.test-support.js";

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
  it.each([undefined, "wrong-cutoff"])("fails closed without an exact full-source visibility receipt (%s)", async (receipt) => {
    const nativeReader = vi.fn(async () => ({
      items: [{ id: "first", kind: "assistant", ts: "2026-09-22T00:00:00Z", ordinal: 0, payload: { text: "first" } }],
      nextCursor: "later-page", revision: "fixture", availability: "available" as const,
      completeness: "complete" as const, visibilityCutoffHandled: receipt,
    }));
    const reader = createTranscriptReader(mockDatabase() as never, { nativeReader: { readRange: nativeReader } });
    const page = await reader.readRun({ orgId: "org-1", runId: "run-1", spanId: "span-1", limit: 1,
      principal: { type: "user", id: "user-1", scopeRef: "user:user-1", orgId: "org-1" },
      visibilityCutoffRef: "later-cutoff" });
    expect(page).toMatchObject({ items: [], nextCursor: null, availability: "incompatible", completeness: "unknown" });
    expect(nativeReader).toHaveBeenCalledTimes(1);
  });

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
    expect(pages.flatMap((page) => page.items.map((item) => item.sequence))).toEqual([2, 3, 4]);
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
    expect(pages.flatMap((page) => page.items.map((item) => item.sequence))).toEqual([2]);
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

  it("keeps page-local filtering for providers without a matching range-handled proof", async () => {
    const { reader, nativeReader } = readerForRange();
    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "user", id: "user-1", scopeRef: "user:user-1", orgId: "org-1" },
      spanId: "span-1",
      limit: 1,
      range: { before: "item-2" },
    });

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(nativeReader.mock.calls[0]?.[0].range).toEqual({ before: "item-2" });
  });

  it.each([null, "entry-0", "entry-1"])("intersects Pi ID bounds with persisted start %s across full Reader pages", async (persistedStart) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-pi-reader-range-"));
    try {
      const sessionFile = path.join(directory, "session.jsonl");
      const rpcScript = path.join(directory, "pi-rpc-fixture.mjs");
      const entries = [
        { type: "session", version: 3, id: "pi-session", cwd: directory },
        { id: "entry-0", type: "message", parentId: null, message: { role: "user", content: "zero" } },
        { id: "entry-1", type: "message", parentId: "entry-0", message: { role: "assistant", content: [
          { type: "thinking", thinking: "planning" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "note.txt" } },
        ] } },
        { id: "entry-2", type: "message", parentId: "entry-1", message: { role: "user", content: "two" } },
        { id: "entry-3", type: "message", parentId: "entry-2", message: { role: "assistant", content: "three" } },
        { id: "entry-4", type: "message", parentId: "entry-3", message: { role: "assistant", content: "boundary" } },
      ];
      await fs.writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      await fs.writeFile(rpcScript, `import readline from "node:readline";
const args = process.argv.slice(2);
const sessionFile = args[args.indexOf("--session") + 1];
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "get_state") process.exit(2);
  process.stdout.write(JSON.stringify({
    type: "response", command: "get_state", success: true,
    data: { sessionFile, sessionId: sessionFile },
  }) + "\\n");
});
`, "utf8");

      const selector = {
        kind: "pi_branch_range",
        sessionResourceRef: sessionFile,
        leafId: "entry-4",
        fromExclusive: persistedStart,
      };
      const database = mockReaderDatabase({
        run: databaseRun({ contextSnapshot: { transcriptSource: "native" } }),
        spans: [databaseSpan("span-1", { selectorJson: selector })],
        bindings: [databaseBinding("span-1", {
          runtimeType: "pi_local",
          continuity: "native",
          hostId: "local",
          profileId: "pi-profile",
        })],
        segments: [databaseSegment("span-1", { runtimeType: "pi_local", nativeSessionId: "pi-session" })],
      });
      const session = {
        sessionId: sessionFile,
        sessionDisplayId: sessionFile,
        sessionParams: {
          sessionId: sessionFile,
          sessionFile,
          sessionDir: directory,
          cwd: directory,
          command: process.execPath,
          rpcArgs: [rpcScript],
          rpcEnv: { HOME: directory },
          transport: "pi-rpc-stdio",
          hostId: "local",
          profileId: "pi-profile",
          profileBindingId: "binding-span-1",
          profileOrgId: "org-1",
          leafId: "entry-4",
          previousLeafId: null,
        },
      };
      const nativeReader = vi.fn(async (input: NativeTranscriptReadInput) => readPiNativeTranscript({
        runtimeType: "pi_local",
        session,
        selector: input.selector,
        binding: {
          id: input.binding?.id,
          orgId: input.binding?.orgId,
          hostId: "local",
          profileId: "pi-profile",
        },
        range: input.range,
        cursor: input.cursor,
        readerInput: { limit: input.limit, maxBytes: input.maxBytes, maxItemBytes: input.maxItemBytes,
          visibilityCutoffRef: input.visibilityCutoffRef },
      }));
      const reader = createTranscriptReader(database as never, { nativeReader: { readRange: nativeReader } });
      const readAll = async (range: TranscriptRange, visibilityCutoffRef?: string, limit = 1) => {
        const pages = [];
        let cursor: string | null = null;
        for (let index = 0; index < 20; index += 1) {
          const page = await reader.readRun({
            orgId: "org-1",
            runId: "run-1",
            principal: { type: "user", id: "user-1", scopeRef: "user:user-1", orgId: "org-1" },
            spanId: "span-1",
            cursor,
            limit,
            range,
            visibilityCutoffRef,
          });
          pages.push(page);
          if (!page.nextCursor) return pages;
          cursor = page.nextCursor;
        }
        throw new Error("Pi Transcript Reader pagination did not terminate");
      };
      const itemSequences = (pages: Awaited<ReturnType<typeof readAll>>) =>
        pages.flatMap(page => page.items.map(item => [item.id, item.sequence] as const));

      const beforePages = await readAll({ before: "entry-4" });
      const beforeLargePage = await readAll({ before: "entry-4" }, undefined, 50);
      const expectedBefore = [
        "entry-0",
        "entry-1",
        "entry-1:tool_call:1",
        "entry-2",
        "entry-3",
      ].slice(persistedStart === "entry-1" ? 3 : persistedStart === "entry-0" ? 1 : 0);
      expect(beforePages.flatMap((page) => page.items.map((item) => item.id))).toEqual(expectedBefore);
      expect(beforePages).toHaveLength(expectedBefore.length);
      expect(beforePages.at(-1)?.nextCursor).toBeNull();
      expect(itemSequences(beforePages)).toEqual(itemSequences(beforeLargePage));

      const visiblePages = await readAll({ before: "entry-4" }, "entry-3");
      const visibleLargePage = await readAll({ before: "entry-4" }, "entry-3", 50);
      expect(visiblePages.flatMap(page => page.items.map(item => item.id))).toEqual(expectedBefore);
      expect(visiblePages.at(-1)).toMatchObject({ nextCursor: null, completeness: "complete" });
      expect(visiblePages.every(page => !("visibilityCutoffHandled" in page))).toBe(true);
      expect(itemSequences(visiblePages)).toEqual(itemSequences(visibleLargePage));
      if (persistedStart !== "entry-1") {
        const multiProjectionCutoff = await readAll({ before: "entry-4" }, "entry-1");
        expect(multiProjectionCutoff.flatMap(page => page.items.map(item => item.id)))
          .toEqual(expectedBefore.filter(id => ["entry-0", "entry-1", "entry-1:tool_call:1"].includes(id)));
      }
      const missingCutoff = await readAll({}, "missing-cutoff");
      expect(missingCutoff).toHaveLength(1);
      expect(missingCutoff[0]).toMatchObject({ items: [], nextCursor: null, availability: "incompatible", completeness: "unknown" });

      const startPages = await readAll({ start: persistedStart === "entry-1" ? "entry-2" : "entry-1" });
      const startLargePage = await readAll({ start: persistedStart === "entry-1" ? "entry-2" : "entry-1" }, undefined, 50);
      const expectedStart = [
        "entry-1",
        "entry-1:tool_call:1",
        "entry-2",
        "entry-3",
        "entry-4",
      ].slice(persistedStart === "entry-1" ? 2 : 0);
      expect(startPages.flatMap((page) => page.items.map((item) => item.id))).toEqual(expectedStart);
      expect(startPages).toHaveLength(expectedStart.length);
      expect(startPages.at(-1)?.nextCursor).toBeNull();
      expect(itemSequences(startPages)).toEqual(itemSequences(startLargePage));

      if (persistedStart) {
        const outsideRanges: TranscriptRange[] = [{ start: "entry-0" }];
        if (persistedStart === "entry-1") outsideRanges.push({ fromExclusive: "entry-0" }, { after: "entry-0" });
        for (const range of outsideRanges) {
          const pages = await readAll(range);
          expect(pages).toHaveLength(1);
          expect(pages[0]).toMatchObject({ items: [], nextCursor: null, availability: "incompatible" });
        }
        const combined = await readAll({ start: "entry-2", after: persistedStart, before: "entry-4" });
        expect(combined.flatMap((page) => page.items.map((item) => item.id))).toEqual(["entry-2", "entry-3"]);
      }

      const missingBoundary = await reader.readRun({
        orgId: "org-1",
        runId: "run-1",
        principal: { type: "user", id: "user-1", scopeRef: "user:user-1", orgId: "org-1" },
        spanId: "span-1",
        limit: 1,
        range: { before: "missing-entry" },
      });
      expect(missingBoundary.items).toEqual([]);
      expect(missingBoundary.nextCursor).toBeNull();
      expect(missingBoundary.availability).toBe("incompatible");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
