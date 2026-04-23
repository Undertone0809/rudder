import type { ExecutionLangfuseLink } from "@rudder/shared";
import type { ObservedRunDetail, RunDiagnosis } from "./types.js";

export interface LangfuseScoreDraft {
  name:
    | "run_health"
    | "failure_taxonomy"
    | "task_outcome"
    | "budget_guardrail"
    | "cost_efficiency"
    | "human_intervention_required"
    | "recovery_success";
  value: boolean | number | string;
  comment?: string;
  metadata?: Record<string, unknown>;
}

function collectErrorText(detail: ObservedRunDetail) {
  return [
    detail.run.error ?? "",
    detail.run.errorCode ?? "",
    detail.run.stderrExcerpt ?? "",
    ...detail.events.map((event) => event.message ?? ""),
  ].join("\n");
}

function isBudgetGuardrail(detail: ObservedRunDetail) {
  return /budget|hard[-\s]?limit|token burn|auto-pause/i.test(collectErrorText(detail));
}

function requiresHumanIntervention(detail: ObservedRunDetail, diagnosis: RunDiagnosis) {
  if (detail.run.status === "failed" || detail.run.status === "timed_out") return true;
  return diagnosis.findings.some((finding) => finding.severity === "error");
}

function resolveTaskOutcome(detail: ObservedRunDetail) {
  switch (detail.run.status) {
    case "succeeded":
      return 1;
    case "cancelled":
      return 0;
    case "failed":
    case "timed_out":
      return 0;
    default:
      return 0;
  }
}

function resolveCostEfficiency(detail: ObservedRunDetail, diagnosis: RunDiagnosis) {
  const costUsd = Number(diagnosis.metrics.costUsd ?? detail.run.usageJson?.costUsd ?? 0);
  if (detail.run.status !== "succeeded") return "n/a";
  if (costUsd <= 1) return "low";
  if (costUsd <= 5) return "medium";
  return "high";
}

function resolveRecoverySuccess(detail: ObservedRunDetail) {
  const recovery = detail.run.contextSnapshot?.recovery;
  if (!recovery || typeof recovery !== "object") return null;
  return detail.run.status === "succeeded";
}

export function buildLangfuseRunScores(detail: ObservedRunDetail, diagnosis: RunDiagnosis): LangfuseScoreDraft[] {
  const scores: LangfuseScoreDraft[] = [
    {
      name: "run_health",
      value: detail.run.status === "succeeded",
      comment: diagnosis.summary,
      metadata: {
        status: detail.run.status,
        failureTaxonomy: diagnosis.failureTaxonomy,
      },
    },
    {
      name: "failure_taxonomy",
      value: diagnosis.failureTaxonomy,
      comment: detail.run.error ?? diagnosis.summary,
    },
    {
      name: "task_outcome",
      value: resolveTaskOutcome(detail),
      comment: detail.issue?.identifier ?? detail.issue?.title ?? "No linked issue",
    },
    {
      name: "budget_guardrail",
      value: isBudgetGuardrail(detail),
      comment: isBudgetGuardrail(detail) ? "Run was blocked or degraded by budget enforcement." : "No budget guardrail detected.",
    },
    {
      name: "cost_efficiency",
      value: resolveCostEfficiency(detail, diagnosis),
      comment: `costUsd=${Number(diagnosis.metrics.costUsd ?? detail.run.usageJson?.costUsd ?? 0).toFixed(2)}`,
    },
    {
      name: "human_intervention_required",
      value: requiresHumanIntervention(detail, diagnosis),
      comment: requiresHumanIntervention(detail, diagnosis)
        ? "Manual review or follow-up is recommended."
        : "No immediate human intervention signal detected.",
    },
  ];

  const recoverySuccess = resolveRecoverySuccess(detail);
  if (recoverySuccess !== null) {
    scores.push({
      name: "recovery_success",
      value: recoverySuccess,
      comment: recoverySuccess ? "Recovery run completed successfully." : "Recovery run did not complete successfully.",
    });
  }

  return scores;
}

export type LangfuseAnnotatedRun = {
  langfuse?: ExecutionLangfuseLink | null;
};
