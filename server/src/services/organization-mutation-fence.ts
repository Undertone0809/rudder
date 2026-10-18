import { sql } from "drizzle-orm";
import { conflict } from "../errors.js";

type TransactionClient = {
  execute(query: unknown): Promise<unknown>;
};

type MutationStateRow = {
  owner: string;
  mutation_version: string | number | bigint;
  fence_epoch: string | number | bigint;
  fence_token: string;
};

type LegacyChatTargetRow = {
  id: string;
  native_owned: boolean;
};

type LegacyChatTargetHint = {
  org_id: string;
  id: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Serialize a legacy Node writer with the organization ownership handoff.
 * Every business write must acquire this row before mutating its component and
 * keep the same transaction open until the business write commits. Rust uses
 * the same row as its handoff lock, so a handoff waits for an in-flight Node
 * transaction and a writer that starts after the handoff observes owner=rust.
 * The token is an opaque identity for the locked epoch, not a bearer value
 * that can authorize a write after this transaction ends.
 */
export async function lockNodeMutationAuthority(
  tx: TransactionClient,
  organizationId: string,
): Promise<MutationStateRow> {
  const result = await tx.execute(sql`
    SELECT owner, mutation_version, fence_epoch, fence_token
    FROM organization_mutation_state
    WHERE org_id = ${organizationId}::uuid
    FOR UPDATE
  `) as { rows?: MutationStateRow[] } | MutationStateRow[];
  const row = Array.isArray(result) ? result[0] : result.rows?.[0];
  if (!row) {
    throw conflict("Organization mutation authority is not provisioned");
  }
  try {
    if (BigInt(row.mutation_version) < 0n || BigInt(row.fence_epoch) < 0n) {
      throw new Error("negative mutation fence counter");
    }
  } catch {
    throw conflict("Organization mutation fence counters are invalid");
  }
  if (!UUID_PATTERN.test(row.fence_token)) {
    throw conflict("Organization mutation fencing token is invalid");
  }
  if (row.owner !== "node") {
    throw conflict("Organization mutation authority is owned by Rust");
  }
  return row;
}

/**
 * Serialize a legacy queue writer with Rust Native Chat admission for one
 * conversation. Keep this exact advisory key in sync with D1's
 * `runtime-binding:target:chat_conversation:{org}:{conversation}` lock.
 * Call it before locking any queued-message, generation, or control-action
 * rows. The subsequent SELECT is a fresh READ COMMITTED statement, so a Rust
 * admission that held this key first is visible before a legacy write begins.
 */
export async function lockLegacyNativeChatQueueTarget(
  tx: TransactionClient,
  organizationId: string,
  conversationId: string,
): Promise<"available" | "native_owned" | "missing"> {
  const hintResult = await tx.execute(sql`
    SELECT c.org_id::text AS org_id, c.id::text AS id
    FROM chat_conversations c
    WHERE c.org_id = ${organizationId}::uuid
      AND c.id = ${conversationId}::uuid
  `) as { rows?: LegacyChatTargetHint[] } | LegacyChatTargetHint[];
  const hint = Array.isArray(hintResult) ? hintResult[0] : hintResult.rows?.[0];
  if (!hint) return "missing";

  // Use UUID values read back from PostgreSQL. This matches Rust's canonical
  // UUID string when callers supplied uppercase but equivalent UUID text.
  const targetKey = `runtime-binding:target:chat_conversation:${hint.org_id}:${hint.id}`;
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${targetKey}, 0))
  `);

  const result = await tx.execute(sql`
    SELECT c.id::text AS id,
      EXISTS (
        SELECT 1
        FROM chat_generations native_generation
        WHERE native_generation.org_id = c.org_id
          AND native_generation.conversation_id = c.id
          AND native_generation.execution_authority = 'native_rust'
      ) AS native_owned
    FROM chat_conversations c
    WHERE c.org_id = ${organizationId}::uuid
      AND c.id = ${conversationId}::uuid
    FOR SHARE OF c
  `) as { rows?: LegacyChatTargetRow[] } | LegacyChatTargetRow[];
  const row = Array.isArray(result) ? result[0] : result.rows?.[0];
  if (!row) return "missing";
  return row.native_owned ? "native_owned" : "available";
}
