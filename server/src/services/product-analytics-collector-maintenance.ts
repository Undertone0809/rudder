import type { Db } from "@rudderhq/db";
import {
  privateProductAnalyticsCollectorDailyRollups,
  privateProductAnalyticsCollectorEvents,
  privateProductAnalyticsCollectorInstallations,
  privateProductAnalyticsCollectorPrivacyAggregates,
  privateProductAnalyticsCollectorQualityCounters,
  privateProductAnalyticsCollectorSubjects,
  privateProductAnalyticsCollectorWorkLoopRevisions,
} from "@rudderhq/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

const PROJECTOR_LOOKBACK_DAYS = 30;

export type ProductAnalyticsCollectorMaintenanceOptions = {
  retentionDays: number;
  privacyThreshold: number;
  now?: Date;
};

export type ProductAnalyticsCollectorMaintenanceResult = {
  projectedWorkLoopRevisions: number;
  rebuiltRollupDays: number;
  privacyAggregateRows: number;
  deletedRawEvents: number;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashProductAnalyticsCollectorDimension(value: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function dayOf(value: Date) {
  return value.toISOString().slice(0, 10);
}

/** Ensure a collector DB cannot accidentally run with the local app role/schema. */
export async function assertProductAnalyticsCollectorDatabaseBoundary(db: Db, expectedRole?: string | null): Promise<{ role: string; schema: string }> {
  const rows = await db.execute(sql`
    SELECT current_user AS role,
           current_schema() AS schema,
           has_schema_privilege(current_user, 'rudder_analytics', 'USAGE') AS has_usage,
           has_schema_privilege(current_user, 'rudder_analytics', 'CREATE') AS has_create
  `);
  const row = rows[0] as { role?: unknown; schema?: unknown; has_usage?: unknown; has_create?: unknown } | undefined;
  const role = typeof row?.role === "string" ? row.role : "";
  const schema = typeof row?.schema === "string" ? row.schema : "";
  if (!role || (expectedRole && role !== expectedRole) || row?.has_usage !== true || row?.has_create === true) {
    throw new Error("product_analytics_collector_database_boundary_failed");
  }
  return { role, schema };
}

async function projectWorkLoopRevisions(db: Db, now: Date): Promise<number> {
  const events = await db.select({
    eventId: privateProductAnalyticsCollectorEvents.eventId,
    installationId: privateProductAnalyticsCollectorEvents.installationId,
    analyticsSubject: privateProductAnalyticsCollectorEvents.analyticsSubject,
    pseudonymousOrgId: privateProductAnalyticsCollectorEvents.pseudonymousOrgId,
    pseudonymousWorkCycleId: privateProductAnalyticsCollectorEvents.pseudonymousWorkCycleId,
    completionRevision: privateProductAnalyticsCollectorEvents.completionRevision,
    eventName: privateProductAnalyticsCollectorEvents.eventName,
    occurredAt: privateProductAnalyticsCollectorEvents.occurredAt,
    environment: privateProductAnalyticsCollectorEvents.environment,
    releaseChannel: privateProductAnalyticsCollectorEvents.releaseChannel,
    origin: privateProductAnalyticsCollectorEvents.origin,
    isInternal: privateProductAnalyticsCollectorEvents.isInternal,
    confidence: privateProductAnalyticsCollectorEvents.confidence,
    properties: privateProductAnalyticsCollectorEvents.properties,
  }).from(privateProductAnalyticsCollectorEvents).where(inArray(privateProductAnalyticsCollectorEvents.eventName, ["work_loop_completed", "work_loop_invalidated"]));
  let changed = 0;
  for (const event of events) {
    if (!event.pseudonymousWorkCycleId || !event.completionRevision || !event.installationId) continue;
    if (event.eventName === "work_loop_completed") {
      await db.insert(privateProductAnalyticsCollectorWorkLoopRevisions).values({
        installationId: event.installationId,
        analyticsSubject: event.analyticsSubject,
        pseudonymousOrgId: event.pseudonymousOrgId,
        pseudonymousWorkCycleId: event.pseudonymousWorkCycleId,
        completionRevision: event.completionRevision,
        completionEventId: event.eventId,
        completedAt: event.occurredAt,
        environment: event.environment,
        releaseChannel: event.releaseChannel,
        origin: event.origin,
        isInternal: event.isInternal,
        confidence: event.confidence,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [privateProductAnalyticsCollectorWorkLoopRevisions.installationId, privateProductAnalyticsCollectorWorkLoopRevisions.pseudonymousWorkCycleId, privateProductAnalyticsCollectorWorkLoopRevisions.completionRevision],
        set: {
          completionEventId: event.eventId,
          completedAt: event.occurredAt,
          analyticsSubject: event.analyticsSubject,
          pseudonymousOrgId: event.pseudonymousOrgId,
          environment: event.environment,
          releaseChannel: event.releaseChannel,
          origin: event.origin,
          isInternal: event.isInternal,
          confidence: event.confidence,
          updatedAt: now,
        },
      });
      changed += 1;
      continue;
    }
    const properties = event.properties ?? {};
    const reason = typeof properties.reason_code === "string" ? properties.reason_code : null;
    const result = await db.update(privateProductAnalyticsCollectorWorkLoopRevisions).set({
      invalidatedAt: event.occurredAt,
      invalidationReasonCode: reason,
      invalidationEventId: event.eventId,
      updatedAt: now,
    }).where(and(
      eq(privateProductAnalyticsCollectorWorkLoopRevisions.installationId, event.installationId),
      eq(privateProductAnalyticsCollectorWorkLoopRevisions.pseudonymousWorkCycleId, event.pseudonymousWorkCycleId),
      eq(privateProductAnalyticsCollectorWorkLoopRevisions.completionRevision, event.completionRevision),
    ));
    if (result.count > 0) changed += result.count;
  }
  return changed;
}

async function rebuildDailyRollups(db: Db, now: Date, fromOverride?: Date): Promise<number> {
  const from = fromOverride ?? new Date(now.getTime() - PROJECTOR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  await db.delete(privateProductAnalyticsCollectorDailyRollups).where(gte(privateProductAnalyticsCollectorDailyRollups.day, dayOf(from)));
  const rows = await db.select({
    day: sql<string>`(${privateProductAnalyticsCollectorEvents.occurredAt} AT TIME ZONE 'UTC')::date`,
    installationId: privateProductAnalyticsCollectorEvents.installationId,
    eventName: privateProductAnalyticsCollectorEvents.eventName,
    origin: privateProductAnalyticsCollectorEvents.origin,
    dimensions: sql<Record<string, string | number | boolean | null>>`jsonb_build_object(
      'environment', ${privateProductAnalyticsCollectorEvents.environment},
      'app_version', ${privateProductAnalyticsCollectorEvents.appVersion},
      'release_channel', ${privateProductAnalyticsCollectorEvents.releaseChannel},
      'deployment_mode', ${privateProductAnalyticsCollectorEvents.deploymentMode},
      'confidence', ${privateProductAnalyticsCollectorEvents.confidence}
    )`,
    eventCount: sql<number>`count(*)::int`,
    firstOccurredAt: sql<Date>`min(${privateProductAnalyticsCollectorEvents.occurredAt})`,
    lastOccurredAt: sql<Date>`max(${privateProductAnalyticsCollectorEvents.occurredAt})`,
  }).from(privateProductAnalyticsCollectorEvents)
    .where(and(
      gte(privateProductAnalyticsCollectorEvents.occurredAt, from),
      eq(privateProductAnalyticsCollectorEvents.environment, "production"),
      eq(privateProductAnalyticsCollectorEvents.isInternal, false),
    ))
    .groupBy(
      sql`(${privateProductAnalyticsCollectorEvents.occurredAt} AT TIME ZONE 'UTC')::date`,
      privateProductAnalyticsCollectorEvents.installationId,
      privateProductAnalyticsCollectorEvents.eventName,
      privateProductAnalyticsCollectorEvents.origin,
      privateProductAnalyticsCollectorEvents.environment,
      privateProductAnalyticsCollectorEvents.appVersion,
      privateProductAnalyticsCollectorEvents.releaseChannel,
      privateProductAnalyticsCollectorEvents.deploymentMode,
      privateProductAnalyticsCollectorEvents.confidence,
    );
  for (const row of rows) {
    const dimensions = row.dimensions ?? {};
    await db.insert(privateProductAnalyticsCollectorDailyRollups).values({
      day: row.day,
      installationId: row.installationId,
      eventName: row.eventName,
      origin: row.origin,
      dimensionHash: hashProductAnalyticsCollectorDimension(dimensions),
      dimensions,
      eventCount: Number(row.eventCount),
      firstOccurredAt: new Date(row.firstOccurredAt),
      lastOccurredAt: new Date(row.lastOccurredAt),
      updatedAt: now,
    });
  }
  return new Set(rows.map((row) => row.day)).size;
}

async function rebuildPrivacyAggregates(db: Db, options: ProductAnalyticsCollectorMaintenanceOptions, now: Date, fromOverride?: Date): Promise<number> {
  const from = fromOverride ?? new Date(now.getTime() - PROJECTOR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const groups = await db.select({
    day: sql<string>`(${privateProductAnalyticsCollectorEvents.occurredAt} AT TIME ZONE 'UTC')::date`,
    metricName: privateProductAnalyticsCollectorEvents.eventName,
    eventName: privateProductAnalyticsCollectorEvents.eventName,
    origin: privateProductAnalyticsCollectorEvents.origin,
    eventCount: sql<number>`count(*)::int`,
    contributingInstallations: sql<number>`count(distinct ${privateProductAnalyticsCollectorEvents.installationId})::int`,
  }).from(privateProductAnalyticsCollectorEvents)
    .where(and(
      gte(privateProductAnalyticsCollectorEvents.occurredAt, from),
      eq(privateProductAnalyticsCollectorEvents.environment, "production"),
      eq(privateProductAnalyticsCollectorEvents.isInternal, false),
    ))
    .groupBy(
      sql`(${privateProductAnalyticsCollectorEvents.occurredAt} AT TIME ZONE 'UTC')::date`,
      privateProductAnalyticsCollectorEvents.eventName,
      privateProductAnalyticsCollectorEvents.origin,
    );
  await db.delete(privateProductAnalyticsCollectorPrivacyAggregates).where(gte(privateProductAnalyticsCollectorPrivacyAggregates.day, dayOf(from)));
  let written = 0;
  for (const group of groups) {
    const contributingInstallations = Number(group.contributingInstallations);
    if (contributingInstallations < options.privacyThreshold) continue;
    const dimensionValues = { event_name: group.eventName, origin: group.origin };
    await db.insert(privateProductAnalyticsCollectorPrivacyAggregates).values({
      day: group.day,
      metricName: group.metricName,
      dimensionSetVersion: 1,
      dimensionHash: hashProductAnalyticsCollectorDimension(dimensionValues),
      dimensionValues,
      metricValue: Number(group.eventCount),
      contributingInstallations,
      privacyThreshold: options.privacyThreshold,
      updatedAt: now,
    });
    written += 1;
  }
  return written;
}

async function applyRetention(db: Db, retentionDays: number, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(privateProductAnalyticsCollectorEvents)
    .where(lt(privateProductAnalyticsCollectorEvents.occurredAt, cutoff))
    .returning({ eventId: privateProductAnalyticsCollectorEvents.eventId });
  await db.delete(privateProductAnalyticsCollectorWorkLoopRevisions)
    .where(lt(privateProductAnalyticsCollectorWorkLoopRevisions.completedAt, cutoff));
  await db.delete(privateProductAnalyticsCollectorDailyRollups).where(lt(privateProductAnalyticsCollectorDailyRollups.day, dayOf(cutoff)));
  await db.delete(privateProductAnalyticsCollectorPrivacyAggregates).where(lt(privateProductAnalyticsCollectorPrivacyAggregates.day, dayOf(cutoff)));
  await db.delete(privateProductAnalyticsCollectorQualityCounters).where(lt(privateProductAnalyticsCollectorQualityCounters.day, dayOf(cutoff)));
  return deleted.length;
}

/** Run the central projector and retention policy as one idempotent maintenance tick. */
export async function runProductAnalyticsCollectorMaintenance(db: Db, options: ProductAnalyticsCollectorMaintenanceOptions): Promise<ProductAnalyticsCollectorMaintenanceResult> {
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1) throw new Error("invalid_product_analytics_retention_days");
  if (!Number.isInteger(options.privacyThreshold) || options.privacyThreshold < 2) throw new Error("invalid_product_analytics_privacy_threshold");
  const now = options.now ?? new Date();
  const projectedWorkLoopRevisions = await projectWorkLoopRevisions(db, now);
  // Retention runs before rebuild. Rebuild from the UTC start of the cutoff
  // day so events that arrived after the precise timestamp remain represented
  // instead of inheriting a stale whole-day rollup.
  const deletedRawEvents = await applyRetention(db, options.retentionDays, now);
  const cutoff = new Date(now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000);
  const projectorFrom = new Date(Math.min(
    cutoff.getTime(),
    now.getTime() - PROJECTOR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ));
  const rebuiltRollupDays = await rebuildDailyRollups(db, now, projectorFrom);
  const privacyAggregateRows = await rebuildPrivacyAggregates(db, options, now, projectorFrom);
  return { projectedWorkLoopRevisions, rebuiltRollupDays, privacyAggregateRows, deletedRawEvents };
}

export async function deleteProductAnalyticsCollectorInstallation(db: Db, installationId: string): Promise<void> {
  await db.delete(privateProductAnalyticsCollectorEvents).where(eq(privateProductAnalyticsCollectorEvents.installationId, installationId));
  await db.delete(privateProductAnalyticsCollectorDailyRollups).where(eq(privateProductAnalyticsCollectorDailyRollups.installationId, installationId));
  await db.delete(privateProductAnalyticsCollectorWorkLoopRevisions).where(eq(privateProductAnalyticsCollectorWorkLoopRevisions.installationId, installationId));
  await db.delete(privateProductAnalyticsCollectorSubjects).where(eq(privateProductAnalyticsCollectorSubjects.installationId, installationId));
  await db.delete(privateProductAnalyticsCollectorInstallations).where(eq(privateProductAnalyticsCollectorInstallations.installationId, installationId));
  // Installation-level rollups and k-threshold aggregates are recomputed by
  // the next maintenance tick so a deletion cannot leave stale counts.
  await db.delete(privateProductAnalyticsCollectorPrivacyAggregates);
}

export async function deleteProductAnalyticsCollectorSubject(db: Db, analyticsSubject: string): Promise<void> {
  await db.delete(privateProductAnalyticsCollectorEvents).where(eq(privateProductAnalyticsCollectorEvents.analyticsSubject, analyticsSubject));
  await db.delete(privateProductAnalyticsCollectorWorkLoopRevisions).where(eq(privateProductAnalyticsCollectorWorkLoopRevisions.analyticsSubject, analyticsSubject));
  await db.delete(privateProductAnalyticsCollectorSubjects).where(eq(privateProductAnalyticsCollectorSubjects.analyticsSubject, analyticsSubject));
  await db.delete(privateProductAnalyticsCollectorDailyRollups);
  await db.delete(privateProductAnalyticsCollectorPrivacyAggregates);
}
