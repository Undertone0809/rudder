import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { describe, expect, it, vi } from "vitest";
import {
  createLegacyTranscriptReader,
  createTranscriptReader,
  decodeTranscriptCursor,
  type CompatibilityTranscriptReaderApi,
  type NativeTranscriptReadInput,
  type TranscriptItem,
  type TranscriptReadAuthorization,
  type TranscriptReadScope,
  type TranscriptReaderFactoryOptions,
} from "./transcript-reader.js";
import {
  databaseBinding,
  databaseRun,
  databaseSegment,
  databaseSpan,
  mockDatabase,
} from "./transcript-reader.test-support.js";

function makeUtf8LogStore(
  bytes: Buffer,
  maxChunkBytes = Number.MAX_SAFE_INTEGER,
  onRead?: () => void,
) {
  const original = Buffer.from(bytes);
  const read = vi.fn(async (_handle: unknown, options: { offset?: number; limitBytes?: number } = {}) => {
    onRead?.();
    const offset = options.offset ?? 0;
    let end = Math.min(original.length, offset + Math.min(options.limitBytes ?? original.length, maxChunkBytes));
    let content: string | null = null;
    for (let trim = 0; trim <= 3; trim += 1) {
      try {
        const candidateEnd = end - trim;
        content = new TextDecoder("utf-8", { fatal: true }).decode(original.subarray(offset, candidateEnd));
        end = candidateEnd;
        break;
      } catch {
        continue;
      }
    }
    if (content === null) throw new Error("fixture failed to produce a UTF-8 page");
    const eof = end >= original.length;
    return { content, endOffset: end, eof, ...(eof ? {} : { nextOffset: end }) };
  });
  return { store: { read } as never, read, original };
}

function databaseConversation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "conversation-1",
    orgId: "org-1",
    updatedAt: new Date("2026-09-22T00:00:10.000Z"),
    ...overrides,
  };
}

function databaseMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "message-1",
    orgId: "org-1",
    conversationId: "conversation-1",
    role: "user",
    body: "hello",
    kind: "message",
    structuredPayload: null,
    runId: null,
    createdAt: new Date("2026-09-22T00:00:00.000Z"),
    updatedAt: new Date("2026-09-22T00:00:01.000Z"),
    supersededAt: null,
    ...overrides,
  };
}

const scope: TranscriptReadScope = {
  orgId: "org-1",
  principal: { type: "user", id: "user-1", scopeRef: "member:1" },
  runId: "run-1",
  spanId: "span-1",
};

const authorization: TranscriptReadAuthorization = {
  org: true,
  principal: true,
  run: true,
  span: true,
  visibilityCutoffRef: "cutoff-1",
  visibilityCutoff: { ref: "cutoff-1", ordinal: 4, itemId: null },
};

function item(overrides: Partial<TranscriptItem> = {}): TranscriptItem {
  return {
    id: "item-1",
    ordinal: 1,
    runId: "run-1",
    spanId: "span-1",
    sourceEntryId: "item-1",
    sourceRef: "native-session-1",
    kind: "assistant",
    ts: "2026-09-22T00:00:00.000Z",
    payload: { text: "ok" },
    visibility: "visible",
    origin: "native",
    ...overrides,
  };
}

function makeReader(options: {
  nativeReader?: TranscriptReaderFactoryOptions["nativeReader"];
  legacyReader?: TranscriptReaderFactoryOptions["legacyReader"];
  authorize?: (value: TranscriptReadScope) => TranscriptReadAuthorization;
} = {}): CompatibilityTranscriptReaderApi {
  return createTranscriptReader({
    authorize: options.authorize ?? (() => authorization),
    nativeReader: options.nativeReader,
    legacyReader: options.legacyReader,
    defaultLimit: 2,
  });
}

describe("transcript reader", () => {
  it("pages a 10,000-entry historical log without materializing the complete source", async () => {
    const lines = Array.from({ length: 10_000 }, (_, index) => JSON.stringify({
      ts: "2026-09-22T00:00:01.000Z",
      stream: "stdout",
      chunk: `entry-${index} 世界\n`,
    }));
    const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const logStore = makeUtf8LogStore(bytes);
    const db = mockDatabase({
      run: databaseRun({
        logStore: "local_file",
        logRef: "org/agent/run.ndjson",
        logBytes: bytes.length,
        logSha256: "large-log-r1",
      }),
    });
    const reader = createTranscriptReader(db as never, {
      logStore: logStore.store,
      maxLegacyReadBytes: 128 * 1024,
      maxLegacyTotalBytes: 16 * 1024 * 1024,
    });
    const collected: string[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    while (true) {
      const page = await reader.readRun({
        orgId: "org-1",
        runId: "run-1",
        principal: { type: "board", orgId: "org-1", authorized: true },
        cursor,
        limit: 100,
      });
      pageCount += 1;
      collected.push(...page.items.map((entry) => entry.text ?? ""));
      cursor = page.nextCursor;
      if (!cursor) break;
      expect(pageCount).toBeLessThanOrEqual(101);
    }

    expect(collected).toEqual(Array.from({ length: 10_000 }, (_, index) => `entry-${index} 世界`));
    expect(logStore.read.mock.calls.every(([, readOptions]) => (readOptions?.limitBytes ?? Infinity) <= 16 * 1024)).toBe(true);
    expect(pageCount).toBeLessThanOrEqual(101);
    expect(bytes.equals(logStore.original)).toBe(true);
  });

  it("preserves Unicode through small byte and NDJSON chunk boundaries", async () => {
    const bytes = Buffer.from([
      JSON.stringify({ ts: "2026-09-22T00:00:01.000Z", stream: "stdout", chunk: "你好，🌍\n" }),
      JSON.stringify({ ts: "2026-09-22T00:00:02.000Z", stream: "stdout", chunk: "再见，🧪\n" }),
    ].join("\n") + "\n", "utf8");
    const logStore = makeUtf8LogStore(bytes, 5);
    const db = mockDatabase({ run: databaseRun({ logStore: "local_file", logRef: "unicode.ndjson", logBytes: bytes.length }) });
    const reader = createTranscriptReader(db as never, { logStore: logStore.store });

    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 10,
    });

    expect(page.items.map((entry) => entry.text)).toEqual(["你好，🌍", "再见，🧪"]);
    expect(page.completeness).toBe("complete");
    expect(bytes.equals(logStore.original)).toBe(true);
  });

  it("resumes legacy log cursors across Reader instances and rejects a changed source revision", async () => {
    const bytes = Buffer.from(Array.from({ length: 5 }, (_, index) => JSON.stringify({
      ts: "2026-09-22T00:00:01.000Z", stream: "stdout", chunk: `resume-${index}\n`,
    })).join("\n") + "\n", "utf8");
    const run = databaseRun({
      logStore: "local_file", logRef: "restart.ndjson", logBytes: bytes.length, logSha256: "restart-r1",
    });
    const db = mockDatabase({ run });
    const logStore = makeUtf8LogStore(bytes);
    const options = { logStore: logStore.store };
    const firstReader = createTranscriptReader(db as never, options);
    const first = await firstReader.readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true }, limit: 2,
    });
    expect(first.items.map((entry) => entry.text)).toEqual(["resume-0", "resume-1"]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const restartedReader = createTranscriptReader(db as never, options);
    const second = await restartedReader.readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 2, cursor: first.nextCursor,
    });
    expect(second.items.map((entry) => entry.text)).toEqual(["resume-2", "resume-3"]);

    (run as Record<string, unknown>).logSha256 = "restart-r2";
    await expect(restartedReader.readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 2, cursor: second.nextCursor,
    })).rejects.toThrow("revision");
  });

  it("cancels a legacy read after an in-flight bounded log page", async () => {
    const bytes = Buffer.from(`${JSON.stringify({ ts: "2026-09-22T00:00:01.000Z", stream: "stdout", chunk: "cancel me\n" })}\n`);
    const controller = new AbortController();
    const logStore = makeUtf8LogStore(bytes, Number.MAX_SAFE_INTEGER, () => controller.abort());
    const db = mockDatabase({ run: databaseRun({ logStore: "local_file", logRef: "cancel.ndjson", logBytes: bytes.length }) });
    const reader = createTranscriptReader(db as never, { logStore: logStore.store });

    await expect(reader.readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(logStore.read).toHaveBeenCalledOnce();
  });

  it("returns an explicit partial result when the total legacy byte budget is exhausted", async () => {
    const bytes = Buffer.from(`${JSON.stringify({
      ts: "2026-09-22T00:00:01.000Z", stream: "stdout", chunk: `${"large transcript row ".repeat(20)}\n`,
    })}\n`, "utf8");
    const logStore = makeUtf8LogStore(bytes);
    const db = mockDatabase({ run: databaseRun({ logStore: "local_file", logRef: "budget.ndjson", logBytes: bytes.length }) });
    const reader = createTranscriptReader(db as never, { logStore: logStore.store, maxLegacyTotalBytes: 100 });

    const page = await reader.readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
    });

    expect(page).toMatchObject({
      completeness: "partial",
      nextCursor: null,
      limitReached: { reason: "total_bytes", maximum: 100 },
    });
  });

  it("returns an explicit partial result when the total legacy item budget is exhausted", async () => {
    const bytes = Buffer.from(Array.from({ length: 4 }, (_, index) => JSON.stringify({
      ts: "2026-09-22T00:00:01.000Z", stream: "stdout", chunk: `item-${index}\n`,
    })).join("\n") + "\n", "utf8");
    const logStore = makeUtf8LogStore(bytes);
    const db = mockDatabase({ run: databaseRun({ logStore: "local_file", logRef: "item-budget.ndjson", logBytes: bytes.length }) });
    const reader = createTranscriptReader(db as never, { logStore: logStore.store, maxLegacyTotalItems: 3 });

    const page = await reader.readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
    });

    expect(page.items.map((entry) => entry.text)).toEqual(["item-0", "item-1", "item-2"]);
    expect(page).toMatchObject({
      completeness: "partial",
      nextCursor: null,
      limitReached: { reason: "total_items", maximum: 3 },
    });
  });

  it("pages historical transcript events by keyset without loading every Run event", async () => {
    const events = Array.from({ length: 10_000 }, (_, index) => ({
      id: index + 1,
      orgId: "org-1",
      runId: "run-1",
      seq: Math.floor(index / 2) + 1,
      eventType: "transcript.entry",
      stream: null,
      message: null,
      payload: { entry: { kind: "assistant", ts: "2026-09-22T00:00:01.000Z", text: `event-${index}` } },
      createdAt: new Date("2026-09-22T00:00:01.000Z"),
    }));
    const db = mockDatabase({ run: databaseRun(), events, pageEvents: true });
    const firstReader = createTranscriptReader(db as never);
    const input = {
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 100,
    };
    const first = await firstReader.readRun(input);
    const restartedReader = createTranscriptReader(db as never);
    const collected = [...first.items.map((entry) => entry.text ?? "")];
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor) {
      const page = await restartedReader.readRun({ ...input, cursor });
      expect(page.revision).toBe(first.revision);
      collected.push(...page.items.map((entry) => entry.text ?? ""));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(101);
    }

    expect(collected).toEqual(Array.from({ length: 10_000 }, (_, index) => `event-${index}`));
    expect(db.maxEventRowsRead).toBeLessThanOrEqual(100);
    expect(db.limitCalls.every((limit) => limit <= 101)).toBe(true);
  });

  it("does not exceed the total event-item budget", async () => {
    const events = Array.from({ length: 2 }, (_, index) => ({
      id: index + 1,
      orgId: "org-1",
      runId: "run-1",
      seq: index + 1,
      eventType: "transcript.entry",
      stream: null,
      level: null,
      color: null,
      message: null,
      idempotencyKey: null,
      payload: { entry: { kind: "assistant", ts: "2026-09-22T00:00:01.000Z", text: `budget-${index}` } },
      createdAt: new Date("2026-09-22T00:00:01.000Z"),
    }));
    const db = mockDatabase({ run: databaseRun(), events, pageEvents: true });
    const reader = createTranscriptReader(db as never, { maxLegacyTotalItems: 1 });

    const page = await reader.readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
    });

    expect(page.items.map((entry) => entry.text)).toEqual(["budget-0"]);
    expect(page).toMatchObject({
      completeness: "partial",
      nextCursor: null,
      limitReached: { reason: "total_items", maximum: 1 },
    });

    const exactDb = mockDatabase({ run: databaseRun(), events: events.slice(0, 1), pageEvents: true });
    const exact = await createTranscriptReader(exactDb as never, { maxLegacyTotalItems: 1 }).readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
    });
    expect(exact.items.map((entry) => entry.text)).toEqual(["budget-0"]);
    expect(exact).toMatchObject({ completeness: "complete", nextCursor: null });
    expect(exact.limitReached).toBeUndefined();
  });

  it("binds event page revisions to the high watermark and rejects changed sources", async () => {
    const events = Array.from({ length: 3 }, (_, index) => ({
      id: index + 1,
      orgId: "org-1",
      runId: "run-1",
      seq: index + 1,
      eventType: "transcript.entry",
      stream: null,
      message: null,
      payload: { entry: { kind: "assistant", ts: "2026-09-22T00:00:01.000Z", text: `event-${index}` } },
      createdAt: new Date("2026-09-22T00:00:01.000Z"),
    }));
    const db = mockDatabase({ run: databaseRun(), events, pageEvents: true });
    const reader = createTranscriptReader(db as never);
    const input = {
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board" as const, orgId: "org-1", authorized: true },
      limit: 1,
    };

    const first = await reader.readRun(input);
    const second = await reader.readRun({ ...input, cursor: first.nextCursor });
    expect(second.revision).toBe(first.revision);
    expect(second.nextCursor).toEqual(expect.any(String));

    events.push({
      id: 4,
      orgId: "org-1",
      runId: "run-1",
      seq: 4,
      eventType: "transcript.entry",
      stream: null,
      message: null,
      payload: { entry: { kind: "assistant", ts: "2026-09-22T00:00:02.000Z", text: "event-3" } },
      createdAt: new Date("2026-09-22T00:00:02.000Z"),
    });

    const changed = await reader.readRun(input);
    expect(changed.revision).not.toBe(first.revision);
    await expect(reader.readRun({ ...input, cursor: second.nextCursor })).rejects.toThrow("changed during pagination");
  });

  it("keeps durable transcript events when a finalized legacy log is empty or unparsable", async () => {
    const reader = createLegacyTranscriptReader({
      logStore: {
        read: vi.fn().mockResolvedValue({
          content: "not-json-log-content",
          endOffset: 20,
          eof: true,
        }),
      } as never,
    });

    const result = await reader.readRun({
      readonly: true,
      run: {
        id: "run-1",
        logStore: "local_file",
        logRef: "run.ndjson",
        logCompressed: false,
        startedAt: new Date("2026-09-22T00:00:00.000Z"),
        createdAt: new Date("2026-09-22T00:00:00.000Z"),
        resultJson: null,
        contextSnapshot: null,
      } as never,
      runtimeType: "process",
      events: [{
        id: 42,
        seq: 42,
        eventType: "transcript.entry",
        payload: { kind: "assistant", ts: "2026-09-22T00:00:01.000Z", text: "durable" },
        createdAt: new Date("2026-09-22T00:00:01.000Z"),
      }, {
        id: 43,
        seq: null,
        eventType: "transcript.entry",
        payload: { kind: "assistant", ts: "2026-09-22T00:00:02.000Z", text: "live-only" },
        createdAt: new Date("2026-09-22T00:00:02.000Z"),
      }, {
        id: 44,
        seq: 44,
        eventType: "adapter.invoke",
        message: "diagnostic should not be transcript",
        createdAt: new Date("2026-09-22T00:00:03.000Z"),
      }],
    });

    expect(result.entries).toEqual([{
      kind: "assistant",
      ts: "2026-09-22T00:00:01.000Z",
      text: "durable",
      sourceEntryId: "42",
    }]);
  });

  it("semantically decodes a successful historical Gemini CLI Run without registering an executable parser", async () => {
    const ts = "2026-09-30T00:00:00.000Z";
    const records = [
      { type: "message", role: "user", content: "private user input" },
      { type: "user", message: "raw private user input" },
      { type: "thinking", text: "Checking the project" },
      { type: "tool_call", subtype: "started", call_id: "call-1", tool_call: { read_file: { args: { path: "README.md" } } } },
      { type: "tool_call", subtype: "completed", call_id: "call-1", tool_call: { read_file: { result: "file contents" } } },
      { type: "message", role: "assistant", content: "The project is ready." },
      { type: "result", status: "success", result: "The project is ready." },
    ];
    const log = records.map((record) => JSON.stringify({
      ts,
      stream: "stdout",
      chunk: `${JSON.stringify(record)}\n`,
    })).join("\n");
    const fixture = makeUtf8LogStore(Buffer.from(log));
    const reader = createLegacyTranscriptReader({ logStore: fixture.store });

    const result = await reader.readRun({
      readonly: true,
      run: {
        id: "successful-gemini-history",
        status: "succeeded",
        logStore: "local_file",
        logRef: "run.ndjson",
        logCompressed: false,
        startedAt: new Date(ts),
        createdAt: new Date(ts),
        resultJson: null,
        contextSnapshot: null,
      } as never,
      runtimeType: "gemini_local",
      events: [],
    });

    const entries: readonly TranscriptEntry[] = Array.isArray(result)
      ? result as readonly TranscriptEntry[]
      : (result as { entries: readonly TranscriptEntry[] }).entries;
    expect(entries.map((entry) => entry.kind)).toEqual([
      "thinking", "tool_call", "tool_result", "assistant", "result",
    ]);
    expect(entries).toEqual(expect.arrayContaining([
      { kind: "thinking", ts, text: "Checking the project" },
      { kind: "tool_call", ts, name: "read_file", input: { path: "README.md" } },
      { kind: "tool_result", ts, toolUseId: "call-1", content: "file contents", isError: false },
      { kind: "assistant", ts, text: "The project is ready." },
      expect.objectContaining({ kind: "result", text: "The project is ready.", isError: false }),
    ]));
    expect(JSON.stringify(entries)).not.toContain("private user input");
    expect(JSON.stringify(entries)).not.toContain("raw private user input");
    expect(fixture.read).toHaveBeenCalled();
  });

  it("prefers native history and returns a scope-bound stable cursor", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [item()],
      nextCursor: "provider-2",
      source: "native",
      revision: "native-r1",
      availability: "available",
      completeness: "complete",
    });
    const legacyReader = vi.fn();
    const reader = makeReader({ nativeReader, legacyReader });

    const page = await reader.read({ ...scope, limit: 1 });

    expect(page.source).toBe("native");
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTypeOf("string");
    expect(legacyReader).not.toHaveBeenCalled();
    expect(decodeTranscriptCursor(page.nextCursor!)).toMatchObject({
      orgId: "org-1",
      runId: "run-1",
      spanId: "span-1",
      source: "native",
      revision: "native-r1",
      providerCursor: "provider-2",
    });
    expect(nativeReader).toHaveBeenCalledWith(expect.objectContaining({
      ...scope,
      limit: 1,
      cursor: null,
      visibilityCutoffRef: "cutoff-1",
    }));
  });

  it("falls back to legacy only for an initial unavailable native page", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      source: "native",
      revision: "native-r1",
      availability: "offline",
      completeness: "unknown",
    });
    const legacyReader = vi.fn().mockResolvedValue({
      items: [item({ sourceRef: "legacy-run-1", origin: "legacy" })],
      nextCursor: null,
      source: "legacy",
      revision: "legacy-r4",
      availability: "available",
      completeness: "partial",
    });
    const page = await makeReader({ nativeReader, legacyReader }).read(scope);

    expect(page).toMatchObject({
      source: "legacy",
      revision: "legacy-r4",
      availability: "available",
      completeness: "partial",
    });
    expect(legacyReader).toHaveBeenCalledOnce();
  });

  it("keeps an explicit native compatibility read empty when native is unavailable", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      source: "native" as const,
      revision: "native-offline-r1",
      availability: "offline" as const,
      completeness: "unknown" as const,
    });
    const legacyReader = vi.fn().mockResolvedValue({
      items: [item({ id: "legacy-item", origin: "legacy" })],
      nextCursor: null,
      source: "legacy" as const,
      revision: "legacy-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });

    await expect(makeReader({ nativeReader, legacyReader }).read({ ...scope, mode: "native" })).resolves.toMatchObject({
      source: "native",
      availability: "offline",
      items: [],
    });
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it("does not fall back through an incompatible compatibility page", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [],
      revision: "native-incompatible-r1",
      availability: "incompatible" as const,
      completeness: "unknown" as const,
    });
    const legacyReader = vi.fn().mockResolvedValue({
      entries: [item({ id: "legacy-item", origin: "legacy" })],
      revision: "legacy-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });

    await expect(makeReader({ nativeReader, legacyReader }).read(scope)).resolves.toMatchObject({
      source: "native",
      availability: "incompatible",
      items: [],
    });
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it("keeps native partial items instead of replacing them with legacy", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [item({ origin: "native", text: "partial-native" })],
      nextCursor: null,
      source: "native",
      revision: "native-r1",
      availability: "offline",
      completeness: "partial",
    });
    const legacyReader = vi.fn().mockResolvedValue({
      entries: [item({ id: "legacy-item", origin: "legacy" })],
      revision: "legacy-r1",
      availability: "available",
      completeness: "complete",
    });

    const page = await makeReader({ nativeReader, legacyReader }).read(scope);

    expect(page).toMatchObject({ source: "native", availability: "offline", completeness: "partial" });
    expect(page.items.map((entry) => entry.id)).toEqual(["item-1"]);
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it("reports offline native availability when no native or legacy reader exists", async () => {
    await expect(makeReader().read(scope)).resolves.toMatchObject({
      items: [],
      source: "native",
      availability: "offline",
      completeness: "unknown",
    });
  });

  it("does not switch source after a native cursor has been issued", async () => {
    const nativeReader = vi.fn()
      .mockResolvedValueOnce({
        items: [item()],
        nextCursor: "provider-2",
        source: "native",
        revision: "native-r1",
        availability: "available",
        completeness: "complete",
      })
      .mockResolvedValueOnce({
        items: [],
        nextCursor: null,
        source: "native",
        revision: "native-r1",
        availability: "offline",
        completeness: "unknown",
      });
    const legacyReader = vi.fn().mockResolvedValue({
      items: [item({ id: "legacy-item", origin: "legacy" })],
      nextCursor: null,
      source: "legacy",
      revision: "legacy-r1",
      availability: "available",
      completeness: "complete",
    });
    const reader = makeReader({ nativeReader, legacyReader });
    const first = await reader.read(scope);
    const second = await reader.read({ ...scope, cursor: first.nextCursor });

    expect(second).toMatchObject({ source: "native", availability: "offline", items: [] });
    expect(legacyReader).not.toHaveBeenCalled();
    expect(nativeReader).toHaveBeenLastCalledWith(expect.objectContaining({
      cursor: "provider-2",
    }));
  });

  it("does not call a reader when any authorization boundary fails", async () => {
    const nativeReader = vi.fn();
    const legacyReader = vi.fn();
    const authorize = vi.fn(() => ({ ...authorization, run: false }));
    const reader = makeReader({ nativeReader, legacyReader, authorize });

    await expect(reader.read(scope)).rejects.toThrow("Transcript access denied");
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining(scope));
    expect(nativeReader).not.toHaveBeenCalled();
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it("rejects cursor reuse across org, principal, run, span, source, and revision", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [item()],
      nextCursor: "provider-2",
      source: "native",
      revision: "native-r1",
      availability: "available",
      completeness: "complete",
    });
    const reader = makeReader({ nativeReader });
    const first = await reader.read(scope);
    const cursor = first.nextCursor!;

    await expect(reader.read({ ...scope, orgId: "org-2", cursor })).rejects.toThrow("scope");
    await expect(reader.read({ ...scope, principal: { ...scope.principal, id: "user-2" }, cursor })).rejects.toThrow("scope");
    await expect(reader.read({ ...scope, runId: "run-2", cursor })).rejects.toThrow("scope");
    await expect(reader.read({ ...scope, spanId: "span-2", cursor })).rejects.toThrow("scope");
    await expect(reader.read({ ...scope, mode: "legacy", cursor })).rejects.toThrow("source");

    const changedRevisionReader = makeReader({
      nativeReader: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        source: "native",
        revision: "native-r2",
        availability: "available",
        completeness: "complete",
      }),
    });
    await expect(changedRevisionReader.read({ ...scope, cursor })).rejects.toThrow("revision");
  });

  it("passes range and cutoff to the hook and filters returned boundaries", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [
        item({ id: "before", ordinal: 1 }),
        item({ id: "inside", ordinal: 3 }),
        item({ id: "after", ordinal: 5 }),
        item({ id: "other-run", ordinal: 3, runId: "run-2" }),
        item({ id: "other-span", ordinal: 3, spanId: "span-2" }),
        item({ id: "hidden", ordinal: 3, visibility: "hidden" }),
      ],
      nextCursor: null,
      source: "native",
      revision: "native-r1",
      availability: "available",
      completeness: "partial",
    });
    const range = {
      fromExclusive: { itemId: "from", ordinal: 1 },
      throughInclusive: { itemId: "through", ordinal: 4 },
    };
    const page = await makeReader({ nativeReader }).read({ ...scope, range });

    expect(page.items.map((entry) => entry.id)).toEqual(["inside"]);
    expect(nativeReader).toHaveBeenCalledWith(expect.objectContaining({
      range,
      visibilityCutoffRef: "cutoff-1",
    }));
  });

  it("prefers an exact item id over a stale ordinal on an end boundary", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [
        item({ id: "first", ordinal: 1 }),
        item({ id: "target", ordinal: 3 }),
        item({ id: "after", ordinal: 2 }),
      ],
      nextCursor: null,
      source: "native",
      revision: "native-r1",
      availability: "available",
      completeness: "complete",
    });
    const page = await makeReader({ nativeReader }).read({
      ...scope,
      range: { end: { itemId: "target", ordinal: 1 } },
    });

    expect(page.items.map((entry) => entry.id)).toEqual(["first", "target"]);
  });

  it("treats numeric range ends as absolute source indexes", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [
        item({ id: "zero", ordinal: 2 }),
        item({ id: "one", ordinal: 1 }),
        item({ id: "two", ordinal: 3 }),
        item({ id: "three", ordinal: 0 }),
      ],
      nextCursor: null,
      source: "native",
      revision: "native-r1",
      availability: "available",
      completeness: "complete",
    });
    const page = await makeReader({ nativeReader }).read({
      ...scope,
      range: { start: 1, end: 2 },
    });

    expect(page.items.map((entry) => entry.id)).toEqual(["one", "two"]);
  });

  it("keeps all projections of a native item inside inclusive and exclusive boundaries", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [
        item({ id: "tool", sourceEntryId: "tool", ordinal: 0 }),
        item({ id: "tool:result", sourceEntryId: "tool", ordinal: 1 }),
        item({ id: "reply", sourceEntryId: "reply", ordinal: 2 }),
      ],
      source: "native", revision: "native-r1", availability: "available", completeness: "complete",
    });
    const reader = makeReader({ nativeReader });
    for (const range of [{ end: "tool" }, { throughInclusive: "tool" }]) {
      const page = await reader.read({ ...scope, range, limit: 10 });
      expect(page.items.map((entry) => entry.id)).toEqual(["tool", "tool:result"]);
    }
    const after = await reader.read({ ...scope, range: { fromExclusive: "tool" }, limit: 10 });
    expect(after.items.map((entry) => entry.id)).toEqual(["reply"]);
    const cutoffReader = makeReader({
      nativeReader,
      authorize: () => ({ ...authorization, visibilityCutoffRef: "tool", visibilityCutoff: { ref: "tool", itemId: "tool", ordinal: 1 } }),
    });
    const cutoff = await cutoffReader.read({ ...scope, limit: 10 });
    expect(cutoff.items.map((entry) => entry.id)).toEqual(["tool", "tool:result"]);
  });

  it("honors zero as a numeric exclusive, inclusive, and before boundary", async () => {
    const reader = makeReader({ nativeReader: vi.fn().mockResolvedValue({
      items: [item({ id: "zero", ordinal: 0 }), item({ id: "one", ordinal: 1 })],
      source: "native", revision: "native-r1", availability: "available", completeness: "complete",
    }) });
    const after = await reader.read({ ...scope, range: { fromExclusive: 0 } });
    expect(after.items.map((entry) => entry.id)).toEqual(["one"]);
    const through = await reader.read({ ...scope, range: { throughInclusive: 0 } });
    expect(through.items.map((entry) => entry.id)).toEqual(["zero"]);
    const before = await reader.read({ ...scope, range: { before: 0 } });
    expect(before.items).toEqual([]);
  });

  it("binds a cursor to the requested range as well as the source", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [item()],
      nextCursor: "provider-2",
      source: "native",
      revision: "native-r1",
      availability: "available",
      completeness: "complete",
    });
    const reader = makeReader({ nativeReader });
    const range = { fromExclusive: 0 };
    const first = await reader.read({ ...scope, range });

    await expect(reader.read({ ...scope, range: { fromExclusive: 1 }, cursor: first.nextCursor })).rejects.toThrow("range");
  });

  it("preserves an explicit native-plus-objects source", async () => {
    const reader = makeReader({
      nativeReader: vi.fn().mockResolvedValue({
        items: [item()],
        nextCursor: null,
        source: "native_plus_objects",
        revision: "native-r1",
        availability: "available",
        completeness: "partial",
      }),
    });

    await expect(reader.read(scope)).resolves.toMatchObject({
      source: "native_plus_objects",
      completeness: "partial",
    });
  });

  it("supports run-level reads while retaining span-level filtering when requested", async () => {
    const nativeReader = vi.fn().mockResolvedValue({
      items: [item({ id: "span-1-item" }), item({ id: "span-2-item", spanId: "span-2" })],
      nextCursor: null,
      source: "native",
      revision: "native-r1",
      availability: "available",
      completeness: "complete",
    });
    const reader = makeReader({ nativeReader });
    const page = await reader.read({ ...scope, spanId: null });

    expect(page.items.map((entry) => entry.id)).toEqual(["span-1-item", "span-2-item"]);
  });

  it("falls back from a missing native hook to durable legacy transcript entries", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
      events: [{
        id: 41,
        seq: 1,
        eventType: "transcript.entry",
        payload: { kind: "assistant", ts: "2026-09-22T00:00:01.000Z", text: "legacy durable" },
        createdAt: new Date("2026-09-22T00:00:01.000Z"),
      }, {
        id: 42,
        seq: null,
        eventType: "transcript.entry",
        payload: { kind: "assistant", ts: "2026-09-22T00:00:02.000Z", text: "live only" },
        createdAt: new Date("2026-09-22T00:00:02.000Z"),
      }],
    });
    const reader = createTranscriptReader(db as never);

    await expect(reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 10,
    })).resolves.toMatchObject({
      source: "legacy",
      availability: "available",
      items: [expect.objectContaining({ text: "legacy durable", origin: "legacy" })],
    });
  });

  it.each([
    ["native transcript source marker", { transcriptSource: "native" }],
    ["runtime binding marker", { runtimeBindingId: "binding-native" }],
  ])("does not read a stale legacy log for a marked native run with no span (%s)", async (_label, marker) => {
    const legacyReader = vi.fn().mockResolvedValue({
      entries: [item({ id: "stale-legacy-item", origin: "legacy" })],
      revision: "legacy-stale-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const db = mockDatabase({
      run: databaseRun({
        contextSnapshot: marker,
        logStore: "local_file",
        logRef: "stale-native-run.ndjson",
      }),
    });
    const reader = createTranscriptReader(db as never, { legacyReader: { readRun: legacyReader } });

    await expect(reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
    })).resolves.toMatchObject({
      source: "native",
      availability: "missing",
      items: [],
    });
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it("does not replace an empty native span with a stale logRef transcript", async () => {
    const db = mockDatabase({
      run: databaseRun({
        contextSnapshot: { transcriptSource: "native" },
        logStore: "local_file",
        logRef: "stale-native-run.ndjson",
      }),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      revision: "native-empty-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const legacyReader = vi.fn().mockResolvedValue({
      entries: [item({ id: "stale-legacy-item", origin: "legacy" })],
      revision: "legacy-stale-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const reader = createTranscriptReader(db as never, {
      nativeReader: { read: nativeReader },
      legacyReader: { readRun: legacyReader },
    });

    await expect(reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
    })).resolves.toMatchObject({
      source: "native",
      availability: "available",
      completeness: "complete",
      items: [],
    });
    expect(nativeReader).toHaveBeenCalledOnce();
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it("rejects a span whose binding, segment, and selector runtimes disagree before reading", async () => {
    const nativeReader = vi.fn();
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1", { selectorJson: { kind: "codex_turn", threadId: "thread-1", turnId: "turn-1" } })],
      bindings: [databaseBinding("span-1", { runtimeType: "codex_local" })],
      segments: [databaseSegment("span-1", { runtimeType: "pi_local" })],
    });
    const reader = createTranscriptReader(db as never, {
      nativeReader: { readRange: nativeReader },
    });

    await expect(reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
    })).rejects.toThrow("runtime identity is inconsistent");
    expect(nativeReader).not.toHaveBeenCalled();
  });

  it("keeps an open pending span readable without querying a provider for an unbounded session", async () => {
    const nativeReader = vi.fn();
    const legacyRead = vi.fn();
    const db = mockDatabase({
      run: databaseRun({ status: "running", logStore: "local_file", logRef: "old-retained.ndjson" }),
      spans: [databaseSpan("span-1", {
        state: "open",
        completeness: "unknown",
        selectorJson: { kind: "pending", runtimeType: "codex_local" },
      })],
      bindings: [databaseBinding("span-1", { runtimeType: "codex_local" })],
      segments: [databaseSegment("span-1", { runtimeType: "codex_local" })],
    });
    const reader = createTranscriptReader(db as never, {
      nativeReader: { readRange: nativeReader }, logStore: { read: legacyRead } as never,
    });

    await expect(reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
    })).resolves.toMatchObject({ source: "native", availability: "pending", completeness: "unknown", items: [] });
    expect(nativeReader).not.toHaveBeenCalled();
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it("does not describe an unresolved terminal native span as still pending", async () => {
    const db = mockDatabase({
      run: databaseRun({ status: "failed" }),
      spans: [databaseSpan("span-1", { state: "open", completeness: "unknown", selectorJson: { kind: "pending", runtimeType: "codex_local" } })],
      bindings: [databaseBinding("span-1", { runtimeType: "codex_local" })],
      segments: [databaseSegment("span-1", { runtimeType: "codex_local" })],
    });
    const page = await createTranscriptReader(db as never).readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
    });
    expect(page.availability).toBe("missing");
  });

  it("reads retained live output before a common Run has acquired its exact native selector", async () => {
    const bytes = Buffer.from(`${JSON.stringify({ ts: "2026-09-22T00:00:01.000Z", stream: "stdout", chunk: "live output\\n" })}\n`);
    const log = makeUtf8LogStore(bytes);
    const nativeReader = vi.fn();
    const db = mockDatabase({
      run: databaseRun({ status: "running", logStore: "local_file", logRef: "live.ndjson", contextSnapshot: { transcriptSource: "legacy", runtimeBindingId: "binding-span-1" } }),
      spans: [databaseSpan("span-1", { state: "open", completeness: "unknown", selectorJson: { kind: "pending", runtimeType: "codex_local" } })],
      bindings: [databaseBinding("span-1", { runtimeType: "codex_local", continuity: "native" })],
      segments: [databaseSegment("span-1", { runtimeType: "codex_local" })],
    });
    const page = await createTranscriptReader(db as never, { logStore: log.store, nativeReader: { readRange: nativeReader } }).readRun({
      orgId: "org-1", runId: "run-1", principal: { type: "board", orgId: "org-1", authorized: true },
    });
    expect(page).toMatchObject({ source: "legacy", availability: "available" });
    expect(page.items.length).toBeGreaterThan(0);
    expect(nativeReader).not.toHaveBeenCalled();
    expect(log.read).toHaveBeenCalled();
  });

  it("applies an exact legacy item boundary after native fallback", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
      events: [
        {
          id: 41,
          seq: 1,
          eventType: "transcript.entry",
          payload: { kind: "assistant", ts: "2026-09-22T00:00:01.000Z", text: "one" },
          createdAt: new Date("2026-09-22T00:00:01.000Z"),
        },
        {
          id: 42,
          seq: 2,
          eventType: "transcript.entry",
          payload: { kind: "assistant", ts: "2026-09-22T00:00:02.000Z", text: "two" },
          createdAt: new Date("2026-09-22T00:00:02.000Z"),
        },
      ],
    });
    const reader = createTranscriptReader(db as never);

    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      range: { end: { itemId: "42", ordinal: 0 } },
      limit: 10,
    });

    expect(page.items.map((entry) => entry.sourceEntryId)).toEqual(["41", "42"]);
  });

  it("tries a native span before falling back to persisted legacy entries", async () => {
    const db = mockDatabase({
      run: databaseRun({
        contextSnapshot: { runtimeBindingId: "binding-span-1" },
        resultJson: {
          entries: [{ kind: "assistant", ts: "2026-09-22T00:00:01.000Z", text: "CLI reply", sourceEntryId: "cli-1" }],
          retention: { transcriptSource: "legacy", rawResultPersisted: true },
        },
      }),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1", { continuity: "native" })],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn().mockResolvedValue({
      entries: [], revision: "empty-native", availability: "missing", completeness: "unknown",
    });
    const reader = createTranscriptReader(db as never, { nativeReader: { readRange: nativeReader } });

    const page = await reader.readRun({
      orgId: "org-1", runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
    });
    expect(page.source).toBe("legacy");
    expect(page.items).toEqual([expect.objectContaining({
      spanId: "span-1", sourceEntryId: "cli-1", origin: "legacy", text: "CLI reply",
    })]);
    expect(nativeReader).toHaveBeenCalledOnce();
  });

  it("continues from a partial native span into retained legacy pages", async () => {
    const db = mockDatabase({
      run: databaseRun({
        resultJson: {
          entries: [{ kind: "assistant", ts: "2026-09-22T00:00:02.000Z", text: "legacy tail", sourceEntryId: "legacy-tail" }],
          retention: { transcriptSource: "legacy", rawResultPersisted: true },
        },
      }),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1", { continuity: "native" })],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn().mockResolvedValue({
      entries: [{ kind: "assistant", ts: "2026-09-22T00:00:01.000Z", text: "native prefix", sourceEntryId: "native-prefix" }],
      revision: "partial-native",
      availability: "available",
      completeness: "partial",
      truncated: true,
    });
    const reader = createTranscriptReader(db as never, { nativeReader: { readRange: nativeReader } });
    const input = {
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 1,
    };

    const nativePage = await reader.readRun(input);
    expect(nativePage).toMatchObject({
      source: "native",
      completeness: "partial",
      truncated: true,
      nextCursor: expect.any(String),
    });
    expect(nativePage.items.map((entry) => entry.sourceEntryId)).toEqual(["native-prefix"]);
    const legacyPage = await reader.readRun({ ...input, cursor: nativePage.nextCursor });
    expect(legacyPage).toMatchObject({ source: "legacy", completeness: "complete", nextCursor: null });
    expect(legacyPage.items.map((entry) => [entry.sourceEntryId, entry.origin, entry.text])).toEqual([
      ["legacy-tail", "legacy", "legacy tail"],
    ]);
    expect(nativeReader).toHaveBeenCalledOnce();
  });

  it("keeps offline-empty native status when legacy has no readable transcript", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
    });
    const reader = createTranscriptReader(db as never);

    await expect(reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
    })).resolves.toMatchObject({
      source: "native",
      availability: "offline",
      items: [],
    });
  });

  it("preserves an explicit legacy incompatibility when fallback is empty", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
    });
    const legacyReader = vi.fn().mockResolvedValue({
      entries: [],
      revision: "legacy-incompatible-r1",
      availability: "incompatible" as const,
      completeness: "unknown" as const,
    });
    const reader = createTranscriptReader(db as never, { legacyReader: { readRun: legacyReader } });

    await expect(reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
    })).resolves.toMatchObject({
      availability: "incompatible",
      items: [],
    });
  });

  it("does not fall back through an incompatible native source", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn().mockResolvedValue({
      items: [],
      revision: "native-r-incompatible",
      availability: "incompatible" as const,
      completeness: "unknown" as const,
    });
    const legacyReader = vi.fn().mockResolvedValue({
      entries: [item({ id: "legacy-item", origin: "legacy" })],
      revision: "legacy-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const reader = createTranscriptReader(db as never, {
      nativeReader: { read: nativeReader },
      legacyReader: { readRun: legacyReader },
    });

    await expect(reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
    })).resolves.toMatchObject({
      source: "native",
      availability: "incompatible",
      items: [],
    });
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it.each(["native", "context_handoff"])("keeps an offline %s binding unavailable instead of substituting old duplicated logs", async (continuity) => {
    const db = mockDatabase({
      run: databaseRun({ contextSnapshot: { transcriptSource: "native" } }),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1", { continuity })],
      segments: [databaseSegment("span-1")],
    });
    const legacyReader = vi.fn().mockResolvedValue({
      entries: [item({ id: "old-copy", origin: "legacy" })],
      revision: "old-copy", availability: "available", completeness: "complete",
    });
    const reader = createTranscriptReader(db as never, {
      nativeReader: { read: vi.fn().mockResolvedValue({
        items: [], revision: "offline", availability: "offline", completeness: "unknown",
      }) },
      legacyReader: { readRun: legacyReader },
    });
    await expect(reader.readRun({
      orgId: "org-1", runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
    })).resolves.toMatchObject({ source: "native", availability: "offline", items: [] });
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it("filters native items by their span before applying the requested range", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [
        databaseSpan("span-a", { ordinal: 0, bindingId: "binding-shared", segmentId: "segment-shared" }),
        databaseSpan("span-b", { ordinal: 1, bindingId: "binding-shared", segmentId: "segment-shared" }),
      ],
      bindings: [databaseBinding("shared")],
      segments: [databaseSegment("shared")],
    });
    const nativeReader = vi.fn(async (input: NativeTranscriptReadInput) => ({
      items: input.span.id === "span-a"
        ? [{ id: "a-1", kind: "assistant", ts: "2026-09-22T00:00:01.000Z", runId: "run-1", spanId: "span-a", ordinal: 1, payload: { text: "a" } },
          { id: "leaked-b", kind: "assistant", ts: "2026-09-22T00:00:02.000Z", runId: "run-1", spanId: "span-b", ordinal: 1, payload: { text: "wrong span" } }]
        : [{ id: "b-1", kind: "assistant", ts: "2026-09-22T00:00:03.000Z", runId: "run-1", spanId: "span-b", ordinal: 1, payload: { text: "b" }}],
      revision: `revision-${input.span.id}`,
      availability: "available" as const,
      completeness: "complete" as const,
    }));
    const reader = createTranscriptReader(db as never, { nativeReader: { read: nativeReader } });

    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      range: { fromExclusive: { ordinal: 0 }, throughInclusive: { ordinal: 1 } },
      limit: 10,
    });

    expect(page.source).toBe("native");
    expect(page.items.map((entry) => entry.id)).toEqual(["a-1", "b-1"]);
    expect(nativeReader).toHaveBeenCalledTimes(2);
  });

  it("applies item ID boundaries across the ordered native Run spans", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [
        databaseSpan("span-a", { ordinal: 0, bindingId: "binding-shared", segmentId: "segment-shared" }),
        databaseSpan("span-b", { ordinal: 1, bindingId: "binding-shared", segmentId: "segment-shared" }),
      ],
      bindings: [databaseBinding("shared")],
      segments: [databaseSegment("shared")],
    });
    const nativeReader = vi.fn(async (input: NativeTranscriptReadInput) => ({
      items: input.span.id === "span-a"
        ? [
          item({ id: "a-before", sourceEntryId: "a-before", spanId: "span-a", ordinal: 0 }),
          item({ id: "a-start", sourceEntryId: "a-start", spanId: "span-a", ordinal: 1 }),
          item({ id: "a-after", sourceEntryId: "a-after", spanId: "span-a", ordinal: 2 }),
        ]
        : [
          item({ id: "b-before", sourceEntryId: "b-before", spanId: "span-b", ordinal: 0 }),
          item({ id: "b-end", sourceEntryId: "b-end", spanId: "span-b", ordinal: 1 }),
          item({ id: "b-after", sourceEntryId: "b-after", spanId: "span-b", ordinal: 2 }),
        ],
      revision: `revision-${input.span.id}`,
      availability: "available" as const,
      completeness: "complete" as const,
    }));
    const reader = createTranscriptReader(db as never, { nativeReader: { read: nativeReader } });

    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      range: { start: "a-start", end: "b-end" },
      limit: 10,
    });

    expect(page.items.map((entry) => entry.id)).toEqual(["a-start", "a-after", "b-before", "b-end"]);
    expect(nativeReader).toHaveBeenCalledTimes(2);
    expect(nativeReader).toHaveBeenNthCalledWith(1, expect.objectContaining({ range: null }));
    expect(nativeReader).toHaveBeenNthCalledWith(2, expect.objectContaining({ range: null }));
  });

  it("carries a resolved item ID start across a Run span cursor", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [
        databaseSpan("span-a", { ordinal: 0, bindingId: "binding-shared", segmentId: "segment-shared" }),
        databaseSpan("span-b", { ordinal: 1, bindingId: "binding-shared", segmentId: "segment-shared" }),
      ],
      bindings: [databaseBinding("shared")],
      segments: [databaseSegment("shared")],
    });
    const nativeReader = vi.fn(async (input: NativeTranscriptReadInput) => ({
      items: input.span.id === "span-a"
        ? [
          item({ id: "a-before", sourceEntryId: "a-before", spanId: "span-a", ordinal: 0 }),
          item({ id: "a-start", sourceEntryId: "a-start", spanId: "span-a", ordinal: 1 }),
          item({ id: "a-after", sourceEntryId: "a-after", spanId: "span-a", ordinal: 2 }),
        ]
        : [
          item({ id: "b-before", sourceEntryId: "b-before", spanId: "span-b", ordinal: 0 }),
          item({ id: "b-end", sourceEntryId: "b-end", spanId: "span-b", ordinal: 1 }),
          item({ id: "b-after", sourceEntryId: "b-after", spanId: "span-b", ordinal: 2 }),
        ],
      revision: `revision-${input.span.id}`,
      availability: "available" as const,
      completeness: "complete" as const,
    }));
    const reader = createTranscriptReader(db as never, { nativeReader: { read: nativeReader } });
    const runInput = {
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board" as const, orgId: "org-1", authorized: true },
      range: { start: "a-start", end: "b-end" },
      limit: 2,
    };

    const first = await reader.readRun(runInput);
    const second = await reader.readRun({ ...runInput, cursor: first.nextCursor });

    expect(first.items.map((entry) => entry.id)).toEqual(["a-start", "a-after"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.items.map((entry) => entry.id)).toEqual(["b-before", "b-end"]);
    expect(second.nextCursor).toBeNull();
  });

  it("applies item ID boundaries across native and legacy Run spans", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [
        databaseSpan("span-a", { ordinal: 0, bindingId: "binding-shared", segmentId: "segment-shared" }),
        databaseSpan("span-b", { ordinal: 1, bindingId: "binding-shared", segmentId: "segment-shared" }),
      ],
      bindings: [databaseBinding("shared")],
      segments: [databaseSegment("shared")],
    });
    const nativeReader = vi.fn(async (input: NativeTranscriptReadInput) => input.span.id === "span-a"
      ? {
        items: [
          item({ id: "native-before", sourceEntryId: "native-before", spanId: "span-a", ordinal: 0 }),
          item({ id: "native-start", sourceEntryId: "native-start", spanId: "span-a", ordinal: 1 }),
          item({ id: "native-after", sourceEntryId: "native-after", spanId: "span-a", ordinal: 2 }),
        ],
        revision: "native-a-r1",
        availability: "available" as const,
        completeness: "complete" as const,
      }
      : {
        items: [],
        revision: "native-b-r1",
        availability: "offline" as const,
        completeness: "unknown" as const,
      });
    const legacyReader = vi.fn().mockImplementation(async (input: { spanId?: string | null }) => ({
      entries: input.spanId === "span-b" ? [
        { kind: "assistant", ts: "2026-09-22T00:00:03.000Z", text: "before", sourceEntryId: "legacy-before" },
        { kind: "assistant", ts: "2026-09-22T00:00:04.000Z", text: "end", sourceEntryId: "legacy-end" },
        { kind: "assistant", ts: "2026-09-22T00:00:05.000Z", text: "after", sourceEntryId: "legacy-after" },
      ] : [],
      revision: "legacy-b-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    }));
    const reader = createTranscriptReader(db as never, {
      nativeReader: { read: nativeReader },
      legacyReader: { readRun: legacyReader },
    });

    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      range: { start: "native-start", end: "legacy-end" },
      limit: 10,
    });

    expect(page.items.map((entry) => entry.id)).toEqual([
      "native-start", "native-after", "legacy-before", "legacy-end",
    ]);
    expect(nativeReader).toHaveBeenCalledTimes(2);
    expect(legacyReader).toHaveBeenCalledOnce();
  });

  it("fails closed when an item ID range boundary is unknown across Run spans", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [
        databaseSpan("span-a", { ordinal: 0, bindingId: "binding-shared", segmentId: "segment-shared" }),
        databaseSpan("span-b", { ordinal: 1, bindingId: "binding-shared", segmentId: "segment-shared" }),
      ],
      bindings: [databaseBinding("shared")],
      segments: [databaseSegment("shared")],
    });
    const nativeReader = vi.fn(async (input: NativeTranscriptReadInput) => ({
      items: input.span.id === "span-a"
        ? [item({ id: "a-start", spanId: "span-a" })]
        : [item({ id: "b-end", spanId: "span-b" })],
      revision: `revision-${input.span.id}`,
      availability: "available" as const,
      completeness: "complete" as const,
    }));
    const reader = createTranscriptReader(db as never, { nativeReader: { read: nativeReader } });
    const runInput = {
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board" as const, orgId: "org-1", authorized: true },
      limit: 10,
    };

    const unknownStart = await reader.readRun({ ...runInput, range: { start: "missing-start", end: "b-end" } });
    const unknownEnd = await reader.readRun({ ...runInput, range: { start: "a-start", end: "missing-end" } });

    expect(unknownStart.items).toEqual([]);
    expect(unknownEnd.items).toEqual([]);
  });

  it("falls back only the empty unavailable span in a mixed run", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [
        databaseSpan("span-a", { ordinal: 0, bindingId: "binding-shared", segmentId: "segment-shared" }),
        databaseSpan("span-b", { ordinal: 1, bindingId: "binding-shared", segmentId: "segment-shared" }),
      ],
      bindings: [databaseBinding("shared")],
      segments: [databaseSegment("shared")],
    });
    const nativeReader = vi.fn(async (input: NativeTranscriptReadInput) => input.span.id === "span-a"
      ? {
        items: [{
          id: "native-a",
          kind: "assistant",
          ts: "2026-09-22T00:00:01.000Z",
          runId: "run-1",
          spanId: "span-a",
          payload: { text: "native" },
        }],
        revision: "native-a-r1",
        availability: "available" as const,
        completeness: "complete" as const,
      }
      : {
        items: [],
        revision: "native-b-r1",
        availability: "offline" as const,
        completeness: "unknown" as const,
      });
    const legacyReader = vi.fn().mockResolvedValue({
      entries: [{
        kind: "assistant",
        ts: "2026-09-22T00:00:02.000Z",
        text: "legacy",
        sourceEntryId: "legacy-b",
      }],
      revision: "legacy-b-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const reader = createTranscriptReader(db as never, {
      nativeReader: { read: nativeReader },
      legacyReader: { readRun: legacyReader },
    });

    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 10,
    });

    expect(page.items.map((entry) => [entry.id, entry.spanId, entry.origin])).toEqual([
      ["native-a", "span-a", "native"],
      ["legacy-b", "span-b", "legacy"],
    ]);
    expect(legacyReader).toHaveBeenCalledOnce();
    expect(legacyReader).toHaveBeenCalledWith(expect.objectContaining({ spanId: "span-b" }));
  });

  it("tries an object supplement before falling back to legacy when native is offline-empty", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1", { supplementalObjectRef: "object-1" })],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn().mockResolvedValue({
      items: [],
      revision: "native-r1",
      availability: "offline" as const,
      completeness: "unknown" as const,
    });
    const objectReader = vi.fn().mockResolvedValue({
      items: [{
        id: "object-item",
        kind: "assistant",
        ts: "2026-09-22T00:00:01.000Z",
        runId: "run-1",
        spanId: "span-1",
        payload: { text: "object transcript" },
      }],
      revision: "object-r1",
      source: "native_plus_objects" as const,
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const legacyReader = vi.fn();
    const reader = createTranscriptReader(db as never, {
      nativeReader: { read: nativeReader },
      objectReader: { read: objectReader },
      legacyReader: { readRun: legacyReader },
    });

    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
    });

    expect(page).toMatchObject({ source: "native_plus_objects", availability: "available" });
    expect(page.items.map((entry) => entry.id)).toEqual(["object-item"]);
    expect(nativeReader).toHaveBeenCalledOnce();
    expect(objectReader).toHaveBeenCalledOnce();
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it("uses the fenced Cursor object as the sole Reader source for repeated chunks across pages", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1", { supplementalObjectRef: "object-1", completeness: "partial" })],
      bindings: [databaseBinding("span-1", { runtimeType: "cursor", continuity: "native" })],
      segments: [databaseSegment("span-1", { runtimeType: "cursor" })],
    });
    const nativeReader = vi.fn();
    const legacyReader = vi.fn();
    const objectReader = vi.fn().mockImplementation(async (input: { cursor: string | null }) => ({
      entries: [{ kind: "assistant", ts: "2026-09-22T00:00:01.000Z", text: "Again ", delta: true,
        sourceEntryId: input.cursor ? "object:entry:2" : "object:entry:1" }],
      nextCursor: input.cursor ? null : "object-page-2",
      revision: "object-revision", availability: "available", completeness: "partial",
    }));
    const reader = createTranscriptReader(db as never, {
      nativeReader: { readRange: nativeReader }, objectReader: { readRange: objectReader },
      legacyReader: { readRun: legacyReader },
    });
    const scope = { orgId: "org-1", runId: "run-1",
      principal: { type: "board" as const, orgId: "org-1", authorized: true } };
    const first = await reader.readRun({ ...scope, limit: 1 });
    const second = await reader.readRun({ ...scope, cursor: first.nextCursor, limit: 1 });
    expect([first, second].map((page) => page.items[0]?.sourceEntryId)).toEqual([
      "object:entry:1", "object:entry:2",
    ]);
    expect([first, second].every((page) => page.items[0]?.origin === "object")).toBe(true);
    expect(nativeReader).not.toHaveBeenCalled();
    expect(legacyReader).not.toHaveBeenCalled();
    objectReader.mockResolvedValueOnce({ entries: [], revision: "object-missing",
      availability: "missing", completeness: "unknown" });
    const missing = await reader.readRun(scope);
    expect(missing.items).toEqual([]);
    expect(missing.availability).toBe("missing");
    expect(nativeReader).not.toHaveBeenCalled();
    expect(legacyReader).not.toHaveBeenCalled();
  });

  it("merges an object supplement into a partial native span without duplicating entries", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1", {
        completeness: "partial",
        supplementalObjectRef: "object-1",
      })],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn().mockResolvedValue({
      items: [{
        id: "native-item",
        sourceEntryId: "shared-item",
        ordinal: 0,
        kind: "assistant",
        ts: "2026-09-22T00:00:01.000Z",
        runId: "run-1",
        spanId: "span-1",
        payload: { text: "native" },
      }],
      revision: "native-r1",
      availability: "available" as const,
      completeness: "partial" as const,
    });
    const objectReader = vi.fn().mockResolvedValue({
      items: [
        {
          id: "shared-item",
          sourceEntryId: "shared-item",
          ordinal: 0,
          kind: "assistant",
          ts: "2026-09-22T00:00:01.000Z",
          runId: "run-1",
          spanId: "span-1",
          payload: { text: "duplicate" },
        },
        {
          id: "object-tail",
          ordinal: 1,
          kind: "tool_result",
          ts: "2026-09-22T00:00:02.000Z",
          runId: "run-1",
          spanId: "span-1",
          payload: { text: "supplement" },
        },
      ],
      revision: "object-r1",
      source: "native_plus_objects" as const,
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const reader = createTranscriptReader(db as never, {
      nativeReader: { read: nativeReader },
      objectReader: { read: objectReader },
    });

    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 10,
    });

    expect(page.source).toBe("native_plus_objects");
    expect(page.items.map((entry) => entry.id)).toEqual(["native-item", "object-tail"]);
    expect(nativeReader).toHaveBeenCalledOnce();
    expect(objectReader).toHaveBeenCalledWith(expect.objectContaining({ cursor: null }));
  });

  it("reports an expired Side Chat supplement without falling back to partial native history", async () => {
    const readInput = {
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board" as const, orgId: "org-1", authorized: true },
      limit: 10,
    };
    const objectReader = vi.fn().mockResolvedValue({
      items: [{ id: "supplement", kind: "assistant", ts: "2026-09-22T00:00:01.000Z", payload: { text: "full history" } }],
      availability: "available", completeness: "complete", revision: "object-r1",
    });
    const nativeReader = vi.fn().mockResolvedValue({
      items: [], availability: "available", completeness: "partial", revision: "native-r1",
    });
    const makeReader = (expiredAt: Date | null) => createTranscriptReader(mockDatabase({
      run: databaseRun({ resultJson: { retention: { transcriptSource: "native" } } }),
      spans: [databaseSpan("span-1", {
        supplementalObjectRef: "tobj_v1_11111111-1111-1111-1111-111111111111",
        supplementalRetentionExpiredAt: expiredAt,
      })],
      bindings: [databaseBinding("span-1", { runtimeType: "cursor", continuity: "native" })],
      segments: [databaseSegment("span-1", { runtimeType: "cursor" })],
    }) as never, {
      nativeReader: { read: nativeReader }, objectReader: { read: objectReader },
    });

    const before = await makeReader(null).readRun(readInput);
    expect(before).toMatchObject({ source: "native_plus_objects", availability: "available", completeness: "complete" });
    expect(before.items).toHaveLength(1);

    const after = await makeReader(new Date("2026-10-01T00:00:00.000Z")).readRun(readInput);
    expect(after).toMatchObject({ source: "native_plus_objects", availability: "expired", completeness: "unknown", items: [] });
    expect(objectReader).toHaveBeenCalledTimes(1);
    expect(nativeReader).not.toHaveBeenCalled();
  });

  it("reads one bounded native window and continues with the provider cursor", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn()
      .mockResolvedValueOnce({
        items: [{ id: "native-1", kind: "assistant", ts: "2026-09-22T00:00:01.000Z", payload: { text: "one" } }],
        nextCursor: "provider-1",
        revision: "native-r1",
        availability: "available" as const,
        completeness: "complete" as const,
      })
      .mockResolvedValueOnce({
        items: [{ id: "native-2", kind: "assistant", ts: "2026-09-22T00:00:02.000Z", payload: { text: "two" } }],
        nextCursor: null,
        revision: "native-r1",
        availability: "available" as const,
        completeness: "complete" as const,
      });
    const reader = createTranscriptReader(db as never, { nativeReader: { read: nativeReader } });

    const first = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 1,
    });
    expect(first.items.map((entry) => entry.id)).toEqual(["native-1"]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.items.map((entry) => entry.id)).toEqual(["native-2"]);
    expect(second.nextCursor).toBeNull();
    expect(nativeReader).toHaveBeenCalledTimes(2);
    expect(nativeReader).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: null, limit: 1 }));
    expect(nativeReader).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "provider-1", limit: 1 }));
  });

  it("passes native byte budgets across opaque continuation pages without duplicate items", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
    });
    const pageBytes = 256 * 1024;
    const itemBytes = 192 * 1024;
    const emittedPageBytes: number[] = [];
    const nativeReader = vi.fn(async (input: NativeTranscriptReadInput) => {
      const index = input.cursor === null ? 0 : Number(input.cursor.replace("native-page-", ""));
      const sourceItem = {
        id: `native-large-${index}`,
        kind: "assistant",
        ts: `2026-09-22T00:00:0${index}.000Z`,
        payload: { text: "x".repeat(180_000) },
      };
      const bytes = Buffer.byteLength(JSON.stringify([sourceItem]));
      if (bytes > (input.maxBytes ?? 0) || bytes - 2 > (input.maxItemBytes ?? 0)) {
        throw new Error("reader did not provide a sufficient source budget");
      }
      emittedPageBytes.push(bytes);
      return {
        items: [sourceItem],
        nextCursor: index < 3 ? `native-page-${index + 1}` : null,
        revision: "native-large-r1",
        availability: "available" as const,
        completeness: "complete" as const,
      };
    });
    const reader = createTranscriptReader(db as never, {
      nativeReader: { read: nativeReader },
      maxNativeReadBytes: pageBytes,
      maxNativeItemBytes: itemBytes,
    });

    const seen: string[] = [];
    const seenSequences: Array<number | undefined> = [];
    let cursor: string | null = null;
    do {
      const page = await reader.readRun({
        orgId: "org-1",
        runId: "run-1",
        principal: { type: "board", orgId: "org-1", authorized: true },
        cursor,
        limit: 50,
      });
      seen.push(...page.items.map((entry) => entry.id));
      seenSequences.push(...page.items.map((entry) => entry.sequence));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(["native-large-0", "native-large-1", "native-large-2", "native-large-3"]);
    expect(seenSequences).toEqual([0, 1, 2, 3]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(nativeReader.mock.calls.map(([input]) => input.cursor)).toEqual([
      null,
      "native-page-1",
      "native-page-2",
      "native-page-3",
    ]);
    expect(nativeReader.mock.calls.every(([input]) => input.maxBytes === pageBytes && input.maxItemBytes === itemBytes)).toBe(true);
    expect(emittedPageBytes.every((bytes) => bytes <= pageBytes)).toBe(true);
    expect(Math.max(...emittedPageBytes)).toBeLessThan(pageBytes);
  });

  it("rejects an oversized native hook result before transcript normalization", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn().mockResolvedValue({
      items: [{
        id: "oversized-native-item",
        kind: "assistant",
        ts: "2026-09-22T00:00:01.000Z",
        payload: { text: "x".repeat(2_000) },
      }],
      revision: "native-oversized-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const reader = createTranscriptReader(db as never, {
      nativeReader: { read: nativeReader },
      maxNativeReadBytes: 512,
      maxNativeItemBytes: 256,
    });

    await expect(reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 10,
    })).rejects.toMatchObject({ code: "source_budget_exceeded", status: 502 });
  });

  it("rejects a provider cursor that does not advance on continuation", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn().mockResolvedValue({
      items: [{ id: "native-1", kind: "assistant", ts: "2026-09-22T00:00:01.000Z", payload: { text: "one" } }],
      nextCursor: "provider-1",
      revision: "native-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const reader = createTranscriptReader(db as never, { nativeReader: { read: nativeReader } });
    const first = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 1,
    });

    await expect(reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      cursor: first.nextCursor,
      limit: 1,
    })).rejects.toThrow("cursor made no progress");
  });

  it("caps a long provider window without materializing its continuation", async () => {
    const db = mockDatabase({
      run: databaseRun(),
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1")],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn().mockResolvedValue({
      items: Array.from({ length: 200 }, (_, index) => ({
        id: `native-${index}`,
        kind: "assistant",
        ts: `2026-09-22T00:00:${String(index).padStart(2, "0")}.000Z`,
        payload: { text: String(index) },
      })),
      nextCursor: "provider-after-200",
      revision: "native-long-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const reader = createTranscriptReader(db as never, { nativeReader: { read: nativeReader } });

    const page = await reader.readRun({
      orgId: "org-1",
      runId: "run-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 2,
    });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(nativeReader).toHaveBeenCalledOnce();
  });

  it("bounds conversation run reads and resumes with the nested native cursor", async () => {
    const database = mockDatabase({
      conversations: [databaseConversation()],
      runs: [databaseRun({ chatConversationId: "conversation-1" })],
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1", {
        conversationId: "conversation-1",
        principalScopeRef: "member:1",
      })],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn()
      .mockResolvedValueOnce({
        items: [{ id: "run-item-1", kind: "assistant", ts: "2026-09-22T00:00:01.000Z", payload: { text: "one" } }],
        nextCursor: "provider-1",
        revision: "native-r1",
        availability: "available" as const,
        completeness: "complete" as const,
      })
      .mockResolvedValueOnce({
        items: [{ id: "run-item-2", kind: "assistant", ts: "2026-09-22T00:00:02.000Z", payload: { text: "two" } }],
        nextCursor: null,
        revision: "native-r1",
        availability: "available" as const,
        completeness: "complete" as const,
      });
    const reader = createTranscriptReader(database as never, { nativeReader: { read: nativeReader } });
    const principal = { type: "user", id: "user-1", scopeRef: "member:1", orgId: "org-1" };

    const first = await reader.readConversation({
      orgId: "org-1",
      conversationId: "conversation-1",
      principal,
      limit: 1,
    });
    expect(first.items.map((entry) => entry.id)).toEqual(["run-item-1"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(nativeReader).toHaveBeenCalledOnce();
    expect(nativeReader).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: null, limit: 1 }));

    const second = await reader.readConversation({
      orgId: "org-1",
      conversationId: "conversation-1",
      principal,
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.items.map((entry) => entry.id)).toEqual(["run-item-2"]);
    expect(second.nextCursor).toBeNull();
    expect(nativeReader).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "provider-1", limit: 1 }));
    expect(database.limitCalls).toContain(2);
  });

  it("retains a linked assistant projection without a stable native item match", async () => {
    const database = mockDatabase({
      conversations: [databaseConversation()],
      runs: [databaseRun({ chatConversationId: "conversation-1" })],
      messages: [databaseMessage({
        role: "assistant", runId: "run-1", body: "same answer",
        createdAt: new Date("2026-09-22T00:00:02.000Z"),
      })],
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1", { conversationId: "conversation-1" })],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn()
      .mockResolvedValueOnce({
        items: [{ id: "native-user", kind: "user", ts: "2026-09-22T00:00:01.000Z", payload: { text: "input" } }],
        nextCursor: "provider-1", revision: "native-r1", availability: "available", completeness: "complete",
      })
      .mockResolvedValueOnce({
        items: [{ id: "native-answer", kind: "assistant", ts: "2026-09-22T00:00:03.000Z", payload: { text: "same answer" } }],
        nextCursor: null, revision: "native-r1", availability: "available", completeness: "complete",
      });
    const reader = createTranscriptReader(database as never, { nativeReader: { readRange: nativeReader } });

    const page = await reader.readConversation({
      orgId: "org-1", conversationId: "conversation-1",
      principal: { type: "board", orgId: "org-1", authorized: true }, limit: 3,
    });
    expect(page.items.map((entry) => entry.id)).toEqual(["native-user", "message:message-1:0", "native-answer"]);
    expect(nativeReader).toHaveBeenCalledWith(expect.objectContaining({ cursor: "provider-1" }));
  });

  it("keeps the assistant message when complete native history contains only the input", async () => {
    const database = mockDatabase({
      conversations: [databaseConversation()],
      runs: [databaseRun({ chatConversationId: "conversation-1" })],
      messages: [databaseMessage({
        role: "assistant", runId: "run-1", body: "persisted answer",
        createdAt: new Date("2026-09-22T00:00:02.000Z"),
      })],
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1", { conversationId: "conversation-1" })],
      segments: [databaseSegment("span-1")],
    });
    const nativeReader = vi.fn()
      .mockResolvedValueOnce({
        items: [{ id: "native-user", kind: "user", ts: "2026-09-22T00:00:01.000Z", payload: { text: "input" } }],
        nextCursor: "provider-1", revision: "native-r1", availability: "available", completeness: "complete",
      })
      .mockResolvedValueOnce({
        items: [], nextCursor: null, revision: "native-r1", availability: "available", completeness: "complete",
      });
    const reader = createTranscriptReader(database as never, { nativeReader: { readRange: nativeReader } });

    const page = await reader.readConversation({
      orgId: "org-1", conversationId: "conversation-1",
      principal: { type: "board", orgId: "org-1", authorized: true }, limit: 2,
    });
    expect(page.items.map((entry) => entry.id)).toEqual(["native-user", "message:message-1:0"]);
    expect(page.items[1]?.text).toBe("persisted answer");
  });

  it("passes conversation range and visibility cutoff to nested run reads", async () => {
    const database = mockDatabase({
      conversations: [databaseConversation()],
      runs: [databaseRun({ chatConversationId: "conversation-1" })],
      spans: [databaseSpan("span-1")],
      bindings: [databaseBinding("span-1", {
        conversationId: "conversation-1",
        principalScopeRef: "member:1",
      })],
      segments: [databaseSegment("span-1")],
    });
    const range = { fromExclusive: { itemId: "run-before", ordinal: 0 } };
    const nativeReader = vi.fn().mockResolvedValue({
      items: [{ id: "run-item-1", kind: "assistant", ts: "2026-09-22T00:00:01.000Z", payload: { text: "one" } }],
      nextCursor: null,
      revision: "native-r1",
      availability: "available" as const,
      completeness: "complete" as const,
    });
    const reader = createTranscriptReader(database as never, { nativeReader: { read: nativeReader } });

    await reader.readConversation({
      orgId: "org-1",
      conversationId: "conversation-1",
      principal: { type: "user", id: "user-1", scopeRef: "member:1", orgId: "org-1" },
      range,
      visibilityCutoffRef: "cutoff-1",
      limit: 1,
    });

    expect(nativeReader).toHaveBeenCalledWith(expect.objectContaining({
      range,
      visibilityCutoffRef: "cutoff-1",
      limit: 1,
    }));
  });

  it("limits the conversation source window instead of loading every message", async () => {
    const database = mockDatabase({
      conversations: [databaseConversation()],
      messages: [
        databaseMessage({ id: "message-1" }),
        databaseMessage({ id: "message-2", createdAt: new Date("2026-09-22T00:00:02.000Z") }),
        databaseMessage({ id: "message-3", createdAt: new Date("2026-09-22T00:00:03.000Z") }),
      ],
    });
    const reader = createTranscriptReader(database as never);

    const page = await reader.readConversation({
      orgId: "org-1",
      conversationId: "conversation-1",
      principal: { type: "board", orgId: "org-1", authorized: true },
      limit: 1,
    });

    expect(page.items.map((entry) => entry.id)).toEqual(["message:message-1:0"]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(database.limitCalls).toContain(2);
  });

  it("exposes no execution or session mutation surface", () => {
    const reader = makeReader({ nativeReader: vi.fn() });
    expect(Object.keys(reader)).toEqual(["read"]);
    expect(reader).not.toHaveProperty("execute");
    expect(reader).not.toHaveProperty("resume");
    expect(reader).not.toHaveProperty("fork");
    expect(reader).not.toHaveProperty("control");
  });
});
