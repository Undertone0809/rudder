import type { Db } from "@rudderhq/db";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readRunInstructionSnapshotForEvent } from "../services/run-instruction-snapshots.js";
import type { StorageService } from "../storage/types.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const spanId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const instructionText = "injected instructions";
const sha256 = createHash("sha256").update(instructionText).digest("hex");
const objectKey = `${orgId}/run-instruction-snapshots/${sha256}`;

function fakeDb(rows: unknown[][]): Db {
  const pendingRows = [...rows];
  const query: any = {};
  query.from = vi.fn(() => query);
  query.where = vi.fn(() => query);
  query.limit = vi.fn(async () => pendingRows.shift() ?? []);
  return { select: vi.fn(() => query) } as unknown as Db;
}

function eventPayload() {
  return {
    invocationAttemptId: attemptId,
    invocationSpanId: spanId,
    invocationInstructionSnapshot: {
      status: "available",
      objectKey,
      sha256,
      byteSize: Buffer.byteLength(instructionText),
    },
  };
}

function storageFor(text: string): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(async () => ({ stream: Readable.from([Buffer.from(text)]) })),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

describe("Run instruction snapshots", () => {
  function inlinePayload() {
    return { invocationAttemptId: attemptId, invocationSpanId: spanId, prompt: instructionText,
      agentInstructionStackAlias: { present: true, sameAsPrompt: true, textSource: "persisted_prompt",
        equality: "nonempty_sanitized_exact", sanitizedSha256: sha256,
        sanitizedCharacterLength: instructionText.length, sanitizedUtf8ByteLength: Buffer.byteLength(instructionText),
        sourceCharacterLength: instructionText.length, sourceUtf8ByteLength: Buffer.byteLength(instructionText),
        sanitizedForPersistence: false } };
  }
  it("restores historical typed persisted inline only through its own Attempt and Span", async () => {
    const storage = storageFor("not used");
    const db = fakeDb([[{ payload: inlinePayload() }], [{ id: attemptId }], [{ id: spanId }]]);
    await expect(readRunInstructionSnapshotForEvent({ db, storage, orgId, runId, eventId: 17 })).resolves.toMatchObject({
      source: "persisted_invocation_inline", agentInstructionStack: instructionText, prompt: instructionText, sha256,
    });
    expect(storage.getObject).not.toHaveBeenCalled();
  });
  it.each(["digest", "length", "own_stack", "missing_attempt", "missing_span", "broken_snapshot", "provenance", "equality", "malformed_utf8"])("denies invalid inline alias: %s", async mode => {
    const payload: Record<string, unknown> = inlinePayload();
    if (mode === "digest") payload.prompt = "changed instructions";
    if (mode === "length") (payload.agentInstructionStackAlias as any).sanitizedUtf8ByteLength++;
    if (mode === "own_stack") payload.agentInstructionStack = null;
    if (mode === "broken_snapshot") payload.invocationInstructionSnapshot = { status: "available", objectKey: "wrong" };
    if (mode === "provenance") delete (payload.agentInstructionStackAlias as any).sanitizedForPersistence;
    if (mode === "equality") (payload.agentInstructionStackAlias as any).equality = "guessed";
    if (mode === "malformed_utf8") {
      payload.prompt = "\ud800";
      Object.assign(payload.agentInstructionStackAlias as any, { sanitizedCharacterLength: 1, sanitizedUtf8ByteLength: 3,
        sanitizedSha256: createHash("sha256").update("\ud800").digest("hex") });
    }
    const db = fakeDb([[{ payload }], mode === "missing_attempt" ? [] : [{ id: attemptId }], mode === "missing_span" ? [] : [{ id: spanId }]]);
    await expect(readRunInstructionSnapshotForEvent({ db, storage: storageFor("unused"), orgId, runId, eventId: 17 })).resolves.toBeNull();
  });
  it("reads only a snapshot linked through the Run's adapter event, Attempt, and Span", async () => {
    const storage = storageFor(instructionText);
    const db = fakeDb([
      [{ payload: eventPayload() }],
      [{ id: attemptId }],
      [{ id: spanId }],
    ]);

    await expect(readRunInstructionSnapshotForEvent({ db, storage, orgId, runId, eventId: 17 }))
      .resolves.toEqual({
        agentInstructionStack: instructionText,
        sha256,
        byteSize: Buffer.byteLength(instructionText),
      });
    expect(storage.getObject).toHaveBeenCalledWith(orgId, objectKey);
  });

  it("does not read the object when the Run Attempt link is missing", async () => {
    const storage = storageFor("injected instructions");
    const db = fakeDb([
      [{ payload: eventPayload() }],
      [],
    ]);

    await expect(readRunInstructionSnapshotForEvent({ db, storage, orgId, runId, eventId: 17 }))
      .resolves.toBeNull();
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("does not read the object when the Span does not belong to the Attempt", async () => {
    const storage = storageFor(instructionText);
    const db = fakeDb([
      [{ payload: eventPayload() }],
      [{ id: attemptId }],
      [],
    ]);

    await expect(readRunInstructionSnapshotForEvent({ db, storage, orgId, runId, eventId: 17 }))
      .resolves.toBeNull();
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("does not infer a snapshot for older events that contain only a digest", async () => {
    const storage = storageFor(instructionText);
    const db = fakeDb([[
      { payload: { invocationContent: { textStored: false } } },
    ]]);

    await expect(readRunInstructionSnapshotForEvent({ db, storage, orgId, runId, eventId: 17 }))
      .resolves.toBeNull();
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("rejects content whose bytes do not match the event locator", async () => {
    const storage = storageFor("changed instructions");
    const db = fakeDb([
      [{ payload: eventPayload() }],
      [{ id: attemptId }],
      [{ id: spanId }],
    ]);

    await expect(readRunInstructionSnapshotForEvent({ db, storage, orgId, runId, eventId: 17 }))
      .resolves.toBeNull();
  });
  it.each(["valid", "digest", "bounds", "utf8_boundary"])("validates public prompt range after the entire snapshot: %s", async mode => {
    const text = "前🙂 debug 后";
    const bytes = Buffer.from(text);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const start = mode === "utf8_boundary" ? 4 : Buffer.byteLength("前🙂 ");
    const range = bytes.subarray(start, start + 5);
    const payload = { ...eventPayload(), invocationInstructionSnapshot: { status: "available", sha256: digest,
      byteSize: bytes.length, objectKey: `${orgId}/run-instruction-snapshots/${digest}` },
      invocationPromptReference: { source: "stored_snapshot", field: "prompt", sha256: digest, byteSize: bytes.length,
        byteStart: start, byteLength: mode === "bounds" ? 1000 : 5,
        rangeSha256: mode === "digest" ? "0".repeat(64) : createHash("sha256").update(range).digest("hex") } };
    const result = await readRunInstructionSnapshotForEvent({ db: fakeDb([[{ payload }], [{ id: attemptId }], [{ id: spanId }]]),
      storage: storageFor(text), orgId, runId, eventId: 17 });
    if (mode === "valid") expect(result).toMatchObject({ agentInstructionStack: text, prompt: "debug" });
    else expect(result).toBeNull();
  });
});
