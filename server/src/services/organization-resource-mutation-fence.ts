import { sql } from "drizzle-orm";
import { conflict } from "../errors.js";

type TransactionClient = {
  execute(query: unknown): Promise<unknown>;
};

type OrganizationResourceMutationStateRow = {
  resource_id: string;
  org_id: string;
  owner: string;
  mutation_version: string | number | bigint;
  fence_epoch: string | number | bigint;
  fence_token: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstRow(result: unknown): OrganizationResourceMutationStateRow | undefined {
  if (Array.isArray(result)) return result[0] as OrganizationResourceMutationStateRow | undefined;
  return (result as { rows?: OrganizationResourceMutationStateRow[] }).rows?.[0];
}

/**
 * Lock resource authority after the caller has locked the organization row.
 *
 * Reasoning:
 * - Existing canonical rows predate this fence, so provision only a missing
 *   row whose canonical organization matches the caller's organization.
 * - When a canonical row was already scoped to this organization, read the
 *   component row by resource ID to detect a corrupt org boundary. Tombstone
 *   lookups stay org-scoped so a foreign ID remains indistinguishable from a
 *   missing resource.
 * - No resource foreign key is used: deletion leaves this row as a replay
 *   tombstone.
 */
export async function lockNodeOrganizationResourceMutationAuthority(
  tx: TransactionClient,
  organizationId: string,
  resourceId: string,
  options: { initializeFromCanonical?: boolean } = {},
): Promise<OrganizationResourceMutationStateRow | null> {
  const initializeFromCanonical = options.initializeFromCanonical ?? false;
  if (initializeFromCanonical) {
    await tx.execute(sql`
      INSERT INTO organization_resource_mutation_state (resource_id, org_id)
      SELECT id, org_id
      FROM organization_resources
      WHERE id = ${resourceId}::uuid AND org_id = ${organizationId}::uuid
      ON CONFLICT (resource_id) DO NOTHING
    `);
  }

  const row = firstRow(await tx.execute(sql`
    SELECT resource_id::text AS resource_id,
      org_id::text AS org_id,
      owner,
      mutation_version,
      fence_epoch,
      fence_token::text AS fence_token
    FROM organization_resource_mutation_state
    WHERE resource_id = ${resourceId}::uuid
      ${initializeFromCanonical ? sql`` : sql`AND org_id = ${organizationId}::uuid`}
    FOR UPDATE
  `));
  if (!row) {
    if (initializeFromCanonical) {
      throw conflict("Organization resource mutation authority is not provisioned");
    }
    return null;
  }

  if (
    row.resource_id.toLowerCase() !== resourceId.toLowerCase()
    || row.org_id.toLowerCase() !== organizationId.toLowerCase()
  ) {
    throw conflict("Organization resource mutation authority has an invalid scope");
  }
  try {
    if (BigInt(row.mutation_version) < 0n || BigInt(row.fence_epoch) < 0n) {
      throw new Error("negative resource mutation fence counter");
    }
  } catch {
    throw conflict("Organization resource mutation fence counters are invalid");
  }
  if (!UUID_PATTERN.test(row.fence_token)) {
    throw conflict("Organization resource mutation fencing token is invalid");
  }
  if (row.owner !== "node") {
    throw conflict("Organization resource mutation authority is owned by Rust");
  }
  return row;
}
