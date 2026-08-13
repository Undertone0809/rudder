import type { LocalAppBenchmarkArm, LocalAppBenchmarkObservation } from "./local-app-native-ab.helpers.js";

export type NativeAbStatus = "pass" | "fail" | "not_comparable";

export type NativeAbSummaryRow = LocalAppBenchmarkObservation & {
  warmup?: boolean;
  samplerCadence?: {
    comparable: boolean;
    errors: string[];
  };
};

export type NativeAbSummary = {
  schemaVersion: 1;
  kind: "rudder_native_ab_summary";
  benchmarkId: string;
  setId: string;
  candidateRef: string;
  runtimeType: string;
  caseIds: [string];
  arms: ["node_baseline", "rust_candidate"];
  trials: [1, 2, 3];
  nativeIdentity: Record<string, unknown>;
  workload: Record<string, unknown>;
  config: Record<string, unknown>;
  observations: Array<{
    caseId: string;
    arm: LocalAppBenchmarkArm;
    trial: 1 | 2 | 3;
    status: NativeAbStatus;
    explanation: string;
    evidence: Record<string, unknown>;
  }>;
};

const ARMS: ["node_baseline", "rust_candidate"] = ["node_baseline", "rust_candidate"];
const TRIALS: [1, 2, 3] = [1, 2, 3];

function statusFor(row: NativeAbSummaryRow): NativeAbStatus {
  if (!row.correctnessPassed) return "fail";
  if (row.samplerCadence && !row.samplerCadence.comparable) return "not_comparable";
  return "pass";
}

function evidenceFor(row: NativeAbSummaryRow): Record<string, unknown> {
  return {
    block: row.block,
    order: row.order,
    correctnessPassed: row.correctnessPassed,
    readyMs: row.readyMs,
    stopAdmissionMs: row.stopAdmissionMs,
    terminalCleanupMs: row.terminalCleanupMs,
    peakTreeRssBytes: row.peakTreeRssBytes,
    idleAdjustedPeakTreeRssBytes: row.idleAdjustedPeakTreeRssBytes,
    treeCpuMs: row.treeCpuMs,
    eventLoopDelayP95Ms: row.eventLoopDelayP95Ms,
    responseBytes: row.responseBytes,
    logBytes: row.logBytes,
    samplerCadence: row.samplerCadence ?? null,
  };
}

/** Convert validated measured operations into the importer-owned three-trial contract. */
export function buildNativeAbSummary(input: {
  candidateRef: string;
  nativeIdentity: Record<string, unknown>;
  workload: Record<string, unknown>;
  config?: Record<string, unknown>;
  measured: NativeAbSummaryRow[];
}): NativeAbSummary {
  if (!input.candidateRef.trim()) throw new Error("native A/B candidateRef is required");
  const rows = new Map<string, NativeAbSummaryRow>();
  for (const row of input.measured) {
    if (row.warmup) continue;
    if (row.block < 0 || row.block > 2) continue;
    rows.set(`${row.block}:${row.arm}`, row);
  }
  const observations = TRIALS.flatMap((trial) => ARMS.map((arm) => {
    const row = rows.get(`${trial - 1}:${arm}`);
    if (!row) throw new Error(`native A/B formal trial ${trial}/${arm} is missing`);
    const status = statusFor(row);
    const explanation = status === "pass"
      ? "Local App operation passed correctness and sampler comparability gates"
      : status === "not_comparable"
        ? `Local App operation was correct but sampler evidence was not comparable: ${row.samplerCadence?.errors.join(", ") || "unknown"}`
        : "Local App operation failed its correctness gate";
    return {
      caseId: "local_app_process_host",
      arm,
      trial,
      status,
      explanation,
      evidence: evidenceFor(row),
    };
  }));
  return {
    schemaVersion: 1,
    kind: "rudder_native_ab_summary",
    benchmarkId: "rudder-local-app-native-ab",
    setId: "rudder-local-app-native-ab-v1",
    candidateRef: input.candidateRef,
    runtimeType: "local_app_native_ab_fixture",
    caseIds: ["local_app_process_host"],
    arms: ARMS,
    trials: TRIALS,
    nativeIdentity: input.nativeIdentity,
    workload: { ...input.workload, trials: 3 },
    config: input.config ?? {},
    observations,
  };
}
