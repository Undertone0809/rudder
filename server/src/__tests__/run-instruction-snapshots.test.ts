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
});
