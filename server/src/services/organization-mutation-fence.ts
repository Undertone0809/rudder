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
