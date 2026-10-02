import type { Db } from "@rudderhq/db";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { compactReadableInstructionSnapshot } from "../services/run-instruction-snapshots.compaction.js";
import { readRunInstructionSnapshotForEvent, storeRunInstructionSnapshot } from "../services/run-instruction-snapshots.js";
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
    expect(Buffer.byteLength(JSON.stringify(f.payload)) - Buffer.byteLength(JSON.stringify(projected))).toBe(199_546);
    expect(f.payload.agentInstructionStack).toBe(f.text);
    expect(f.deleteObject).not.toHaveBeenCalled();
  });
  it("keeps distinct debug prompt and unique context verbatim", async () => {
    const f = await fixture();
    const projected = await f.compact({ ...f.payload, prompt: "distinct task input" });
    expect(projected.prompt).toBe("distinct task input");
    expect(projected).not.toHaveProperty("invocationPromptReference");
    expect(projected).not.toHaveProperty("agentInstructionStack");
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
});
