import type { TranscriptEntry } from "@rudder/agent-runtime-utils";
import type { ObservedRunDetail, RunComparison, RunDiagnosis, RunDiagnosisMode, RunFinding, RunMetrics } from "./types.js";

function addFinding(
  target: RunFinding[],
  finding: RunFinding | null,
) {
  if (!finding) return;
  if (target.some((existing) => existing.id === finding.id)) return;
  target.push(finding);
}

function countTokens(entries: TranscriptEntry[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;

  for (const entry of entries) {
    if (entry.kind !== "result") continue;
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
    cachedTokens += entry.cachedTokens;
  }

  return { inputTokens, outputTokens, cachedTokens };
}

function summarizeIssue(detail: ObservedRunDetail) {
  if (!detail.issue) return "No linked issue";
  return detail.issue.identifier ? `${detail.issue.identifier} ${detail.issue.title ?? ""}`.trim() : detail.issue.title ?? detail.issue.id;
}

function inferFailureTaxonomy(detail: ObservedRunDetail): string {
  const errorText = [
    detail.run.error ?? "",
    detail.run.errorCode ?? "",
    detail.run.stderrExcerpt ?? "",
    ...detail.events.map((event) => event.message ?? ""),
  ].join("\n");

  if (detail.run.status === "timed_out") return "timeout";
  if (/permission denied/i.test(errorText)) return "permission_denied";
  if (/could not read username|authentication failed|401|403/i.test(errorText)) return "auth_or_git_failure";
  if (/cannot find module|module not found|command not found|no such file/i.test(errorText)) return "dependency_or_boot_failure";
  if (/connection refused|econnrefused|network/i.test(errorText)) return "network_dependency_failure";
  if (/detached|process_lost|orphan/i.test(errorText)) return "runtime_process_failure";
  if (detail.run.status === "failed") return "run_failed_unknown";
  if (detail.run.status === "cancelled") return "cancelled";
  return "healthy_or_unknown";
}

function computeMetrics(detail: ObservedRunDetail): RunMetrics {
  const { inputTokens: transcriptInputTokens, outputTokens: transcriptOutputTokens, cachedTokens: transcriptCachedTokens } = countTokens(detail.transcript);
  const usage = detail.run.usageJson ?? {};
  const inputTokens = Number(usage.inputTokens ?? transcriptInputTokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? transcriptOutputTokens ?? 0);
  const cachedTokens = Number(usage.cachedInputTokens ?? usage.cachedTokens ?? transcriptCachedTokens ?? 0);
  const costUsd = Number(usage.costUsd ?? usage.totalCostUsd ?? 0);
  const startedAtMs = detail.run.startedAt ? new Date(detail.run.startedAt).getTime() : null;
  const createdAtMs = new Date(detail.run.createdAt).getTime();
  const baselineMs = startedAtMs ?? createdAtMs;

  let assistantTurns = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let stderrLines = 0;
  let firstToolCallLatencyMs: number | null = null;
  let firstAssistantOutputLatencyMs: number | null = null;
  const topToolCounts = new Map<string, number>();

  for (const entry of detail.transcript) {
    const tsMs = Number.isFinite(Date.parse(entry.ts)) ? Date.parse(entry.ts) : baselineMs;
    if (entry.kind === "assistant" || entry.kind === "thinking") {
      assistantTurns += 1;
      if (firstAssistantOutputLatencyMs === null) {
        firstAssistantOutputLatencyMs = Math.max(0, tsMs - baselineMs);
      }
    }
    if (entry.kind === "tool_call") {
      toolCalls += 1;
      if (firstToolCallLatencyMs === null) {
        firstToolCallLatencyMs = Math.max(0, tsMs - baselineMs);
      }
      topToolCounts.set(entry.name, (topToolCounts.get(entry.name) ?? 0) + 1);
    }
    if (entry.kind === "tool_result") {
      toolResults += 1;
    }
    if (entry.kind === "stderr") {
      stderrLines += 1;
    }
  }

  const durationMs = detail.run.finishedAt && detail.run.startedAt
    ? Math.max(0, new Date(detail.run.finishedAt).getTime() - new Date(detail.run.startedAt).getTime())
    : 0;

  return {
    durationMs,
    inputTokens,
    outputTokens,
    cachedTokens,
    costUsd,
    assistantTurns,
    toolCalls,
    toolResults,
    stderrLines,
    firstToolCallLatencyMs,
    firstAssistantOutputLatencyMs,
    topTools: [...topToolCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
  };
}

function quickFindings(detail: ObservedRunDetail, metrics: RunMetrics): RunFinding[] {
  const findings: RunFinding[] = [];

  addFinding(findings, detail.run.status === "failed" ? {
    id: "failed-run",
    severity: "error",
    category: "health",
    title: "Run failed",
    detail: detail.run.error ?? "The run ended in a failed state.",
    evidence: [summarizeIssue(detail)],
  } : null);

  addFinding(findings, detail.run.status === "running" ? {
    id: "running-run",
    severity: "info",
    category: "health",
    title: "Run still in progress",
    detail: "The run is not terminal yet, so findings may still change.",
    evidence: [summarizeIssue(detail)],
  } : null);

  addFinding(findings, metrics.durationMs > 5 * 60 * 1000 ? {
    id: "long-runtime",
    severity: "warn",
    category: "performance",
    title: "Long runtime",
    detail: `Run duration exceeded 5 minutes (${Math.round(metrics.durationMs / 1000)}s).`,
    evidence: [String(metrics.durationMs)],
  } : null);

  addFinding(findings, metrics.costUsd > 5 ? {
    id: "high-cost",
    severity: "warn",
    category: "performance",
    title: "High cost",
    detail: `Run cost exceeded $5 ($${metrics.costUsd.toFixed(2)}).`,
    evidence: [`$${metrics.costUsd.toFixed(2)}`],
  } : null);

  addFinding(findings, detail.run.error ? {
    id: "recorded-error",
    severity: "warn",
    category: "error",
    title: "Recorded error",
    detail: detail.run.error,
    evidence: [detail.run.errorCode ?? "no-error-code"],
  } : null);

  if (findings.length === 0) {
    findings.push({
      id: "healthy-run",
      severity: "info",
      category: "health",
      title: "No obvious health warnings",
      detail: "The run completed without high-signal warning conditions.",
      evidence: [summarizeIssue(detail)],
    });
  }

  return findings;
}

function errorFindings(detail: ObservedRunDetail, taxonomy: string): RunFinding[] {
  const findings: RunFinding[] = [];
  const contextLines = detail.events.slice(-5).map((event) => `[${event.seq}] ${event.message ?? event.eventType}`);
  const evidence = contextLines.length > 0 ? contextLines : [detail.run.error ?? "No event context"];

  const knownPatterns: Array<[RegExp, string, string]> = [
    [/could not read username|authentication failed/i, "auth_or_git_failure", "Git or provider authentication is misconfigured."],
    [/timeout|timed out/i, "timeout", "The run exceeded its allowed execution window."],
    [/cannot find module|module not found|command not found/i, "dependency_or_boot_failure", "A required dependency or command is missing."],
    [/permission denied/i, "permission_denied", "The run failed because the runtime lacked required permissions."],
    [/connection refused|econnrefused/i, "network_dependency_failure", "The run depended on a service that was unavailable."],
  ];

  const haystack = [detail.run.error, detail.run.stderrExcerpt, detail.run.stdoutExcerpt].filter(Boolean).join("\n");
  const matched = knownPatterns.find(([pattern]) => pattern.test(haystack));

  addFinding(findings, {
    id: `taxonomy-${taxonomy}`,
    severity: detail.run.status === "failed" || detail.run.status === "timed_out" ? "error" : "warn",
    category: "error",
    title: "Failure taxonomy",
    detail: taxonomy,
    evidence,
  });

  if (matched) {
    findings.push({
      id: `known-pattern-${matched[1]}`,
      severity: "error",
      category: "error",
      title: "Matched known failure signature",
      detail: matched[2],
      evidence,
    });
  } else if (detail.run.status === "failed" || detail.run.status === "timed_out") {
    findings.push({
      id: "unknown-failure-pattern",
      severity: "warn",
      category: "error",
      title: "Unknown failure signature",
      detail: "The run failed, but no known signature matched. Inspect the raw log and late event stream.",
      evidence,
    });
  }

  return findings;
}

function perfFindings(metrics: RunMetrics): RunFinding[] {
  const findings: RunFinding[] = [];

  addFinding(findings, metrics.durationMs > 10 * 60 * 1000 ? {
    id: "duration-over-10m",
    severity: "warn",
    category: "performance",
    title: "Runtime above 10 minutes",
    detail: `Run duration reached ${Math.round(metrics.durationMs / 1000)} seconds.`,
    evidence: [String(metrics.durationMs)],
  } : null);

  addFinding(findings, metrics.inputTokens > 500_000 ? {
    id: "very-high-input-tokens",
    severity: "warn",
    category: "performance",
    title: "Very high input token usage",
    detail: `Input tokens exceeded 500k (${metrics.inputTokens.toLocaleString()}).`,
    evidence: [String(metrics.inputTokens)],
  } : null);

  addFinding(findings, metrics.toolCalls > 100 ? {
    id: "very-high-tool-volume",
    severity: "warn",
    category: "behavior",
    title: "Very high tool call volume",
    detail: `Tool calls exceeded 100 (${metrics.toolCalls}).`,
    evidence: metrics.topTools.map((tool) => `${tool.name}:${tool.count}`),
  } : null);

  addFinding(findings, metrics.firstToolCallLatencyMs !== null && metrics.firstToolCallLatencyMs > 30_000 ? {
    id: "slow-first-tool-call",
    severity: "warn",
    category: "performance",
    title: "Slow first tool call",
    detail: `The agent took ${Math.round(metrics.firstToolCallLatencyMs / 1000)} seconds before its first tool call.`,
    evidence: [String(metrics.firstToolCallLatencyMs)],
  } : null);

  if (findings.length === 0) {
    findings.push({
      id: "no-perf-red-flags",
      severity: "info",
      category: "performance",
      title: "No obvious performance red flags",
      detail: "The run stayed within the default time, cost, and tool-volume thresholds.",
      evidence: [],
    });
  }

  return findings;
}

function nextStepsFromFindings(findings: RunFinding[], taxonomy: string, detail: ObservedRunDetail): string[] {
  const nextSteps: string[] = [];
  const findingIds = new Set(findings.map((finding) => finding.id));

  if (taxonomy === "auth_or_git_failure") {
    nextSteps.push("Verify the runtime's git/provider authentication and rerun after credentials are fixed.");
  }
  if (taxonomy === "dependency_or_boot_failure") {
    nextSteps.push("Check the working directory and required dependencies or CLI commands before retrying.");
  }
  if (taxonomy === "timeout") {
    nextSteps.push("Inspect the late transcript for repeated loops, then decide whether to raise timeout or tighten the prompt.");
  }
  if (findingIds.has("very-high-tool-volume")) {
    nextSteps.push("Inspect bursts of repeated tool calls and batch repeated reads or searches.");
  }
  if (findingIds.has("very-high-input-tokens")) {
    nextSteps.push("Reduce broad context loading and prefer targeted file reads or delta-oriented fetches.");
  }
  if (findingIds.has("unknown-failure-pattern")) {
    nextSteps.push("Open the raw log and final event slice to capture a new failure signature for future taxonomy rules.");
  }
  if (detail.transcript.length > 0) {
    nextSteps.push("Start with a compact trace outline, then expand only the suspicious turn or step instead of loading every payload.");
  }
  if (nextSteps.length === 0) {
    nextSteps.push("Review the transcript and linked issue context to confirm whether the run behavior matched intent.");
  }

  return nextSteps;
}

export function diagnoseRun(detail: ObservedRunDetail, requestedMode: RunDiagnosisMode = "auto"): RunDiagnosis {
  const mode = requestedMode === "auto"
    ? (detail.run.status === "failed" || detail.run.status === "timed_out"
      ? "full"
      : "quick")
    : requestedMode;
  const metrics = computeMetrics(detail);
  const taxonomy = inferFailureTaxonomy(detail);
  const findings: RunFinding[] = [];

  for (const finding of quickFindings(detail, metrics)) addFinding(findings, finding);
  if (mode === "error" || mode === "full") {
    for (const finding of errorFindings(detail, taxonomy)) addFinding(findings, finding);
  }
  if (mode === "perf" || mode === "full") {
    for (const finding of perfFindings(metrics)) addFinding(findings, finding);
  }

  findings.sort((left, right) => {
    const severityOrder = { error: 0, warn: 1, info: 2 };
    return severityOrder[left.severity] - severityOrder[right.severity];
  });

  const headlineFinding = findings[0];
  const summary = headlineFinding
    ? `${headlineFinding.title}: ${headlineFinding.detail}`
    : `Run ${detail.run.status}`;

  return {
    mode,
    status: detail.run.status,
    summary,
    failureTaxonomy: taxonomy,
    findings,
    nextSteps: nextStepsFromFindings(findings, taxonomy, detail),
    metrics,
  };
}

export function compareRunDiagnoses(left: RunDiagnosis, right: RunDiagnosis): RunComparison {
  const deltas = [
    {
      metric: "status",
      left: left.status,
      right: right.status,
      detail: `Status changed from ${left.status} to ${right.status}.`,
    },
    {
      metric: "durationMs",
      left: left.metrics.durationMs,
      right: right.metrics.durationMs,
      detail: `Duration delta: ${right.metrics.durationMs - left.metrics.durationMs}ms.`,
    },
    {
      metric: "inputTokens",
      left: left.metrics.inputTokens,
      right: right.metrics.inputTokens,
      detail: `Input token delta: ${right.metrics.inputTokens - left.metrics.inputTokens}.`,
    },
    {
      metric: "costUsd",
      left: left.metrics.costUsd,
      right: right.metrics.costUsd,
      detail: `Cost delta: ${(right.metrics.costUsd - left.metrics.costUsd).toFixed(2)} USD.`,
    },
    {
      metric: "toolCalls",
      left: left.metrics.toolCalls,
      right: right.metrics.toolCalls,
      detail: `Tool call delta: ${right.metrics.toolCalls - left.metrics.toolCalls}.`,
    },
  ];

  return {
    left,
    right,
    summary: `Compared ${left.status} vs ${right.status}; top headline moved from "${left.summary}" to "${right.summary}".`,
    deltas,
  };
}
