import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeTranscriptReadInput } from "./transcript-reader.js";
import {
  createTranscriptObjectReader,
  createTranscriptObjectStore,
  type TranscriptObjectBeginInput,
} from "./transcript-object-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-transcript-object-"));
  roots.push(root);
  return { root, store: createTranscriptObjectStore(root) };
}

const binding: TranscriptObjectBeginInput = {
  orgId: "org-1",
  runId: "run-1",
  spanId: "span-1",
  ownerToken: "owner-secret-1",
};

const entries: TranscriptEntry[] = [
  { kind: "assistant", ts: "2026-09-23T00:00:01.000Z", text: "first" },
  { kind: "tool_result", ts: "2026-09-23T00:00:02.000Z", toolUseId: "tool-1", content: "second", isError: false },
];

function readInput(objectRef: string, overrides: Partial<TranscriptObjectBeginInput> = {}) {
  return {
    objectRef,
    ...binding,
    ...overrides,
  };
}

describe("transcript object store", () => {
  it("does not delete an existing payload when allocation collides", async () => {
    const { root, store } = await fixture();
    const originalOpen = fs.open.bind(fs);
    let collisionPath: string | null = null;
    const open = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (!collisionPath && flags === "wx" && String(filePath).endsWith(".ndjson")) {
        collisionPath = String(filePath);
        await fs.writeFile(collisionPath, "existing-payload", "utf8");
        throw Object.assign(new Error("File exists"), { code: "EEXIST" });
      }
      return originalOpen(filePath, flags, mode);
    });
    try {
      await store.begin(binding);
    } finally {
      open.mockRestore();
    }
    expect(collisionPath).toMatch(/^.+\.ndjson$/u);
    expect(collisionPath).toContain(root);
    await expect(fs.readFile(collisionPath!, "utf8")).resolves.toBe("existing-payload");
  });

  it("reads an empty object before and after sealing without opening a negative byte range", async () => {
    const { store } = await fixture();
    const handle = await store.begin(binding);
    await expect(store.readRange(readInput(handle.objectRef))).resolves.toMatchObject({
      entries: [],
      nextCursor: null,
      completeness: "partial",
    });
    await store.finalize(handle);
    await expect(store.readRange(readInput(handle.objectRef))).resolves.toMatchObject({
      entries: [],
      nextCursor: null,
      completeness: "complete",
    });
  });

  it("streams entries into an open partial object, pages them, then seals immutably", async () => {
    const { store } = await fixture();
    const handle = await store.begin(binding);

    await store.append(handle, entries[0]!);
    await store.append(handle, [entries[1]!]);

    const first = await store.readRange({ ...readInput(handle.objectRef), limit: 1 });
    expect(first).toMatchObject({
      source: "native_plus_objects",
      availability: "available",
      completeness: "partial",
    });
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({ kind: "assistant", text: "first" });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await store.readRange({
      ...readInput(handle.objectRef),
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.entries).toEqual([expect.objectContaining({ kind: "tool_result", content: "second" })]);
    expect(second.nextCursor).toBeNull();

    const receipt = await store.finalize(handle);
    expect(receipt).toMatchObject({ objectRef: handle.objectRef, entryCount: 2, completeness: "complete" });
    await expect(store.append(handle, entries[0]!)).rejects.toMatchObject({ status: 409 });

    const sealed = await store.readRange({ ...readInput(handle.objectRef), limit: 10 });
    expect(sealed).toMatchObject({ completeness: "complete", revision: first.revision });
    expect(sealed.entries).toHaveLength(2);
  });

  it("supports one-shot write while keeping the reference opaque and owner material out of metadata", async () => {
    const { root, store } = await fixture();
    const objectRef = await store.write({ ...binding, entries });

    expect(objectRef).toMatch(/^tobj_v1_[0-9a-f-]{36}$/u);
    const metadata = await fs.readFile(path.join(root, "transcript-objects", `${objectRef}.json`), "utf8");
    expect(metadata).not.toContain(binding.ownerToken);
    await expect(store.readRange({ ...readInput(objectRef), limit: 10 })).resolves.toMatchObject({
      source: "native_plus_objects",
      completeness: "complete",
      entries,
    });
  });

  it("rejects an oversized append before serializing the full entry", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    const input: Record<string, unknown> = { oversized: "x".repeat(2 * 1024 * 1024), cycle: null };
    input.cycle = input;

    await expect(store.append(handle, {
      kind: "tool_call",
      ts: "2026-09-23T00:00:00.000Z",
      name: "large-tool",
      input,
    })).rejects.toMatchObject({ status: 400 });
    await expect(fs.stat(path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`)))
      .resolves.toMatchObject({ size: 0 });
  });

  it("checks the aggregate append budget before serializing any entry", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    const makeEntry = (input: Record<string, unknown>): TranscriptEntry => ({
      kind: "tool_call",
      ts: "2026-09-23T00:00:00.000Z",
      name: "large-tool",
      input,
    });
    const firstTwo = [
      makeEntry({ text: "x".repeat(1400 * 1024) }),
      makeEntry({ text: "x".repeat(1400 * 1024) }),
    ];
    const finalInput: Record<string, unknown> = { text: "x".repeat(1400 * 1024), cycle: null };
    finalInput.cycle = finalInput;

    await expect(store.append(handle, [...firstTwo, makeEntry(finalInput)]))
      .rejects.toMatchObject({ status: 400 });
    await expect(fs.stat(path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`)))
      .resolves.toMatchObject({ size: 0 });
  });

  it("rejects stored lines that exceed the byte cap while reading and scanning", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    await store.append(handle, entries[0]!);
    await store.finalize(handle);
    const payload = JSON.stringify({
      version: 1,
      entry: { kind: "assistant", ts: "2026-09-23T00:00:00.000Z", text: "x".repeat(2 * 1024 * 1024) },
    });
    await fs.writeFile(path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`), `${payload}\n`, "utf8");
    const metadataPath = path.join(root, "transcript-objects", `${handle.objectRef}.json`);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.bytes = Buffer.byteLength(`${payload}\n`, "utf8");
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");

    await expect(store.readRange({ ...readInput(handle.objectRef) }))
      .rejects.toThrow("Transcript object line limit exceeded");
    await expect(store.finalize(handle)).rejects.toThrow("Transcript object line limit exceeded");
  });

  it("rejects forged references and every cross-binding read", async () => {
    const { store } = await fixture();
    const objectRef = await store.write({ ...binding, entries });

    await expect(store.readRange({ ...readInput("tobj_v1_00000000-0000-0000-0000-000000000000") })).rejects.toMatchObject({ status: 404 });
    await expect(store.readRange({ ...readInput(objectRef), objectRef: "../outside" })).rejects.toMatchObject({ status: 403 });
    await expect(store.readRange({ ...readInput(objectRef), orgId: "org-2" })).rejects.toMatchObject({ status: 403 });
    await expect(store.readRange({ ...readInput(objectRef), runId: "run-2" })).rejects.toMatchObject({ status: 403 });
    await expect(store.readRange({ ...readInput(objectRef), spanId: "span-2" })).rejects.toMatchObject({ status: 403 });
    await expect(store.readRange({ ...readInput(objectRef), ownerToken: "owner-secret-2" })).rejects.toMatchObject({ status: 403 });
  });

  it("exposes only the span supplemental ref through the Reader hook", async () => {
    const { store } = await fixture();
    const objectRef = await store.write({ ...binding, entries: [entries[0]!] });
    const reader = createTranscriptObjectReader(store);
    const input = {
      readonly: true,
      scope: "run",
      orgId: binding.orgId,
      run: { id: binding.runId },
      span: {
        id: binding.spanId,
        ownerToken: binding.ownerToken,
        supplementalObjectRef: objectRef,
      },
    } as unknown as NativeTranscriptReadInput;

    await expect(reader.readRange!(input)).resolves.toMatchObject({
      source: "native_plus_objects",
      completeness: "complete",
      entries: [expect.objectContaining({ text: "first" })],
    });
    await expect(reader.readRange!({
      ...input,
      span: { ...input.span, supplementalObjectRef: null },
    })).resolves.toMatchObject({ availability: "missing", completeness: "unknown", items: [] });
  });

  it("keeps the source owner hash while allowing only the attached Reader path to read after owner recovery", async () => {
    const { store } = await fixture();
    const objectRef = await store.write({ ...binding, entries: [entries[0]!] });

    await expect(store.readRange({
      ...readInput(objectRef),
      ownerToken: "recovered-owner",
    })).rejects.toMatchObject({ status: 403 });

    const reader = createTranscriptObjectReader(store);
    const input = {
      readonly: true,
      scope: "run",
      orgId: binding.orgId,
      run: { id: binding.runId },
      span: {
        id: binding.spanId,
        ownerToken: "recovered-owner",
        supplementalObjectRef: objectRef,
      },
    } as unknown as import("./transcript-reader.js").NativeTranscriptReadInput;
    await expect(reader.readRange!(input)).resolves.toMatchObject({
      source: "native_plus_objects",
      completeness: "complete",
      entries: [expect.objectContaining({ text: "first" })],
    });
  });

  it("resumes the attached open object for owner recovery without changing its lineage", async () => {
    const { store } = await fixture();
    const original = await store.begin(binding);
    await store.append(original, entries[0]!);

    await expect(store.resume({
      ...binding,
      orgId: "org-2",
      objectRef: original.objectRef,
    })).rejects.toMatchObject({ status: 403 });

    const recovered = await store.resume({
      ...binding,
      ownerToken: "recovered-owner",
      objectRef: original.objectRef,
    });
    await store.append(recovered, entries[1]!);
    await expect(store.finalize(recovered, { completeness: "partial" })).resolves.toMatchObject({
      objectRef: original.objectRef,
      completeness: "partial",
      entryCount: 2,
    });

    await expect(store.readRange({
      ...readInput(original.objectRef),
      ownerToken: "recovered-owner",
    })).rejects.toMatchObject({ status: 403 });

    const reader = createTranscriptObjectReader(store);
    const input = {
      readonly: true,
      scope: "run",
      orgId: binding.orgId,
      run: { id: binding.runId },
      span: {
        id: binding.spanId,
        ownerToken: "recovered-owner",
        supplementalObjectRef: original.objectRef,
      },
    } as unknown as NativeTranscriptReadInput;
    await expect(reader.readRange!(input)).resolves.toMatchObject({
      source: "native_plus_objects",
      completeness: "partial",
      entries,
    });
  });

  it("hides an uncommitted append and discards its torn tail before recovery", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    await store.append(handle, entries[0]!);
    const payloadPath = path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`);
    const committedBytes = (await fs.stat(payloadPath)).size;
    await fs.appendFile(payloadPath, `${JSON.stringify({ version: 1, entry: entries[1] })}\n{"version":1,"entry":`, "utf8");

    const before = await store.readRange({ ...readInput(handle.objectRef), limit: 10 });
    expect(before.entries).toHaveLength(1);
    expect(before.entries[0]).toMatchObject({ text: "first" });
    const recoveredStore = createTranscriptObjectStore(root);
    const recovered = await recoveredStore.resume({ ...binding, objectRef: handle.objectRef });
    expect((await fs.stat(payloadPath)).size).toBe(committedBytes);
    await recoveredStore.append(recovered, entries[1]!);
    await expect(recoveredStore.finalize(recovered)).resolves.toMatchObject({ entryCount: 2 });
    const after = await recoveredStore.readRange({ ...readInput(handle.objectRef), limit: 10 });
    expect(after.entries).toMatchObject([{ text: "first" }, { content: "second" }]);
    expect(after.completeness).toBe("complete");
  });

  it("seals only committed entries after a failed append leaves a tail", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    await store.append(handle, entries[0]!);
    const payloadPath = path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`);
    const committedBytes = (await fs.stat(payloadPath)).size;
    await fs.appendFile(payloadPath, '{"version":1,"entry":', "utf8");

    await expect(store.finalize(handle)).resolves.toMatchObject({ entryCount: 1, bytes: committedBytes });
    expect((await fs.stat(payloadPath)).size).toBe(committedBytes);
    const result = await store.readRange(readInput(handle.objectRef));
    expect(result.entries).toHaveLength(1);
    expect(result.completeness).toBe("complete");
  });

  it("refuses to resume or append when committed payload bytes are missing", async () => {
    const { root, store } = await fixture();
    const handle = await store.begin(binding);
    await store.append(handle, entries[0]!);
    const payloadPath = path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`);
    await fs.truncate(payloadPath, 1);
    const recoveredStore = createTranscriptObjectStore(root);
    await expect(recoveredStore.resume({ ...binding, objectRef: handle.objectRef }))
      .rejects.toThrow("shorter than committed metadata");
    await expect(store.append(handle, entries[1]!)).rejects.toThrow("shorter than committed metadata");
    await expect(store.finalize(handle)).rejects.toThrow("shorter than committed metadata");
    await expect(store.readRange(readInput(handle.objectRef))).rejects.toThrow("does not match committed metadata");
  });

  it("sweeps only old unreferenced objects and preserves protected or recent objects", async () => {
    const { root, store } = await fixture();
    const protectedRef = await store.write({ ...binding, entries: [entries[0]!] });
    const collectableRef = await store.write({ ...binding, entries: [entries[1]!] });
    const recentRef = await store.write({ ...binding, entries: [entries[0]!] });
    const now = new Date();
    const oldUpdatedAt = new Date(now.getTime() - 60_000).toISOString();
    const metadataPath = (ref: string) => path.join(root, "transcript-objects", `${ref}.json`);
    for (const ref of [protectedRef, collectableRef]) {
      const metadata = JSON.parse(await fs.readFile(metadataPath(ref), "utf8")) as Record<string, unknown>;
      metadata.updatedAt = oldUpdatedAt;
      await fs.writeFile(metadataPath(ref), `${JSON.stringify(metadata)}\n`, "utf8");
    }

    const swept = await store.sweepUnreferenced({
      protectedObjectRefs: [protectedRef],
      now,
      minAgeMs: 1_000,
    });
    expect(swept).toMatchObject({
      scanned: 3,
      protected: 1,
      deletedObjectRefs: [collectableRef],
    });
    await expect(fs.stat(metadataPath(protectedRef))).resolves.toBeTruthy();
    await expect(fs.stat(metadataPath(collectableRef))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(metadataPath(recentRef))).resolves.toBeTruthy();
  });

  it("preserves aged payload-only crash-window files without invoking the retention guard", async () => {
    const { root, store } = await fixture();
    const objectRoot = path.join(root, "transcript-objects");
    await fs.mkdir(objectRoot, { recursive: true });
    const emptyRef = `tobj_v1_${randomUUID()}`;
    const recoverableRef = `tobj_v1_${randomUUID()}`;
    const emptyPath = path.join(objectRoot, `${emptyRef}.ndjson`);
    const recoverablePath = path.join(objectRoot, `${recoverableRef}.ndjson`);
    const oldDate = new Date("2026-09-20T00:00:00.000Z");
    await fs.writeFile(emptyPath, "", "utf8");
    await fs.writeFile(recoverablePath, `${JSON.stringify({ version: 1, entry: entries[0] })}\n`, "utf8");
    await fs.utimes(emptyPath, oldDate, oldDate);
    await fs.utimes(recoverablePath, oldDate, oldDate);
    const withRetentionGuard = vi.fn(async () => "deleted" as const);

    const swept = await store.sweepUnreferenced({
      protectedObjectRefs: [emptyRef],
      withRetentionGuard,
      now: new Date("2026-09-24T00:00:00.000Z"),
      minAgeMs: 1_000,
    });

    expect(swept.deletedObjectRefs).toEqual([]);
    expect(withRetentionGuard).not.toHaveBeenCalled();
    await expect(fs.readFile(emptyPath, "utf8")).resolves.toBe("");
    await expect(fs.readFile(recoverablePath, "utf8")).resolves.toContain("first");
  });

  it("preserves symlinked payload-only files and their targets", async () => {
    const { root, store } = await fixture();
    const objectRoot = path.join(root, "transcript-objects");
    await fs.mkdir(objectRoot, { recursive: true });
    const ref = `tobj_v1_${randomUUID()}`;
    const linkPath = path.join(objectRoot, `${ref}.ndjson`);
    const targetPath = path.join(root, "recoverable-transcript.ndjson");
    await fs.writeFile(targetPath, "recoverable payload\n", "utf8");
    await fs.symlink(targetPath, linkPath);

    const swept = await store.sweepUnreferenced({ now: new Date(), minAgeMs: 0 });

    expect(swept.deletedObjectRefs).toEqual([]);
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("recoverable payload\n");
  });

  it("does not destroy malformed or incomplete objects during a sweep", async () => {
    const { root, store } = await fixture();
    const objectRef = await store.write({ ...binding, entries: [entries[0]!] });
    const metadataPath = path.join(root, "transcript-objects", `${objectRef}.json`);
    const payloadPath = path.join(root, "transcript-objects", `${objectRef}.ndjson`);
    await fs.writeFile(metadataPath, "not-json\n", "utf8");

    const swept = await store.sweepUnreferenced({
      now: new Date("2026-09-23T00:00:00.000Z"),
      minAgeMs: 0,
    });
    expect(swept.deletedObjectRefs).toEqual([]);
    expect(swept.skipped).toBe(1);
    await expect(fs.stat(metadataPath)).resolves.toBeTruthy();
    await expect(fs.readFile(payloadPath, "utf8")).resolves.toContain("first");
  });

  it("bounds sweeps when the caller does not provide a limit", async () => {
    const { root, store } = await fixture();
    const objectRoot = path.join(root, "transcript-objects");
    await fs.mkdir(objectRoot, { recursive: true });
    const now = new Date();
    const updatedAt = new Date(now.getTime() - 60_000).toISOString();
    const objectCount = 501;
    for (let index = 0; index < objectCount; index += 1) {
      const ref = `tobj_v1_${randomUUID()}`;
      await fs.writeFile(path.join(objectRoot, `${ref}.json`), `${JSON.stringify({
        version: 1,
        objectRef: ref,
        orgId: binding.orgId,
        runId: binding.runId,
        spanId: binding.spanId,
        sourceOwnerHash: "0".repeat(64),
        state: "sealed",
        completeness: "complete",
        entryCount: 0,
        bytes: 0,
        createdAt: updatedAt,
        updatedAt,
      })}\n`, "utf8");
    }

    const swept = await store.sweepUnreferenced({ now, minAgeMs: 0 });
    expect(swept.scanned).toBeGreaterThan(0);
    expect(swept.scanned).toBeLessThan(objectCount);
    expect(swept.skipped).toBe(swept.scanned);

    const nextBatch = await store.sweepUnreferenced({ now, minAgeMs: 0 });
    expect(nextBatch.scanned).toBe(objectCount - swept.scanned);
    expect(nextBatch.skipped).toBe(nextBatch.scanned);
  });
});
