import { index, pgTable, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { calendarSources } from "./calendar_sources.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { approvals } from "./approvals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { activityLog } from "./activity_log.js";

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    sourceId: uuid("source_id").references(() => calendarSources.id, { onDelete: "set null" }),
    eventKind: text("event_kind").notNull(),
    eventStatus: text("event_status").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerUserId: text("owner_user_id"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    allDay: boolean("all_day").notNull().default(false),
    visibility: text("visibility").notNull().default("full"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    activityId: uuid("activity_id").references(() => activityLog.id, { onDelete: "set null" }),
    sourceMode: text("source_mode").notNull().default("manual"),
    externalProvider: text("external_provider"),
    externalCalendarId: text("external_calendar_id"),
    externalEventId: text("external_event_id"),
    externalEtag: text("external_etag"),
    externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    orgRangeIdx: index("calendar_events_org_range_idx").on(table.orgId, table.startAt, table.endAt),
    orgAgentRangeIdx: index("calendar_events_org_agent_range_idx").on(
      table.orgId,
      table.ownerAgentId,
      table.startAt,
    ),
    orgSourceRangeIdx: index("calendar_events_org_source_range_idx").on(
      table.orgId,
      table.sourceId,
      table.startAt,
    ),
    externalIdx: index("calendar_events_external_idx").on(
      table.orgId,
      table.externalProvider,
      table.externalCalendarId,
      table.externalEventId,
    ),
  }),
);
