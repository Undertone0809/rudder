import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  assessSamplerCadence,
  distribution,
  pairedP95Improvement,
  seededArmOrders,
  validateLocalAppBenchmarkObservations,
  type LocalAppBenchmarkArm,
  type LocalAppBenchmarkObservation,
} from "./local-app-native-ab.helpers.js";

type ProcessRow = { pid: number; ppid: number; name: string; rssBytes: number; cpuNs: string };
type SamplerRow = {
  type: "ready" | "sample" | "error";
  source?: string;
  intervalMs?: number;
  sampleDurationNs?: string;
  interSampleGapNs?: string | null;
  treeRssBytes?: number;
  treeCpuNs?: string;
  processes?: ProcessRow[];
  message?: string;
};
type WorkerResult = {
  type: "result";
  startEpochMs: number;
  readyMs: number;
  stopAdmissionMs: number | null;
  terminalCleanupMs: number;
  eventLoopDelayP95Ms: number;
  responseBytes: number;
  logBytes: number;
  heapUsedBeforeBytes: number;
  heapUsedAfterBytes: number;
  httpStatus: number;
  descriptorCleared: boolean;
  portClosed: boolean;
  correctnessPassed: boolean;
};
type RawObservation = LocalAppBenchmarkObservation & Omit<WorkerResult, "type" | "stopAdmissionMs"> & {
  warmup: boolean;
  stopFrameType: "stop-accepted";
  rssSamples: SamplerRow[];
  idleTreeRssBytes: number;
  samplerCadence: ReturnType<typeof assessSamplerCadence>;
  peakRssByProcessName: Record<string, number>;
};

const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturePath = path.join(repositoryRoot, "desktop/src/fixtures/local-app-http-fixture.mjs");
const floodFixturePath = path.join(repositoryRoot, "desktop/src/fixtures/local-app-http-flood-fixture.mjs");
const workerPath = path.join(repositoryRoot, "scripts/perf/local-app-native-ab.worker.ts");
const tsxPath = path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs");

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}`);
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return (await runCommandBytes(command, args)).toString("utf8").trim();
}

async function runCommandBytes(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(Buffer.concat(stdout))
      : reject(new Error(`${command} failed: ${Buffer.concat(stderr).toString("utf8")}`)));
  });
}

async function candidateFingerprint(): Promise<{ sha256: string; untrackedFiles: string[] }> {
  const trackedDiff = await runCommandBytes("git", ["diff", "--binary", "HEAD"]);
  const untracked = (await runCommand("git", ["ls-files", "--others", "--exclude-standard"]))
    .split("\n").filter(Boolean).sort();
  const hash = createHash("sha256").update(trackedDiff);
  for (const relativePath of untracked) {
    hash.update(`\0${relativePath}\0`).update(await readFile(path.join(repositoryRoot, relativePath)));
  }
  return { sha256: hash.digest("hex"), untrackedFiles: untracked };
}

async function runOperation(input: {
  arm: LocalAppBenchmarkArm;
  block: number;
  order: number;
  warmup: boolean;
  root: string;
  rustHostPath: string;
  samplerPath: string;
  intervalMs: number;
  fixturePath: string;
  expectedBody: string;
  pressureMs: number;
}): Promise<RawObservation> {
  const bounded = <T>(promise: Promise<T>, label: string, milliseconds = 15_000) => new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    void promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
  const operationRoot = path.join(input.root, `${input.warmup ? "warmup" : "block"}-${input.block}-${input.order}-${input.arm}`);
  const worker = spawn(process.execPath, [tsxPath, workerPath,
    "--arm", input.arm,
    "--root", operationRoot,
    "--fixture", input.fixturePath,
    "--expected-body", input.expectedBody,
    "--pressure-ms", String(input.pressureMs),
    "--rust-host", input.rustHostPath,
  ], { cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"] });
  const workerErrors: Buffer[] = [];
  worker.stderr.on("data", (chunk: Buffer) => workerErrors.push(chunk));
  const workerLines = createInterface({ input: worker.stdout });
  const workerReady = new Promise<number>((resolve, reject) => {
    workerLines.on("line", (line) => {
      try {
        const row = JSON.parse(line) as { type?: string; pid?: number };
        if (row.type === "ready" && Number.isInteger(row.pid)) resolve(row.pid!);
      } catch (error) {
        reject(error);
      }
    });
  });
  const workerPid = await bounded(workerReady, "worker readiness");
  const samples: SamplerRow[] = [];
  const sampler = spawn(input.samplerPath, [String(workerPid), String(input.intervalMs)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const samplerErrors: Buffer[] = [];
  sampler.stderr.on("data", (chunk: Buffer) => samplerErrors.push(chunk));
  const samplerLines = createInterface({ input: sampler.stdout });
  const samplerReady = new Promise<SamplerRow>((resolve, reject) => {
    samplerLines.on("line", (line) => {
      try {
        const row = JSON.parse(line) as SamplerRow;
        if (row.type === "ready") resolve(row);
        else if (row.type === "sample") samples.push(row);
        else if (row.type === "error") reject(new Error(row.message ?? "sampler failed"));
      } catch (error) {
        reject(error);
      }
    });
    sampler.once("error", reject);
    sampler.once("exit", (code) => reject(new Error(
      `sampler exited before readiness (${code}): ${Buffer.concat(samplerErrors).toString("utf8")}`,
    )));
  });
  await bounded(samplerReady, "sampler readiness");
  while (samples.length === 0) await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
  const resultPromise = new Promise<WorkerResult>((resolve, reject) => {
    workerLines.on("line", (line) => {
      try {
        const row = JSON.parse(line) as WorkerResult;
        if (row.type === "result") resolve(row);
      } catch (error) {
        reject(error);
      }
    });
  });
  worker.stdin.write("go\n");
  worker.stdin.end();
  const result = await bounded(resultPromise, "worker result");
  const workerExit = await bounded(new Promise<number | null>((resolve) => worker.once("exit", resolve)), "worker exit");
  sampler.stdin.write("stop\n");
  sampler.stdin.end();
  const samplerExit = await bounded(new Promise<number | null>((resolve) => sampler.once("exit", resolve)), "sampler exit");
  if (workerExit !== 0) throw new Error(`worker failed (${workerExit}): ${Buffer.concat(workerErrors).toString("utf8")}`);
  if (samplerExit !== 0) throw new Error(`sampler failed (${samplerExit}): ${Buffer.concat(samplerErrors).toString("utf8")}`);
  if (result.stopAdmissionMs === null) throw new Error(`${input.arm} did not emit Stop admission evidence`);
  const { type: _transportType, ...observationResult } = result;
  if (_transportType !== "result") throw new Error(`unexpected worker transport type: ${_transportType}`);

  const peakTreeRssBytes = Math.max(0, ...samples.map((sample) => sample.treeRssBytes ?? 0));
  const idleTreeRssBytes = samples[0]?.treeRssBytes ?? 0;
  const cpu = samples.map((sample) => BigInt(sample.treeCpuNs ?? "0"));
  const treeCpuMs = cpu.length < 2 ? 0 : Number(
    cpu.reduce((maximum, value) => value > maximum ? value : maximum)
      - cpu.reduce((minimum, value) => value < minimum ? value : minimum),
  ) / 1e6;
  const peakRssByProcessName: Record<string, number> = {};
  for (const sample of samples) for (const item of sample.processes ?? []) {
    peakRssByProcessName[item.name || "(unnamed)"] = Math.max(
      peakRssByProcessName[item.name || "(unnamed)"] ?? 0,
      item.rssBytes,
    );
  }
  return {
    block: input.block,
    arm: input.arm,
    order: input.order,
    warmup: input.warmup,
    ...observationResult,
    stopAdmissionMs: result.stopAdmissionMs,
    peakTreeRssBytes,
    idleAdjustedPeakTreeRssBytes: Math.max(0, peakTreeRssBytes - idleTreeRssBytes),
    treeCpuMs,
    idleTreeRssBytes,
    stopFrameType: "stop-accepted",
    rssSamples: samples,
    samplerCadence: assessSamplerCadence(samples, input.intervalMs),
    peakRssByProcessName,
  };
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Benchmark requires macOS arm64");
  const rustHostPath = path.resolve(argument("--rust-host", path.join(repositoryRoot, "native/target/release/rudder-process-host")));
  const samplerPath = path.resolve(argument("--sampler", path.join(repositoryRoot, "native/target/release/rudder-process-tree-sampler")));
  const outputPath = path.resolve(argument("--output"));
  const seed = Number.parseInt(argument("--seed", "20260812"), 10);
  const warmups = Number.parseInt(argument("--warmups", "3"), 10);
  const blocks = Number.parseInt(argument("--blocks", "100"), 10);
  const intervalMs = Number.parseInt(argument("--sample-interval-ms", "10"), 10);
  const workload = argument("--workload", "normal");
  if (workload !== "normal" && workload !== "flood") throw new Error("Invalid workload");
  const selectedFixturePath = workload === "flood" ? floodFixturePath : fixturePath;
  const expectedBody = workload === "flood"
    ? "Rudder Local App flood fixture"
    : "Rudder harmless Local App fixture";
  const pressureMs = workload === "flood" ? 250 : 0;
  if (![seed, warmups, blocks, intervalMs].every(Number.isInteger) || warmups < 3 || blocks < 1 || intervalMs < 5) {
    throw new Error("Invalid benchmark configuration");
  }
  const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-native-ab-"));
  try {
    const raw: RawObservation[] = [];
    const run = async (arm: LocalAppBenchmarkArm, block: number, order: number, warmup: boolean) => {
      const observation = await runOperation({
        arm,
        block,
        order,
        warmup,
        root,
        rustHostPath,
        samplerPath,
        intervalMs,
        fixturePath: selectedFixturePath,
        expectedBody,
        pressureMs,
      });
      raw.push(observation);
      if (!observation.correctnessPassed) throw new Error(`${arm} correctness gate failed in block ${block}`);
    };
    const warmupOrders = seededArmOrders(seed ^ 0x51a7, warmups);
    for (let index = 0; index < warmups; index += 1) {
      for (const [order, arm] of warmupOrders[index]!.entries()) await run(arm, -(index + 1), order, true);
    }
    const orders = seededArmOrders(seed, blocks);
    for (let block = 0; block < blocks; block += 1) {
      for (const [order, arm] of orders[block]!.entries()) await run(arm, block, order, false);
    }
    const measured = raw.filter((row) => !row.warmup);
    const observationErrors = validateLocalAppBenchmarkObservations(measured, blocks);
    if (observationErrors.length > 0) throw new Error(`Benchmark evidence is invalid: ${observationErrors.join(",")}`);
    if (workload === "flood" && measured.some((row) => row.stopAdmissionMs >= 250)) {
      throw new Error("Flood Stop admission exceeded 250 ms");
    }
    const samplerFailures = measured.flatMap((row) => row.samplerCadence.errors.map((error) => ({
      block: row.block,
      arm: row.arm,
      error,
    })));
    const comparable = samplerFailures.length === 0;
    const metrics = ["readyMs", "stopAdmissionMs", "terminalCleanupMs", "peakTreeRssBytes", "idleAdjustedPeakTreeRssBytes", "treeCpuMs", "eventLoopDelayP95Ms", "responseBytes", "logBytes", "heapUsedBeforeBytes", "heapUsedAfterBytes", "idleTreeRssBytes"] as const;
    const summaries = Object.fromEntries(((["node_baseline", "rust_candidate"] as const).map((arm) => [
      arm,
      Object.fromEntries(metrics.map((metric) => [metric, distribution(measured.filter((row) => row.arm === arm).map((row) => row[metric]))])),
    ])));
    const promotionMetrics = ["readyMs", "stopAdmissionMs", "terminalCleanupMs", "peakTreeRssBytes", "idleAdjustedPeakTreeRssBytes"] as const;
    const paired = comparable
      ? Object.fromEntries(promotionMetrics.map((metric, index) => [metric, pairedP95Improvement(measured, metric, seed ^ (index + 1))]))
      : null;
    const dirtyIdentity = await candidateFingerprint();
    const hostStat = await stat(rustHostPath);
    const samplerStat = await stat(samplerPath);
    const watchdogPath = path.join(repositoryRoot, "desktop/src/local-app-watchdog-runner.mjs");
    const result = {
      schemaVersion: 3,
      kind: "rudder_local_app_native_ab",
      generatedAt: new Date().toISOString(),
      identity: {
        rudderOssCommit: await runCommand("git", ["rev-parse", "HEAD"]),
        dirtyDiffSha256: dirtyIdentity.sha256,
        untrackedFiles: dirtyIdentity.untrackedFiles,
        nodeComparator: { path: "desktop/src/local-app-watchdog-runner.mjs", sha256: await sha256(watchdogPath), incrementalPackageBytes: (await stat(watchdogPath)).size, runtime: process.version, authority: "typed watchdog Stop with backend stop-accepted acknowledgement and bounded parent fallback after watchdog exit" },
        rustActivation: { useNativeProcessHost: true },
        rustBinary: { path: rustHostPath, sha256: await sha256(rustHostPath), bytes: hostStat.size, target: "aarch64-apple-darwin", profile: "release", protocol: "1.0" },
        samplerBinary: { path: samplerPath, sha256: await sha256(samplerPath), bytes: samplerStat.size },
        sampler: { intervalMs, source: "proc_listchildpids+PROC_PIDTBSDINFO+PROC_PIDTASKINFO", scope: "isolated operation worker and descendants", idleSampleBeforeGo: true },
        machine: { platform: process.platform, arch: process.arch, release: await runCommand("uname", ["-r"]), cpu: await runCommand("sysctl", ["-n", "machdep.cpu.brand_string"]) },
        workload: { name: workload, fixturePath: selectedFixturePath, fixtureSha256: await sha256(selectedFixturePath), expectedBody, pressureMs, nominalFloodBytesPerSecond: workload === "flood" ? 10 * 1024 * 1000 : 0, workerPath, workerSha256: await sha256(workerPath), warmups, measuredBlocks: blocks, seed, armOrders: orders, cacheState: "cold-worker-cold-local-app-generation", concurrency: 1 },
      },
      correctness: { passed: measured.every((row) => row.correctnessPassed), failures: measured.filter((row) => !row.correctnessPassed).length },
      comparability: {
        status: comparable ? "comparable" : "not_comparable",
        passed: comparable,
        failures: samplerFailures,
      },
      summaries,
      pairedP95NodeRelativeImprovement: paired,
      samplerCalibration: {
        observations: raw.length,
        samples: raw.flatMap((row) => row.rssSamples).length,
        measuredFailures: samplerFailures,
        gapMs: distribution(raw.flatMap((row) => row.rssSamples.flatMap((sample) => sample.interSampleGapNs == null
          ? []
          : [Number(BigInt(sample.interSampleGapNs)) / 1e6]))),
        durationMs: distribution(raw.flatMap((row) => row.rssSamples).map((row) => Number(BigInt(row.sampleDurationNs ?? "0")) / 1e6)),
      },
      rawObservations: raw,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ outputPath, correctness: result.correctness, comparability: result.comparability, summaries, paired }, null, 2)}\n`);
    if (!comparable) process.exitCode = 3;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
