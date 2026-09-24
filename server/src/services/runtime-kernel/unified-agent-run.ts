import { randomUUID } from "node:crypto";
import type { AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import type {
  AgentRunTargetType,
  HeartbeatRunAttemptResumeSource,
  HeartbeatRunAttemptStatus,
} from "@rudderhq/shared";

/**
 * The common admission vocabulary deliberately lives below routes and above
 * the existing heartbeat/chat services. It does not own scheduling, database
 * writes, or transcript/event persistence.
 */
export const UNIFIED_AGENT_RUN_SCENES = [
  "chat",
  "side_chat",
  "issue",
  "review",
  "automation",
  "heartbeat",
  "delegation",
] as const;

export type UnifiedAgentRunScene = (typeof UNIFIED_AGENT_RUN_SCENES)[number];

export type UnifiedAgentRunTargetType = AgentRunTargetType | "review";

export type UnifiedAgentRunTarget = {
  type: UnifiedAgentRunTargetType;
  id: string;
};

export type UnifiedSessionIntent =
  | {
      kind: "fresh";
      reuseScope: "none";
      sourceRunId: null;
      sessionId: null;
      sessionParams: null;
    }
  | {
      kind: "resume";
      reuseScope: "explicit" | "task";
      sourceRunId: string | null;
      sessionId: string | null;
      sessionParams: Record<string, unknown> | null;
    }
  | {
      kind: "fork";
      reuseScope: "explicit";
      sourceRunId: string;
      sourceBoundaryRef: string;
      sessionId: string | null;
      sessionParams: Record<string, unknown> | null;
    };

export type UnifiedSessionIntentInput =
  | {
      kind: "fresh";
      reuseScope?: "none";
      sourceRunId?: null;
      sessionId?: null;
      sessionParams?: null;
    }
  | {
      kind: "resume";
      reuseScope: "explicit" | "task";
      sourceRunId?: string | null;
      sessionId?: string | null;
      sessionParams?: Record<string, unknown> | null;
    }
  | {
      kind: "fork";
      sourceRunId: string;
      sourceBoundaryRef: string;
      sessionId?: string | null;
      sessionParams?: Record<string, unknown> | null;
    };

export type UnifiedSubmissionPhase = "pre_submission" | "accepted" | "indeterminate" | null;
export type UnifiedSubmissionState = "pending" | "accepted" | "rejected" | "acceptance_unknown";
export type UnifiedSubmissionRetry = "allowed" | "blocked_until_reconciled" | "not_allowed";

export type UnifiedSubmission = {
  key: string;
  state: UnifiedSubmissionState;
  phase: UnifiedSubmissionPhase;
  retry: UnifiedSubmissionRetry;
  providerThreadId: string | null;
  providerTurnId: string | null;
  reason: string | null;
};

export type UnifiedOwnerFence = {
  id: string;
  ownerToken: string;
  attemptEpoch: number;
  leaseExpiresAt: Date;
};

export type UnifiedRunStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type UnifiedSpanState = "open" | "sealed" | "unresolved";
export type UnifiedSpanCompleteness = "complete" | "partial" | "terminal_only" | "unknown";

/** Structural identity shared by persisted heartbeat attempts and the facade. */
export type UnifiedAttemptRef = {
  id: string;
  attemptIndex: number;
  ownerToken?: string | null;
  attemptEpoch?: number | null;
};

export type UnifiedRunAttempt = {
  ref: UnifiedAttemptRef;
  runtimeType: string;
  model: string | null;
  fallbackIndex: number | null;
  isFallback: boolean;
  resumeSource: HeartbeatRunAttemptResumeSource;
  status: HeartbeatRunAttemptStatus;
  submission: UnifiedSubmission;
};

export type UnifiedRunSpan = {
  id: string;
  runId: string;
  attemptRef: UnifiedAttemptRef | null;
  ownerFence: UnifiedOwnerFence;
  state: UnifiedSpanState;
  completeness: UnifiedSpanCompleteness;
  sourceRevision: string | null;
  visibilityCutoffRef: string | null;
};

export type UnifiedAgentRunEntry = {
  runId: string;
  orgId: string;
  agentId: string;
  scene: UnifiedAgentRunScene;
  target: UnifiedAgentRunTarget;
  idempotencyKey: string;
  sessionIntent: UnifiedSessionIntent;
  status: UnifiedRunStatus;
  ownerFence: UnifiedOwnerFence;
  attempt: UnifiedRunAttempt;
  span: UnifiedRunSpan;
};

export type UnifiedAgentRunAdmission = {
  orgId: string;
  agentId: string;
  scene: UnifiedAgentRunScene;
  target: UnifiedAgentRunTarget;
  idempotencyKey: string;
  runtimeType: string;
  /** Explicit native identity anchor for non-Chat runs. */
  runtimeBindingId?: string | null;
  runtimeSegmentId?: string | null;
  model?: string | null;
  sessionIntent: UnifiedSessionIntentInput;
  /** Caller-owned recovery metadata persisted atomically with Run admission. */
  contextSnapshot?: Record<string, unknown> | null;
  leaseMs?: number;
  attempt?: {
    attemptIndex?: number;
    fallbackIndex?: number | null;
    isFallback?: boolean;
    resumeSource?: HeartbeatRunAttemptResumeSource;
  };
};

export type UnifiedAdmissionResult = {
  created: boolean;
  entry: UnifiedAgentRunEntry;
};

export type UnifiedFenceFailure =
  | "run_not_found"
  | "stale_owner"
  | "lease_expired"
  | "lease_held"
  | "run_terminal";

export type UnifiedFenceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: UnifiedFenceFailure };

export class UnifiedAgentRunContractError extends Error {
  constructor(
    readonly code:
      | "invalid_scene"
      | "invalid_target"
      | "invalid_session_intent"
      | "invalid_admission"
      | "idempotency_conflict"
      | "attempt_conflict"
      | "acceptance_unknown_requires_reconciliation",
    message: string,
  ) {
    super(message);
    this.name = "UnifiedAgentRunContractError";
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UnifiedAgentRunContractError("invalid_admission", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UnifiedAgentRunContractError("invalid_session_intent", `${field} must be a non-empty string when provided`);
  }
  return value.trim();
}

function recordOrNull(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new UnifiedAgentRunContractError("invalid_session_intent", `${field} must be an object or null`);
  }
  return { ...(value as Record<string, unknown>) };
}

export function normalizeUnifiedSessionIntent(input: UnifiedSessionIntentInput): UnifiedSessionIntent {
  if (input.kind === "fresh") {
    if (input.sourceRunId !== undefined || input.sessionId !== undefined || input.sessionParams !== undefined) {
      throw new UnifiedAgentRunContractError(
        "invalid_session_intent",
        "fresh session intent cannot carry a source or session parameters",
      );
    }
    return {
      kind: "fresh",
      reuseScope: "none",
      sourceRunId: null,
      sessionId: null,
      sessionParams: null,
    };
  }

  if (input.kind === "resume") {
    return {
      kind: "resume",
      reuseScope: input.reuseScope,
      sourceRunId: optionalString(input.sourceRunId, "sourceRunId"),
      sessionId: optionalString(input.sessionId, "sessionId"),
      sessionParams: recordOrNull(input.sessionParams, "sessionParams"),
    };
  }

  const sourceRunId = requiredString(input.sourceRunId, "sourceRunId");
  const sourceBoundaryRef = requiredString(input.sourceBoundaryRef, "sourceBoundaryRef");
  return {
    kind: "fork",
    reuseScope: "explicit",
    sourceRunId,
    sourceBoundaryRef,
    sessionId: optionalString(input.sessionId, "sessionId"),
    sessionParams: recordOrNull(input.sessionParams, "sessionParams"),
  };
}

export function isUnifiedOwnerFenceCurrent(
  expected: UnifiedOwnerFence,
  presented: UnifiedOwnerFence,
  now = new Date(),
) {
  return expected.ownerToken === presented.ownerToken
    && expected.attemptEpoch === presented.attemptEpoch
    && expected.leaseExpiresAt.getTime() > now.getTime();
}

function cloneFence(fence: UnifiedOwnerFence): UnifiedOwnerFence {
  return { ...fence, leaseExpiresAt: new Date(fence.leaseExpiresAt) };
}

function cloneSubmission(submission: UnifiedSubmission): UnifiedSubmission {
  return { ...submission };
}

function cloneAttempt(attempt: UnifiedRunAttempt): UnifiedRunAttempt {
  return {
    ...attempt,
    ref: { ...attempt.ref },
    submission: cloneSubmission(attempt.submission),
  };
}

function cloneEntry(entry: UnifiedAgentRunEntry): UnifiedAgentRunEntry {
  return {
    ...entry,
    target: { ...entry.target },
    sessionIntent: entry.sessionIntent.kind === "fresh"
      ? { ...entry.sessionIntent }
      : entry.sessionIntent.kind === "resume"
        ? {
            ...entry.sessionIntent,
            sessionParams: entry.sessionIntent.sessionParams ? { ...entry.sessionIntent.sessionParams } : null,
          }
        : {
            ...entry.sessionIntent,
            sessionParams: entry.sessionIntent.sessionParams ? { ...entry.sessionIntent.sessionParams } : null,
          },
    ownerFence: cloneFence(entry.ownerFence),
    attempt: cloneAttempt(entry.attempt),
    span: {
      ...entry.span,
      attemptRef: entry.span.attemptRef ? { ...entry.span.attemptRef } : null,
      ownerFence: cloneFence(entry.span.ownerFence),
    },
  };
}

function submissionFor(key: string): UnifiedSubmission {
  return {
    key,
    state: "pending",
    phase: "pre_submission",
    retry: "allowed",
    providerThreadId: null,
    providerTurnId: null,
    reason: null,
  };
}

function fingerprintFor(input: {
  scene: UnifiedAgentRunScene;
  target: UnifiedAgentRunTarget;
  runtimeType: string;
  runtimeBindingId?: string | null;
  runtimeSegmentId?: string | null;
  model: string | null;
  sessionIntent: UnifiedSessionIntent;
}) {
  return JSON.stringify({
    scene: input.scene,
    target: input.target,
    runtimeType: input.runtimeType,
    runtimeBindingId: input.runtimeBindingId ?? null,
    runtimeSegmentId: input.runtimeSegmentId ?? null,
    model: input.model,
    sessionIntent: input.sessionIntent,
  });
}

function ensureTarget(target: UnifiedAgentRunTarget): UnifiedAgentRunTarget {
  const allowed: UnifiedAgentRunTargetType[] = [
    "issue",
    "chat_conversation",
    "chat_message",
    "automation_run",
    "wakeup_request",
    "manual",
    "review",
  ];
  if (!allowed.includes(target.type) || typeof target.id !== "string" || target.id.trim().length === 0) {
    throw new UnifiedAgentRunContractError("invalid_target", "run target type and id are required");
  }
  return { type: target.type, id: target.id.trim() };
}

function ensureScene(scene: UnifiedAgentRunScene): UnifiedAgentRunScene {
  if (!UNIFIED_AGENT_RUN_SCENES.includes(scene)) {
    throw new UnifiedAgentRunContractError("invalid_scene", `unsupported run scene: ${String(scene)}`);
  }
  return scene;
}

function failureFrom(error: unknown): Exclude<UnifiedFenceFailure, "run_not_found"> {
  if (error instanceof UnifiedAgentRunFenceError) return error.code;
  return "stale_owner";
}

export class UnifiedAgentRunFenceError extends Error {
  constructor(readonly code: Exclude<UnifiedFenceFailure, "run_not_found" | "lease_held">) {
    super(`Unified run owner fence rejected: ${code}`);
    this.name = "UnifiedAgentRunFenceError";
  }
}

export type UnifiedAttemptInput = {
  attemptIndex: number;
  runtimeType: string;
  model?: string | null;
  fallbackIndex?: number | null;
  isFallback?: boolean;
  resumeSource: HeartbeatRunAttemptResumeSource;
};

export type UnifiedAttemptWaitingInput = {
  submissionPhase?: Exclude<UnifiedSubmissionPhase, null> | null;
  providerThreadId?: string | null;
  providerTurnId?: string | null;
  sessionDisplayId?: string | null;
  sessionParamsJson?: Record<string, unknown> | null;
  errorCode?: string | null;
  error?: string | null;
  suspendedAt?: Date;
};

export type UnifiedAttemptFinishInput = UnifiedAttemptWaitingInput & {
  usageDeltaJson?: Record<string, unknown> | null;
  costUsd?: number | null;
  finishedAt?: Date;
};

export type UnifiedNativeExecutionInput = {
  spanId?: string | null;
  result: AgentRuntimeExecutionResult;
  error?: boolean;
  suspended?: boolean;
  visibilityCutoffRef?: string | null;
};

export type UnifiedRunTerminalFields = {
  finishedAt?: Date;
  exitCode?: number | null;
  signal?: string | null;
  sessionIdAfter?: string | null;
  sessionParamsAfterJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  logBytes?: number | null;
  logSha256?: string | null;
  logCompressed?: boolean;
};

export type UnifiedRunTerminalInput = {
  error?: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
  resultSummaryJson?: Record<string, unknown> | null;
  usageJson?: Record<string, unknown> | null;
  terminalFields?: UnifiedRunTerminalFields;
  nativeExecution?: UnifiedNativeExecutionInput;
  terminalEffectsPending?: boolean;
  /** Product terminal effects remain owned by the heartbeat coordinator. */
  terminalEffectsIntent?: Record<string, unknown> | null;
  processExitedAt?: Date | null;
  expectedStatuses?: string[];
  activityWatermark?: { updatedAt: Date; updatedAtExact?: string; eventCount: number };
  attempt?: UnifiedAttemptFinishInput;
};

export type UnifiedSubmissionOutcome = {
  submissionKey?: string;
  providerThreadId?: string | null;
  providerTurnId?: string | null;
  reason?: string | null;
};

type StoredRun = {
  entry: UnifiedAgentRunEntry;
  fingerprint: string;
  attempts: Map<number, UnifiedRunAttempt>;
  leaseMs: number;
};

/**
 * Contract double for the run boundary. This is intentionally process-local:
 * it does not replace persisted heartbeat runs, schedule work, or write
 * attempts, events, transcripts, or runtime state.
 */
export type UnifiedAgentRunLedger = ReturnType<typeof createUnifiedAgentRunLedger>;

export function createUnifiedAgentRunLedger(options: {
  now?: () => Date;
  idFactory?: (kind: "run" | "attempt" | "span" | "owner") => string;
  defaultLeaseMs?: number;
} = {}) {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => randomUUID());
  const defaultLeaseMs = options.defaultLeaseMs ?? 5 * 60_000;
  if (!Number.isFinite(defaultLeaseMs) || defaultLeaseMs <= 0) {
    throw new UnifiedAgentRunContractError("invalid_admission", "defaultLeaseMs must be positive");
  }

  const byIdempotencyKey = new Map<string, StoredRun>();
  const byRunId = new Map<string, StoredRun>();

  const currentTime = () => new Date(now().getTime());

  function find(runId: string): StoredRun | null {
    return byRunId.get(runId) ?? null;
  }

  function requireRun(runId: string): StoredRun {
    const stored = find(runId);
    if (!stored) throw new UnifiedAgentRunContractError("invalid_admission", `unknown run: ${runId}`);
    return stored;
  }

  function checkFence(stored: StoredRun, fence: UnifiedOwnerFence) {
    if (stored.entry.status !== "running") throw new UnifiedAgentRunFenceError("run_terminal");
    const current = currentTime();
    if (stored.entry.ownerFence.ownerToken !== fence.ownerToken || stored.entry.ownerFence.attemptEpoch !== fence.attemptEpoch) {
      throw new UnifiedAgentRunFenceError("stale_owner");
    }
    if (stored.entry.ownerFence.leaseExpiresAt.getTime() <= current.getTime()) {
      throw new UnifiedAgentRunFenceError("lease_expired");
    }
  }

  function updateFence(stored: StoredRun, fence: UnifiedOwnerFence) {
    stored.entry.ownerFence = cloneFence(fence);
    stored.entry.span.ownerFence = cloneFence(fence);
    stored.entry.attempt.ref.ownerToken = fence.ownerToken;
    stored.entry.attempt.ref.attemptEpoch = fence.attemptEpoch;
    if (stored.entry.span.attemptRef) {
      stored.entry.span.attemptRef.ownerToken = fence.ownerToken;
      stored.entry.span.attemptRef.attemptEpoch = fence.attemptEpoch;
    }
  }

  function submissionKeyFor(stored: StoredRun, input?: UnifiedSubmissionOutcome) {
    return input?.submissionKey?.trim() || stored.entry.attempt.submission.key;
  }

  function ensureSubmissionKey(stored: StoredRun, key: string) {
    if (stored.entry.attempt.submission.key !== key) {
      throw new UnifiedAgentRunContractError(
        "attempt_conflict",
        `submission key ${key} does not match current attempt ${stored.entry.attempt.ref.attemptIndex}`,
      );
    }
  }

  function setSubmission(stored: StoredRun, submission: UnifiedSubmission) {
    stored.entry.attempt.submission = cloneSubmission(submission);
  }

  function submit(input: UnifiedAgentRunAdmission): UnifiedAdmissionResult {
    const orgId = requiredString(input.orgId, "orgId");
    const agentId = requiredString(input.agentId, "agentId");
    const idempotencyKey = requiredString(input.idempotencyKey, "idempotencyKey");
    const runtimeType = requiredString(input.runtimeType, "runtimeType");
    const runtimeBindingId = input.runtimeBindingId?.trim() || null;
    const runtimeSegmentId = input.runtimeSegmentId?.trim() || null;
    const scene = ensureScene(input.scene);
    const target = ensureTarget(input.target);
    const sessionIntent = normalizeUnifiedSessionIntent(input.sessionIntent);
    const model = input.model?.trim() || null;
    const leaseMs = input.leaseMs ?? defaultLeaseMs;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new UnifiedAgentRunContractError("invalid_admission", "leaseMs must be positive");
    }

    const key = `${orgId}:${idempotencyKey}`;
    const fingerprint = fingerprintFor({
      scene,
      target,
      runtimeType,
      runtimeBindingId,
      runtimeSegmentId,
      model,
      sessionIntent,
    });
    const existing = byIdempotencyKey.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new UnifiedAgentRunContractError(
          "idempotency_conflict",
          `idempotency key ${idempotencyKey} was already admitted with different run inputs`,
        );
      }
      return { created: false, entry: cloneEntry(existing.entry) };
    }

    const createdAt = currentTime();
    const runId = idFactory("run");
    const spanId = idFactory("span");
    const ownerFence: UnifiedOwnerFence = {
      id: spanId,
      ownerToken: idFactory("owner"),
      attemptEpoch: 1,
      leaseExpiresAt: new Date(createdAt.getTime() + leaseMs),
    };
    const attemptRef: UnifiedAttemptRef = {
      id: idFactory("attempt"),
      attemptIndex: input.attempt?.attemptIndex ?? 0,
      ownerToken: ownerFence.ownerToken,
      attemptEpoch: ownerFence.attemptEpoch,
    };
    const submission = submissionFor(idempotencyKey);
    const attempt: UnifiedRunAttempt = {
      ref: attemptRef,
      runtimeType,
      model,
      fallbackIndex: input.attempt?.fallbackIndex ?? null,
      isFallback: input.attempt?.isFallback ?? false,
      resumeSource: input.attempt?.resumeSource ?? (sessionIntent.kind === "fresh" ? "fresh" : "same_session"),
      status: "started",
      submission,
    };
    const span: UnifiedRunSpan = {
      id: spanId,
      runId,
      attemptRef: { ...attemptRef },
      ownerFence: cloneFence(ownerFence),
      state: "open",
      completeness: "unknown",
      sourceRevision: null,
      visibilityCutoffRef: null,
    };
    const entry: UnifiedAgentRunEntry = {
      runId,
      orgId,
      agentId,
      scene,
      target,
      idempotencyKey,
      sessionIntent,
      status: "running",
      ownerFence,
      attempt,
      span,
    };
    const stored: StoredRun = {
      entry,
      fingerprint,
      attempts: new Map([[attemptRef.attemptIndex, attempt]]),
      leaseMs,
    };
    byIdempotencyKey.set(key, stored);
    byRunId.set(runId, stored);
    return { created: true, entry: cloneEntry(entry) };
  }

  function get(runId: string): UnifiedAgentRunEntry | null {
    const stored = find(runId);
    return stored ? cloneEntry(stored.entry) : null;
  }

  function renewLease(runId: string, fence: UnifiedOwnerFence): UnifiedFenceResult<UnifiedOwnerFence> {
    const stored = find(runId);
    if (!stored) return { ok: false, reason: "run_not_found" };
    try {
      checkFence(stored, fence);
    } catch (error) {
      return { ok: false, reason: failureFrom(error) };
    }
    const renewed: UnifiedOwnerFence = {
      ...stored.entry.ownerFence,
      leaseExpiresAt: new Date(currentTime().getTime() + stored.leaseMs),
    };
    updateFence(stored, renewed);
    return { ok: true, value: cloneFence(renewed) };
  }

  function claimLease(
    runId: string,
    input: { ownerToken?: string; leaseMs?: number } = {},
  ): UnifiedFenceResult<UnifiedOwnerFence> {
    const stored = find(runId);
    if (!stored) return { ok: false, reason: "run_not_found" };
    if (stored.entry.status !== "running") return { ok: false, reason: "run_terminal" };
    const current = currentTime();
    if (stored.entry.ownerFence.leaseExpiresAt.getTime() > current.getTime()) {
      return { ok: false, reason: "lease_held" };
    }
    const leaseMs = input.leaseMs ?? stored.leaseMs;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new UnifiedAgentRunContractError("invalid_admission", "leaseMs must be positive");
    }
    const next: UnifiedOwnerFence = {
      id: stored.entry.ownerFence.id,
      ownerToken: input.ownerToken?.trim() || idFactory("owner"),
      attemptEpoch: stored.entry.ownerFence.attemptEpoch + 1,
      leaseExpiresAt: new Date(current.getTime() + leaseMs),
    };
    stored.leaseMs = leaseMs;
    updateFence(stored, next);
    return { ok: true, value: cloneFence(next) };
  }

  function beginAttempt(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedAttemptInput,
  ): UnifiedFenceResult<UnifiedRunAttempt> {
    const stored = find(runId);
    if (!stored) return { ok: false, reason: "run_not_found" };
    try {
      checkFence(stored, fence);
    } catch (error) {
      return { ok: false, reason: failureFrom(error) };
    }
    if (!Number.isInteger(input.attemptIndex) || input.attemptIndex < 0) {
      throw new UnifiedAgentRunContractError("invalid_admission", "attemptIndex must be a non-negative integer");
    }
    const existing = stored.attempts.get(input.attemptIndex);
    if (existing) {
      if (
        existing.runtimeType !== input.runtimeType
        || existing.model !== (input.model?.trim() || null)
        || existing.fallbackIndex !== (input.fallbackIndex ?? null)
        || existing.isFallback !== (input.isFallback ?? false)
      ) {
        throw new UnifiedAgentRunContractError("attempt_conflict", `attempt ${input.attemptIndex} was already admitted differently`);
      }
      return { ok: true, value: cloneAttempt(existing) };
    }
    if (stored.entry.attempt.submission.state === "acceptance_unknown") {
      throw new UnifiedAgentRunContractError(
        "acceptance_unknown_requires_reconciliation",
        "cannot create a retry attempt before reconciling provider acceptance",
      );
    }
    if (input.attemptIndex <= stored.entry.attempt.ref.attemptIndex) {
      throw new UnifiedAgentRunContractError("attempt_conflict", "attempt index must increase monotonically");
    }
    if (!["succeeded", "failed", "cancelled", "timed_out"].includes(stored.entry.attempt.status)) {
      throw new UnifiedAgentRunContractError("attempt_conflict", "current attempt must be terminal before a retry");
    }

    const ref: UnifiedAttemptRef = {
      id: idFactory("attempt"),
      attemptIndex: input.attemptIndex,
      ownerToken: fence.ownerToken,
      attemptEpoch: fence.attemptEpoch,
    };
    const attempt: UnifiedRunAttempt = {
      ref,
      runtimeType: requiredString(input.runtimeType, "runtimeType"),
      model: input.model?.trim() || null,
      fallbackIndex: input.fallbackIndex ?? null,
      isFallback: input.isFallback ?? false,
      resumeSource: input.resumeSource,
      status: "started",
      submission: submissionFor(`${stored.entry.idempotencyKey}:attempt:${input.attemptIndex}`),
    };
    stored.attempts.set(input.attemptIndex, attempt);
    stored.entry.attempt = attempt;
    stored.entry.span.attemptRef = { ...ref };
    return { ok: true, value: cloneAttempt(attempt) };
  }

  function finishAttempt(
    runId: string,
    fence: UnifiedOwnerFence,
    status: Exclude<HeartbeatRunAttemptStatus, "started" | "waiting_for_network">,
    input: UnifiedAttemptFinishInput = {},
  ): UnifiedFenceResult<UnifiedRunAttempt> {
    const stored = find(runId);
    if (!stored) return { ok: false, reason: "run_not_found" };
    try {
      checkFence(stored, fence);
    } catch (error) {
      return { ok: false, reason: failureFrom(error) };
    }
    const currentSubmission = stored.entry.attempt.submission;
    stored.entry.attempt.submission = {
      ...currentSubmission,
      providerThreadId: input.providerThreadId?.trim() || currentSubmission.providerThreadId,
      providerTurnId: input.providerTurnId?.trim() || currentSubmission.providerTurnId,
      phase: input.submissionPhase ?? currentSubmission.phase,
    };
    stored.entry.attempt.status = status;
    stored.attempts.set(stored.entry.attempt.ref.attemptIndex, stored.entry.attempt);
    return { ok: true, value: cloneAttempt(stored.entry.attempt) };
  }

  function markAttemptWaiting(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedAttemptWaitingInput,
  ): UnifiedFenceResult<UnifiedRunAttempt> {
    const stored = find(runId);
    if (!stored) return { ok: false, reason: "run_not_found" };
    try {
      checkFence(stored, fence);
    } catch (error) {
      return { ok: false, reason: failureFrom(error) };
    }
    const currentSubmission = stored.entry.attempt.submission;
    stored.entry.attempt.submission = {
      ...currentSubmission,
      providerThreadId: input.providerThreadId?.trim() || currentSubmission.providerThreadId,
      providerTurnId: input.providerTurnId?.trim() || currentSubmission.providerTurnId,
      phase: input.submissionPhase ?? currentSubmission.phase,
      reason: input.error?.trim() || currentSubmission.reason,
    };
    stored.entry.attempt.status = "waiting_for_network";
    stored.attempts.set(stored.entry.attempt.ref.attemptIndex, stored.entry.attempt);
    return { ok: true, value: cloneAttempt(stored.entry.attempt) };
  }

  function acceptSubmission(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedSubmissionOutcome = {},
  ): UnifiedFenceResult<UnifiedSubmission> {
    const stored = find(runId);
    if (!stored) return { ok: false, reason: "run_not_found" };
    try {
      checkFence(stored, fence);
    } catch (error) {
      return { ok: false, reason: failureFrom(error) };
    }
    const key = submissionKeyFor(stored, input);
    ensureSubmissionKey(stored, key);
    const current = stored.entry.attempt.submission;
    if (current.state === "acceptance_unknown") {
      throw new UnifiedAgentRunContractError(
        "acceptance_unknown_requires_reconciliation",
        "provider acceptance is unknown; reconcile before accepting or retrying",
      );
    }
    if (current.state === "accepted") return { ok: true, value: cloneSubmission(current) };
    if (current.state === "rejected") {
      throw new UnifiedAgentRunContractError("attempt_conflict", "a rejected submission cannot be accepted later");
    }
    const accepted: UnifiedSubmission = {
      ...current,
      state: "accepted",
      phase: "accepted",
      retry: "not_allowed",
      providerThreadId: input.providerThreadId?.trim() || null,
      providerTurnId: input.providerTurnId?.trim() || null,
      reason: null,
    };
    setSubmission(stored, accepted);
    return { ok: true, value: cloneSubmission(accepted) };
  }

  function markAcceptanceUnknown(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedSubmissionOutcome & { phase?: Exclude<UnifiedSubmissionPhase, null> } = {},
  ): UnifiedFenceResult<UnifiedSubmission> {
    const stored = find(runId);
    if (!stored) return { ok: false, reason: "run_not_found" };
    try {
      checkFence(stored, fence);
    } catch (error) {
      return { ok: false, reason: failureFrom(error) };
    }
    const key = submissionKeyFor(stored, input);
    ensureSubmissionKey(stored, key);
    const current = stored.entry.attempt.submission;
    if (current.state === "accepted") return { ok: true, value: cloneSubmission(current) };
    if (current.state === "acceptance_unknown") return { ok: true, value: cloneSubmission(current) };
    const unknown: UnifiedSubmission = {
      ...current,
      state: "acceptance_unknown",
      phase: input.phase ?? "indeterminate",
      retry: "blocked_until_reconciled",
      providerThreadId: input.providerThreadId?.trim() || null,
      providerTurnId: input.providerTurnId?.trim() || null,
      reason: input.reason?.trim() || "provider acceptance could not be determined",
    };
    setSubmission(stored, unknown);
    return { ok: true, value: cloneSubmission(unknown) };
  }

  function reconcileAcceptance(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedSubmissionOutcome & { state: "accepted" | "rejected" },
  ): UnifiedFenceResult<UnifiedSubmission> {
    const stored = find(runId);
    if (!stored) return { ok: false, reason: "run_not_found" };
    try {
      checkFence(stored, fence);
    } catch (error) {
      return { ok: false, reason: failureFrom(error) };
    }
    const key = submissionKeyFor(stored, input);
    ensureSubmissionKey(stored, key);
    const current = stored.entry.attempt.submission;
    const confirmedPendingAcceptance = current.state === "pending" && input.state === "accepted";
    const confirmedPreSubmissionRejection = current.state === "pending"
      && current.phase === "pre_submission" && input.state === "rejected";
    if (current.state !== "acceptance_unknown" && current.state !== input.state
      && !confirmedPendingAcceptance && !confirmedPreSubmissionRejection) {
      throw new UnifiedAgentRunContractError("attempt_conflict", "submission reconciliation does not match current state");
    }
    const reconciled: UnifiedSubmission = {
      ...current,
      state: input.state,
      phase: input.state === "accepted" ? "accepted"
        : current.phase === "pre_submission" ? "pre_submission" : "indeterminate",
      retry: input.state === "accepted" ? "not_allowed" : "allowed",
      providerThreadId: input.providerThreadId?.trim() || current.providerThreadId,
      providerTurnId: input.providerTurnId?.trim() || current.providerTurnId,
      reason: input.state === "accepted" ? null : input.reason?.trim() || current.reason || "provider rejected submission",
    };
    setSubmission(stored, reconciled);
    return { ok: true, value: cloneSubmission(reconciled) };
  }

  function sealSpan(
    runId: string,
    fence: UnifiedOwnerFence,
    input: { completeness: UnifiedSpanCompleteness; sourceRevision?: string | null; visibilityCutoffRef?: string | null },
  ): UnifiedFenceResult<UnifiedRunSpan> {
    const stored = find(runId);
    if (!stored) return { ok: false, reason: "run_not_found" };
    try {
      checkFence(stored, fence);
    } catch (error) {
      return { ok: false, reason: failureFrom(error) };
    }
    stored.entry.span.state = input.completeness === "complete" ? "sealed" : "unresolved";
    stored.entry.span.completeness = input.completeness;
    stored.entry.span.sourceRevision = input.sourceRevision?.trim() || null;
    stored.entry.span.visibilityCutoffRef = input.visibilityCutoffRef?.trim() || null;
    return {
      ok: true,
      value: {
        ...stored.entry.span,
        attemptRef: stored.entry.span.attemptRef ? { ...stored.entry.span.attemptRef } : null,
        ownerFence: cloneFence(stored.entry.span.ownerFence),
      },
    };
  }

  function recordExecutionResult(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedNativeExecutionInput,
  ): UnifiedFenceResult<UnifiedRunSpan> {
    const complete = !input.error
      && !input.result.errorMessage
      && !input.result.timedOut
      && (input.result.exitCode ?? 0) === 0;
    return sealSpan(runId, fence, {
      completeness: input.suspended ? "partial" : complete ? "complete" : input.result.sessionId ? "partial" : "unknown",
      visibilityCutoffRef: input.visibilityCutoffRef,
    });
  }

  function finishRun(
    runId: string,
    fence: UnifiedOwnerFence,
    status: Exclude<UnifiedRunStatus, "running">,
    _input: UnifiedRunTerminalInput = {},
  ): UnifiedFenceResult<UnifiedAgentRunEntry> {
    const stored = find(runId);
    if (!stored) return { ok: false, reason: "run_not_found" };
    try {
      checkFence(stored, fence);
    } catch (error) {
      return { ok: false, reason: failureFrom(error) };
    }
    stored.entry.status = status;
    if (stored.entry.span.state === "open") {
      stored.entry.span.state = "unresolved";
      stored.entry.span.completeness = "unknown";
    }
    return { ok: true, value: cloneEntry(stored.entry) };
  }

  return {
    submit,
    get,
    renewLease,
    claimLease,
    beginAttempt,
    finishAttempt,
    markAttemptWaiting,
    acceptSubmission,
    markAcceptanceUnknown,
    reconcileAcceptance,
    sealSpan,
    recordExecutionResult,
    finishRun,
  };
}
