import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chatConversations } from "./chat_conversations.js";
import { heartbeatRunAttempts } from "./heartbeat_run_attempts.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { organizations } from "./organizations.js";

type RuntimeBindingKeyColumns = { id: AnyPgColumn; orgId: AnyPgColumn };
type NativeSegmentKeyColumns = { id: AnyPgColumn; orgId: AnyPgColumn; bindingId: AnyPgColumn };

export type RuntimeBindingTargetType =
  | "issue"
  | "chat_conversation"
  | "chat_message"
  | "automation_run"
  | "wakeup_request"
  | "manual"
  | "review";

/**
 * The authorization material captured by a binding epoch. The database keeps
 * the canonical values on the binding row; segments and spans refer to that
 * immutable row by id so historical reads never inherit a later active head.
 */
export type RuntimeBindingIdentitySnapshot = {
  version: 1;
  bindingId: string;
  bindingEpoch: number;
  orgId: string;
  principalScopeRef: string;
  agentId: string;
  runtimeType: string;
  hostId: string;
  profileId: string;
  workspaceBindingId: string | null;
  instructionsRevision: string;
  capabilityRevision: string;
};

// Extra-config builders are evaluated after module initialization. Explicitly
// typed key holders break the mutual runtimeBindings/nativeSegments inference
// cycle while keeping the actual Drizzle columns as FK targets.
let runtimeBindingKeyColumns: RuntimeBindingKeyColumns;
let nativeSegmentKeyColumns: NativeSegmentKeyColumns;

/**
 * A product conversation's durable association with one provider-native
 * session lineage. The provider identifier lives on a segment because a
 * runtime may rotate or fork its physical storage without changing the
 * Rudder conversation.
 */
export const runtimeBindings = pgTable(
  "runtime_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    /** Nullable for non-Chat scenes; targetType/targetId are the authoritative key there. */
    conversationId: uuid("conversation_id").references(() => chatConversations.id, { onDelete: "cascade" }),
    /** Product target covered by this binding. Legacy Chat rows may omit these and use conversationId. */
    targetType: text("target_type").$type<RuntimeBindingTargetType | null>(),
    targetId: text("target_id"),
    /** Stable authorization scope. It is deliberately opaque and is not a provider session id. */
    principalScopeRef: text("principal_scope_ref").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    runtimeType: text("runtime_type").notNull(),
    hostId: text("host_id").notNull().default("local"),
    profileId: text("profile_id").notNull().default("default"),
    workspaceBindingId: text("workspace_binding_id"),
    instructionsRevision: text("instructions_revision").notNull().default("unknown"),
    capabilityRevision: text("capability_revision").notNull().default("unknown"),
    continuity: text("continuity").$type<"native" | "context_handoff" | "legacy">().notNull().default("native"),
    parentBindingId: uuid("parent_binding_id").references((): AnyPgColumn => runtimeBindings.id, { onDelete: "set null" }),
    sourceBoundaryRef: text("source_boundary_ref"),
    bindingEpoch: integer("binding_epoch").notNull().default(0),
    currentSegmentId: uuid("current_segment_id"),
    status: text("status").$type<"active" | "closed" | "superseded">().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Exactly one active identity head may serve a conversation. Superseded
     * epochs remain addressable by historical segments/spans. */
    orgConversationUnique: uniqueIndex("runtime_bindings_org_conversation_uq")
      .on(table.orgId, table.conversationId)
      .where(sql`${table.status} = 'active' and ${table.conversationId} is not null`),
    orgConversationEpochUnique: uniqueIndex("runtime_bindings_org_conversation_epoch_uq")
      .on(table.orgId, table.conversationId, table.bindingEpoch),
    orgTargetUnique: uniqueIndex("runtime_bindings_org_target_uq")
      .on(table.orgId, table.targetType, table.targetId)
      .where(sql`${table.status} = 'active' and ${table.targetType} is not null and ${table.targetId} is not null`),
    orgTargetEpochUnique: uniqueIndex("runtime_bindings_org_target_epoch_uq")
      .on(table.orgId, table.targetType, table.targetId, table.bindingEpoch)
      .where(sql`${table.targetType} is not null and ${table.targetId} is not null`),
    orgIdIdUnique: uniqueIndex("runtime_bindings_org_id_uq").on(table.orgId, table.id),
    orgAgentUpdatedIdx: index("runtime_bindings_org_agent_updated_idx").on(table.orgId, table.agentId, table.updatedAt),
    orgCurrentSegmentIdx: index("runtime_bindings_org_current_segment_idx").on(table.orgId, table.currentSegmentId),
    bindingEpochCheck: check(
      "runtime_bindings_binding_epoch_check",
      sql`${table.bindingEpoch} >= 0`,
    ),
    parentBindingNotSelfCheck: check(
      "runtime_bindings_parent_binding_not_self_check",
      sql`${table.parentBindingId} is null or ${table.parentBindingId} <> ${table.id}`,
    ),
    targetShapeCheck: check(
      "runtime_bindings_target_shape_check",
      sql`(
        (${table.targetType} is null and ${table.targetId} is null and ${table.conversationId} is not null)
        or
        (${table.targetType} is not null and ${table.targetType} = 'chat_conversation'
          and ${table.targetId} is not null
          and btrim(${table.targetId}) <> ''
          and ${table.conversationId} is not null
          and ${table.targetId} = ${table.conversationId}::text)
        or
        (${table.targetType} is not null and ${table.targetType} in ('issue', 'chat_message', 'automation_run', 'wakeup_request', 'manual', 'review')
          and ${table.targetId} is not null
          and btrim(${table.targetId}) <> ''
          and ${table.conversationId} is null)
      )`,
    ),
    targetTypeCheck: check(
      "runtime_bindings_target_type_check",
      sql`${table.targetType} is null or ${table.targetType} in ('issue', 'chat_conversation', 'chat_message', 'automation_run', 'wakeup_request', 'manual', 'review')`,
    ),
    continuityCheck: check(
      "runtime_bindings_continuity_check",
      sql`${table.continuity} in ('native', 'context_handoff', 'legacy')`,
    ),
    statusCheck: check(
      "runtime_bindings_status_check",
      sql`${table.status} in ('active', 'closed', 'superseded')`,
    ),
    orgConversationFk: foreignKey({
      name: "runtime_bindings_org_conversation_fk",
      columns: [table.orgId, table.conversationId],
      foreignColumns: [chatConversations.orgId, chatConversations.id],
    }).onDelete("cascade"),
    orgAgentFk: foreignKey({
      name: "runtime_bindings_org_agent_fk",
      columns: [table.orgId, table.agentId],
      foreignColumns: [agents.orgId, agents.id],
    }).onDelete("restrict"),
    parentBindingOrgFk: foreignKey({
      name: "runtime_bindings_parent_binding_org_fk",
      columns: [table.orgId, table.parentBindingId],
      foreignColumns: [runtimeBindingKeyColumns.orgId, runtimeBindingKeyColumns.id],
    }).onDelete("no action"),
    currentSegmentFk: foreignKey({
      name: "runtime_bindings_current_segment_fk",
      columns: [table.currentSegmentId],
      foreignColumns: [nativeSegments.id],
    }).onDelete("set null"),
    currentSegmentBindingFk: foreignKey({
      name: "runtime_bindings_current_segment_binding_fk",
      columns: [table.orgId, table.id, table.currentSegmentId],
      foreignColumns: [
        nativeSegmentKeyColumns.orgId,
        nativeSegmentKeyColumns.bindingId,
        nativeSegmentKeyColumns.id,
      ],
    }).onDelete("no action"),
  }),
);

runtimeBindingKeyColumns = runtimeBindings;

export const nativeSegments = pgTable(
  "native_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").notNull().references((): AnyPgColumn => runtimeBindingKeyColumns.id, { onDelete: "cascade" }),
    runtimeType: text("runtime_type").notNull(),
    segmentOrdinal: integer("segment_ordinal").notNull().default(0),
    nativeSessionId: text("native_session_id"),
    rootSessionId: text("root_session_id"),
    parentSegmentId: uuid("parent_segment_id").references((): AnyPgColumn => nativeSegments.id, { onDelete: "set null" }),
    leafId: text("leaf_id"),
    providerStateJson: jsonb("provider_state_json").$type<Record<string, unknown>>(),
    sourceBoundaryRef: text("source_boundary_ref"),
    state: text("state").$type<"pending" | "open" | "sealed" | "superseded">().notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bindingCreatedIdx: index("native_segments_binding_created_idx").on(table.bindingId, table.createdAt),
    bindingOrdinalUnique: uniqueIndex("native_segments_binding_ordinal_uq").on(table.bindingId, table.segmentOrdinal),
    orgIdIdUnique: uniqueIndex("native_segments_org_id_uq").on(table.orgId, table.id),
    orgBindingIdUnique: uniqueIndex("native_segments_org_binding_id_uq").on(table.orgId, table.bindingId, table.id),
    orgNativeSessionIdx: index("native_segments_org_native_session_idx").on(table.orgId, table.nativeSessionId),
    bindingLeafIdx: index("native_segments_binding_leaf_idx").on(table.bindingId, table.leafId),
    segmentOrdinalCheck: check(
      "native_segments_segment_ordinal_check",
      sql`${table.segmentOrdinal} >= 0`,
    ),
    parentSegmentNotSelfCheck: check(
      "native_segments_parent_segment_not_self_check",
      sql`${table.parentSegmentId} is null or ${table.parentSegmentId} <> ${table.id}`,
    ),
    stateCheck: check(
      "native_segments_state_check",
      sql`${table.state} in ('pending', 'open', 'sealed', 'superseded')`,
    ),
    sealedLifecycleCheck: check(
      "native_segments_sealed_lifecycle_check",
      sql`(
        (${table.state} in ('pending', 'open') and ${table.sealedAt} is null)
        or (${table.state} in ('sealed', 'superseded') and ${table.sealedAt} is not null)
      )`,
    ),
    sealedAfterCreateCheck: check(
      "native_segments_sealed_after_create_check",
      sql`${table.sealedAt} is null or ${table.sealedAt} >= ${table.createdAt}`,
    ),
    orgBindingFk: foreignKey({
      name: "native_segments_org_binding_fk",
      columns: [table.orgId, table.bindingId],
      foreignColumns: [runtimeBindingKeyColumns.orgId, runtimeBindingKeyColumns.id],
    }).onDelete("cascade"),
    parentSegmentBindingFk: foreignKey({
      name: "native_segments_parent_segment_binding_fk",
      columns: [table.orgId, table.bindingId, table.parentSegmentId],
      foreignColumns: [
        nativeSegmentKeyColumns.orgId,
        nativeSegmentKeyColumns.bindingId,
        nativeSegmentKeyColumns.id,
      ],
    }).onDelete("no action"),
  }),
);

nativeSegmentKeyColumns = nativeSegments;

export const runRuntimeSpans = pgTable(
  "run_runtime_spans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").notNull().references(() => runtimeBindings.id, { onDelete: "cascade" }),
    segmentId: uuid("segment_id").notNull().references(() => nativeSegments.id, { onDelete: "restrict" }),
    attemptId: uuid("attempt_id").references(() => heartbeatRunAttempts.id, { onDelete: "set null" }),
    attemptRef: text("attempt_ref").notNull(),
    attemptEpoch: integer("attempt_epoch").notNull().default(1),
    ownerToken: text("owner_token").notNull(),
    ordinal: integer("ordinal").notNull().default(0),
    relation: text("relation").$type<"primary" | "continuation" | "native_subagent">().notNull().default("primary"),
    nativeExecutionRef: text("native_execution_ref"),
    inputCorrelationRef: text("input_correlation_ref"),
    selectorJson: jsonb("selector_json").$type<Record<string, unknown>>().notNull().default({}),
    sourceRevision: text("source_revision"),
    state: text("state").$type<"open" | "sealed" | "unresolved">().notNull().default("open"),
    completeness: text("completeness").$type<"complete" | "partial" | "terminal_only" | "unknown">().notNull().default("unknown"),
    visibilityCutoffRef: text("visibility_cutoff_ref"),
    supplementalObjectRef: text("supplemental_object_ref"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgRunOrdinalUnique: uniqueIndex("run_runtime_spans_org_run_ordinal_uq").on(table.orgId, table.runId, table.ordinal),
    orgRunIdx: index("run_runtime_spans_org_run_idx").on(table.orgId, table.runId, table.openedAt),
    bindingSegmentIdx: index("run_runtime_spans_binding_segment_idx").on(table.bindingId, table.segmentId, table.openedAt),
    openSpanIdx: index("run_runtime_spans_open_idx").on(table.state, table.updatedAt),
    attemptEpochCheck: check(
      "run_runtime_spans_attempt_epoch_check",
      sql`${table.attemptEpoch} > 0`,
    ),
    ordinalCheck: check(
      "run_runtime_spans_ordinal_check",
      sql`${table.ordinal} >= 0`,
    ),
    relationCheck: check(
      "run_runtime_spans_relation_check",
      sql`${table.relation} in ('primary', 'continuation', 'native_subagent')`,
    ),
    stateCheck: check(
      "run_runtime_spans_state_check",
      sql`${table.state} in ('open', 'sealed', 'unresolved')`,
    ),
    completenessCheck: check(
      "run_runtime_spans_completeness_check",
      sql`${table.completeness} in ('complete', 'partial', 'terminal_only', 'unknown')`,
    ),
    closedLifecycleCheck: check(
      "run_runtime_spans_closed_lifecycle_check",
      sql`(
        (${table.state} = 'open' and ${table.closedAt} is null)
        or (${table.state} in ('sealed', 'unresolved') and ${table.closedAt} is not null)
      )`,
    ),
    closedAfterOpenCheck: check(
      "run_runtime_spans_closed_after_open_check",
      sql`${table.closedAt} is null or ${table.closedAt} >= ${table.openedAt}`,
    ),
    orgRunFk: foreignKey({
      name: "run_runtime_spans_org_run_fk",
      columns: [table.orgId, table.runId],
      foreignColumns: [heartbeatRuns.orgId, heartbeatRuns.id],
    }).onDelete("cascade"),
    orgBindingFk: foreignKey({
      name: "run_runtime_spans_org_binding_fk",
      columns: [table.orgId, table.bindingId],
      foreignColumns: [runtimeBindings.orgId, runtimeBindings.id],
    }).onDelete("cascade"),
    orgSegmentFk: foreignKey({
      name: "run_runtime_spans_org_segment_fk",
      columns: [table.orgId, table.segmentId],
      foreignColumns: [nativeSegments.orgId, nativeSegments.id],
    }).onDelete("restrict"),
    orgAttemptFk: foreignKey({
      name: "run_runtime_spans_org_attempt_fk",
      columns: [table.orgId, table.attemptId],
      foreignColumns: [heartbeatRunAttempts.orgId, heartbeatRunAttempts.id],
    }).onDelete("no action"),
    bindingSegmentFk: foreignKey({
      name: "run_runtime_spans_binding_segment_fk",
      columns: [table.orgId, table.bindingId, table.segmentId],
      foreignColumns: [nativeSegments.orgId, nativeSegments.bindingId, nativeSegments.id],
    }).onDelete("no action"),
    runAttemptFk: foreignKey({
      name: "run_runtime_spans_run_attempt_fk",
      columns: [table.orgId, table.runId, table.attemptId],
      foreignColumns: [heartbeatRunAttempts.orgId, heartbeatRunAttempts.runId, heartbeatRunAttempts.id],
    }).onDelete("no action"),
  }),
);
