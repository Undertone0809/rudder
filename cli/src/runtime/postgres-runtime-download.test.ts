import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
});
