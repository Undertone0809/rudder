import type { Db } from "@rudderhq/db";
import { sql } from "drizzle-orm";
import { conflict } from "../errors.js";
import { lockNodeMutationAuthority } from "./organization-mutation-fence.js";

type TransactionClient = {
  execute(query: unknown): Promise<unknown>;
};

type ProjectGoalMutationStateRow = {
  project_id: string;
  org_id: string;
  mutation_version: string | number | bigint;
  fence_epoch: string | number | bigint;
  fence_token: string;
  owner: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function configuredProjectGoalMutationProjectIds(
  rawValue = process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS,
): string[] {
  const values = (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.find((value) => !UUID_PATTERN.test(value));
  if (invalid) {
    throw new Error(
      `RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS must contain UUIDs; received ${invalid}`,
    );
  }
  return [...new Set(values)];
}

function firstRow(result: unknown): ProjectGoalMutationStateRow | undefined {
  if (Array.isArray(result)) return result[0] as ProjectGoalMutationStateRow | undefined;
  return (result as { rows?: ProjectGoalMutationStateRow[] }).rows?.[0];
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/**
 * Lock the organization boundary first, then the Project-Goal component row.
 * The order is shared with the Rust transaction and the organization delete
 * path so a handoff cannot race a legacy project writer or deletion.
 */
export async function lockNodeProjectGoalMutationAuthority(
  tx: TransactionClient,
  organizationId: string,
  projectId: string,
): Promise<ProjectGoalMutationStateRow> {
  await lockNodeMutationAuthority(tx, organizationId);
  const result = await tx.execute(sql`
    SELECT project_id, org_id, mutation_version, fence_epoch, fence_token, owner
    FROM project_goal_mutation_state
    WHERE project_id = ${projectId}::uuid AND org_id = ${organizationId}::uuid
    FOR UPDATE
  `);
  const row = firstRow(result);
  if (!row) throw conflict("Project goal mutation authority is not provisioned");
  if (row.org_id !== organizationId || row.project_id !== projectId) {
    throw conflict("Project goal mutation authority has an invalid scope");
  }
  try {
    if (BigInt(row.mutation_version) < 0n || BigInt(row.fence_epoch) < 0n) {
      throw new Error("negative project goal mutation fence counter");
    }
  } catch {
    throw conflict("Project goal mutation fence counters are invalid");
  }
  if (!UUID_PATTERN.test(row.fence_token)) {
    throw conflict("Project goal mutation fencing token is invalid");
  }
  if (row.owner !== "node") {
    throw conflict("Project goal mutation authority is owned by Rust");
  }
  return row;
}

/** Advance the selected Project-Goal components into the Rust epoch. */
export async function handoffProjectGoalMutationAuthorityInTransaction(
  tx: TransactionClient,
  projectIds: readonly string[],
): Promise<void> {
  const requestedProjectIds = [...new Set(projectIds)];
  if (requestedProjectIds.length === 0) return;

  const projectIdList = sql.join(
    requestedProjectIds.map((projectId) => sql`${projectId}::uuid`),
    sql`, `,
  );

  // Read the target rows before taking locks so the lock set is explicit. The
  // locked re-read below is the authority check; this first read only avoids
  // broad organization locking when an allowlisted UUID is missing.
  const discoveredRows = resultRows<Pick<ProjectGoalMutationStateRow, "project_id" | "org_id">>(await tx.execute(sql`
    SELECT project_id::text AS project_id, org_id::text AS org_id
    FROM project_goal_mutation_state
    WHERE project_id IN (${projectIdList})
  `));
  const discoveredById = new Map(discoveredRows.map((row) => [row.project_id, row]));
  const missingProjectId = requestedProjectIds.find((projectId) => !discoveredById.has(projectId));
  if (missingProjectId) {
    throw conflict(`Project goal mutation authority is not provisioned for ${missingProjectId}`);
  }

  const organizationIds = [...new Set(discoveredRows.map((row) => row.org_id))].sort();
  const organizationIdList = sql.join(
    organizationIds.map((organizationId) => sql`${organizationId}::uuid`),
    sql`, `,
  );
  // Project-Goal writers lock the organization fence before the component
  // row. Acquire the same organization rows before changing ownership so a
  // handoff cannot cross an in-flight legacy writer or organization delete.
  const lockedOrganizations = resultRows<{ org_id: string }>(await tx.execute(sql`
    SELECT org_id::text AS org_id
    FROM organization_mutation_state
    WHERE org_id IN (${organizationIdList})
    ORDER BY org_id
    FOR UPDATE
  `));
  if (lockedOrganizations.length !== organizationIds.length) {
    throw conflict("Project goal mutation organization authority is not provisioned");
  }

  const lockedRows = resultRows<ProjectGoalMutationStateRow>(await tx.execute(sql`
    SELECT project_id::text AS project_id,
      org_id::text AS org_id,
      mutation_version,
      fence_epoch,
      fence_token,
      owner
    FROM project_goal_mutation_state
    WHERE project_id IN (${projectIdList})
    ORDER BY org_id, project_id
    FOR UPDATE
  `));
  if (lockedRows.length !== requestedProjectIds.length) {
    throw conflict("Project goal mutation authority changed during handoff");
  }
  for (const row of lockedRows) {
    if (!discoveredById.has(row.project_id) || !organizationIds.includes(row.org_id)) {
      throw conflict("Project goal mutation authority has an invalid scope");
    }
    if (row.owner !== "node" && row.owner !== "rust") {
      throw conflict("Project goal mutation authority has an invalid owner");
    }
    try {
      if (BigInt(row.mutation_version) < 0n || BigInt(row.fence_epoch) < 0n) {
        throw new Error("negative project goal mutation fence counter");
      }
    } catch {
      throw conflict("Project goal mutation fence counters are invalid");
    }
    if (!UUID_PATTERN.test(row.fence_token)) {
      throw conflict("Project goal mutation fencing token is invalid");
    }
  }

  const nodeOwnedRows = lockedRows.filter((row) => row.owner === "node");
  const updatedRows = resultRows<{ project_id: string }>(await tx.execute(sql`
    UPDATE project_goal_mutation_state
    SET owner = 'rust',
        fence_epoch = fence_epoch + 1,
        fence_token = gen_random_uuid(),
        updated_at = now()
    WHERE project_id IN (${projectIdList})
      AND owner = 'node'
    RETURNING project_id::text AS project_id
  `));
  if (updatedRows.length !== nodeOwnedRows.length) {
    throw conflict("Project goal mutation authority handoff was incomplete");
  }
}

export async function handoffProjectGoalMutationAuthority(
  db: Db,
  projectIds: readonly string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await handoffProjectGoalMutationAuthorityInTransaction(tx, projectIds);
  });
}
