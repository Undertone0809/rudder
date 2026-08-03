import type { Db } from "@rudderhq/db";
import {
  privateProductAnalyticsCollectorEvents,
  privateProductAnalyticsCollectorInstallations,
  privateProductAnalyticsCollectorQualityCounters,
  privateProductAnalyticsCollectorSubjects,
} from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { PRODUCT_ANALYTICS_EVENT_NAMES, PRODUCT_ANALYTICS_EVENT_PROPERTY_ALLOWLIST } from "./product-analytics.js";

const MAX_BATCH_EVENTS = 100;
const MAX_BATCH_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 2 * 1024;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_LATE_EVENT_MS = 30 * 24 * 60 * 60 * 1000;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY = /(prompt|transcript|title|description|body|content|url|token|secret|password|credential|email|hostname|username)/i;
const EVENT_NAMES = new Set<string>(PRODUCT_ANALYTICS_EVENT_NAMES);

export type ProductAnalyticsCollectorAuthorization = {
  installationId: string;
  mode: "anonymous" | "account_linked";
  consentVersion: string;
  consentEpoch: number;
  analyticsSubject?: string | null;
  pseudonymousInstallationId?: string | null;
};

export type ProductAnalyticsCollectorEvent = {
  eventId: string;
  eventName: string;
  schemaVersion: 1;
  occurredAt: string;
  environment: "production" | "development" | "test";
  appVersion: string;
  releaseChannel: "development" | "preview" | "canary" | "stable";
  deploymentMode: "desktop_local" | "self_hosted" | "remote_server";
  actorKind: "user" | "agent" | "system" | "automation";
  origin: "human" | "automation" | "retry" | "recovery" | "system";
  pseudonymousInstallationId: string | null;
  pseudonymousOrgId: string | null;
  pseudonymousWorkId: string | null;
  pseudonymousWorkCycleId: string | null;
  pseudonymousRootRunId: string | null;
  pseudonymousRunId: string | null;
  completionRevision: number | null;
  properties: Record<string, string | number | boolean | null>;
  confidence: "exact" | "derived" | "unknown";
  isBackfill: boolean;
};

export type ProductAnalyticsCollectorAck = {
  eventId: string;
  status: "accepted" | "duplicate" | "rejected";
  errorCode?: "invalid_schema" | "invalid_event" | "future_event" | "revoked" | "conflict" | "too_large";
  late: boolean;
};

export type StoredCollectorEvent = ProductAnalyticsCollectorEvent & {
  installationId: string;
  analyticsSubject: string | null;
  consentVersion: string;
  consentEpoch: number;
  payloadSha256: string;
  receivedAt: string;
  effectiveAt: string;
  late: boolean;
};

export type InstallationState = {
  consentVersion: string;
  consentEpoch: number;
  revoked: boolean;
};

export type ProductAnalyticsCollectorStore = {
  getInstallationState(installationId: string): InstallationState | null;
  setInstallationState(installationId: string, state: InstallationState): void;
  getSubjectState?(installationId: string, analyticsSubject: string): InstallationState | null;
  setSubjectState?(installationId: string, analyticsSubject: string, state: InstallationState): void;
  getEvent(eventId: string): StoredCollectorEvent | null;
  putEvent(event: StoredCollectorEvent): void;
  listEvents(): StoredCollectorEvent[];
};

export class InMemoryProductAnalyticsCollectorStore implements ProductAnalyticsCollectorStore {
  private readonly installations = new Map<string, InstallationState>();
  private readonly subjects = new Map<string, InstallationState>();
  private readonly events = new Map<string, StoredCollectorEvent>();

  getInstallationState(installationId: string) {
    return this.installations.get(installationId) ?? null;
  }

  setInstallationState(installationId: string, state: InstallationState) {
    this.installations.set(installationId, { ...state });
  }

  getSubjectState(installationId: string, analyticsSubject: string) {
    return this.subjects.get(`${installationId}\u0000${analyticsSubject}`) ?? null;
  }

  setSubjectState(installationId: string, analyticsSubject: string, state: InstallationState) {
    this.subjects.set(`${installationId}\u0000${analyticsSubject}`, { ...state });
  }

  getEvent(eventId: string) {
    return this.events.get(eventId) ?? null;
  }

  putEvent(event: StoredCollectorEvent) {
    this.events.set(event.eventId, event);
  }

  listEvents() {
    return [...this.events.values()];
  }
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashProductAnalyticsCollectorPayload(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export type ProductAnalyticsCollectorDashboardEvent = Pick<StoredCollectorEvent,
  "installationId" | "eventName" | "origin" | "occurredAt" | "effectiveAt" | "late" | "isBackfill" | "properties" | "pseudonymousInstallationId"
>;

export type ProductAnalyticsCollectorDashboard = {
  rollups: Array<{
    day: string;
    eventName: string;
    origin: string;
    eventCount: number | null;
    contributingInstallations: number;
    suppressed: boolean;
  }>;
  cohorts: Array<{ firstSeenDay: string; installationCount: number | null; suppressed: boolean }>;
  quality: {
    acceptedEventCount: number;
    lateEventCount: number;
    backfillEventCount: number;
    missingPseudonymousInstallationCount: number;
    suppressedRollupCount: number;
    privacyThreshold: number;
  };
};

/**
 * Build a privacy-safe collector dashboard without exposing installation IDs.
 * The central deployment can persist the same dimensions in SQL rollups; this
 * pure projection is also the deterministic contract fixture for those jobs.
 */
export function buildProductAnalyticsCollectorDashboard(
  events: readonly ProductAnalyticsCollectorDashboardEvent[],
  options: { privacyThreshold?: number } = {},
): ProductAnalyticsCollectorDashboard {
  const privacyThreshold = Number.isInteger(options.privacyThreshold) && (options.privacyThreshold ?? 0) > 0
    ? options.privacyThreshold!
    : 10;
  const rollupGroups = new Map<string, { day: string; eventName: string; origin: string; eventCount: number; installations: Set<string> }>();
  const firstSeenByInstallation = new Map<string, string>();
  let lateEventCount = 0;
  let backfillEventCount = 0;
  let missingPseudonymousInstallationCount = 0;
  for (const event of events) {
    const occurredAt = new Date(event.occurredAt);
    const effectiveAt = new Date(event.effectiveAt);
    if (event.late || effectiveAt.getTime() !== occurredAt.getTime()) lateEventCount += 1;
    if (event.isBackfill) backfillEventCount += 1;
    if (!event.pseudonymousInstallationId) missingPseudonymousInstallationCount += 1;
    const day = occurredAt.toISOString().slice(0, 10);
    const key = `${day}\u0000${event.eventName}\u0000${event.origin}`;
    const group = rollupGroups.get(key) ?? { day, eventName: event.eventName, origin: event.origin, eventCount: 0, installations: new Set<string>() };
    group.eventCount += 1;
    group.installations.add(event.installationId);
    rollupGroups.set(key, group);
    const firstSeenDay = firstSeenByInstallation.get(event.installationId);
    if (!firstSeenDay || day < firstSeenDay) firstSeenByInstallation.set(event.installationId, day);
  }
  const rollups = [...rollupGroups.values()]
    .sort((left, right) => left.day.localeCompare(right.day) || left.eventName.localeCompare(right.eventName) || left.origin.localeCompare(right.origin))
    .map((group) => {
      const contributingInstallations = group.installations.size;
      const suppressed = contributingInstallations < privacyThreshold;
      return {
        day: group.day,
        eventName: group.eventName,
        origin: group.origin,
        eventCount: suppressed ? null : group.eventCount,
        contributingInstallations,
        suppressed,
      };
    });
  const cohorts = [...firstSeenByInstallation.values()].reduce((counts, day) => {
    counts.set(day, (counts.get(day) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  return {
    rollups,
    cohorts: [...cohorts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([firstSeenDay, installationCount]) => ({
      firstSeenDay,
      installationCount: installationCount < privacyThreshold ? null : installationCount,
      suppressed: installationCount < privacyThreshold,
    })),
    quality: {
      acceptedEventCount: events.length,
      lateEventCount,
      backfillEventCount,
      missingPseudonymousInstallationCount,
      suppressedRollupCount: rollups.filter((rollup) => rollup.suppressed).length,
      privacyThreshold,
    },
  };
}

function reject(code: ProductAnalyticsCollectorAck["errorCode"], eventId: string, late = false): ProductAnalyticsCollectorAck {
  return { eventId, status: "rejected", errorCode: code, late };
}

export function validateProductAnalyticsCollectorEvent(value: unknown): { event: ProductAnalyticsCollectorEvent; serialized: string; late: boolean } | ProductAnalyticsCollectorAck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject("invalid_schema", "unknown");
  const event = value as Record<string, unknown>;
  const requiredKeys = [
    "eventId", "eventName", "schemaVersion", "occurredAt", "environment", "appVersion", "releaseChannel",
    "deploymentMode", "actorKind", "origin", "pseudonymousInstallationId", "pseudonymousOrgId", "pseudonymousWorkId",
    "pseudonymousWorkCycleId", "pseudonymousRootRunId", "pseudonymousRunId", "completionRevision", "properties", "confidence", "isBackfill",
  ];
  const actualKeys = Object.keys(event).sort();
  if (actualKeys.length !== requiredKeys.length || actualKeys.some((key, index) => key !== requiredKeys.sort()[index])) {
    return reject("invalid_schema", typeof event.eventId === "string" ? event.eventId : "unknown");
  }
  if (typeof event.eventId !== "string" || !UUID_LIKE.test(event.eventId)) return reject("invalid_schema", "unknown");
  if (typeof event.eventName !== "string" || !EVENT_NAMES.has(event.eventName) || event.schemaVersion !== 1) return reject("invalid_event", event.eventId);
  if (typeof event.occurredAt !== "string") return reject("invalid_event", event.eventId);
  const occurredAt = new Date(event.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return reject("invalid_event", event.eventId);
  const now = Date.now();
  if (occurredAt.getTime() > now + MAX_FUTURE_SKEW_MS) return reject("future_event", event.eventId);
  const late = now - occurredAt.getTime() > MAX_LATE_EVENT_MS;
  if (!(["production", "development", "test"] as string[]).includes(String(event.environment))) return reject("invalid_event", event.eventId, late);
  if (!(["development", "preview", "canary", "stable"] as string[]).includes(String(event.releaseChannel))) return reject("invalid_event", event.eventId, late);
  if (!(["desktop_local", "self_hosted", "remote_server"] as string[]).includes(String(event.deploymentMode))) return reject("invalid_event", event.eventId, late);
  if (!(["user", "agent", "system", "automation"] as string[]).includes(String(event.actorKind))) return reject("invalid_event", event.eventId, late);
  if (!(["human", "automation", "retry", "recovery", "system"] as string[]).includes(String(event.origin))) return reject("invalid_event", event.eventId, late);
  if (!(["exact", "derived", "unknown"] as string[]).includes(String(event.confidence))) return reject("invalid_event", event.eventId, late);
  if (typeof event.appVersion !== "string" || event.appVersion.length > 80 || typeof event.isBackfill !== "boolean") return reject("invalid_event", event.eventId, late);
  if (event.completionRevision !== null && (!Number.isInteger(event.completionRevision) || Number(event.completionRevision) < 1)) return reject("invalid_event", event.eventId, late);
  for (const key of ["pseudonymousInstallationId", "pseudonymousOrgId", "pseudonymousWorkId", "pseudonymousWorkCycleId", "pseudonymousRootRunId", "pseudonymousRunId"]) {
    if (event[key] !== null && (typeof event[key] !== "string" || event[key].length > 128)) return reject("invalid_event", event.eventId, late);
  }
  if (!event.properties || typeof event.properties !== "object" || Array.isArray(event.properties)) return reject("invalid_event", event.eventId, late);
  for (const [key, property] of Object.entries(event.properties as Record<string, unknown>)) {
    const allowlist = PRODUCT_ANALYTICS_EVENT_PROPERTY_ALLOWLIST[event.eventName as keyof typeof PRODUCT_ANALYTICS_EVENT_PROPERTY_ALLOWLIST];
    if (!allowlist?.has(key) || SENSITIVE_KEY.test(key) || !isScalar(property) || (typeof property === "string" && property.length > 80) || (typeof property === "number" && !Number.isFinite(property))) {
      return reject("invalid_event", event.eventId, late);
    }
  }
  if (event.pseudonymousInstallationId === null || typeof event.pseudonymousInstallationId !== "string") return reject("invalid_event", event.eventId, late);
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) return reject("too_large", event.eventId, late);
  return { event: event as unknown as ProductAnalyticsCollectorEvent, serialized, late };
}

export function createProductAnalyticsCollector(store: ProductAnalyticsCollectorStore = new InMemoryProductAnalyticsCollectorStore()) {
  function ingestBatch(input: { authorization: ProductAnalyticsCollectorAuthorization; events: unknown; now?: Date }) {
    const { authorization } = input;
    const now = input.now ?? new Date();
    const events = Array.isArray(input.events) ? input.events : null;
    if (!authorization.installationId || !Number.isInteger(authorization.consentEpoch) || authorization.consentEpoch < 1) {
      return { accepted: 0, duplicate: 0, rejected: (events ?? []).map((value) => reject("invalid_schema", typeof (value as Record<string, unknown>)?.eventId === "string" ? String((value as Record<string, unknown>).eventId) : "unknown")), receivedAt: now.toISOString() };
    }
    const serializedBatch = JSON.stringify(events ?? null) ?? "";
    if (!events) {
      return { accepted: 0, duplicate: 0, rejected: [{ eventId: "batch", status: "rejected" as const, errorCode: "invalid_schema" as const, late: false }], receivedAt: now.toISOString() };
    }
    if (events.length > MAX_BATCH_EVENTS || Buffer.byteLength(serializedBatch, "utf8") > MAX_BATCH_BYTES) {
      return { accepted: 0, duplicate: 0, rejected: [{ eventId: "batch", status: "rejected" as const, errorCode: "too_large" as const, late: false }], receivedAt: now.toISOString() };
    }
    const installationState = authorization.mode === "account_linked" && authorization.analyticsSubject
      ? store.getSubjectState?.(authorization.installationId, authorization.analyticsSubject)
      : store.getInstallationState(authorization.installationId);
    if (!installationState || installationState.revoked || installationState.consentEpoch !== authorization.consentEpoch || installationState.consentVersion !== authorization.consentVersion) {
      return { accepted: 0, duplicate: 0, rejected: events.map((value) => reject("revoked", typeof (value as Record<string, unknown>)?.eventId === "string" ? String((value as Record<string, unknown>).eventId) : "unknown")), receivedAt: now.toISOString() };
    }
    const acks: ProductAnalyticsCollectorAck[] = [];
    for (const value of events) {
      const result = validateProductAnalyticsCollectorEvent(value);
      if ("status" in result) {
        acks.push(result);
        continue;
      }
      if (authorization.pseudonymousInstallationId && result.event.pseudonymousInstallationId !== authorization.pseudonymousInstallationId) {
        acks.push(reject("invalid_event", result.event.eventId, result.late));
        continue;
      }
      const existing = store.getEvent(result.event.eventId);
      const payloadSha256 = hashProductAnalyticsCollectorPayload(result.event);
      if (existing) {
        acks.push(existing.payloadSha256 === payloadSha256
          ? { eventId: result.event.eventId, status: "duplicate", late: result.late }
          : { eventId: result.event.eventId, status: "rejected", errorCode: "conflict", late: result.late });
        continue;
      }
      store.putEvent({
        ...result.event,
        installationId: authorization.installationId,
        analyticsSubject: authorization.mode === "account_linked" ? authorization.analyticsSubject ?? null : null,
        consentVersion: authorization.consentVersion,
        consentEpoch: authorization.consentEpoch,
        payloadSha256,
        receivedAt: now.toISOString(),
        effectiveAt: (result.late ? now : new Date(result.event.occurredAt)).toISOString(),
        late: result.late,
      });
      acks.push({ eventId: result.event.eventId, status: "accepted", late: result.late });
    }
    return {
      accepted: acks.filter((ack) => ack.status === "accepted").length,
      duplicate: acks.filter((ack) => ack.status === "duplicate").length,
      rejected: acks.filter((ack) => ack.status === "rejected"),
      receivedAt: now.toISOString(),
    };
  }

  function advanceConsent(input: { installationId: string; analyticsSubject?: string | null; consentVersion: string; consentEpoch: number; revoked: boolean }) {
    const current = input.analyticsSubject
      ? store.getSubjectState?.(input.installationId, input.analyticsSubject)
      : store.getInstallationState(input.installationId);
    // Consent epochs are monotonic. Treat an equal or older epoch as already
    // applied so a replay cannot change revocation state without a new epoch.
    if (current && input.consentEpoch <= current.consentEpoch) return current;
    const next = { consentVersion: input.consentVersion, consentEpoch: input.consentEpoch, revoked: input.revoked };
    if (input.analyticsSubject) store.setSubjectState?.(input.installationId, input.analyticsSubject, next);
    else store.setInstallationState(input.installationId, next);
    return next;
  }

  return { ingestBatch, advanceConsent, store };
}

export type ProductAnalyticsCollector = ReturnType<typeof createProductAnalyticsCollector>;

export type ProductAnalyticsPersistentCollector = {
  ingestBatch(input: { authorization: ProductAnalyticsCollectorAuthorization; events: unknown; now?: Date }): Promise<{
    accepted: number;
    duplicate: number;
    rejected: ProductAnalyticsCollectorAck[];
    receivedAt: string;
  }>;
  advanceConsent(input: { installationId: string; analyticsSubject?: string | null; consentVersion: string; consentEpoch: number; revoked: boolean }): Promise<InstallationState>;
};

/**
 * PostgreSQL-backed collector used by the private telemetry deployment. The
 * local app never mounts this route, so these tables can live in a separately
 * permissioned database/schema in production while sharing the same contract.
 */
export function createProductAnalyticsPersistentCollector(db: Db): ProductAnalyticsPersistentCollector {
  async function recordQualityCounters(input: {
    now: Date;
    acceptedEvents: number;
    duplicateEvents: number;
    rejectedEvents: number;
    lateEvents: number;
  }): Promise<void> {
    const day = input.now.toISOString().slice(0, 10);
    await db.insert(privateProductAnalyticsCollectorQualityCounters).values({
      day,
      receivedBatches: 1,
      acceptedEvents: input.acceptedEvents,
      duplicateEvents: input.duplicateEvents,
      rejectedEvents: input.rejectedEvents,
      lateEvents: input.lateEvents,
      updatedAt: input.now,
    }).onConflictDoUpdate({
      target: privateProductAnalyticsCollectorQualityCounters.day,
      set: {
        receivedBatches: sql`${privateProductAnalyticsCollectorQualityCounters.receivedBatches} + 1`,
        acceptedEvents: sql`${privateProductAnalyticsCollectorQualityCounters.acceptedEvents} + ${input.acceptedEvents}`,
        duplicateEvents: sql`${privateProductAnalyticsCollectorQualityCounters.duplicateEvents} + ${input.duplicateEvents}`,
        rejectedEvents: sql`${privateProductAnalyticsCollectorQualityCounters.rejectedEvents} + ${input.rejectedEvents}`,
        lateEvents: sql`${privateProductAnalyticsCollectorQualityCounters.lateEvents} + ${input.lateEvents}`,
        updatedAt: input.now,
      },
    });
  }

  async function readState(installationId: string) {
    const [row] = await db.select({
      consentVersion: privateProductAnalyticsCollectorInstallations.consentVersion,
      consentEpoch: privateProductAnalyticsCollectorInstallations.consentEpoch,
      revoked: privateProductAnalyticsCollectorInstallations.revoked,
      analyticsSubject: privateProductAnalyticsCollectorInstallations.analyticsSubject,
    }).from(privateProductAnalyticsCollectorInstallations)
      .where(eq(privateProductAnalyticsCollectorInstallations.installationId, installationId)).limit(1);
    return row ?? null;
  }

  async function readSubjectState(installationId: string, analyticsSubject: string) {
    const [row] = await db.select({
      consentVersion: privateProductAnalyticsCollectorSubjects.consentVersion,
      consentEpoch: privateProductAnalyticsCollectorSubjects.consentEpoch,
      revoked: sql<boolean>`${privateProductAnalyticsCollectorSubjects.revokedAt} IS NOT NULL`,
    }).from(privateProductAnalyticsCollectorSubjects)
      .where(and(
        eq(privateProductAnalyticsCollectorSubjects.installationId, installationId),
        eq(privateProductAnalyticsCollectorSubjects.analyticsSubject, analyticsSubject),
      )).limit(1);
    return row ?? null;
  }

  async function ensureState(authorization: ProductAnalyticsCollectorAuthorization, now: Date) {
    const existing = await readState(authorization.installationId);
    if (existing) return existing;
    const [created] = await db.insert(privateProductAnalyticsCollectorInstallations).values({
      installationId: authorization.installationId,
      mode: authorization.mode,
      consentVersion: authorization.consentVersion,
      consentEpoch: authorization.consentEpoch,
      // The installation row is shared health/state only. Account-linked
      // consent lives in product_analytics_collector_subjects per subject.
      analyticsSubject: null,
      revoked: false,
      firstSeenAt: now,
      lastSeenAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: privateProductAnalyticsCollectorInstallations.installationId }).returning({
      consentVersion: privateProductAnalyticsCollectorInstallations.consentVersion,
      consentEpoch: privateProductAnalyticsCollectorInstallations.consentEpoch,
      revoked: privateProductAnalyticsCollectorInstallations.revoked,
      analyticsSubject: privateProductAnalyticsCollectorInstallations.analyticsSubject,
    });
    return created ?? await readState(authorization.installationId);
  }

  async function ensureSubjectState(authorization: ProductAnalyticsCollectorAuthorization, now: Date) {
    const analyticsSubject = authorization.analyticsSubject;
    if (!analyticsSubject) return null;
    const existing = await readSubjectState(authorization.installationId, analyticsSubject);
    if (existing) {
      if (authorization.consentEpoch > existing.consentEpoch) {
        const [updated] = await db.update(privateProductAnalyticsCollectorSubjects).set({
          consentVersion: authorization.consentVersion,
          consentEpoch: authorization.consentEpoch,
          revokedAt: null,
          updatedAt: now,
        }).where(and(
          eq(privateProductAnalyticsCollectorSubjects.installationId, authorization.installationId),
          eq(privateProductAnalyticsCollectorSubjects.analyticsSubject, analyticsSubject),
          eq(privateProductAnalyticsCollectorSubjects.consentEpoch, existing.consentEpoch),
        )).returning({
          consentVersion: privateProductAnalyticsCollectorSubjects.consentVersion,
          consentEpoch: privateProductAnalyticsCollectorSubjects.consentEpoch,
          revoked: sql<boolean>`${privateProductAnalyticsCollectorSubjects.revokedAt} IS NOT NULL`,
        });
        return updated ?? await readSubjectState(authorization.installationId, analyticsSubject);
      }
      return existing;
    }
    const [created] = await db.insert(privateProductAnalyticsCollectorSubjects).values({
      installationId: authorization.installationId,
      analyticsSubject,
      consentVersion: authorization.consentVersion,
      consentEpoch: authorization.consentEpoch,
      consentedAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: [privateProductAnalyticsCollectorSubjects.installationId, privateProductAnalyticsCollectorSubjects.analyticsSubject] }).returning({
      consentVersion: privateProductAnalyticsCollectorSubjects.consentVersion,
      consentEpoch: privateProductAnalyticsCollectorSubjects.consentEpoch,
      revoked: sql<boolean>`${privateProductAnalyticsCollectorSubjects.revokedAt} IS NOT NULL`,
    });
    return created ?? await readSubjectState(authorization.installationId, analyticsSubject);
  }

  async function ingestBatch(input: { authorization: ProductAnalyticsCollectorAuthorization; events: unknown; now?: Date }) {
    const now = input.now ?? new Date();
    const events = Array.isArray(input.events) ? input.events : null;
    if (!events) {
      await recordQualityCounters({ now, acceptedEvents: 0, duplicateEvents: 0, rejectedEvents: 1, lateEvents: 0 });
      return { accepted: 0, duplicate: 0, rejected: [{ eventId: "batch", status: "rejected" as const, errorCode: "invalid_schema" as const, late: false }], receivedAt: now.toISOString() };
    }
    const serializedBatch = JSON.stringify(events) ?? "";
    if (events.length > MAX_BATCH_EVENTS || Buffer.byteLength(serializedBatch, "utf8") > MAX_BATCH_BYTES) {
      await recordQualityCounters({ now, acceptedEvents: 0, duplicateEvents: 0, rejectedEvents: 1, lateEvents: 0 });
      return { accepted: 0, duplicate: 0, rejected: [{ eventId: "batch", status: "rejected" as const, errorCode: "too_large" as const, late: false }], receivedAt: now.toISOString() };
    }
    const installationState = await ensureState(input.authorization, now);
    const state = input.authorization.mode === "account_linked"
      ? await ensureSubjectState(input.authorization, now)
      : installationState;
    if (input.authorization.mode === "account_linked" && !input.authorization.analyticsSubject) {
      return { accepted: 0, duplicate: 0, rejected: events.map((value) => reject("invalid_schema", typeof (value as Record<string, unknown>)?.eventId === "string" ? String((value as Record<string, unknown>).eventId) : "unknown")), receivedAt: now.toISOString() };
    }
    if (!state || state.revoked || state.consentEpoch !== input.authorization.consentEpoch || state.consentVersion !== input.authorization.consentVersion) {
      return { accepted: 0, duplicate: 0, rejected: events.map((value) => reject("revoked", typeof (value as Record<string, unknown>)?.eventId === "string" ? String((value as Record<string, unknown>).eventId) : "unknown")), receivedAt: now.toISOString() };
    }
    const acknowledgements: ProductAnalyticsCollectorAck[] = [];
    for (const value of events) {
      const result = validateProductAnalyticsCollectorEvent(value);
      if ("status" in result) {
        acknowledgements.push(result);
        continue;
      }
      if (input.authorization.pseudonymousInstallationId && result.event.pseudonymousInstallationId !== input.authorization.pseudonymousInstallationId) {
        acknowledgements.push(reject("invalid_event", result.event.eventId, result.late));
        continue;
      }
      const payloadSha256 = hashProductAnalyticsCollectorPayload(result.event);
      const [existing] = await db.select({ payloadSha256: privateProductAnalyticsCollectorEvents.payloadSha256 })
        .from(privateProductAnalyticsCollectorEvents).where(eq(privateProductAnalyticsCollectorEvents.eventId, result.event.eventId)).limit(1);
      if (existing) {
        acknowledgements.push(existing.payloadSha256 === payloadSha256
          ? { eventId: result.event.eventId, status: "duplicate", late: result.late }
          : { eventId: result.event.eventId, status: "rejected", errorCode: "conflict", late: result.late });
        continue;
      }
      const [inserted] = await db.insert(privateProductAnalyticsCollectorEvents).values({
        eventId: result.event.eventId,
        installationId: input.authorization.installationId,
        analyticsSubject: input.authorization.mode === "account_linked" ? input.authorization.analyticsSubject ?? null : null,
        eventName: result.event.eventName,
        schemaVersion: result.event.schemaVersion,
        occurredAt: new Date(result.event.occurredAt),
        receivedAt: now,
        effectiveAt: result.late ? now : new Date(result.event.occurredAt),
        environment: result.event.environment,
        appVersion: result.event.appVersion,
        releaseChannel: result.event.releaseChannel,
        deploymentMode: result.event.deploymentMode,
        coarsePlatform: null,
        actorKind: result.event.actorKind,
        origin: result.event.origin,
        isInternal: false,
        pseudonymousInstallationId: result.event.pseudonymousInstallationId,
        pseudonymousOrgId: result.event.pseudonymousOrgId,
        pseudonymousWorkId: result.event.pseudonymousWorkId,
        pseudonymousWorkCycleId: result.event.pseudonymousWorkCycleId,
        pseudonymousRootRunId: result.event.pseudonymousRootRunId,
        pseudonymousRunId: result.event.pseudonymousRunId,
        completionRevision: result.event.completionRevision,
        properties: result.event.properties,
        confidence: result.event.confidence,
        isBackfill: result.event.isBackfill,
        late: result.late,
        consentVersion: input.authorization.consentVersion,
        consentEpoch: input.authorization.consentEpoch,
        payloadSha256,
      }).onConflictDoNothing({ target: privateProductAnalyticsCollectorEvents.eventId }).returning({ eventId: privateProductAnalyticsCollectorEvents.eventId });
      // A concurrent request may win the event-id race after the read above.
      // Do not increment a rollup for that loser: it is a duplicate (or a
      // conflict if the winning payload has a different digest).
      if (!inserted) {
        const [winner] = await db.select({ payloadSha256: privateProductAnalyticsCollectorEvents.payloadSha256 })
          .from(privateProductAnalyticsCollectorEvents)
          .where(eq(privateProductAnalyticsCollectorEvents.eventId, result.event.eventId)).limit(1);
        acknowledgements.push(winner?.payloadSha256 === payloadSha256
          ? { eventId: result.event.eventId, status: "duplicate", late: result.late }
          : { eventId: result.event.eventId, status: "rejected", errorCode: "conflict", late: result.late });
        continue;
      }
      acknowledgements.push({ eventId: result.event.eventId, status: "accepted", late: result.late });
    }
    await db.update(privateProductAnalyticsCollectorInstallations).set({ lastSeenAt: now, updatedAt: now }).where(eq(privateProductAnalyticsCollectorInstallations.installationId, input.authorization.installationId));
    const accepted = acknowledgements.filter((ack) => ack.status === "accepted").length;
    const duplicate = acknowledgements.filter((ack) => ack.status === "duplicate").length;
    const rejected = acknowledgements.filter((ack) => ack.status === "rejected");
    await recordQualityCounters({
      now,
      acceptedEvents: accepted,
      duplicateEvents: duplicate,
      rejectedEvents: rejected.length,
      lateEvents: acknowledgements.filter((ack) => ack.late).length,
    });
    return { accepted, duplicate, rejected, receivedAt: now.toISOString() };
  }

  async function advanceConsent(input: { installationId: string; analyticsSubject?: string | null; consentVersion: string; consentEpoch: number; revoked: boolean }) {
    if (input.analyticsSubject) {
      const current = await readSubjectState(input.installationId, input.analyticsSubject);
      if (current && input.consentEpoch <= current.consentEpoch) return current;
      const now = new Date();
      const [row] = current
        ? await db.update(privateProductAnalyticsCollectorSubjects).set({
          consentVersion: input.consentVersion,
          consentEpoch: input.consentEpoch,
          revokedAt: input.revoked ? now : null,
          updatedAt: now,
        }).where(and(
          eq(privateProductAnalyticsCollectorSubjects.installationId, input.installationId),
          eq(privateProductAnalyticsCollectorSubjects.analyticsSubject, input.analyticsSubject),
          eq(privateProductAnalyticsCollectorSubjects.consentEpoch, current.consentEpoch),
        )).returning({
          consentVersion: privateProductAnalyticsCollectorSubjects.consentVersion,
          consentEpoch: privateProductAnalyticsCollectorSubjects.consentEpoch,
          revoked: sql<boolean>`${privateProductAnalyticsCollectorSubjects.revokedAt} IS NOT NULL`,
        })
        : await db.insert(privateProductAnalyticsCollectorSubjects).values({
          installationId: input.installationId,
          analyticsSubject: input.analyticsSubject,
          consentVersion: input.consentVersion,
          consentEpoch: input.consentEpoch,
          revokedAt: input.revoked ? now : null,
          consentedAt: now,
          updatedAt: now,
        }).onConflictDoNothing({ target: [privateProductAnalyticsCollectorSubjects.installationId, privateProductAnalyticsCollectorSubjects.analyticsSubject] }).returning({
          consentVersion: privateProductAnalyticsCollectorSubjects.consentVersion,
          consentEpoch: privateProductAnalyticsCollectorSubjects.consentEpoch,
          revoked: sql<boolean>`${privateProductAnalyticsCollectorSubjects.revokedAt} IS NOT NULL`,
        });
      return row ?? await readSubjectState(input.installationId, input.analyticsSubject) ?? { consentVersion: input.consentVersion, consentEpoch: input.consentEpoch, revoked: input.revoked };
    }
    const current = await readState(input.installationId);
    if (current && input.consentEpoch <= current.consentEpoch) return current;
    const [row] = await db.update(privateProductAnalyticsCollectorInstallations).set({
      consentVersion: input.consentVersion,
      consentEpoch: input.consentEpoch,
      revoked: input.revoked,
      updatedAt: new Date(),
    }).where(current
      ? and(eq(privateProductAnalyticsCollectorInstallations.installationId, input.installationId), eq(privateProductAnalyticsCollectorInstallations.consentEpoch, current.consentEpoch))
      : eq(privateProductAnalyticsCollectorInstallations.installationId, input.installationId)).returning({
      consentVersion: privateProductAnalyticsCollectorInstallations.consentVersion,
      consentEpoch: privateProductAnalyticsCollectorInstallations.consentEpoch,
      revoked: privateProductAnalyticsCollectorInstallations.revoked,
    });
    if (row) return row;
    const [created] = await db.insert(privateProductAnalyticsCollectorInstallations).values({
      installationId: input.installationId,
      mode: "anonymous",
      consentVersion: input.consentVersion,
      consentEpoch: input.consentEpoch,
      revoked: input.revoked,
    }).onConflictDoNothing({ target: privateProductAnalyticsCollectorInstallations.installationId }).returning({
      consentVersion: privateProductAnalyticsCollectorInstallations.consentVersion,
      consentEpoch: privateProductAnalyticsCollectorInstallations.consentEpoch,
      revoked: privateProductAnalyticsCollectorInstallations.revoked,
    });
    return created ?? await readState(input.installationId) ?? { consentVersion: input.consentVersion, consentEpoch: input.consentEpoch, revoked: input.revoked };
  }

  return { ingestBatch, advanceConsent };
}
