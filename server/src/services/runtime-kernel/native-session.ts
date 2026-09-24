import type { AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import type { Db, RuntimeBindingTargetType } from "@rudderhq/db";
import {
  heartbeatRunAttempts,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { and, asc, desc, eq, inArray, isNull, max, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { preserveNativeForkIntentProviderState } from "./native-fork-intent.js";

export type RuntimeDb = Pick<Db, "select" | "insert" | "update" | "execute">;

export type RuntimeBindingInput = {
  orgId: string;
  /** Required for Chat bindings; omitted for non-Chat target bindings. */
  conversationId?: string | null;
  /** Common Run target for Issue, Review, Automation, Heartbeat, and Chat. */
  target?: {
    type: RuntimeBindingTargetType;
    id: string;
  } | null;
  principalScopeRef?: string | null;
  agentId: string;
  runtimeType: string;
  hostId?: string | null;
  profileId?: string | null;
  workspaceBindingId?: string | null;
  instructionsRevision?: string | null;
  capabilityRevision?: string | null;
  continuity?: "native" | "context_handoff" | "legacy" | null;
  parentBindingId?: string | null;
  sourceBoundaryRef?: string | null;
};

export type RuntimeBindingRecord = typeof runtimeBindings.$inferSelect;
export type NativeSegmentRecord = typeof nativeSegments.$inferSelect;
export type RunRuntimeSpanRecord = typeof runRuntimeSpans.$inferSelect;

export type RuntimeBindingIdentitySnapshot = {
  version: 1;
  bindingId: string;
  bindingEpoch: number;
  orgId: string;
  principalScopeRef: string;
  agentId: string;
  runtimeType: string;
  hostId: string;
  profileId: string;
  workspaceBindingId: string | null;
  instructionsRevision: string;
  capabilityRevision: string;
};

export type RuntimeBindingIdentity = Omit<RuntimeBindingIdentitySnapshot, "version" | "bindingId" | "bindingEpoch">;

type RuntimeBindingTarget = {
  conversationId: string | null;
  targetType: RuntimeBindingTargetType;
  targetId: string;
};

function runtimeBindingTargetFromInput(input: RuntimeBindingInput): RuntimeBindingTarget {
  const conversationId = stringValue(input.conversationId);
  const explicit = input.target?.id && input.target.type
    ? { type: input.target.type, id: input.target.id.trim() }
    : null;
  if (explicit && explicit.id.length === 0) throw new Error("Runtime binding target id must not be empty");
  if (explicit?.type === "chat_conversation") {
    if (conversationId && conversationId !== explicit.id) {
      throw new Error("Chat runtime binding conversationId must match target.id");
    }
    return { conversationId: conversationId ?? explicit.id, targetType: explicit.type, targetId: explicit.id };
  }
  if (explicit) {
    if (conversationId) throw new Error("Non-Chat runtime binding cannot carry conversationId");
    return { conversationId: null, targetType: explicit.type, targetId: explicit.id };
  }
  if (conversationId) {
    return { conversationId, targetType: "chat_conversation", targetId: conversationId };
  }
  throw new Error("Runtime binding requires conversationId or a target");
}

export function runtimeBindingIdentityFromInput(input: RuntimeBindingInput): RuntimeBindingIdentity {
  return {
    orgId: input.orgId,
    principalScopeRef: stringValue(input.principalScopeRef) ?? `org:${input.orgId}`,
    agentId: stringValue(input.agentId) ?? input.agentId,
    runtimeType: stringValue(input.runtimeType) ?? input.runtimeType,
    hostId: stringValue(input.hostId) ?? "local",
    profileId: stringValue(input.profileId) ?? "default",
    workspaceBindingId: stringValue(input.workspaceBindingId),
    instructionsRevision: stringValue(input.instructionsRevision) ?? "unknown",
    capabilityRevision: stringValue(input.capabilityRevision) ?? "unknown",
  };
}

export function runtimeBindingIdentityFromRecord(binding: RuntimeBindingRecord): RuntimeBindingIdentity {
  return {
    orgId: binding.orgId,
    principalScopeRef: binding.principalScopeRef,
    agentId: binding.agentId,
    runtimeType: binding.runtimeType,
    hostId: binding.hostId,
    profileId: binding.profileId,
    workspaceBindingId: binding.workspaceBindingId,
    instructionsRevision: binding.instructionsRevision,
    capabilityRevision: binding.capabilityRevision,
  };
}

export function runtimeBindingIdentityChanged(
  binding: RuntimeBindingRecord,
  input: RuntimeBindingInput,
): boolean {
  const current = runtimeBindingIdentityFromRecord(binding);
  const next = runtimeBindingIdentityFromInput(input);
  return current.orgId !== next.orgId
    || current.principalScopeRef !== next.principalScopeRef
    || current.agentId !== next.agentId
    || current.runtimeType !== next.runtimeType
    || current.hostId !== next.hostId
    || current.profileId !== next.profileId
    || current.workspaceBindingId !== next.workspaceBindingId
    || current.instructionsRevision !== next.instructionsRevision
    || current.capabilityRevision !== next.capabilityRevision;
}

export function runtimeBindingSnapshot(binding: RuntimeBindingRecord): RuntimeBindingIdentitySnapshot {
  return {
    version: 1,
    bindingId: binding.id,
    bindingEpoch: binding.bindingEpoch,
    ...runtimeBindingIdentityFromRecord(binding),
  };
}

export function snapshotMatchesBinding(
  snapshot: RuntimeBindingIdentitySnapshot | null,
  binding: RuntimeBindingRecord,
): boolean {
  if (!snapshot || snapshot.version !== 1 || snapshot.bindingId !== binding.id || snapshot.bindingEpoch !== binding.bindingEpoch) {
    return false;
  }
  const identity = runtimeBindingIdentityFromRecord(binding);
  return Object.keys(identity).every((key) => {
    const typedKey = key as keyof RuntimeBindingIdentity;
    return snapshot[typedKey] === identity[typedKey];
  });
}

export type NativeSessionState = {
  binding: RuntimeBindingRecord;
  segment: NativeSegmentRecord;
  sessionId: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
};

export type RuntimeSpanLease = {
  id: string;
  ownerToken: string;
  attemptEpoch: number;
};

type RunOwnerInput = {
  orgId: string;
  runId: string;
  ownerToken: string;
};

/**
 * Run terminal transitions and runtime-span writes must share the same
 * transaction advisory lock. Otherwise a worker can pass the span predicate,
 * lose the Run lease, and still mutate the binding before its final CAS.
 */
async function selectActiveRunOwner(db: RuntimeDb, input: RunOwnerInput) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${input.runId}))`);
  const run = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      executionOwnerToken: heartbeatRuns.executionOwnerToken,
      executionLeaseExpiresAt: heartbeatRuns.executionLeaseExpiresAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.orgId, input.orgId),
      eq(heartbeatRuns.executionOwnerToken, input.ownerToken),
      eq(heartbeatRuns.status, "running"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) return null;
  if (run.executionLeaseExpiresAt && run.executionLeaseExpiresAt.getTime() <= Date.now()) return null;
  return run;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export class RuntimeIdentityContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeIdentityContractError";
  }
}

export type RuntimeIdentityAssertionInput = {
  bindingRuntimeType: unknown;
  segmentRuntimeType: unknown;
  driverRuntimeType: unknown;
  selectorRuntimeType?: unknown;
  context?: string;
};

function requiredRuntimeType(value: unknown, field: string): string {
  const runtimeType = stringValue(value);
  if (!runtimeType) {
    throw new RuntimeIdentityContractError(`${field} must be a non-empty runtime type`);
  }
  return runtimeType;
}

/** Resolve the runtime identity encoded by a persisted native span selector. */
export function runtimeTypeFromSelector(value: unknown): string | null {
  const selector = jsonRecord(value);
  if (!selector) return null;
  const declared = stringValue(selector.runtimeType);
  if (declared) return declared;
  switch (selector.kind) {
    case "codex_turn":
      return "codex_local";
    case "claude_chain":
      return "claude_local";
    case "hermes_execution":
      return "hermes_gateway";
    case "opencode_input":
      return "opencode_local";
    case "pi_branch_range":
      return "pi_local";
    case "cursor_execution":
      return "cursor";
    default:
      return null;
  }
}

/**
 * A provider driver may only operate on a segment from the binding that
 * authorized that same runtime. Missing identity is corruption, not a
 * compatibility case, so every caller fails closed.
 */
export function assertRuntimeIdentity(input: RuntimeIdentityAssertionInput) {
  const bindingRuntimeType = requiredRuntimeType(input.bindingRuntimeType, "binding.runtimeType");
  const segmentRuntimeType = requiredRuntimeType(input.segmentRuntimeType, "segment.runtimeType");
  const driverRuntimeType = requiredRuntimeType(input.driverRuntimeType, "driver.runtimeType");
  const selectorRuntimeType = input.selectorRuntimeType === undefined || input.selectorRuntimeType === null
    ? null
    : requiredRuntimeType(input.selectorRuntimeType, "selector.runtimeType");
  if (
    bindingRuntimeType !== segmentRuntimeType
    || segmentRuntimeType !== driverRuntimeType
    || (selectorRuntimeType !== null && selectorRuntimeType !== driverRuntimeType)
  ) {
    const selectorDetail = selectorRuntimeType === null ? "" : `, selector.runtimeType=${selectorRuntimeType}`;
    const context = input.context?.trim() ? `${input.context.trim()}: ` : "";
    throw new RuntimeIdentityContractError(
      `${context}runtime identity mismatch (binding.runtimeType=${bindingRuntimeType}, segment.runtimeType=${segmentRuntimeType}, driver.runtimeType=${driverRuntimeType}${selectorDetail})`,
    );
  }
  return {
    bindingRuntimeType,
    segmentRuntimeType,
    driverRuntimeType,
    selectorRuntimeType,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function revisionForRuntimeConfig(config: Record<string, unknown>, excludedKeys: string[] = []) {
  const excluded = new Set(excludedKeys);
  const filtered = Object.fromEntries(Object.entries(config).filter(([key]) => !excluded.has(key)));
  return createHash("sha256").update(stableJson(filtered)).digest("hex");
}

function providerResult(result: AgentRuntimeExecutionResult): Record<string, unknown> {
  return jsonRecord(result.resultJson) ?? {};
}

function providerString(result: AgentRuntimeExecutionResult, keys: string[]): string | null {
  const payload = providerResult(result);
  const sources: unknown[] = [payload, payload.provider, payload.session, payload.execution, payload.result];
  for (const source of sources) {
    const record = jsonRecord(source);
    if (!record) continue;
    for (const key of keys) {
      const value = stringValue(record[key]);
      if (value) return value;
    }
  }
  return null;
}

export function nativeSessionIdFromResult(result: AgentRuntimeExecutionResult) {
  return stringValue(result.sessionId)
    ?? stringValue(jsonRecord(result.sessionParams)?.sessionId)
    ?? stringValue(jsonRecord(result.sessionParams)?.threadId)
    ?? providerString(result, ["providerSessionId", "sessionId", "threadId", "thread_id"]);
}

function nativeExecutionRefFromResult(result: AgentRuntimeExecutionResult) {
  return providerString(result, [
    "providerTurnId",
    "turnId",
    "turn_id",
    "executionId",
    "execution_id",
    "providerRunId",
    "upstreamRunId",
    "runId",
    "messageId",
    "message_id",
  ]);
}

export function selectorForRuntime(input: {
  runtimeType: string;
  sessionId: string;
  executionRef: string | null;
  inputCorrelationRef: string | null;
  runId: string;
  result: AgentRuntimeExecutionResult;
}) {
  const terminalRef = nativeExecutionRefFromResult(input.result);
  switch (input.runtimeType) {
    case "codex_local":
      return {
        kind: "codex_turn",
        threadId: input.sessionId,
        turnId: input.executionRef ?? terminalRef,
        inputCorrelationRef: input.inputCorrelationRef,
        runId: input.runId,
      };
    case "claude_local":
      return {
        kind: "claude_chain",
        sessionId: input.sessionId,
        startExclusiveUuid: providerString(input.result, ["startExclusiveUuid"]),
        throughInclusiveUuid: input.executionRef ?? terminalRef,
        boundaryStatus: stringValue(jsonRecord(providerResult(input.result).transcriptBoundary)?.status),
        inputCorrelationRef: input.inputCorrelationRef,
      };
    case "hermes_gateway":
    case "hermes_local":
      {
        const transcriptBoundary = jsonRecord(providerResult(input.result).transcriptBoundary);
        return {
          kind: "hermes_execution",
          sessionRef: input.sessionId,
          providerExecutionRef: input.executionRef ?? terminalRef,
          sourceRangeRef: stringValue(transcriptBoundary?.sourceRangeRef),
          boundaryStatus: stringValue(transcriptBoundary?.status),
          inputCorrelationRef: input.inputCorrelationRef,
        };
      }
    case "opencode_local":
      return {
        kind: "opencode_input",
        sessionId: input.sessionId,
        userMessageId: providerString(input.result, ["userMessageId"]) ?? input.inputCorrelationRef,
        terminalMessageIds: [input.executionRef ?? terminalRef].filter((value): value is string => Boolean(value)),
      };
    case "pi_local":
      return {
        kind: "pi_branch_range",
        sessionResourceRef: input.sessionId,
        fromExclusive: providerString(input.result, ["previousLeafId", "previous_leaf_id"]),
        throughInclusive: input.executionRef ?? terminalRef,
        leafId: providerString(input.result, ["leafId", "leaf_id"]),
        inputCorrelationRef: input.inputCorrelationRef,
      };
    case "cursor":
      return {
        kind: "cursor_execution",
        sessionId: input.sessionId,
        executionRef: input.executionRef ?? terminalRef,
        nativeRangeRef: null,
        inputCorrelationRef: input.inputCorrelationRef,
      };
    default:
      return {
        kind: "native_execution",
        runtimeType: input.runtimeType,
        sessionId: input.sessionId,
        executionRef: input.executionRef ?? terminalRef,
        inputCorrelationRef: input.inputCorrelationRef,
        runId: input.runId,
      };
  }
}

async function selectBinding(
  db: RuntimeDb,
  input: Pick<RuntimeBindingInput, "orgId" | "conversationId" | "target">,
  options: { activeOnly?: boolean } = {},
) {
  const target = runtimeBindingTargetFromInput(input as RuntimeBindingInput);
  const predicates = [
    eq(runtimeBindings.orgId, input.orgId),
    target.targetType === "chat_conversation"
      ? or(
        target.conversationId
          ? eq(runtimeBindings.conversationId, target.conversationId)
          : undefined,
        and(eq(runtimeBindings.targetType, target.targetType), eq(runtimeBindings.targetId, target.targetId)),
      )
      : and(eq(runtimeBindings.targetType, target.targetType), eq(runtimeBindings.targetId, target.targetId)),
    ...(options.activeOnly ? [eq(runtimeBindings.status, "active" as const)] : []),
  ];
  return db
    .select()
    .from(runtimeBindings)
    .where(and(...predicates))
    .orderBy(desc(runtimeBindings.bindingEpoch), desc(runtimeBindings.createdAt), desc(runtimeBindings.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function persistedSpanRuntimeIdentity(
  db: RuntimeDb,
  input: {
    orgId: string;
    span: RunRuntimeSpanRecord;
    driverRuntimeType: string;
    context: string;
  },
) {
  const binding = await db
    .select()
    .from(runtimeBindings)
    .where(and(
      eq(runtimeBindings.id, input.span.bindingId),
      eq(runtimeBindings.orgId, input.orgId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const segment = await db
    .select()
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.id, input.span.segmentId),
      eq(nativeSegments.orgId, input.orgId),
      eq(nativeSegments.bindingId, input.span.bindingId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!binding || !segment) return null;
  assertRuntimeIdentity({
    bindingRuntimeType: binding.runtimeType,
    segmentRuntimeType: segment.runtimeType,
    driverRuntimeType: input.driverRuntimeType,
    selectorRuntimeType: runtimeTypeFromSelector(input.span.selectorJson),
    context: input.context,
  });
  return { binding, segment };
}

export async function ensureRuntimeBinding(db: RuntimeDb, input: RuntimeBindingInput): Promise<RuntimeBindingRecord> {
  const target = runtimeBindingTargetFromInput(input);
  const identity = runtimeBindingIdentityFromInput(input);
  return (db as Db).transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.orgId}:${target.targetType}:${target.targetId}`}, 0))`);
    const txDb = tx as unknown as RuntimeDb;
    const existing = await selectBinding(txDb, input, { activeOnly: true });
    const latest = existing ?? await selectBinding(txDb, input);
    if (existing && !runtimeBindingIdentityChanged(existing, input)) return existing;

    const bindingEpoch = latest ? latest.bindingEpoch + 1 : 0;
    const parentBindingId = existing?.id ?? stringValue(input.parentBindingId);
    const continuity = latest
      ? input.continuity === "legacy" ? "legacy" as const : "context_handoff" as const
      : input.continuity ?? (parentBindingId ? "context_handoff" : "native");

    if (existing) {
      const [superseded] = await txDb
        .update(runtimeBindings)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(and(
          eq(runtimeBindings.id, existing.id),
          eq(runtimeBindings.orgId, input.orgId),
          eq(runtimeBindings.status, "active"),
        ))
        .returning({ id: runtimeBindings.id });
      if (!superseded) {
        const raced = await selectBinding(txDb, input, { activeOnly: true });
        if (raced && !runtimeBindingIdentityChanged(raced, input)) return raced;
        throw new Error("Runtime binding identity changed concurrently");
      }
    }

    const [created] = await txDb
      .insert(runtimeBindings)
      .values({
        orgId: input.orgId,
        conversationId: target.conversationId,
        targetType: target.targetType,
        targetId: target.targetId,
        principalScopeRef: identity.principalScopeRef,
        agentId: identity.agentId,
        runtimeType: identity.runtimeType,
        hostId: identity.hostId,
        profileId: identity.profileId,
        workspaceBindingId: identity.workspaceBindingId,
        instructionsRevision: identity.instructionsRevision,
        capabilityRevision: identity.capabilityRevision,
        continuity,
        parentBindingId,
        sourceBoundaryRef: stringValue(input.sourceBoundaryRef),
        bindingEpoch,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const raced = await selectBinding(txDb, input, { activeOnly: true });
    if (raced && !runtimeBindingIdentityChanged(raced, input)) return raced;
    throw new Error("Failed to create immutable runtime binding epoch; active conversation binding already exists");
  });
}

async function ensurePendingSegment(db: RuntimeDb, binding: RuntimeBindingRecord): Promise<NativeSegmentRecord> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`runtime-binding:${binding.id}`}, 0))`);
  if (binding.currentSegmentId) {
    const current = await db
      .select()
      .from(nativeSegments)
      .where(and(
        eq(nativeSegments.id, binding.currentSegmentId),
        eq(nativeSegments.orgId, binding.orgId),
        eq(nativeSegments.bindingId, binding.id),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (current) {
      assertRuntimeIdentity({
        bindingRuntimeType: binding.runtimeType,
        segmentRuntimeType: current.runtimeType,
        driverRuntimeType: binding.runtimeType,
        context: `binding ${binding.id} current segment`,
      });
    }
    if (current && ["pending", "open"].includes(current.state)) return current;
    if (current) {
      const [handoff] = await db
        .insert(nativeSegments)
        .values({
          orgId: binding.orgId,
          bindingId: binding.id,
          runtimeType: binding.runtimeType,
          parentSegmentId: current.id,
          sourceBoundaryRef: current.nativeSessionId,
          segmentOrdinal: current.segmentOrdinal + 1,
          state: "pending",
        })
        .returning();
      if (handoff) {
        await db.update(runtimeBindings).set({ currentSegmentId: handoff.id, updatedAt: new Date() }).where(eq(runtimeBindings.id, binding.id));
        return handoff;
      }
    }
  }

  const [latest] = await db
    .select()
    .from(nativeSegments)
    .where(and(eq(nativeSegments.bindingId, binding.id), inArray(nativeSegments.state, ["pending", "open"])))
      .orderBy(desc(nativeSegments.segmentOrdinal))
      .limit(1);
  if (latest) {
    assertRuntimeIdentity({
      bindingRuntimeType: binding.runtimeType,
      segmentRuntimeType: latest.runtimeType,
      driverRuntimeType: binding.runtimeType,
      context: `binding ${binding.id} pending segment`,
    });
    await db.update(runtimeBindings)
      .set({ currentSegmentId: latest.id, updatedAt: new Date() })
      .where(and(eq(runtimeBindings.id, binding.id), eq(runtimeBindings.orgId, binding.orgId)));
    return latest;
  }

  const [maxOrdinal] = await db
    .select({ value: max(nativeSegments.segmentOrdinal) })
    .from(nativeSegments)
    .where(eq(nativeSegments.bindingId, binding.id));
  const [created] = await db
    .insert(nativeSegments)
    .values({
      orgId: binding.orgId,
      bindingId: binding.id,
      runtimeType: binding.runtimeType,
      segmentOrdinal: Number(maxOrdinal?.value ?? -1) + 1,
      state: "pending",
    })
    .returning();
  if (!created) throw new Error("Failed to create native runtime segment");
  const [updated] = await db
    .update(runtimeBindings)
    .set({ currentSegmentId: created.id, updatedAt: new Date() })
    .where(eq(runtimeBindings.id, binding.id))
    .returning();
  return updated?.currentSegmentId === created.id ? created : created;
}

export async function currentNativeSession(db: Db, binding: RuntimeBindingRecord): Promise<NativeSessionState> {
  const segment = await db.transaction(async (tx) => ensurePendingSegment(tx as unknown as RuntimeDb, binding));
  assertRuntimeIdentity({
    bindingRuntimeType: binding.runtimeType,
    segmentRuntimeType: segment.runtimeType,
    driverRuntimeType: binding.runtimeType,
    context: `binding ${binding.id} native session`,
  });
  const params = segment.providerStateJson ?? null;
  return {
    binding,
    segment,
    sessionId: segment.nativeSessionId,
    sessionParams: params,
    sessionDisplayId: segment.nativeSessionId,
  };
}

/** Read an already-materialized provider session without creating a pending segment. */
export async function existingNativeSession(db: Db, binding: RuntimeBindingRecord): Promise<NativeSessionState | null> {
  if (!binding.currentSegmentId) return null;
  const segment = await db
    .select()
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.id, binding.currentSegmentId),
      eq(nativeSegments.orgId, binding.orgId),
      eq(nativeSegments.bindingId, binding.id),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!segment?.nativeSessionId) return null;
  assertRuntimeIdentity({
    bindingRuntimeType: binding.runtimeType,
    segmentRuntimeType: segment.runtimeType,
    driverRuntimeType: binding.runtimeType,
    context: `binding ${binding.id} existing native session`,
  });
  return {
    binding,
    segment,
    sessionId: segment.nativeSessionId,
    sessionParams: segment.providerStateJson ?? null,
    sessionDisplayId: segment.nativeSessionId,
  };
}

type StartRunRuntimeSpanInput = {
  orgId: string;
  runId: string;
  binding: RuntimeBindingRecord;
  segment: NativeSegmentRecord;
  /** Runtime type of the concrete driver admitting this span. */
  runtimeType: string;
  attemptRef: string;
  attemptId?: string | null;
  attemptEpoch?: number;
  ownerToken: string;
  inputCorrelationRef: string | null;
  relation?: "primary" | "continuation" | "native_subagent";
};

export async function startRunRuntimeSpanInTransaction(db: RuntimeDb, input: StartRunRuntimeSpanInput) {
  if (input.binding.orgId !== input.orgId || input.segment.orgId !== input.orgId || input.segment.bindingId !== input.binding.id) {
    throw new RuntimeIdentityContractError("span create: binding and segment organization/binding identity is inconsistent");
  }
  assertRuntimeIdentity({
    bindingRuntimeType: input.binding.runtimeType,
    segmentRuntimeType: input.segment.runtimeType,
    driverRuntimeType: input.runtimeType,
    context: "span create",
  });
  const persistedBinding = await db
    .select()
    .from(runtimeBindings)
    .where(and(
      eq(runtimeBindings.id, input.binding.id),
      eq(runtimeBindings.orgId, input.orgId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const persistedSegment = await db
    .select()
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.id, input.segment.id),
      eq(nativeSegments.orgId, input.orgId),
      eq(nativeSegments.bindingId, input.binding.id),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!persistedBinding || !persistedSegment) {
    throw new RuntimeIdentityContractError("span create: binding or segment identity is not durable");
  }
  assertRuntimeIdentity({
    bindingRuntimeType: persistedBinding.runtimeType,
    segmentRuntimeType: persistedSegment.runtimeType,
    driverRuntimeType: input.runtimeType,
    context: "span create persisted identity",
  });
  if (input.attemptId) {
    const attempt = await db
      .select({ runtimeType: heartbeatRunAttempts.runtimeType })
      .from(heartbeatRunAttempts)
      .where(and(
        eq(heartbeatRunAttempts.id, input.attemptId),
        eq(heartbeatRunAttempts.orgId, input.orgId),
        eq(heartbeatRunAttempts.runId, input.runId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!attempt || attempt.runtimeType !== input.runtimeType) {
      throw new RuntimeIdentityContractError(
        `span create: attempt.runtimeType=${attempt?.runtimeType ?? "<missing>"} does not match driver.runtimeType=${input.runtimeType}`,
      );
    }
  }
  if (!await selectActiveRunOwner(db, input)) {
    throw new Error("Cannot start a runtime span without the active Run owner lease");
  }
  const ordinal = await db
    .select({ value: max(runRuntimeSpans.ordinal) })
    .from(runRuntimeSpans)
    .where(and(eq(runRuntimeSpans.orgId, input.orgId), eq(runRuntimeSpans.runId, input.runId)))
    .then((rows) => Number(rows[0]?.value ?? -1) + 1);
  const [span] = await db
    .insert(runRuntimeSpans)
    .values({
      orgId: input.orgId,
      runId: input.runId,
      bindingId: input.binding.id,
      segmentId: input.segment.id,
      attemptId: input.attemptId ?? null,
      attemptRef: input.attemptRef,
      attemptEpoch: input.attemptEpoch ?? 1,
      ownerToken: input.ownerToken,
      ordinal,
      relation: input.relation ?? "primary",
      inputCorrelationRef: input.inputCorrelationRef,
      selectorJson: {
        kind: "pending",
        runtimeType: input.binding.runtimeType,
        inputCorrelationRef: input.inputCorrelationRef,
      },
      state: "open",
      completeness: "unknown",
    })
    .returning();
  if (!span) throw new Error("Failed to create Run runtime span");
  return span;
}

export async function startRunRuntimeSpan(db: Db, input: StartRunRuntimeSpanInput) {
  return db.transaction(async (tx) => startRunRuntimeSpanInTransaction(tx as unknown as RuntimeDb, input));
}

export async function findOpenRunRuntimeSpan(db: RuntimeDb, input: {
  orgId: string;
  runId: string;
  ownerToken: string;
  runtimeType: string;
  attemptEpoch?: number;
}) {
  const span = await db
    .select()
    .from(runRuntimeSpans)
    .where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.runId, input.runId),
      eq(runRuntimeSpans.ownerToken, input.ownerToken),
      eq(runRuntimeSpans.state, "open"),
      ...(input.attemptEpoch === undefined ? [] : [eq(runRuntimeSpans.attemptEpoch, input.attemptEpoch)]),
    ))
    .orderBy(desc(runRuntimeSpans.ordinal))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!span) return null;
  const identity = await persistedSpanRuntimeIdentity(db, {
    orgId: input.orgId,
    span,
    driverRuntimeType: input.runtimeType,
    context: "open span read",
  });
  return identity ? span : null;
}

/** Claim the still-open span after a durable network wait or process restart. */
export async function claimOpenRunRuntimeSpan(db: Db, input: RunOwnerInput & { runtimeType: string; attemptEpoch?: number }) {
  return db.transaction(async (tx) => {
    if (!await selectActiveRunOwner(tx as unknown as RuntimeDb, input)) return null;
    const span = await tx
      .select()
      .from(runRuntimeSpans)
      .where(and(
        eq(runRuntimeSpans.orgId, input.orgId),
        eq(runRuntimeSpans.runId, input.runId),
        eq(runRuntimeSpans.state, "open"),
      ))
      .orderBy(desc(runRuntimeSpans.ordinal))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!span) return null;
    const identity = await persistedSpanRuntimeIdentity(tx as unknown as RuntimeDb, {
      orgId: input.orgId,
      span,
      driverRuntimeType: input.runtimeType,
      context: "open span claim",
    });
    if (!identity) return null;
    if (!span.attemptId) return null;
    const attempt = await tx
      .select({ runtimeType: heartbeatRunAttempts.runtimeType })
      .from(heartbeatRunAttempts)
      .where(and(
        eq(heartbeatRunAttempts.id, span.attemptId),
        eq(heartbeatRunAttempts.orgId, input.orgId),
        eq(heartbeatRunAttempts.runId, input.runId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!attempt || attempt.runtimeType !== input.runtimeType) {
      throw new RuntimeIdentityContractError(
        `open span claim: attempt.runtimeType=${attempt?.runtimeType ?? "<missing>"} does not match driver.runtimeType=${input.runtimeType}`,
      );
    }
    const [claimed] = await tx
      .update(runRuntimeSpans)
      .set({
        ownerToken: input.ownerToken,
        attemptEpoch: input.attemptEpoch ?? span.attemptEpoch + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(runRuntimeSpans.id, span.id),
        eq(runRuntimeSpans.orgId, input.orgId),
        eq(runRuntimeSpans.runId, input.runId),
        eq(runRuntimeSpans.state, "open"),
      ))
      .returning();
    return claimed ?? null;
  });
}

export async function bindRunRuntimeSpanAttempt(db: RuntimeDb, input: {
  orgId: string;
  runId: string;
  spanId?: string | null;
  ownerToken: string;
  runtimeType: string;
  attemptEpoch?: number;
  attemptId: string;
}) {
  if (!await selectActiveRunOwner(db, input)) return null;
  const attempt = await db
    .select({ id: heartbeatRunAttempts.id, runtimeType: heartbeatRunAttempts.runtimeType })
    .from(heartbeatRunAttempts)
    .where(and(
      eq(heartbeatRunAttempts.id, input.attemptId),
      eq(heartbeatRunAttempts.orgId, input.orgId),
      eq(heartbeatRunAttempts.runId, input.runId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!attempt) return null;
  const span = await db
    .select()
    .from(runRuntimeSpans)
    .where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.runId, input.runId),
      ...(input.spanId ? [eq(runRuntimeSpans.id, input.spanId)] : []),
      eq(runRuntimeSpans.ownerToken, input.ownerToken),
      eq(runRuntimeSpans.state, "open"),
    ))
    .orderBy(desc(runRuntimeSpans.ordinal))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!span) return null;
  const identity = await persistedSpanRuntimeIdentity(db, {
    orgId: input.orgId,
    span,
    driverRuntimeType: input.runtimeType,
    context: "span attempt bind",
  });
  if (!identity || attempt.runtimeType !== input.runtimeType) {
    throw new RuntimeIdentityContractError(
      `span attempt bind: attempt.runtimeType=${attempt.runtimeType} does not match driver.runtimeType=${input.runtimeType}`,
    );
  }
  const [updated] = await db
    .update(runRuntimeSpans)
    .set({
      attemptId: input.attemptId,
      attemptEpoch: input.attemptEpoch ?? 1,
      updatedAt: new Date(),
    })
    .where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.runId, input.runId),
      ...(input.spanId ? [eq(runRuntimeSpans.id, input.spanId)] : []),
      eq(runRuntimeSpans.ownerToken, input.ownerToken),
      eq(runRuntimeSpans.state, "open"),
    ))
    .returning();
  return updated ?? null;
}

/** Attach only an already durable supplement while the exact attempt owns the
 * open span. A stale worker may leave an unreferenced object, never replace the
 * current owner's history. Terminal transitions take the same advisory lock. */
export async function attachRuntimeSpanSupplement(db: Db, input: {
  orgId: string;
  runId: string;
  spanId: string;
  ownerToken: string;
  attemptEpoch: number;
  objectRef: string;
}) {
  if (!input.objectRef.trim()) throw new Error("Transcript supplement reference is required");
  return db.transaction(async (tx) => {
    if (!await selectActiveRunOwner(tx as unknown as RuntimeDb, input)) return null;
    const [span] = await tx.update(runRuntimeSpans).set({
      supplementalObjectRef: input.objectRef,
      updatedAt: new Date(),
    }).where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.runId, input.runId),
      eq(runRuntimeSpans.id, input.spanId),
      eq(runRuntimeSpans.ownerToken, input.ownerToken),
      eq(runRuntimeSpans.attemptEpoch, input.attemptEpoch),
      eq(runRuntimeSpans.state, "open"),
      or(isNull(runRuntimeSpans.supplementalObjectRef), eq(runRuntimeSpans.supplementalObjectRef, input.objectRef)),
    )).returning();
    if (span) return span;
    // Another service instance may have attached the authoritative object
    // after allocation. Return that winner instead of replacing its evidence.
    return tx.select().from(runRuntimeSpans).where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.runId, input.runId),
      eq(runRuntimeSpans.id, input.spanId),
      eq(runRuntimeSpans.ownerToken, input.ownerToken),
      eq(runRuntimeSpans.attemptEpoch, input.attemptEpoch),
      eq(runRuntimeSpans.state, "open"),
    )).limit(1).then((rows) => rows[0] ?? null);
  });
}

export async function finishRunRuntimeSpan(db: Db, input: {
  orgId: string;
  runId: string;
  spanId?: string | null;
  ownerToken: string;
  runtimeType: string;
  attemptEpoch?: number;
  result: AgentRuntimeExecutionResult;
  error?: boolean;
  suspended?: boolean;
  visibilityCutoffRef?: string | null;
  /** Terminal callers with an activity CAS must not advance the Run watermark before that CAS. */
  touchRunActivity?: boolean;
}) {
  return db.transaction(async (tx) => {
    if (!await selectActiveRunOwner(tx as unknown as RuntimeDb, input)) return null;
    let span = await tx
      .select()
      .from(runRuntimeSpans)
      .where(and(
        eq(runRuntimeSpans.orgId, input.orgId),
        eq(runRuntimeSpans.runId, input.runId),
        ...(input.spanId ? [eq(runRuntimeSpans.id, input.spanId)] : []),
        eq(runRuntimeSpans.ownerToken, input.ownerToken),
        eq(runRuntimeSpans.state, "open"),
        ...(input.attemptEpoch === undefined ? [] : [eq(runRuntimeSpans.attemptEpoch, input.attemptEpoch)]),
      ))
      .orderBy(desc(runRuntimeSpans.ordinal))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!span) {
      // Terminal transition may have sealed the span before losing its Run
      // watermark CAS. Treat a matching sealed span as an idempotent finish
      // so a later owner-fenced retry can complete the Run.
      span = await tx
        .select()
        .from(runRuntimeSpans)
        .where(and(
          eq(runRuntimeSpans.orgId, input.orgId),
          eq(runRuntimeSpans.runId, input.runId),
          ...(input.spanId ? [eq(runRuntimeSpans.id, input.spanId)] : []),
          eq(runRuntimeSpans.ownerToken, input.ownerToken),
          eq(runRuntimeSpans.state, "sealed"),
          ...(input.attemptEpoch === undefined ? [] : [eq(runRuntimeSpans.attemptEpoch, input.attemptEpoch)]),
        ))
        .orderBy(desc(runRuntimeSpans.ordinal))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (span) return span;
      return null;
    }

    const identity = await persistedSpanRuntimeIdentity(tx as unknown as RuntimeDb, {
      orgId: input.orgId,
      span,
      driverRuntimeType: input.runtimeType,
      context: "span finish",
    });
    if (!identity || !span.attemptId) return null;
    const attempt = await tx
      .select({ runtimeType: heartbeatRunAttempts.runtimeType })
      .from(heartbeatRunAttempts)
      .where(and(
        eq(heartbeatRunAttempts.id, span.attemptId),
        eq(heartbeatRunAttempts.orgId, input.orgId),
        eq(heartbeatRunAttempts.runId, input.runId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!attempt || attempt.runtimeType !== input.runtimeType) {
      throw new RuntimeIdentityContractError(
        `span finish: attempt.runtimeType=${attempt?.runtimeType ?? "<missing>"} does not match driver.runtimeType=${input.runtimeType}`,
      );
    }

    const sessionId = nativeSessionIdFromResult(input.result);
    const executionRef = nativeExecutionRefFromResult(input.result);
    let segment = identity.segment;

    if (sessionId && segment.nativeSessionId && segment.nativeSessionId !== sessionId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`runtime-binding:${segment.bindingId}`}, 0))`);
      const [maxOrdinal] = await tx
        .select({ value: max(nativeSegments.segmentOrdinal) })
        .from(nativeSegments)
        .where(eq(nativeSegments.bindingId, segment.bindingId));
      const [nextSegment] = await tx
        .insert(nativeSegments)
        .values({
          orgId: segment.orgId,
          bindingId: segment.bindingId,
          runtimeType: input.runtimeType,
          segmentOrdinal: Number(maxOrdinal?.value ?? segment.segmentOrdinal) + 1,
          nativeSessionId: sessionId,
          rootSessionId: segment.rootSessionId ?? segment.nativeSessionId,
          parentSegmentId: segment.id,
          providerStateJson: preserveNativeForkIntentProviderState(
            segment.providerStateJson,
            input.result.sessionParams,
          ),
          state: "open",
        })
        .returning();
      if (nextSegment) {
        await tx.update(nativeSegments)
          .set({ state: "superseded", sealedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(nativeSegments.id, segment.id), eq(nativeSegments.orgId, input.orgId)));
        await tx.update(runtimeBindings)
          .set({ currentSegmentId: nextSegment.id, updatedAt: new Date() })
          .where(and(eq(runtimeBindings.id, span.bindingId), eq(runtimeBindings.orgId, input.orgId)));
        segment = nextSegment;
      }
    } else if (sessionId && !segment.nativeSessionId) {
      const [updated] = await tx
        .update(nativeSegments)
        .set({
          nativeSessionId: sessionId,
          rootSessionId: sessionId,
          providerStateJson: preserveNativeForkIntentProviderState(
            segment.providerStateJson,
            input.result.sessionParams,
          ),
          state: "open",
          updatedAt: new Date(),
        })
        .where(and(eq(nativeSegments.id, segment.id), eq(nativeSegments.orgId, input.orgId)))
        .returning();
      segment = updated ?? segment;
      await tx.update(runtimeBindings)
        .set({ currentSegmentId: segment.id, updatedAt: new Date() })
        .where(and(eq(runtimeBindings.id, span.bindingId), eq(runtimeBindings.orgId, input.orgId)));
    } else if (sessionId && input.result.sessionParams) {
      const [updated] = await tx
        .update(nativeSegments)
        .set({
          providerStateJson: preserveNativeForkIntentProviderState(
            segment.providerStateJson,
            input.result.sessionParams,
          ),
          updatedAt: new Date(),
        })
        .where(and(eq(nativeSegments.id, segment.id), eq(nativeSegments.orgId, input.orgId)))
        .returning();
      segment = updated ?? segment;
    }

    const transcriptBoundaryStatus = stringValue(jsonRecord(providerResult(input.result).transcriptBoundary)?.status);
    const incompleteTranscriptBoundary = transcriptBoundaryStatus === "missing" || transcriptBoundaryStatus === "unknown";
    const complete = !input.error && !input.result.errorMessage && !input.result.timedOut
      && input.result.exitCode === 0 && executionRef !== null
      && !incompleteTranscriptBoundary;
    const selector = sessionId
      ? selectorForRuntime({
        runtimeType: segment.runtimeType,
        sessionId,
        executionRef,
        inputCorrelationRef: span.inputCorrelationRef,
        runId: input.runId,
        result: input.result,
      })
      : {
        kind: "unresolved",
        runtimeType: segment.runtimeType,
        inputCorrelationRef: span.inputCorrelationRef,
        runId: input.runId,
      };
    const suspended = input.suspended === true;
    const [updatedSpan] = await tx
      .update(runRuntimeSpans)
      .set({
        segmentId: segment.id,
        nativeExecutionRef: executionRef,
        selectorJson: selector,
        // A transport suspension is not a terminal provider span. Keeping it
        // open lets recovery claim the same native range instead of inventing
        // a fresh conversation or losing the continuation boundary.
        state: suspended ? "open" : "sealed",
        completeness: suspended ? "partial" : complete ? "complete" : sessionId ? "partial" : "unknown",
        visibilityCutoffRef: input.visibilityCutoffRef ?? null,
        closedAt: suspended ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(runRuntimeSpans.id, span.id),
        eq(runRuntimeSpans.orgId, input.orgId),
        eq(runRuntimeSpans.ownerToken, input.ownerToken),
        eq(runRuntimeSpans.state, "open"),
      ))
      .returning();
    if (!updatedSpan) return null;
    if (suspended) return updatedSpan;
    const [updatedRun] = await tx
      .update(heartbeatRuns)
      .set({
        sessionIdAfter: sessionId,
        sessionParamsAfterJson: input.result.sessionParams ?? null,
        externalRunId: executionRef,
        ...(input.touchRunActivity === false ? {} : { updatedAt: new Date() }),
      })
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.orgId, input.orgId),
        eq(heartbeatRuns.executionOwnerToken, input.ownerToken),
        eq(heartbeatRuns.status, "running"),
      ))
      .returning({ id: heartbeatRuns.id });
    if (!updatedRun) {
      throw new Error("Runtime span completion lost the active Run owner lease");
    }
    return updatedSpan;
  });
}

/** Close a span when the provider never returned a structured result. */
export async function markRunRuntimeSpanUnresolved(db: Db, input: {
  orgId: string;
  runId: string;
  spanId?: string | null;
  ownerToken: string;
  runtimeType: string;
  attemptEpoch?: number;
  completeness?: "partial" | "terminal_only" | "unknown";
  visibilityCutoffRef?: string | null;
  reason?: string | null;
}) {
  return db.transaction(async (tx) => {
    if (!await selectActiveRunOwner(tx as unknown as RuntimeDb, input)) return null;
    const span = await tx
      .select()
      .from(runRuntimeSpans)
      .where(and(
        eq(runRuntimeSpans.orgId, input.orgId),
        eq(runRuntimeSpans.runId, input.runId),
        ...(input.spanId ? [eq(runRuntimeSpans.id, input.spanId)] : []),
        eq(runRuntimeSpans.ownerToken, input.ownerToken),
        eq(runRuntimeSpans.state, "open"),
        ...(input.attemptEpoch === undefined ? [] : [eq(runRuntimeSpans.attemptEpoch, input.attemptEpoch)]),
      ))
      .orderBy(desc(runRuntimeSpans.ordinal))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!span) return null;
    const identity = await persistedSpanRuntimeIdentity(tx as unknown as RuntimeDb, {
      orgId: input.orgId,
      span,
      driverRuntimeType: input.runtimeType,
      context: "span unresolved update",
    });
    if (!identity) return null;
    if (!span.attemptId) return null;
    const attempt = await tx
      .select({ runtimeType: heartbeatRunAttempts.runtimeType })
      .from(heartbeatRunAttempts)
      .where(and(
        eq(heartbeatRunAttempts.id, span.attemptId),
        eq(heartbeatRunAttempts.orgId, input.orgId),
        eq(heartbeatRunAttempts.runId, input.runId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!attempt || attempt.runtimeType !== input.runtimeType) {
      throw new RuntimeIdentityContractError(
        `span unresolved update: attempt.runtimeType=${attempt?.runtimeType ?? "<missing>"} does not match driver.runtimeType=${input.runtimeType}`,
      );
    }
    const [updated] = await tx
      .update(runRuntimeSpans)
      .set({
        selectorJson: {
          ...jsonRecord(span.selectorJson),
          kind: "unresolved",
          reason: stringValue(input.reason),
        },
        state: "unresolved",
        completeness: input.completeness ?? "unknown",
        visibilityCutoffRef: input.visibilityCutoffRef ?? span.visibilityCutoffRef,
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(runRuntimeSpans.id, span.id),
        eq(runRuntimeSpans.orgId, input.orgId),
        eq(runRuntimeSpans.ownerToken, input.ownerToken),
        eq(runRuntimeSpans.state, "open"),
      ))
      .returning();
    return updated ?? null;
  });
}

export async function listRunRuntimeSpans(db: RuntimeDb, input: { orgId: string; runId: string }) {
  return db
    .select()
    .from(runRuntimeSpans)
    .where(and(eq(runRuntimeSpans.orgId, input.orgId), eq(runRuntimeSpans.runId, input.runId)))
    .orderBy(asc(runRuntimeSpans.ordinal));
}
