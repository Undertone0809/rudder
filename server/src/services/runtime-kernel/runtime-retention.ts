import type { Db } from "@rudderhq/db";
import {
  chatConversations,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
  runtimeRetentionClaims,
  runtimeSourceAliases,
  sideChatProviderCleanupIntents,
} from "@rudderhq/db";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { retryFailedNativeTranscriptCleanup } from "./native-transcript-retention-recovery.js";
import type {
  TranscriptObjectStore,
  TranscriptObjectSweepCandidate,
  TranscriptObjectSweepGuardResult,
  TranscriptObjectSweepResult,
} from "./transcript-object-store.js";
import { getTranscriptObjectStore } from "./transcript-object-store.js";

export type RuntimeRetentionDb = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;
type ClaimRow = typeof runtimeRetentionClaims.$inferSelect;
type SourceAliasRow = typeof runtimeSourceAliases.$inferSelect;

export type RuntimeRetentionClaimSpec = {
  resourceRef: string;
  purpose: string;
  principalScopeRef: string;
  bindingId?: string | null;
  segmentId?: string | null;
  expiresAt?: Date | null;
};

export type RuntimeRetentionClaimFence = {
  id: string;
  lifecycleVersion: number;
  cleanupEpoch: number;
};

export type RuntimeRetentionSourceAliasSpec = {
  conversationId?: string | null;
  runId?: string | null;
  bindingId?: string | null;
  segmentId?: string | null;
  sourceKind: string;
  sourceRef: string;
  sourceRangeJson?: Record<string, unknown>;
  contentSha256?: string | null;
  principalScopeRef: string;
  expiresAt?: Date | null;
};

export type RuntimeRetentionInspection = {
  resourceRefs: string[];
  activeClaimIds: string[];
  activeAliasIds: string[];
  keptConversationIds: string[];
  inFlightSpanIds: string[];
  inFlightRunIds: string[];
  collectable: boolean;
  blockedBy: "claim" | "source_alias" | "kept_chat" | "in_flight" | null;
};

export type RuntimeRetentionGcResult = RuntimeRetentionInspection & {
  status: "collectable" | "blocked" | "fenced";
  expiredClaimIds: string[];
  releasedAliasIds: string[];
};

export class RuntimeRetentionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeRetentionConflictError";
  }
}

export class RuntimeRetentionFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeRetentionFenceError";
  }
}

const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const ACTIVE_SPAN_STATES = ["open", "unresolved"] as const;

function isLiveClaim(row: ClaimRow, now: Date) {
  return row.status === "active" && (!row.expiresAt || row.expiresAt.getTime() > now.getTime());
}

function isLiveAlias(row: SourceAliasRow, now: Date) {
  return !row.releasedAt && (!row.expiresAt || row.expiresAt.getTime() > now.getTime());
}

function requiredText(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function distinct(values: readonly string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function retentionLockKey(orgId: string) {
  return `runtime-retention:${requiredText(orgId, "orgId")}`;
}

function claimScopeCondition(input: {
  orgId: string;
  purpose: string;
  principalScopeRef: string;
}) {
  return and(
    eq(runtimeRetentionClaims.orgId, input.orgId),
    eq(runtimeRetentionClaims.purpose, input.purpose),
    eq(runtimeRetentionClaims.principalScopeRef, input.principalScopeRef),
  );
}

function assertClaimOwnership(existing: ClaimRow, spec: RuntimeRetentionClaimSpec) {
  if (
    existing.principalScopeRef !== spec.principalScopeRef
    || existing.bindingId !== (spec.bindingId ?? null)
    || existing.segmentId !== (spec.segmentId ?? null)
  ) {
    throw new RuntimeRetentionConflictError(
      `Retention claim ${existing.id} is already bound to a different principal or runtime resource`,
    );
  }
}

function assertSourceAliasOwnership(existing: SourceAliasRow, spec: RuntimeRetentionSourceAliasSpec) {
  const canonical = (value: unknown): string => Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
      : JSON.stringify(value) ?? "null";
  if (
    existing.principalScopeRef !== spec.principalScopeRef
    || existing.conversationId !== (spec.conversationId ?? null)
    || existing.runId !== (spec.runId ?? null)
    || existing.bindingId !== (spec.bindingId ?? null)
    || existing.segmentId !== (spec.segmentId ?? null)
    || existing.contentSha256 !== (spec.contentSha256 ?? null)
    || canonical(existing.sourceRangeJson) !== canonical(spec.sourceRangeJson ?? {})
  ) {
    throw new RuntimeRetentionConflictError(
      `Retention source alias ${existing.id} is already bound to a different owner or resource`,
    );
  }
}

export async function lockRuntimeRetentionScope(db: RuntimeRetentionDb, orgId: string) {
  await db.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${retentionLockKey(orgId)}, 0))
  `);
}

/** Preserve a durable cleanup decision without pretending a root is an owned
 * Side Chat fork. The shared retention lock fences Keep/alias/GC mutations. */
export async function recordRetainedNativeSourceCleanupInTransaction(
  db: RuntimeRetentionDb,
  input: { orgId: string; conversationId: string; ownerUserId: string; binding: typeof runtimeBindings.$inferSelect },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  const segments = await db.select().from(nativeSegments).where(and(
    eq(nativeSegments.orgId, input.orgId), eq(nativeSegments.bindingId, input.binding.id),
  ));
  for (const segment of segments) {
    if (!segment.nativeSessionId) continue;
    const [run] = await db.select().from(heartbeatRuns).innerJoin(runRuntimeSpans, and(
      eq(runRuntimeSpans.runId, heartbeatRuns.id), eq(runRuntimeSpans.orgId, input.orgId),
    )).where(and(eq(heartbeatRuns.orgId, input.orgId), eq(runRuntimeSpans.segmentId, segment.id))).limit(1);
    await db.insert(sideChatProviderCleanupIntents).values({
      orgId: input.orgId, conversationId: input.conversationId, ownerUserId: input.ownerUserId,
      principalScopeRef: input.binding.principalScopeRef, bindingId: input.binding.id, bindingEpoch: input.binding.bindingEpoch,
      segmentId: segment.id, agentId: input.binding.agentId, runtimeType: input.binding.runtimeType,
      hostId: input.binding.hostId, profileId: input.binding.profileId, workspaceBindingId: input.binding.workspaceBindingId,
      capabilityRevision: input.binding.capabilityRevision, parentBindingId: input.binding.parentBindingId,
      sourceBoundaryRef: input.binding.sourceBoundaryRef, nativeSessionId: segment.nativeSessionId,
      sessionParamsJson: segment.providerStateJson ?? { sessionId: segment.nativeSessionId },
      profileSnapshotJson: (run?.heartbeat_runs.contextSnapshot?.runtimeProviderProfile as Record<string, unknown>) ?? {},
      protectionRefsJson: { version: 1, bindingIds: [input.binding.id], segmentIds: [segment.id], conversationIds: [],
        runIds: run ? [run.heartbeat_runs.id] : [], providerSessionIds: [segment.nativeSessionId], retentionResourceRefs: [], sourceAliasRefs: [] },
      state: "review_required", stateReason: "retained_native_source_requires_root_session_cleanup_authority",
    }).onConflictDoNothing();
  }
}

export async function noteReleasedNativeSourceAliasesInTransaction(
  db: RuntimeRetentionDb,
  input: { orgId: string; aliases: readonly SourceAliasRow[] },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  for (const bindingId of distinct(input.aliases.map((alias) => alias.bindingId).filter((id): id is string => Boolean(id)))) {
    const [reference] = await db.select({ id: runtimeSourceAliases.id }).from(runtimeSourceAliases).where(and(
      eq(runtimeSourceAliases.orgId, input.orgId), eq(runtimeSourceAliases.bindingId, bindingId),
    )).limit(1);
    if (reference) continue;
    // Invalidate any stale cleanup lease; root-session deletion still needs
    // explicit ownership/capability proof rather than a Side Fork API guess.
    await db.update(sideChatProviderCleanupIntents).set({
      state: "review_required", stateReason: "retained_native_source_last_alias_released_cleanup_review_required",
      leaseOwner: null, leaseExpiresAt: null, leaseEpoch: sql`${sideChatProviderCleanupIntents.leaseEpoch} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(sideChatProviderCleanupIntents.orgId, input.orgId),
      eq(sideChatProviderCleanupIntents.bindingId, bindingId), eq(sideChatProviderCleanupIntents.state, "review_required"),
      eq(sideChatProviderCleanupIntents.stateReason, "retained_native_source_requires_root_session_cleanup_authority")));
  }
}

async function activeClaimsForSpec(
  db: RuntimeRetentionDb,
  orgId: string,
  spec: RuntimeRetentionClaimSpec,
) {
  return db
    .select()
    .from(runtimeRetentionClaims)
    .where(and(
      eq(runtimeRetentionClaims.orgId, orgId),
      eq(runtimeRetentionClaims.resourceRef, spec.resourceRef),
      eq(runtimeRetentionClaims.purpose, spec.purpose),
      eq(runtimeRetentionClaims.status, "active"),
    ))
    .for("update");
}

export async function ensureRuntimeRetentionClaimsInTransaction(
  db: RuntimeRetentionDb,
  input: { orgId: string; claims: readonly RuntimeRetentionClaimSpec[] },
) {
  if (input.claims.length === 0) return [] as ClaimRow[];
  await lockRuntimeRetentionScope(db, input.orgId);
  const createdOrExisting: ClaimRow[] = [];
  for (const rawSpec of input.claims) {
    const spec: RuntimeRetentionClaimSpec = {
      ...rawSpec,
      resourceRef: requiredText(rawSpec.resourceRef, "resourceRef"),
      purpose: requiredText(rawSpec.purpose, "purpose"),
      principalScopeRef: requiredText(rawSpec.principalScopeRef, "principalScopeRef"),
    };
    const [existing] = await activeClaimsForSpec(db, input.orgId, spec);
    if (existing) {
      assertClaimOwnership(existing, spec);
      if (
        existing.expiresAt
        && spec.expiresAt
        && spec.expiresAt.getTime() > existing.expiresAt.getTime()
      ) {
        const [renewed] = await db
          .update(runtimeRetentionClaims)
          .set({
            expiresAt: spec.expiresAt,
            lifecycleVersion: sql`${runtimeRetentionClaims.lifecycleVersion} + 1`,
            cleanupEpoch: sql`${runtimeRetentionClaims.cleanupEpoch} + 1`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(runtimeRetentionClaims.id, existing.id),
            eq(runtimeRetentionClaims.status, "active"),
            eq(runtimeRetentionClaims.lifecycleVersion, existing.lifecycleVersion),
            eq(runtimeRetentionClaims.cleanupEpoch, existing.cleanupEpoch),
          ))
          .returning();
        if (!renewed) throw new RuntimeRetentionFenceError(`Retention claim ${existing.id} changed while renewing`);
        createdOrExisting.push(renewed);
      } else {
        createdOrExisting.push(existing);
      }
      continue;
    }

    const [inserted] = await db
      .insert(runtimeRetentionClaims)
      .values({
        orgId: input.orgId,
        bindingId: spec.bindingId ?? null,
        segmentId: spec.segmentId ?? null,
        resourceRef: spec.resourceRef,
        purpose: spec.purpose,
        principalScopeRef: spec.principalScopeRef,
        expiresAt: spec.expiresAt ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      createdOrExisting.push(inserted);
      continue;
    }

    const [raced] = await activeClaimsForSpec(db, input.orgId, spec);
    if (!raced) throw new RuntimeRetentionConflictError("Retention claim was concurrently removed");
    assertClaimOwnership(raced, spec);
    createdOrExisting.push(raced);
  }
  return createdOrExisting;
}

async function scopedClaims(
  db: RuntimeRetentionDb,
  input: { orgId: string; purpose: string; principalScopeRef: string },
  statuses: readonly ClaimRow["status"][],
) {
  return db
    .select()
    .from(runtimeRetentionClaims)
    .where(and(
      claimScopeCondition(input),
      inArray(runtimeRetentionClaims.status, statuses),
    ))
    .for("update");
}

function assertExpectedFences(
  rows: ReadonlyArray<Pick<ClaimRow | SourceAliasRow, "id" | "lifecycleVersion" | "cleanupEpoch">>,
  expectedFences: readonly RuntimeRetentionClaimFence[] | undefined,
) {
  for (const expected of expectedFences ?? []) {
    const actual = rows.find((row) => row.id === expected.id);
    if (
      !actual
      || actual.lifecycleVersion !== expected.lifecycleVersion
      || actual.cleanupEpoch !== expected.cleanupEpoch
    ) {
      throw new RuntimeRetentionFenceError(`Retention resource ${expected.id} changed while applying a lifecycle transition`);
    }
  }
}

export async function renewRuntimeRetentionClaimsInTransaction(
  db: RuntimeRetentionDb,
  input: {
    orgId: string;
    purpose: string;
    principalScopeRef: string;
    expiresAt: Date;
    expectedFences?: readonly RuntimeRetentionClaimFence[];
  },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  const rows = await scopedClaims(db, input, ["active"]);
  assertExpectedFences(rows, input.expectedFences);
  const now = new Date();
  const renewed: ClaimRow[] = [];
  for (const row of rows) {
    if (!row.expiresAt) continue;
    const [updated] = await db
      .update(runtimeRetentionClaims)
      .set({
        expiresAt: input.expiresAt,
        lifecycleVersion: sql`${runtimeRetentionClaims.lifecycleVersion} + 1`,
        cleanupEpoch: sql`${runtimeRetentionClaims.cleanupEpoch} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(runtimeRetentionClaims.id, row.id),
        eq(runtimeRetentionClaims.status, "active"),
        eq(runtimeRetentionClaims.lifecycleVersion, row.lifecycleVersion),
        eq(runtimeRetentionClaims.cleanupEpoch, row.cleanupEpoch),
      ))
      .returning();
    if (!updated) throw new RuntimeRetentionFenceError(`Retention claim ${row.id} changed while renewing`);
    renewed.push(updated);
  }
  return renewed;
}

export async function promoteRuntimeRetentionClaimsInTransaction(
  db: RuntimeRetentionDb,
  input: {
    orgId: string;
    purpose: string;
    principalScopeRef: string;
    expectedFences?: readonly RuntimeRetentionClaimFence[];
  },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  const rows = await scopedClaims(db, input, ["active"]);
  assertExpectedFences(rows, input.expectedFences);
  const now = new Date();
  const promoted: ClaimRow[] = [];
  for (const row of rows) {
    if (!row.expiresAt) {
      promoted.push(row);
      continue;
    }
    const [updated] = await db
      .update(runtimeRetentionClaims)
      .set({
        expiresAt: null,
        lifecycleVersion: sql`${runtimeRetentionClaims.lifecycleVersion} + 1`,
        cleanupEpoch: sql`${runtimeRetentionClaims.cleanupEpoch} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(runtimeRetentionClaims.id, row.id),
        eq(runtimeRetentionClaims.status, "active"),
        eq(runtimeRetentionClaims.lifecycleVersion, row.lifecycleVersion),
        eq(runtimeRetentionClaims.cleanupEpoch, row.cleanupEpoch),
      ))
      .returning();
    if (!updated) throw new RuntimeRetentionFenceError(`Retention claim ${row.id} changed while promoting`);
    promoted.push(updated);
  }
  return promoted;
}

export async function expireRuntimeRetentionClaimsInTransaction(
  db: RuntimeRetentionDb,
  input: {
    orgId: string;
    purpose: string;
    principalScopeRef: string;
    now?: Date;
    force?: boolean;
    expectedFences?: readonly RuntimeRetentionClaimFence[];
  },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  const rows = await scopedClaims(db, input, ["active"]);
  assertExpectedFences(rows, input.expectedFences);
  const now = input.now ?? new Date();
  const expired: ClaimRow[] = [];
  for (const row of rows) {
    if (!row.expiresAt || (!input.force && row.expiresAt.getTime() > now.getTime())) continue;
    const [updated] = await db
      .update(runtimeRetentionClaims)
      .set({
        status: "expired",
        lifecycleVersion: sql`${runtimeRetentionClaims.lifecycleVersion} + 1`,
        cleanupEpoch: sql`${runtimeRetentionClaims.cleanupEpoch} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(runtimeRetentionClaims.id, row.id),
        eq(runtimeRetentionClaims.status, "active"),
        eq(runtimeRetentionClaims.lifecycleVersion, row.lifecycleVersion),
        eq(runtimeRetentionClaims.cleanupEpoch, row.cleanupEpoch),
      ))
      .returning();
    if (!updated) throw new RuntimeRetentionFenceError(`Retention claim ${row.id} changed while expiring`);
    expired.push(updated);
  }
  return expired;
}

export async function releaseRuntimeRetentionClaimsInTransaction(
  db: RuntimeRetentionDb,
  input: {
    orgId: string;
    purpose: string;
    principalScopeRef: string;
    now?: Date;
    expectedFences?: readonly RuntimeRetentionClaimFence[];
  },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  const rows = await scopedClaims(db, input, ["active", "expired"]);
  assertExpectedFences(rows, input.expectedFences);
  const now = input.now ?? new Date();
  const released: ClaimRow[] = [];
  for (const row of rows) {
    const [updated] = await db
      .update(runtimeRetentionClaims)
      .set({
        status: "released",
        releasedAt: row.releasedAt ?? now,
        lifecycleVersion: sql`${runtimeRetentionClaims.lifecycleVersion} + 1`,
        cleanupEpoch: sql`${runtimeRetentionClaims.cleanupEpoch} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(runtimeRetentionClaims.id, row.id),
        inArray(runtimeRetentionClaims.status, ["active", "expired"]),
        eq(runtimeRetentionClaims.lifecycleVersion, row.lifecycleVersion),
        eq(runtimeRetentionClaims.cleanupEpoch, row.cleanupEpoch),
      ))
      .returning();
    if (!updated) throw new RuntimeRetentionFenceError(`Retention claim ${row.id} changed while releasing`);
    released.push(updated);
  }
  return released;
}

export async function deleteReleasedRuntimeRetentionClaimsInTransaction(
  db: RuntimeRetentionDb,
  input: { orgId: string; purpose: string; principalScopeRef: string },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  return db
    .delete(runtimeRetentionClaims)
    .where(and(
      claimScopeCondition(input),
      inArray(runtimeRetentionClaims.status, ["released", "expired"]),
    ))
    .returning({ id: runtimeRetentionClaims.id });
}

export async function ensureRuntimeSourceAliasInTransaction(
  db: RuntimeRetentionDb,
  input: { orgId: string; alias: RuntimeRetentionSourceAliasSpec },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  const alias = {
    ...input.alias,
    sourceKind: requiredText(input.alias.sourceKind, "sourceKind"),
    sourceRef: requiredText(input.alias.sourceRef, "sourceRef"),
    principalScopeRef: requiredText(input.alias.principalScopeRef, "principalScopeRef"),
  };
  const [existing] = await db
    .select()
    .from(runtimeSourceAliases)
    .where(and(
      eq(runtimeSourceAliases.orgId, input.orgId),
      eq(runtimeSourceAliases.sourceKind, alias.sourceKind),
      eq(runtimeSourceAliases.sourceRef, alias.sourceRef),
      eq(runtimeSourceAliases.principalScopeRef, alias.principalScopeRef),
      isNull(runtimeSourceAliases.releasedAt),
    ))
    .for("update");
  if (existing) {
    assertSourceAliasOwnership(existing, alias);
    if (
      existing.expiresAt
      && alias.expiresAt
      && alias.expiresAt.getTime() > existing.expiresAt.getTime()
    ) {
      const [updated] = await db
        .update(runtimeSourceAliases)
        .set({
          expiresAt: alias.expiresAt,
          lifecycleVersion: sql`${runtimeSourceAliases.lifecycleVersion} + 1`,
          cleanupEpoch: sql`${runtimeSourceAliases.cleanupEpoch} + 1`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(runtimeSourceAliases.id, existing.id),
          isNull(runtimeSourceAliases.releasedAt),
          eq(runtimeSourceAliases.lifecycleVersion, existing.lifecycleVersion),
          eq(runtimeSourceAliases.cleanupEpoch, existing.cleanupEpoch),
        ))
        .returning();
      if (!updated) throw new RuntimeRetentionFenceError(`Source alias ${existing.id} changed while renewing`);
      return updated;
    }
    return existing;
  }
  const [created] = await db.insert(runtimeSourceAliases).values({
    orgId: input.orgId,
    conversationId: alias.conversationId ?? null,
    runId: alias.runId ?? null,
    bindingId: alias.bindingId ?? null,
    segmentId: alias.segmentId ?? null,
    sourceKind: alias.sourceKind,
    sourceRef: alias.sourceRef,
    sourceRangeJson: alias.sourceRangeJson ?? {},
    contentSha256: alias.contentSha256 ?? null,
    principalScopeRef: alias.principalScopeRef,
    expiresAt: alias.expiresAt ?? null,
    readOnly: true,
  }).returning();
  if (!created) throw new RuntimeRetentionConflictError("Failed to create runtime source alias");
  return created;
}

export async function promoteRuntimeSourceAliasesInTransaction(
  db: RuntimeRetentionDb,
  input: { orgId: string; principalScopeRef: string; sourceRefs?: readonly string[] },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  const conditions = [
    eq(runtimeSourceAliases.orgId, input.orgId),
    eq(runtimeSourceAliases.principalScopeRef, input.principalScopeRef),
    isNull(runtimeSourceAliases.releasedAt),
  ];
  if (input.sourceRefs?.length) conditions.push(inArray(runtimeSourceAliases.sourceRef, input.sourceRefs));
  return db.update(runtimeSourceAliases)
    .set({
      expiresAt: null,
      lifecycleVersion: sql`${runtimeSourceAliases.lifecycleVersion} + 1`,
      cleanupEpoch: sql`${runtimeSourceAliases.cleanupEpoch} + 1`,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning();
}

export async function releaseRuntimeSourceAliasesInTransaction(
  db: RuntimeRetentionDb,
  input: { orgId: string; principalScopeRef: string; sourceRefs?: readonly string[]; now?: Date },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  const conditions = [
    eq(runtimeSourceAliases.orgId, input.orgId),
    eq(runtimeSourceAliases.principalScopeRef, input.principalScopeRef),
    isNull(runtimeSourceAliases.releasedAt),
  ];
  if (input.sourceRefs?.length) conditions.push(inArray(runtimeSourceAliases.sourceRef, input.sourceRefs));
  return db.update(runtimeSourceAliases)
    .set({
      releasedAt: input.now ?? new Date(),
      lifecycleVersion: sql`${runtimeSourceAliases.lifecycleVersion} + 1`,
      cleanupEpoch: sql`${runtimeSourceAliases.cleanupEpoch} + 1`,
      updatedAt: input.now ?? new Date(),
    })
    .where(and(...conditions))
    .returning();
}

export async function deleteReleasedRuntimeSourceAliasesInTransaction(
  db: RuntimeRetentionDb,
  input: { orgId: string; principalScopeRef: string; sourceRefs?: readonly string[] },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  const conditions = [
    eq(runtimeSourceAliases.orgId, input.orgId),
    eq(runtimeSourceAliases.principalScopeRef, input.principalScopeRef),
    isNotNull(runtimeSourceAliases.releasedAt),
  ];
  if (input.sourceRefs?.length) conditions.push(inArray(runtimeSourceAliases.sourceRef, input.sourceRefs));
  return db.delete(runtimeSourceAliases)
    .where(and(...conditions))
    .returning({ id: runtimeSourceAliases.id });
}

async function inspectRuntimeRetentionInTransaction(
  db: RuntimeRetentionDb,
  input: { orgId: string; resourceRefs: readonly string[]; runIds?: readonly string[]; now?: Date },
): Promise<RuntimeRetentionInspection> {
  const resourceRefs = distinct(input.resourceRefs);
  if (resourceRefs.length === 0) throw new Error("resourceRefs must not be empty");
  const now = input.now ?? new Date();
  const allClaims = await db.select().from(runtimeRetentionClaims).where(eq(runtimeRetentionClaims.orgId, input.orgId));
  const allAliases = await db.select().from(runtimeSourceAliases).where(eq(runtimeSourceAliases.orgId, input.orgId));
  const directResourceRefs = new Set(resourceRefs);
  const directClaims = allClaims.filter((claim) => directResourceRefs.has(claim.resourceRef));
  const directAliases = allAliases.filter((alias) => directResourceRefs.has(alias.sourceRef));

  // Include spans whose object pointer is itself the requested resource. The
  // old claim-only lookup missed this path, allowing an expired claim/object
  // sweep to delete a transcript while its run was still executing.
  const directSpanMatches = await db.select({
    id: runRuntimeSpans.id,
    runId: runRuntimeSpans.runId,
    bindingId: runRuntimeSpans.bindingId,
    segmentId: runRuntimeSpans.segmentId,
    supplementalObjectRef: runRuntimeSpans.supplementalObjectRef,
    state: runRuntimeSpans.state,
    conversationId: runtimeBindings.conversationId,
    sideChatState: chatConversations.sideChatState,
  })
    .from(runRuntimeSpans)
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, runRuntimeSpans.runId),
      eq(heartbeatRuns.orgId, input.orgId),
    ))
    .leftJoin(runtimeBindings, and(
      eq(runtimeBindings.id, runRuntimeSpans.bindingId),
      eq(runtimeBindings.orgId, input.orgId),
    ))
    .leftJoin(chatConversations, and(
      eq(chatConversations.id, runtimeBindings.conversationId),
      eq(chatConversations.orgId, input.orgId),
    ))
    .where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      inArray(runRuntimeSpans.supplementalObjectRef, resourceRefs),
    ));

  const bindingIds = distinct([
    ...directClaims.map((claim) => claim.bindingId),
    ...directAliases.map((alias) => alias.bindingId),
    ...directSpanMatches.map((span) => span.bindingId),
  ].filter((id): id is string => Boolean(id)));
  const segmentIds = distinct([
    ...directClaims.map((claim) => claim.segmentId),
    ...directAliases.map((alias) => alias.segmentId),
    ...directSpanMatches.map((span) => span.segmentId),
  ].filter((id): id is string => Boolean(id)));
  const runIds = distinct([
    ...(input.runIds ?? []),
    ...directAliases.map((alias) => alias.runId),
    ...directSpanMatches.map((span) => span.runId),
  ].filter((id): id is string => Boolean(id)));
  const relatedClaims = allClaims.filter((claim) =>
    directResourceRefs.has(claim.resourceRef)
    || (claim.bindingId !== null && bindingIds.includes(claim.bindingId))
    || (claim.segmentId !== null && segmentIds.includes(claim.segmentId)),
  );
  const relatedAliases = allAliases.filter((alias) =>
    directResourceRefs.has(alias.sourceRef)
    || (alias.bindingId !== null && bindingIds.includes(alias.bindingId))
    || (alias.segmentId !== null && segmentIds.includes(alias.segmentId))
    || (alias.runId !== null && runIds.includes(alias.runId)),
  );
  const relatedBindingIds = distinct([
    ...bindingIds,
    ...relatedClaims.map((claim) => claim.bindingId),
    ...relatedAliases.map((alias) => alias.bindingId),
  ].filter((id): id is string => Boolean(id)));
  const relatedSegmentIds = distinct([
    ...segmentIds,
    ...relatedClaims.map((claim) => claim.segmentId),
    ...relatedAliases.map((alias) => alias.segmentId),
  ].filter((id): id is string => Boolean(id)));
  const relatedRunIds = distinct([
    ...runIds,
    ...relatedAliases.map((alias) => alias.runId),
  ].filter((id): id is string => Boolean(id)));
  const spanMatchConditions = [
    inArray(runRuntimeSpans.supplementalObjectRef, resourceRefs),
    ...(relatedBindingIds.length > 0 ? [inArray(runRuntimeSpans.bindingId, relatedBindingIds)] : []),
    ...(relatedSegmentIds.length > 0 ? [inArray(runRuntimeSpans.segmentId, relatedSegmentIds)] : []),
    ...(relatedRunIds.length > 0 ? [inArray(runRuntimeSpans.runId, relatedRunIds)] : []),
  ];
  const spanMatches = await db.select({
    id: runRuntimeSpans.id,
    runId: runRuntimeSpans.runId,
    state: runRuntimeSpans.state,
    conversationId: runtimeBindings.conversationId,
    sideChatState: chatConversations.sideChatState,
  })
    .from(runRuntimeSpans)
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, runRuntimeSpans.runId),
      eq(heartbeatRuns.orgId, input.orgId),
    ))
    .leftJoin(runtimeBindings, and(
      eq(runtimeBindings.id, runRuntimeSpans.bindingId),
      eq(runtimeBindings.orgId, input.orgId),
    ))
    .leftJoin(chatConversations, and(
      eq(chatConversations.id, runtimeBindings.conversationId),
      eq(chatConversations.orgId, input.orgId),
    ))
    .where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      or(...spanMatchConditions),
    ));
  const runMatches = relatedRunIds.length > 0
    ? await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.orgId, input.orgId),
      inArray(heartbeatRuns.id, relatedRunIds),
      or(
        inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
        eq(heartbeatRuns.terminalEffectsPending, true),
      ),
    ))
    : [];
  // A claim is an explicit reference to the requested resource. Claims that
  // merely share a binding/segment protect the object sweep, but must not
  // mask the more precise active-run/Reader reason for a different resource.
  const activeClaims = directClaims.filter((claim) => claim.status === "active");
  const activeAliases = directAliases.filter((alias) => isLiveAlias(alias, now));
  const keptConversationIds = distinct([
    ...spanMatches
      .filter((span) => span.sideChatState === "kept")
      .map((span) => span.conversationId),
    ...directAliases
      .filter((alias) => isLiveAlias(alias, now))
      .map((alias) => alias.conversationId),
  ].filter((id): id is string => Boolean(id)));
  const inFlightSpanIds = distinct(spanMatches
    .filter((span) =>
      ACTIVE_SPAN_STATES.includes(span.state as (typeof ACTIVE_SPAN_STATES)[number])
      || runMatches.some((run) => run.id === span.runId),
    )
    .map((span) => span.id));
  const inFlightRunIds = distinct([
    ...spanMatches.filter((span) => inFlightSpanIds.includes(span.id)).map((span) => span.runId),
    ...runMatches.map((run) => run.id),
  ]);
  const blockedBy = activeClaims.length > 0
    ? "claim"
    : activeAliases.length > 0
      ? "source_alias"
      : keptConversationIds.length > 0
        ? "kept_chat"
        : inFlightSpanIds.length > 0 || inFlightRunIds.length > 0
          ? "in_flight"
          : null;
  return {
    resourceRefs,
    activeClaimIds: activeClaims.map((claim) => claim.id),
    activeAliasIds: activeAliases.map((alias) => alias.id),
    keptConversationIds,
    inFlightSpanIds,
    inFlightRunIds,
    collectable: blockedBy === null,
    blockedBy,
  };
}

export async function inspectRuntimeRetention(
  db: RuntimeRetentionDb,
  input: { orgId: string; resourceRefs: readonly string[]; runIds?: readonly string[]; now?: Date },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  return inspectRuntimeRetentionInTransaction(db, input);
}

export async function gcExpiredRuntimeRetentionInTransaction(
  db: RuntimeRetentionDb,
  input: {
    orgId: string;
    resourceRefs: readonly string[];
    runIds?: readonly string[];
    now?: Date;
    expectedFences?: readonly RuntimeRetentionClaimFence[];
  },
): Promise<RuntimeRetentionGcResult> {
  await lockRuntimeRetentionScope(db, input.orgId);
  const resourceRefs = distinct(input.resourceRefs);
  if (resourceRefs.length === 0) throw new Error("resourceRefs must not be empty");
  const now = input.now ?? new Date();
  const claims = await db.select().from(runtimeRetentionClaims).where(and(
    eq(runtimeRetentionClaims.orgId, input.orgId),
    inArray(runtimeRetentionClaims.resourceRef, resourceRefs),
  )).for("update");
  const aliases = await db.select().from(runtimeSourceAliases).where(and(
    eq(runtimeSourceAliases.orgId, input.orgId),
    inArray(runtimeSourceAliases.sourceRef, resourceRefs),
  )).for("update");
  try {
    assertExpectedFences([...claims, ...aliases], input.expectedFences);
  } catch (error) {
    const inspection = await inspectRuntimeRetentionInTransaction(db, input);
    return {
      ...inspection,
      status: "fenced",
      collectable: false,
      expiredClaimIds: [],
      releasedAliasIds: [],
    };
  }

  const preflight = await inspectRuntimeRetentionInTransaction(db, input);
  if (preflight.inFlightSpanIds.length > 0 || preflight.inFlightRunIds.length > 0) {
    return {
      ...preflight,
      status: "blocked",
      collectable: false,
      expiredClaimIds: [],
      releasedAliasIds: [],
    };
  }

  const expiredClaimIds: string[] = [];
  for (const claim of claims) {
    if (claim.status !== "active" || !claim.expiresAt || claim.expiresAt.getTime() > now.getTime()) continue;
    const [updated] = await db.update(runtimeRetentionClaims)
      .set({
        status: "expired",
        lifecycleVersion: sql`${runtimeRetentionClaims.lifecycleVersion} + 1`,
        cleanupEpoch: sql`${runtimeRetentionClaims.cleanupEpoch} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(runtimeRetentionClaims.id, claim.id),
        eq(runtimeRetentionClaims.status, "active"),
        eq(runtimeRetentionClaims.lifecycleVersion, claim.lifecycleVersion),
        eq(runtimeRetentionClaims.cleanupEpoch, claim.cleanupEpoch),
      ))
      .returning({ id: runtimeRetentionClaims.id });
    if (!updated) throw new RuntimeRetentionFenceError(`Retention claim ${claim.id} changed during GC`);
    expiredClaimIds.push(updated.id);
  }

  const releasedAliasIds: string[] = [];
  for (const alias of aliases) {
    if (alias.releasedAt || !alias.expiresAt || alias.expiresAt.getTime() > now.getTime()) continue;
    const [updated] = await db.update(runtimeSourceAliases)
      .set({
        releasedAt: now,
        lifecycleVersion: sql`${runtimeSourceAliases.lifecycleVersion} + 1`,
        cleanupEpoch: sql`${runtimeSourceAliases.cleanupEpoch} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(runtimeSourceAliases.id, alias.id),
        isNull(runtimeSourceAliases.releasedAt),
        eq(runtimeSourceAliases.lifecycleVersion, alias.lifecycleVersion),
        eq(runtimeSourceAliases.cleanupEpoch, alias.cleanupEpoch),
      ))
      .returning({ id: runtimeSourceAliases.id });
    if (!updated) throw new RuntimeRetentionFenceError(`Source alias ${alias.id} changed during GC`);
    releasedAliasIds.push(updated.id);
  }

  const inspection = await inspectRuntimeRetentionInTransaction(db, input);
  return {
    ...inspection,
    status: inspection.collectable ? "collectable" : "blocked",
    expiredClaimIds,
    releasedAliasIds,
  };
}

export async function deleteCollectableRuntimeRetentionInTransaction(
  db: RuntimeRetentionDb,
  input: { orgId: string; resourceRefs: readonly string[]; now?: Date },
) {
  await lockRuntimeRetentionScope(db, input.orgId);
  const inspection = await inspectRuntimeRetentionInTransaction(db, input);
  if (!inspection.collectable) {
    return { claimIds: [] as string[], aliasIds: [] as string[] };
  }
  const resourceRefs = distinct(input.resourceRefs);
  const [claims, aliases] = await Promise.all([
    db.select({ id: runtimeRetentionClaims.id })
      .from(runtimeRetentionClaims)
      .where(and(
        eq(runtimeRetentionClaims.orgId, input.orgId),
        inArray(runtimeRetentionClaims.resourceRef, resourceRefs),
        inArray(runtimeRetentionClaims.status, ["released", "expired"]),
      ))
      .for("update"),
    db.select({ id: runtimeSourceAliases.id })
      .from(runtimeSourceAliases)
      .where(and(
        eq(runtimeSourceAliases.orgId, input.orgId),
        inArray(runtimeSourceAliases.sourceRef, resourceRefs),
        isNotNull(runtimeSourceAliases.releasedAt),
      ))
      .for("update"),
  ]);
  const claimIds = claims.map((claim) => claim.id);
  const aliasIds = aliases.map((alias) => alias.id);
  if (claimIds.length > 0) {
    await db.delete(runtimeRetentionClaims).where(and(
      eq(runtimeRetentionClaims.orgId, input.orgId),
      inArray(runtimeRetentionClaims.id, claimIds),
      inArray(runtimeRetentionClaims.status, ["released", "expired"]),
    ));
  }
  if (aliasIds.length > 0) {
    await db.delete(runtimeSourceAliases).where(and(
      eq(runtimeSourceAliases.orgId, input.orgId),
      inArray(runtimeSourceAliases.id, aliasIds),
      isNotNull(runtimeSourceAliases.releasedAt),
    ));
  }
  return { claimIds, aliasIds };
}

export type RuntimeRetentionMaintenanceOptions = {
  objectStore?: TranscriptObjectStore;
  now?: Date;
  objectGraceMs?: number;
  objectLimit?: number;
};

export type RuntimeRetentionMaintenanceResult = {
  organizationCount: number;
  resourceCount: number;
  expiredClaimCount: number;
  releasedAliasCount: number;
  deletedClaimCount: number;
  deletedAliasCount: number;
  nativeTranscriptRecovery: { attempted: number; recovered: number };
  objectSweep: TranscriptObjectSweepResult;
};

type RuntimeRetentionMaintenanceSpan = {
  orgId: string;
  supplementalObjectRef: string | null;
};

// Temporary Side Chats are no longer keepable after expiry, but retain their
// full supplemental transcript for a bounded read-only recovery window.
export const EXPIRED_SIDE_CHAT_TRANSCRIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function retentionResourceMap(rows: readonly { orgId: string; resourceRef: string }[]) {
  const byOrg = new Map<string, Set<string>>();
  for (const row of rows) {
    const resourceRef = row.resourceRef.trim();
    if (!resourceRef) continue;
    const refs = byOrg.get(row.orgId) ?? new Set<string>();
    refs.add(resourceRef);
    byOrg.set(row.orgId, refs);
  }
  return byOrg;
}

function spanPermanentlyPinsTranscript(
  span: { supplementalObjectRef: string | null } | undefined,
  objectRef: string,
) {
  // Readers resolve this durable pointer directly; an expired temporary Side
  // Chat is the only case with a bounded detach lifecycle.
  return span?.supplementalObjectRef?.trim() === objectRef;
}

async function collectTranscriptObjectUnderRetentionLock(
  db: RuntimeRetentionDb,
  candidate: TranscriptObjectSweepCandidate,
  now: Date,
  collect: () => Promise<boolean>,
): Promise<TranscriptObjectSweepGuardResult> {
  await lockRuntimeRetentionScope(db, candidate.orgId);
  const [span] = await db.select({
    id: runRuntimeSpans.id,
    runId: runRuntimeSpans.runId,
    bindingId: runRuntimeSpans.bindingId,
    segmentId: runRuntimeSpans.segmentId,
    supplementalObjectRef: runRuntimeSpans.supplementalObjectRef,
    supplementalRetentionExpiredAt: runRuntimeSpans.supplementalRetentionExpiredAt,
    state: runRuntimeSpans.state,
    closedAt: runRuntimeSpans.closedAt,
  }).from(runRuntimeSpans).where(and(
    eq(runRuntimeSpans.orgId, candidate.orgId),
    eq(runRuntimeSpans.id, candidate.spanId),
    eq(runRuntimeSpans.runId, candidate.runId),
  )).for("update");

  // A missing payload can only be a retry after the prior marked deletion
  // removed it; the generic retention guard is not enough to prove that.
  if (candidate.payloadMissing && !(
    span?.supplementalObjectRef === candidate.objectRef
    && span.supplementalRetentionExpiredAt instanceof Date
  )) return "skipped";

  const claims = await db.select().from(runtimeRetentionClaims).where(
    eq(runtimeRetentionClaims.orgId, candidate.orgId),
  ).for("update");
  const aliases = await db.select().from(runtimeSourceAliases).where(
    eq(runtimeSourceAliases.orgId, candidate.orgId),
  ).for("update");
  const [scope] = span
    ? await db.select({
      runStatus: heartbeatRuns.status,
      runFinishedAt: heartbeatRuns.finishedAt,
      terminalEffectsPending: heartbeatRuns.terminalEffectsPending,
      conversationId: runtimeBindings.conversationId,
      conversationKind: chatConversations.conversationKind,
      sideChatState: chatConversations.sideChatState,
      sideChatExpiresAt: chatConversations.sideChatExpiresAt,
      sideChatUpdatedAt: chatConversations.updatedAt,
    }).from(heartbeatRuns)
      .innerJoin(runRuntimeSpans, and(
        eq(runRuntimeSpans.runId, heartbeatRuns.id),
        eq(runRuntimeSpans.orgId, heartbeatRuns.orgId),
      ))
      .leftJoin(runtimeBindings, and(
        eq(runtimeBindings.id, span.bindingId),
        eq(runtimeBindings.orgId, candidate.orgId),
      ))
      .leftJoin(chatConversations, and(
        eq(chatConversations.id, runtimeBindings.conversationId),
        eq(chatConversations.orgId, candidate.orgId),
      ))
      .where(and(
        eq(heartbeatRuns.orgId, candidate.orgId),
        eq(heartbeatRuns.id, candidate.runId),
        eq(runRuntimeSpans.id, candidate.spanId),
      ))
      .limit(1)
    : [];

  const activeRun = Boolean(scope && (
    ACTIVE_RUN_STATUSES.includes(scope.runStatus as (typeof ACTIVE_RUN_STATUSES)[number])
    || scope.terminalEffectsPending
    || ACTIVE_SPAN_STATES.includes(span!.state as (typeof ACTIVE_SPAN_STATES)[number])
  ));
  const keptChat = scope?.sideChatState === "kept";
  const expiredAt = scope?.conversationKind === "side_chat"
    ? scope.sideChatState === "expired"
      ? scope.sideChatUpdatedAt
      : scope.sideChatState === "active" && scope.sideChatExpiresAt && scope.sideChatExpiresAt <= now
        ? scope.sideChatExpiresAt
        : null
    : null;
  const expiredSideChatGraceElapsed = expiredAt instanceof Date
    && span?.closedAt instanceof Date
    && now.getTime() - Math.max(
      expiredAt.getTime(),
      span.closedAt.getTime(),
      scope?.runFinishedAt?.getTime() ?? 0,
    ) >= EXPIRED_SIDE_CHAT_TRANSCRIPT_RETENTION_MS;
  const attached = spanPermanentlyPinsTranscript(span, candidate.objectRef);
  const linkedClaim = claims.some((claim) =>
    isLiveClaim(claim, now)
    && (claim.resourceRef === candidate.objectRef
      || claim.bindingId === span?.bindingId
      || claim.segmentId === span?.segmentId),
  );
  const linkedAlias = aliases.some((alias) =>
    isLiveAlias(alias, now)
    && (alias.sourceRef === candidate.objectRef
      || alias.runId === candidate.runId
      || alias.bindingId === span?.bindingId
      || alias.segmentId === span?.segmentId
      || alias.conversationId === scope?.conversationId),
  );

  if (
    (attached && !expiredSideChatGraceElapsed)
    || activeRun
    || keptChat
    || linkedClaim
    || linkedAlias
  ) return "protected";

  if (attached && span && !span.supplementalRetentionExpiredAt) {
    await db.update(runRuntimeSpans).set({ supplementalRetentionExpiredAt: now }).where(and(
      eq(runRuntimeSpans.orgId, candidate.orgId),
      eq(runRuntimeSpans.id, span.id),
      eq(runRuntimeSpans.supplementalObjectRef, candidate.objectRef),
    ));
    return "protected";
  }
  return await collect() ? "deleted" : "skipped";
}

/**
 * One production retention tick. Database lifecycle transitions and object
 * claims/aliases and the object store are coordinated per object at deletion
 * time. Attached span pointers are durable Reader roots; unattached objects
 * become collectible when no live claim, alias, active run, or kept chat pins
 * them and the attach/recovery grace period has elapsed.
 */
export async function runRuntimeRetentionMaintenance(
  db: Db,
  options: RuntimeRetentionMaintenanceOptions = {},
): Promise<RuntimeRetentionMaintenanceResult> {
  const now = options.now ?? new Date();
  const objectGraceMs = options.objectGraceMs ?? 60 * 60 * 1000;
  if (!Number.isFinite(objectGraceMs) || objectGraceMs < 0) {
    throw new Error("invalid_runtime_retention_object_grace_ms");
  }

  const nativeTranscriptRecovery = await retryFailedNativeTranscriptCleanup(db, { now });

  const claims = await db.select().from(runtimeRetentionClaims);
  const aliases = await db.select().from(runtimeSourceAliases);
  const spans = await db.select({
    orgId: runRuntimeSpans.orgId,
    supplementalObjectRef: runRuntimeSpans.supplementalObjectRef,
  }).from(runRuntimeSpans) as RuntimeRetentionMaintenanceSpan[];

  const resources = retentionResourceMap([
    ...claims.map((claim) => ({ orgId: claim.orgId, resourceRef: claim.resourceRef })),
    ...aliases.map((alias) => ({ orgId: alias.orgId, resourceRef: alias.sourceRef })),
    ...spans.flatMap((span) => span.supplementalObjectRef
      ? [{ orgId: span.orgId, resourceRef: span.supplementalObjectRef }]
      : []),
  ]);
  let expiredClaimCount = 0;
  let releasedAliasCount = 0;
  let deletedClaimCount = 0;
  let deletedAliasCount = 0;
  for (const [orgId, refs] of resources) {
    const resourceRefs = [...refs];
    const result = await db.transaction(async (tx) => {
      const txRetention = tx as unknown as RuntimeRetentionDb;
      const gc = await gcExpiredRuntimeRetentionInTransaction(txRetention, {
        orgId,
        resourceRefs,
        now,
      });
      const deleted = gc.collectable
        ? await deleteCollectableRuntimeRetentionInTransaction(txRetention, { orgId, resourceRefs, now })
        : { claimIds: [], aliasIds: [] };
      return { gc, deleted };
    });
    expiredClaimCount += result.gc.expiredClaimIds.length;
    releasedAliasCount += result.gc.releasedAliasIds.length;
    deletedClaimCount += result.deleted.claimIds.length;
    deletedAliasCount += result.deleted.aliasIds.length;
  }

  const objectStore = options.objectStore ?? getTranscriptObjectStore();
  const objectSweep = await objectStore.sweepUnreferenced({
    withRetentionGuard: (candidate, collect) => db.transaction((tx) =>
      collectTranscriptObjectUnderRetentionLock(
        tx as unknown as RuntimeRetentionDb,
        candidate,
        now,
        collect,
      ),
    ),
    now,
    minAgeMs: objectGraceMs,
    limit: options.objectLimit,
  });
  return {
    organizationCount: resources.size,
    resourceCount: [...resources.values()].reduce((total, refs) => total + refs.size, 0),
    expiredClaimCount,
    releasedAliasCount,
    deletedClaimCount,
    deletedAliasCount,
    nativeTranscriptRecovery,
    objectSweep,
  };
}

export type RuntimeRetentionMaintenanceSchedulerOptions = RuntimeRetentionMaintenanceOptions & {
  intervalMs?: number;
  onError?: (error: unknown) => void;
  runMaintenance?: () => Promise<unknown>;
  setIntervalFn?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
};

export function startRuntimeRetentionMaintenance(
  db: Db,
  options: RuntimeRetentionMaintenanceSchedulerOptions = {},
) {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new Error("invalid_runtime_retention_interval_ms");
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const runMaintenance = options.runMaintenance ?? (() => runRuntimeRetentionMaintenance(db, options));
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = runMaintenance()
      .then(() => undefined)
      .catch((error) => options.onError?.(error))
      .finally(() => {
        inFlight = null;
      });
  };
  tick();
  const timer = setIntervalFn(tick, intervalMs);
  timer.unref?.();
  return {
    runNow: tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}

export function runtimeRetentionService(db: Db) {
  const withTransaction = <T>(callback: (tx: RuntimeRetentionDb) => Promise<T>) =>
    db.transaction((tx) => callback(tx as unknown as RuntimeRetentionDb));
  return {
    ensureClaims: (input: { orgId: string; claims: readonly RuntimeRetentionClaimSpec[] }) =>
      withTransaction((tx) => ensureRuntimeRetentionClaimsInTransaction(tx, input)),
    renewClaims: (input: Parameters<typeof renewRuntimeRetentionClaimsInTransaction>[1]) =>
      withTransaction((tx) => renewRuntimeRetentionClaimsInTransaction(tx, input)),
    promoteClaims: (input: Parameters<typeof promoteRuntimeRetentionClaimsInTransaction>[1]) =>
      withTransaction((tx) => promoteRuntimeRetentionClaimsInTransaction(tx, input)),
    expireClaims: (input: Parameters<typeof expireRuntimeRetentionClaimsInTransaction>[1]) =>
      withTransaction((tx) => expireRuntimeRetentionClaimsInTransaction(tx, input)),
    releaseClaims: (input: Parameters<typeof releaseRuntimeRetentionClaimsInTransaction>[1]) =>
      withTransaction((tx) => releaseRuntimeRetentionClaimsInTransaction(tx, input)),
    deleteReleasedClaims: (input: Parameters<typeof deleteReleasedRuntimeRetentionClaimsInTransaction>[1]) =>
      withTransaction((tx) => deleteReleasedRuntimeRetentionClaimsInTransaction(tx, input)),
    ensureSourceAlias: (input: Parameters<typeof ensureRuntimeSourceAliasInTransaction>[1]) =>
      withTransaction((tx) => ensureRuntimeSourceAliasInTransaction(tx, input)),
    promoteSourceAliases: (input: Parameters<typeof promoteRuntimeSourceAliasesInTransaction>[1]) =>
      withTransaction((tx) => promoteRuntimeSourceAliasesInTransaction(tx, input)),
    releaseSourceAliases: (input: Parameters<typeof releaseRuntimeSourceAliasesInTransaction>[1]) =>
      withTransaction((tx) => releaseRuntimeSourceAliasesInTransaction(tx, input)),
    deleteReleasedSourceAliases: (input: Parameters<typeof deleteReleasedRuntimeSourceAliasesInTransaction>[1]) =>
      withTransaction((tx) => deleteReleasedRuntimeSourceAliasesInTransaction(tx, input)),
    inspect: (input: Parameters<typeof inspectRuntimeRetention>[1]) =>
      withTransaction((tx) => inspectRuntimeRetention(tx, input)),
    gcExpired: (input: Parameters<typeof gcExpiredRuntimeRetentionInTransaction>[1]) =>
      withTransaction((tx) => gcExpiredRuntimeRetentionInTransaction(tx, input)),
  };
}
