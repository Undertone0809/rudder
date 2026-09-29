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

type ProjectDeleteStartupReceiptRow = {
  project_id: string;
  receipt_format: string | number;
  outcome: string;
  receipt_org_id: string;
  result_org_id: string | null;
  result_kind: string | null;
  result_project_id: string | null;
  response_project_id: string | null;
  response_org_id: string | null;
};

type ProjectOrganizationRow = {
  project_id: string;
  org_id: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function configuredProjectGoalMutationProjectIds(
  rawValue = process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS,
): string[] {
  const values = (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.toLowerCase());
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

function projectDeleteReceiptOrganizationIds(
  rows: readonly ProjectDeleteStartupReceiptRow[],
): Map<string, Set<string>> {
  const organizationIdsByProjectId = new Map<string, Set<string>>();
  for (const row of rows) {
    const projectId = row.project_id.toLowerCase();
    if (
      Number(row.receipt_format) !== 1
      || row.outcome !== "applied"
      || row.result_org_id !== row.receipt_org_id
      || row.result_kind !== "project_deleted"
      || row.result_project_id?.toLowerCase() !== projectId
      || row.response_project_id?.toLowerCase() !== projectId
      || row.response_org_id !== row.receipt_org_id
    ) {
      continue;
    }
    const organizationIds = organizationIdsByProjectId.get(projectId) ?? new Set<string>();
    organizationIds.add(row.receipt_org_id.toLowerCase());
    organizationIdsByProjectId.set(projectId, organizationIds);
  }
  return organizationIdsByProjectId;
}

async function readProjectOrganizations(
  tx: TransactionClient,
  projectIds: readonly string[],
  lockRows: boolean,
): Promise<ProjectOrganizationRow[]> {
  if (projectIds.length === 0) return [];
  const projectIdList = sql.join(projectIds.map((projectId) => sql`${projectId}::uuid`), sql`, `);
  const lockClause = lockRows ? sql`FOR UPDATE` : sql``;
  return resultRows<ProjectOrganizationRow>(await tx.execute(sql`
    SELECT id::text AS project_id, org_id::text AS org_id
    FROM projects
    WHERE id IN (${projectIdList})
    ORDER BY org_id, id
    ${lockClause}
  `));
}

async function readProjectGoalMutationRows(
  tx: TransactionClient,
  projectIds: readonly string[],
  lockRows: boolean,
): Promise<ProjectGoalMutationStateRow[]> {
  if (projectIds.length === 0) return [];
  const projectIdList = sql.join(projectIds.map((projectId) => sql`${projectId}::uuid`), sql`, `);
  const lockClause = lockRows ? sql`FOR UPDATE` : sql``;
  return resultRows<ProjectGoalMutationStateRow>(await tx.execute(sql`
    SELECT project_id::text AS project_id,
      org_id::text AS org_id,
      mutation_version,
      fence_epoch,
      fence_token,
      owner
    FROM project_goal_mutation_state
    WHERE project_id IN (${projectIdList})
    ORDER BY org_id, project_id
    ${lockClause}
  `));
}

async function readProjectDeleteStartupReceipts(
  tx: TransactionClient,
  projectIds: readonly string[],
): Promise<ProjectDeleteStartupReceiptRow[]> {
  if (projectIds.length === 0) return [];
  const candidates = sql.join(
    projectIds.map((projectId) => sql`(${projectId}::uuid)`),
    sql`, `,
  );
  return resultRows<ProjectDeleteStartupReceiptRow>(await tx.execute(sql`
    SELECT candidate.project_id::text AS project_id,
      receipt.receipt_format,
      receipt.outcome,
      receipt.org_id::text AS receipt_org_id,
      receipt.result->>'organization_id' AS result_org_id,
      receipt.result->'result'->>'kind' AS result_kind,
      receipt.result->'result'->>'project_id' AS result_project_id,
      receipt.result->'result'->'response'->>'id' AS response_project_id,
      receipt.result->'result'->'response'->>'orgId' AS response_org_id
    FROM (VALUES ${candidates}) AS candidate(project_id)
    JOIN organization_mutation_receipts receipt
      ON receipt.command_kind = 'project_delete'
      AND receipt.result->'result'->>'project_id' = candidate.project_id::text
  `));
}

function validateProjectGoalMutationStateRow(
  row: ProjectGoalMutationStateRow,
  organizationId: string,
  projectId?: string,
) {
  if (row.org_id !== organizationId || (projectId !== undefined && row.project_id !== projectId)) {
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
  if (row.owner !== "node" && row.owner !== "rust") {
    throw conflict("Project goal mutation authority has an invalid owner");
  }
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
  const row = await lockProjectGoalMutationAuthorityForDelete(tx, organizationId, projectId);
  if (row.owner !== "node") {
    throw conflict("Project goal mutation authority is owned by Rust");
  }
  return row;
}

/**
 * Lock the Project-Goal component for deletion in the normal organization-then-component
 * order. Parent deletion cascades this state row, including when Rust owns it.
 */
export async function lockProjectGoalMutationAuthorityForDelete(
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
  validateProjectGoalMutationStateRow(row, organizationId, projectId);
  return row;
}

/**
 * Lock every Project-Goal component before an organization deletion. The
 * organization fence is acquired first, then component rows in deterministic
 * order, matching Rust writers and preventing a deletion/writer race.
 */
export async function lockProjectGoalMutationAuthoritiesForOrganizationDeletion(
  tx: TransactionClient,
  organizationId: string,
): Promise<ProjectGoalMutationStateRow[]> {
  await lockNodeMutationAuthority(tx, organizationId);
  const result = await tx.execute(sql`
    SELECT project_id, org_id, mutation_version, fence_epoch, fence_token, owner
    FROM project_goal_mutation_state
    WHERE org_id = ${organizationId}::uuid
    ORDER BY project_id
    FOR UPDATE
  `);
  const rows = resultRows<ProjectGoalMutationStateRow>(result);
  for (const row of rows) {
    validateProjectGoalMutationStateRow(row, organizationId);
  }
  return rows;
}

/** Advance the selected Project-Goal components into the Rust epoch. */
export async function handoffProjectGoalMutationAuthorityInTransaction(
  tx: TransactionClient,
  projectIds: readonly string[],
): Promise<void> {
  const requestedProjectIds = [...new Set(projectIds.map((projectId) => projectId.toLowerCase()))];
  if (requestedProjectIds.length === 0) return;

  const discoveredProjects = await readProjectOrganizations(tx, requestedProjectIds, false);
  const discoveredStates = await readProjectGoalMutationRows(tx, requestedProjectIds, false);
  const discoveredProjectIds = new Set(discoveredProjects.map((row) => row.project_id.toLowerCase()));
  const discoveredStateIds = new Set(discoveredStates.map((row) => row.project_id.toLowerCase()));
  const initiallyMissingIds = requestedProjectIds.filter(
    (projectId) => !discoveredProjectIds.has(projectId) && !discoveredStateIds.has(projectId),
  );
  const initialReceiptRows = await readProjectDeleteStartupReceipts(tx, initiallyMissingIds);
  const initialReceiptOrganizations = projectDeleteReceiptOrganizationIds(initialReceiptRows);
  const missingProjectId = initiallyMissingIds.find(
    (projectId) => !initialReceiptOrganizations.has(projectId),
  );
  if (missingProjectId) {
    // Organization deletion also cascades the receipt, so its old UUID remains
    // intentionally indistinguishable from an arbitrary missing allowlist ID.
    throw conflict(`Project goal mutation authority is not provisioned for ${missingProjectId}`);
  }

  const organizationIds = [...new Set([
    ...discoveredProjects.map((row) => row.org_id.toLowerCase()),
    ...discoveredStates.map((row) => row.org_id.toLowerCase()),
    ...[...initialReceiptOrganizations.values()].flatMap((ids) => [...ids]),
  ])].sort();
  if (organizationIds.length === 0) {
    throw conflict("Project goal mutation organization authority is not provisioned");
  }
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
  const lockedOrganizationIds = new Set(lockedOrganizations.map((row) => row.org_id.toLowerCase()));
  if (
    lockedOrganizationIds.size !== organizationIds.length
    || organizationIds.some((organizationId) => !lockedOrganizationIds.has(organizationId))
  ) {
    throw conflict("Project goal mutation organization authority is not provisioned");
  }

  // Re-read both sides of the Project/fence relationship after taking the
  // organization locks. Creates, deletes, and organization deletion use this
  // fence too, so a receipt-backed UUID that was recreated while we waited is
  // handed off instead of being mistaken for a terminal target.
  const lockedProjects = await readProjectOrganizations(tx, requestedProjectIds, true);
  const lockedRows = await readProjectGoalMutationRows(tx, requestedProjectIds, true);
  const lockedProjectsById = new Map(lockedProjects.map((row) => [row.project_id.toLowerCase(), row]));
  const lockedRowsById = new Map(lockedRows.map((row) => [row.project_id.toLowerCase(), row]));
  const lockedMissingIds = requestedProjectIds.filter(
    (projectId) => !lockedProjectsById.has(projectId) && !lockedRowsById.has(projectId),
  );
  const currentReceiptRows = await readProjectDeleteStartupReceipts(tx, lockedMissingIds);
  const currentReceiptOrganizations = projectDeleteReceiptOrganizationIds(currentReceiptRows);
  const activeProjectIds: string[] = [];
  for (const row of lockedRows) {
    const projectId = row.project_id.toLowerCase();
    const project = lockedProjectsById.get(projectId);
    if (!project || project.org_id.toLowerCase() !== row.org_id.toLowerCase()) {
      throw conflict("Project goal mutation authority has an invalid scope");
    }
    if (!lockedOrganizationIds.has(row.org_id.toLowerCase())) {
      throw conflict("Project goal mutation authority changed during handoff");
    }
    validateProjectGoalMutationStateRow(row, row.org_id, row.project_id);
    if (row.owner !== "node" && row.owner !== "rust") {
      throw conflict("Project goal mutation authority has an invalid owner");
    }
    activeProjectIds.push(projectId);
  }
  for (const projectId of requestedProjectIds) {
    const project = lockedProjectsById.get(projectId);
    const state = lockedRowsById.get(projectId);
    if (project || state) {
      if (!project || !state) throw conflict(`Project goal mutation authority is not provisioned for ${projectId}`);
      continue;
    }
    const receiptOrganizations = currentReceiptOrganizations.get(projectId);
    if (!receiptOrganizations || receiptOrganizations.size === 0) {
      throw conflict(`Project goal mutation authority is not provisioned for ${projectId}`);
    }
    if ([...receiptOrganizations].some((organizationId) => !lockedOrganizationIds.has(organizationId))) {
      throw conflict("Project goal mutation authority changed during handoff");
    }
  }

  if (activeProjectIds.length === 0) return;
  const projectIdList = sql.join(
    activeProjectIds.map((projectId) => sql`${projectId}::uuid`),
    sql`, `,
  );

  if (lockedRows.length !== activeProjectIds.length) {
    throw conflict("Project goal mutation authority changed during handoff");
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
