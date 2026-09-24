import type { Db } from "@rudderhq/db";
import {
  agents,
  heartbeatRunAttempts,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import type { HeartbeatRunAttemptStatus } from "@rudderhq/shared";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import {
  UnifiedAgentRunPersistenceContractError,
  type UnifiedAgentRunPersistenceErrorCode,
  type UnifiedNativeSpanResolverInput,
} from "./unified-agent-run.contracts.js";
import type {
  UnifiedAgentRunAdmission,
  UnifiedAgentRunEntry,
  UnifiedOwnerFence,
  UnifiedRunAttempt,
  UnifiedRunStatus,
  UnifiedSubmission,
  UnifiedSubmissionOutcome,
} from "./unified-agent-run.js";
import { UnifiedAgentRunContractError, normalizeUnifiedSessionIntent, UNIFIED_AGENT_RUN_SCENES } from "./unified-agent-run.js";
import {
  assertRuntimeIdentity,
  runtimeTypeFromSelector,
  type NativeSegmentRecord,
  type RuntimeBindingRecord,
} from "./native-session.js";
import { RUN_EXECUTION_LEASE_MS } from "./heartbeat.terminal.js";

export type UnifiedStoredAdmission = {
  version: 1;
  fingerprintVersion?: 2;
  agentId?: string;
  runtimeBindingId?: string | null;
  runtimeSegmentId?: string | null;
  scene: UnifiedAgentRunAdmission["scene"];
  targetType: UnifiedAgentRunAdmission["target"]["type"];
  targetId: string;
  idempotencyKey: string;
  runtimeType: string;
  model: string | null;
  sessionIntent: UnifiedAgentRunEntry["sessionIntent"];
  fingerprint: string;
  ownerFenceId?: string | null;
  lastOwnerToken?: string | null;
  attemptEpoch?: number;
  lastLeaseExpiresAt?: string | null;
};

export type UnifiedStoredSubmission = UnifiedSubmission;

export const UNIFIED_ADMISSION_CONTEXT_KEY = "unifiedAgentRun";
export const UNIFIED_SUBMISSION_CHECKPOINT_KEY = "unifiedSubmission";
export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UnifiedNativeSpanResolution = {
  binding: RuntimeBindingRecord;
  segment: NativeSegmentRecord;
  inputCorrelationRef?: string | null;
};

export function persistenceError(
  code: UnifiedAgentRunPersistenceErrorCode,
  message: string,
): UnifiedAgentRunPersistenceContractError {
  return new UnifiedAgentRunPersistenceContractError(code, message);
}

export function requiredPersistenceString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UnifiedAgentRunContractError("invalid_admission", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalProviderField(value: unknown, field = "provider reference"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new UnifiedAgentRunContractError("invalid_admission", `${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function assertPersistedRuntimeIdentity(input: {
  binding: RuntimeBindingRecord;
  segment: NativeSegmentRecord;
  driverRuntimeType: string;
  selectorRuntimeType?: unknown;
  context: string;
}) {
  try {
    return assertRuntimeIdentity({
      bindingRuntimeType: input.binding.runtimeType,
      segmentRuntimeType: input.segment.runtimeType,
      driverRuntimeType: input.driverRuntimeType,
      selectorRuntimeType: input.selectorRuntimeType,
      context: input.context,
    });
  } catch (error) {
    throw persistenceError(
      "contract",
      error instanceof Error ? error.message : `${input.context}: runtime identity is inconsistent`,
    );
  }
}

export async function loadNativeSpanIdentity(
  db: Db,
  input: {
    span: typeof runRuntimeSpans.$inferSelect;
    driverRuntimeType: string;
    context: string;
  },
) {
  const binding = await db
    .select()
    .from(runtimeBindings)
    .where(and(
      eq(runtimeBindings.id, input.span.bindingId),
      eq(runtimeBindings.orgId, input.span.orgId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const segment = await db
    .select()
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.id, input.span.segmentId),
      eq(nativeSegments.orgId, input.span.orgId),
      eq(nativeSegments.bindingId, input.span.bindingId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!binding || !segment) {
    throw persistenceError("contract", `${input.context} has no durable binding/segment identity`);
  }
  assertPersistedRuntimeIdentity({
    binding,
    segment,
    driverRuntimeType: input.driverRuntimeType,
    selectorRuntimeType: runtimeTypeFromSelector(input.span.selectorJson),
    context: input.context,
  });
  return { binding, segment };
}

function cloneJsonRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return value ? { ...value } : {};
}

function normalizeStoredSessionIntent(value: unknown): UnifiedAgentRunEntry["sessionIntent"] | null {
  const intent = asRecord(value);
  if (!intent || typeof intent.kind !== "string") return null;
  try {
    if (intent.kind === "fresh") {
      return normalizeUnifiedSessionIntent({ kind: "fresh" });
    }
    if (intent.kind === "resume") {
      return normalizeUnifiedSessionIntent({
        kind: "resume",
        reuseScope: intent.reuseScope as "explicit" | "task",
        sourceRunId: intent.sourceRunId as string | null,
        sessionId: intent.sessionId as string | null,
        sessionParams: intent.sessionParams as Record<string, unknown> | null,
      });
    }
    if (intent.kind === "fork") {
      return normalizeUnifiedSessionIntent({
        kind: "fork",
        sourceRunId: intent.sourceRunId as string,
        sourceBoundaryRef: intent.sourceBoundaryRef as string,
        sessionId: intent.sessionId as string | null,
        sessionParams: intent.sessionParams as Record<string, unknown> | null,
      });
    }
  } catch {
    return null;
  }
  return null;
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function assertPersistenceUuid(value: string, field: string) {
  if (!isUuid(value)) {
    throw persistenceError(
      "unsupported",
      `${field} must be a UUID because the heartbeat persistence schema uses uuid columns`,
    );
  }
}

export function normalizePersistenceAdmission(input: UnifiedAgentRunAdmission) {
  const orgId = requiredPersistenceString(input.orgId, "orgId");
  const agentId = requiredPersistenceString(input.agentId, "agentId");
  const idempotencyKey = requiredPersistenceString(input.idempotencyKey, "idempotencyKey");
  const runtimeType = requiredPersistenceString(input.runtimeType, "runtimeType");
  if (!UNIFIED_AGENT_RUN_SCENES.includes(input.scene)) {
    throw new UnifiedAgentRunContractError("invalid_scene", `unsupported run scene: ${String(input.scene)}`);
  }
  if (
    ![
      "issue",
      "chat_conversation",
      "chat_message",
      "automation_run",
      "wakeup_request",
      "manual",
      "review",
    ].includes(input.target.type)
    || typeof input.target.id !== "string"
    || input.target.id.trim().length === 0
  ) {
    throw new UnifiedAgentRunContractError("invalid_target", "run target type and id are required");
  }
  const target = { type: input.target.type, id: input.target.id.trim() };
  const sessionIntent = normalizeUnifiedSessionIntent(input.sessionIntent);
  const model = input.model?.trim() || null;
  const leaseMs = input.leaseMs ?? RUN_EXECUTION_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new UnifiedAgentRunContractError("invalid_admission", "leaseMs must be positive");
  }
  if (leaseMs !== RUN_EXECUTION_LEASE_MS) {
    throw persistenceError(
      "unsupported",
      `custom leaseMs ${leaseMs} is unsupported because heartbeat execution lease authority uses ${RUN_EXECUTION_LEASE_MS}ms`,
    );
  }
  assertPersistenceUuid(orgId, "orgId");
  assertPersistenceUuid(agentId, "agentId");
  if (target.type === "chat_conversation") assertPersistenceUuid(target.id, "target.id");
  if (sessionIntent.kind === "fork" && !isUuid(sessionIntent.sourceRunId)) {
    throw persistenceError(
      "unsupported",
      "fork sessionIntent.sourceRunId must be a UUID because heartbeat_runs.source_run_id is a UUID foreign key",
    );
  }
  if (sessionIntent.kind === "resume" && sessionIntent.sourceRunId && !isUuid(sessionIntent.sourceRunId)) {
    throw persistenceError(
      "unsupported",
      "resume sessionIntent.sourceRunId must be a UUID because heartbeat_runs.source_run_id is a UUID foreign key",
    );
  }
  const runtimeBindingId = input.runtimeBindingId?.trim() || null;
  const runtimeSegmentId = input.runtimeSegmentId?.trim() || null;
  if (runtimeBindingId) assertPersistenceUuid(runtimeBindingId, "runtimeBindingId");
  if (runtimeSegmentId) assertPersistenceUuid(runtimeSegmentId, "runtimeSegmentId");
  const fingerprint = JSON.stringify({ agentId, runtimeBindingId, runtimeSegmentId, scene: input.scene, target, runtimeType, model, sessionIntent });
  return {
    ...input,
    orgId,
    agentId,
    runtimeBindingId,
    runtimeSegmentId,
    idempotencyKey,
    runtimeType,
    target,
    model,
    sessionIntent,
    leaseMs,
    fingerprint,
  };
}

export function invocationSourceForScene(scene: UnifiedAgentRunAdmission["scene"]): string {
  switch (scene) {
    case "chat":
    case "side_chat":
      return "chat";
    case "review":
      return "review";
    case "automation":
      return "automation";
    case "delegation":
      return "delegation";
    case "issue":
    case "heartbeat":
      return "on_demand";
  }
}

export function sessionReuseScopeForIntent(
  intent: UnifiedAgentRunEntry["sessionIntent"],
): "explicit" | "task" | "none" {
  if (intent.kind === "fresh") return "none";
  return intent.reuseScope === "task" ? "task" : "explicit";
}

export function contextWithAdmission(
  existing: unknown,
  admission: UnifiedStoredAdmission,
): Record<string, unknown> {
  return {
    ...cloneJsonRecord(asRecord(existing)),
    scene: admission.scene,
    targetType: admission.targetType,
    targetId: admission.targetId,
    [UNIFIED_ADMISSION_CONTEXT_KEY]: admission,
  };
}

function readStoredAdmission(contextSnapshot: unknown): UnifiedStoredAdmission | null {
  const context = asRecord(contextSnapshot);
  const stored = asRecord(context?.[UNIFIED_ADMISSION_CONTEXT_KEY]);
  if (!stored) return null;
  if (stored.version !== 1) return null;
  if (
    typeof stored.scene !== "string"
    || typeof stored.targetType !== "string"
    || typeof stored.targetId !== "string"
    || typeof stored.idempotencyKey !== "string"
    || typeof stored.runtimeType !== "string"
    || typeof stored.fingerprint !== "string"
  ) return null;
  const normalizedIntent = normalizeStoredSessionIntent(stored.sessionIntent);
  if (!normalizedIntent) return null;
  return {
    version: 1,
    fingerprintVersion: stored.fingerprintVersion === 2 ? 2 : undefined,
    agentId: stringValue(stored.agentId) ?? undefined,
    runtimeBindingId: stringValue(stored.runtimeBindingId),
    runtimeSegmentId: stringValue(stored.runtimeSegmentId),
    scene: stored.scene as UnifiedAgentRunAdmission["scene"],
    targetType: stored.targetType as UnifiedAgentRunAdmission["target"]["type"],
    targetId: stored.targetId,
    idempotencyKey: stored.idempotencyKey,
    runtimeType: stored.runtimeType,
    model: stored.model === null || stored.model === undefined ? null : stringValue(stored.model),
    sessionIntent: normalizedIntent,
    fingerprint: stored.fingerprint,
    ownerFenceId: stringValue(stored.ownerFenceId),
    lastOwnerToken: stringValue(stored.lastOwnerToken),
    attemptEpoch: typeof stored.attemptEpoch === "number" ? stored.attemptEpoch : undefined,
    lastLeaseExpiresAt: stored.lastLeaseExpiresAt === null || stored.lastLeaseExpiresAt === undefined
      ? null
      : stringValue(stored.lastLeaseExpiresAt),
  };
}

export function readPersistedAdmission(run: typeof heartbeatRuns.$inferSelect): UnifiedStoredAdmission | null {
  const identityColumns = [
    run.scene,
    run.targetType,
    run.targetId,
    run.idempotencyKey,
    run.sessionIntentJson,
  ];
  const hasIdentityColumns = identityColumns.some((value) => value !== null && value !== undefined);
  if (!hasIdentityColumns) return null;
  if (
    typeof run.scene !== "string"
    || typeof run.targetType !== "string"
    || typeof run.targetId !== "string"
    || typeof run.idempotencyKey !== "string"
    || run.sessionIntentJson === null
    || run.sessionIntentJson === undefined
  ) return null;

  const stored = readStoredAdmission(run.contextSnapshot);
  if (!stored) return null;
  const sessionIntent = normalizeStoredSessionIntent(run.sessionIntentJson);
  if (!sessionIntent) return null;
  if (
    stored.scene !== run.scene
    || (stored.agentId !== undefined && stored.agentId !== run.agentId)
    || stored.targetType !== run.targetType
    || stored.targetId !== run.targetId
    || stored.idempotencyKey !== run.idempotencyKey
    || JSON.stringify(stored.sessionIntent) !== JSON.stringify(sessionIntent)
  ) {
    throw persistenceError(
      "contract",
      `heartbeat run ${run.id} compatibility admission disagrees with its durable identity columns`,
    );
  }
  return {
    ...stored,
    agentId: run.agentId,
    scene: run.scene as UnifiedAgentRunAdmission["scene"],
    targetType: run.targetType as UnifiedAgentRunAdmission["target"]["type"],
    targetId: run.targetId,
    idempotencyKey: run.idempotencyKey,
    sessionIntent,
  };
}

export function admissionMatches(
  stored: UnifiedStoredAdmission,
  admission: ReturnType<typeof normalizePersistenceAdmission>,
): boolean {
  return stored.scene === admission.scene
    && stored.agentId === admission.agentId
    && stored.targetType === admission.target.type
    && stored.targetId === admission.target.id
    && stored.idempotencyKey === admission.idempotencyKey
    && stored.runtimeType === admission.runtimeType;
}

function currentLeaseDate(run: typeof heartbeatRuns.$inferSelect, stored: UnifiedStoredAdmission): Date {
  if (run.executionLeaseExpiresAt) return new Date(run.executionLeaseExpiresAt);
  if (stored.lastLeaseExpiresAt) {
    const parsed = new Date(stored.lastLeaseExpiresAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(run.finishedAt ?? run.updatedAt ?? run.createdAt);
}

function unifiedRunStatus(status: string): UnifiedRunStatus {
  if (status === "running") return "running";
  if (status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out") {
    return status;
  }
  throw persistenceError("unsupported", `heartbeat run status ${status} cannot be represented by the unified run contract`);
}

function attemptStatus(status: string): HeartbeatRunAttemptStatus {
  if (["started", "waiting_for_network", "succeeded", "failed", "cancelled", "timed_out"].includes(status)) {
    return status as HeartbeatRunAttemptStatus;
  }
  throw persistenceError("unsupported", `heartbeat attempt status ${status} cannot be represented by the unified run contract`);
}

export function readSubmission(attempt: typeof heartbeatRunAttempts.$inferSelect): UnifiedStoredSubmission {
  const checkpoint = asRecord(attempt.checkpointJson);
  const submission = asRecord(checkpoint?.[UNIFIED_SUBMISSION_CHECKPOINT_KEY]);
  if (
    !submission
    || typeof submission.key !== "string"
    || !["pending", "accepted", "rejected", "acceptance_unknown"].includes(String(submission.state))
    || !["allowed", "blocked_until_reconciled", "not_allowed"].includes(String(submission.retry))
  ) {
    throw persistenceError(
      "contract",
      `attempt ${attempt.id} has no durable ${UNIFIED_SUBMISSION_CHECKPOINT_KEY} record; refusing to synthesize submission state in memory`,
    );
  }
  return {
    key: submission.key,
    state: submission.state as UnifiedSubmission["state"],
    phase: submission.phase === null || submission.phase === undefined
      ? null
      : submission.phase as UnifiedSubmission["phase"],
    retry: submission.retry as UnifiedSubmission["retry"],
    providerThreadId: optionalProviderField(submission.providerThreadId),
    providerTurnId: optionalProviderField(submission.providerTurnId),
    reason: submission.reason === null || submission.reason === undefined ? null : stringValue(submission.reason),
  };
}

export function unifiedAttemptFromRow(attempt: typeof heartbeatRunAttempts.$inferSelect): UnifiedRunAttempt {
  return {
    ref: {
      id: attempt.id,
      attemptIndex: attempt.attemptIndex,
      ownerToken: attempt.ownerToken,
      attemptEpoch: attempt.attemptEpoch,
    },
    runtimeType: attempt.runtimeType,
    model: attempt.model,
    fallbackIndex: attempt.fallbackIndex,
    isFallback: attempt.isFallback,
    resumeSource: attempt.resumeSource,
    status: attemptStatus(attempt.status),
    submission: readSubmission(attempt),
  };
}

export function checkpointWithSubmission(
  checkpointJson: unknown,
  submission: UnifiedStoredSubmission,
): Record<string, unknown> {
  return {
    ...cloneJsonRecord(asRecord(checkpointJson)),
    [UNIFIED_SUBMISSION_CHECKPOINT_KEY]: submission,
  };
}

export function providerField(value: string | null | undefined): string | null {
  return optionalProviderField(value);
}

export function submissionKeyFor(
  submission: UnifiedStoredSubmission,
  input?: UnifiedSubmissionOutcome,
): string {
  const key = input?.submissionKey?.trim() || submission.key;
  if (key !== submission.key) {
    throw new UnifiedAgentRunContractError(
      "attempt_conflict",
      `submission key ${key} does not match current attempt submission ${submission.key}`,
    );
  }
  return key;
}

export async function defaultNativeSpanResolver(
  input: UnifiedNativeSpanResolverInput,
): Promise<UnifiedNativeSpanResolution | null> {
  const agent = await input.db
    .select({ id: agents.id, agentRuntimeType: agents.agentRuntimeType })
    .from(agents)
    .where(and(
      eq(agents.id, input.admission.agentId),
      eq(agents.orgId, input.admission.orgId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!agent || agent.agentRuntimeType !== input.admission.runtimeType) {
    throw persistenceError(
      "contract",
      `agent ${input.admission.agentId} runtime identity does not match driver.runtimeType=${input.admission.runtimeType}`,
    );
  }
  const binding = input.admission.runtimeBindingId
    ? await input.db
      .select()
      .from(runtimeBindings)
      .where(and(
        eq(runtimeBindings.orgId, input.admission.orgId),
        eq(runtimeBindings.id, input.admission.runtimeBindingId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    : await input.db
      .select()
      .from(runtimeBindings)
      .where(and(
        eq(runtimeBindings.orgId, input.admission.orgId),
        input.admission.target.type === "chat_conversation"
          ? or(
            eq(runtimeBindings.conversationId, input.admission.target.id),
            and(
              eq(runtimeBindings.targetType, input.admission.target.type),
              eq(runtimeBindings.targetId, input.admission.target.id),
            ),
          )
          : and(
            eq(runtimeBindings.targetType, input.admission.target.type),
            eq(runtimeBindings.targetId, input.admission.target.id),
          ),
      ))
      .orderBy(desc(runtimeBindings.bindingEpoch), desc(runtimeBindings.createdAt), desc(runtimeBindings.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  if (!binding) return null;
  if (binding.agentId !== input.admission.agentId || binding.runtimeType !== input.admission.runtimeType) {
    throw persistenceError(
      "contract",
      `runtime binding ${binding.id} does not match the admitted agent/runtime identity`,
    );
  }
  const bindingTargetMatches = input.admission.target.type === "chat_conversation"
    ? (binding.targetType === null || binding.targetType === "chat_conversation")
      && binding.targetId !== null
      ? binding.targetId === input.admission.target.id
      : binding.conversationId === input.admission.target.id
    : binding.targetType === input.admission.target.type && binding.targetId === input.admission.target.id;
  if (!bindingTargetMatches) {
    throw persistenceError(
      "contract",
      `runtime binding ${binding.id} does not match target ${input.admission.target.type}/${input.admission.target.id}`,
    );
  }
  const requestedSegmentId = input.admission.runtimeSegmentId ?? binding.currentSegmentId;
  if (!requestedSegmentId) return null;
  let segment = await input.db
    .select()
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.id, requestedSegmentId),
      eq(nativeSegments.orgId, input.admission.orgId),
      eq(nativeSegments.bindingId, binding.id),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!segment) return null;
  if (segment.state === "superseded" || segment.state === "sealed") {
    throw persistenceError(
      "contract",
      `runtime binding ${binding.id} points at a ${segment.state} native segment`,
    );
  }
  assertPersistedRuntimeIdentity({
    binding,
    segment,
    driverRuntimeType: input.admission.runtimeType,
    context: `native span admission for ${binding.id}`,
  });
  if (input.admission.runtimeSegmentId && segment.state !== "pending" && segment.state !== "open") {
    throw persistenceError(
      "contract",
      `runtime segment ${segment.id} cannot accept a new span while it is ${segment.state}`,
    );
  }
  const intent = normalizeUnifiedSessionIntent(input.admission.sessionIntent);
  if (intent.sessionId) {
    if (segment.nativeSessionId && segment.nativeSessionId !== intent.sessionId) {
      throw persistenceError("contract", "admitted session identity differs from the bound native segment");
    }
    if (!segment.nativeSessionId) {
      // A provider-created fork already exists before prompt submission. Keep
      // its identity in the admission transaction, including failures before
      // the first provider turn, so retry/recovery resumes this exact child.
      const [bound] = await input.db.update(nativeSegments).set({
        nativeSessionId: intent.sessionId,
        rootSessionId: typeof intent.sessionParams?.rootSessionId === "string"
          ? intent.sessionParams.rootSessionId : intent.sessionId,
        providerStateJson: intent.sessionParams,
        sourceBoundaryRef: intent.kind === "fork" ? intent.sourceBoundaryRef : segment.sourceBoundaryRef,
        state: "open",
        updatedAt: new Date(),
      }).where(and(
        eq(nativeSegments.id, segment.id), eq(nativeSegments.orgId, input.admission.orgId),
        eq(nativeSegments.bindingId, binding.id), isNull(nativeSegments.nativeSessionId),
      )).returning();
      if (!bound) throw persistenceError("contract", "native segment identity changed during admission");
      segment = bound;
    }
  }
  return { binding, segment, inputCorrelationRef: input.admission.idempotencyKey };
}

export async function loadPersistedUnifiedEntry(db: Db, runId: string): Promise<UnifiedAgentRunEntry | null> {
  const run = await db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) return null;
  const admission = readPersistedAdmission(run);
  if (!admission) {
    throw persistenceError(
      "contract",
      `heartbeat run ${run.id} has no durable unified admission identity; refusing to infer scene/target/idempotency from a partial row`,
    );
  }
  const attempt = await db
    .select()
    .from(heartbeatRunAttempts)
    .where(and(
      eq(heartbeatRunAttempts.orgId, run.orgId),
      eq(heartbeatRunAttempts.runId, run.id),
    ))
    .orderBy(desc(heartbeatRunAttempts.attemptIndex))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!attempt) {
    throw persistenceError("contract", `heartbeat run ${run.id} has no durable attempt row`);
  }
  if (attempt.agentId !== run.agentId) {
    throw persistenceError("contract", `heartbeat run ${run.id} attempt is owned by a different agent`);
  }
  if (attempt.runtimeType !== admission.runtimeType) {
    throw persistenceError(
      "contract",
      `heartbeat run ${run.id} attempt.runtimeType=${attempt.runtimeType} does not match admission.runtimeType=${admission.runtimeType}`,
    );
  }
  const span = await db
    .select()
    .from(runRuntimeSpans)
    .where(and(
      eq(runRuntimeSpans.orgId, run.orgId),
      eq(runRuntimeSpans.runId, run.id),
    ))
    .orderBy(desc(runRuntimeSpans.ordinal))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!span) {
    throw persistenceError("contract", `heartbeat run ${run.id} has no durable native span row`);
  }
  const nativeIdentity = await loadNativeSpanIdentity(db, {
    span,
    driverRuntimeType: admission.runtimeType,
    context: `heartbeat run ${run.id} native span read`,
  });
  if (nativeIdentity.binding.agentId !== run.agentId) {
    throw persistenceError("contract", `heartbeat run ${run.id} native binding is owned by a different agent`);
  }
  if (!span.attemptId) {
    throw persistenceError("contract", `heartbeat run ${run.id} native span has no attempt binding`);
  }
  if (span.attemptId !== attempt.id) {
    throw persistenceError(
      "contract",
      `heartbeat run ${run.id} latest native span is not bound to its latest attempt`,
    );
  }
  if (
    span.orgId !== run.orgId
    || span.runId !== run.id
    || span.ownerToken.length === 0
    || span.attemptEpoch <= 0
  ) {
    throw persistenceError("contract", `heartbeat run ${run.id} native span has invalid organization or owner identity`);
  }
  const status = unifiedRunStatus(run.status);
  const ownerToken = run.executionOwnerToken ?? span.ownerToken ?? admission.lastOwnerToken;
  if (!ownerToken) {
    throw persistenceError("contract", `heartbeat run ${run.id} has no durable owner fence token`);
  }
  if (
    status === "running"
    && run.executionOwnerToken !== span.ownerToken
    && run.runningSubstate !== "waiting_for_network"
  ) {
    throw persistenceError("contract", `heartbeat run ${run.id} owner token and native span owner token diverged`);
  }
  const leaseExpiresAt = currentLeaseDate(run, admission);
  const ownerFence: UnifiedOwnerFence = {
    id: admission.ownerFenceId ?? span.id,
    ownerToken,
    attemptEpoch: span.attemptEpoch,
    leaseExpiresAt,
  };
  if (admission.ownerFenceId && admission.ownerFenceId !== span.id) {
    throw persistenceError("contract", `heartbeat run ${run.id} owner fence id is not the native span id`);
  }
  const unifiedAttempt = unifiedAttemptFromRow(attempt);
  return {
    runId: run.id,
    orgId: run.orgId,
    agentId: run.agentId,
    scene: admission.scene,
    target: { type: admission.targetType, id: admission.targetId },
    idempotencyKey: admission.idempotencyKey,
    sessionIntent: admission.sessionIntent,
    status,
    ownerFence,
    attempt: unifiedAttempt,
    span: {
      id: span.id,
      runId: span.runId,
      attemptRef: { id: attempt.id, attemptIndex: attempt.attemptIndex },
      ownerFence,
      state: span.state,
      completeness: span.completeness,
      sourceRevision: span.sourceRevision,
      visibilityCutoffRef: span.visibilityCutoffRef,
    },
  };
}

export async function findPersistedAdmissionRows(db: Db, admission: ReturnType<typeof normalizePersistenceAdmission>) {
  return db
    .select()
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.orgId, admission.orgId),
      eq(heartbeatRuns.idempotencyKey, admission.idempotencyKey),
    ));
}
