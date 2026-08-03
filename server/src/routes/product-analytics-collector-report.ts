import type { Db } from "@rudderhq/db";
import {
  privateProductAnalyticsCollectorEvents,
  privateProductAnalyticsCollectorInstallations,
  privateProductAnalyticsCollectorPrivacyAggregates,
  privateProductAnalyticsCollectorQualityCounters,
  privateProductAnalyticsCollectorWorkLoopRevisions,
} from "@rudderhq/db";
import { and, gte, isNull, lte, sql } from "drizzle-orm";
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
  const to = toRaw ? new Date(toRaw) : new Date();
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new Error("invalid_window");
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
    const eventWhere = and(gte(privateProductAnalyticsCollectorEvents.occurredAt, range.from), lte(privateProductAnalyticsCollectorEvents.occurredAt, range.to));
    const eventSelect = {
      eventName: privateProductAnalyticsCollectorEvents.eventName,
      installationId: privateProductAnalyticsCollectorEvents.installationId,
      analyticsSubject: privateProductAnalyticsCollectorEvents.analyticsSubject,
      origin: privateProductAnalyticsCollectorEvents.origin,
      environment: privateProductAnalyticsCollectorEvents.environment,
      isInternal: privateProductAnalyticsCollectorEvents.isInternal,
      occurredAt: privateProductAnalyticsCollectorEvents.occurredAt,
    };
    const events = await db.select(eventSelect).from(privateProductAnalyticsCollectorEvents).where(eventWhere);
    const retentionEventTo = new Date(range.to.getTime() + 35 * 24 * 60 * 60 * 1000);
    const retentionEvents = await db.select(eventSelect).from(privateProductAnalyticsCollectorEvents).where(and(
      gte(privateProductAnalyticsCollectorEvents.occurredAt, range.from),
      lte(privateProductAnalyticsCollectorEvents.occurredAt, retentionEventTo),
    ));
    const production = events.filter((event) => event.environment === "production" && !event.isInternal);
    const retentionProduction = retentionEvents.filter((event) => event.environment === "production" && !event.isInternal);
    const meaningful = new Set(["human_work_started", "review_decision_recorded", "work_loop_completed"]);
    const productive = new Set(["output_ready", "work_loop_completed"]);
    const distinct = (rows: typeof production, key: "installationId" | "analyticsSubject") => new Set(rows.map((row) => row[key]).filter((value): value is string => Boolean(value))).size;
    const distinctActors = (rows: typeof production) => new Set(rows.map((row) => row.analyticsSubject ?? row.installationId)).size;
    const at = (days: number, names: Set<string>) => {
      const cutoff = new Date(range.to.getTime() - days * 24 * 60 * 60 * 1000);
      return distinct(production.filter((event) => event.occurredAt >= cutoff && names.has(event.eventName)), "installationId");
    };
    const loops = await db.select({ count: sql<number>`count(*)::int` }).from(privateProductAnalyticsCollectorWorkLoopRevisions).where(and(
      gte(privateProductAnalyticsCollectorWorkLoopRevisions.completedAt, range.from),
      lte(privateProductAnalyticsCollectorWorkLoopRevisions.completedAt, range.to),
      isNull(privateProductAnalyticsCollectorWorkLoopRevisions.invalidatedAt),
      eqProduction(privateProductAnalyticsCollectorWorkLoopRevisions.environment),
      eqHuman(privateProductAnalyticsCollectorWorkLoopRevisions.origin),
      eqFalse(privateProductAnalyticsCollectorWorkLoopRevisions.isInternal),
    ));
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
    }).from(privateProductAnalyticsCollectorPrivacyAggregates).where(and(gte(privateProductAnalyticsCollectorPrivacyAggregates.day, range.from.toISOString().slice(0, 10)), lte(privateProductAnalyticsCollectorPrivacyAggregates.day, range.to.toISOString().slice(0, 10))));
    const installations = await db.select({
      installationId: privateProductAnalyticsCollectorInstallations.installationId,
      firstSeenAt: privateProductAnalyticsCollectorInstallations.firstSeenAt,
    }).from(privateProductAnalyticsCollectorInstallations);
    const meaningfulEventsByInstallation = new Map<string, Date[]>();
    const loopEventsByInstallation = new Map<string, Date[]>();
    for (const event of retentionProduction) {
      if (meaningful.has(event.eventName)) {
        const dates = meaningfulEventsByInstallation.get(event.installationId) ?? [];
        dates.push(event.occurredAt);
        meaningfulEventsByInstallation.set(event.installationId, dates);
      }
      if (event.eventName === "work_loop_completed") {
        const dates = loopEventsByInstallation.get(event.installationId) ?? [];
        dates.push(event.occurredAt);
        loopEventsByInstallation.set(event.installationId, dates);
      }
    }
    const cohorts = new Map<string, { eligibleInstallations: number; meaningfulW1: number; loopW1: number; loopW4: number }>();
    for (const installation of installations) {
      const firstSeen = new Date(installation.firstSeenAt);
      const cohortDay = firstSeen.toISOString().slice(0, 10);
      const row = cohorts.get(cohortDay) ?? { eligibleInstallations: 0, meaningfulW1: 0, loopW1: 0, loopW4: 0 };
      const meaningfulDates = meaningfulEventsByInstallation.get(installation.installationId) ?? [];
      const loopDates = loopEventsByInstallation.get(installation.installationId) ?? [];
      const inWindow = (date: Date, startDays: number, endDays: number) => {
        const start = firstSeen.getTime() + startDays * 24 * 60 * 60 * 1000;
        const end = firstSeen.getTime() + endDays * 24 * 60 * 60 * 1000;
        return date.getTime() >= start && date.getTime() < end;
      };
      if (firstSeen <= range.to && firstSeen >= range.from) row.eligibleInstallations += 1;
      if (firstSeen <= range.to && meaningfulDates.some((date) => inWindow(date, 7, 14))) row.meaningfulW1 += 1;
      if (firstSeen <= range.to && loopDates.some((date) => inWindow(date, 7, 14))) row.loopW1 += 1;
      if (firstSeen <= range.to && loopDates.some((date) => inWindow(date, 28, 35))) row.loopW4 += 1;
      cohorts.set(cohortDay, row);
    }
    res.json({
      window: { from: range.from.toISOString(), to: range.to.toISOString(), timezone: "UTC" },
      metrics: {
        meaningfulActiveInstallations1d: at(1, meaningful),
        meaningfulActiveInstallations7d: at(7, meaningful),
        productiveInstallations7d: at(7, productive),
        weeklyCompletedWorkLoops: Number(loops[0]?.count ?? 0),
        meaningfulDau: distinctActors(production.filter((event) => meaningful.has(event.eventName))),
        productiveWau: distinctActors(production.filter((event) => productive.has(event.eventName))),
      },
      quality: { receivedBatchCount: Number(quality[0]?.receivedBatches ?? 0), acceptedEventCount: Number(quality[0]?.accepted ?? 0), lateEventCount: Number(quality[0]?.late ?? 0), duplicateEventCount: Number(quality[0]?.duplicate ?? 0), rejectedEventCount: Number(quality[0]?.rejected ?? 0), aggregateRows: aggregateRows.length },
      privacy: { aggregateRows: aggregateRows.map((row) => ({ metricName: row.metricName, metricValue: row.metricValue, contributingInstallations: row.contributingInstallations, privacyThreshold: row.privacyThreshold })) },
      coverage: { accountLinkedEventCount: production.filter((event) => Boolean(event.analyticsSubject)).length, anonymousEventCount: production.filter((event) => !event.analyticsSubject).length },
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

function eqProduction(column: typeof privateProductAnalyticsCollectorWorkLoopRevisions.environment) {
  return sql`${column} = 'production'`;
}

function eqHuman(column: typeof privateProductAnalyticsCollectorWorkLoopRevisions.origin) {
  return sql`${column} = 'human'`;
}

function eqFalse(column: typeof privateProductAnalyticsCollectorWorkLoopRevisions.isInternal) {
  return sql`${column} = false`;
}
