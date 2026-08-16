import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
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
  warmupCount: number;
  operationTimeoutMs: number;
  rssScope: "process-tree";
  comparability: {
    status: "comparable" | "not_comparable";
    reason: string | null;
    failures: string[];
    requirements: {
      minimumWarmupsPerArm: number;
      minimumMeasuredSamplesPerArm: number;
      minimumBootstrapIterations: number;
    };
    evidence: {
      warmupsPerArm: number;
      measuredSamplesPerArm: { node: number; native: number };
      pairedBlocks: number;
      armOrders: BackupArm[][];
      orderCoverage: { nodeFirst: number; nativeFirst: number };
      bootstrap: {
        seed: number;
        iterations: number;
        metrics: string[];
      };
      measuredBoundaryCount: number;
      positiveMeasuredBoundaryCount: number;
    };
  };
  benchmark: {
    seed: number;
    warmupSeed: number;
    warmupCount: number;
    measuredSamples: number;
    measuredBlocks: number;
    armOrders: BackupArm[][];
    warmupArmOrders: BackupArm[][];
    bootstrapSeed: number;
    bootstrapIterations: number;
  };
  pairedP95: {
    elapsedMs: PairedP95Bootstrap;
    rssDeltaBytes: PairedP95Bootstrap;
  } | null;
  identity: {
    sourceSha: string;
    dirtyFingerprint: string;
    nativeBinary: {
      path: string;
      sha256: string;
      version: string;
      target: string;
      profile: "debug" | "release" | "unknown";
    };
    sampler: SamplerMetadata;
    fixture: {
      rootPath: string;
      fileCount: number;
      byteSize: number;
      treeSha256: string;
      contentSha256: string;
      files: Array<{ path: string; byteSize: number }>;
    };
  };
  sampler: SamplerMetadata;
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
  samplerSampleCount?: number;
  samplerOverheadMs?: number;
};

export type BackupArm = "node" | "native";
export type PairedP95Metric = "elapsedMs" | "rssDeltaBytes";

export type PairedP95Bootstrap = {
  metric: PairedP95Metric;
  completePairs: number;
  seed: number;
  iterations: number;
  nodeP95: number;
  nativeP95: number;
  pointDeltaP95: number;
  ci95DeltaP95: [number, number];
  pointNodeRelativeImprovementPercent: number;
  ci95NodeRelativeImprovementPercent: [number, number];
};

export type BackupObservation = {
  block: number;
  arm: BackupArm;
  order: number;
  warmup: boolean;
  sample: RssSample;
};

type MeasuredOperation<T> = {
  value: T;
  sample: RssSample;
  boundary: Omit<OperationBoundaryReceipt, "arm" | "sampleIndex">;
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
  warmupCount?: number;
  seed?: number;
  bootstrapIterations?: number;
  sampleIntervalMs?: number;
  operationTimeoutMs?: number;
  samplerMode?: "node-ps" | "external";
  samplerPath?: string;
};

type OperationBoundaryReceipt = {
  arm: BackupArm;
  sampleIndex: number;
  block: number;
  order: number;
  warmup: boolean;
  startRowIndex: number;
  endRowIndex: number;
  sampleCount: number;
  operationElapsedMs: number;
  positive: boolean;
};

type SamplerMetadata = {
  mode: "node-ps" | "external";
  command: string;
  path: string | null;
  version: string | null;
  protocolVersion: number | null;
  qosClass: string | null;
  intervalMs: number;
  source: string;
  sessionScope: "shared-run" | "per-operation-fallback";
  operationBoundaries: OperationBoundaryReceipt[];
  positiveBoundaryCount: number;
  overheadMs: {
    p95: number | null;
    max: number | null;
    samples: number;
  };
};

type ExternalSamplerRow = {
  type: "ready" | "sample" | "error";
  version?: string;
  protocolVersion?: number;
  qosClass?: string;
  intervalMs?: number;
  source?: string;
  treeRssBytes?: number;
  sampleDurationNs?: string;
  message?: string;
};

type ExternalSamplerSession = {
  child: ChildProcessWithoutNullStreams;
  rows: ExternalSamplerRow[];
  ready: ExternalSamplerRow;
  stderr: Buffer[];
  lines: ReturnType<typeof createInterface>;
  stopped: boolean;
};

export function nativeTargetLabel(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") {
    const targetArch = ({ arm64: "aarch64", x64: "x86_64" } as Record<string, string>)[arch] ?? arch;
    return `${targetArch}-apple-darwin`;
  }
  return `${arch}-${platform}`;
}

const MIN_WARMUPS_PER_ARM = 3;
const MIN_MEASURED_SAMPLES_PER_ARM = 100;
const MIN_BOOTSTRAP_ITERATIONS = 1_000;
const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;
const WARMUP_SEED_XOR = 0x51a7;
const BOOTSTRAP_SEED_XOR = 0xb0057a;

export function seededArmOrders(seed: number, blocks: number): BackupArm[][] {
  if (!Number.isInteger(seed)) throw new Error("seed must be an integer");
  if (!Number.isInteger(blocks) || blocks < 0) throw new Error("blocks must be a non-negative integer");
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return Array.from({ length: blocks }, () => random() < 0.5
    ? ["node", "native"]
    : ["native", "node"]);
}

function nodeRelativeImprovement(nodeP95: number, nativeP95: number) {
  return nodeP95 === 0 ? 0 : ((nodeP95 - nativeP95) / nodeP95) * 100;
}

export function pairedP95Bootstrap(
  observations: BackupObservation[],
  metric: PairedP95Metric,
  seed: number,
  iterations = DEFAULT_BOOTSTRAP_ITERATIONS,
): PairedP95Bootstrap {
  if (!Number.isInteger(seed)) throw new Error("bootstrap seed must be an integer");
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("bootstrap iterations must be a positive integer");
  const pairs = new Map<number, Partial<Record<BackupArm, BackupObservation>>>();
  for (const observation of observations.filter((row) => !row.warmup)) {
    const pair = pairs.get(observation.block) ?? {};
    if (pair[observation.arm]) throw new Error(`duplicate ${observation.arm} observation for block ${observation.block}`);
    pair[observation.arm] = observation;
    pairs.set(observation.block, pair);
  }
  const complete = [...pairs.values()].filter((pair): pair is Record<BackupArm, BackupObservation> =>
    Boolean(pair.node && pair.native));
  if (complete.length === 0) throw new Error("no complete Rust/Node benchmark pairs");
  const nodeValues = complete.map((pair) => pair.node.sample[metric]);
  const nativeValues = complete.map((pair) => pair.native.sample[metric]);
  const nodeP95 = nearestRank(nodeValues, 0.95);
  const nativeP95 = nearestRank(nativeValues, 0.95);
  let state = seed >>> 0;
  const randomIndex = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((state / 0x1_0000_0000) * complete.length);
  };
  const deltaBootstrap: number[] = [];
  const improvementBootstrap: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampledNode: number[] = [];
    const sampledNative: number[] = [];
    for (let index = 0; index < complete.length; index += 1) {
      const pair = complete[randomIndex()]!;
      sampledNode.push(pair.node.sample[metric]);
      sampledNative.push(pair.native.sample[metric]);
    }
    const sampledNodeP95 = nearestRank(sampledNode, 0.95);
    const sampledNativeP95 = nearestRank(sampledNative, 0.95);
    deltaBootstrap.push(sampledNativeP95 - sampledNodeP95);
    improvementBootstrap.push(nodeRelativeImprovement(sampledNodeP95, sampledNativeP95));
  }
  deltaBootstrap.sort((left, right) => left - right);
  improvementBootstrap.sort((left, right) => left - right);
  return {
    metric,
    completePairs: complete.length,
    seed,
    iterations,
    nodeP95,
    nativeP95,
    pointDeltaP95: nativeP95 - nodeP95,
    ci95DeltaP95: [nearestRank(deltaBootstrap, 0.025), nearestRank(deltaBootstrap, 0.975)],
    pointNodeRelativeImprovementPercent: nodeRelativeImprovement(nodeP95, nativeP95),
    ci95NodeRelativeImprovementPercent: [nearestRank(improvementBootstrap, 0.025), nearestRank(improvementBootstrap, 0.975)],
  };
}

export function assessBackupComparability(input: {
  warmupsPerArm: number;
  measuredSamplesPerArm: { node: number; native: number };
  pairedBlocks: number;
  armOrders: BackupArm[][];
  bootstrapIterations: number;
  bootstrapMetrics: PairedP95Metric[];
  measuredBoundaryCount: number;
  positiveMeasuredBoundaryCount: number;
  manifestParity: boolean;
  entryParity: boolean;
  contentParity: boolean;
  recoveryPassed: boolean;
}): { comparable: boolean; failures: string[] } {
  const failures: string[] = [];
  if (input.warmupsPerArm < MIN_WARMUPS_PER_ARM) failures.push("insufficient_warmups");
  if (input.measuredSamplesPerArm.node < MIN_MEASURED_SAMPLES_PER_ARM
    || input.measuredSamplesPerArm.native < MIN_MEASURED_SAMPLES_PER_ARM) failures.push("insufficient_measured_samples");
  if (input.pairedBlocks < MIN_MEASURED_SAMPLES_PER_ARM) failures.push("insufficient_paired_blocks");
  if (input.armOrders.length !== input.pairedBlocks) failures.push("missing_arm_orders");
  const nodeFirst = input.armOrders.filter((order) => order[0] === "node").length;
  const nativeFirst = input.armOrders.filter((order) => order[0] === "native").length;
  if (nodeFirst === 0 || nativeFirst === 0) failures.push("arm_order_not_balanced");
  if (input.armOrders.some((order) => order.length !== 2 || new Set(order).size !== 2)) failures.push("invalid_arm_order");
  if (input.bootstrapIterations < MIN_BOOTSTRAP_ITERATIONS) failures.push("insufficient_bootstrap_iterations");
  if (!input.bootstrapMetrics.includes("elapsedMs")) failures.push("missing_elapsed_bootstrap");
  if (!input.bootstrapMetrics.includes("rssDeltaBytes")) failures.push("missing_rss_bootstrap");
  if (input.measuredBoundaryCount < input.pairedBlocks * 2
    || input.positiveMeasuredBoundaryCount !== input.measuredBoundaryCount) failures.push("non_positive_sampler_boundary");
  if (!input.manifestParity) failures.push("manifest_parity_failed");
  if (!input.entryParity) failures.push("entry_parity_failed");
  if (!input.contentParity) failures.push("content_parity_failed");
  if (!input.recoveryPassed) failures.push("recovery_failed");
  return { comparable: failures.length === 0, failures: [...new Set(failures)] };
}

export function stableFixtureContentHash(entries: Array<{ path: string; kind: "directory" | "file"; byteSize: number; sha256: string | null }>) {
  const hash = crypto.createHash("sha256");
  for (const entry of [...entries].filter((item) => item.kind === "file").sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.sha256 ?? "");
    hash.update("\0");
    hash.update(String(entry.byteSize));
    hash.update("\n");
  }
  return hash.digest("hex");
}

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

function bounded<T>(promise: Promise<T>, label: string, milliseconds = 15_000) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    void promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise<number | null>((resolve) => child.once("exit", resolve));
}

async function externalSamplerVersion(samplerPath: string) {
  const { stdout } = await execFileAsync(samplerPath, ["--version"], { cwd: process.cwd() });
  return stdout.trim();
}

async function startExternalSampler(samplerPath: string, intervalMs: number): Promise<ExternalSamplerSession> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("external process-tree sampler requires macOS arm64; use samplerMode=node-ps explicitly for a local fallback");
  }
  if (!existsSync(samplerPath)) throw new Error(`external process-tree sampler is unavailable: ${samplerPath}`);
  const child = spawn(samplerPath, [String(process.pid), String(intervalMs)], { stdio: ["pipe", "pipe", "pipe"] });
  const rows: ExternalSamplerRow[] = [];
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<ExternalSamplerRow>((resolve, reject) => {
    let settled = false;
    lines.on("line", (line) => {
      try {
        const row = JSON.parse(line) as ExternalSamplerRow;
        if (row.type === "ready" && !settled) {
          settled = true;
          resolve(row);
        } else if (row.type === "sample") rows.push(row);
        else if (row.type === "error" && !settled) {
          settled = true;
          reject(new Error(row.message ?? "external process-tree sampler failed"));
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`external sampler exited before readiness (${code}): ${Buffer.concat(stderr).toString("utf8")}`));
      }
    });
  });
  const readyRow = await bounded(ready, "external sampler readiness");
  return { child, rows, ready: readyRow, stderr, lines, stopped: false };
}

async function stopExternalSampler(session: ExternalSamplerSession) {
  if (session.stopped) return;
  session.stopped = true;
  try {
    session.child.stdin.write("stop\n");
    session.child.stdin.end();
    const exitCode = await bounded(waitForExit(session.child), "external sampler exit");
    if (exitCode !== 0) throw new Error(`external sampler failed (${exitCode}): ${Buffer.concat(session.stderr).toString("utf8")}`);
  } finally {
    session.lines.close();
  }
}

async function waitForExternalSamples(session: ExternalSamplerSession, minimumRows: number, intervalMs: number) {
  if (session.rows.length >= minimumRows) return;
  await bounded((async () => {
    while (session.rows.length < minimumRows) await sleep(intervalMs);
  })(), "external sampler sample");
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

async function measureNodePsOperation<T>(
  operation: () => Promise<T>,
  sampleIntervalMs: number,
  operationTimeoutMs: number,
): Promise<MeasuredOperation<T>> {
  const rssBeforeBytes = await processTreeRss(process.pid);
  let samplerRowCount = 1;
  let rssPeakBytes = rssBeforeBytes;
  let sampling = true;
  let samplerError: unknown;
  const sampler = (async () => {
    while (sampling) {
      try {
        rssPeakBytes = Math.max(rssPeakBytes, await processTreeRss(process.pid));
        samplerRowCount += 1;
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
    value = await bounded(operation(), "workspace backup operation", operationTimeoutMs);
  } catch (error) {
    operationError = error;
  }
  const elapsedMs = elapsed(started);
  sampling = false;
  await sampler;
  if (operationError) throw operationError;
  if (samplerError) throw samplerError;
  const rssAfterBytes = await processTreeRss(process.pid);
  samplerRowCount += 1;
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
    boundary: {
      startRowIndex: 0,
      endRowIndex: Math.max(0, samplerRowCount - 1),
      sampleCount: Math.max(0, samplerRowCount - 1),
      operationElapsedMs: elapsedMs,
      positive: samplerRowCount > 1,
    },
  };
}

async function measureExternalOperation<T>(
  operation: () => Promise<T>,
  sampleIntervalMs: number,
  operationTimeoutMs: number,
  session: ExternalSamplerSession,
  arm: "node" | "native",
): Promise<MeasuredOperation<T>> {
  if (session.rows.length === 0) await waitForExternalSamples(session, 1, sampleIntervalMs);
  const startRowIndex = session.rows.length;
  const beforeRow = session.rows[startRowIndex - 1];
  const operationStart = performance.now();
  let value!: T;
  let operationError: unknown;
  try {
    value = await bounded(operation(), `${arm} workspace backup operation`, operationTimeoutMs);
  } catch (error) {
    operationError = error;
  }
  const elapsedMs = elapsed(operationStart);
  if (!operationError) await waitForExternalSamples(session, startRowIndex + 1, sampleIntervalMs);
  const endRowIndex = session.rows.length;
  const rssSamples = session.rows
    .slice(startRowIndex, endRowIndex)
    .filter((row): row is ExternalSamplerRow & { treeRssBytes: number } => Number.isFinite(row.treeRssBytes));
  if (operationError) throw operationError;
  if (rssSamples.length === 0) throw new Error("external process-tree sampler emitted no RSS samples");
  const rssBeforeBytes = Number.isFinite(beforeRow?.treeRssBytes) ? beforeRow.treeRssBytes! : rssSamples[0]!.treeRssBytes;
  const rssPeakBytes = Math.max(...rssSamples.map((row) => row.treeRssBytes));
  const rssAfterBytes = rssSamples[rssSamples.length - 1]!.treeRssBytes;
  const observerDurationsMs = rssSamples.flatMap((row) => row.sampleDurationNs == null
    ? []
    : [Number(BigInt(row.sampleDurationNs)) / 1e6]);
  return {
    value,
    sample: {
      elapsedMs,
      rssBeforeBytes,
      rssPeakBytes,
      rssAfterBytes,
      rssDeltaBytes: Math.max(0, rssPeakBytes - rssBeforeBytes),
      samplerSampleCount: rssSamples.length,
      samplerOverheadMs: observerDurationsMs.length > 0 ? nearestRank(observerDurationsMs, 0.95) : undefined,
    },
    boundary: {
      startRowIndex,
      endRowIndex,
      sampleCount: endRowIndex - startRowIndex,
      operationElapsedMs: elapsedMs,
      positive: endRowIndex > startRowIndex,
    },
  };
}

async function measureOperation<T>(
  operation: () => Promise<T>,
  sampleIntervalMs: number,
  operationTimeoutMs: number,
  samplerMode: "node-ps" | "external",
  session: ExternalSamplerSession | undefined,
  arm: "node" | "native",
): Promise<MeasuredOperation<T>> {
  return samplerMode === "external"
    ? measureExternalOperation(operation, sampleIntervalMs, operationTimeoutMs, assertSession(session), arm)
    : measureNodePsOperation(operation, sampleIntervalMs, operationTimeoutMs);
}

function assertSession(session: ExternalSamplerSession | undefined): ExternalSamplerSession {
  if (!session) throw new Error("external sampler session was not started");
  return session;
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

function assertArchiveStructureParity(
  nodeIndex: WorkspaceBackupV2ArchiveIndex,
  nativeIndex: WorkspaceBackupV2ArchiveIndex,
) {
  assert.deepEqual(nativeIndex.manifest, nodeIndex.manifest);
  assert.deepEqual(
    [...nativeIndex.entries.keys()].sort(),
    [...nodeIndex.entries.keys()].sort(),
  );
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

async function candidateIdentity(nativeBinary: string) {
  const cwd = process.cwd();
  const sourceSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  const diff = (await execFileAsync("git", ["diff", "--binary", "HEAD"], { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const untracked = (await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd })).stdout
    .split(/\r?\n/).filter(Boolean).filter((item) => !item.split("/").includes("node_modules")).sort();
  const dirtyHasher = crypto.createHash("sha256").update(diff);
  for (const relativePath of untracked) dirtyHasher.update(`\0${relativePath}\0`).update(await readFile(path.join(cwd, relativePath)));
  const binaryBytes = await readFile(nativeBinary);
  const version = (await execFileAsync(nativeBinary, ["--version"], { cwd })).stdout.trim();
  const profile = nativeBinary.split(path.sep).includes("release")
    ? "release"
    : nativeBinary.split(path.sep).includes("debug") ? "debug" : "unknown";
  return {
    sourceSha,
    dirtyFingerprint: dirtyHasher.digest("hex"),
    nativeBinary: {
      path: nativeBinary,
      sha256: crypto.createHash("sha256").update(binaryBytes).digest("hex"),
      version,
      target: nativeTargetLabel(),
      profile: profile as "debug" | "release" | "unknown",
    },
  };
}

async function samplerIdentity(
  mode: "node-ps" | "external",
  samplerPath: string,
  intervalMs: number,
): Promise<SamplerMetadata> {
  if (mode === "node-ps") {
    return {
      mode,
      command: "ps -axo pid=,ppid=,rss=,comm=",
      path: null,
      version: null,
      protocolVersion: null,
      qosClass: null,
      intervalMs,
      source: "Node child_process ps process-tree traversal (explicit fallback)",
      sessionScope: "per-operation-fallback",
      operationBoundaries: [],
      positiveBoundaryCount: 0,
      overheadMs: { p95: null, max: null, samples: 0 },
    };
  }
  const version = await externalSamplerVersion(samplerPath);
  const protocolVersion = Number((await execFileAsync(samplerPath, ["--protocol-version"], { cwd: process.cwd() })).stdout.trim());
  return {
    mode,
    command: `${samplerPath} <root-pid> <interval-ms>`,
    path: samplerPath,
    version,
    protocolVersion: Number.isFinite(protocolVersion) ? protocolVersion : null,
    qosClass: null,
    intervalMs,
    source: "proc_listchildpids+PROC_PIDTBSDINFO+PROC_PIDTASKINFO",
    sessionScope: "shared-run",
    operationBoundaries: [],
    positiveBoundaryCount: 0,
    overheadMs: { p95: null, max: null, samples: 0 },
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
  const warmupCount = options.warmupCount ?? MIN_WARMUPS_PER_ARM;
  const seed = options.seed ?? 20260816;
  const bootstrapIterations = options.bootstrapIterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const sampleIntervalMs = options.sampleIntervalMs ?? 5;
  const operationTimeoutMs = options.operationTimeoutMs ?? 120_000;
  const samplerMode = options.samplerMode ?? "node-ps";
  const samplerPath = options.samplerPath ?? path.resolve(process.cwd(), "native/target/debug/rudder-process-tree-sampler");
  if (!Number.isInteger(sampleCount) || sampleCount < 1) throw new Error("sampleCount must be a positive integer");
  if (!Number.isInteger(warmupCount) || warmupCount < 0) throw new Error("warmupCount must be a non-negative integer");
  if (!Number.isInteger(seed)) throw new Error("seed must be an integer");
  if (!Number.isInteger(bootstrapIterations) || bootstrapIterations < 1) throw new Error("bootstrapIterations must be a positive integer");
  if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 1) throw new Error("sampleIntervalMs must be a positive integer");
  if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 1) throw new Error("operationTimeoutMs must be a positive integer");
  if (samplerMode === "external" && (!existsSync(samplerPath) || process.platform !== "darwin" || process.arch !== "arm64")) {
    throw new Error(`external process-tree sampler is unavailable for this environment: ${samplerPath}`);
  }
  const createdAt = options.createdAt ?? new Date("2026-08-14T00:00:00.000Z");
  const candidate = await candidateIdentity(nativeBinary);
  const sampler = await samplerIdentity(samplerMode, samplerPath, sampleIntervalMs);
  const samplerOverheads: number[] = [];
  const nodeSamples: RssSample[] = [];
  const nativeSamples: RssSample[] = [];
  const observations: BackupObservation[] = [];
  const warmupArmOrders = seededArmOrders(seed ^ WARMUP_SEED_XOR, warmupCount);
  const armOrders = seededArmOrders(seed, sampleCount);
  let nodePath = "";
  let nativePath = "";
  let nodeArtifact: Awaited<ReturnType<typeof createWorkspaceBackupV2File>> | undefined;
  let nativeArtifact: Awaited<ReturnType<typeof createWorkspaceBackupV2Native>> | undefined;
  let nodeIndex: WorkspaceBackupV2ArchiveIndex | undefined;
  let nativeIndex: WorkspaceBackupV2ArchiveIndex | undefined;
  let manifestParity = true;
  let entryParity = true;
  let contentParity = true;
  let externalSession: ExternalSamplerSession | undefined;
  try {
    if (samplerMode === "external") {
      externalSession = await startExternalSampler(samplerPath, sampleIntervalMs);
      sampler.qosClass ??= externalSession.ready.qosClass ?? null;
      sampler.source = externalSession.ready.source ?? sampler.source;
      sampler.protocolVersion ??= externalSession.ready.protocolVersion ?? null;
      await waitForExternalSamples(externalSession, 1, sampleIntervalMs);
    }
    const runArm = async (arm: BackupArm, artifactPath: string) => {
      if (arm === "node") {
        return createWorkspaceBackupV2File({ rootPath, orgId: "ab-org", instanceId: "ab-instance", artifactPath, createdAt });
      }
      const previousBinary = process.env.RUDDER_NATIVE_ARCHIVE_PATH;
      process.env.RUDDER_NATIVE_ARCHIVE_PATH = nativeBinary;
      try {
        return await createWorkspaceBackupV2Native({ rootPath, orgId: "ab-org", instanceId: "ab-instance", artifactPath, createdAt });
      } finally {
        if (previousBinary === undefined) delete process.env.RUDDER_NATIVE_ARCHIVE_PATH;
        else process.env.RUDDER_NATIVE_ARCHIVE_PATH = previousBinary;
      }
    };
    const runTrial = async (arm: BackupArm, block: number, order: number, warmup: boolean) => {
      const artifactPath = warmup
        ? path.join(outputDir, `.warmup-${arm}-${block}-${order}.zip`)
        : block === sampleCount - 1
          ? path.join(outputDir, `${arm}.zip`)
          : path.join(outputDir, `.${arm}-${block}.zip`);
      const measured = await measureOperation(
        () => runArm(arm, artifactPath),
        sampleIntervalMs,
        operationTimeoutMs,
        samplerMode,
        externalSession,
        arm,
      );
      if (arm === "node") nodeArtifact = measured.value;
      else nativeArtifact = measured.value;
      if (measured.sample.samplerOverheadMs !== undefined) samplerOverheads.push(measured.sample.samplerOverheadMs);
      sampler.operationBoundaries.push({
        arm,
        sampleIndex: warmup ? block : block,
        block: warmup ? -(block + 1) : block,
        order,
        warmup,
        ...measured.boundary,
      });
      if (!warmup) {
        const observation = { block, arm, order, warmup, sample: measured.sample } satisfies BackupObservation;
        observations.push(observation);
        if (arm === "node") nodeSamples.push(measured.sample);
        else nativeSamples.push(measured.sample);
      }
      return { artifactPath, value: measured.value };
    };
    for (let index = 0; index < warmupCount; index += 1) {
      for (const [order, arm] of warmupArmOrders[index]!.entries()) {
        const warmup = await runTrial(arm, index, order, true);
        await rm(warmup.artifactPath, { force: true });
      }
    }
    for (let index = 0; index < sampleCount; index += 1) {
      const finalSample = index === sampleCount - 1;
      for (const [order, arm] of armOrders[index]!.entries()) {
        const trial = await runTrial(arm, index, order, false);
        if (arm === "node") nodePath = trial.artifactPath;
        else nativePath = trial.artifactPath;
      }
      const sampledNodeIndex = await inspectWorkspaceBackupV2File(nodePath);
      const sampledNativeIndex = await inspectWorkspaceBackupV2File(nativePath);
      try {
        assertArchiveStructureParity(sampledNodeIndex, sampledNativeIndex);
      } catch {
        manifestParity = false;
        entryParity = false;
        throw new Error(`Rust/Node archive structure mismatch at sample ${index}`);
      }
      nodeIndex = sampledNodeIndex;
      nativeIndex = sampledNativeIndex;
      const verifyContent = index === 0 || finalSample;
      if (verifyContent) {
        try {
          await inspectAndCompare(rootPath, nodePath, nativePath, sampledNodeIndex, sampledNativeIndex);
        } catch (error) {
          contentParity = false;
          throw error;
        }
      }
      if (!finalSample) await Promise.all([rm(nodePath, { force: true }), rm(nativePath, { force: true })]);
    }
  } finally {
    if (externalSession) await stopExternalSampler(externalSession);
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
  const recoveryPassed = [recovery.node, recovery.native].every((probe) =>
    probe.rejected && probe.sentinelPreserved && probe.temporaryArtifacts.length === 0);
  const nodeResult = summarizeArm(nodeSamples, nodeStat.size, nodeSha256, nodePath);
  const nativeResult = summarizeArm(nativeSamples, nativeStat.size, nativeSha256, nativePath);
  if (samplerOverheads.length > 0) {
    sampler.overheadMs = {
      p95: nearestRank(samplerOverheads, 0.95),
      max: Math.max(...samplerOverheads),
      samples: samplerOverheads.length,
    };
  }
  const fixtureFiles = nodeArtifact.manifest.entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => ({ path: entry.path, byteSize: entry.byteSize }));
  const fixtureContentSha256 = stableFixtureContentHash(nodeArtifact.manifest.entries);
  const measuredBoundaries = sampler.operationBoundaries.filter((boundary) => !boundary.warmup);
  const positiveMeasuredBoundaries = measuredBoundaries.filter((boundary) => boundary.positive);
  sampler.positiveBoundaryCount = positiveMeasuredBoundaries.length;
  const pairedP95 = (() => {
    try {
      return {
        elapsedMs: pairedP95Bootstrap(observations, "elapsedMs", seed ^ BOOTSTRAP_SEED_XOR, bootstrapIterations),
        rssDeltaBytes: pairedP95Bootstrap(observations, "rssDeltaBytes", (seed ^ BOOTSTRAP_SEED_XOR) + 1, bootstrapIterations),
      };
    } catch {
      return null;
    }
  })();
  const comparison = assessBackupComparability({
    warmupsPerArm: warmupCount,
    measuredSamplesPerArm: { node: nodeSamples.length, native: nativeSamples.length },
    pairedBlocks: sampleCount,
    armOrders,
    bootstrapIterations,
    bootstrapMetrics: pairedP95 ? ["elapsedMs", "rssDeltaBytes"] : [],
    measuredBoundaryCount: measuredBoundaries.length,
    positiveMeasuredBoundaryCount: positiveMeasuredBoundaries.length,
    manifestParity,
    entryParity,
    contentParity,
    recoveryPassed,
  });
  const nodeFirst = armOrders.filter((order) => order[0] === "node").length;
  const nativeFirst = armOrders.filter((order) => order[0] === "native").length;
  const bootstrapSeed = seed ^ BOOTSTRAP_SEED_XOR;
  return {
    rootPath: path.resolve(rootPath),
    fileCount: nodeArtifact.fileCount,
    byteSize: nodeArtifact.byteSize,
    sampleCount,
    warmupCount,
    operationTimeoutMs,
    rssScope: "process-tree",
    comparability: {
      status: comparison.comparable ? "comparable" : "not_comparable",
      reason: comparison.comparable ? null : comparison.failures.join(","),
      failures: comparison.failures,
      requirements: {
        minimumWarmupsPerArm: MIN_WARMUPS_PER_ARM,
        minimumMeasuredSamplesPerArm: MIN_MEASURED_SAMPLES_PER_ARM,
        minimumBootstrapIterations: MIN_BOOTSTRAP_ITERATIONS,
      },
      evidence: {
        warmupsPerArm: warmupCount,
        measuredSamplesPerArm: { node: nodeSamples.length, native: nativeSamples.length },
        pairedBlocks: sampleCount,
        armOrders,
        orderCoverage: { nodeFirst, nativeFirst },
        bootstrap: {
          seed: bootstrapSeed,
          iterations: bootstrapIterations,
          metrics: pairedP95 ? ["elapsedMs", "rssDeltaBytes"] : [],
        },
        measuredBoundaryCount: measuredBoundaries.length,
        positiveMeasuredBoundaryCount: positiveMeasuredBoundaries.length,
      },
    },
    benchmark: {
      seed,
      warmupSeed: seed ^ WARMUP_SEED_XOR,
      warmupCount,
      measuredSamples: sampleCount,
      measuredBlocks: sampleCount,
      armOrders,
      warmupArmOrders,
      bootstrapSeed,
      bootstrapIterations,
    },
    identity: {
      ...candidate,
      sampler,
      fixture: {
        rootPath: path.resolve(rootPath),
        fileCount: nodeArtifact.fileCount,
        byteSize: nodeArtifact.byteSize,
        treeSha256: nodeArtifact.manifest.treeSha256,
        contentSha256: fixtureContentSha256,
        files: fixtureFiles,
      },
    },
    sampler,
    manifestParity,
    entryParity,
    contentParity,
    archiveByteParity: "not_compared",
    pairedP95,
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
