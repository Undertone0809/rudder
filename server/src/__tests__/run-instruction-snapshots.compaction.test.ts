import type { Db } from "@rudderhq/db";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { compactNativeAdapterInvokePayload } from "../services/chat-agent-runs.helpers.js";
import { compactReadableInstructionSnapshot } from "../services/run-instruction-snapshots.compaction.js";
import { readRunInstructionSnapshotForEvent, storeRunInstructionSnapshot } from "../services/run-instruction-snapshots.js";
import { compactHeartbeatAdapterInvokePayload } from "../services/runtime-kernel/heartbeat.execute-native-retention.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const spanId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function dbFor(rows = [[{ id: attemptId, orgId, runId }], [{ id: spanId, orgId, runId, attemptId }]]) {
  const pending = [...rows];
  const query: any = {};
  for (const method of ["from", "where"]) query[method] = vi.fn(() => query);
  query.limit = vi.fn(async () => pending.shift() ?? []);
  return { select: vi.fn(() => query) } as unknown as Db;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function expectInlineUnavailable(payload: Record<string, unknown>, text: string) {
  expect(payload).toMatchObject({ prompt: text, agentInstructionStack: text,
    invocationInstructionSnapshot: { status: "unavailable", reason: "snapshot_readback_unavailable" } });
  expect(payload).not.toHaveProperty("invocationInstructionTextReference");
  expect(payload).not.toHaveProperty("invocationPromptReference");
}
async function fixture(text = "真实 Instructions🙂\n".repeat(4000)) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-snapshot-readback-"));
  const provider = createLocalDiskStorageProvider(root);
  const deleteObject = vi.spyOn(provider, "deleteObject");
  const storage = createStorageService(provider);
  const locator = await storeRunInstructionSnapshot({ storage, orgId, text });
  const payload: Record<string, unknown> = { prompt: text, agentInstructionStack: text,
    invocationAttemptId: attemptId, invocationSpanId: spanId,
    invocationInstructionSnapshot: { status: "available", ...locator }, context: { unique: "keep" } };
  const compact = (value = payload, db = dbFor()) => compactReadableInstructionSnapshot({
    db, storage, orgId, runId, attemptId, spanId, payload: value,
  });
  return { root, storage, locator, payload, text, compact, deleteObject };
}

describe("verified new-event instruction snapshot projection", () => {
  it.each(["resolve", "reject", "unresolved"] as const)("bounds store before proof and observes late %s without publishing a locator", async settlement => {
    const f = await fixture();
    const lateText = `${f.text}new late object`;
    const inline = { ...f.payload, prompt: lateText, agentInstructionStack: lateText };
    const realStore = f.storage.putContentAddressedFile.bind(f.storage);
    const gate = deferred<void>();
    const store = vi.spyOn(f.storage, "putContentAddressedFile").mockImplementation(async input => {
      await gate.promise;
      return realStore(input);
    });
    const get = vi.spyOn(f.storage, "getObject");
    const append = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const deadlineAt = performance.now() + 5_000;
      const pending = storeRunInstructionSnapshot({ storage: f.storage, orgId, text: lateText, deadlineAt })
        .then(locator => ({ ...inline, invocationInstructionSnapshot: { status: "available", ...locator } }))
        .catch(() => ({ ...inline, invocationInstructionSnapshot: { status: "unavailable", reason: "storage_unavailable" } }))
        .then(payload => compactReadableInstructionSnapshot({ db: dbFor(), storage: f.storage,
          orgId, runId, attemptId, spanId, payload, deadlineAt }))
        .then(payload => { append(payload); return payload; });
      await vi.advanceTimersByTimeAsync(5_001);
      const result = await pending;
      expect(result).toMatchObject({ prompt: lateText, agentInstructionStack: lateText,
        invocationInstructionSnapshot: { status: "unavailable", reason: "storage_unavailable" } });
      expect(get).not.toHaveBeenCalled();
      if (settlement === "resolve") {
        gate.resolve();
        const stored = await store.mock.results[0]!.value;
        expect(await readFile(path.join(f.root, stored.objectKey), "utf8")).toBe(lateText);
        expect(stored.objectKey).not.toBe(f.locator.objectKey);
      }
      if (settlement === "reject") gate.reject(new Error("late store rejection"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(append).toHaveBeenCalledTimes(1);
      expect(result).not.toHaveProperty("invocationInstructionTextReference");
      expect(f.deleteObject).not.toHaveBeenCalled();
      expect(await readFile(path.join(f.root, f.locator.objectKey), "utf8")).toBe(f.text);
    } finally { vi.useRealTimers(); }
  });
  it("shares the store deadline with linkage, acquisition and stream rather than restarting the budget", async () => {
    const f = await fixture();
    const realStore = f.storage.putContentAddressedFile.bind(f.storage);
    vi.spyOn(f.storage, "putContentAddressedFile").mockImplementation(async input => {
      await new Promise(resolve => setTimeout(resolve, 3_000)); return realStore(input);
    });
    const stream = new Readable({ read() {} });
    const get = vi.spyOn(f.storage, "getObject").mockResolvedValue({ stream });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const deadlineAt = performance.now() + 5_000;
      const storing = storeRunInstructionSnapshot({ storage: f.storage, orgId, text: f.text, deadlineAt });
      await vi.advanceTimersByTimeAsync(3_000);
      const locator = await storing;
      const pending = compactReadableInstructionSnapshot({ db: dbFor(), storage: f.storage, orgId,
        runId, attemptId, spanId, deadlineAt, payload: { ...f.payload,
          invocationInstructionSnapshot: { status: "available", ...locator } } });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(stream.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expectInlineUnavailable(await pending, f.text);
      expect(get).toHaveBeenCalledTimes(1);
      expect(stream.destroyed).toBe(true);
      expect(f.deleteObject).not.toHaveBeenCalled();
    } finally { stream.destroy(); vi.useRealTimers(); }
  });
  it.each([0, -1, NaN, Infinity])("expired or invalid absolute deadline %s starts no optional IO", async deadlineAt => {
    const f = await fixture();
    const put = vi.spyOn(f.storage, "putContentAddressedFile");
    const get = vi.spyOn(f.storage, "getObject");
    const db = dbFor();
    await expect(storeRunInstructionSnapshot({ storage: f.storage, orgId, text: f.text, deadlineAt })).rejects.toThrow("deadline");
    expectInlineUnavailable(await compactReadableInstructionSnapshot({ db, storage: f.storage,
      orgId, runId, attemptId, spanId, payload: f.payload, deadlineAt }), f.text);
    expect(put).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(db.select).not.toHaveBeenCalled();
  });
  it("uses actual local storage readback and existing Instructions reader; reduces serialized bytes without deleting objects", async () => {
    const f = await fixture();
    const projected = await f.compact();
    expect(projected).not.toHaveProperty("prompt");
    expect(projected).not.toHaveProperty("agentInstructionStack");
    expect(projected).toMatchObject({ context: f.payload.context,
      invocationPromptReference: { sameAsInstructions: true }, invocationInstructionTextReference: { source: "stored_snapshot" } });
    const db = dbFor([[{ payload: projected }], [{ id: attemptId }], [{ id: spanId }]] as any);
    await expect(readRunInstructionSnapshotForEvent({ db, storage: f.storage, orgId, runId, eventId: 17 }))
      .resolves.toMatchObject({ agentInstructionStack: f.text, byteSize: Buffer.byteLength(f.text) });
    expect(await readFile(path.join(f.root, f.locator.objectKey), "utf8")).toBe(f.text);
    const saved = Buffer.byteLength(JSON.stringify(f.payload)) - Buffer.byteLength(JSON.stringify(projected));
    expect(saved).toBeGreaterThan(199_000);
    console.info("snapshot projection serialized bytes", { before: Buffer.byteLength(JSON.stringify(f.payload)), after: Buffer.byteLength(JSON.stringify(projected)), saved });
    expect(f.payload.agentInstructionStack).toBe(f.text);
    expect(f.deleteObject).not.toHaveBeenCalled();
  });
  it("keeps distinct debug prompt and unique context verbatim", async () => {
    const f = await fixture();
    const projected = await f.compact({ ...f.payload, prompt: "distinct task input" });
    expect(projected.prompt).toBe("distinct task input");
    expect(projected).not.toHaveProperty("invocationPromptReference");
    expect(projected).not.toHaveProperty("agentInstructionStack");
    expect((projected.invocationContent as any).textStored).toBe(true);
    for (const compactTerminal of [compactNativeAdapterInvokePayload, compactHeartbeatAdapterInvokePayload]) {
      const terminal = compactTerminal(projected);
      expect(terminal.prompt).toBe(projected.prompt);
      expect(terminal.invocationContent).toEqual(projected.invocationContent);
      expect((terminal.invocationContent as any).textStored).toBe(true);
    }
    await expect(readRunInstructionSnapshotForEvent({ db: dbFor([[{ payload: projected }], [{ id: attemptId }], [{ id: spanId }]]),
      storage: f.storage, orgId, runId, eventId: 17 })).resolves.toMatchObject({ prompt: "distinct task input", agentInstructionStack: f.text });
  });
  it("restores a unique distinct UTF8 debug prompt from the same physically verified object", async () => {
    const prompt = "独有 debug 🙂\n" + "X".repeat(12000);
    const f = await fixture(`系统前文\n${prompt}\n系统后文`);
    const projected = await f.compact({ ...f.payload, prompt });
    expect(projected).not.toHaveProperty("prompt");
    expect(projected.invocationPromptReference).toMatchObject({ field: "prompt", byteStart: Buffer.byteLength("系统前文\n"), byteLength: Buffer.byteLength(prompt) });
    expect(projected.invocationContent).toMatchObject({ textSource: "stored_snapshot", snapshotTextStored: true,
      agentInstructionStack: { present: true } });
    expect((projected.invocationContent as any).agentInstructionStack).not.toHaveProperty("sameAsPrompt");
    await expect(readRunInstructionSnapshotForEvent({ db: dbFor([[{ payload: projected }], [{ id: attemptId }], [{ id: spanId }]]),
      storage: f.storage, orgId, runId, eventId: 17 })).resolves.toMatchObject({ agentInstructionStack: f.text, prompt });
    const saved = Buffer.byteLength(JSON.stringify({ ...f.payload, prompt })) - Buffer.byteLength(JSON.stringify(projected));
    expect(saved).toBeGreaterThan(22000);
    console.info("unique range serialized bytes", { saved, snapshotBytes: Buffer.byteLength(f.text) });
    expect(f.deleteObject).not.toHaveBeenCalled();
  });
  it.each(["重复🙂", "", "not contained", "\ud800"])("retains ambiguous, empty, absent or malformed UTF8 debug input %j", async prompt => {
    const f = await fixture("重复🙂 middle 重复🙂");
    const projected = await f.compact({ ...f.payload, prompt });
    expect(projected.prompt).toBe(prompt);
    expect(projected).not.toHaveProperty("invocationPromptReference");
    expect((projected.invocationContent as any).textStored).toBe(true);
  });
  it.each(["missing_locator", "wrong_digest", "wrong_bytes", "wrong_field", "wrong_type", "wrong_presence", "stale_summary", "bad_range", "foreign_path", "wrong_prompt_digest", "wrong_flag_type", "wrong_length_type", "wrong_attempt_type", "invented_provenance"])("rebuilds unproven terminal snapshot metadata without deleting raw fallbacks: %s", async mode => {
    const f = await fixture();
    const projected = await f.compact();
    const invalid: any = structuredClone(projected);
    if (mode === "missing_locator") delete invalid.invocationInstructionSnapshot;
    if (mode === "wrong_digest") invalid.invocationInstructionTextReference.sha256 = "0".repeat(64);
    if (mode === "wrong_bytes") invalid.invocationContent.agentInstructionStack.sanitizedUtf8ByteLength++;
    if (mode === "wrong_field") invalid.invocationInstructionTextReference.field = "prompt";
    if (mode === "wrong_type") invalid.invocationContent = "truthy but not metadata";
    if (mode === "wrong_presence") invalid.invocationContent.prompt.inline = true;
    if (mode === "stale_summary") invalid.invocationContent.agentInstructionStack.sanitizedSha256 = "0".repeat(64);
    if (mode === "bad_range") invalid.invocationPromptReference = { ...invalid.invocationPromptReference, sameAsInstructions: false, byteStart: -1, byteLength: 5, rangeSha256: "0".repeat(64) };
    if (mode === "foreign_path") invalid.invocationInstructionSnapshot.objectKey = "../escape";
    if (mode === "wrong_prompt_digest") invalid.invocationContent.prompt.sanitizedSha256 = "0".repeat(64);
    if (mode === "wrong_flag_type") invalid.invocationContent.textStored = "false";
    if (mode === "wrong_length_type") invalid.invocationContent.agentInstructionStack.sanitizedCharacterLength = "10";
    if (mode === "wrong_attempt_type") invalid.invocationAttemptId = 123;
    if (mode === "invented_provenance") invalid.invocationContent.physicalProof = "not issued by producer";
    for (const compactTerminal of [compactNativeAdapterInvokePayload, compactHeartbeatAdapterInvokePayload]) {
      const terminal = compactTerminal(invalid);
      expect(terminal.invocationContent).not.toEqual(invalid.invocationContent);
      expect((terminal.invocationContent as any).textSource).not.toBe("stored_snapshot");
      expect((terminal.invocationContent as any).agentInstructionStack).not.toHaveProperty("sha256");
      // Even invalid pointer/metadata cannot authorize deletion of a unique
      // persisted prompt or stack; actual field presence dictates textStored.
      const raw = { ...invalid, prompt: "unique raw debug input", agentInstructionStack: "unique raw Instructions" };
      const retained = compactTerminal(raw);
      expect(retained.prompt).toBe(raw.prompt);
      expect(retained.agentInstructionStack).toBe(raw.agentInstructionStack);
      expect((retained.invocationContent as any).textStored).toBe(true);
      expect((retained.invocationContent as any).textSource).toBe("persisted_invocation_inline");
    }
  });
  it("accepts only explicit existing equality alias, not arbitrary absent instructions", async () => {
    const f = await fixture();
    const payload = { ...f.payload };
    delete payload.agentInstructionStack;
    const projected = await f.compact({ ...payload, agentInstructionStackAlias: {
      present: true, sameAsPrompt: true, textSource: "persisted_prompt", equality: "nonempty_sanitized_exact",
    } });
    expect(projected).not.toHaveProperty("prompt");
    const absent = await f.compact(payload);
    expect(absent.prompt).toBe(f.text);
    expect(absent.invocationInstructionSnapshot).toMatchObject({ status: "unavailable", reason: "snapshot_inline_not_equivalent" });
  });
  it.each([null, "", "different", "same but extra newline\n"])("retains non-equivalent inline stack %j", async stack => {
    const f = await fixture();
    const projected = await f.compact({ ...f.payload, agentInstructionStack: stack });
    expect(projected).toMatchObject({ prompt: f.text, agentInstructionStack: stack,
      invocationInstructionSnapshot: { status: "unavailable", reason: "snapshot_inline_not_equivalent" } });
  });
  it("rejects same-length corrupt existing object even when content-addressed PUT reuses HEAD", async () => {
    const f = await fixture("AAAA");
    await writeFile(path.join(f.root, f.locator.objectKey), "BBBB");
    await storeRunInstructionSnapshot({ storage: f.storage, orgId, text: "AAAA" });
    const projected = await f.compact();
    expect(projected).toMatchObject({ prompt: "AAAA", agentInstructionStack: "AAAA",
      invocationInstructionSnapshot: { status: "unavailable", reason: "snapshot_digest_mismatch" } });
    expect(await readFile(path.join(f.root, f.locator.objectKey), "utf8")).toBe("BBBB");
    expect(f.deleteObject).not.toHaveBeenCalled();
  });
  it.each(["../escape", `${runId}/run-instruction-snapshots/hash`, "wrong"])("rejects wrong org/path before object IO: %s", async objectKey => {
    const f = await fixture();
    const get = vi.spyOn(f.storage, "getObject");
    const projected = await f.compact({ ...f.payload, invocationInstructionSnapshot: { status: "available", ...f.locator, objectKey } });
    expect(projected.invocationInstructionSnapshot).toMatchObject({ status: "unavailable", reason: "snapshot_identity_invalid" });
    expect(get).not.toHaveBeenCalled();
  });
  it.each([{ attempt: [] }, { attempt: [{ id: attemptId, orgId: runId, runId }] }])("rejects missing or foreign linkage", async ({ attempt }) => {
    const f = await fixture();
    const get = vi.spyOn(f.storage, "getObject");
    const projected = await f.compact(f.payload, dbFor([attempt, [{ id: spanId, orgId, runId, attemptId }]]));
    expect(projected.invocationInstructionSnapshot).toMatchObject({ status: "unavailable", reason: "snapshot_run_linkage_invalid" });
    expect(get).not.toHaveBeenCalled();
  });
  it.each([Buffer.from("short"), Buffer.alloc(200_000)])("rejects incomplete/over-budget streams", async body => {
    const f = await fixture();
    vi.spyOn(f.storage, "getObject").mockResolvedValue({ stream: Readable.from([body]) });
    expect((await f.compact()).invocationInstructionSnapshot).toMatchObject({ status: "unavailable", reason: "snapshot_size_mismatch" });
  });
  it("rejects matching-digest invalid UTF8 and keeps fallback", async () => {
    const f = await fixture();
    const body = Buffer.from([0xff]);
    const sha256 = createHash("sha256").update(body).digest("hex");
    vi.spyOn(f.storage, "getObject").mockResolvedValue({ stream: Readable.from([body]) });
    const projected = await f.compact({ ...f.payload, invocationInstructionSnapshot: { status: "available", sha256,
      byteSize: 1, objectKey: `${orgId}/run-instruction-snapshots/${sha256}` } });
    expect(projected.invocationInstructionSnapshot).toMatchObject({ status: "unavailable", reason: "snapshot_utf8_invalid" });
    expect(projected.prompt).toBe(f.text);
  });
  it("keeps inline text and exposes unavailable when storage read throws", async () => {
    const f = await fixture();
    vi.spyOn(f.storage, "getObject").mockRejectedValue(new Error("offline"));
    const projected = await f.compact();
    expect(projected).toMatchObject({ prompt: f.text, agentInstructionStack: f.text,
      invocationInstructionSnapshot: { status: "unavailable", reason: "snapshot_readback_unavailable" } });
  });
  it("does not trust pre-existing field references when storage is unavailable", async () => {
    const f = await fixture();
    const projected = await f.compact({ ...f.payload, invocationInstructionSnapshot: { status: "unavailable" },
      invocationInstructionTextReference: { source: "stored_snapshot" }, invocationPromptReference: { sameAsInstructions: true } });
    expect(projected.prompt).toBe(f.text);
    expect(projected).not.toHaveProperty("invocationInstructionTextReference");
    expect(projected).not.toHaveProperty("invocationPromptReference");
  });
  it("bounds a stalled read stream and destroys it without deleting the snapshot", async () => {
    const f = await fixture();
    const stream = new Readable({ read() {} });
    vi.spyOn(f.storage, "getObject").mockResolvedValue({ stream });
    vi.useFakeTimers();
    try {
      const pending = f.compact();
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await pending).invocationInstructionSnapshot).toMatchObject({ status: "unavailable", reason: "snapshot_readback_unavailable" });
      expect(stream.destroyed).toBe(true);
      expect(f.deleteObject).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each([1, 2])("bounds unresolved linkage select %i and never starts subsequent IO after late settlement", async stage => {
    const f = await fixture();
    const db = dbFor();
    const query = (db.select as any)();
    vi.mocked(db.select).mockClear();
    const gate = deferred<any[]>();
    let calls = 0;
    query.limit.mockImplementation(() => ++calls === stage ? gate.promise
      : Promise.resolve([{ id: attemptId, orgId, runId }]));
    const get = vi.spyOn(f.storage, "getObject");
    const append = vi.fn();
    vi.useFakeTimers();
    try {
      const pending = f.compact(f.payload, db).then(payload => { append(payload); return payload; });
      await vi.advanceTimersByTimeAsync(5_001);
      const result = await pending;
      expectInlineUnavailable(result, f.text);
      expect(append).toHaveBeenCalledTimes(1);
      gate.resolve([{ id: stage === 1 ? attemptId : spanId, orgId, runId, attemptId }]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(query.limit).toHaveBeenCalledTimes(stage);
      expect(get).not.toHaveBeenCalled();
      expect(append).toHaveBeenCalledTimes(1);
      expectInlineUnavailable(result, f.text);
    } finally { vi.useRealTimers(); }
  });
  it.each([1, 2])("observes late rejection from linkage select %i without a second append", async stage => {
    const f = await fixture();
    const db = dbFor();
    const query = (db.select as any)();
    const gate = deferred<any[]>();
    let calls = 0;
    query.limit.mockImplementation(() => ++calls === stage ? gate.promise
      : Promise.resolve([{ id: attemptId, orgId, runId }]));
    const get = vi.spyOn(f.storage, "getObject");
    const append = vi.fn();
    vi.useFakeTimers();
    try {
      const pending = f.compact(f.payload, db).then(payload => { append(payload); return payload; });
      await vi.advanceTimersByTimeAsync(5_001);
      expectInlineUnavailable(await pending, f.text);
      gate.reject(new Error("late DB failure"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(append).toHaveBeenCalledTimes(1);
      expect(get).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each(["resolve", "reject", "resolve_destroy_error"] as const)("bounds unresolved object acquisition; safely handles late %s", async settlement => {
    const f = await fixture();
    const gate = deferred<{ stream: Readable }>();
    const get = vi.spyOn(f.storage, "getObject").mockReturnValue(gate.promise);
    const append = vi.fn();
    const stream = settlement === "resolve_destroy_error"
      ? new Readable({ read() {}, destroy(_error, callback) { callback(new Error("late stream close failure")); } })
      : Readable.from([Buffer.from(f.text)]);
    vi.useFakeTimers();
    try {
      const pending = f.compact().then(payload => { append(payload); return payload; });
      await vi.advanceTimersByTimeAsync(5_001);
      const result = await pending;
      expectInlineUnavailable(result, f.text);
      expect(get).toHaveBeenCalledTimes(1);
      if (settlement !== "reject") gate.resolve({ stream });
      else gate.reject(new Error("late object failure"));
      await vi.advanceTimersByTimeAsync(10_000);
      if (settlement !== "reject") expect(stream.destroyed).toBe(true);
      expectInlineUnavailable(result, f.text);
      expect(append).toHaveBeenCalledTimes(1);
      expect(f.deleteObject).not.toHaveBeenCalled();
    } finally { stream.destroy(); vi.useRealTimers(); }
  });
  it("uses the same deadline across DB, acquisition and a stalled stream, not a fresh stream budget", async () => {
    const f = await fixture();
    const db = dbFor();
    const query = (db.select as any)();
    query.limit.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve([{ id: attemptId, orgId, runId }]), 2_000)));
    query.limit.mockResolvedValueOnce([{ id: spanId, orgId, runId, attemptId }]);
    const stream = new Readable({ read() {} });
    vi.spyOn(f.storage, "getObject").mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ stream }), 2_000)));
    const append = vi.fn();
    vi.useFakeTimers();
    try {
      const pending = f.compact(f.payload, db).then(payload => { append(payload); return payload; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(append).not.toHaveBeenCalled();
      expect(stream.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expectInlineUnavailable(await pending, f.text);
      expect(stream.destroyed).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(append).toHaveBeenCalledTimes(1);
    } finally { stream.destroy(); vi.useRealTimers(); }
  });
});
