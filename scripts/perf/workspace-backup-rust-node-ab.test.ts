import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { runWorkspaceBackupRustNodeAb } from "./workspace-backup-rust-node-ab.js";

describe("workspace backup Rust/Node formal comparator", () => {
  const nativeBinary = process.env.RUDDER_NATIVE_ARCHIVE_PATH ?? path.resolve("native/target/debug/rudder-native");
  it.skipIf(!existsSync(nativeBinary))("compares contract parity and publication recovery with 100 process-tree RSS samples", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-ab-fixture-"));
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-ab-output-"));
    try {
      await mkdir(path.join(root, "nested"), { recursive: true });
      await writeFile(path.join(root, "README.md"), "# Backup\n");
      await writeFile(path.join(root, "nested", "payload.bin"), Buffer.alloc(128 * 1024, 0x61));
      const result = await runWorkspaceBackupRustNodeAb(root, {
        outputDir,
        nativeBinary,
        createdAt: new Date("2026-08-14T00:00:00.000Z"),
      });
      assert.equal(result.sampleCount, 100);
      assert.equal(result.node.sampleCount, 100);
      assert.equal(result.native.sampleCount, 100);
      assert.equal(result.rssScope, "process-tree");
      assert.equal(result.node.samples.length, 100);
      assert.equal(result.native.samples.length, 100);
      assert.equal(result.manifestParity, true);
      assert.equal(result.entryParity, true);
      assert.equal(result.contentParity, true);
      assert.equal(result.archiveByteParity, "not_compared");
      assert.equal(result.node.byteSize, result.native.byteSize);
      assert.match(result.node.sha256, /^[a-f0-9]{64}$/);
      assert.match(result.native.sha256, /^[a-f0-9]{64}$/);
      assert.equal(result.recovery.node.rejected, true);
      assert.equal(result.recovery.native.rejected, true);
      assert.equal(result.recovery.node.sentinelPreserved, true);
      assert.equal(result.recovery.native.sentinelPreserved, true);
      assert.deepEqual(result.recovery.node.temporaryArtifacts, []);
      assert.deepEqual(result.recovery.native.temporaryArtifacts, []);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 300_000);
});
