import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  sampleCount: number;
  rssScope: "process-tree";
  manifestParity: boolean;
  entryParity: boolean;
  contentParity: boolean;
  archiveByteParity: "not_compared";
  node: {
    elapsedMs: number;
    rssDeltaBytes: number;
    byteSize: number;
    sha256: string;
    artifactPath: string;
    sampleCount: number;
    rssPeakBytes: number;
    samples: RssSample[];
  };
  native: {
    elapsedMs: number;
    rssDeltaBytes: number;
    byteSize: number;
    sha256: string;
    artifactPath: string;
    sampleCount: number;
    rssPeakBytes: number;
    samples: RssSample[];
  };
  recovery: {
    node: RecoveryProbe;
    native: RecoveryProbe;
  };
};

type RssSample = {
  elapsedMs: number;
  rssBeforeBytes: number;
  rssPeakBytes: number;
  rssAfterBytes: number;
  rssDeltaBytes: number;
};

type MeasuredOperation<T> = {
  value: T;
  sample: RssSample;
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
  sampleCount?: number;
  sampleIntervalMs?: number;
};

async function sha256File(filePath: string) {
  return crypto.createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function elapsed(start: number) {
  return Number((performance.now() - start).toFixed(3));
}

function nearestRank(values: number[], percentile: number) {
  if (values.length === 0) throw new Error("cannot summarize an empty sample set");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!;
}

async function processTreeRss(rootPid: number) {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const records = stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssBytes: Number(match[3]) * 1024,
        command: match[4]!.trim(),
      };
    })
    .filter((record): record is NonNullable<typeof record> => record !== null && Number.isFinite(record.rssBytes));
  const byParent = new Map<number, number[]>();
  const byPid = new Map<number, (typeof records)[number]>();
  for (const record of records) {
    byPid.set(record.pid, record);
    const children = byParent.get(record.ppid) ?? [];
    children.push(record.pid);
    byParent.set(record.ppid, children);
  }
  if (!byPid.has(rootPid)) throw new Error(`process tree root ${rootPid} was not visible to ps`);
  const pending = [rootPid];
  const visited = new Set<number>();
  let total = 0;
  while (pending.length) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const record = byPid.get(pid);
    if (record && !record.command.endsWith("/ps") && record.command !== "ps") total += record.rssBytes;
    pending.push(...(byParent.get(pid) ?? []));
  }
  return total;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function measureOperation<T>(operation: () => Promise<T>, sampleIntervalMs: number): Promise<MeasuredOperation<T>> {
  const rssBeforeBytes = await processTreeRss(process.pid);
  let rssPeakBytes = rssBeforeBytes;
  let sampling = true;
  let samplerError: unknown;
  const sampler = (async () => {
    while (sampling) {
      try {
        rssPeakBytes = Math.max(rssPeakBytes, await processTreeRss(process.pid));
      } catch (error) {
        samplerError = error;
        return;
      }
      await sleep(sampleIntervalMs);
    }
  })();
  const started = performance.now();
  let value!: T;
  let operationError: unknown;
  try {
    value = await operation();
  } catch (error) {
    operationError = error;
  }
  const elapsedMs = elapsed(started);
  sampling = false;
  await sampler;
  if (operationError) throw operationError;
  if (samplerError) throw samplerError;
  const rssAfterBytes = await processTreeRss(process.pid);
  rssPeakBytes = Math.max(rssPeakBytes, rssAfterBytes);
  return {
    value,
    sample: {
      elapsedMs,
      rssBeforeBytes,
      rssPeakBytes,
      rssAfterBytes,
      rssDeltaBytes: Math.max(0, rssPeakBytes - rssBeforeBytes),
    },
  };
}

function summarizeArm(samples: RssSample[], byteSize: number, sha256: string, artifactPath: string) {
  // Keep the existing scalar fields as p95 summaries while preserving every
  // sample for variance inspection and later evidence import.
  return {
    elapsedMs: nearestRank(samples.map((sample) => sample.elapsedMs), 0.95),
    rssDeltaBytes: nearestRank(samples.map((sample) => sample.rssDeltaBytes), 0.95),
    rssPeakBytes: Math.max(...samples.map((sample) => sample.rssPeakBytes)),
    byteSize,
    sha256,
    artifactPath,
    sampleCount: samples.length,
    samples,
  };
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
  const sampleCount = options.sampleCount ?? 100;
  const sampleIntervalMs = options.sampleIntervalMs ?? 5;
  if (!Number.isInteger(sampleCount) || sampleCount < 1) throw new Error("sampleCount must be a positive integer");
  if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 1) throw new Error("sampleIntervalMs must be a positive integer");
  const createdAt = options.createdAt ?? new Date("2026-08-14T00:00:00.000Z");
  const nodeSamples: RssSample[] = [];
  const nativeSamples: RssSample[] = [];
  let nodePath = "";
  let nativePath = "";
  let nodeArtifact: Awaited<ReturnType<typeof createWorkspaceBackupV2File>> | undefined;
  let nativeArtifact: Awaited<ReturnType<typeof createWorkspaceBackupV2Native>> | undefined;
  let nodeIndex: WorkspaceBackupV2ArchiveIndex | undefined;
  let nativeIndex: WorkspaceBackupV2ArchiveIndex | undefined;
  for (let index = 0; index < sampleCount; index += 1) {
    const finalSample = index === sampleCount - 1;
    nodePath = finalSample ? path.join(outputDir, "node.zip") : path.join(outputDir, `.node-${index}.zip`);
    nativePath = finalSample ? path.join(outputDir, "native.zip") : path.join(outputDir, `.native-${index}.zip`);
    const measuredNode = await measureOperation(
      () => createWorkspaceBackupV2File({ rootPath, orgId: "ab-org", instanceId: "ab-instance", artifactPath: nodePath, createdAt }),
      sampleIntervalMs,
    );
    nodeArtifact = measuredNode.value;
    nodeSamples.push(measuredNode.sample);
    const measuredNative = await measureOperation(async () => {
      const previousBinary = process.env.RUDDER_NATIVE_ARCHIVE_PATH;
      process.env.RUDDER_NATIVE_ARCHIVE_PATH = nativeBinary;
      try {
        return await createWorkspaceBackupV2Native({ rootPath, orgId: "ab-org", instanceId: "ab-instance", artifactPath: nativePath, createdAt });
      } finally {
        if (previousBinary === undefined) delete process.env.RUDDER_NATIVE_ARCHIVE_PATH;
        else process.env.RUDDER_NATIVE_ARCHIVE_PATH = previousBinary;
      }
    }, sampleIntervalMs);
    nativeArtifact = measuredNative.value;
    nativeSamples.push(measuredNative.sample);
    if (index === 0) {
      nodeIndex = await inspectWorkspaceBackupV2File(nodePath);
      nativeIndex = await inspectWorkspaceBackupV2File(nativePath);
      await inspectAndCompare(rootPath, nodePath, nativePath, nodeIndex, nativeIndex);
    }
    if (!finalSample) await Promise.all([rm(nodePath, { force: true }), rm(nativePath, { force: true })]);
  }
  if (!nodeArtifact || !nativeArtifact || !nodeIndex || !nativeIndex) throw new Error("comparator produced no samples");
  const [nodeSha256, nativeSha256, nodeStat, nativeStat] = await Promise.all([
    sha256File(nodePath), sha256File(nativePath), stat(nodePath), stat(nativePath),
  ]);
  await Promise.all([
    execFileAsync("unzip", ["-t", nodePath]),
    execFileAsync("unzip", ["-t", nativePath]),
  ]);
  const recovery = {
    node: await recoveryProbe("node", rootPath, path.join(outputDir, "node-race.zip"), createdAt, nativeBinary),
    native: await recoveryProbe("native", rootPath, path.join(outputDir, "native-race.zip"), createdAt, nativeBinary),
  };
  assert.equal(recovery.node.rejected, true);
  assert.equal(recovery.native.rejected, true);
  assert.equal(recovery.node.sentinelPreserved, true);
  assert.equal(recovery.native.sentinelPreserved, true);
  assert.deepEqual(recovery.node.temporaryArtifacts, []);
  assert.deepEqual(recovery.native.temporaryArtifacts, []);
  const nodeResult = summarizeArm(nodeSamples, nodeStat.size, nodeSha256, nodePath);
  const nativeResult = summarizeArm(nativeSamples, nativeStat.size, nativeSha256, nativePath);
  return {
    rootPath: path.resolve(rootPath),
    fileCount: nodeArtifact.fileCount,
    byteSize: nodeArtifact.byteSize,
    sampleCount,
    rssScope: "process-tree",
    manifestParity: JSON.stringify(nodeIndex.manifest) === JSON.stringify(nativeIndex.manifest),
    entryParity: nodeIndex.entries.size === nativeIndex.entries.size,
    contentParity: true,
    archiveByteParity: "not_compared",
    node: nodeResult,
    native: nativeResult,
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
