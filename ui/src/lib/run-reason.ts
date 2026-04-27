import type { HeartbeatRun } from "@rudderhq/shared";

type RunReasonTone = "scheduled" | "manual" | "task" | "followup" | "recovery" | "auto";

export type RunReasonSummary = {
  label: string;
  description: string;
  tone: RunReasonTone;
};

type RunReasonInput = Pick<HeartbeatRun, "invocationSource" | "triggerDetail" | "contextSnapshot" | "retryOfRunId">;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sentenceFromReason(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

export function describeRunReason(run: RunReasonInput): RunReasonSummary {
  const context = asRecord(run.contextSnapshot);
  const wakeReason = asNonEmptyString(context?.wakeReason);
  const wakeSource = asNonEmptyString(context?.wakeSource) ?? asNonEmptyString(context?.source);
  const recovery = asRecord(context?.recovery);
  const passiveFollowup = asRecord(context?.passiveFollowup);

  if (passiveFollowup || wakeReason === "issue_passive_followup") {
    const attempt = typeof passiveFollowup?.attempt === "number" ? passiveFollowup.attempt : null;
    const maxAttempts = typeof passiveFollowup?.maxAttempts === "number" ? passiveFollowup.maxAttempts : null;
    return {
      label: attempt && maxAttempts ? `Follow-up ${attempt}/${maxAttempts}` : "Follow-up",
      description: "Rudder started this run because the previous issue run did not leave a clear close-out.",
      tone: "followup",
    };
  }

  if (recovery || wakeReason === "process_lost_retry") {
    const recoveryTrigger = asNonEmptyString(recovery?.recoveryTrigger);
    const failureKind = asNonEmptyString(recovery?.failureKind);
    const manual = recoveryTrigger === "manual" || wakeReason === "retry_failed_run" || Boolean(run.retryOfRunId);
    return {
      label: manual ? "Retry" : "Recovery",
      description: failureKind
        ? `Rudder started this run to recover from ${sentenceFromReason(failureKind).toLowerCase()}.`
        : manual
          ? "A user retried a failed or timed-out run."
          : "Rudder started this run to recover interrupted agent work.",
      tone: "recovery",
    };
  }

  switch (wakeReason) {
    case "heartbeat_timer":
      return {
        label: "Scheduled heartbeat",
        description: "The agent's heartbeat schedule reached its next run time.",
        tone: "scheduled",
      };
    case "issue_assigned":
      return {
        label: "Task assigned",
        description: "This run started because an issue was assigned to the agent.",
        tone: "task",
      };
    case "issue_commented":
      return {
        label: "Comment added",
        description: "This run started because someone commented on the agent's active issue.",
        tone: "followup",
      };
    case "issue_comment_mentioned":
      return {
        label: "Mentioned",
        description: "This run started because the agent was mentioned in an issue comment.",
        tone: "followup",
      };
    case "issue_reopened_via_comment":
      return {
        label: "Issue reopened",
        description: "This run started because a comment reopened the issue.",
        tone: "followup",
      };
    case "issue_status_changed":
      return {
        label: "Issue activated",
        description: "This run started because an assigned issue moved into active work.",
        tone: "task",
      };
    case "retry_failed_run":
      return {
        label: "Retry",
        description: "A user retried a failed or timed-out run.",
        tone: "recovery",
      };
    case "issue_execution_promoted":
      return {
        label: "Resumed task",
        description: "A deferred issue run was promoted after the agent became available.",
        tone: "task",
      };
  }

  if (run.invocationSource === "timer") {
    return {
      label: "Scheduled heartbeat",
      description: "The agent's heartbeat schedule started this run.",
      tone: "scheduled",
    };
  }

  if (run.invocationSource === "on_demand") {
    return {
      label: run.triggerDetail === "ping" ? "API heartbeat" : "Manual heartbeat",
      description: run.triggerDetail === "ping"
        ? "An API request manually woke the agent."
        : "A user manually started this heartbeat.",
      tone: "manual",
    };
  }

  if (run.invocationSource === "assignment") {
    return {
      label: "Task assigned",
      description: "This run started because work was assigned to the agent.",
      tone: "task",
    };
  }

  if (wakeSource === "comment.mention") {
    return {
      label: "Mentioned",
      description: "This run started because the agent was mentioned in an issue comment.",
      tone: "followup",
    };
  }

  if (wakeReason) {
    return {
      label: sentenceFromReason(wakeReason),
      description: `Rudder started this run because: ${sentenceFromReason(wakeReason).toLowerCase()}.`,
      tone: "auto",
    };
  }

  return {
    label: "Auto run",
    description: "Rudder started this run automatically, but no more specific reason was recorded.",
    tone: "auto",
  };
}

export function runReasonBadgeClassName(tone: RunReasonTone) {
  switch (tone) {
    case "scheduled":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300";
    case "manual":
      return "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300";
    case "task":
      return "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300";
    case "followup":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300";
    case "recovery":
      return "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300";
    case "auto":
      return "bg-muted text-muted-foreground";
  }
}
