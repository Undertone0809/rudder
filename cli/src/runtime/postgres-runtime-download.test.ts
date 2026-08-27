import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { downloadRuntimePostgresArchive } from "./postgres-runtime-download.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("PostgreSQL runtime archive download", () => {
  it("enforces the trusted digest supplied by the platform source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-download-"));
    roots.push(root);
    const source = path.join(root, "source.zip");
    const target = path.join(root, "target.zip");
    await fs.writeFile(source, "tampered archive", "utf8");
    const actual = createHash("sha256").update("different archive").digest("hex");

    await expect(downloadRuntimePostgresArchive(
      new URL(`file://${source}`).toString(),
      target,
      actual,
    )).rejects.toThrow("SHA-256 mismatch");
    await expect(fs.stat(target)).resolves.toBeTruthy();
  });

  it("aborts a stalled file archive copy at the supplied deadline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-download-timeout-"));
    roots.push(root);
    const source = path.join(root, "source.zip");
    const target = path.join(root, "target.zip");
    await fs.writeFile(source, "source exists", "utf8");
    const stalled = new Readable({ read() {} });

    await expect(downloadRuntimePostgresArchive(
      new URL(`file://${source}`).toString(),
      target,
      null,
      {
        timeoutMs: 20,
        createReadStreamImpl: (() => stalled) as never,
      },
    )).rejects.toThrow("timed out after 20ms");
    expect(stalled.destroyed).toBe(true);
  });
});
