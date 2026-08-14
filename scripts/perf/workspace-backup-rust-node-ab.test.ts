import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import {
  nativeTargetLabel,
  runWorkspaceBackupRustNodeAb,
  stableFixtureContentHash,
} from "./workspace-backup-rust-node-ab.js";

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
      assert.equal(result.identity.nativeBinary.target, nativeTargetLabel());
      assert.equal(result.node.byteSize, result.native.byteSize);
      assert.match(result.node.sha256, /^[a-f0-9]{64}$/);
      assert.match(result.native.sha256, /^[a-f0-9]{64}$/);
      assert.equal(result.recovery.node.rejected, true);
      assert.equal(result.recovery.native.rejected, true);
      assert.equal(result.recovery.node.sentinelPreserved, true);
      assert.equal(result.recovery.native.sentinelPreserved, true);
      assert.deepEqual(result.recovery.node.temporaryArtifacts, []);
      assert.deepEqual(result.recovery.native.temporaryArtifacts, []);
      assert.equal(result.identity.fixture.treeSha256.length, 64);
      assert.equal(result.identity.fixture.contentSha256.length, 64);
      assert.equal(result.sampler.operationBoundaries.length, 200);
      assert.equal(result.sampler.positiveBoundaryCount, 200);
      assert.equal(result.sampler.operationBoundaries.every((boundary) => boundary.positive && boundary.endRowIndex > boundary.startRowIndex), true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 300_000);

  it("maps native Darwin labels and hashes fixture content independently of entry order", () => {
    assert.equal(nativeTargetLabel("darwin", "arm64"), "aarch64-apple-darwin");
    assert.equal(nativeTargetLabel("darwin", "x64"), "x86_64-apple-darwin");
    assert.equal(nativeTargetLabel("linux", "x64"), "x64-linux");
    const entries = [
      { path: "b.txt", kind: "file" as const, byteSize: 2, sha256: "b" },
      { path: "folder", kind: "directory" as const, byteSize: 0, sha256: null },
      { path: "a.txt", kind: "file" as const, byteSize: 1, sha256: "a" },
    ];
    assert.equal(stableFixtureContentHash(entries), stableFixtureContentHash([...entries].reverse()));
  });

  it.skipIf(!existsSync(nativeBinary))("fails with an explicit bounded operation timeout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-ab-timeout-fixture-"));
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-ab-timeout-output-"));
    try {
      await writeFile(path.join(root, "file.txt"), "content");
      await assert.rejects(
        runWorkspaceBackupRustNodeAb(root, {
          outputDir,
          nativeBinary,
          sampleCount: 1,
          operationTimeoutMs: 1,
        }),
        /workspace backup operation timed out/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(nativeBinary) || !existsSync(path.resolve("native/target/debug/rudder-process-tree-sampler")) || process.platform !== "darwin" || process.arch !== "arm64")("uses one shared external sampler session with positive operation boundaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-ab-external-fixture-"));
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-ab-external-output-"));
    try {
      await writeFile(path.join(root, "file.txt"), "content");
      const result = await runWorkspaceBackupRustNodeAb(root, {
        outputDir,
        nativeBinary,
        sampleCount: 1,
        samplerMode: "external",
        samplerPath: path.resolve("native/target/debug/rudder-process-tree-sampler"),
      });
      assert.equal(result.sampler.sessionScope, "shared-run");
      assert.equal(result.sampler.operationBoundaries.length, 2);
      assert.equal(result.sampler.positiveBoundaryCount, 2);
      assert.equal(result.sampler.operationBoundaries.every((boundary) => boundary.positive), true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(nativeBinary))("fails closed when the requested external sampler is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-ab-missing-sampler-fixture-"));
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-ab-missing-sampler-output-"));
    try {
      await writeFile(path.join(root, "file.txt"), "content");
      await assert.rejects(
        runWorkspaceBackupRustNodeAb(root, {
          outputDir,
          nativeBinary,
          samplerMode: "external",
          samplerPath: path.join(root, "missing-process-tree-sampler"),
          sampleCount: 1,
        }),
        /external process-tree sampler is unavailable/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
