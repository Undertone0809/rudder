import { integer, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const runDiagnosticFindings = pgTable(
  "run_diagnostic_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    fingerprint: text("fingerprint").notNull(),
    summary: text("summary").notNull(),
    detailsJson: jsonb("details_json").$type<Record<string, unknown>>(),
    evidenceJson: jsonb("evidence_json").$type<Array<{ label: string; value: string }>>().notNull().default([]),
    rawExcerpt: text("raw_excerpt"),
    source: text("source").notNull().default("run_diagnostics"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgStatusUpdatedIdx: index("run_diagnostic_findings_org_status_updated_idx").on(
      table.orgId,
      table.status,
      table.updatedAt,
    ),
    orgKindIdx: index("run_diagnostic_findings_org_kind_idx").on(table.orgId, table.kind),
    runIdx: index("run_diagnostic_findings_run_idx").on(table.runId),
    orgFingerprintStatusIdx: index("run_diagnostic_findings_org_fingerprint_status_idx").on(
      table.orgId,
      table.fingerprint,
      table.status,
    ),
    orgRunFingerprintIdx: uniqueIndex("run_diagnostic_findings_org_run_fingerprint_idx").on(
      table.orgId,
      table.runId,
      table.fingerprint,
    ),
  }),
);
