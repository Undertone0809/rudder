import { readPiNativeTranscript } from "@rudderhq/agent-runtime-pi-local/server";
import { heartbeatRunAttempts, heartbeatRunEvents, heartbeatRuns, runRuntimeSpans } from "@rudderhq/db";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanSealedNativeTranscriptMirrors, proveSealedNativeRunTranscript } from "./native-transcript-retention.js";
import { createTranscriptObjectReader, createTranscriptObjectStore } from "./transcript-object-store.js";
import { createTranscriptReader, type NativeTranscriptReadInput, type TranscriptPage, type TranscriptReader } from "./transcript-reader.js";
import type { TranscriptObjectStore } from "./transcript-object-store.js";
import { stableJson } from "../chat-agent-runs.helpers.js";
import { databaseBinding, databaseRun, databaseSegment, databaseSpan, mockDatabase } from "./transcript-reader.test-support.js";

type RemovalCapableTranscriptObjectStore = TranscriptObjectStore & {
  stageSealedRemoval: NonNullable<TranscriptObjectStore["stageSealedRemoval"]>;
  purgeStagedRemoval: NonNullable<TranscriptObjectStore["purgeStagedRemoval"]>;
};

async function fixture(count: number, budgets: { maxNativeReadBytes?: number; maxNativeItemBytes?: number } = {}) {
  // A synthetic Pi session file, read by the production indexed native reader.
  // Only a get_state protocol fixture is spawned; no installed CLI/model,
  // live data, supplement removal, or DB writes.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-w12-proof-fixture-"));
  const sessionFile = path.join(root, "session.jsonl");
  const command = path.join(root, "state-only-fixture.mjs");
  const requests = path.join(root, "requests.jsonl");
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(requests)}, line+'\\n');
  if(request.type!=='get_state') throw Error('Only read-only get_state is allowed');
  process.stdout.write(JSON.stringify({type:'response',command:'get_state',success:true,
    data:{sessionId:'proof-session',sessionFile:${JSON.stringify(sessionFile)}}})+'\\n');
});
`, { mode: 0o755 });
  const id = (index: number) => index.toString(16).padStart(8, "0");
  const rows = [{ type: "session", version: 3, id: "proof-session", cwd: root, timestamp: new Date(0).toISOString() },
    ...Array.from({ length: count }, (_, index) => ({ type: "message", id: id(index + 1),
      parentId: index ? id(index) : null, timestamp: new Date(index + 1).toISOString(),
      message: { role: index ? "assistant" : "user", content: [{ type: "text", text: `row-${index}-原生` }] } }))];
  const original = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  await fs.writeFile(sessionFile, original);
  const closedAt = new Date("2026-10-02T00:00:00Z");
  const span = databaseSpan("span-1", { orgId: "org-1", ownerToken: "owner-1", attemptEpoch: 1,
    attemptId: "attempt-1", state: "sealed", writerLeaseReleasedAt: closedAt,
    supplementalObjectRef: "retained-supplement", selectorJson: { kind: "pi_branch_range",
      sessionResourceRef: sessionFile, fromExclusive: null, throughInclusive: id(count), leafId: id(count) } });
  const base = mockDatabase({ run: databaseRun({ status: "succeeded", orgId: "org-1", executionOwnerToken: null,
    terminalEffectsPending: false, processExitedAt: closedAt, contextSnapshot: { transcriptSource: "native" } }),
    spans: [span], bindings: [databaseBinding("span-1", { runtimeType: "pi_local", continuity: "native" })],
    segments: [databaseSegment("span-1", { runtimeType: "pi_local", nativeSessionId: sessionFile })] });
  const attempt = { id: "attempt-1", ownerToken: "owner-1", attemptEpoch: 1, status: "succeeded", finishedAt: closedAt };
  const db = { select: (selection?: Record<string, unknown>) => {
    const query = base.select(selection), from = query.from as (table: unknown) => unknown;
    query.from = (table: unknown) => {
      if (table !== heartbeatRunAttempts) return from(table);
      const attemptQuery = { where: () => attemptQuery, limit: () => attemptQuery,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([attempt]).then(resolve) };
      return attemptQuery;
    };
    return query;
  } };
  const native = vi.fn(async (input: NativeTranscriptReadInput) => readPiNativeTranscript({ runtimeType: "pi_local", binding: { hostId: "local", profileId: "test" },
    session: { sessionId: sessionFile, sessionDisplayId: "proof-session", sessionParams: {
      sessionId: sessionFile, sessionFile, sessionDir: root, cwd: root, command,
      rpcEnv: {}, rpcArgs: [], transport: "pi-rpc-stdio", hostId: "local", profileId: "test", leafId: id(count) } },
    selector: input.selector, cursor: input.cursor, readerInput: input }));
  const reader = createTranscriptReader(db as never, { nativeReader: { readRange: native }, ...budgets });
  const scope = { orgId: "org-1", runId: "run-1", spanId: "span-1", principal: { type: "board", orgId: "org-1", authorized: true } };
  const prove = (override: TranscriptReader = reader) => proveSealedNativeRunTranscript({ db: db as never,
    reader: override, orgId: scope.orgId, runId: scope.runId });
  return { reader, scope, prove, native, span, sessionFile, original, requests, attempt };
}

describe("sealed native retention exact-range proof", () => {
  it.each(["tool_call", "assistant", "events_only", "log_only", "excerpt_only"] as const)("retains unproven %s despite two complete native traversals", async (kind) => {
    const f = await fixture(201);
    const store = createTranscriptObjectStore(path.join(path.dirname(f.sessionFile), "objects"));
    const binding = { orgId: "org-1", runId: "run-1", spanId: "span-1", ownerToken: "owner-1" };
    const entry = kind === "tool_call"
      ? { kind: "tool_call" as const, ts: new Date(0).toISOString(), name: "supplement-only-tool", input: { missingFromNative: true } }
      : { kind: "assistant" as const, ts: new Date(0).toISOString(), text: "supplement-only assistant fragment" };
    const hasSupplement = kind === "tool_call" || kind === "assistant";
    const objectRef = await store.write({ ...binding, entries: [entry] });
    f.span.supplementalObjectRef = hasSupplement ? objectRef : null;
    f.span.sourceRevision = null;
    const result = await f.prove();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(f.native).toHaveBeenCalledTimes(6);
    const readInput = { ...binding, objectRef };
    const before = await store.readRange(readInput);
    const stage = vi.spyOn(store, "stageSealedRemoval");
    const purge = vi.spyOn(store, "purgeStagedRemoval");
    const run = databaseRun({ status: "succeeded", executionOwnerToken: null, terminalEffectsPending: false,
      processExitedAt: new Date(0), ...(kind === "excerpt_only" ? { stdoutExcerpt: "retained fragment" }
        : { logStore: "local_file", logRef: "retained.log", logSha256: "a".repeat(64) }) });
    const events = kind === "log_only" || kind === "excerpt_only" ? []
      : [{ id: 1, payload: { spanId: "span-1", attemptId: "attempt-1", entry } }];
    const rows = [[run], [f.span], [{ ...f.attempt, orgId: "org-1", runId: "run-1" }], events, []];
    const select = vi.fn(() => {
      const values = rows.shift()!;
      const query: any = { then: (resolve: (value: unknown) => unknown) => Promise.resolve(values).then(resolve) };
      for (const method of ["from", "where", "for", "orderBy", "limit"]) query[method] = () => query;
      return query;
    });
    const tx = { select, execute: vi.fn(), update: vi.fn(() => { throw new Error("unexpected SQL update"); }),
      delete: vi.fn(() => { throw new Error("unexpected SQL delete"); }) };
    const logStore = { stageRunRemoval: vi.fn(), purgeStagedRunRemoval: vi.fn(), restoreStagedRunRemoval: vi.fn() };
    const compact = vi.fn();
    await expect(cleanSealedNativeTranscriptMirrors({
      db: { transaction: async (callback: (value: unknown) => unknown) => callback(tx) } as never,
      proof: result.proof, transcriptObjectStore: store, runLogStore: logStore as never,
      readerFactory: () => f.reader, retainResultJson: vi.fn(), compactAdapterInvokePayload: compact,
    })).resolves.toEqual({ cleaned: false, reason: hasSupplement ? "supplement_native_coverage_unproven"
      : kind === "events_only" ? "transcript_events_native_coverage_unproven" : "run_log_native_coverage_unproven" });
    expect(stage).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
    expect(logStore.stageRunRemoval).not.toHaveBeenCalled();
    expect(logStore.purgeStagedRunRemoval).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(f.span.supplementalObjectRef).toBe(hasSupplement ? readInput.objectRef : null);
    expect(await store.readRange(readInput)).toEqual(before);
    expect(await fs.readFile(f.sessionFile, "utf8")).toBe(f.original);
  });

  it("proves the actual Pi small range despite an intentionally limited one-item probe", async () => {
    const f = await fixture(8);
    const full = await f.reader.readRun({ ...f.scope, limit: 200 });
    const one = await f.reader.readRun({ ...f.scope, limit: 1 });
    expect(full).toMatchObject({ source: "native", availability: "available", completeness: "complete", nextCursor: null });
    expect(one).toMatchObject({ revision: full.revision, completeness: "partial", nextCursor: expect.any(String),
      limitReached: { reason: "total_items", maximum: 1 } });
    await expect(f.prove()).resolves.toMatchObject({ ok: true, proof: { itemCount: 8,
      spans: [{ sourceRevision: full.revision, supplementalObjectRef: "retained-supplement" }] } });
    expect(await fs.readFile(f.sessionFile, "utf8")).toBe(f.original);
    expect(f.span.supplementalObjectRef).toBe("retained-supplement");
    expect((await fs.readFile(f.requests, "utf8")).trim().split("\n").map(line => JSON.parse(line).type))
      .toEqual(["get_state", "get_state", "get_state", "get_state"]);
  });

  it("exhausts and confirms a production Pi range larger than the bounded page size", async () => {
    const f = await fixture(201);
    const first = await f.reader.readRun({ ...f.scope, limit: 200 });
    // Pi clamps the requested 200 to its native page cap of 100.
    expect(first.items).toHaveLength(100);
    expect(first).toMatchObject({ completeness: "partial", nextCursor: expect.any(String),
      limitReached: { reason: "total_items", maximum: 100 } });
    f.native.mockClear();
    await expect(f.prove()).resolves.toMatchObject({ ok: true, proof: { itemCount: 201 } });
    expect(f.native).toHaveBeenCalledTimes(6);
    expect(f.native.mock.calls.every(([input]) => input.limit === 200
      && input.maxBytes !== undefined && input.maxBytes <= 1024 * 1024)).toBe(true);
    expect(await fs.readFile(f.sessionFile, "utf8")).toBe(f.original);
  });

  it("denies real indexed parse loss even though the valid branch remains readable", async () => {
    const f = await fixture(8);
    await fs.appendFile(f.sessionFile, "not-valid-json\n");
    const page = await f.reader.readRun({ ...f.scope, limit: 200 });
    expect(page.items).toHaveLength(8);
    expect(page.completeness).toBe("partial");
    expect(page.nextCursor).toBeNull();
    await expect(f.prove()).resolves.toMatchObject({ ok: false, reason: "native_range_read_incomplete" });
  });

  it("denies a real Pi item-byte cutoff without increasing native budgets", async () => {
    const f = await fixture(8, { maxNativeReadBytes: 4096, maxNativeItemBytes: 512 });
    const page = await f.reader.readRun({ ...f.scope, limit: 200 });
    expect(page).toMatchObject({ completeness: "partial", limitReached: { reason: "item_bytes", maximum: 512 } });
    await expect(f.prove()).resolves.toMatchObject({ ok: false, reason: "native_range_read_incomplete" });
    expect(f.native.mock.calls.every(([input]) => input.maxBytes === 4096 && input.maxItemBytes === 512)).toBe(true);
  });

  it.each(["missing", "offline", "expired", "empty", "pruned", "changed-content", "revision", "wrong-run", "wrong-span"] as const)(
    "denies confirmation after %s, even if a provider reuses its old revision", async fault => {
      const f = await fixture(201);
      let scans = 0;
      const reader = { ...f.reader, readRun: async (input: Parameters<TranscriptReader["readRun"]>[0]): Promise<TranscriptPage> => {
        if (!input.cursor) scans += 1;
        const page = await f.reader.readRun(input);
        if (scans < 2) return page;
        if (["missing", "offline", "expired"].includes(fault)) return { ...page, availability: fault as "missing" | "offline" | "expired" };
        if (fault === "revision") return { ...page, revision: "changed-native-revision" };
        if (fault === "empty") return { ...page, items: [] };
        if (fault === "pruned") return page.nextCursor ? page : { ...page, items: page.items.slice(1) };
        return { ...page, items: page.items.map(item => ({ ...item,
          ...(fault === "changed-content" ? { text: "changed under stale revision" } : {}),
          ...(fault === "wrong-run" ? { runId: "another-run" } : {}),
          ...(fault === "wrong-span" ? { spanId: "another-span" } : {}) })) };
      } };
      await expect(f.prove(reader)).resolves.toMatchObject({ ok: false, reason: "native_range_read_incomplete" });
      expect(f.span.supplementalObjectRef).toBe("retained-supplement");
    });

  it.each(["page_bytes", "item_bytes", "total_bytes", "hard-item-cap", "parse-loss", "truncated", "cursor-loop"] as const)(
    "does not mistake %s for exhaustible pagination", async fault => {
      const f = await fixture(201);
      const reader = { ...f.reader, readRun: async (input: Parameters<TranscriptReader["readRun"]>[0]): Promise<TranscriptPage> => {
        const page = await f.reader.readRun(input);
        if (["page_bytes", "item_bytes", "total_bytes"].includes(fault)) return { ...page,
          limitReached: { reason: fault as "page_bytes" | "item_bytes" | "total_bytes", maximum: 200 } };
        if (fault === "hard-item-cap") return { ...page, limitReached: { reason: "total_items", maximum: 100_000 } };
        if (fault === "truncated") return { ...page, truncated: true };
        if (fault === "cursor-loop") return { ...page, nextCursor: input.cursor ?? page.nextCursor };
        return page.nextCursor ? page : { ...page, completeness: "partial" };
      } };
      await expect(f.prove(reader)).resolves.toMatchObject({ ok: false, reason: "native_range_read_incomplete" });
    });
});

describe("proof-gated exact Codex supplement reclaim", () => {
  const ts = "2026-10-01T00:00:00.000Z";

  async function cleanupFixture(input: { completeness?: "complete" | "partial"; mismatch?: boolean } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-exact-supplement-cleanup-"));
    const store = createTranscriptObjectStore(path.join(root, "objects")) as RemovalCapableTranscriptObjectStore;
    const identity = {
      orgId: "org-exact", runId: "run-exact", spanId: "span-exact", attemptId: "attempt-exact",
      attemptEpoch: 7, ownerToken: "synthetic-exact-owner",
      selector: { kind: "codex_turn" as const, runId: "run-exact", threadId: "thread-exact", turnId: "turn-exact" },
    };
    const entries = [
      { kind: "user" as const, ts, text: "synthetic request", messageId: "user-exact", sourceEntryId: "user-exact" },
      { kind: "assistant" as const, ts, text: "synthetic response", phase: "final_answer" as const,
        segmentId: "assistant-exact", sourceEntryId: "assistant-exact" },
    ];
    const objectEntries = entries.map(entry => ({ ...entry }));
    if (input.mismatch) objectEntries[1]!.text = "changed supplement";
    const handle = await store.begin(identity);
    await store.append(handle, objectEntries);
    const objectRef = handle.objectRef;
    await store.finalize(handle, { completeness: input.completeness ?? "complete" });

    const revision = "codex-native-revision-exact";
    const baseRun = databaseRun({ orgId: identity.orgId, id: identity.runId, status: "succeeded",
      executionOwnerToken: null, terminalEffectsPending: false, processExitedAt: new Date(ts),
      contextSnapshot: { transcriptSource: "native" } });
    const span = databaseSpan(identity.spanId, { orgId: identity.orgId, runId: identity.runId,
      attemptId: identity.attemptId, attemptEpoch: identity.attemptEpoch, ownerToken: identity.ownerToken,
      sourceRevision: revision, selectorJson: identity.selector, state: "sealed", completeness: "complete",
      writerLeaseReleasedAt: new Date(ts), supplementalObjectRef: objectRef });
    const attempt = { id: identity.attemptId, orgId: identity.orgId, runId: identity.runId,
      ownerToken: identity.ownerToken, attemptEpoch: identity.attemptEpoch,
      status: "succeeded", finishedAt: new Date(ts) };
    const db = mockDatabase({ run: baseRun, spans: [span],
      bindings: [databaseBinding(identity.spanId, { orgId: identity.orgId, runtimeType: "codex_local", continuity: "native" })],
      segments: [databaseSegment(identity.spanId, { orgId: identity.orgId, runtimeType: "codex_local", nativeSessionId: identity.selector.threadId })] });
    const nativeOnlyReader = createTranscriptReader(db as never, {
      nativeReader: { readRange: async () => ({ entries: entries.map(entry => ({ entry })), source: "native",
        revision, availability: "available", completeness: "complete" }) },
    });
    const nativePage = await nativeOnlyReader.readRun({ orgId: identity.orgId, runId: identity.runId,
      spanId: identity.spanId, principal: { type: "board", orgId: identity.orgId, authorized: true }, limit: 200 });
    span.sourceRevision = nativePage.revision;
    const nativeReadSha256 = createHash("sha256")
      .update(nativePage.items.map(item => `${stableJson(item)}\n`).join(""))
      .digest("hex");
    const proof = {
      orgId: identity.orgId,
      runId: identity.runId,
      itemCount: entries.length,
      spans: [{ spanId: identity.spanId, ownerToken: identity.ownerToken, attemptEpoch: identity.attemptEpoch,
        attemptId: identity.attemptId, sourceRevision: nativePage.revision, itemCount: entries.length, nativeReadSha256,
        selectorJson: identity.selector, supplementalObjectRef: objectRef }],
    };

    const rows = new Map<unknown, Record<string, unknown>[]>([
      [heartbeatRuns, [baseRun]], [runRuntimeSpans, [span]], [heartbeatRunAttempts, [attempt]], [heartbeatRunEvents, []],
    ]);
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(() => {
        let table: unknown;
        const query: any = {
          from(value: unknown) { table = value; return query; },
          where() { return query; },
          for() { return query; },
          orderBy() { return query; },
          limit() { return query; },
          then(resolve: (value: Record<string, unknown>[]) => unknown, reject?: (reason: unknown) => unknown) {
            return Promise.resolve(rows.get(table) ?? []).then(resolve, reject);
          },
        };
        return query;
      }),
      update: vi.fn((table: unknown) => {
        let values: Record<string, unknown> = {};
        const query: any = {
          set(next: Record<string, unknown>) { values = next; return query; },
          where() { return query; },
          returning: async () => {
            const target = rows.get(table)?.[0];
            if (target) Object.assign(target, values);
            return target ? [{ id: target.id }] : [];
          },
        };
        return query;
      }),
      delete: vi.fn(() => { throw new Error("unexpected SQL delete"); }),
    };
    const database = { transaction: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx)) };
    const readerFactory = () => nativeOnlyReader;
    const publicReader = createTranscriptReader(db as never, {
      nativeReader: { readRange: async () => ({ entries: entries.map(entry => ({ entry })), source: "native",
        revision, availability: "available", completeness: "complete" }) },
      objectReader: createTranscriptObjectReader(store),
    });
    const fallbackReader = createTranscriptReader(db as never, {
      nativeReader: { readRange: async () => ({ entries: [], source: "native", revision: "offline-native",
        availability: "offline", completeness: "unknown" }) },
      objectReader: createTranscriptObjectReader(store),
    });
    return { root, store, objectRef, identity, entries, span, proof, tx, database, readerFactory,
      publicReader, fallbackReader, run: baseRun };
  }

  it("stages and purges only a complete exact supplement, leaving native-only readback", async () => {
    const f = await cleanupFixture();
    const stageOriginal = f.store.stageSealedRemoval!.bind(f.store);
    const stage = vi.spyOn(f.store, "stageSealedRemoval").mockImplementation(async input => {
      expect(f.tx.update).toHaveBeenCalledTimes(1);
      expect(f.span.supplementalObjectRef).toBe(f.objectRef);
      expect((f.run.contextSnapshot as any).nativeTranscriptRetention).toMatchObject({
        status: "cleanup_pending",
        recovery: [{ kind: "transcript_object", objectRef: f.objectRef, spanId: f.identity.spanId,
          entryDigest: input.expectedEntriesSha256, stageId: input.stageId }],
      });
      return stageOriginal(input);
    });
    const purge = vi.spyOn(f.store, "purgeStagedRemoval");
    try {
      await expect(cleanSealedNativeTranscriptMirrors({ db: f.database as never, proof: f.proof,
        runLogStore: {} as never, transcriptObjectStore: f.store, readerFactory: f.readerFactory,
        retainResultJson: value => value ?? {} })).resolves.toEqual({ cleaned: true });
      expect(stage).toHaveBeenCalledTimes(1);
      expect(purge).toHaveBeenCalledTimes(1);
      expect(f.span.supplementalObjectRef).toBeNull();
      await expect(f.store.readRange({ ...f.identity, objectRef: f.objectRef })).rejects.toThrow();
      const readback = await f.publicReader.readRun({ orgId: f.identity.orgId, runId: f.identity.runId,
        spanId: f.identity.spanId, principal: { type: "board", orgId: f.identity.orgId, authorized: true } });
      expect(readback).toMatchObject({ source: "native", completeness: "complete" });
      expect(readback.items.map(item => item.entry)).toEqual(f.entries);
    } finally {
      stage.mockRestore();
      purge.mockRestore();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["partial supplement", { completeness: "partial" as const }],
    ["complete but changed entry", { mismatch: true }],
  ])("preserves a %s before any staging or SQL mutation", async (_name, options) => {
    const f = await cleanupFixture(options);
    const stage = vi.spyOn(f.store, "stageSealedRemoval");
    const purge = vi.spyOn(f.store, "purgeStagedRemoval");
    try {
      await expect(cleanSealedNativeTranscriptMirrors({ db: f.database as never, proof: f.proof,
        runLogStore: {} as never, transcriptObjectStore: f.store, readerFactory: f.readerFactory,
        retainResultJson: value => value ?? {} })).resolves.toEqual({ cleaned: false,
        reason: "supplement_native_coverage_unproven" });
      expect(stage).not.toHaveBeenCalled();
      expect(purge).not.toHaveBeenCalled();
      expect(f.tx.update).not.toHaveBeenCalled();
      expect(f.tx.delete).not.toHaveBeenCalled();
      expect(f.span.supplementalObjectRef).toBe(f.objectRef);
      const objectPage = await f.store.readRange({ ...f.identity, objectRef: f.objectRef });
      expect(objectPage.entries).toHaveLength(2);
      if ("completeness" in options && options.completeness === "partial") expect(objectPage.completeness).toBe("partial");
      const readback = await f.fallbackReader.readRun({ orgId: f.identity.orgId, runId: f.identity.runId,
        spanId: f.identity.spanId, principal: { type: "board", orgId: f.identity.orgId, authorized: true } });
      expect(readback.source).toBe("native_plus_objects");
    } finally {
      stage.mockRestore();
      purge.mockRestore();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("refuses staging when a same-size supplement rewrite races after its exact proof", async () => {
    const f = await cleanupFixture();
    const payload = path.join(f.root, "objects", "transcript-objects", `${f.objectRef}.ndjson`);
    const stageOriginal = f.store.stageSealedRemoval!.bind(f.store);
    const stage = vi.spyOn(f.store, "stageSealedRemoval").mockImplementation(async (input) => {
      const before = await fs.readFile(payload, "utf8");
      const replaced = before.replace("synthetic request", "synthetic requess");
      expect(replaced).not.toBe(before);
      expect(Buffer.byteLength(replaced, "utf8")).toBe(Buffer.byteLength(before, "utf8"));
      await fs.writeFile(payload, replaced);
      return stageOriginal(input);
    });
    const purge = vi.spyOn(f.store, "purgeStagedRemoval");
    try {
      const result = await cleanSealedNativeTranscriptMirrors({ db: f.database as never, proof: f.proof,
        runLogStore: {} as never, transcriptObjectStore: f.store, readerFactory: f.readerFactory,
        retainResultJson: value => value ?? {} });
      expect(result).toMatchObject({ cleaned: false });
      expect(stage).toHaveBeenCalledTimes(1);
      expect(purge).not.toHaveBeenCalled();
      expect(f.tx.update.mock.calls.some(([table]) => table === runRuntimeSpans)).toBe(false);
      expect(f.tx.delete).not.toHaveBeenCalled();
      expect(f.span.supplementalObjectRef).toBe(f.objectRef);
      const objectPage = await f.store.readRange({ ...f.identity, objectRef: f.objectRef });
      expect(objectPage.entries[0]).toMatchObject({ text: "synthetic requess" });
      expect(await fs.readdir(path.join(f.root, "objects", "transcript-objects"))).toEqual([
        `${f.objectRef}.json`, `${f.objectRef}.ndjson`,
      ]);
    } finally {
      stage.mockRestore();
      purge.mockRestore();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("keeps the committed recovery identity and Run/span reference when staging fails after moving files", async () => {
    const f = await cleanupFixture();
    const stageOriginal = f.store.stageSealedRemoval!.bind(f.store);
    const stage = vi.spyOn(f.store, "stageSealedRemoval").mockImplementation(async input => {
      const staged = await stageOriginal(input);
      throw new Error(`injected_ack_loss_after_stage:${staged.stageId}`);
    });
    try {
      const result = await cleanSealedNativeTranscriptMirrors({ db: f.database as never, proof: f.proof,
        runLogStore: {} as never, transcriptObjectStore: f.store, readerFactory: f.readerFactory,
        retainResultJson: value => value ?? {} });
      expect(result).toMatchObject({ cleaned: false, reason: expect.stringContaining("injected_ack_loss_after_stage") });
      expect(f.span.supplementalObjectRef).toBe(f.objectRef);
      expect(f.tx.update.mock.calls.some(([table]) => table === runRuntimeSpans)).toBe(false);
      const retention = (f.run.contextSnapshot as any).nativeTranscriptRetention;
      expect(retention).toMatchObject({ status: "cleanup_pending", recovery: [
        { kind: "transcript_object", objectRef: f.objectRef, spanId: f.identity.spanId },
      ] });
      await expect(f.store.readRange({ ...f.identity, objectRef: f.objectRef })).resolves.toMatchObject({
        entries: f.entries,
        completeness: "complete",
      });
    } finally {
      stage.mockRestore();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
});
