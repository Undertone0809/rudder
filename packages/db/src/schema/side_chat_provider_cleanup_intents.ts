import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export type SideChatProviderCleanupState =
  | "pending"
  | "claimed"
  | "retry_wait"
  | "review_required"
  | "completed";

export type SideChatProviderCleanupProtectionRefs = {
  version: 1;
  bindingIds: string[];
  segmentIds: string[];
  conversationIds: string[];
  runIds: string[];
  providerSessionIds: string[];
  retentionResourceRefs: string[];
  sourceAliasRefs: string[];
};

/** Durable snapshot of one Side Chat-owned provider fork, independent of chat FKs. */
export const sideChatProviderCleanupIntents = pgTable(
  "side_chat_provider_cleanup_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    principalScopeRef: text("principal_scope_ref").notNull(),
    bindingId: uuid("binding_id").notNull(),
    bindingEpoch: integer("binding_epoch").notNull(),
    segmentId: uuid("segment_id").notNull(),
    forkRunId: uuid("fork_run_id"),
    agentId: uuid("agent_id").notNull(),
    runtimeType: text("runtime_type").notNull(),
    hostId: text("host_id").notNull(),
    profileId: text("profile_id").notNull(),
    workspaceBindingId: text("workspace_binding_id"),
    capabilityRevision: text("capability_revision"),
    parentBindingId: uuid("parent_binding_id"),
    parentSessionId: text("parent_session_id"),
    sourceBoundaryRef: text("source_boundary_ref"),
    nativeSessionId: text("native_session_id").notNull(),
    sessionParamsJson: jsonb("session_params_json").$type<Record<string, unknown>>().notNull().default({}),
    protectionRefsJson: jsonb("protection_refs_json")
      .$type<SideChatProviderCleanupProtectionRefs>()
      .notNull()
      .default({
        version: 1,
        bindingIds: [],
        segmentIds: [],
        conversationIds: [],
        runIds: [],
        providerSessionIds: [],
        retentionResourceRefs: [],
        sourceAliasRefs: [],
      }),
    profileSnapshotJson: jsonb("profile_snapshot_json").$type<Record<string, unknown>>().notNull().default({}),
    state: text("state").$type<SideChatProviderCleanupState>().notNull().default("pending"),
    stateReason: text("state_reason"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    leaseOwner: text("lease_owner"),
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resourceUnique: uniqueIndex("side_chat_provider_cleanup_resource_uq").on(
      table.orgId,
      table.conversationId,
      table.bindingId,
      table.bindingEpoch,
      table.segmentId,
      table.nativeSessionId,
    ),
    claimIdx: index("side_chat_provider_cleanup_claim_idx").on(
      table.state,
      table.nextAttemptAt,
      table.leaseExpiresAt,
      table.createdAt,
    ),
    scopeIdx: index("side_chat_provider_cleanup_scope_idx").on(
      table.orgId,
      table.runtimeType,
      table.hostId,
      table.profileId,
      table.nativeSessionId,
    ),
    stateCheck: check(
      "side_chat_provider_cleanup_state_check",
      sql`${table.state} in ('pending', 'claimed', 'retry_wait', 'review_required', 'completed')`,
    ),
    identityCheck: check(
      "side_chat_provider_cleanup_identity_check",
      sql`${table.bindingEpoch} >= 0 and ${table.leaseEpoch} >= 0 and ${table.attemptCount} >= 0
        and btrim(${table.principalScopeRef}) <> ''
        and btrim(${table.runtimeType}) <> ''
        and btrim(${table.hostId}) <> ''
        and btrim(${table.profileId}) <> ''
        and btrim(${table.nativeSessionId}) <> ''`,
    ),
    leaseCheck: check(
      "side_chat_provider_cleanup_lease_check",
      sql`(
        (${table.state} = 'claimed' and ${table.leaseOwner} is not null and btrim(${table.leaseOwner}) <> '' and ${table.leaseExpiresAt} is not null)
        or
        (${table.state} <> 'claimed' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)
      )`,
    ),
    completionCheck: check(
      "side_chat_provider_cleanup_completion_check",
      sql`(${table.state} = 'completed') = (${table.completedAt} is not null)`,
    ),
  }),
);
