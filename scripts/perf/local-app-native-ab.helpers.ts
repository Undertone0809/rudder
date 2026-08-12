export type LocalAppBenchmarkArm = "node_baseline" | "rust_candidate";

export type LocalAppBenchmarkObservation = {
  block: number;
  arm: LocalAppBenchmarkArm;
  order: number;
  readyMs: number;
  stopAdmissionMs: number;
  terminalCleanupMs: number;
  peakTreeRssBytes: number;
  idleAdjustedPeakTreeRssBytes: number;
  treeCpuMs: number;
  eventLoopDelayP95Ms: number;
  responseBytes: number;
  logBytes: number;
  correctnessPassed: boolean;
};

export type SamplerCadenceSample = {
  interSampleGapNs?: string | null;
  sampleDurationNs?: string;
};

export type SamplerCadenceAssessment = {
  comparable: boolean;
  errors: string[];
  sampleCount: number;
  gapCount: number;
  slowGapCount: number;
  slowGapFraction: number;
  gapMs: ReturnType<typeof distribution>;
  durationMs: ReturnType<typeof distribution>;
  thresholds: {
    minimumSamples: number;
    slowGapMs: number;
    maximumSlowGapFraction: number;
    maximumGapMs: number;
    maximumDurationMs: number;
  };
};

export function seededArmOrders(seed: number, blocks: number): LocalAppBenchmarkArm[][] {
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  return Array.from({ length: blocks }, () => random() < 0.5
    ? ["node_baseline", "rust_candidate"]
    : ["rust_candidate", "node_baseline"]);
}

function nearestRank(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!;
}

export function distribution(values: number[]) {
  return {
    count: values.length,
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

export function assessSamplerCadence(
  samples: SamplerCadenceSample[],
  intervalMs: number,
): SamplerCadenceAssessment {
  const minimumSamples = 3;
  const slowGapMs = intervalMs * 2;
  const maximumSlowGapFraction = 0.01;
  const maximumGapMs = intervalMs * 4;
  const maximumDurationMs = intervalMs * 2;
  const gaps = samples.flatMap((sample) => sample.interSampleGapNs == null
    ? []
    : [Number(BigInt(sample.interSampleGapNs)) / 1e6]);
  const durations = samples.map((sample) => Number(BigInt(sample.sampleDurationNs ?? "0")) / 1e6);
  const slowGapCount = gaps.filter((gap) => gap > slowGapMs).length;
  const slowGapFraction = gaps.length === 0 ? 1 : slowGapCount / gaps.length;
  const errors: string[] = [];
  if (samples.length < minimumSamples) errors.push("insufficient_samples");
  if (gaps.length !== Math.max(0, samples.length - 1)) errors.push("missing_inter_sample_gap");
  if (slowGapFraction > maximumSlowGapFraction) errors.push("excessive_slow_gap_fraction");
  if (gaps.some((gap) => gap > maximumGapMs)) errors.push("maximum_gap_exceeded");
  if (durations.some((duration) => duration > maximumDurationMs)) errors.push("observer_overhead_exceeded");
  return {
    comparable: errors.length === 0,
    errors,
    sampleCount: samples.length,
    gapCount: gaps.length,
    slowGapCount,
    slowGapFraction,
    gapMs: distribution(gaps),
    durationMs: distribution(durations),
    thresholds: {
      minimumSamples,
      slowGapMs,
      maximumSlowGapFraction,
      maximumGapMs,
      maximumDurationMs,
    },
  };
}

function improvementPercent(nodeValue: number, rustValue: number): number {
  return nodeValue === 0 ? 0 : ((nodeValue - rustValue) / nodeValue) * 100;
}

export function pairedP95Improvement(
  observations: LocalAppBenchmarkObservation[],
  metric: "readyMs" | "stopAdmissionMs" | "terminalCleanupMs" | "peakTreeRssBytes" | "idleAdjustedPeakTreeRssBytes",
  seed: number,
  resamples = 10_000,
) {
  const pairs = new Map<number, Partial<Record<LocalAppBenchmarkArm, LocalAppBenchmarkObservation>>>();
  for (const observation of observations) {
    const pair = pairs.get(observation.block) ?? {};
    pair[observation.arm] = observation;
    pairs.set(observation.block, pair);
  }
  const complete = [...pairs.values()].filter((pair): pair is Record<LocalAppBenchmarkArm, LocalAppBenchmarkObservation> =>
    Boolean(pair.node_baseline && pair.rust_candidate));
  if (complete.length === 0) throw new Error("No complete Local App benchmark pairs");

  const point = improvementPercent(
    nearestRank(complete.map((pair) => pair.node_baseline[metric]), 0.95),
    nearestRank(complete.map((pair) => pair.rust_candidate[metric]), 0.95),
  );
  let state = seed >>> 0;
  const randomIndex = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((state / 0x1_0000_0000) * complete.length);
  };
  const bootstrap = Array.from({ length: resamples }, () => {
    const sample = Array.from({ length: complete.length }, () => complete[randomIndex()]!);
    return improvementPercent(
      nearestRank(sample.map((pair) => pair.node_baseline[metric]), 0.95),
      nearestRank(sample.map((pair) => pair.rust_candidate[metric]), 0.95),
    );
  }).sort((left, right) => left - right);

  return {
    pointPercent: point,
    ci95Percent: [
      nearestRank(bootstrap, 0.025),
      nearestRank(bootstrap, 0.975),
    ],
  };
}

export function validateLocalAppBenchmarkObservations(
  observations: LocalAppBenchmarkObservation[],
  measuredBlocks: number,
): string[] {
  const errors: string[] = [];
  const measured = observations.filter((row) => !("warmup" in row) || !(row as { warmup?: boolean }).warmup);
  const byBlock = new Map<number, LocalAppBenchmarkObservation[]>();
  for (const row of measured) {
    if (!Number.isInteger(row.block) || row.block < 0 || row.block >= measuredBlocks) errors.push("invalid_block");
    if (![row.readyMs, row.stopAdmissionMs, row.terminalCleanupMs, row.peakTreeRssBytes,
      row.idleAdjustedPeakTreeRssBytes,
      row.treeCpuMs, row.eventLoopDelayP95Ms, row.responseBytes, row.logBytes]
      .every((value) => Number.isFinite(value) && value >= 0)) errors.push("invalid_metric");
    if (!row.correctnessPassed) errors.push("correctness_failed");
    const rows = byBlock.get(row.block) ?? [];
    rows.push(row);
    byBlock.set(row.block, rows);
  }
  if (measured.length !== measuredBlocks * 2) errors.push("wrong_observation_count");
  for (let block = 0; block < measuredBlocks; block += 1) {
    const rows = byBlock.get(block) ?? [];
    if (rows.length !== 2
      || new Set(rows.map((row) => row.arm)).size !== 2
      || new Set(rows.map((row) => row.order)).size !== 2) errors.push("incomplete_pair");
  }
  return [...new Set(errors)];
}
