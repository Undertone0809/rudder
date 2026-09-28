import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranscriptObjectStore } from "./transcript-object-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("native transcript retention object writes", () => {
  it("keeps committed history attached and recoverable when an append hits ENOSPC", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-native-transcript-retention-"));
    roots.push(root);
    const binding = {
      orgId: "org-test",
      runId: randomUUID(),
      spanId: randomUUID(),
      ownerToken: "owner-test",
    };
    const store = createTranscriptObjectStore(root);
    const handle = await store.begin(binding);
    const committed: TranscriptEntry = {
      kind: "assistant",
      ts: "2026-09-29T00:00:00.000Z",
      text: "last committed history",
    };
    const interrupted: TranscriptEntry = {
      kind: "tool_result",
      ts: "2026-09-29T00:00:01.000Z",
      toolUseId: "tool-test",
      content: "append interrupted by ENOSPC",
      isError: false,
    };
    await store.append(handle, committed);

    const payloadPath = path.join(root, "transcript-objects", `${handle.objectRef}.ndjson`);
    const committedBytes = (await fs.stat(payloadPath)).size;
    const originalOpen = fs.open.bind(fs);
    let failedAppend = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const file = await originalOpen(filePath, flags, mode);
      if (flags !== "a" || failedAppend) return file;
      failedAppend = true;
      return new Proxy(file, {
        get(target, property) {
          if (property === "writeFile") {
            return async (data: string | Uint8Array) => {
              const bytes = Buffer.from(data);
              const partial = bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)));
              await target.writeFile(partial);
              throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as typeof file;
    });
    try {
      await expect(store.append(handle, interrupted)).rejects.toMatchObject({ code: "ENOSPC" });
    } finally {
      open.mockRestore();
    }

    const failedPayloadBytes = (await fs.stat(payloadPath)).size;
    expect(failedPayloadBytes).toBeGreaterThan(committedBytes);
    await expect(store.readRange({ ...binding, objectRef: handle.objectRef })).resolves.toMatchObject({
      source: "native_plus_objects",
      availability: "available",
      completeness: "partial",
      entries: [expect.objectContaining({ text: "last committed history" })],
    });
    await expect(store.stageSealedRemoval!({ ...binding, objectRef: handle.objectRef }))
      .rejects.toMatchObject({ status: 409 });
    expect((await fs.stat(payloadPath)).size).toBe(failedPayloadBytes);
    await expect(store.readRange({ ...binding, objectRef: handle.objectRef })).resolves.toMatchObject({
      availability: "available",
      entries: [expect.objectContaining({ text: "last committed history" })],
    });

    const recoveredStore = createTranscriptObjectStore(root);
    const recovered = await recoveredStore.resume({ ...binding, objectRef: handle.objectRef });
    expect((await fs.stat(payloadPath)).size).toBe(committedBytes);
    await recoveredStore.append(recovered, interrupted);
    await expect(recoveredStore.finalize(recovered)).resolves.toMatchObject({
      entryCount: 2,
      completeness: "complete",
    });
    await expect(recoveredStore.readRange({ ...binding, objectRef: handle.objectRef, limit: 10 })).resolves.toMatchObject({
      entries: [
        expect.objectContaining({ text: "last committed history" }),
        expect.objectContaining({ content: "append interrupted by ENOSPC" }),
      ],
    });
  });
});
