import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import {
  assessBackupComparability,
  nativeTargetLabel,
  pairedP95Bootstrap,
  runWorkspaceBackupRustNodeAb,
  seededArmOrders,
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
      assert.equal(result.comparability.status, "comparable");
      const measuredBoundaries = result.sampler.operationBoundaries.filter((boundary) => !boundary.warmup);
      assert.equal(measuredBoundaries.length, 200);
      assert.equal(measuredBoundaries.filter((boundary) => boundary.positive).length, 200);
      assert.equal(measuredBoundaries.every((boundary) => boundary.positive && boundary.endRowIndex > boundary.startRowIndex), true);
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

  it("creates reproducible counterbalanced arm blocks", () => {
    const first = seededArmOrders(20260816, 100);
    const second = seededArmOrders(20260816, 100);
    assert.deepEqual(first, second);
    assert.equal(first.every((order) => order.length === 2 && new Set(order).size === 2), true);
    assert.ok(first.some((order) => order[0] === "node"));
    assert.ok(first.some((order) => order[0] === "native"));
  });

  it("reports paired p95 bootstrap confidence intervals", () => {
    const observations = Array.from({ length: 100 }, (_, block) => ([
      {
        block,
        arm: "node" as const,
        order: 0,
        warmup: false,
        sample: {
          elapsedMs: 100 + (block % 5),
          rssBeforeBytes: 100,
          rssPeakBytes: 200,
          rssAfterBytes: 100,
          rssDeltaBytes: 100 + (block % 3),
        },
      },
      {
        block,
        arm: "native" as const,
        order: 1,
        warmup: false,
        sample: {
          elapsedMs: 80 + (block % 5),
          rssBeforeBytes: 100,
          rssPeakBytes: 180,
          rssAfterBytes: 100,
          rssDeltaBytes: 80 + (block % 3),
        },
      },
    ])).flat();
    const result = pairedP95Bootstrap(observations, "elapsedMs", 1234, 1_000);
    assert.equal(result.completePairs, 100);
    assert.equal(result.nativeP95 < result.nodeP95, true);
    assert.equal(result.pointDeltaP95 < 0, true);
    assert.equal(result.ci95DeltaP95[0] <= result.pointDeltaP95, true);
    assert.equal(result.ci95DeltaP95[1] >= result.pointDeltaP95, true);
  });

  it("fails closed when the formal comparison requirements are incomplete", () => {
    const assessment = assessBackupComparability({
      warmupsPerArm: 0,
      measuredSamplesPerArm: { node: 1, native: 1 },
      pairedBlocks: 1,
      armOrders: [["node", "native"]],
      bootstrapIterations: 10,
      bootstrapMetrics: [],
      measuredBoundaryCount: 2,
      positiveMeasuredBoundaryCount: 2,
      manifestParity: true,
      entryParity: true,
      contentParity: true,
      recoveryPassed: true,
    });
    assert.equal(assessment.comparable, false);
    assert.deepEqual(assessment.failures.sort(), [
      "insufficient_bootstrap_iterations",
      "insufficient_measured_samples",
      "insufficient_paired_blocks",
      "insufficient_warmups",
      "arm_order_not_balanced",
      "missing_elapsed_bootstrap",
      "missing_rss_bootstrap",
    ].sort());
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
      const measuredBoundaries = result.sampler.operationBoundaries.filter((boundary) => !boundary.warmup);
      assert.equal(measuredBoundaries.length, 2);
      assert.equal(measuredBoundaries.filter((boundary) => boundary.positive).length, 2);
      assert.equal(measuredBoundaries.every((boundary) => boundary.positive), true);
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
