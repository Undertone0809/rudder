import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  createWorkspaceBackupV2File,
  createWorkspaceBackupV2Native,
  inspectWorkspaceBackupV2File,
  readWorkspaceBackupV2File,
  type WorkspaceBackupV2ArchiveIndex,
} from "../../server/src/services/workspace-backup-v2.js";

const execFileAsync = promisify(execFile);

export type WorkspaceBackupRustNodeAbResult = {
  rootPath: string;
  fileCount: number;
  byteSize: number;
  manifestParity: boolean;
  entryParity: boolean;
  contentParity: boolean;
  archiveFormatParity: false;
  node: {
    elapsedMs: number;
    rssDeltaBytes: number;
    byteSize: number;
    sha256: string;
    artifactPath: string;
  };
  native: {
    elapsedMs: number;
    rssDeltaBytes: number;
    byteSize: number;
    sha256: string;
    artifactPath: string;
  };
  recovery: {
    node: RecoveryProbe;
    native: RecoveryProbe;
  };
};

type RecoveryProbe = {
  rejected: boolean;
  errorCode: string | null;
  sentinelPreserved: boolean;
  temporaryArtifacts: string[];
};

type AbOptions = {
  outputDir?: string;
  nativeBinary?: string;
  createdAt?: Date;
};

async function sha256File(filePath: string) {
  return crypto.createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function elapsed(start: number) {
  return Number((performance.now() - start).toFixed(3));
}

function memoryDelta(before: NodeJS.MemoryUsage, after: NodeJS.MemoryUsage) {
  return after.rss - before.rss;
}

async function inspectAndCompare(
  rootPath: string,
  nodePath: string,
  nativePath: string,
  nodeIndex: WorkspaceBackupV2ArchiveIndex,
  nativeIndex: WorkspaceBackupV2ArchiveIndex,
) {
  assert.deepEqual(nativeIndex.manifest, nodeIndex.manifest);
  assert.deepEqual(
    [...nativeIndex.entries.keys()].sort(),
    [...nodeIndex.entries.keys()].sort(),
  );
  for (const entry of nodeIndex.manifest.entries) {
    if (entry.kind !== "file") continue;
    const expected = await readFile(path.join(rootPath, entry.path));
    const nodeBytes = await readWorkspaceBackupV2File(nodePath, nodeIndex, entry.path);
    const nativeBytes = await readWorkspaceBackupV2File(nativePath, nativeIndex, entry.path);
    assert.deepEqual(nodeBytes, expected, `Node archive content mismatch: ${entry.path}`);
    assert.deepEqual(nativeBytes, expected, `native archive content mismatch: ${entry.path}`);
    assert.deepEqual(nativeBytes, nodeBytes, `Rust/Node content mismatch: ${entry.path}`);
  }
}

async function recoveryProbe(
  kind: "node" | "native",
  rootPath: string,
  artifactPath: string,
  createdAt: Date,
  nativeBinary: string,
): Promise<RecoveryProbe> {
  const sentinel = Buffer.from(`${kind}-sentinel`);
  const beforePublish = async () => writeFile(artifactPath, sentinel, { flag: "wx" });
  let error: unknown;
  try {
    if (kind === "node") {
      await createWorkspaceBackupV2File({ rootPath, orgId: "ab-org", instanceId: "ab-instance", artifactPath, createdAt, beforePublish });
    } else {
      const previousBinary = process.env.RUDDER_NATIVE_ARCHIVE_PATH;
      process.env.RUDDER_NATIVE_ARCHIVE_PATH = nativeBinary;
      try {
        await createWorkspaceBackupV2Native({ rootPath, orgId: "ab-org", instanceId: "ab-instance", artifactPath, createdAt, beforePublish });
      } finally {
        if (previousBinary === undefined) delete process.env.RUDDER_NATIVE_ARCHIVE_PATH;
        else process.env.RUDDER_NATIVE_ARCHIVE_PATH = previousBinary;
      }
    }
  } catch (caught) {
    error = caught;
  }
  const parentEntries = await readdir(path.dirname(artifactPath));
  return {
    rejected: error !== undefined,
    errorCode: typeof error === "object" && error && "diagnostic" in error
      ? String((error as { diagnostic?: { code?: unknown } }).diagnostic?.code ?? "unknown")
      : error instanceof Error ? error.message : null,
    sentinelPreserved: (await readFile(artifactPath)).equals(sentinel),
    temporaryArtifacts: parentEntries.filter((entry) => entry.includes(".tmp") || entry.startsWith(".rudder-native-archive-") ),
  };
}

export async function runWorkspaceBackupRustNodeAb(
  rootPath: string,
  options: AbOptions = {},
): Promise<WorkspaceBackupRustNodeAbResult> {
  const outputDir = options.outputDir ?? await fsTempDir();
  const nativeBinary = options.nativeBinary ?? process.env.RUDDER_NATIVE_ARCHIVE_PATH;
  if (!nativeBinary || !existsSync(nativeBinary)) {
    throw new Error("native binary is required; set RUDDER_NATIVE_ARCHIVE_PATH or pass nativeBinary");
  }
  const createdAt = options.createdAt ?? new Date("2026-08-14T00:00:00.000Z");
  const nodePath = path.join(outputDir, "node.zip");
  const nativePath = path.join(outputDir, "native.zip");
  const beforeNode = process.memoryUsage();
  const nodeStart = performance.now();
  const nodeArtifact = await createWorkspaceBackupV2File({ rootPath, orgId: "ab-org", instanceId: "ab-instance", artifactPath: nodePath, createdAt });
  const nodeResult = { elapsedMs: elapsed(nodeStart), rssDeltaBytes: memoryDelta(beforeNode, process.memoryUsage()) };
  const previousBinary = process.env.RUDDER_NATIVE_ARCHIVE_PATH;
  process.env.RUDDER_NATIVE_ARCHIVE_PATH = nativeBinary;
  const beforeNative = process.memoryUsage();
  const nativeStart = performance.now();
  try {
    await createWorkspaceBackupV2Native({ rootPath, orgId: "ab-org", instanceId: "ab-instance", artifactPath: nativePath, createdAt });
  } finally {
    if (previousBinary === undefined) delete process.env.RUDDER_NATIVE_ARCHIVE_PATH;
    else process.env.RUDDER_NATIVE_ARCHIVE_PATH = previousBinary;
  }
  const nativeResult = { elapsedMs: elapsed(nativeStart), rssDeltaBytes: memoryDelta(beforeNative, process.memoryUsage()) };
  const nodeIndex = await inspectWorkspaceBackupV2File(nodePath);
  const nativeIndex = await inspectWorkspaceBackupV2File(nativePath);
  await inspectAndCompare(rootPath, nodePath, nativePath, nodeIndex, nativeIndex);
  const [nodeSha256, nativeSha256, nodeStat, nativeStat] = await Promise.all([
    sha256File(nodePath), sha256File(nativePath), stat(nodePath), stat(nativePath),
  ]);
  await Promise.all([
    execFileAsync("unzip", ["-t", nodePath]),
    execFileAsync("unzip", ["-t", nativePath]),
  ]);
  const recovery = {
    node: await recoveryProbe("node", rootPath, path.join(outputDir, "node-race.zip"), createdAt),
    native: await recoveryProbe("native", rootPath, path.join(outputDir, "native-race.zip"), createdAt, nativeBinary),
  };
  assert.equal(recovery.node.rejected, true);
  assert.equal(recovery.native.rejected, true);
  assert.equal(recovery.node.sentinelPreserved, true);
  assert.equal(recovery.native.sentinelPreserved, true);
  assert.deepEqual(recovery.node.temporaryArtifacts, []);
  assert.deepEqual(recovery.native.temporaryArtifacts, []);
  return {
    rootPath: path.resolve(rootPath),
    fileCount: nodeArtifact.fileCount,
    byteSize: nodeArtifact.byteSize,
    manifestParity: JSON.stringify(nodeIndex.manifest) === JSON.stringify(nativeIndex.manifest),
    entryParity: nodeIndex.entries.size === nativeIndex.entries.size,
    contentParity: true,
    archiveFormatParity: false,
    node: { ...nodeResult, byteSize: nodeStat.size, sha256: nodeSha256, artifactPath: nodePath },
    native: { ...nativeResult, byteSize: nativeStat.size, sha256: nativeSha256, artifactPath: nativePath },
    recovery,
  };
}

async function fsTempDir() {
  return mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-rust-node-ab-"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootPath = process.argv[2];
  if (!rootPath) {
    console.error("Usage: pnpm exec tsx scripts/perf/workspace-backup-rust-node-ab.ts <workspace-root> [output-dir]");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(await runWorkspaceBackupRustNodeAb(rootPath, { outputDir: process.argv[3] }), null, 2));
  }
}
