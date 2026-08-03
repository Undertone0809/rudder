import type { Db } from "@rudderhq/db";
import {
  productAnalyticsConsentLedger,
  productAnalyticsEvents,
  productAnalyticsInstallations,
  productAnalyticsOutbox,
  productAnalyticsWorkCycleRevisions,
  productAnalyticsWorkCycles,
} from "@rudderhq/db";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { forbidden, unauthorized, unprocessable } from "../errors.js";

export const PRODUCT_ANALYTICS_EVENT_NAMES = [
  "organization_created",
  "human_work_started",
  "run_started",
  "run_succeeded",
  "run_failed",
  "output_ready",
  "review_decision_recorded",
  "account_created",
  "desktop_authorized",
  "local_server_connected",
  "first_agent_ready",
  "work_loop_completed",
  "work_loop_invalidated",
] as const;

export const PRODUCT_ANALYTICS_PRODUCED_EVENT_NAMES = [
  "organization_created",
  "human_work_started",
  "run_started",
  "run_succeeded",
  "run_failed",
  "output_ready",
  "first_agent_ready",
  "work_loop_completed",
  "work_loop_invalidated",
] as const;

export const PRODUCT_ANALYTICS_DERIVED_EVENT_NAMES = ["review_decision_recorded"] as const;
export const PRODUCT_ANALYTICS_DEFERRED_EVENT_NAMES = ["account_created", "desktop_authorized", "local_server_connected"] as const;

export type ProductAnalyticsRunTerminalStatus = "succeeded" | "failed" | "cancelled" | "timed_out";

export function productAnalyticsRunTerminalEventName(status: string) {
  if (status === "succeeded") return "run_succeeded" as const;
  if (status === "failed" || status === "cancelled" || status === "timed_out") return "run_failed" as const;
  return null;
}

export type ProductAnalyticsEventName = (typeof PRODUCT_ANALYTICS_EVENT_NAMES)[number];
export type ProductAnalyticsConfidence = "exact" | "derived" | "unknown";
export type ProductAnalyticsActorType = "human" | "agent" | "system" | "automation";
export type ProductAnalyticsPropertyValue = string | number | boolean | null;
export type ProductAnalyticsOrigin = "human" | "automation" | "retry" | "recovery" | "system";
export type ProductAnalyticsEnvironment = "production" | "development" | "test";
export type ProductAnalyticsReleaseChannel = "development" | "preview" | "canary" | "stable";
export type ProductAnalyticsDeploymentMode = "desktop_local" | "self_hosted" | "remote_server";

type AnalyticsProperties = Record<string, ProductAnalyticsPropertyValue>;

const EVENT_NAME_SET = new Set<string>(PRODUCT_ANALYTICS_EVENT_NAMES);
const CONFIDENCE_SET = new Set<ProductAnalyticsConfidence>(["exact", "derived", "unknown"]);
const ACTOR_TYPE_SET = new Set<ProductAnalyticsActorType>(["human", "agent", "system", "automation"]);
// Unknown keys are rejected by the event-specific allowlist. Keep this scan
// focused on content-bearing names so safe dimensions such as creation_path do
// not get rejected by a substring match.
const SENSITIVE_PROPERTY_KEY = /(prompt|transcript|title|description|body|content|url|token|secret|password|credential|email|hostname|username)/i;
const PRODUCT_ANALYTICS_OUTBOX_MAX_ROWS = 10_000;
const PRODUCT_ANALYTICS_OUTBOX_MAX_BYTES = 32 * 1024 * 1024;
export const PRODUCT_ANALYTICS_EVENT_PROPERTY_ALLOWLIST: Record<ProductAnalyticsEventName, ReadonlySet<string>> = {
  organization_created: new Set([
    "creation_path",
    "template_kind",
    "is_first_organization",
    "is_user_initiated",
  ]),
  human_work_started: new Set(["work_surface", "origin"]),
  run_started: new Set(["run_kind", "runtime", "attempt_kind"]),
  run_succeeded: new Set(["run_kind", "runtime", "attempt_kind"]),
  run_failed: new Set(["run_kind", "runtime", "attempt_kind", "terminal_status"]),
  output_ready: new Set(["output_kind"]),
  review_decision_recorded: new Set(["decision", "review_surface"]),
  account_created: new Set(["auth_method", "is_migrated", "acquisition_source"]),
  desktop_authorized: new Set(["client_kind", "release_channel", "coarse_platform", "authorization_kind"]),
  local_server_connected: new Set(["connection_kind"]),
  first_agent_ready: new Set(["runtime_adapter", "is_default_agent", "preflight_result_code", "is_first_for_installation"]),
  work_loop_completed: new Set(["work_surface", "origin", "review_required", "attempt_count", "duration_bucket", "cost_bucket", "output_kind", "is_first_loop"]),
  work_loop_invalidated: new Set(["reason_code", "duration_bucket"]),
};

export type RecordProductAnalyticsEventInput = {
  orgId?: string | null;
  eventName: ProductAnalyticsEventName;
  schemaVersion?: number;
  occurredAt?: Date;
  sourceTransition: string;
  confidence: ProductAnalyticsConfidence;
  actorType: ProductAnalyticsActorType;
  actorId?: string | null;
  localUserId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  environment?: ProductAnalyticsEnvironment;
  appVersion?: string;
  releaseChannel?: ProductAnalyticsReleaseChannel;
  deploymentMode?: ProductAnalyticsDeploymentMode;
  origin?: ProductAnalyticsOrigin;
  workSurface?: "chat" | "issue" | null;
  workId?: string | null;
  workCycleId?: string | null;
  rootRunId?: string | null;
  runId?: string | null;
  completionRevision?: number | null;
  isBackfill?: boolean;
  installationId?: string | null;
  dedupeKey: string;
  properties?: AnalyticsProperties;
};

async function resolveProductAnalyticsInstallationId(db: Db, installationId?: string | null) {
  if (installationId) return installationId;
  if (typeof (db as unknown as { select?: unknown }).select !== "function") return null;
  const [registered] = await db.select({ installationId: productAnalyticsInstallations.installationId })
    .from(productAnalyticsInstallations)
    .orderBy(asc(productAnalyticsInstallations.createdAt))
    .limit(1);
  return registered?.installationId ?? null;
}

function assertBoundedText(value: string, field: string, maxLength: number) {
  if (value.length === 0 || value.length > maxLength) {
    throw unprocessable(`Product analytics ${field} is invalid`);
  }
}

function validateProperties(eventName: ProductAnalyticsEventName, properties: AnalyticsProperties): AnalyticsProperties {
  const allowed = PRODUCT_ANALYTICS_EVENT_PROPERTY_ALLOWLIST[eventName];
  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.has(key) || SENSITIVE_PROPERTY_KEY.test(key)) {
      throw unprocessable(`Product analytics property is not allowed: ${key}`);
    }
    if (typeof value === "string") assertBoundedText(value, `property ${key}`, 80);
    if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > 1_000_000)) {
      throw unprocessable(`Product analytics property is invalid: ${key}`);
    }
    if (typeof value === "object" && value !== null) {
      throw unprocessable(`Product analytics property must be scalar: ${key}`);
    }
  }
  return properties;
}

function validateEvent(input: RecordProductAnalyticsEventInput) {
  if (!EVENT_NAME_SET.has(input.eventName)) {
    throw unprocessable(`Unknown product analytics event: ${input.eventName}`);
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    throw unprocessable("Unsupported product analytics schema version");
  }
  if (!CONFIDENCE_SET.has(input.confidence)) throw unprocessable("Product analytics confidence is invalid");
  if (!ACTOR_TYPE_SET.has(input.actorType)) throw unprocessable("Product analytics actor type is invalid");
  if (input.completionRevision !== undefined && input.completionRevision !== null && (!Number.isInteger(input.completionRevision) || input.completionRevision < 1)) {
    throw unprocessable("Product analytics completion revision is invalid");
  }
  assertBoundedText(input.sourceTransition, "source transition", 120);
  assertBoundedText(input.dedupeKey, "dedupe key", 256);
  if (input.actorId !== undefined && input.actorId !== null) assertBoundedText(input.actorId, "actor id", 200);
  if (input.entityType !== undefined && input.entityType !== null) assertBoundedText(input.entityType, "entity type", 80);
  if (input.entityId !== undefined && input.entityId !== null) assertBoundedText(input.entityId, "entity id", 200);
  if (input.occurredAt && Number.isNaN(input.occurredAt.getTime())) {
    throw unprocessable("Product analytics occurredAt is invalid");
  }
  validateProperties(input.eventName, input.properties ?? {});
}

export async function recordProductAnalyticsEvent(
  db: Db,
  input: RecordProductAnalyticsEventInput,
) {
  validateEvent(input);
  const installationId = await resolveProductAnalyticsInstallationId(db, input.installationId);
  const localUserId = input.localUserId ?? (input.actorType === "human" ? input.actorId ?? null : null);
  const rows = await db
    .insert(productAnalyticsEvents)
    .values({
      orgId: input.orgId,
      installationId,
      eventName: input.eventName,
      schemaVersion: input.schemaVersion ?? 1,
      occurredAt: input.occurredAt ?? new Date(),
      sourceTransition: input.sourceTransition,
      confidence: input.confidence,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      localUserId,
      environment: input.environment ?? (process.env.NODE_ENV === "production" ? "production" : "development"),
      appVersion: input.appVersion ?? "unknown",
      releaseChannel: input.releaseChannel ?? "stable",
      deploymentMode: input.deploymentMode ?? "self_hosted",
      origin: input.origin ?? (input.actorType === "human" ? "human" : input.actorType === "automation" ? "automation" : "system"),
      workSurface: input.workSurface ?? null,
      workId: input.workId ?? input.entityId ?? null,
      workCycleId: input.workCycleId ?? null,
      rootRunId: input.rootRunId ?? null,
      runId: input.runId ?? null,
      completionRevision: input.completionRevision ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      dedupeKey: input.dedupeKey,
      properties: input.properties ?? {},
      isBackfill: input.isBackfill ?? false,
    })
    .onConflictDoNothing({ target: productAnalyticsEvents.dedupeKey })
    .returning({ id: productAnalyticsEvents.id });
  if (rows[0] && installationId) {
    await enqueueProductAnalyticsEvent(db, {
      eventId: rows[0].id,
      installationId,
      localUserId,
    });
  }
  if (rows[0] && input.workCycleId && typeof (db as unknown as { update?: unknown }).update === "function") {
    if (input.eventName === "output_ready") {
      await db.update(productAnalyticsWorkCycles).set({ outputReadyAt: input.occurredAt ?? new Date(), updatedAt: new Date() })
        .where(and(eq(productAnalyticsWorkCycles.orgId, input.orgId as string), eq(productAnalyticsWorkCycles.workCycleId, input.workCycleId)));
    }
    if (input.eventName === "review_decision_recorded") {
      const decision = input.properties?.decision;
      await db.update(productAnalyticsWorkCycles).set({ reviewDecision: typeof decision === "string" ? decision : null, updatedAt: new Date() })
        .where(and(eq(productAnalyticsWorkCycles.orgId, input.orgId as string), eq(productAnalyticsWorkCycles.workCycleId, input.workCycleId)));
    }
  }
  return rows[0] ?? null;
}

export async function enqueueProductAnalyticsEvent(db: Db, input: { eventId: string; installationId: string; localUserId?: string | null }) {
  const [event] = await db.select({ environment: productAnalyticsEvents.environment }).from(productAnalyticsEvents)
    .where(eq(productAnalyticsEvents.id, input.eventId)).limit(1);
  if (!event || event.environment !== "production") return null;
  const [installation] = await db.select({ mode: productAnalyticsInstallations.mode, state: productAnalyticsInstallations.state }).from(productAnalyticsInstallations)
    .where(eq(productAnalyticsInstallations.installationId, input.installationId)).limit(1);
  if (!installation || installation.mode === "off") return null;
  const [backlog] = await db.select({ count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(length(${productAnalyticsEvents.properties}::text)), 0)` })
    .from(productAnalyticsOutbox)
    .innerJoin(productAnalyticsEvents, eq(productAnalyticsOutbox.eventId, productAnalyticsEvents.id))
    .where(and(eq(productAnalyticsOutbox.installationId, input.installationId), inArray(productAnalyticsOutbox.state, ["pending", "claimed", "retry_wait"])));
  if (Number(backlog?.count ?? 0) >= PRODUCT_ANALYTICS_OUTBOX_MAX_ROWS || Number(backlog?.bytes ?? 0) >= PRODUCT_ANALYTICS_OUTBOX_MAX_BYTES) {
    await db.update(productAnalyticsInstallations).set({ state: { ...(installation.state ?? {}), coverageGap: true }, updatedAt: new Date() })
      .where(eq(productAnalyticsInstallations.installationId, input.installationId));
    return null;
  }
  const scope = installation.mode === "account_linked" ? "account_linked_user" : "anonymous_installation";
  const conditions = [eq(productAnalyticsConsentLedger.installationId, input.installationId), eq(productAnalyticsConsentLedger.scope, scope), eq(productAnalyticsConsentLedger.decision, "granted")];
  conditions.push(scope === "account_linked_user" && input.localUserId ? eq(productAnalyticsConsentLedger.localUserId, input.localUserId) : isNull(productAnalyticsConsentLedger.localUserId));
  const [consent] = await db.select().from(productAnalyticsConsentLedger).where(and(...conditions)).orderBy(desc(productAnalyticsConsentLedger.consentEpoch)).limit(1);
  if (!consent) return null;
  const [row] = await db.insert(productAnalyticsOutbox).values({
    eventId: input.eventId,
    installationId: input.installationId,
    deliveryMode: installation.mode,
    consentScope: scope,
    consentedLocalUserId: consent.localUserId ?? null,
    consentVersion: consent.policyVersion,
    consentEpoch: consent.consentEpoch,
  }).onConflictDoNothing().returning();
  return row ?? null;
}

export type EnsureProductAnalyticsWorkCycleInput = {
  orgId: string;
  workSurface: "chat" | "issue";
  workId: string;
  workCycleId: string;
  actorId?: string | null;
  origin?: ProductAnalyticsOrigin;
  startedAt?: Date;
};

export async function ensureProductAnalyticsWorkCycle(db: Db, input: EnsureProductAnalyticsWorkCycleInput) {
  const [row] = await db
    .insert(productAnalyticsWorkCycles)
    .values({
      orgId: input.orgId,
      workSurface: input.workSurface,
      workId: input.workId,
      workCycleId: input.workCycleId,
      actorId: input.actorId ?? null,
      origin: input.origin ?? "human",
      startedAt: input.startedAt ?? new Date(),
    })
    .onConflictDoNothing({ target: [productAnalyticsWorkCycles.orgId, productAnalyticsWorkCycles.workCycleId] })
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(productAnalyticsWorkCycles)
    .where(and(eq(productAnalyticsWorkCycles.orgId, input.orgId), eq(productAnalyticsWorkCycles.workCycleId, input.workCycleId)))
    .limit(1);
  return existing ?? null;
}

export async function completeProductAnalyticsWorkCycle(
  db: Db,
  input: EnsureProductAnalyticsWorkCycleInput & {
    sourceTransition: string;
    actorType: ProductAnalyticsActorType;
    actorId?: string | null;
    rootRunId?: string | null;
    properties?: AnalyticsProperties;
  },
) {
  return db.transaction(async (tx) => {
    const cycle = await ensureProductAnalyticsWorkCycle(tx as unknown as Db, input);
    if (!cycle) throw unprocessable("Product analytics work cycle is unavailable");
    const [lockedCycle] = await tx.select().from(productAnalyticsWorkCycles)
      .where(and(eq(productAnalyticsWorkCycles.orgId, input.orgId), eq(productAnalyticsWorkCycles.workCycleId, input.workCycleId)))
      .for("update");
    if (!lockedCycle) throw unprocessable("Product analytics work cycle is unavailable");
    const [successfulRuns] = await tx.select({ count: sql<number>`count(*)` }).from(productAnalyticsEvents).where(and(
      eq(productAnalyticsEvents.orgId, input.orgId),
      eq(productAnalyticsEvents.workCycleId, input.workCycleId),
      eq(productAnalyticsEvents.eventName, "run_succeeded"),
    ));
    const [readyOutputs] = await tx.select({ count: sql<number>`count(*)` }).from(productAnalyticsEvents).where(and(
      eq(productAnalyticsEvents.orgId, input.orgId),
      eq(productAnalyticsEvents.workCycleId, input.workCycleId),
      eq(productAnalyticsEvents.eventName, "output_ready"),
    ));
    const reviewRequired = input.properties?.review_required === true;
    const [approvedReviews] = reviewRequired
      ? await tx.select({ count: sql<number>`count(*)` }).from(productAnalyticsEvents).where(and(
        eq(productAnalyticsEvents.orgId, input.orgId),
        eq(productAnalyticsEvents.workCycleId, input.workCycleId),
        eq(productAnalyticsEvents.eventName, "review_decision_recorded"),
        sql`${productAnalyticsEvents.properties}->>'decision' = 'approve'`,
      ))
      : [{ count: 1 }];
    if (Number(successfulRuns?.count ?? 0) < 1 || Number(readyOutputs?.count ?? 0) < 1 || Number(approvedReviews?.count ?? 0) < 1) {
      throw unprocessable("Product analytics work cycle does not satisfy completion gates");
    }
    if (lockedCycle.state === "completed" && lockedCycle.invalidatedAt === null) {
      return { event: null, revision: lockedCycle.completionRevision };
    }
    const rootRunRows = await tx.select({ rootRunId: productAnalyticsEvents.rootRunId }).from(productAnalyticsEvents).where(and(
      eq(productAnalyticsEvents.orgId, input.orgId),
      eq(productAnalyticsEvents.workCycleId, input.workCycleId),
      sql`${productAnalyticsEvents.rootRunId} is not null`,
    ));
    const rootRunIds = [...new Set([
      ...(lockedCycle.rootRunIds ?? []),
      ...rootRunRows.map((row) => row.rootRunId).filter((value): value is string => Boolean(value)),
      ...(input.rootRunId ? [input.rootRunId] : []),
    ])];
    const revision = (lockedCycle.completionRevision ?? 0) + 1;
    const event = await recordProductAnalyticsEvent(tx as unknown as Db, {
      orgId: input.orgId,
      eventName: "work_loop_completed",
      occurredAt: new Date(),
      sourceTransition: input.sourceTransition,
      confidence: "exact",
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      entityType: input.workSurface,
      entityId: input.workId,
      workSurface: input.workSurface,
      workId: input.workId,
      workCycleId: input.workCycleId,
      rootRunId: input.rootRunId ?? null,
      completionRevision: revision,
      origin: input.origin ?? "human",
      dedupeKey: `work_loop_completed:${input.workCycleId}:${revision}`,
      properties: input.properties ?? { work_surface: input.workSurface, origin: input.origin ?? "human", is_first_loop: revision === 1 },
    });
    await tx
      .update(productAnalyticsWorkCycles)
      .set({ state: "completed", completionRevision: revision, completedAt: new Date(), invalidatedAt: null, rootRunIds, updatedAt: new Date() })
      .where(and(eq(productAnalyticsWorkCycles.orgId, input.orgId), eq(productAnalyticsWorkCycles.workCycleId, input.workCycleId)));
    await tx.insert(productAnalyticsWorkCycleRevisions).values({
      orgId: input.orgId,
      workCycleId: input.workCycleId,
      completionRevision: revision,
      completionEventId: event?.id as string,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    return { event, revision };
  });
}

export async function invalidateProductAnalyticsWorkCycle(
  db: Db,
  input: { orgId: string; workSurface: "chat" | "issue"; workId: string; workCycleId: string; completionRevision: number; reasonCode: string; occurredAt?: Date },
) {
  return db.transaction(async (tx) => {
    const [cycle] = await tx.select().from(productAnalyticsWorkCycles)
      .where(and(eq(productAnalyticsWorkCycles.orgId, input.orgId), eq(productAnalyticsWorkCycles.workCycleId, input.workCycleId)))
      .for("update");
    if (!cycle || cycle.completionRevision < input.completionRevision) return null;
    const event = await recordProductAnalyticsEvent(tx as unknown as Db, {
      orgId: input.orgId,
      eventName: "work_loop_invalidated",
      occurredAt: input.occurredAt ?? new Date(),
      sourceTransition: "work_loop.invalidate",
      confidence: "exact",
      actorType: "system",
      entityType: input.workSurface,
      entityId: input.workId,
      workSurface: input.workSurface,
      workId: input.workId,
      workCycleId: input.workCycleId,
      completionRevision: input.completionRevision,
      dedupeKey: `work_loop_invalidated:${input.workCycleId}:${input.completionRevision}:${input.reasonCode}`,
      properties: { reason_code: input.reasonCode },
    });
    await tx.update(productAnalyticsWorkCycleRevisions).set({
      invalidatedAt: input.occurredAt ?? new Date(),
      invalidationReasonCode: input.reasonCode,
      invalidationEventId: event?.id as string,
      updatedAt: new Date(),
    }).where(and(
      eq(productAnalyticsWorkCycleRevisions.orgId, input.orgId),
      eq(productAnalyticsWorkCycleRevisions.workCycleId, input.workCycleId),
      eq(productAnalyticsWorkCycleRevisions.completionRevision, input.completionRevision),
    ));
    await tx.update(productAnalyticsWorkCycles).set({ state: "invalidated", invalidatedAt: input.occurredAt ?? new Date(), updatedAt: new Date() })
      .where(and(eq(productAnalyticsWorkCycles.orgId, input.orgId), eq(productAnalyticsWorkCycles.workCycleId, input.workCycleId)));
    return event;
  });
}

export type ProductAnalyticsConsentScope = "anonymous_installation" | "account_linked_user";
export type ProductAnalyticsConsentDecision = "granted" | "revoked";

export async function registerProductAnalyticsInstallation(db: Db, input: { installationId: string; installationSecret?: string; mode?: "off" | "anonymous" | "account_linked" }) {
  assertBoundedText(input.installationId, "installation id", 200);
  if (input.mode && input.mode !== "off") {
    throw unprocessable("Product analytics mode requires an explicit consent ledger decision");
  }
  const secret = input.installationSecret ?? randomBytes(32).toString("hex");
  const secretHash = createHash("sha256").update(secret).digest("hex");
  const [row] = await db.insert(productAnalyticsInstallations).values({
    installationId: input.installationId,
    installationSecretHash: secretHash,
    mode: input.mode ?? "off",
  }).onConflictDoNothing({ target: productAnalyticsInstallations.installationId }).returning();
  return { installation: row ?? null, installationSecret: row ? secret : null };
}

export async function assertProductAnalyticsInstallationSecret(db: Db, installationId: string, installationSecret: string) {
  assertBoundedText(installationSecret, "installation secret", 256);
  const [installation] = await db.select({ secretHash: productAnalyticsInstallations.installationSecretHash })
    .from(productAnalyticsInstallations)
    .where(eq(productAnalyticsInstallations.installationId, installationId))
    .limit(1);
  if (!installation) throw unauthorized("Product analytics installation is not registered");
  const expected = Buffer.from(installation.secretHash, "utf8");
  const actual = Buffer.from(createHash("sha256").update(installationSecret).digest("hex"), "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw forbidden("Product analytics installation credential is invalid");
  }
}

export async function setProductAnalyticsInstallationMode(db: Db, installationId: string, mode: "off" | "anonymous" | "account_linked") {
  const [row] = await db.update(productAnalyticsInstallations).set({ mode, updatedAt: new Date() })
    .where(eq(productAnalyticsInstallations.installationId, installationId)).returning();
  return row ?? null;
}

export async function reconcileProductAnalyticsInstallationMode(db: Db, installationId: string) {
  const consent = await db.select({ scope: productAnalyticsConsentLedger.scope, decision: productAnalyticsConsentLedger.decision })
    .from(productAnalyticsConsentLedger)
    .where(eq(productAnalyticsConsentLedger.installationId, installationId))
    .orderBy(desc(productAnalyticsConsentLedger.consentEpoch));
  const latestByScope = new Map<string, string>();
  for (const row of consent) {
    if (!latestByScope.has(row.scope)) latestByScope.set(row.scope, row.decision);
  }
  const mode = latestByScope.get("account_linked_user") === "granted"
    ? "account_linked"
    : latestByScope.get("anonymous_installation") === "granted" ? "anonymous" : "off";
  return setProductAnalyticsInstallationMode(db, installationId, mode);
}

export async function getProductAnalyticsInstallationState(db: Db, installationId: string) {
  const [installation] = await db.select().from(productAnalyticsInstallations)
    .where(eq(productAnalyticsInstallations.installationId, installationId)).limit(1);
  if (!installation) return null;
  const consent = await db.select().from(productAnalyticsConsentLedger)
    .where(eq(productAnalyticsConsentLedger.installationId, installationId))
    .orderBy(desc(productAnalyticsConsentLedger.decidedAt)).limit(20);
  const [pending] = await db.select({ count: sql<number>`count(*)` }).from(productAnalyticsOutbox)
    .where(and(
      eq(productAnalyticsOutbox.installationId, installationId),
      inArray(productAnalyticsOutbox.state, ["pending", "claimed", "retry_wait", "failed_actionable"]),
      eq(productAnalyticsOutbox.deliveryMode, installation.mode),
    ));
  return { installation, consent, pendingCount: Number(pending?.count ?? 0) };
}

export async function recordProductAnalyticsConsent(
  db: Db,
  input: { installationId: string; scope: ProductAnalyticsConsentScope; localUserId?: string | null; decision: ProductAnalyticsConsentDecision; policyVersion: string; decidedByLocalUserId?: string | null; uploadFromAt?: Date | null },
) {
  return db.transaction(async (tx) => {
    const [installation] = await tx.select({ installationId: productAnalyticsInstallations.installationId })
      .from(productAnalyticsInstallations)
      .where(eq(productAnalyticsInstallations.installationId, input.installationId))
      .limit(1)
      .for("update");
    if (!installation) throw unprocessable("Product analytics installation is not registered");
    assertBoundedText(input.policyVersion, "consent policy version", 80);
    if (input.localUserId) assertBoundedText(input.localUserId, "consent local user id", 200);
    const keyCondition = and(
      eq(productAnalyticsConsentLedger.installationId, input.installationId),
      eq(productAnalyticsConsentLedger.scope, input.scope),
      input.localUserId ? eq(productAnalyticsConsentLedger.localUserId, input.localUserId) : isNull(productAnalyticsConsentLedger.localUserId),
    );
    const [previous] = await tx.select({ consentEpoch: productAnalyticsConsentLedger.consentEpoch })
      .from(productAnalyticsConsentLedger).where(keyCondition).orderBy(desc(productAnalyticsConsentLedger.consentEpoch)).limit(1).for("update");
    const epoch = (previous?.consentEpoch ?? 0) + 1;
    const [row] = await tx.insert(productAnalyticsConsentLedger).values({
      installationId: input.installationId,
      scope: input.scope,
      localUserId: input.localUserId ?? null,
      decision: input.decision,
      policyVersion: input.policyVersion,
      consentEpoch: epoch,
      decidedByLocalUserId: input.decidedByLocalUserId ?? null,
      uploadFromAt: input.uploadFromAt ?? (input.decision === "granted" ? new Date() : null),
    }).returning();
    if (input.decision === "revoked") {
      await tx.delete(productAnalyticsOutbox).where(and(
        eq(productAnalyticsOutbox.installationId, input.installationId),
        eq(productAnalyticsOutbox.consentScope, input.scope),
        lt(productAnalyticsOutbox.consentEpoch, epoch),
        input.localUserId ? eq(productAnalyticsOutbox.consentedLocalUserId, input.localUserId) : isNull(productAnalyticsOutbox.consentedLocalUserId),
        sql`${productAnalyticsOutbox.state} <> 'delivered'`,
      ));
    }
    return row ?? null;
  });
}

export async function claimProductAnalyticsOutbox(db: Db, input: { installationId: string; limit?: number; leaseSeconds?: number; deliveryMode?: string; consentedLocalUserId?: string | null }) {
  if (!input.installationId) throw unprocessable("Product analytics installation id is required for claim");
  if (!input.deliveryMode) throw unprocessable("Product analytics delivery mode is required for claim");
  const deliveryMode = input.deliveryMode;
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + (input.leaseSeconds ?? 300) * 1000);
  const token = randomUUID();
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  return db.transaction(async (tx) => {
    const conditions = [
      or(eq(productAnalyticsOutbox.state, "pending"), and(eq(productAnalyticsOutbox.state, "claimed"), lt(productAnalyticsOutbox.leaseExpiresAt, now)), eq(productAnalyticsOutbox.state, "retry_wait")),
      lte(productAnalyticsOutbox.nextAttemptAt, now),
    ];
    conditions.push(eq(productAnalyticsOutbox.deliveryMode, deliveryMode));
    conditions.push(eq(productAnalyticsOutbox.installationId, input.installationId));
    if (input.consentedLocalUserId !== undefined) conditions.push(input.consentedLocalUserId ? eq(productAnalyticsOutbox.consentedLocalUserId, input.consentedLocalUserId) : isNull(productAnalyticsOutbox.consentedLocalUserId));
    const [first] = await tx.select({ eventId: productAnalyticsOutbox.eventId, consentEpoch: productAnalyticsOutbox.consentEpoch, consentedLocalUserId: productAnalyticsOutbox.consentedLocalUserId }).from(productAnalyticsOutbox).where(and(...conditions)).orderBy(productAnalyticsOutbox.nextAttemptAt).limit(1).for("update", { skipLocked: true });
    if (!first) return [];
    conditions.push(eq(productAnalyticsOutbox.consentEpoch, first.consentEpoch));
    conditions.push(first.consentedLocalUserId ? eq(productAnalyticsOutbox.consentedLocalUserId, first.consentedLocalUserId) : isNull(productAnalyticsOutbox.consentedLocalUserId));
    const rows = await tx.select({ eventId: productAnalyticsOutbox.eventId }).from(productAnalyticsOutbox).where(and(...conditions)).orderBy(productAnalyticsOutbox.nextAttemptAt).limit(limit).for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    const scope = deliveryMode === "account_linked" ? "account_linked_user" : "anonymous_installation";
    const consentConditions = [
      eq(productAnalyticsConsentLedger.installationId, input.installationId),
      eq(productAnalyticsConsentLedger.scope, scope),
      eq(productAnalyticsConsentLedger.decision, "granted"),
      eq(productAnalyticsConsentLedger.consentEpoch, first.consentEpoch),
      first.consentedLocalUserId
        ? eq(productAnalyticsConsentLedger.localUserId, first.consentedLocalUserId)
        : isNull(productAnalyticsConsentLedger.localUserId),
    ];
    const [currentConsent] = await tx.select({ id: productAnalyticsConsentLedger.id })
      .from(productAnalyticsConsentLedger)
      .where(and(...consentConditions))
      .limit(1);
    if (!currentConsent) {
      await tx.delete(productAnalyticsOutbox).where(inArray(productAnalyticsOutbox.eventId, rows.map((row) => row.eventId)));
      return [];
    }
    await tx.update(productAnalyticsOutbox).set({ state: "claimed", claimToken: token, claimedAt: now, leaseExpiresAt, updatedAt: now }).where(inArray(productAnalyticsOutbox.eventId, rows.map((row) => row.eventId)));
    return tx.select().from(productAnalyticsOutbox).where(inArray(productAnalyticsOutbox.eventId, rows.map((row) => row.eventId)));
  });
}

export async function claimProductAnalyticsOutboxBatch(
  db: Db,
  input: { installationId: string; installationSecret: string; limit?: number; leaseSeconds?: number; deliveryMode?: "anonymous" | "account_linked"; consentedLocalUserId?: string | null },
) {
  await assertProductAnalyticsInstallationSecret(db, input.installationId, input.installationSecret);
  const rows = await claimProductAnalyticsOutbox(db, input);
  if (rows.length === 0) return null;
  const eventRows = await db.select().from(productAnalyticsEvents).where(inArray(productAnalyticsEvents.id, rows.map((row) => row.eventId)));
  const eventsById = new Map(eventRows.map((event) => [event.id, event]));
  let payloads: Array<ReturnType<typeof buildProductAnalyticsExportPayload>>;
  try {
    payloads = rows.map((row) => {
      const event = eventsById.get(row.eventId);
      if (!event) throw unprocessable("Product analytics outbox event is missing");
      return buildProductAnalyticsExportPayload(input.installationSecret, event);
    });
  } catch (error) {
    await acknowledgeProductAnalyticsOutboxClaim(db, {
      installationId: input.installationId,
      installationSecret: input.installationSecret,
      eventIds: rows.map((row) => row.eventId),
      claimToken: rows[0]?.claimToken ?? "",
      delivered: false,
      errorCode: "payload_rejected",
    });
    throw error;
  }
  const first = rows[0];
  if (!first.claimToken) throw unprocessable("Product analytics outbox claim token is missing");
  return {
    claimToken: first.claimToken,
    installationId: first.installationId,
    deliveryMode: first.deliveryMode,
    consentScope: first.consentScope,
    consentEpoch: first.consentEpoch,
    events: payloads,
  };
}

export async function acknowledgeProductAnalyticsOutbox(db: Db, input: { installationId: string; eventIds: string[]; claimToken: string; deliveryMode: string; consentEpoch: number; consentedLocalUserId?: string | null; delivered?: boolean; errorCode?: string }) {
  const now = new Date();
  const where = and(
    inArray(productAnalyticsOutbox.eventId, input.eventIds),
    eq(productAnalyticsOutbox.installationId, input.installationId),
    eq(productAnalyticsOutbox.claimToken, input.claimToken),
    eq(productAnalyticsOutbox.deliveryMode, input.deliveryMode),
    eq(productAnalyticsOutbox.consentEpoch, input.consentEpoch),
    input.consentedLocalUserId ? eq(productAnalyticsOutbox.consentedLocalUserId, input.consentedLocalUserId) : isNull(productAnalyticsOutbox.consentedLocalUserId),
  );
  const delivered = input.delivered ?? true;
  const rows = await db.select({ eventId: productAnalyticsOutbox.eventId, attemptCount: productAnalyticsOutbox.attemptCount }).from(productAnalyticsOutbox).where(where);
  if (rows.length === 0) return { updatedCount: 0, state: delivered ? "delivered" : "retry_wait" };
  const maxAttemptCount = Math.max(...rows.map((row) => row.attemptCount));
  const deadLettered = !delivered && maxAttemptCount + 1 >= 5;
  await db.update(productAnalyticsOutbox).set({
    state: delivered ? "delivered" : deadLettered ? "failed_actionable" : "retry_wait",
    attemptCount: sql`${productAnalyticsOutbox.attemptCount} + 1`,
    deliveredAt: delivered ? now : null,
    deadLetteredAt: deadLettered ? now : null,
    nextAttemptAt: delivered || deadLettered ? now : new Date(now.getTime() + Math.round(Math.min(60 * 60_000, 2 ** Math.min(maxAttemptCount, 6) * 60_000) * (0.8 + Math.random() * 0.4))),
    lastErrorCode: input.errorCode ?? null,
    claimToken: null,
    leaseExpiresAt: null,
    updatedAt: now,
  }).where(where);
  return { updatedCount: rows.length, state: delivered ? "delivered" : deadLettered ? "failed_actionable" : "retry_wait" };
}

export async function acknowledgeProductAnalyticsOutboxClaim(
  db: Db,
  input: { installationId: string; installationSecret: string; eventIds: string[]; claimToken: string; delivered?: boolean; errorCode?: string },
) {
  await assertProductAnalyticsInstallationSecret(db, input.installationId, input.installationSecret);
  const rows = await db.select({
    eventId: productAnalyticsOutbox.eventId,
    deliveryMode: productAnalyticsOutbox.deliveryMode,
    consentEpoch: productAnalyticsOutbox.consentEpoch,
    consentedLocalUserId: productAnalyticsOutbox.consentedLocalUserId,
  }).from(productAnalyticsOutbox).where(and(
    eq(productAnalyticsOutbox.installationId, input.installationId),
    eq(productAnalyticsOutbox.claimToken, input.claimToken),
    inArray(productAnalyticsOutbox.eventId, input.eventIds),
  ));
  if (rows.length === 0) return { updatedCount: 0, state: input.delivered === false ? "retry_wait" : "delivered" };
  const first = rows[0];
  const sameClaim = rows.length === input.eventIds.length && rows.every((row) => (
    row.deliveryMode === first.deliveryMode
    && row.consentEpoch === first.consentEpoch
    && row.consentedLocalUserId === first.consentedLocalUserId
  ));
  if (!sameClaim) throw forbidden("Product analytics ACK batch is mixed or incomplete");
  return acknowledgeProductAnalyticsOutbox(db, {
    ...input,
    deliveryMode: first.deliveryMode,
    consentEpoch: first.consentEpoch,
    consentedLocalUserId: first.consentedLocalUserId,
  });
}

export async function cleanupProductAnalyticsRetention(
  db: Db,
  input: { installationId: string; retentionDays?: number; now?: Date },
) {
  const now = input.now ?? new Date();
  const retentionDays = Math.min(Math.max(Math.trunc(input.retentionDays ?? 90), 1), 3650);
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const delivered = await db.select({ eventId: productAnalyticsOutbox.eventId }).from(productAnalyticsOutbox)
    .where(and(eq(productAnalyticsOutbox.installationId, input.installationId), eq(productAnalyticsOutbox.state, "delivered"), lt(productAnalyticsOutbox.updatedAt, cutoff)));
  if (delivered.length === 0) return { deletedEvents: 0, droppedDueToRetention: 0, cutoff: cutoff.toISOString() };
  const eventIds = delivered.map((row) => row.eventId);
  await db.delete(productAnalyticsOutbox).where(inArray(productAnalyticsOutbox.eventId, eventIds));
  const deleted = await db.delete(productAnalyticsEvents).where(and(eq(productAnalyticsEvents.installationId, input.installationId), inArray(productAnalyticsEvents.id, eventIds))).returning({ id: productAnalyticsEvents.id });
  await db.update(productAnalyticsInstallations).set({
    state: { retentionCleanupAt: now.toISOString(), droppedDueToRetention: 0 },
    updatedAt: now,
  }).where(eq(productAnalyticsInstallations.installationId, input.installationId));
  return { deletedEvents: deleted.length, droppedDueToRetention: 0, cutoff: cutoff.toISOString() };
}

export function pseudonymizeProductAnalyticsId(secret: string, value: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function buildProductAnalyticsExportPayload(secret: string, event: Record<string, unknown>) {
  const properties = (event.properties ?? {}) as Record<string, ProductAnalyticsPropertyValue>;
  const rawActorKind = String(event.actorType ?? "system");
  const payload = {
    eventId: String(event.id),
    eventName: String(event.eventName),
    schemaVersion: Number(event.schemaVersion ?? 1),
    occurredAt: new Date(String(event.occurredAt)).toISOString(),
    environment: String(event.environment ?? "production"),
    appVersion: String(event.appVersion ?? "unknown"),
    releaseChannel: String(event.releaseChannel ?? "stable"),
    deploymentMode: String(event.deploymentMode ?? "self_hosted"),
    pseudonymousInstallationId: event.installationId ? pseudonymizeProductAnalyticsId(secret, String(event.installationId)) : null,
    actorKind: rawActorKind === "human" ? "user" : rawActorKind,
    origin: String(event.origin ?? "system"),
    pseudonymousOrgId: event.orgId ? pseudonymizeProductAnalyticsId(secret, String(event.orgId)) : null,
    pseudonymousWorkId: event.workId ? pseudonymizeProductAnalyticsId(secret, String(event.workId)) : null,
    pseudonymousWorkCycleId: event.workCycleId ? pseudonymizeProductAnalyticsId(secret, String(event.workCycleId)) : null,
    pseudonymousRootRunId: event.rootRunId ? pseudonymizeProductAnalyticsId(secret, String(event.rootRunId)) : null,
    pseudonymousRunId: event.runId ? pseudonymizeProductAnalyticsId(secret, String(event.runId)) : null,
    completionRevision: event.completionRevision ?? null,
    properties,
    confidence: String(event.confidence ?? "unknown"),
    isBackfill: Boolean(event.isBackfill),
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length > 2048) throw unprocessable("Product analytics export payload is too large");
  if (/(prompt|transcript|title|description|body|content|url|email|secret|token)/i.test(serialized)) throw unprocessable("Product analytics export payload contains sensitive data");
  return payload;
}

function parseWindow(input: { from?: Date; to?: Date; windowDays?: number }) {
  const to = input.to ?? new Date();
  const windowDays = input.windowDays ?? 7;
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 366) {
    throw unprocessable("Product analytics windowDays must be between 1 and 366");
  }
  const from = input.from ?? new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw unprocessable("Product analytics time window is invalid");
  }
  return { from, to };
}

export function productAnalyticsService(db: Db) {
  return {
    record: (input: RecordProductAnalyticsEventInput) => recordProductAnalyticsEvent(db, input),

    summary: async (orgId: string, input: { from?: Date; to?: Date; windowDays?: number } = {}) => {
      const window = parseWindow(input);
      const where = and(
        eq(productAnalyticsEvents.orgId, orgId),
        gte(productAnalyticsEvents.occurredAt, window.from),
        lt(productAnalyticsEvents.occurredAt, window.to),
      );
      const [eventCounts, distinctHumanRows, totalRows, completedLoopRows, invalidatedLoopRows, meaningfulInstallationRows, productiveInstallationRows] = await Promise.all([
        db
          .select({ eventName: productAnalyticsEvents.eventName, count: sql<number>`count(*)` })
          .from(productAnalyticsEvents)
          .where(where)
          .groupBy(productAnalyticsEvents.eventName),
        db
          .select({ count: sql<number>`count(distinct ${productAnalyticsEvents.actorId})` })
          .from(productAnalyticsEvents)
          .where(and(where, eq(productAnalyticsEvents.actorType, "human"), sql`${productAnalyticsEvents.actorId} is not null`)),
        db
          .select({ count: sql<number>`count(*)` })
          .from(productAnalyticsEvents)
          .where(where),
        db
          .select({ count: sql<number>`count(distinct ${productAnalyticsEvents.workCycleId} || ':' || ${productAnalyticsEvents.completionRevision})` })
          .from(productAnalyticsEvents)
          .where(and(
            where,
            eq(productAnalyticsEvents.eventName, "work_loop_completed"),
            eq(productAnalyticsEvents.origin, "human"),
            eq(productAnalyticsEvents.environment, "production"),
            sql`not exists (
              select 1 from ${productAnalyticsWorkCycleRevisions} invalidated
              where invalidated.org_id = ${productAnalyticsEvents.orgId}
                and invalidated.work_cycle_id = ${productAnalyticsEvents.workCycleId}
                and invalidated.completion_revision = ${productAnalyticsEvents.completionRevision}
                and invalidated.invalidated_at is not null
            )`,
          )),
        db
          .select({ count: sql<number>`count(*)` })
          .from(productAnalyticsEvents)
          .where(and(where, eq(productAnalyticsEvents.eventName, "work_loop_invalidated"))),
        db
          .select({ count: sql<number>`count(distinct ${productAnalyticsEvents.installationId})` })
          .from(productAnalyticsEvents)
          .where(and(
            where,
            inArray(productAnalyticsEvents.eventName, ["human_work_started", "review_decision_recorded", "work_loop_completed"]),
            eq(productAnalyticsEvents.origin, "human"),
            eq(productAnalyticsEvents.environment, "production"),
            sql`${productAnalyticsEvents.installationId} is not null`,
          )),
        db
          .select({ count: sql<number>`count(distinct ${productAnalyticsEvents.installationId})` })
          .from(productAnalyticsEvents)
          .where(and(
            where,
            inArray(productAnalyticsEvents.eventName, ["output_ready", "work_loop_completed"]),
            eq(productAnalyticsEvents.origin, "human"),
            eq(productAnalyticsEvents.environment, "production"),
            sql`${productAnalyticsEvents.installationId} is not null`,
          )),
      ]);
      const [approvedReviewRows] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(productAnalyticsEvents)
          .where(and(
            where,
            eq(productAnalyticsEvents.eventName, "review_decision_recorded"),
            sql`${productAnalyticsEvents.properties}->>'decision' = 'approve'`,
          )),
      ]);
      const counts = Object.fromEntries(eventCounts.map((row) => [row.eventName, Number(row.count)]));
      return {
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        metrics: {
          mutating_user_dau_local: Number(distinctHumanRows[0]?.count ?? 0),
          meaningful_active_installations: Number(meaningfulInstallationRows[0]?.count ?? 0),
          productive_installations: Number(productiveInstallationRows[0]?.count ?? 0),
          successful_runs: counts.run_succeeded ?? 0,
          failed_runs: counts.run_failed ?? 0,
          human_work_started: counts.human_work_started ?? 0,
          output_ready: counts.output_ready ?? 0,
          review_decisions_recorded: counts.review_decision_recorded ?? 0,
          reviewed_issue_completions: Number(approvedReviewRows[0]?.count ?? 0),
          weekly_completed_work_loops: Number(completedLoopRows[0]?.count ?? 0),
          work_loop_invalidations: Number(invalidatedLoopRows[0]?.count ?? 0),
          ledger_event_count: Number(totalRows[0]?.count ?? 0),
        },
        dataQuality: {
          source: "local_product_analytics_events",
          producedExactEventNames: PRODUCT_ANALYTICS_PRODUCED_EVENT_NAMES,
          producedDerivedEventNames: PRODUCT_ANALYTICS_DERIVED_EVENT_NAMES,
          deferredEventNames: PRODUCT_ANALYTICS_DEFERRED_EVENT_NAMES,
          completeDau: false,
          completeNorthStar: false,
        },
      };
    },

    listEvents: async (
      orgId: string,
      input: { from?: Date; to?: Date; eventName?: ProductAnalyticsEventName; limit?: number } = {},
    ) => {
      const window = parseWindow(input);
      const limit = Math.min(Math.max(Math.floor(input.limit ?? 100), 1), 500);
      const conditions = [
        eq(productAnalyticsEvents.orgId, orgId),
        gte(productAnalyticsEvents.occurredAt, window.from),
        lt(productAnalyticsEvents.occurredAt, window.to),
      ];
      if (input.eventName) {
        if (!EVENT_NAME_SET.has(input.eventName)) throw unprocessable("Unknown product analytics event");
        conditions.push(eq(productAnalyticsEvents.eventName, input.eventName));
      }
      return db
        .select({
          id: productAnalyticsEvents.id,
          installationId: productAnalyticsEvents.installationId,
          eventName: productAnalyticsEvents.eventName,
          schemaVersion: productAnalyticsEvents.schemaVersion,
          occurredAt: productAnalyticsEvents.occurredAt,
          sourceTransition: productAnalyticsEvents.sourceTransition,
          confidence: productAnalyticsEvents.confidence,
          actorType: productAnalyticsEvents.actorType,
          environment: productAnalyticsEvents.environment,
          appVersion: productAnalyticsEvents.appVersion,
          releaseChannel: productAnalyticsEvents.releaseChannel,
          deploymentMode: productAnalyticsEvents.deploymentMode,
          origin: productAnalyticsEvents.origin,
          workSurface: productAnalyticsEvents.workSurface,
          workId: productAnalyticsEvents.workId,
          workCycleId: productAnalyticsEvents.workCycleId,
          rootRunId: productAnalyticsEvents.rootRunId,
          runId: productAnalyticsEvents.runId,
          completionRevision: productAnalyticsEvents.completionRevision,
          entityType: productAnalyticsEvents.entityType,
          entityId: productAnalyticsEvents.entityId,
          dedupeKey: productAnalyticsEvents.dedupeKey,
          properties: productAnalyticsEvents.properties,
        })
        .from(productAnalyticsEvents)
        .where(and(...conditions))
        .orderBy(desc(productAnalyticsEvents.occurredAt), desc(productAnalyticsEvents.recordedAt))
        .limit(limit);
    },
  };
}
