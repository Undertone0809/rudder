import type { Db } from "@rudderhq/db";
import { productAnalyticsEvents } from "@rudderhq/db";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { unprocessable } from "../errors.js";

export const PRODUCT_ANALYTICS_EVENT_NAMES = [
  "organization_created",
  "human_work_started",
  "run_started",
  "run_succeeded",
  "run_failed",
  "output_ready",
  "review_decision_recorded",
] as const;

export const PRODUCT_ANALYTICS_PRODUCED_EVENT_NAMES = [
  "organization_created",
  "human_work_started",
  "run_started",
  "run_succeeded",
  "run_failed",
  "output_ready",
] as const;

export const PRODUCT_ANALYTICS_DERIVED_EVENT_NAMES = ["review_decision_recorded"] as const;
export const PRODUCT_ANALYTICS_DEFERRED_EVENT_NAMES = [
  "account_created",
  "desktop_authorized",
  "local_server_connected",
  "first_agent_ready",
  "work_loop_completed",
  "work_loop_invalidated",
] as const;

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

type AnalyticsProperties = Record<string, ProductAnalyticsPropertyValue>;

const EVENT_NAME_SET = new Set<string>(PRODUCT_ANALYTICS_EVENT_NAMES);
const CONFIDENCE_SET = new Set<ProductAnalyticsConfidence>(["exact", "derived", "unknown"]);
const ACTOR_TYPE_SET = new Set<ProductAnalyticsActorType>(["human", "agent", "system", "automation"]);
const SENSITIVE_PROPERTY_KEY = /(prompt|transcript|title|description|body|content|path|url|token|secret|password|credential|email|hostname|username)/i;
const EVENT_PROPERTY_ALLOWLIST: Record<ProductAnalyticsEventName, ReadonlySet<string>> = {
  organization_created: new Set(["creation_source"]),
  human_work_started: new Set(["work_surface", "origin"]),
  run_started: new Set(["run_kind", "runtime", "attempt_kind"]),
  run_succeeded: new Set(["run_kind", "runtime", "attempt_kind"]),
  run_failed: new Set(["run_kind", "runtime", "attempt_kind", "terminal_status"]),
  output_ready: new Set(["output_kind"]),
  review_decision_recorded: new Set(["decision", "review_surface"]),
};

export type RecordProductAnalyticsEventInput = {
  orgId: string;
  eventName: ProductAnalyticsEventName;
  schemaVersion?: number;
  occurredAt?: Date;
  sourceTransition: string;
  confidence: ProductAnalyticsConfidence;
  actorType: ProductAnalyticsActorType;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  dedupeKey: string;
  properties?: AnalyticsProperties;
};

function assertBoundedText(value: string, field: string, maxLength: number) {
  if (value.length === 0 || value.length > maxLength) {
    throw unprocessable(`Product analytics ${field} is invalid`);
  }
}

function validateProperties(eventName: ProductAnalyticsEventName, properties: AnalyticsProperties): AnalyticsProperties {
  const allowed = EVENT_PROPERTY_ALLOWLIST[eventName];
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
  const rows = await db
    .insert(productAnalyticsEvents)
    .values({
      orgId: input.orgId,
      eventName: input.eventName,
      schemaVersion: input.schemaVersion ?? 1,
      occurredAt: input.occurredAt ?? new Date(),
      sourceTransition: input.sourceTransition,
      confidence: input.confidence,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      dedupeKey: input.dedupeKey,
      properties: input.properties ?? {},
    })
    .onConflictDoNothing({ target: [productAnalyticsEvents.orgId, productAnalyticsEvents.dedupeKey] })
    .returning({ id: productAnalyticsEvents.id });
  return rows[0] ?? null;
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
      const [eventCounts, distinctHumanRows, totalRows] = await Promise.all([
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
          successful_runs: counts.run_succeeded ?? 0,
          failed_runs: counts.run_failed ?? 0,
          human_work_started: counts.human_work_started ?? 0,
          output_ready: counts.output_ready ?? 0,
          review_decisions_recorded: counts.review_decision_recorded ?? 0,
          reviewed_issue_completions: Number(approvedReviewRows[0]?.count ?? 0),
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
          eventName: productAnalyticsEvents.eventName,
          schemaVersion: productAnalyticsEvents.schemaVersion,
          occurredAt: productAnalyticsEvents.occurredAt,
          sourceTransition: productAnalyticsEvents.sourceTransition,
          confidence: productAnalyticsEvents.confidence,
          actorType: productAnalyticsEvents.actorType,
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
