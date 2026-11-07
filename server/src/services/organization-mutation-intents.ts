import type { Db } from "@rudderhq/db";
import {
  approvals,
  chatConversations,
  chatMessages,
  organizationMutationIntents,
  type OrganizationMutationIntentPhase,
  type OrganizationMutationIntentSourceKind,
  type OrganizationSettingsPatch,
} from "@rudderhq/db";
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { conflict, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { lockNodeMutationAuthority } from "./organization-mutation-fence.js";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_BATCH_SIZE = 25;
const MAX_ERROR_LENGTH = 2_000;
const POST_RUST_PHASES: OrganizationMutationIntentPhase[] = [
  "rust_committed",
  "downstream_pending",
  "effects_claimed",
  "completed",
];
const RETRYABLE_PHASES: OrganizationMutationIntentPhase[] = ["pending", "failed"];
const SUPPORTED_PATCH_KEYS = new Set([
  "name",
  "description",
  "status",
  "budgetMonthlyCents",
  "spentMonthlyCents",
  "defaultChatIssueCreationMode",
  "requireBoardApprovalForNewAgents",
  "issuePrefix",
  "brandColor",
  "logoAssetId",
]);

const RUST_PATCH_KEYS = [
  "name",
  "description",
  "status",
  "budgetMonthlyCents",
  "spentMonthlyCents",
  "defaultChatIssueCreationMode",
  "requireBoardApprovalForNewAgents",
  "issuePrefix",
  "brandColor",
  "logoAssetId",
] as const;

type TransactionDb = Parameters<Parameters<Db["transaction"]>[0]>[0];
type IntentRow = typeof organizationMutationIntents.$inferSelect;
export type OrganizationMutationIntentRow = IntentRow;

export type OrganizationSettingsIntentSource = {
  kind: OrganizationMutationIntentSourceKind;
  sourceId: string;
  approvalId: string | null;
  conversationId: string;
  proposalMessageId: string | null;
};

export type OrganizationSettingsIntentInput = {
  orgId: string;
  source: OrganizationSettingsIntentSource;
  actorUserId: string | null;
  actorPrincipal: string;
  decidedByUserId: string | null;
  decisionNote: string | null;
  generation: bigint | number | string;
  patch: OrganizationSettingsPatch;
  rustIdempotencyKey?: string;
  patchFingerprint?: string;
  intentFingerprint?: string;
  downstreamTargets?: Record<string, unknown>;
};

export type OrganizationSettingsRustContext = {
  intentId: string;
  orgId: string;
  source: OrganizationSettingsIntentSource;
  actorUserId: string | null;
  actorPrincipal: string;
  decidedByUserId: string | null;
  decisionNote: string | null;
  generation: bigint;
  patch: OrganizationSettingsPatch;
  patchFingerprint: string;
  intentFingerprint: string;
  rustIdempotencyKey: string;
  claimToken: string;
};

export type OrganizationSettingsRustExecutor = (
  context: OrganizationSettingsRustContext,
) => Promise<Record<string, unknown>>;

export type OrganizationMutationIntentStep = (
  tx: TransactionDb,
) => Promise<void>;

export type OrganizationMutationIntentCallbacks = {
  beforeRust?: (context: OrganizationSettingsRustContext) => Promise<void>;
  applyEffects: (context: {
    intent: IntentRow;
    runStep: (
      name: string,
      target: string,
      action: OrganizationMutationIntentStep,
    ) => Promise<void>;
  }) => Promise<void>;
};

function proposalDecisionStatus(payload: unknown): "pending" | "approved" | "rejected" | "revision_requested" {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "pending";
  const state = (payload as Record<string, unknown>).operationProposalState;
  if (!state || typeof state !== "object" || Array.isArray(state)) return "pending";
  const status = (state as Record<string, unknown>).status;
  return status === "approved" || status === "rejected" || status === "revision_requested"
    ? status
    : "pending";
}

export type OrganizationMutationIntentCoordinatorOptions = {
  executor?: OrganizationSettingsRustExecutor;
  resolveCallbacks?: (intent: IntentRow) => OrganizationMutationIntentCallbacks | null;
  workerId?: string;
  leaseMs?: number;
  batchSize?: number;
};

export type OrganizationMutationIntentRunResult = {
  status: "completed" | "in_progress" | "replayed";
  intent: IntentRow;
};

type ClaimResult =
  | { kind: "claimed"; intent: IntentRow }
  | { kind: "busy"; intent: IntentRow }
  | { kind: "replay"; intent: IntentRow };

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function invalidIntent(message: string): never {
  throw conflict(message, { code: "InvalidIntent" });
}

function invalidReceipt(message: string): never {
  throw conflict(message, { code: "InvalidReceipt" });
}

function digestRustJson(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function rustGeneration(value: bigint | number | string) {
  const generation = BigInt(value);
  if (generation > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw unprocessable("Organization mutation intent generation is too large");
  }
  return Number(generation);
}

function rustPatchPayload(patch: OrganizationSettingsPatch) {
  const serialized: Record<string, unknown> = {};
  for (const key of RUST_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) {
      serialized[key] = patch[key];
    }
  }
  return serialized;
}

export function organizationSettingsPatchFingerprint(patch: OrganizationSettingsPatch) {
  return digestRustJson(rustPatchPayload(patch));
}

export function organizationSettingsIntentFingerprint(input: {
  orgId: string;
  source: OrganizationSettingsIntentSource;
  actorUserId: string | null;
  actorPrincipal: string;
  decidedByUserId: string | null;
  decisionNote: string | null;
  generation: bigint | number | string;
  patchFingerprint: string;
  rustIdempotencyKey: string;
}) {
  // Keep this byte-for-byte aligned with OrganizationSettingsCommand's Rust
  // intent_fingerprint(). Lease tokens and display decision metadata are
  // intentionally excluded because they are mutable or downstream-only.
  return digestRustJson({
    schema: "rudder.organization-settings-intent.v1",
    organization_id: input.orgId,
    source_kind: input.source.kind,
    source_id: input.source.sourceId,
    approval_id: input.source.approvalId,
    conversation_id: input.source.conversationId,
    proposal_message_id: input.source.proposalMessageId,
    actor_user_id: input.actorUserId,
    actor_principal: input.actorPrincipal,
    generation: rustGeneration(input.generation),
    patch_fingerprint: input.patchFingerprint,
    rust_idempotency_key: input.rustIdempotencyKey,
  });
}

function validatePatch(patch: OrganizationSettingsPatch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw unprocessable("Organization settings intent patch must be an object");
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw unprocessable("Organization settings intent patch must not be empty");
  }
  const unsupported = keys.find((key) => !SUPPORTED_PATCH_KEYS.has(key));
  if (unsupported) {
    throw unprocessable(`Unsupported organization settings patch field: ${unsupported}`);
  }
}

function normalizePatch(patch: OrganizationSettingsPatch): OrganizationSettingsPatch {
  validatePatch(patch);
  const normalized: OrganizationSettingsPatch = {};
  for (const key of RUST_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) {
      (normalized as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
    }
  }
  if (normalized.issuePrefix !== undefined) {
    const issuePrefix = normalized.issuePrefix.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,11}$/.test(issuePrefix)) {
      throw unprocessable("Issue key must start with a letter and contain only letters and numbers");
    }
    normalized.issuePrefix = issuePrefix;
  }
  return normalized;
}

function normalizeGeneration(value: bigint | number | string) {
  try {
    const generation = BigInt(value);
    if (generation < 1n) throw new Error("generation must be positive");
    return generation;
  } catch {
    throw unprocessable("Organization mutation intent generation is invalid");
  }
}

function normalizeInput(input: OrganizationSettingsIntentInput) {
  if (input.source.kind === "chat_lightweight") {
    if (
      input.source.approvalId !== null
      || !input.source.proposalMessageId
      || input.source.sourceId !== input.source.proposalMessageId
    ) {
      invalidIntent("Lightweight organization mutation source must be its proposal message");
    }
  } else if (!input.source.approvalId || input.source.sourceId !== input.source.approvalId) {
    invalidIntent("Approval organization mutation source must be its approval");
  }
  const patch = normalizePatch(input.patch);
  const generation = normalizeGeneration(input.generation);
  const computedPatchFingerprint = organizationSettingsPatchFingerprint(patch);
  if (input.patchFingerprint && input.patchFingerprint !== computedPatchFingerprint) {
    invalidIntent("Organization mutation patch fingerprint does not match its patch");
  }
  const patchFingerprint = computedPatchFingerprint;
  const rustIdempotencyKey = input.rustIdempotencyKey
    ?? `organization-settings:${input.source.kind}:${input.source.sourceId}:${generation.toString()}`;
  const computedIntentFingerprint = organizationSettingsIntentFingerprint({
    orgId: input.orgId,
    source: input.source,
    actorUserId: input.actorUserId,
    actorPrincipal: input.actorPrincipal,
    decidedByUserId: input.decidedByUserId,
    decisionNote: input.decisionNote,
    generation,
    patchFingerprint,
    rustIdempotencyKey,
  });
  if (input.intentFingerprint && input.intentFingerprint !== computedIntentFingerprint) {
    invalidIntent("Organization mutation intent fingerprint does not match its immutable identity");
  }
  const intentFingerprint = computedIntentFingerprint;
  return {
    ...input,
    patch,
    generation,
    patchFingerprint,
    intentFingerprint,
    rustIdempotencyKey,
    downstreamTargets: input.downstreamTargets ?? {
      approvalId: input.source.approvalId,
      conversationId: input.source.conversationId,
      proposalMessageId: input.source.proposalMessageId,
    },
  };
}

function sourceMatchesIntent(intent: IntentRow, input: ReturnType<typeof normalizeInput>) {
  return intent.orgId === input.orgId
    && intent.commandKind === "organization_settings"
    && intent.sourceKind === input.source.kind
    && intent.sourceId === input.source.sourceId
    && intent.approvalId === input.source.approvalId
    && intent.conversationId === input.source.conversationId
    && intent.proposalMessageId === input.source.proposalMessageId
    && intent.generation === input.generation
    && intent.patchFingerprint === input.patchFingerprint
    && intent.intentFingerprint === input.intentFingerprint
    && intent.rustIdempotencyKey === input.rustIdempotencyKey;
}

async function lockSourceRows(
  tx: TransactionDb,
  input: ReturnType<typeof normalizeInput>,
): Promise<{
  approvalPresent: boolean;
  approvalStatus: string | null;
  messagePresent: boolean;
  messageApprovalId: string | null;
  messageDecisionStatus: "pending" | "approved" | "rejected" | "revision_requested" | null;
}> {
  let approvalPresent = true;
  let approvalStatus: string | null = null;
  let messagePresent = true;
  let messageApprovalId: string | null = null;
  let messageDecisionStatus: "pending" | "approved" | "rejected" | "revision_requested" | null = null;

  if (input.source.kind === "chat_approval") {
    const approval = await tx
      .select({ id: approvals.id, orgId: approvals.orgId, type: approvals.type, status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, input.source.approvalId ?? input.source.sourceId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    approvalPresent = Boolean(approval);
    approvalStatus = approval?.status ?? null;
    if (approval && (approval.orgId !== input.orgId || approval.type !== "chat_operation")) {
      invalidIntent("Organization mutation approval source is outside its organization or has the wrong type");
    }
  }

  if (input.source.proposalMessageId) {
    const message = await tx
      .select({
        id: chatMessages.id,
        orgId: chatMessages.orgId,
        conversationId: chatMessages.conversationId,
        approvalId: chatMessages.approvalId,
        kind: chatMessages.kind,
        structuredPayload: chatMessages.structuredPayload,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, input.source.proposalMessageId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    messagePresent = Boolean(message);
    messageApprovalId = message?.approvalId ?? null;
    messageDecisionStatus = message ? proposalDecisionStatus(message.structuredPayload) : null;
    if (message) {
      if (
        message.orgId !== input.orgId
        || message.conversationId !== input.source.conversationId
        || message.kind !== "operation_proposal"
        || (
          input.source.kind === "chat_lightweight"
            ? message.approvalId !== null
            : message.approvalId !== input.source.approvalId && message.approvalId !== null
        )
      ) {
        invalidIntent("Organization mutation proposal message is outside its conversation or has invalid linkage");
      }
    }
  }

  return { approvalPresent, approvalStatus, messagePresent, messageApprovalId, messageDecisionStatus };
}

async function lockConversationRow(
  tx: TransactionDb,
  input: ReturnType<typeof normalizeInput>,
) {
  const conversation = await tx
    .select({ id: chatConversations.id, orgId: chatConversations.orgId })
    .from(chatConversations)
    .where(eq(chatConversations.id, input.source.conversationId))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (conversation && conversation.orgId !== input.orgId) {
    invalidIntent("Organization mutation conversation is outside its organization");
  }
  return Boolean(conversation);
}

async function conversationExists(
  tx: TransactionDb,
  input: ReturnType<typeof normalizeInput>,
) {
  const conversation = await tx
    .select({ id: chatConversations.id, orgId: chatConversations.orgId })
    .from(chatConversations)
    .where(eq(chatConversations.id, input.source.conversationId))
    .then((rows) => rows[0] ?? null);
  if (conversation && conversation.orgId !== input.orgId) {
    invalidIntent("Organization mutation conversation is outside its organization");
  }
  return Boolean(conversation);
}

async function findIntentForUpdate(
  tx: TransactionDb,
  input: ReturnType<typeof normalizeInput>,
) {
  return tx
    .select()
    .from(organizationMutationIntents)
    .where(and(
      eq(organizationMutationIntents.orgId, input.orgId),
      or(
        eq(organizationMutationIntents.rustIdempotencyKey, input.rustIdempotencyKey),
        and(
          eq(organizationMutationIntents.sourceKind, input.source.kind),
          eq(organizationMutationIntents.sourceId, input.source.sourceId),
          eq(organizationMutationIntents.generation, input.generation),
        ),
      ),
    ))
    .for("update")
    .then((rows) => rows[0] ?? null);
}

async function insertIntent(tx: TransactionDb, input: ReturnType<typeof normalizeInput>) {
  const [inserted] = await tx
    .insert(organizationMutationIntents)
    .values({
      orgId: input.orgId,
      commandKind: "organization_settings",
      sourceKind: input.source.kind,
      sourceId: input.source.sourceId,
      approvalId: input.source.approvalId,
      conversationId: input.source.conversationId,
      proposalMessageId: input.source.proposalMessageId,
      actorUserId: input.actorUserId,
      actorPrincipal: input.actorPrincipal,
      decidedByUserId: input.decidedByUserId,
      decisionNote: input.decisionNote,
      generation: input.generation,
      patch: input.patch,
      patchFingerprint: input.patchFingerprint,
      intentFingerprint: input.intentFingerprint,
      rustIdempotencyKey: input.rustIdempotencyKey,
      downstreamTargets: input.downstreamTargets,
    })
    .onConflictDoNothing()
    .returning();
  return inserted ?? null;
}

function isPostRust(intent: IntentRow) {
  return POST_RUST_PHASES.includes(intent.phase);
}

function isClaimExpired(intent: IntentRow, now: Date) {
  return intent.phase === "claimed"
    && (!intent.leaseExpiresAt || intent.leaseExpiresAt.getTime() <= now.getTime());
}

async function claimLockedIntent(
  tx: TransactionDb,
  intent: IntentRow,
  sourceRows: {
    approvalPresent: boolean;
    approvalStatus: string | null;
    messagePresent: boolean;
    messageApprovalId: string | null;
    messageDecisionStatus: "pending" | "approved" | "rejected" | "revision_requested" | null;
    conversationPresent: boolean;
  },
  workerId: string,
  leaseMs: number,
): Promise<ClaimResult> {
  const now = new Date();
  if (isPostRust(intent)) {
    if (!intent.rustReceipt || !intent.rustCommittedAt) {
      invalidReceipt("Post-Rust organization mutation intent has no durable receipt");
    }
    if (intent.phase === "completed" && !intent.downstreamCompletedAt) {
      invalidReceipt("Completed organization mutation intent has no downstream completion marker");
    }
    return { kind: "replay", intent };
  }

  if (intent.phase === "rejected" || intent.phase === "cancelled") {
    throw conflict("Organization mutation intent is terminal and cannot be accepted again");
  }

  const sourcesPresent = sourceRows.approvalPresent
    && sourceRows.messagePresent
    && sourceRows.conversationPresent;
  const expiredClaim = isClaimExpired(intent, now);
  if (intent.phase === "claimed" && !expiredClaim) {
    // A coordinator instance shares its worker id across concurrent HTTP
    // requests. An active claim is therefore busy even when it belongs to
    // this worker; only the request that acquired the claim may drive Rust.
    return { kind: "busy", intent };
  }
  if (RETRYABLE_PHASES.includes(intent.phase) && intent.nextAttemptAt.getTime() > now.getTime()) {
    return { kind: "busy", intent };
  }
  if (!sourcesPresent && intent.phase !== "claimed") {
    invalidIntent("Organization mutation source disappeared before its claim was persisted");
  }
  if (
    intent.sourceKind === "chat_approval"
    && intent.proposalMessageId
    && sourceRows.messagePresent
    && sourceRows.messageApprovalId === null
    && intent.phase !== "claimed"
  ) {
    invalidIntent("Organization approval proposal linkage disappeared before its claim was persisted");
  }
  if (
    intent.phase !== "claimed"
    && intent.sourceKind === "chat_approval"
    && sourceRows.approvalStatus
    && ![
      "pending",
      "revision_requested",
      // The approval state is committed before the Rust call. A process loss
      // after that point leaves a retryable failed intent with an approved
      // source; the immutable intent snapshot, not a fresh proposal, governs
      // the retry.
      ...(intent.phase === "failed" ? ["approved"] : []),
    ].includes(sourceRows.approvalStatus)
  ) {
    invalidIntent("Organization mutation approval is no longer pending");
  }
  if (
    intent.phase !== "claimed"
    && intent.sourceKind === "chat_lightweight"
    && sourceRows.messageDecisionStatus !== "pending"
  ) {
    invalidIntent("Organization mutation proposal is no longer pending");
  }

  await lockNodeMutationAuthority(tx, intent.orgId);
  const claimToken = randomUUID();
  const [claimed] = await tx
    .update(organizationMutationIntents)
    .set({
      phase: "claimed",
      attempts: intent.attempts + 1,
      claimToken,
      claimOwner: workerId,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
      lastError: null,
    })
    .where(eq(organizationMutationIntents.id, intent.id))
    .returning();
  if (!claimed) throw conflict("Organization mutation intent claim was lost");
  return { kind: "claimed", intent: claimed };
}

function rustContext(intent: IntentRow): OrganizationSettingsRustContext {
  if (!intent.claimToken) throw conflict("Organization mutation intent has no active claim token");
  return {
    intentId: intent.id,
    orgId: intent.orgId,
    source: {
      kind: intent.sourceKind,
      sourceId: intent.sourceId,
      approvalId: intent.approvalId,
      conversationId: intent.conversationId,
      proposalMessageId: intent.proposalMessageId,
    },
    actorUserId: intent.actorUserId,
    actorPrincipal: intent.actorPrincipal,
    decidedByUserId: intent.decidedByUserId,
    decisionNote: intent.decisionNote,
    generation: intent.generation,
    patch: intent.patch,
    patchFingerprint: intent.patchFingerprint,
    intentFingerprint: intent.intentFingerprint,
    rustIdempotencyKey: intent.rustIdempotencyKey,
    claimToken: intent.claimToken,
  };
}

async function markFailed(db: Db, intent: IntentRow, error: unknown) {
  if (!intent.claimToken) return;
  const retryMs = Math.min(60_000, Math.max(1_000, 2 ** Math.min(intent.attempts, 6) * 1_000));
  await db
    .update(organizationMutationIntents)
    .set({
      phase: "failed",
      claimToken: null,
      claimOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: new Date(Date.now() + retryMs),
      lastError: errorText(error),
      updatedAt: new Date(),
    })
    .where(and(
      eq(organizationMutationIntents.id, intent.id),
      eq(organizationMutationIntents.phase, "claimed"),
      eq(organizationMutationIntents.claimToken, intent.claimToken),
    ));
}

async function markRustCommitted(db: Db, intent: IntentRow, receipt: Record<string, unknown>) {
  if (!intent.claimToken) throw conflict("Organization mutation intent has no active claim token");
  const claimToken = intent.claimToken;
  return db.transaction(async (tx) => {
    const [committed] = await tx
      .update(organizationMutationIntents)
      .set({
        phase: "downstream_pending",
        rustReceipt: receipt,
        rustCommittedAt: new Date(),
        downstreamNextAttemptAt: new Date(),
        claimToken: null,
        claimOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(organizationMutationIntents.id, intent.id),
        eq(organizationMutationIntents.phase, "claimed"),
        eq(organizationMutationIntents.claimToken, claimToken),
      ))
      .returning();
    if (committed) return committed;

    // Rust persists the receipt and clears the claim in the same business
    // transaction. A lost HTTP response must therefore advance that durable
    // state instead of treating the already-committed mutation as stale.
    const durable = await tx
      .select()
      .from(organizationMutationIntents)
      .where(eq(organizationMutationIntents.id, intent.id))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!durable) throw conflict("Organization mutation intent disappeared before receipt recovery");
    if (durable.phase === "rust_committed") {
      if (!durable.rustReceipt || !durable.rustCommittedAt) {
        invalidReceipt("Rust committed organization mutation has no durable receipt");
      }
      if (!sameJson(durable.rustReceipt, receipt)) {
        invalidReceipt("Rust organization mutation receipt does not match the durable receipt");
      }
      const [advanced] = await tx
        .update(organizationMutationIntents)
        .set({
          phase: "downstream_pending",
          downstreamNextAttemptAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(organizationMutationIntents.id, intent.id),
          eq(organizationMutationIntents.phase, "rust_committed"),
        ))
        .returning();
      return advanced ?? durable;
    }
    if (isPostRust(durable) && durable.rustReceipt && durable.rustCommittedAt) {
      if (!sameJson(durable.rustReceipt, receipt)) {
        invalidReceipt("Rust organization mutation receipt does not match the durable receipt");
      }
      return durable;
    }
    throw conflict("Organization mutation intent claim became stale before receipt commit");
  });
}

async function renewClaim(db: Db, intent: IntentRow, leaseMs: number) {
  if (!intent.claimToken) return false;
  const [renewed] = await db
    .update(organizationMutationIntents)
    .set({
      leaseExpiresAt: new Date(Date.now() + leaseMs),
      updatedAt: new Date(),
    })
    .where(and(
      eq(organizationMutationIntents.id, intent.id),
      eq(organizationMutationIntents.phase, "claimed"),
      eq(organizationMutationIntents.claimToken, intent.claimToken),
    ))
    .returning({ id: organizationMutationIntents.id });
  return Boolean(renewed);
}

async function claimDownstream(db: Db, intentId: string, workerId: string, leaseMs: number) {
  return db.transaction(async (tx) => {
    const intent = await tx
      .select()
      .from(organizationMutationIntents)
      .where(eq(organizationMutationIntents.id, intentId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!intent) throw conflict("Organization mutation intent not found");
    if (!intent.rustReceipt || !intent.rustCommittedAt) invalidReceipt("Organization mutation has no Rust receipt");
    if (intent.phase === "completed") return { kind: "completed" as const, intent };
    const now = new Date();
    if (
      intent.phase === "effects_claimed"
      && intent.downstreamLeaseExpiresAt
      && intent.downstreamLeaseExpiresAt.getTime() > now.getTime()
    ) {
      return { kind: "busy" as const, intent };
    }
    if (
      intent.phase === "downstream_pending"
      && intent.downstreamNextAttemptAt
      && intent.downstreamNextAttemptAt.getTime() > now.getTime()
    ) {
      return { kind: "busy" as const, intent };
    }
    if (intent.phase !== "downstream_pending" && intent.phase !== "effects_claimed" && intent.phase !== "rust_committed") {
      throw conflict(`Organization mutation intent cannot run downstream effects from phase ${intent.phase}`);
    }
    const downstreamClaimToken = randomUUID();
    const [claimed] = await tx
      .update(organizationMutationIntents)
      .set({
        phase: "effects_claimed",
        downstreamAttempts: intent.downstreamAttempts + 1,
        downstreamClaimToken,
        downstreamClaimOwner: workerId,
        downstreamLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        downstreamNextAttemptAt: null,
        updatedAt: now,
      })
      .where(eq(organizationMutationIntents.id, intent.id))
      .returning();
    if (!claimed) throw conflict("Organization downstream claim was lost");
    return { kind: "claimed" as const, intent: claimed };
  });
}

async function markDownstreamFailed(db: Db, intent: IntentRow, error: unknown) {
  if (!intent.downstreamClaimToken) return;
  const retryMs = Math.min(60_000, Math.max(1_000, 2 ** Math.min(intent.downstreamAttempts, 6) * 1_000));
  await db
    .update(organizationMutationIntents)
    .set({
      phase: "downstream_pending",
      downstreamClaimToken: null,
      downstreamClaimOwner: null,
      downstreamLeaseExpiresAt: null,
      downstreamNextAttemptAt: new Date(Date.now() + retryMs),
      lastError: errorText(error),
      updatedAt: new Date(),
    })
    .where(and(
      eq(organizationMutationIntents.id, intent.id),
      eq(organizationMutationIntents.phase, "effects_claimed"),
      eq(organizationMutationIntents.downstreamClaimToken, intent.downstreamClaimToken),
    ));
}

async function renewDownstreamClaim(db: Db, intent: IntentRow, leaseMs: number) {
  if (!intent.downstreamClaimToken) return false;
  const [renewed] = await db
    .update(organizationMutationIntents)
    .set({
      downstreamLeaseExpiresAt: new Date(Date.now() + leaseMs),
      updatedAt: new Date(),
    })
    .where(and(
      eq(organizationMutationIntents.id, intent.id),
      eq(organizationMutationIntents.phase, "effects_claimed"),
      eq(organizationMutationIntents.downstreamClaimToken, intent.downstreamClaimToken),
    ))
    .returning({ id: organizationMutationIntents.id });
  return Boolean(renewed);
}

async function runDownstream(
  db: Db,
  intent: IntentRow,
  callbacks: OrganizationMutationIntentCallbacks,
  workerId: string,
  leaseMs: number,
): Promise<OrganizationMutationIntentRunResult> {
  const claim = await claimDownstream(db, intent.id, workerId, leaseMs);
  if (claim.kind === "completed") return { status: "replayed", intent: claim.intent };
  if (claim.kind === "busy") return { status: "in_progress", intent: claim.intent };
  const claimed = claim.intent;
  if (!claimed.downstreamClaimToken) throw conflict("Organization downstream claim has no token");
  const token = claimed.downstreamClaimToken;
  const progress = { ...claimed.downstreamProgress };
  const renewalTimer = setInterval(() => {
    void renewDownstreamClaim(db, claimed, leaseMs).catch((error) => {
      logger.warn({ err: error, intentId: claimed.id }, "organization mutation downstream lease renewal failed");
    });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  try {
    await callbacks.applyEffects({
      intent: claimed,
      runStep: async (name, target, action) => {
        const existing = progress[name];
        if (existing && typeof existing === "object" && (existing as Record<string, unknown>).status === "completed") {
          return;
        }
        await db.transaction(async (tx) => {
          const current = await tx
            .select({ phase: organizationMutationIntents.phase, downstreamClaimToken: organizationMutationIntents.downstreamClaimToken })
            .from(organizationMutationIntents)
            .where(eq(organizationMutationIntents.id, claimed.id))
            .then((rows) => rows[0] ?? null);
          if (
            !current
            || current.phase !== "effects_claimed"
            || current.downstreamClaimToken !== token
          ) {
            throw conflict("Organization downstream effect claim became stale");
          }
          await action(tx);
          const locked = await tx
            .select({ phase: organizationMutationIntents.phase, downstreamClaimToken: organizationMutationIntents.downstreamClaimToken })
            .from(organizationMutationIntents)
            .where(eq(organizationMutationIntents.id, claimed.id))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (
            !locked
            || locked.phase !== "effects_claimed"
            || locked.downstreamClaimToken !== token
          ) {
            throw conflict("Organization downstream effect claim became stale after effect");
          }
          progress[name] = { status: "completed", target, completedAt: new Date().toISOString() };
          await tx
            .update(organizationMutationIntents)
            .set({ downstreamProgress: progress, updatedAt: new Date() })
            .where(and(
              eq(organizationMutationIntents.id, claimed.id),
              eq(organizationMutationIntents.phase, "effects_claimed"),
              eq(organizationMutationIntents.downstreamClaimToken, token),
            ));
        });
      },
    });

    const [completed] = await db
      .update(organizationMutationIntents)
      .set({
        phase: "completed",
        downstreamClaimToken: null,
        downstreamClaimOwner: null,
        downstreamLeaseExpiresAt: null,
        downstreamCompletedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(organizationMutationIntents.id, claimed.id),
        eq(organizationMutationIntents.phase, "effects_claimed"),
        eq(organizationMutationIntents.downstreamClaimToken, token),
      ))
      .returning();
    if (!completed) throw conflict("Organization downstream claim became stale before completion");
    return { status: "completed", intent: completed };
  } catch (error) {
    await markDownstreamFailed(db, claimed, error);
    throw error;
  } finally {
    clearInterval(renewalTimer);
  }
}

export async function assertOrganizationMutationApprovalWritable(
  tx: Pick<Db, "select">,
  approvalId: string,
  claimToken?: string | null,
) {
  const rows = await tx
    .select({
      phase: organizationMutationIntents.phase,
      claimToken: organizationMutationIntents.claimToken,
    })
    .from(organizationMutationIntents)
    .where(eq(organizationMutationIntents.approvalId, approvalId))
    .orderBy(desc(organizationMutationIntents.generation))
    .limit(1)
    .for("update");
  const intent = rows[0];
  if (!intent) return;
  if (
    claimToken
    && intent.phase === "claimed"
    && intent.claimToken === claimToken
  ) return;
  if (intent.phase !== "rejected" && intent.phase !== "cancelled") {
    throw conflict("Approval is bound to an active organization mutation intent");
  }
}

export async function assertOrganizationMutationMessageWritable(
  tx: Pick<Db, "select">,
  proposalMessageId: string,
  claimToken?: string | null,
  downstreamClaimToken?: string | null,
) {
  const rows = await tx
    .select({
      phase: organizationMutationIntents.phase,
      claimToken: organizationMutationIntents.claimToken,
      downstreamClaimToken: organizationMutationIntents.downstreamClaimToken,
    })
    .from(organizationMutationIntents)
    .where(eq(organizationMutationIntents.proposalMessageId, proposalMessageId))
    .orderBy(desc(organizationMutationIntents.generation))
    .limit(1)
    .for("update");
  const intent = rows[0];
  if (!intent) return;
  if (
    claimToken
    && intent.phase === "claimed"
    && intent.claimToken === claimToken
  ) return;
  if (
    downstreamClaimToken
    && intent.phase === "effects_claimed"
    && intent.downstreamClaimToken === downstreamClaimToken
  ) return;
  if (intent.phase !== "rejected" && intent.phase !== "cancelled") {
    throw conflict("Proposal message is bound to an active organization mutation intent");
  }
}

export function organizationMutationIntentCoordinator(
  db: Db,
  options: OrganizationMutationIntentCoordinatorOptions = {},
) {
  const workerId = options.workerId?.trim() || `organization-settings-intent:${process.pid}:${randomUUID()}`;
  const leaseMs = Math.max(5_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  const batchSize = Math.max(1, Math.min(100, options.batchSize ?? DEFAULT_BATCH_SIZE));

  async function enqueueAndClaim(input: OrganizationSettingsIntentInput): Promise<ClaimResult> {
    const normalized = normalizeInput(input);
    return db.transaction(async (tx) => {
      const sourceRows = await lockSourceRows(tx, normalized);
      let intent = await findIntentForUpdate(tx, normalized);
      if (!intent) {
        if (
          !sourceRows.approvalPresent
          || !sourceRows.messagePresent
          || !(await conversationExists(tx, normalized))
        ) {
          invalidIntent("Organization mutation source disappeared before enqueue claim");
        }
        await insertIntent(tx, normalized);
        intent = await findIntentForUpdate(tx, normalized);
      }
      if (!intent) throw conflict("Organization mutation intent could not be persisted");
      if (!sourceMatchesIntent(intent, normalized)) {
        throw conflict("Organization mutation idempotency key is bound to a different command");
      }
      const conversationPresent = await lockConversationRow(tx, normalized);
      return claimLockedIntent(
        tx,
        intent,
        { ...sourceRows, conversationPresent },
        workerId,
        leaseMs,
      );
    });
  }

  async function driveClaim(
    claim: ClaimResult,
    callbacks: OrganizationMutationIntentCallbacks | null,
  ): Promise<OrganizationMutationIntentRunResult> {
    if (claim.kind === "busy") return { status: "in_progress", intent: claim.intent };
    if (claim.kind === "replay") {
      if (!callbacks) return { status: "replayed", intent: claim.intent };
      return runDownstream(db, claim.intent, callbacks, workerId, leaseMs);
    }
    const intent = claim.intent;
    const resolvedCallbacks = callbacks ?? options.resolveCallbacks?.(intent) ?? null;
    if (!resolvedCallbacks) {
      await markFailed(db, intent, new Error("Organization settings intent callbacks are not configured"));
      throw conflict("Organization settings intent execution is not configured");
    }
    try {
      const context = rustContext(intent);
      const renewalTimer = setInterval(() => {
        void renewClaim(db, intent, leaseMs).catch((error) => {
          logger.warn({ err: error, intentId: intent.id }, "organization mutation claim lease renewal failed");
        });
      }, Math.max(1_000, Math.floor(leaseMs / 3)));
      try {
        await resolvedCallbacks.beforeRust?.(context);
        if (!options.executor) throw new Error("Organization settings Rust executor is not configured");
        const receipt = await options.executor(context);
        const committed = await markRustCommitted(db, intent, receipt);
        return runDownstream(db, committed, resolvedCallbacks, workerId, leaseMs);
      } finally {
        clearInterval(renewalTimer);
      }
    } catch (error) {
      await markFailed(db, intent, error);
      throw error;
    }
  }

  async function run(
    input: OrganizationSettingsIntentInput,
    callbacks?: OrganizationMutationIntentCallbacks,
  ) {
    const claim = await enqueueAndClaim(input);
    return driveClaim(claim, callbacks ?? null);
  }

  async function recover(limit = batchSize) {
    const now = new Date();
    const rows = await db
      .select()
      .from(organizationMutationIntents)
      .where(or(
        and(inArray(organizationMutationIntents.phase, RETRYABLE_PHASES), lte(organizationMutationIntents.nextAttemptAt, now)),
        and(eq(organizationMutationIntents.phase, "claimed"), lte(organizationMutationIntents.leaseExpiresAt, now)),
        and(eq(organizationMutationIntents.phase, "rust_committed")),
        and(eq(organizationMutationIntents.phase, "downstream_pending"), or(
          lte(organizationMutationIntents.downstreamNextAttemptAt, now),
          // A null downstream schedule is valid immediately after Rust receipt.
          isNull(organizationMutationIntents.downstreamNextAttemptAt),
        )),
        and(eq(organizationMutationIntents.phase, "effects_claimed"), lte(organizationMutationIntents.downstreamLeaseExpiresAt, now)),
      ))
      .orderBy(asc(organizationMutationIntents.nextAttemptAt), asc(organizationMutationIntents.createdAt))
      .limit(Math.max(1, Math.min(100, limit)));
    const results: OrganizationMutationIntentRunResult[] = [];
    for (const intent of rows) {
      const input: OrganizationSettingsIntentInput = {
        orgId: intent.orgId,
        source: {
          kind: intent.sourceKind,
          sourceId: intent.sourceId,
          approvalId: intent.approvalId,
          conversationId: intent.conversationId,
          proposalMessageId: intent.proposalMessageId,
        },
        actorUserId: intent.actorUserId,
        actorPrincipal: intent.actorPrincipal,
        decidedByUserId: intent.decidedByUserId,
        decisionNote: intent.decisionNote,
        generation: intent.generation,
        patch: intent.patch,
        rustIdempotencyKey: intent.rustIdempotencyKey,
        patchFingerprint: intent.patchFingerprint,
        intentFingerprint: intent.intentFingerprint,
        downstreamTargets: intent.downstreamTargets,
      };
      try {
        if (isPostRust(intent)) {
          const callbacks = options.resolveCallbacks?.(intent) ?? null;
          if (!callbacks) continue;
          results.push(await runDownstream(db, intent, callbacks, workerId, leaseMs));
        } else {
          results.push(await run(input));
        }
      } catch (error) {
        logger.warn(
          { err: error, intentId: intent.id, orgId: intent.orgId },
          "organization mutation intent recovery failed",
        );
        // A missing source before claim is intentionally left visible for an
        // operator; recovery must not manufacture a receipt or hide InvalidIntent.
      }
    }
    return results;
  }

  async function nextGeneration(source: Pick<OrganizationSettingsIntentSource, "kind" | "sourceId">, orgId: string) {
    const rows = await db
      .select({ generation: organizationMutationIntents.generation })
      .from(organizationMutationIntents)
      .where(and(
        eq(organizationMutationIntents.orgId, orgId),
        eq(organizationMutationIntents.sourceKind, source.kind),
        eq(organizationMutationIntents.sourceId, source.sourceId),
      ))
      .orderBy(desc(organizationMutationIntents.generation))
      .limit(1);
    return (rows[0]?.generation ?? 0n) + 1n;
  }

  return {
    enqueueAndClaim,
    nextGeneration,
    recover,
    run,
  };
}

export type OrganizationMutationIntentCoordinator = ReturnType<typeof organizationMutationIntentCoordinator>;

export type OrganizationMutationIntentPublisherOptions = {
  intervalMs?: number;
  batchSize?: number;
};

/**
 * Drive durable intent recovery while the optional coordinator is enabled.
 * The default application does not construct a coordinator, so this publisher
 * cannot activate the unfinished Rust organization-settings authority by
 * accident.
 */
export function startOrganizationMutationIntentPublisher(
  coordinator: OrganizationMutationIntentCoordinator,
  options: OrganizationMutationIntentPublisherOptions = {},
) {
  const intervalMs = Math.max(100, options.intervalMs ?? 1_000);
  const batchSize = Math.max(1, Math.min(100, options.batchSize ?? 25));
  let closed = false;
  let drainInFlight: Promise<void> | null = null;

  const drain = async () => {
    if (closed) return;
    if (drainInFlight) return drainInFlight;
    drainInFlight = coordinator.recover(batchSize)
      .then(() => undefined)
      .finally(() => {
        drainInFlight = null;
      });
    return drainInFlight;
  };

  const timer = setInterval(() => {
    void drain().catch((error) => {
      logger.warn({ err: error }, "organization mutation intent recovery failed");
    });
  }, intervalMs);

  void drain().catch((error) => {
    logger.warn({ err: error }, "organization mutation intent startup recovery failed");
  });

  return {
    drain,
    async close() {
      closed = true;
      clearInterval(timer);
      await drainInFlight;
    },
  };
}
