import { heartbeatRunAttempts } from "@rudderhq/db";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoverageIdentity } from "./native-transcript-coverage.js";
import type { NativeTranscriptRunProof } from "./native-transcript-retention.js";
import { persistCodexTimelineShadows } from "./native-transcript-shadow.js";
import { createTranscriptObjectReader, createTranscriptObjectStore } from "./transcript-object-store.js";
import { createTranscriptReader } from "./transcript-reader.js";
import { stableHash } from "./transcript-reader.normalize.js";
import { databaseBinding, databaseRun, databaseSegment, databaseSpan, mockDatabase } from "./transcript-reader.test-support.js";

vi.mock("../../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(root: string) {
  const store = createTranscriptObjectStore(root);
  const ts = "2026-01-01T00:00:00.000Z";
  const identity: CoverageIdentity = { orgId: "org-1", runId: "run-1", spanId: "span-1", ownerToken: "owner-1",
    attemptId: "attempt-1", attemptEpoch: 1,
    selector: { kind: "codex_turn", runId: "run-1", threadId: "thread-1", turnId: "turn-1" } };
  const handle = await store.begin(identity);
  await store.append(handle, [{ kind: "system", ts, text: "retained diagnostic" },
    { kind: "assistant", ts, segmentId: "msg-1", phase: "final_answer", delta: true, text: "界" },
    { kind: "assistant", ts: "2026-01-01T00:00:01.123Z", segmentId: "msg-1", phase: "final_answer", delta: true, text: "🌍" }]);
  await store.finalize(handle, { completeness: "partial" });
  const native = [{ kind: "assistant" as const, ts, segmentId: "msg-1", sourceEntryId: "msg-1", phase: "final_answer" as const, text: "界🌍" }];
  const run = databaseRun({ status: "succeeded", executionOwnerToken: null, terminalEffectsPending: false, processExitedAt: new Date(ts),
    contextSnapshot: { transcriptSource: "native" } });
  const span = databaseSpan("span-1", { orgId: "org-1", attemptId: "attempt-1", attemptEpoch: 1, ownerToken: "owner-1",
    selectorJson: identity.selector, sourceRevision: stableHash(["raw-provider-revision"]),
    state: "sealed", completeness: "complete", writerLeaseReleasedAt: new Date(ts), supplementalObjectRef: handle.objectRef });
  const attempt = { id: "attempt-1", runId: "run-1", orgId: "org-1", status: "succeeded", finishedAt: new Date(ts), ownerToken: "owner-1", attemptEpoch: 1 };
  const base = mockDatabase({ run, spans: [span], bindings: [databaseBinding("span-1", { runtimeType: "codex_local", continuity: "native" })],
    segments: [databaseSegment("span-1", { runtimeType: "codex_local", nativeSessionId: "thread-1" })] });
  const select = (...args: Parameters<typeof base.select>) => {
    const query = base.select(...args) as Record<string, unknown>;
    query.for = () => query; // Row-lock protocol; scheduling model below is NOT actual PG.
    const from = query.from as (table: unknown) => typeof query;
    query.from = (table: unknown) => {
      from(table);
      if (table === heartbeatRunAttempts) query.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([attempt]).then(resolve);
      return query;
    };
    return query;
  };
  let tail = Promise.resolve();
  const db = { select, transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
    const previous = tail, done = barrier(); tail = done.promise;
    const tx = { select, execute: async () => { await previous; } };
    try { return await operation(tx); } finally { done.release(); }
  }) };
  const readerFactory = (tx: unknown) => createTranscriptReader(tx as never, { nativeReader: { readRange: async () => ({
    entries: native.map(entry => ({ entry })), // Provider wrapper projection; caller and Reader must normalize equally.
    revision: "raw-provider-revision", availability: "available", completeness: "complete" }) } });
  const proof: NativeTranscriptRunProof = { orgId: "org-1", runId: "run-1", itemCount: 1,
    spans: [{ spanId: "span-1", attemptId: "attempt-1", attemptEpoch: 1, ownerToken: "owner-1",
      sourceRevision: span.sourceRevision as string, itemCount: 1, selectorJson: identity.selector, supplementalObjectRef: handle.objectRef }] };
  return { store, db, proof, readerFactory, identity, native, span, attempt, run, objectRef: handle.objectRef };
}

describe("callable terminal shadow caller -> persist -> reopen -> public Reader", () => {
  it("uses the same single-span public revision and normalized entries at BOTH boundaries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-shadow-caller-"));
    try {
      const f = await fixture(root);
      const payload = path.join(root, "transcript-objects", f.objectRef + ".ndjson");
      const metadata = path.join(root, "transcript-objects", f.objectRef + ".json");
      const before = [await fs.readFile(payload), await fs.readFile(metadata)];
      const persisted = await persistCodexTimelineShadows({ db: f.db as never, proof: f.proof, store: f.store, readerFactory: f.readerFactory });
      expect(persisted[0].result.ok, JSON.stringify(persisted)).toBe(true);
      const reopened = createTranscriptObjectStore(root), objectReader = createTranscriptObjectReader(reopened);
      const compare = vi.fn(objectReader.compareCodexTimelineShadow!); objectReader.compareCodexTimelineShadow = compare;
      const reader = createTranscriptReader(f.db as never, { nativeReader: { readRange: async () => ({ entries: f.native.map(entry => ({ entry })),
        revision: "raw-provider-revision", availability: "available", completeness: "complete" }) }, objectReader });
      const page = await reader.readRun({ orgId: "org-1", runId: "run-1", spanId: "span-1", principal: { type: "board", orgId: "org-1", authorized: true }, limit: 200 });
      expect(page.revision).toBe(stableHash(["raw-provider-revision"]));
      expect(compare).toHaveBeenCalledOnce();
      expect(await compare.mock.results[0].value).toMatchObject({ ok: true, authorizesOldObjectDelete: false });
      expect(page.items.map(item => item.entry)).toEqual(f.native);
      expect([await fs.readFile(payload), await fs.readFile(metadata)]).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("interleaves real sweep object lock with caller without acquiring DB locks while waiting on object", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-shadow-lock-"));
    const sweepObjectHeld = barrier(), allowSweepDB = barrier();
    try {
      const f = await fixture(root);
      const sweep = f.store.sweepUnreferenced({ minAgeMs: 0, now: new Date("2099-01-01"), withRetentionGuard: async () => {
        sweepObjectHeld.release(); await allowSweepDB.promise;
        await f.db.transaction(async (tx: unknown) => { await (tx as { execute: () => Promise<void> }).execute(); });
        return "protected";
      } });
      await sweepObjectHeld.promise;
      const caller = persistCodexTimelineShadows({ db: f.db as never, proof: f.proof, store: f.store, readerFactory: f.readerFactory });
      await Promise.resolve(); await Promise.resolve();
      expect(f.db.transaction).not.toHaveBeenCalled(); // Inverted DB->object order fails HERE, not after a hung timeout.
      allowSweepDB.release();
      const [swept, persisted] = await Promise.all([sweep, caller]);
      expect(swept.deletedObjectRefs).toEqual([]);
      expect(persisted).toMatchObject([{ result: { ok: true, authorizesOldObjectDelete: false } }]);
    } finally { allowSweepDB.release(); await fs.rm(root, { recursive: true, force: true }); }
  }, 2000);

  it.each(["owner", "lease", "revision"])("retains original and does not publish on %s fence failure", async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-shadow-fence-"));
    try {
      const f = await fixture(root);
      if (mode === "owner") f.attempt.ownerToken = "successor";
      if (mode === "lease") f.run.contextSnapshot = { nativeTranscriptRetention: { cleanupLease: { expiresAt: "unknown" } } };
      if (mode === "revision") f.proof.spans[0].sourceRevision = "drift";
      const result = await persistCodexTimelineShadows({ db: f.db as never, proof: f.proof, store: f.store, readerFactory: f.readerFactory });
      expect(result).toMatchObject([{ result: { ok: false, authorizesOldObjectDelete: false } }]);
      expect(await fs.stat(path.join(root, "transcript-objects", "codex-timeline-shadows", f.objectRef)).catch(() => null)).toBeNull();
      expect((await f.store.readRange({ ...f.identity, objectRef: f.objectRef })).entries).toHaveLength(3);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
