import {
  RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS,
  type TranscriptEntry,
} from "@rudderhq/agent-runtime-utils";

export const ASSIGNMENT_RUN_CONSECUTIVE_FAILURE_LIMIT = 3;
export const ASSIGNMENT_RUN_UNRESOLVED_FAILURE_LIMIT = 25;
export const ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT = 100;
export const ASSIGNMENT_RUN_RECOVERY_BACKOFF_MS = 1_000;

type ToolFailure = Extract<TranscriptEntry, { kind: "tool_result" }>;
type ToolCall = Extract<TranscriptEntry, { kind: "tool_call" }>;

export type AssignmentToolFailureClass =
  | "context_drift"
  | "transient_transport"
  | "invalid_request"
  | "command_failure"
  | "unknown";

export type AssignmentRunGuardrailCheckpoint = {
  reason: "repeated_failure" | "unresolved_failure_budget" | "total_failure_budget";
  failureCount: number;
  unresolvedFailureCount: number;
  consecutiveFailureCount: number;
  failureClass: AssignmentToolFailureClass;
  fingerprint: string;
  toolName: string;
  unresolvedError: string;
  nextRecoveryCommand: string | null;
  automaticContinuationAllowed: boolean;
  continuationBlockReason: string | null;
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

function operationIdentity(entry: ToolFailure, call?: ToolCall) {
  return `${entry.toolName ?? call?.name ?? "unknown"}:${commandIdentity(call, entry.toolUseId)}`;
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

function classifyToolFailure(entry: ToolFailure, call?: ToolCall): AssignmentToolFailureClass {
  const toolName = (entry.toolName ?? call?.name ?? "").toLowerCase();
  const content = entry.content.toLowerCase();
  if (
    content.includes("internal server error")
    || content.includes("status\": 500")
    || content.includes("status: 500")
    || content.includes("timed out")
    || content.includes("timeout")
    || content.includes("connection reset")
    || content.includes("temporarily unavailable")
  ) {
    return "transient_transport";
  }
  if (
    toolName.includes("apply_patch")
    && (
      content.includes("invalid context")
      || content.includes("context mismatch")
      || content.includes("patch failed")
    )
  ) {
    return "context_drift";
  }
  if (
    content.includes("invalid argument")
    || content.includes("invalid_arguments")
    || content.includes("must be at most")
    || content.includes("usage:")
  ) {
    return "invalid_request";
  }
  if (toolName === "exec_command" || content.includes("exit_code:")) {
    return "command_failure";
  }
  return "unknown";
}

function canonicalRudderToolName(toolName: string) {
  const normalized = toolName.toLowerCase();
  const managedPrefix = normalized.lastIndexOf("__rudder_tools__");
  return managedPrefix >= 0
    ? normalized.slice(managedPrefix + "__rudder_tools__".length)
    : normalized;
}

function continuationSafety(toolName: string, failureClass: AssignmentToolFailureClass) {
  if (failureClass === "context_drift") {
    return { automaticContinuationAllowed: true, continuationBlockReason: null };
  }
  if (failureClass !== "transient_transport") {
    return {
      automaticContinuationAllowed: false,
      continuationBlockReason: `The ${failureClass} failure is not proven transient and side-effect free.`,
    };
  }
  const descriptor = RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS.find(
    (candidate) => candidate.name === canonicalRudderToolName(toolName),
  );
  if (!descriptor || descriptor.mutating || descriptor.annotations.readOnlyHint !== true) {
    return {
      automaticContinuationAllowed: false,
      continuationBlockReason: descriptor?.mutating
        ? "The canonical tool contract marks this operation as mutating, so its side effect may be indeterminate."
        : "The tool has no canonical read-only contract, so Rudder cannot prove that retrying is side-effect free.",
    };
  }
  return { automaticContinuationAllowed: true, continuationBlockReason: null };
}

export function formatAssignmentRunGuardrailError(
  checkpoint: AssignmentRunGuardrailCheckpoint,
  continuationRequired: boolean,
) {
  const reason = checkpoint.reason === "repeated_failure"
    ? `${checkpoint.consecutiveFailureCount} repeated ${checkpoint.toolName} failures`
    : checkpoint.reason === "unresolved_failure_budget"
      ? `${checkpoint.unresolvedFailureCount} unresolved tool operations`
      : `${checkpoint.failureCount} total tool failures`;
  const recovery = continuationRequired
    ? "This failure is eligible for recovery attempt 1 of 1 as a linked continuation."
    : checkpoint.continuationBlockReason
      ? `Automatic continuation was withheld: ${checkpoint.continuationBlockReason}`
      : "The single automatic recovery allowance was exhausted.";
  const nextStep = checkpoint.nextRecoveryCommand
    ? `Suggested recovery: ${checkpoint.nextRecoveryCommand}.`
    : "Next: inspect the last tool error, correct the failing input or environment, then retry the run.";
  return `Run stopped after ${reason} (${checkpoint.failureClass}). ${recovery} ${nextStep}`;
}

export function createAssignmentRunFailureBudget() {
  let failureCount = 0;
  let lastFingerprint: string | null = null;
  let consecutiveFailureCount = 0;
  let processedEntryCount = 0;
  let checkpoint: AssignmentRunGuardrailCheckpoint | null = null;
  const callsById = new Map<string, ToolCall>();
  const unresolvedOperations = new Map<string, string>();

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
        const call = callsById.get(entry.toolUseId);
        const operation = operationIdentity(entry, call);
        if (!entry.isError) {
          unresolvedOperations.delete(operation);
          lastFingerprint = null;
          consecutiveFailureCount = 0;
          continue;
        }
        failureCount += 1;
        const fingerprint = fingerprintToolFailure(entry, call);
        unresolvedOperations.set(operation, fingerprint);
        const unresolvedFailureCount = unresolvedOperations.size;
        consecutiveFailureCount = fingerprint === lastFingerprint ? consecutiveFailureCount + 1 : 1;
        lastFingerprint = fingerprint;
        const reason = consecutiveFailureCount >= ASSIGNMENT_RUN_CONSECUTIVE_FAILURE_LIMIT
          ? "repeated_failure"
          : unresolvedFailureCount >= ASSIGNMENT_RUN_UNRESOLVED_FAILURE_LIMIT
            ? "unresolved_failure_budget"
            : failureCount >= ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT
              ? "total_failure_budget"
            : null;
        if (reason) {
          const toolName = entry.toolName ?? call?.name ?? "unknown";
          const failureClass = classifyToolFailure(entry, call);
          checkpoint = {
            reason,
            failureCount,
            unresolvedFailureCount,
            consecutiveFailureCount,
            failureClass,
            fingerprint,
            toolName,
            unresolvedError: entry.content.slice(0, 2_000),
            nextRecoveryCommand: inferRecoveryCommand(entry),
            ...continuationSafety(toolName, failureClass),
          };
          return checkpoint;
        }
      }
      return null;
    },
    snapshot() {
      return {
        failureCount,
        unresolvedFailureCount: unresolvedOperations.size,
        consecutiveFailureCount,
        checkpoint,
      };
    },
  };
}
