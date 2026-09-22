import type { Db } from "@rudderhq/db";
import { sql } from "drizzle-orm";
import { conflict } from "../errors.js";

type TransactionClient = {
  execute(query: unknown): Promise<unknown>;
};

type BrandingMutationStateRow = {
  owner: string;
  mutation_version: string | number | bigint;
  fence_epoch: string | number | bigint;
  fence_token: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Serialize every legacy brandColor writer with the component-level Rust
 * ownership handoff. This lock must be acquired before the organization-wide
 * fence so a Rust branding transaction and a Node update cannot cross locks.
 */
export async function lockNodeOrganizationBrandingAuthority(
  tx: TransactionClient,
  organizationId: string,
): Promise<BrandingMutationStateRow> {
  const result = await tx.execute(sql`
    SELECT owner, mutation_version, fence_epoch, fence_token
    FROM organization_branding_mutation_state
    WHERE org_id = ${organizationId}::uuid
    FOR UPDATE
  `) as { rows?: BrandingMutationStateRow[] } | BrandingMutationStateRow[];
  const row = Array.isArray(result) ? result[0] : result.rows?.[0];
  if (!row) {
    throw conflict("Organization branding mutation authority is not provisioned");
  }
  try {
    if (BigInt(row.mutation_version) < 0n || BigInt(row.fence_epoch) < 0n) {
      throw new Error("negative branding mutation fence counter");
    }
  } catch {
    throw conflict("Organization branding mutation fence counters are invalid");
  }
  if (!UUID_PATTERN.test(row.fence_token)) {
    throw conflict("Organization branding mutation fencing token is invalid");
  }
  if (row.owner !== "node") {
    throw conflict("Organization branding mutation authority is owned by Rust");
  }
  return row;
}

/**
 * Advance every Node-owned branding component into the Rust epoch. The row
 * lock makes an in-flight legacy writer finish before the handoff, while every
 * later writer observes owner=rust and fails closed. Re-running the same
 * startup handoff is intentionally idempotent for rows already owned by Rust.
 */
export async function handoffOrganizationBrandingAuthorityInTransaction(
  tx: TransactionClient,
  organizationId?: string,
) {
  const invalid = await tx.execute(sql`
    SELECT org_id
    FROM organization_branding_mutation_state
    WHERE owner NOT IN ('node', 'rust')
      ${organizationId ? sql`AND org_id = ${organizationId}::uuid` : sql``}
    LIMIT 1
  `) as { rows?: Array<{ org_id: string }> };
  if (invalid.rows?.[0]) {
    throw conflict("Organization branding mutation authority has an invalid owner");
  }
  await tx.execute(sql`
    UPDATE organization_branding_mutation_state
    SET owner = 'rust',
        fence_epoch = fence_epoch + 1,
        fence_token = gen_random_uuid(),
        updated_at = now()
    WHERE owner = 'node'
      ${organizationId ? sql`AND org_id = ${organizationId}::uuid` : sql``}
  `);
}

export async function handoffOrganizationBrandingAuthority(
  db: Db,
  organizationId?: string,
) {
  await db.transaction(async (tx) => {
    await handoffOrganizationBrandingAuthorityInTransaction(tx, organizationId);
  });
}
