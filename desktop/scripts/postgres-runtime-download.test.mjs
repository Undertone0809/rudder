import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { afterEach, describe, expect, it } from "vitest";
import { downloadPostgresRuntimeArchive } from "./postgres-runtime-download.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("PostgreSQL runtime archive download", () => {
  it("streams a response body to the target archive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-postgres-download-"));
    roots.push(root);
    const target = path.join(root, "archive.zip");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("archive contents"));
        controller.close();
      },
    });

    await downloadPostgresRuntimeArchive("https://example.test/archive.zip", target, {
      fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", body }),
    });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("archive contents");
  });

  it("aborts a response body that stalls after headers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-postgres-download-timeout-"));
    roots.push(root);
    const target = path.join(root, "archive.zip");
    const body = new ReadableStream({
      start() {
        // Simulate a server that sends headers but never finishes the archive.
      },
    });

    await expect(downloadPostgresRuntimeArchive("https://example.test/archive.zip", target, {
      timeoutMs: 20,
      maxAttempts: 1,
      fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", body }),
    })).rejects.toThrow("timed out downloading https://example.test/archive.zip after 20ms");
  });
});
