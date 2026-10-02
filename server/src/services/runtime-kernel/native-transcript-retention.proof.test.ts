import { readPiNativeTranscript } from "@rudderhq/agent-runtime-pi-local/server";
import { heartbeatRunAttempts } from "@rudderhq/db";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanSealedNativeTranscriptMirrors, proveSealedNativeRunTranscript } from "./native-transcript-retention.js";
import { createTranscriptObjectStore } from "./transcript-object-store.js";
import { createTranscriptReader, type NativeTranscriptReadInput, type TranscriptPage, type TranscriptReader } from "./transcript-reader.js";
import { databaseBinding, databaseRun, databaseSegment, databaseSpan, mockDatabase } from "./transcript-reader.test-support.js";

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
