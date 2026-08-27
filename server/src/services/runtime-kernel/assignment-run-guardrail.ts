import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";

export const ASSIGNMENT_RUN_CONSECUTIVE_FAILURE_LIMIT = 3;
export const ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT = 25;

type ToolFailure = Extract<TranscriptEntry, { kind: "tool_result" }>;
type ToolCall = Extract<TranscriptEntry, { kind: "tool_call" }>;

export type AssignmentRunGuardrailCheckpoint = {
  reason: "repeated_failure" | "total_failure_budget";
  failureCount: number;
  consecutiveFailureCount: number;
  fingerprint: string;
  toolName: string;
  unresolvedError: string;
  nextRecoveryCommand: string | null;
  completedWorkSummary?: string;
};

function compactFailureText(value: string) {
  return value
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\S+\b/g, "<timestamp>")
    .replace(/\/[^\s:'\"]+/g, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function commandIdentity(entry: ToolCall | undefined, toolUseId: string) {
  if (!entry) return `tool-use:${toolUseId}`;
  return compactFailureText(JSON.stringify(entry.input)).slice(0, 500);
}

export function fingerprintToolFailure(entry: ToolFailure, call?: ToolCall) {
  return `${entry.toolName ?? call?.name ?? "unknown"}:${commandIdentity(call, entry.toolUseId)}:${compactFailureText(entry.content).slice(0, 500)}`;
}

function inferRecoveryCommand(entry: ToolFailure) {
  const content = entry.content.toLowerCase();
  if (content.includes("node_modules") || content.includes("cannot find module") || content.includes("module not found")) {
    return "pnpm install --frozen-lockfile";
  }
  if (content.includes("unexpected store") || content.includes("virtual store") || content.includes("store-dir")) {
    return "pnpm install --force";
  }
  return null;
}

export function createAssignmentRunFailureBudget() {
  let failureCount = 0;
  let lastFingerprint: string | null = null;
  let consecutiveFailureCount = 0;
  let processedEntryCount = 0;
  let checkpoint: AssignmentRunGuardrailCheckpoint | null = null;
  const callsById = new Map<string, ToolCall>();

  return {
    observe(entries: TranscriptEntry[]) {
      if (checkpoint) return checkpoint;
      const nextEntries = entries.slice(processedEntryCount);
      processedEntryCount = entries.length;
      for (const entry of nextEntries) {
        if (entry.kind === "tool_call" && entry.toolUseId) {
          callsById.set(entry.toolUseId, entry);
          continue;
        }
        if (entry.kind !== "tool_result") continue;
        if (!entry.isError) {
          lastFingerprint = null;
          consecutiveFailureCount = 0;
          continue;
        }
        failureCount += 1;
        const fingerprint = fingerprintToolFailure(entry, callsById.get(entry.toolUseId));
        consecutiveFailureCount = fingerprint === lastFingerprint ? consecutiveFailureCount + 1 : 1;
        lastFingerprint = fingerprint;
        const reason = consecutiveFailureCount >= ASSIGNMENT_RUN_CONSECUTIVE_FAILURE_LIMIT
          ? "repeated_failure"
          : failureCount >= ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT
            ? "total_failure_budget"
            : null;
        if (reason) {
          checkpoint = {
            reason,
            failureCount,
            consecutiveFailureCount,
            fingerprint,
            toolName: entry.toolName ?? "unknown",
            unresolvedError: entry.content.slice(0, 2_000),
            nextRecoveryCommand: inferRecoveryCommand(entry),
          };
          return checkpoint;
        }
      }
      return null;
    },
    snapshot() {
      return { failureCount, consecutiveFailureCount, checkpoint };
    },
  };
}
