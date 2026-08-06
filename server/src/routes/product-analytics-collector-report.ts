import type { Db } from "@rudderhq/db";
import {
  privateProductAnalyticsCollectorDailyRollups,
  privateProductAnalyticsCollectorPrivacyAggregates,
  privateProductAnalyticsCollectorQualityCounters,
} from "@rudderhq/db";
import { and, gte, inArray, lte, sql } from "drizzle-orm";
import { Router } from "express";
import { timingSafeEqual } from "node:crypto";

function authorized(value: string | undefined, expected: string | null): boolean {
  if (!value || !expected) return false;
  const actual = Buffer.from(value);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function window(req: { query: Record<string, unknown> }) {
  const toRaw = typeof req.query.to === "string" ? req.query.to : undefined;
  const fromRaw = typeof req.query.from === "string" ? req.query.from : undefined;
  const toInput = toRaw ? new Date(toRaw) : new Date();
  const fromInput = fromRaw ? new Date(fromRaw) : new Date(toInput.getTime() - 6 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(fromInput.getTime()) || Number.isNaN(toInput.getTime()) || fromInput > toInput) throw new Error("invalid_window");
  // Reports are built from UTC daily rollups. Normalize arbitrary timestamps
  // to complete UTC days instead of implying sub-day precision we cannot
  // recover after the raw event has been projected.
  const from = new Date(Date.UTC(fromInput.getUTCFullYear(), fromInput.getUTCMonth(), fromInput.getUTCDate()));
  const to = new Date(Date.UTC(toInput.getUTCFullYear(), toInput.getUTCMonth(), toInput.getUTCDate() + 1) - 1);
  if (from >= to) throw new Error("invalid_window");
  return { from, to };
}

export type ProductAnalyticsCreationRollup = {
  day: string;
  installationId: string;
  eventName: string;
  origin: string;
  eventCount: number;
};

type DailyCreationValue = {
  count: number | null;
  status: "available" | "threshold_blocked" | "not_observed";
};

const CREATION_EVENT_FIELDS = {
  issue_created: "issuesCreated",
  chat_created: "chatsCreated",
} as const;

type CreationEventName = keyof typeof CREATION_EVENT_FIELDS;

/** Build a complete UTC-day series without exposing installation identifiers. */
export function buildProductAnalyticsCreationSeries(
  rows: readonly ProductAnalyticsCreationRollup[],
  range: { from: Date; to: Date },
  privacyThreshold: number,
  observedFromByEvent: Partial<Record<CreationEventName, string>> = {},
) {
  const creationRows = rows.filter((row) => row.eventName in CREATION_EVENT_FIELDS);
  const firstObserved = new Map<string, string>(Object.entries(observedFromByEvent));
  const groups = new Map<string, { count: number; installations: Set<string> }>();
  for (const row of creationRows) {
    const day = String(row.day).slice(0, 10);
    const first = firstObserved.get(row.eventName);
    if (!first || day < first) firstObserved.set(row.eventName, day);
    if (row.origin !== "human") continue;
    const key = `${day}\u0000${row.eventName}`;
    const group = groups.get(key) ?? { count: 0, installations: new Set<string>() };
    group.count += Number(row.eventCount);
    group.installations.add(row.installationId);
    groups.set(key, group);
  }

  const valueFor = (day: string, eventName: CreationEventName): DailyCreationValue => {
    const observedFrom = firstObserved.get(eventName);
    if (!observedFrom || day < observedFrom) return { count: null, status: "not_observed" };
    const group = groups.get(`${day}\u0000${eventName}`);
    if (!group) return { count: 0, status: "available" };
    if (group.installations.size < privacyThreshold) return { count: null, status: "threshold_blocked" };
    return { count: group.count, status: "available" };
  };

  const days = [];
  for (
    let cursor = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate()));
    cursor <= range.to;
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  ) {
    const day = cursor.toISOString().slice(0, 10);
    days.push({
      day,
      issuesCreated: valueFor(day, "issue_created"),
      chatsCreated: valueFor(day, "chat_created"),
    });
  }
  return { privacyThreshold, days };
}

/** Read-only, aggregate-only central reporting surface. It never returns IDs or raw properties. */
export function productAnalyticsCollectorReportRoutes(db: Db, options: { reportSecret: string | null; privacyThreshold?: number }) {
  const router = Router();
  const privacyThreshold = options.privacyThreshold ?? 10;
  router.get("/api/analytics/v1/report", async (req, res) => {
    const bearer = req.header("authorization")?.replace(/^Bearer\s+/iu, "");
    if (!authorized(bearer, options.reportSecret)) {
      res.status(401).json({ errorCode: "unauthorized" });
      return;
    }
    let range: { from: Date; to: Date };
    try {
      range = window(req);
    } catch {
      res.status(422).json({ errorCode: "invalid_window" });
      return;
    }
    const retentionEventTo = new Date(range.to.getTime() + 35 * 24 * 60 * 60 * 1000);
    // The report connection is intentionally limited to installation rollups
    // and thresholded aggregates. Raw events, subjects, and installation
    // registry rows are never readable by this route or its DB role.
    const rollupRows = await db.select({
      day: privateProductAnalyticsCollectorDailyRollups.day,
      installationId: privateProductAnalyticsCollectorDailyRollups.installationId,
      eventName: privateProductAnalyticsCollectorDailyRollups.eventName,
      origin: privateProductAnalyticsCollectorDailyRollups.origin,
      dimensions: privateProductAnalyticsCollectorDailyRollups.dimensions,
      eventCount: privateProductAnalyticsCollectorDailyRollups.eventCount,
      firstOccurredAt: privateProductAnalyticsCollectorDailyRollups.firstOccurredAt,
      lastOccurredAt: privateProductAnalyticsCollectorDailyRollups.lastOccurredAt,
    }).from(privateProductAnalyticsCollectorDailyRollups).where(and(
      gte(privateProductAnalyticsCollectorDailyRollups.day, range.from.toISOString().slice(0, 10)),
      lte(privateProductAnalyticsCollectorDailyRollups.day, retentionEventTo.toISOString().slice(0, 10)),
    ));
    const creationObservationRows = await db.select({
      eventName: privateProductAnalyticsCollectorDailyRollups.eventName,
      firstObservedDay: sql<string>`min(${privateProductAnalyticsCollectorDailyRollups.day})::text`,
    }).from(privateProductAnalyticsCollectorDailyRollups).where(and(
      inArray(privateProductAnalyticsCollectorDailyRollups.eventName, Object.keys(CREATION_EVENT_FIELDS)),
      sql`${privateProductAnalyticsCollectorDailyRollups.dimensions}->>'environment' = 'production'`,
    )).groupBy(privateProductAnalyticsCollectorDailyRollups.eventName);
    const production = rollupRows.filter((event) => event.dimensions?.environment === "production");
    const reportProduction = production.filter((event) => new Date(event.firstOccurredAt) <= range.to);
    const retentionProduction = production.filter((event) => new Date(event.lastOccurredAt) <= retentionEventTo);
    const meaningful = new Set(["human_work_started", "review_decision_recorded", "work_loop_completed"]);
    const productive = new Set(["output_ready", "work_loop_completed"]);
    const distinct = (rows: typeof production) => new Set(rows.map((row) => row.installationId)).size;
    const at = (days: number, names: Set<string>) => {
      const cutoff = new Date(range.to.getTime() - days * 24 * 60 * 60 * 1000);
      return distinct(reportProduction.filter((event) => new Date(event.lastOccurredAt) >= cutoff && names.has(event.eventName)));
    };
    const quality = await db.select({
      receivedBatches: sql<number>`coalesce(sum(${privateProductAnalyticsCollectorQualityCounters.receivedBatches}), 0)::int`,
      accepted: sql<number>`coalesce(sum(${privateProductAnalyticsCollectorQualityCounters.acceptedEvents}), 0)::int`,
      late: sql<number>`coalesce(sum(${privateProductAnalyticsCollectorQualityCounters.lateEvents}), 0)::int`,
      duplicate: sql<number>`coalesce(sum(${privateProductAnalyticsCollectorQualityCounters.duplicateEvents}), 0)::int`,
      rejected: sql<number>`coalesce(sum(${privateProductAnalyticsCollectorQualityCounters.rejectedEvents}), 0)::int`,
    }).from(privateProductAnalyticsCollectorQualityCounters).where(and(
      gte(privateProductAnalyticsCollectorQualityCounters.day, range.from.toISOString().slice(0, 10)),
      lte(privateProductAnalyticsCollectorQualityCounters.day, range.to.toISOString().slice(0, 10)),
    ));
    const aggregateRows = await db.select({
      metricName: privateProductAnalyticsCollectorPrivacyAggregates.metricName,
      metricValue: privateProductAnalyticsCollectorPrivacyAggregates.metricValue,
      contributingInstallations: privateProductAnalyticsCollectorPrivacyAggregates.contributingInstallations,
      privacyThreshold: privateProductAnalyticsCollectorPrivacyAggregates.privacyThreshold,
      dimensionValues: privateProductAnalyticsCollectorPrivacyAggregates.dimensionValues,
    }).from(privateProductAnalyticsCollectorPrivacyAggregates).where(and(gte(privateProductAnalyticsCollectorPrivacyAggregates.day, range.from.toISOString().slice(0, 10)), lte(privateProductAnalyticsCollectorPrivacyAggregates.day, range.to.toISOString().slice(0, 10))));
    const loops = aggregateRows
      .filter((row) => row.metricName === "weekly_completed_work_loops")
      .reduce((sum, row) => sum + Number(row.metricValue), 0);
    const dailyCreation = buildProductAnalyticsCreationSeries(
      reportProduction.map((row) => ({
        day: String(row.day),
        installationId: row.installationId,
        eventName: row.eventName,
        origin: row.origin,
        eventCount: Number(row.eventCount),
      })),
      range,
      privacyThreshold,
      Object.fromEntries(creationObservationRows.map((row) => [row.eventName, row.firstObservedDay])),
    );
    const firstSeenByInstallation = new Map<string, Date>();
    for (const event of retentionProduction) {
      const firstSeen = firstSeenByInstallation.get(event.installationId);
      const candidate = new Date(event.firstOccurredAt);
      if (!firstSeen || candidate < firstSeen) firstSeenByInstallation.set(event.installationId, candidate);
    }
    const meaningfulEventsByInstallation = new Map<string, Date[]>();
    for (const event of retentionProduction) {
      if (meaningful.has(event.eventName)) {
        const dates = meaningfulEventsByInstallation.get(event.installationId) ?? [];
        dates.push(new Date(event.lastOccurredAt));
        meaningfulEventsByInstallation.set(event.installationId, dates);
      }
    }
    const loopRetentionByCohort = new Map<string, { w1: number; w4: number }>();
    for (const row of aggregateRows.filter((value) => value.metricName === "work_loop_retention")) {
      const cohortDay = typeof row.dimensionValues?.cohort_day === "string" ? row.dimensionValues.cohort_day : null;
      const window = row.dimensionValues?.window;
      if (!cohortDay || (window !== "w1" && window !== "w4")) continue;
      const retention = loopRetentionByCohort.get(cohortDay) ?? { w1: 0, w4: 0 };
      retention[window] = Number(row.metricValue);
      loopRetentionByCohort.set(cohortDay, retention);
    }
    const cohorts = new Map<string, { eligibleInstallations: number; meaningfulW1: number; loopW1: number; loopW4: number }>();
    for (const [installationId, firstSeen] of firstSeenByInstallation) {
      const cohortDay = firstSeen.toISOString().slice(0, 10);
      const row = cohorts.get(cohortDay) ?? { eligibleInstallations: 0, meaningfulW1: 0, loopW1: 0, loopW4: 0 };
      const meaningfulDates = meaningfulEventsByInstallation.get(installationId) ?? [];
      const inWindow = (date: Date, startDays: number, endDays: number) => {
        const start = firstSeen.getTime() + startDays * 24 * 60 * 60 * 1000;
        const end = firstSeen.getTime() + endDays * 24 * 60 * 60 * 1000;
        return date.getTime() >= start && date.getTime() < end;
      };
      if (firstSeen <= range.to && firstSeen >= range.from) row.eligibleInstallations += 1;
      if (firstSeen <= range.to && meaningfulDates.some((date) => inWindow(date, 7, 14))) row.meaningfulW1 += 1;
      const loopRetention = loopRetentionByCohort.get(cohortDay);
      if (firstSeen <= range.to && loopRetention) {
        row.loopW1 = loopRetention.w1;
        row.loopW4 = loopRetention.w4;
      }
      cohorts.set(cohortDay, row);
    }
    res.json({
      window: { from: range.from.toISOString(), to: range.to.toISOString(), timezone: "UTC" },
      metrics: {
        meaningfulActiveInstallations1d: at(1, meaningful),
        meaningfulActiveInstallations7d: at(7, meaningful),
        productiveInstallations7d: at(7, productive),
        weeklyCompletedWorkLoops: loops,
        meaningfulDau: at(1, meaningful),
        productiveWau: at(7, productive),
      },
      quality: { receivedBatchCount: Number(quality[0]?.receivedBatches ?? 0), acceptedEventCount: Number(quality[0]?.accepted ?? 0), lateEventCount: Number(quality[0]?.late ?? 0), duplicateEventCount: Number(quality[0]?.duplicate ?? 0), rejectedEventCount: Number(quality[0]?.rejected ?? 0), aggregateRows: aggregateRows.length },
      privacy: { aggregateRows: aggregateRows.map((row) => ({ metricName: row.metricName, metricValue: row.metricValue, contributingInstallations: row.contributingInstallations, privacyThreshold: row.privacyThreshold })) },
      coverage: {
        accountLinkedEventCount: reportProduction.filter((event) => event.dimensions?.analytics_mode === "account_linked").reduce((sum, event) => sum + Number(event.eventCount), 0),
        anonymousEventCount: reportProduction.filter((event) => event.dimensions?.analytics_mode !== "account_linked").reduce((sum, event) => sum + Number(event.eventCount), 0),
      },
      dailyCreation,
      retention: [...cohorts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([cohortDay, row]) => {
        const suppressed = row.eligibleInstallations < privacyThreshold;
        return suppressed
          ? { cohortDay, eligibleInstallations: null, meaningfulW1: null, loopW1: null, loopW4: null, suppressed: true }
          : { cohortDay, ...row, suppressed: false };
      }),
    });
  });
  return router;
}
