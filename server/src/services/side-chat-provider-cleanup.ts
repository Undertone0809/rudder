import {
  activityLog,
  chatConversations,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
  runtimeRetentionClaims,
  runtimeSourceAliases,
  sideChatProviderCleanupIntents,
  type SideChatProviderCleanupProtectionRefs,
  type Db,
} from "@rudderhq/db";
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  createProfileBoundRuntimeProviderCapabilityResolverFromConfig,
  getRuntimeDriver,
  type RuntimeDriver,
} from "../agent-runtimes/index.js";
import { findServerAdapter } from "../agent-runtimes/registry.js";
import {
  runtimeConfigFromProviderProfileSnapshot,
  sanitizeRuntimeProviderProfileSnapshot,
} from "../agent-runtimes/runtime-provider-profile-snapshot.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_MS = 120_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
const OPENCODE_FORK_DELETE_REVIEW_REASON = "provider_fork_delete_mutual_exclusion_is_process_local";

type CleanupIntent = typeof sideChatProviderCleanupIntents.$inferSelect;
type CleanupTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RetryReviewAudit = (tx: CleanupTransaction) => Promise<unknown>;
type CleanupLogger = {
  warn?: (fields: Record<string, unknown>, message: string) => void;
  error?: (fields: Record<string, unknown>, message: string) => void;
};

export type SideChatCleanupConversation = {
  id: string;
  orgId: string;
  createdByUserId: string | null;
  sideChatState: string | null;
  messengerVisible: boolean;
};

export type SideChatProviderCleanupOptions = {
  workerId?: string;
  leaseMs?: number;
  logger?: CleanupLogger;
  resolveDriver?: (intent: CleanupIntent) => RuntimeDriver | null;
  now?: () => Date;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map(nonEmpty).filter((value): value is string => Boolean(value)))];
}

function parseProtectionRefs(
  value: unknown,
  intent: Pick<CleanupIntent, "bindingId" | "segmentId" | "conversationId" | "nativeSessionId">,
): SideChatProviderCleanupProtectionRefs | null {
  const record = asRecord(value);
  if (record?.version !== 1) return null;
  const fields = [
    "bindingIds",
    "segmentIds",
    "conversationIds",
    "runIds",
    "providerSessionIds",
    "retentionResourceRefs",
    "sourceAliasRefs",
  ] as const;
  const parsed = Object.fromEntries(fields.map((field) => {
    const raw = record[field];
    if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === "string")) return [field, null];
    return [field, uniqueStrings(raw)];
  })) as Record<typeof fields[number], string[] | null>;
  if (fields.some((field) => parsed[field] === null)) return null;
  const refs = parsed as Record<typeof fields[number], string[]>;
  if (
    !refs.bindingIds.includes(intent.bindingId)
    || !refs.segmentIds.includes(intent.segmentId)
    || !refs.conversationIds.includes(intent.conversationId)
    || !refs.providerSessionIds.includes(intent.nativeSessionId)
    || !refs.retentionResourceRefs.includes(intent.nativeSessionId)
  ) return null;
  return { version: 1, ...refs };
}

function sessionParamsFor(binding: typeof runtimeBindings.$inferSelect, segment: typeof nativeSegments.$inferSelect) {
  const sessionId = nonEmpty(segment.nativeSessionId);
  if (!sessionId) return null;
  const state = asRecord(segment.providerStateJson) ?? {};
  const codec = findServerAdapter(binding.runtimeType)?.sessionCodec;
  const serialized = codec?.serialize({ ...state, sessionId }) ?? null;
  if (!serialized) return { sessionId };
  return { ...serialized, sessionId };
}

function cleanupDriver(intent: CleanupIntent): RuntimeDriver | null {
  const snapshot = sanitizeRuntimeProviderProfileSnapshot(intent.profileSnapshotJson);
  if (!snapshot || snapshot.runtimeType !== intent.runtimeType) return null;
  const providerBinding = {
    id: intent.bindingId,
    orgId: intent.orgId,
    hostId: intent.hostId,
    profileId: intent.profileId,
    workspaceBindingId: intent.workspaceBindingId,
    capabilityRevision: intent.capabilityRevision,
  };
  return getRuntimeDriver(intent.runtimeType, {
    providerBinding,
    providerCapabilityResolver: createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      runtimeType: intent.runtimeType,
      runtimeConfig: runtimeConfigFromProviderProfileSnapshot(snapshot),
      cwd: snapshot.cwd,
      resolutionMode: "historical",
    }),
  });
}

async function hasDescendantBinding(
  tx: Db,
  input: { orgId: string; bindingId: string },
) {
  const visited = new Set([input.bindingId]);
  let frontier = [input.bindingId];
  while (frontier.length > 0) {
    const children = await tx.select({ id: runtimeBindings.id })
      .from(runtimeBindings)
      .where(and(
        eq(runtimeBindings.orgId, input.orgId),
        inArray(runtimeBindings.parentBindingId, frontier),
      ));
    const next = children.map(({ id }) => id).filter((id) => !visited.has(id));
    if (next.length > 0) return true;
    frontier = next;
  }
  return false;
}

async function hasDescendantSegment(
  tx: Db,
  input: { orgId: string; segmentId: string },
) {
  const visited = new Set([input.segmentId]);
  let frontier = [input.segmentId];
  while (frontier.length > 0) {
    const children = await tx.select({ id: nativeSegments.id })
      .from(nativeSegments)
      .where(and(
        eq(nativeSegments.orgId, input.orgId),
        inArray(nativeSegments.parentSegmentId, frontier),
      ));
    const next = children.map(({ id }) => id).filter((id) => !visited.has(id));
    if (next.length > 0) return true;
    frontier = next;
  }
  return false;
}

async function referencedByRetentionOrAlias(
  tx: Db,
  input: {
    orgId: string;
    bindingIds: string[];
    segmentIds: string[];
    conversationIds: string[];
    runIds: string[];
    sourceRefs: string[];
  },
) {
  const claimReferences = or(
    inArray(runtimeRetentionClaims.bindingId, input.bindingIds),
    inArray(runtimeRetentionClaims.segmentId, input.segmentIds),
    inArray(runtimeRetentionClaims.resourceRef, input.sourceRefs),
  );
  const activeClaims = await tx.select({ resourceRef: runtimeRetentionClaims.resourceRef })
    .from(runtimeRetentionClaims)
    .where(and(
      eq(runtimeRetentionClaims.orgId, input.orgId),
      eq(runtimeRetentionClaims.status, "active"),
      claimReferences,
    ));

  const aliasReferences = or(
    inArray(runtimeSourceAliases.bindingId, input.bindingIds),
    inArray(runtimeSourceAliases.segmentId, input.segmentIds),
    inArray(runtimeSourceAliases.conversationId, input.conversationIds),
    input.runIds.length > 0 ? inArray(runtimeSourceAliases.runId, input.runIds) : sql`false`,
    inArray(runtimeSourceAliases.sourceRef, input.sourceRefs),
  );
  const liveAliases = await tx.select({ sourceRef: runtimeSourceAliases.sourceRef })
    .from(runtimeSourceAliases)
    .where(and(
      eq(runtimeSourceAliases.orgId, input.orgId),
      isNull(runtimeSourceAliases.releasedAt),
      aliasReferences,
    ));
  return {
    retentionResourceRefs: uniqueStrings(activeClaims.map(({ resourceRef }) => resourceRef)),
    sourceAliasRefs: uniqueStrings(liveAliases.map(({ sourceRef }) => sourceRef)),
  };
}

function cleanupSourceRefs(input: {
  bindingId: string;
  segmentIds: string[];
  conversationId: string;
  runIds: string[];
  providerSessionIds: string[];
  resourceIdentityRefs: string[];
}) {
  return [...new Set([
    input.bindingId,
    ...input.segmentIds,
    input.conversationId,
    ...input.runIds,
    ...input.providerSessionIds,
    ...input.providerSessionIds.map((sessionId) => `provider-session:${sessionId}`),
    ...input.resourceIdentityRefs,
  ])];
}

async function sharedProviderSessionReferenceExists(
  tx: Db,
  input: {
    orgId: string;
    bindingId: string;
    runtimeType: string;
    hostId: string;
    profileId: string;
    providerSessionIds: string[];
  },
) {
  const sessionRef = or(
    inArray(nativeSegments.nativeSessionId, input.providerSessionIds),
    inArray(nativeSegments.rootSessionId, input.providerSessionIds),
  );
  const [reference] = await tx.select({ id: nativeSegments.id })
    .from(nativeSegments)
    .innerJoin(runtimeBindings, eq(nativeSegments.bindingId, runtimeBindings.id))
    .where(and(
      sessionRef,
      ne(runtimeBindings.id, input.bindingId),
      eq(runtimeBindings.orgId, input.orgId),
      eq(runtimeBindings.runtimeType, input.runtimeType),
      eq(runtimeBindings.hostId, input.hostId),
      eq(runtimeBindings.profileId, input.profileId),
    ))
    .limit(1);
  return Boolean(reference);
}

async function findForkRun(
  tx: Db,
  input: { orgId: string; conversationId: string; bindingId: string; segmentId: string; sessionId: string },
) {
  const [run] = await tx.select({
    contextSnapshot: heartbeatRuns.contextSnapshot,
    sessionIntentJson: heartbeatRuns.sessionIntentJson,
    id: heartbeatRuns.id,
  })
    .from(runRuntimeSpans)
    .innerJoin(heartbeatRuns, eq(runRuntimeSpans.runId, heartbeatRuns.id))
    .where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.bindingId, input.bindingId),
      eq(runRuntimeSpans.segmentId, input.segmentId),
      eq(heartbeatRuns.scene, "side_chat"),
      eq(heartbeatRuns.targetType, "chat_conversation"),
      eq(heartbeatRuns.targetId, input.conversationId),
      sql`${heartbeatRuns.sessionIntentJson}->>'kind' = 'fork'
        and ${heartbeatRuns.sessionIntentJson}->>'sessionId' = ${input.sessionId}`,
    ))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  return run ?? null;
}

async function parentSessionForBinding(tx: Db, binding: typeof runtimeBindings.$inferSelect) {
  if (!binding.parentBindingId) return null;
  const [parent] = await tx.select({ currentSegmentId: runtimeBindings.currentSegmentId })
    .from(runtimeBindings)
    .where(and(
      eq(runtimeBindings.orgId, binding.orgId),
      eq(runtimeBindings.id, binding.parentBindingId),
    ))
    .limit(1);
  if (!parent?.currentSegmentId) return null;
  const [segment] = await tx.select({ nativeSessionId: nativeSegments.nativeSessionId })
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.orgId, binding.orgId),
      eq(nativeSegments.bindingId, binding.parentBindingId),
      eq(nativeSegments.id, parent.currentSegmentId),
    ))
    .limit(1);
  return nonEmpty(segment?.nativeSessionId);
}

async function detachDeletedSideChatReferences(
  tx: Db,
  input: {
    orgId: string;
    conversationId: string;
    bindingIds: string[];
    segmentIds: string[];
    runIds: string[];
    now: Date;
  },
) {
  const bindingCondition = input.bindingIds.length > 0
    ? inArray(runtimeRetentionClaims.bindingId, input.bindingIds)
    : sql`false`;
  const segmentCondition = input.segmentIds.length > 0
    ? inArray(runtimeRetentionClaims.segmentId, input.segmentIds)
    : sql`false`;
  await tx.update(runtimeRetentionClaims)
    .set({ bindingId: null, segmentId: null, updatedAt: input.now })
    .where(and(
      eq(runtimeRetentionClaims.orgId, input.orgId),
      or(bindingCondition, segmentCondition),
    ));

  const aliasReferences = or(
    eq(runtimeSourceAliases.conversationId, input.conversationId),
    input.bindingIds.length > 0 ? inArray(runtimeSourceAliases.bindingId, input.bindingIds) : sql`false`,
    input.segmentIds.length > 0 ? inArray(runtimeSourceAliases.segmentId, input.segmentIds) : sql`false`,
    input.runIds.length > 0 ? inArray(runtimeSourceAliases.runId, input.runIds) : sql`false`,
  );
  await tx.update(runtimeSourceAliases)
    .set({ conversationId: null, runId: null, bindingId: null, segmentId: null, updatedAt: input.now })
    .where(and(eq(runtimeSourceAliases.orgId, input.orgId), aliasReferences));
}

export async function persistSideChatProviderCleanupIntents(
  tx: Db,
  input: SideChatCleanupConversation,
  now = new Date(),
) {
  if (!input.createdByUserId) return { recorded: 0, reviewRequired: 0 };
  const conversation = await tx.select({
    conversationKind: chatConversations.conversationKind,
    createdByUserId: chatConversations.createdByUserId,
    sideChatState: chatConversations.sideChatState,
    messengerVisible: chatConversations.messengerVisible,
  })
    .from(chatConversations)
    .where(and(eq(chatConversations.orgId, input.orgId), eq(chatConversations.id, input.id)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !conversation
    || conversation.conversationKind !== "side_chat"
    || conversation.sideChatState === "kept"
    || conversation.messengerVisible
  ) {
    return { recorded: 0, reviewRequired: 0 };
  }
  if (conversation.createdByUserId !== input.createdByUserId) {
    throw new Error("Side Chat cleanup owner changed before the delete transaction");
  }

  const [productDescendant] = await tx.select({ id: chatConversations.id })
    .from(chatConversations)
    .where(and(
      eq(chatConversations.orgId, input.orgId),
      eq(chatConversations.forkedFromConversationId, input.id),
    ))
    .limit(1);

  const bindings = await tx.select().from(runtimeBindings).where(and(
    eq(runtimeBindings.orgId, input.orgId),
    eq(runtimeBindings.conversationId, input.id),
  ));
  const bindingIds = bindings.map((binding) => binding.id);
  const segments = bindingIds.length > 0
    ? await tx.select().from(nativeSegments).where(and(
      eq(nativeSegments.orgId, input.orgId),
      inArray(nativeSegments.bindingId, bindingIds),
    )).orderBy(asc(nativeSegments.segmentOrdinal))
    : [];
  const segmentIds = segments.map(({ id }) => id);
  const sideChatRuns = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.orgId, input.orgId),
    or(
      eq(heartbeatRuns.chatConversationId, input.id),
      and(
        eq(heartbeatRuns.scene, "side_chat"),
        eq(heartbeatRuns.targetType, "chat_conversation"),
        eq(heartbeatRuns.targetId, input.id),
      ),
    ),
  ));
  const runIds = sideChatRuns.map(({ id }) => id);
  let recorded = 0;
  let reviewRequired = 0;

  for (const binding of bindings) {
    const bindingSegments = segments.filter((segment) => segment.bindingId === binding.id);
    const bySession = new Map<string, typeof bindingSegments>();
    for (const segment of bindingSegments) {
      const sessionId = nonEmpty(segment.nativeSessionId);
      if (!sessionId) continue;
      const group = bySession.get(sessionId) ?? [];
      group.push(segment);
      bySession.set(sessionId, group);
    }

    for (const [nativeSessionId, sameSessionSegments] of bySession) {
      const candidates = await Promise.all(sameSessionSegments.map(async (segment) => ({
        segment,
        forkRun: await findForkRun(tx, {
          orgId: input.orgId,
          conversationId: input.id,
          bindingId: binding.id,
          segmentId: segment.id,
          sessionId: nativeSessionId,
        }),
      })));
      const provenCandidates = candidates.filter(({ forkRun }) => {
        const forkIntent = asRecord(forkRun?.sessionIntentJson);
        return forkIntent?.kind === "fork"
          && forkIntent.sessionId === nativeSessionId
          && Boolean(nonEmpty(forkIntent.sourceRunId))
          && Boolean(nonEmpty(forkIntent.sourceBoundaryRef));
      });
      const selected = provenCandidates.length === 1 ? provenCandidates[0]! : candidates[0]!;
      const { segment, forkRun } = selected;
      const forkIntent = asRecord(forkRun?.sessionIntentJson);
      const profileSnapshot = sanitizeRuntimeProviderProfileSnapshot(
        asRecord(forkRun?.contextSnapshot)?.runtimeProviderProfile,
      );
      const sessionParams = sessionParamsFor(binding, segment);
      const parentSessionId = await parentSessionForBinding(tx, binding);
      const providerSessionIds = uniqueStrings(sameSessionSegments.map((candidate) => candidate.nativeSessionId));
      const rootSessionIds = uniqueStrings(sameSessionSegments.map((candidate) => candidate.rootSessionId));
      const resourceIdentityRefs = uniqueStrings([
        ...providerSessionIds,
        ...rootSessionIds,
        ...rootSessionIds.map((sessionId) => `provider-session:${sessionId}`),
        binding.sourceBoundaryRef,
        forkIntent?.sourceBoundaryRef,
        ...sameSessionSegments.flatMap((candidate) => [candidate.sourceBoundaryRef, candidate.leafId]),
      ]);
      const sourceRefs = cleanupSourceRefs({
        bindingId: binding.id,
        segmentIds: sameSessionSegments.map(({ id }) => id),
        conversationId: input.id,
        runIds,
        providerSessionIds,
        resourceIdentityRefs,
      });
      const existingProtectionRefs = await referencedByRetentionOrAlias(tx, {
        orgId: input.orgId,
        bindingIds: [binding.id],
        segmentIds: sameSessionSegments.map(({ id }) => id),
        conversationIds: [input.id],
        runIds,
        sourceRefs,
      });
      const protectionRefsJson: SideChatProviderCleanupProtectionRefs = {
        version: 1,
        bindingIds: [binding.id],
        segmentIds: uniqueStrings(sameSessionSegments.map(({ id }) => id)),
        conversationIds: [input.id],
        runIds: uniqueStrings(runIds),
        providerSessionIds,
        retentionResourceRefs: uniqueStrings([
          ...sourceRefs,
          ...existingProtectionRefs.retentionResourceRefs,
        ]),
        sourceAliasRefs: uniqueStrings([
          ...sourceRefs,
          ...existingProtectionRefs.sourceAliasRefs,
        ]),
      };

      let stateReason: string | null = null;
      if (productDescendant) {
        stateReason = "side_chat_has_product_conversation_descendants";
      } else if (binding.runtimeType === "opencode_local") {
        stateReason = OPENCODE_FORK_DELETE_REVIEW_REASON;
      } else if (sameSessionSegments.length > 1 && provenCandidates.length !== 1) {
        stateReason = "provider_session_id_is_ambiguous_across_binding_segments";
      } else if (binding.continuity !== "native" || !binding.parentBindingId || !nonEmpty(binding.sourceBoundaryRef)) {
        stateReason = "provider_resource_ownership_not_proven_by_native_fork_binding";
      } else if (
        !forkRun
        || forkIntent?.kind !== "fork"
        || forkIntent.sessionId !== nativeSessionId
        || !nonEmpty(forkIntent.sourceRunId)
        || !nonEmpty(forkIntent.sourceBoundaryRef)
      ) {
        stateReason = "provider_resource_ownership_not_proven_by_fork_run_span";
      } else if (!parentSessionId || parentSessionId === nativeSessionId) {
        stateReason = "provider_fork_parent_session_is_missing_or_shared";
      } else if (!sessionParams || sessionParams.sessionId !== nativeSessionId) {
        stateReason = "provider_session_parameters_could_not_be_safely_serialized";
      } else if (
        await hasDescendantBinding(tx, { orgId: input.orgId, bindingId: binding.id })
        || (await Promise.all(sameSessionSegments.map((candidate) =>
          hasDescendantSegment(tx, { orgId: input.orgId, segmentId: candidate.id }),
        ))).some(Boolean)
        || existingProtectionRefs.retentionResourceRefs.length > 0
        || existingProtectionRefs.sourceAliasRefs.length > 0
      ) {
        stateReason = "provider_resource_has_descendant_or_retention_references";
      } else if (await sharedProviderSessionReferenceExists(tx, {
        orgId: input.orgId,
        bindingId: binding.id,
        runtimeType: binding.runtimeType,
        hostId: binding.hostId,
        profileId: binding.profileId,
        providerSessionIds,
      })) {
        stateReason = "provider_session_id_is_referenced_by_another_binding";
      }

      const rowState = stateReason ? "review_required" : "pending";
      const inserted = await tx.insert(sideChatProviderCleanupIntents).values({
        orgId: input.orgId,
        conversationId: input.id,
        ownerUserId: input.createdByUserId,
        principalScopeRef: binding.principalScopeRef,
        bindingId: binding.id,
        bindingEpoch: binding.bindingEpoch,
        segmentId: segment.id,
        forkRunId: forkRun?.id ?? null,
        agentId: binding.agentId,
        runtimeType: binding.runtimeType,
        hostId: binding.hostId,
        profileId: binding.profileId,
        workspaceBindingId: binding.workspaceBindingId,
        capabilityRevision: binding.capabilityRevision,
        parentBindingId: binding.parentBindingId,
        parentSessionId,
        sourceBoundaryRef: binding.sourceBoundaryRef,
        nativeSessionId,
        sessionParamsJson: sessionParams ?? { sessionId: nativeSessionId },
        protectionRefsJson,
        profileSnapshotJson: (profileSnapshot ?? {}) as Record<string, unknown>,
        state: rowState,
        stateReason,
        lastError: stateReason,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().returning({ id: sideChatProviderCleanupIntents.id });
      if (inserted.length > 0) {
        recorded += 1;
        if (stateReason) reviewRequired += 1;
      }
    }
  }

  await detachDeletedSideChatReferences(tx, {
    orgId: input.orgId,
    conversationId: input.id,
    bindingIds,
    segmentIds,
    runIds,
    now,
  });
  return { recorded, reviewRequired };
}

export function sideChatProviderCleanupService(db: Db, options: SideChatProviderCleanupOptions = {}) {
  const workerId = options.workerId ?? randomUUID();
  const leaseMs = Math.max(options.leaseMs ?? DEFAULT_LEASE_MS, 1_000);
  const now = options.now ?? (() => new Date());
  const resolveDriver = options.resolveDriver ?? cleanupDriver;

  async function claimNext() {
    const startedAt = now();
    return db.transaction(async (tx) => {
      const [candidate] = await tx.select().from(sideChatProviderCleanupIntents)
        .where(or(
          and(
            or(
              eq(sideChatProviderCleanupIntents.state, "pending"),
              eq(sideChatProviderCleanupIntents.state, "retry_wait"),
            ),
            lte(sideChatProviderCleanupIntents.nextAttemptAt, startedAt),
          ),
          and(
            eq(sideChatProviderCleanupIntents.state, "claimed"),
            lte(sideChatProviderCleanupIntents.leaseExpiresAt, startedAt),
          ),
        ))
        .orderBy(asc(sideChatProviderCleanupIntents.nextAttemptAt), asc(sideChatProviderCleanupIntents.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return null;
      const [claimed] = await tx.update(sideChatProviderCleanupIntents).set({
        state: "claimed",
        leaseOwner: workerId,
        leaseEpoch: candidate.leaseEpoch + 1,
        leaseExpiresAt: new Date(startedAt.getTime() + leaseMs),
        attemptCount: candidate.attemptCount + 1,
        lastError: null,
        stateReason: null,
        updatedAt: startedAt,
      }).where(and(
        eq(sideChatProviderCleanupIntents.id, candidate.id),
        eq(sideChatProviderCleanupIntents.leaseEpoch, candidate.leaseEpoch),
      )).returning();
      return claimed ?? null;
    });
  }

  function claimCondition(intent: CleanupIntent) {
    return and(
      eq(sideChatProviderCleanupIntents.id, intent.id),
      eq(sideChatProviderCleanupIntents.state, "claimed"),
      eq(sideChatProviderCleanupIntents.leaseOwner, workerId),
      eq(sideChatProviderCleanupIntents.leaseEpoch, intent.leaseEpoch),
      gt(sideChatProviderCleanupIntents.leaseExpiresAt, now()),
    );
  }

  async function renewClaim(intent: CleanupIntent) {
    const at = now();
    const [renewed] = await db.update(sideChatProviderCleanupIntents).set({
      leaseExpiresAt: new Date(at.getTime() + leaseMs),
      updatedAt: at,
    }).where(and(
      eq(sideChatProviderCleanupIntents.id, intent.id),
      eq(sideChatProviderCleanupIntents.state, "claimed"),
      eq(sideChatProviderCleanupIntents.leaseOwner, workerId),
      eq(sideChatProviderCleanupIntents.leaseEpoch, intent.leaseEpoch),
      gt(sideChatProviderCleanupIntents.leaseExpiresAt, at),
    )).returning({ id: sideChatProviderCleanupIntents.id });
    return Boolean(renewed);
  }

  async function runWithClaimRenewal<T>(
    intent: CleanupIntent,
    operation: (signal: AbortSignal) => Promise<T>,
  ) {
    const controller = new AbortController();
    let leaseOwned = true;
    let renewal: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (!leaseOwned || renewal) return;
      renewal = renewClaim(intent).then((renewed) => {
        if (!renewed) {
          leaseOwned = false;
          controller.abort(new Error("Side Chat cleanup lease was fenced by another owner"));
        }
      }).catch((error: unknown) => {
        leaseOwned = false;
        controller.abort(error);
      }).finally(() => { renewal = null; });
    }, Math.max(250, Math.floor(leaseMs / 3)));
    timer.unref?.();
    let value!: T;
    try {
      value = await operation(controller.signal);
    } finally {
      clearInterval(timer);
      await renewal;
    }
    return { value, leaseOwned };
  }

  async function finishClaim(
    intent: CleanupIntent,
    outcome: { state: "completed" | "retry_wait" | "review_required"; reason?: string; error?: string | null },
  ) {
    const at = now();
    const retryDelay = Math.min(5_000 * (2 ** Math.min(intent.attemptCount - 1, 10)), MAX_RETRY_DELAY_MS);
    const [updated] = await db.update(sideChatProviderCleanupIntents).set({
      state: outcome.state,
      stateReason: outcome.reason ?? null,
      lastError: outcome.error ?? null,
      nextAttemptAt: outcome.state === "retry_wait" ? new Date(at.getTime() + retryDelay) : at,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: outcome.state === "completed" ? at : null,
      updatedAt: at,
    }).where(claimCondition(intent)).returning({ id: sideChatProviderCleanupIntents.id });
    return Boolean(updated);
  }

  async function review(intent: CleanupIntent, reason: string) {
    const stored = await finishClaim(intent, {
      state: "review_required",
      reason,
      error: reason,
    });
    if (stored) {
      options.logger?.warn?.({
        cleanupIntentId: intent.id,
        runtimeType: intent.runtimeType,
        profileId: intent.profileId,
        bindingEpoch: intent.bindingEpoch,
        reason,
      }, "Side Chat Provider cleanup requires review");
    }
  }

  async function retry(intent: CleanupIntent, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const stored = await finishClaim(intent, { state: "retry_wait", error: detail });
    if (stored) {
      options.logger?.error?.({
        cleanupIntentId: intent.id,
        runtimeType: intent.runtimeType,
        profileId: intent.profileId,
        bindingEpoch: intent.bindingEpoch,
        error,
      }, "Side Chat Provider cleanup attempt failed and will retry");
    }
  }

  async function currentProtectionReason(intent: CleanupIntent) {
    const protectionRefs = parseProtectionRefs(intent.protectionRefsJson, intent);
    if (!protectionRefs) return "provider_cleanup_protection_identity_snapshot_is_missing_or_invalid";

    const [conversation] = await db.select({
      sideChatState: chatConversations.sideChatState,
      messengerVisible: chatConversations.messengerVisible,
    }).from(chatConversations).where(and(
      eq(chatConversations.orgId, intent.orgId),
      eq(chatConversations.id, intent.conversationId),
    )).limit(1);
    if (conversation?.sideChatState === "kept" || conversation?.messengerVisible) {
      return "side_chat_was_kept_in_messenger";
    }
    if (conversation) return "side_chat_still_exists_after_cleanup_was_enqueued";

    const [binding] = await db.select({ bindingEpoch: runtimeBindings.bindingEpoch })
      .from(runtimeBindings)
      .where(and(
        eq(runtimeBindings.orgId, intent.orgId),
        eq(runtimeBindings.id, intent.bindingId),
      ))
      .limit(1);
    if (binding) {
      return binding.bindingEpoch === intent.bindingEpoch
        ? "runtime_binding_still_exists_after_cleanup_was_enqueued"
        : "runtime_binding_epoch_changed_after_cleanup_was_enqueued";
    }
    if (intent.runtimeType === "opencode_local") return OPENCODE_FORK_DELETE_REVIEW_REASON;

    const [activeClaim] = await db.select({ id: runtimeRetentionClaims.id })
      .from(runtimeRetentionClaims)
      .where(and(
        eq(runtimeRetentionClaims.orgId, intent.orgId),
        eq(runtimeRetentionClaims.status, "active"),
        or(
          inArray(runtimeRetentionClaims.bindingId, protectionRefs.bindingIds),
          inArray(runtimeRetentionClaims.segmentId, protectionRefs.segmentIds),
          inArray(runtimeRetentionClaims.resourceRef, protectionRefs.retentionResourceRefs),
        ),
      ))
      .limit(1);
    if (activeClaim) return "provider_resource_has_an_active_retention_claim";

    const [liveAlias] = await db.select({ id: runtimeSourceAliases.id })
      .from(runtimeSourceAliases)
      .where(and(
        eq(runtimeSourceAliases.orgId, intent.orgId),
        isNull(runtimeSourceAliases.releasedAt),
        or(
          inArray(runtimeSourceAliases.bindingId, protectionRefs.bindingIds),
          inArray(runtimeSourceAliases.segmentId, protectionRefs.segmentIds),
          inArray(runtimeSourceAliases.conversationId, protectionRefs.conversationIds),
          protectionRefs.runIds.length > 0
            ? inArray(runtimeSourceAliases.runId, protectionRefs.runIds)
            : sql`false`,
          inArray(runtimeSourceAliases.sourceRef, protectionRefs.sourceAliasRefs),
        ),
      ))
      .limit(1);
    if (liveAlias) return "provider_resource_has_an_active_source_alias";

    const [reference] = await db.select({ id: nativeSegments.id })
      .from(nativeSegments)
      .innerJoin(runtimeBindings, eq(nativeSegments.bindingId, runtimeBindings.id))
      .where(and(
        or(
          inArray(nativeSegments.nativeSessionId, protectionRefs.providerSessionIds),
          inArray(nativeSegments.rootSessionId, protectionRefs.providerSessionIds),
        ),
        ne(runtimeBindings.id, intent.bindingId),
        eq(runtimeBindings.orgId, intent.orgId),
        eq(runtimeBindings.runtimeType, intent.runtimeType),
        eq(runtimeBindings.hostId, intent.hostId),
        eq(runtimeBindings.profileId, intent.profileId),
      ))
      .limit(1);
    if (reference) return "provider_session_id_is_now_referenced_by_another_binding";
    return null;
  }

  async function processClaim(intent: CleanupIntent) {
    const protection = await currentProtectionReason(intent);
    if (protection) {
      await review(intent, protection);
      return;
    }
    if (!await renewClaim(intent)) return;

    if (!intent.forkRunId || !intent.parentSessionId) {
      await review(intent, "provider_fork_cleanup_run_or_parent_identity_is_missing");
      return;
    }
    const driver = resolveDriver(intent);
    if (!driver) {
      await review(intent, "no_profile_bound_runtime_driver_for_provider_cleanup");
      return;
    }
    const resumed = driver.resume({
      sessionId: intent.nativeSessionId,
      sessionParams: intent.sessionParamsJson,
      sessionDisplayId: intent.nativeSessionId,
    });
    if (resumed.status !== "supported") {
      await review(intent, `provider_session_resume_${resumed.status}: ${resumed.reason}`);
      return;
    }
    if (resumed.value.sessionId !== intent.nativeSessionId) {
      await review(intent, "provider_session_codec_returned_a_different_session_id");
      return;
    }
    const protectionAfterResume = await currentProtectionReason(intent);
    if (protectionAfterResume) {
      await review(intent, protectionAfterResume);
      return;
    }
    if (!await renewClaim(intent)) return;

    const result = await runWithClaimRenewal(intent, (signal) => driver.deleteSideChatForkSession({
      session: resumed.value,
      expectedParentSessionId: intent.parentSessionId!,
      binding: {
        id: intent.bindingId,
        orgId: intent.orgId,
        hostId: intent.hostId,
        profileId: intent.profileId,
        workspaceBindingId: intent.workspaceBindingId,
        capabilityRevision: intent.capabilityRevision,
      },
      forkRunId: intent.forkRunId,
      signal,
    }));
    if (!result.leaseOwned) return;
    const operation = result.value;
    if (operation.status !== "supported") {
      await review(intent, `provider_side_chat_cleanup_${operation.status}: ${operation.reason}`);
      return;
    }
    await finishClaim(intent, { state: "completed" });
  }

  async function processBatch(limit = DEFAULT_BATCH_SIZE) {
    let processed = 0;
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
    while (processed < boundedLimit) {
      const intent = await claimNext();
      if (!intent) break;
      processed += 1;
      try {
        await processClaim(intent);
      } catch (error) {
        const status = asRecord(error)?.status;
        if (status === "unsupported" || status === "unknown") {
          await review(intent, error instanceof Error ? error.message : String(error));
        } else {
          await retry(intent, error);
        }
      }
    }
    return processed;
  }

  async function listReviewRequired(limit = 50, orgId?: string) {
    return db.select().from(sideChatProviderCleanupIntents)
      .where(and(
        eq(sideChatProviderCleanupIntents.state, "review_required"),
        orgId ? eq(sideChatProviderCleanupIntents.orgId, orgId) : undefined,
      ))
      .orderBy(desc(sideChatProviderCleanupIntents.updatedAt))
      .limit(Math.min(Math.max(Math.floor(limit), 1), 200));
  }

  async function retryReviewRequired(
    input: { orgId: string; intentId: string },
    writeAudit?: RetryReviewAudit,
  ) {
    const at = now();
    return db.transaction(async (tx) => {
      const [updated] = await tx.update(sideChatProviderCleanupIntents).set({
        state: "pending",
        stateReason: null,
        lastError: null,
        nextAttemptAt: at,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
        updatedAt: at,
      }).where(and(
        eq(sideChatProviderCleanupIntents.orgId, input.orgId),
        eq(sideChatProviderCleanupIntents.id, input.intentId),
        eq(sideChatProviderCleanupIntents.state, "review_required"),
      )).returning({
        id: sideChatProviderCleanupIntents.id,
        orgId: sideChatProviderCleanupIntents.orgId,
        conversationId: sideChatProviderCleanupIntents.conversationId,
        state: sideChatProviderCleanupIntents.state,
        stateReason: sideChatProviderCleanupIntents.stateReason,
        nextAttemptAt: sideChatProviderCleanupIntents.nextAttemptAt,
        updatedAt: sideChatProviderCleanupIntents.updatedAt,
      });
      if (updated) {
        if (writeAudit) {
          await writeAudit(tx);
        } else {
          await tx.insert(activityLog).values({
            orgId: input.orgId,
            actorType: "system",
            actorId: "side_chat_provider_cleanup_service",
            action: "side_chat.provider_cleanup_retry_requested",
            entityType: "side_chat_provider_cleanup_intent",
            entityId: input.intentId,
            details: { state: "pending", source: "service" },
          });
        }
      }
      return updated ?? null;
    });
  }

  return { processBatch, listReviewRequired, retryReviewRequired };
}

export function startSideChatProviderCleanupWorker(
  db: Db,
  options: SideChatProviderCleanupOptions & {
    intervalMs?: number;
    batchSize?: number;
    setIntervalFn?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
    clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  } = {},
) {
  const intervalMs = Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, 1_000);
  const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH_SIZE, 1), 100);
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const service = sideChatProviderCleanupService(db, options);
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const sweep = () => {
    if (stopped || inFlight) return;
    inFlight = service.processBatch(batchSize)
      .then(() => undefined)
      .catch((error) => {
        options.logger?.error?.({ error }, "Side Chat Provider cleanup recovery sweep failed");
      })
      .finally(() => { inFlight = null; });
  };
  sweep();
  const timer = setIntervalFn(sweep, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      if (stopped) {
        await inFlight;
        return;
      }
      stopped = true;
      clearIntervalFn(timer);
      await inFlight;
    },
  };
}
