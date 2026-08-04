import type { Db } from "@rudderhq/db";
import {
  privateProductAnalyticsCollectorDailyRollups,
  privateProductAnalyticsCollectorPrivacyAggregates,
  privateProductAnalyticsCollectorQualityCounters,
} from "@rudderhq/db";
import { and, gte, lte, sql } from "drizzle-orm";
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
