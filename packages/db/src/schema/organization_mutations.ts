import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { activityLog } from "./activity_log.js";
import { organizations } from "./organizations.js";

/** Private D1 state. Missing state and the default owner both keep Node authoritative. */
export const organizationMutationState = pgTable(
  "organization_mutation_state",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    mutationVersion: bigint("mutation_version", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    fenceEpoch: bigint("fence_epoch", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    fenceToken: uuid("fence_token")
      .notNull()
      .default(sql`gen_random_uuid()`),
    owner: text("owner").$type<"node" | "rust">().notNull().default("node"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    versionCheck: check(
      "organization_mutation_state_version_ck",
      sql`${table.mutationVersion} >= 0`,
    ),
    fenceCheck: check(
      "organization_mutation_state_fence_ck",
      sql`${table.fenceEpoch} >= 0`,
    ),
    ownerCheck: check(
      "organization_mutation_state_owner_ck",
      sql`${table.owner} in ('node', 'rust') and (${table.owner} = 'node' or ${table.fenceEpoch} > 0)`,
    ),
  }),
);

/** Original committed outcomes, never a current-state cache or second writer. */
export const organizationMutationReceipts = pgTable(
  "organization_mutation_receipts",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationMutationState.orgId, {
        onDelete: "cascade",
      }),
    idempotencyKey: text("idempotency_key").notNull(),
    commandKind: text("command_kind")
      .$type<
        | "organization_branding"
        | "organization_settings"
        | "project_goal_link"
        | "project_goal_set_replacement"
      >()
      .notNull(),
    commandFingerprint: text("command_fingerprint").notNull(),
    receiptFormat: integer("receipt_format").notNull().default(1),
    outcome: text("outcome").$type<"applied" | "noop">().notNull(),
    resultingVersion: bigint("resulting_version", { mode: "bigint" }).notNull(),
    fenceEpoch: bigint("fence_epoch", { mode: "bigint" }).notNull(),
    activityId: uuid("activity_id").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.idempotencyKey] }),
    activityUnique: unique("organization_mutation_receipts_activity_uq").on(
      table.activityId,
    ),
    // The existing Node delete path removes activity before the organization.
    activityFk: foreignKey({
      name: "organization_mutation_receipts_activity_fk",
      columns: [table.orgId, table.activityId],
      foreignColumns: [activityLog.orgId, activityLog.id],
    }).onDelete("no action"),
    keyCheck: check(
      "organization_mutation_receipts_key_ck",
      sql`octet_length(${table.idempotencyKey}) between 1 and 256`,
    ),
    fingerprintCheck: check(
      "organization_mutation_receipts_fingerprint_ck",
      sql`${table.commandFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    kindCheck: check(
      "organization_mutation_receipts_kind_ck",
      sql`${table.commandKind} in ('organization_branding', 'organization_settings', 'project_goal_link', 'project_goal_set_replacement')`,
    ),
    outcomeCheck: check(
      "organization_mutation_receipts_outcome_ck",
      sql`${table.outcome} in ('applied', 'noop')`,
    ),
    versionCheck: check(
      "organization_mutation_receipts_version_ck",
      sql`${table.resultingVersion} >= 0 and ${table.fenceEpoch} >= 0 and ${table.receiptFormat} > 0`,
    ),
    resultCheck: check(
      "organization_mutation_receipts_result_ck",
      sql`coalesce(
        jsonb_typeof(${table.result}) = 'object'
        and ${table.result}->>'organization_id' = ${table.orgId}::text
        and ${table.result}->>'version' = ${table.resultingVersion}::text
        and ${table.result}->>'fence_epoch' = ${table.fenceEpoch}::text, false)`,
    ),
  }),
);

export type OrganizationMutationIntentSourceKind = "chat_lightweight" | "chat_approval";
export type OrganizationMutationIntentPhase =
  | "pending"
  | "claimed"
  | "rust_committed"
  | "downstream_pending"
  | "effects_claimed"
  | "completed"
  | "rejected"
  | "cancelled"
  | "failed";

export type OrganizationSettingsPatch = Partial<{
  name: string;
  description: string | null;
  status: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  defaultChatIssueCreationMode: string;
  requireBoardApprovalForNewAgents: boolean;
  issuePrefix: string;
  brandColor: string | null;
  logoAssetId: string | null;
}>;

/**
 * Transitional Chat coordinator input. The source and patch columns are
 * immutable; only lease, retry, Rust receipt, and downstream progress fields
 * may advance after insertion. Rust consumes this row inside its settings
 * transaction and must use the same source -> intent -> organization lock
 * order as Node's reject/revision/edit writers.
 */
export const organizationMutationIntents = pgTable(
  "organization_mutation_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    commandKind: text("command_kind")
      .$type<"organization_settings">()
      .notNull()
      .default("organization_settings"),
    sourceKind: text("source_kind").$type<OrganizationMutationIntentSourceKind>().notNull(),
    sourceId: uuid("source_id").notNull(),
    // These are immutable source identities, not ownership references. Chat
    // cleanup must be able to prune source rows while recovery retains the
    // patch and actor context needed to finish the intent.
    approvalId: uuid("approval_id"),
    conversationId: uuid("conversation_id").notNull(),
    proposalMessageId: uuid("proposal_message_id"),
    actorUserId: text("actor_user_id"),
    actorPrincipal: text("actor_principal").notNull(),
    decidedByUserId: text("decided_by_user_id"),
    decisionNote: text("decision_note"),
    generation: bigint("generation", { mode: "bigint" }).notNull(),
    patch: jsonb("patch").$type<OrganizationSettingsPatch>().notNull(),
    patchFingerprint: text("patch_fingerprint").notNull(),
    intentFingerprint: text("intent_fingerprint").notNull(),
    rustIdempotencyKey: text("rust_idempotency_key").notNull(),
    phase: text("phase")
      .$type<OrganizationMutationIntentPhase>()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimToken: uuid("claim_token"),
    claimOwner: text("claim_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    rustReceipt: jsonb("rust_receipt").$type<Record<string, unknown>>(),
    rustCommittedAt: timestamp("rust_committed_at", { withTimezone: true }),
    downstreamTargets: jsonb("downstream_targets")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    downstreamProgress: jsonb("downstream_progress")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    downstreamAttempts: integer("downstream_attempts").notNull().default(0),
    downstreamNextAttemptAt: timestamp("downstream_next_attempt_at", { withTimezone: true }),
    downstreamClaimToken: uuid("downstream_claim_token"),
    downstreamClaimOwner: text("downstream_claim_owner"),
    downstreamLeaseExpiresAt: timestamp("downstream_lease_expires_at", { withTimezone: true }),
    downstreamCompletedAt: timestamp("downstream_completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stableKeyUq: unique("organization_mutation_intents_org_key_uq").on(
      table.orgId,
      table.rustIdempotencyKey,
    ),
    sourceGenerationUq: unique("organization_mutation_intents_source_generation_uq").on(
      table.orgId,
      table.sourceKind,
      table.sourceId,
      table.generation,
    ),
    claimIdx: index("organization_mutation_intents_claim_idx").on(
      table.phase,
      table.nextAttemptAt,
      table.createdAt,
    ),
    leaseIdx: index("organization_mutation_intents_lease_idx").on(
      table.phase,
      table.leaseExpiresAt,
      table.nextAttemptAt,
      table.createdAt,
    ),
    downstreamClaimIdx: index("organization_mutation_intents_downstream_claim_idx").on(
      table.phase,
      table.downstreamNextAttemptAt,
      table.createdAt,
    ),
    approvalGenerationIdx: index("organization_mutation_intents_approval_generation_idx").on(
      table.orgId,
      table.approvalId,
      table.generation,
    ),
    kindCheck: check(
      "organization_mutation_intents_kind_ck",
      sql`${table.commandKind} = 'organization_settings'`,
    ),
    sourceKindCheck: check(
      "organization_mutation_intents_source_kind_ck",
      sql`${table.sourceKind} in ('chat_lightweight', 'chat_approval')`,
    ),
    sourceShapeCheck: check(
      "organization_mutation_intents_source_shape_ck",
      sql`(
        (${table.sourceKind} = 'chat_lightweight'
          and ${table.approvalId} is null
          and ${table.proposalMessageId} is not null
          and ${table.sourceId} = ${table.proposalMessageId})
        or
        (${table.sourceKind} = 'chat_approval'
          and ${table.approvalId} is not null
          and ${table.sourceId} = ${table.approvalId})
      )`,
    ),
    phaseCheck: check(
      "organization_mutation_intents_phase_ck",
      sql`${table.phase} in ('pending', 'claimed', 'rust_committed', 'downstream_pending', 'effects_claimed', 'completed', 'rejected', 'cancelled', 'failed')`,
    ),
    claimCheck: check(
      "organization_mutation_intents_claim_ck",
      sql`(${table.phase} = 'claimed'
        and ${table.claimToken} is not null
        and ${table.claimOwner} is not null
        and ${table.leaseExpiresAt} is not null)
      or (${table.phase} <> 'claimed'
        and ${table.claimToken} is null
        and ${table.claimOwner} is null
        and ${table.leaseExpiresAt} is null)`,
    ),
    downstreamClaimCheck: check(
      "organization_mutation_intents_downstream_claim_ck",
      sql`(${table.phase} = 'effects_claimed'
        and ${table.downstreamClaimToken} is not null
        and ${table.downstreamClaimOwner} is not null
        and ${table.downstreamLeaseExpiresAt} is not null)
      or (${table.phase} <> 'effects_claimed'
        and ${table.downstreamClaimToken} is null
        and ${table.downstreamClaimOwner} is null
        and ${table.downstreamLeaseExpiresAt} is null)`,
    ),
    counterCheck: check(
      "organization_mutation_intents_counter_ck",
      sql`${table.generation} >= 1 and ${table.attempts} >= 0 and ${table.downstreamAttempts} >= 0`,
    ),
    patchCheck: check(
      "organization_mutation_intents_patch_ck",
      sql`jsonb_typeof(${table.patch}) = 'object' and ${table.patch} <> '{}'::jsonb`,
    ),
    fingerprintCheck: check(
      "organization_mutation_intents_fingerprint_ck",
      sql`${table.patchFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    intentFingerprintCheck: check(
      "organization_mutation_intents_intent_fingerprint_ck",
      sql`${table.intentFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    keyCheck: check(
      "organization_mutation_intents_key_ck",
      sql`octet_length(${table.rustIdempotencyKey}) between 1 and 256`,
    ),
    actorCheck: check(
      "organization_mutation_intents_actor_ck",
      sql`octet_length(btrim(${table.actorPrincipal})) between 1 and 256
        and (${table.actorUserId} is null or octet_length(btrim(${table.actorUserId})) between 1 and 256)
        and (${table.decidedByUserId} is null or octet_length(btrim(${table.decidedByUserId})) between 1 and 256)`,
    ),
    postRustCheck: check(
      "organization_mutation_intents_post_rust_ck",
      sql`(${table.phase} not in ('rust_committed', 'downstream_pending', 'effects_claimed', 'completed')
        or (${table.rustReceipt} is not null and ${table.rustCommittedAt} is not null))
        and (${table.phase} <> 'completed' or ${table.downstreamCompletedAt} is not null)`,
    ),
    targetsCheck: check(
      "organization_mutation_intents_targets_ck",
      sql`jsonb_typeof(${table.downstreamTargets}) = 'object'`,
    ),
    progressCheck: check(
      "organization_mutation_intents_progress_ck",
      sql`jsonb_typeof(${table.downstreamProgress}) = 'object'`,
    ),
  }),
);
