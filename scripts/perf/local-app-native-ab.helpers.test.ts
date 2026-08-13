import { describe, expect, it } from "vitest";
import {
  assessSamplerCadence,
  distribution,
  pairedP95Improvement,
  seededArmOrders,
  validateLocalAppBenchmarkObservations,
  type LocalAppBenchmarkObservation,
} from "./local-app-native-ab.helpers.js";
import { buildNativeAbSummary } from "./local-app-native-ab.summary.js";

describe("Local App native A/B benchmark helpers", () => {
  it("generates deterministic counterbalanced arm orders", () => {
    expect(seededArmOrders(42, 8)).toEqual(seededArmOrders(42, 8));
    expect(seededArmOrders(42, 8)).not.toEqual(seededArmOrders(43, 8));
    expect(seededArmOrders(42, 8).every((order) => new Set(order).size === 2)).toBe(true);
  });

  it("uses nearest-rank distributions", () => {
    expect(distribution(Array.from({ length: 100 }, (_, index) => index + 1))).toEqual({
      count: 100,
      p50: 50,
      p95: 95,
      max: 100,
    });
  });

  it("bootstraps complete paired blocks and reports Node-relative improvement", () => {
    const observations: LocalAppBenchmarkObservation[] = Array.from({ length: 100 }, (_, block) => [
      { block, arm: "node_baseline" as const, order: 0, readyMs: 100, stopAdmissionMs: 20, terminalCleanupMs: 100, peakTreeRssBytes: 200, idleAdjustedPeakTreeRssBytes: 100, treeCpuMs: 10, eventLoopDelayP95Ms: 1, responseBytes: 1, logBytes: 1, correctnessPassed: true },
      { block, arm: "rust_candidate" as const, order: 1, readyMs: 80, stopAdmissionMs: 10, terminalCleanupMs: 80, peakTreeRssBytes: 100, idleAdjustedPeakTreeRssBytes: 50, treeCpuMs: 5, eventLoopDelayP95Ms: 1, responseBytes: 1, logBytes: 1, correctnessPassed: true },
    ]).flat();
    expect(pairedP95Improvement(observations, "readyMs", 7, 200)).toEqual({
      pointPercent: 20,
      ci95Percent: [20, 20],
    });
  });

  it("rejects incomplete, non-finite, and incorrect measured pairs", () => {
    const valid = [
      { block: 0, arm: "node_baseline" as const, order: 0, readyMs: 1, stopAdmissionMs: 1, terminalCleanupMs: 1, peakTreeRssBytes: 1, idleAdjustedPeakTreeRssBytes: 1, treeCpuMs: 1, eventLoopDelayP95Ms: 1, responseBytes: 1, logBytes: 1, correctnessPassed: true },
      { block: 0, arm: "rust_candidate" as const, order: 1, readyMs: 1, stopAdmissionMs: 1, terminalCleanupMs: 1, peakTreeRssBytes: 1, idleAdjustedPeakTreeRssBytes: 1, treeCpuMs: 1, eventLoopDelayP95Ms: 1, responseBytes: 1, logBytes: 1, correctnessPassed: true },
    ];
    expect(validateLocalAppBenchmarkObservations(valid, 1)).toEqual([]);
    expect(validateLocalAppBenchmarkObservations([
      { ...valid[0]!, readyMs: Number.POSITIVE_INFINITY, correctnessPassed: false },
    ], 1)).toEqual(["invalid_metric", "correctness_failed", "wrong_observation_count", "incomplete_pair"]);
  });

  it("fails closed when sampler cadence or observer overhead can hide a peak", () => {
    const healthy = [null, "10000000", "10000000"].map((gap) => ({
      interSampleGapNs: gap,
      sampleDurationNs: "1000000",
    }));
    expect(assessSamplerCadence(healthy, 10)).toMatchObject({ comparable: true, errors: [] });
    expect(assessSamplerCadence([
      ...healthy,
      { interSampleGapNs: "50000000", sampleDurationNs: "25000000" },
    ], 10)).toMatchObject({
      comparable: false,
      errors: ["excessive_slow_gap_fraction", "maximum_gap_exceeded", "observer_overhead_exceeded"],
    });
  });

  it("emits exactly three importer-owned formal trials per arm", () => {
    const row = (block: number, arm: LocalAppBenchmarkObservation["arm"]) => ({
      block,
      arm,
      order: arm === "node_baseline" ? 0 : 1,
      readyMs: 1,
      stopAdmissionMs: 1,
      terminalCleanupMs: 1,
      peakTreeRssBytes: 1,
      idleAdjustedPeakTreeRssBytes: 1,
      treeCpuMs: 1,
      eventLoopDelayP95Ms: 1,
      responseBytes: 1,
      logBytes: 1,
      correctnessPassed: true,
      samplerCadence: { comparable: true, errors: [] },
    });
    const summary = buildNativeAbSummary({
      candidateRef: "rust:test",
      nativeIdentity: { baselineRef: "node:test", candidateRef: "rust:test", workload: { trials: 3 } },
      workload: { measuredBlocks: 100 },
      measured: [0, 1, 2].flatMap((block) => [row(block, "node_baseline"), row(block, "rust_candidate")]),
    });
    expect(summary.kind).toBe("rudder_native_ab_summary");
    expect(summary.trials).toEqual([1, 2, 3]);
    expect(summary.observations).toHaveLength(6);
    expect(new Set(summary.observations.map((observation) => `${observation.arm}:${observation.trial}`)).size).toBe(6);
    expect(summary.workload.measuredBlocks).toBe(100);
  });
});
