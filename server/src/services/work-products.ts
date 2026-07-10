import type { Db } from "@rudderhq/db";
import {
  executionWorkspaces,
  heartbeatRuns,
  issueWorkProducts,
  projects,
  workspaceRuntimeServices,
} from "@rudderhq/db";
import type { IssueWorkProduct } from "@rudderhq/shared";
import { and, desc, eq } from "drizzle-orm";
import { unprocessable } from "../errors.js";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;
type IssueWorkProductMutableData = Omit<
  typeof issueWorkProducts.$inferInsert,
  "id" | "orgId" | "issueId" | "createdAt" | "updatedAt"
>;
type IssueWorkProductInput = IssueWorkProductMutableData & {
  /** Public API alias for the legacy database column executionWorkspaceId. */
  runWorkspaceId?: string | null;
};
type IssueWorkProductPatch = Partial<IssueWorkProductInput>;

const INVALID_REFERENCE_MESSAGE = "One or more work product references are invalid for this organization";

function normalizeRunWorkspaceReference(
  input: IssueWorkProductInput | IssueWorkProductPatch,
): Partial<IssueWorkProductMutableData> {
  const source = input as Record<string, unknown>;
  const hasRunWorkspaceId = Object.prototype.hasOwnProperty.call(source, "runWorkspaceId");
  const hasExecutionWorkspaceId = Object.prototype.hasOwnProperty.call(source, "executionWorkspaceId");
  if (
    hasRunWorkspaceId
    && hasExecutionWorkspaceId
    && (source.runWorkspaceId ?? null) !== (source.executionWorkspaceId ?? null)
  ) {
    throw unprocessable(INVALID_REFERENCE_MESSAGE);
  }

  const normalized = { ...source };
  if (hasRunWorkspaceId) {
    normalized.executionWorkspaceId = source.runWorkspaceId ?? null;
  }
  delete normalized.runWorkspaceId;
  // Owner and audit columns are immutable even if an internal caller passes a
  // wider object than the public validator permits.
  delete normalized.id;
  delete normalized.orgId;
  delete normalized.issueId;
  delete normalized.createdAt;
  delete normalized.updatedAt;
  return normalized as Partial<IssueWorkProductMutableData>;
}

async function assertReferencesBelongToOrganization(
  dbOrTx: Db | any,
  orgId: string,
  references: Pick<
    IssueWorkProductRow,
    "projectId" | "executionWorkspaceId" | "runtimeServiceId" | "createdByRunId"
  >,
) {
  const checks: Array<Promise<boolean>> = [];
  if (references.projectId) {
    checks.push(
      dbOrTx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, references.projectId), eq(projects.orgId, orgId)))
        .then((rows: Array<{ id: string }>) => rows.length > 0),
    );
  }
  if (references.executionWorkspaceId) {
    checks.push(
      dbOrTx
        .select({ id: executionWorkspaces.id })
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.id, references.executionWorkspaceId),
            eq(executionWorkspaces.orgId, orgId),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows.length > 0),
    );
  }
  if (references.runtimeServiceId) {
    checks.push(
      dbOrTx
        .select({ id: workspaceRuntimeServices.id })
        .from(workspaceRuntimeServices)
        .where(
          and(
            eq(workspaceRuntimeServices.id, references.runtimeServiceId),
            eq(workspaceRuntimeServices.orgId, orgId),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows.length > 0),
    );
  }
  if (references.createdByRunId) {
    checks.push(
      dbOrTx
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, references.createdByRunId), eq(heartbeatRuns.orgId, orgId)))
        .then((rows: Array<{ id: string }>) => rows.length > 0),
    );
  }

  if ((await Promise.all(checks)).some((valid) => !valid)) {
    throw unprocessable(INVALID_REFERENCE_MESSAGE);
  }
}

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    runWorkspaceId: row.executionWorkspaceId ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function workProductService(db: Db) {
  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return rows.map(toIssueWorkProduct);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (issueId: string, orgId: string, data: IssueWorkProductInput) => {
      const normalizedData = normalizeRunWorkspaceReference(data) as IssueWorkProductMutableData;
      const row = await db.transaction(async (tx) => {
        await assertReferencesBelongToOrganization(tx, orgId, {
          projectId: normalizedData.projectId ?? null,
          executionWorkspaceId: normalizedData.executionWorkspaceId ?? null,
          runtimeServiceId: normalizedData.runtimeServiceId ?? null,
          createdByRunId: normalizedData.createdByRunId ?? null,
        });
        if (normalizedData.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.orgId, orgId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, normalizedData.type),
              ),
            );
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...normalizedData,
            orgId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (id: string, patch: IssueWorkProductPatch) => {
      const normalizedPatch = normalizeRunWorkspaceReference(patch);
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const next = { ...existing, ...normalizedPatch };
        await assertReferencesBelongToOrganization(tx, existing.orgId, {
          projectId: next.projectId ?? null,
          executionWorkspaceId: next.executionWorkspaceId ?? null,
          runtimeServiceId: next.runtimeServiceId ?? null,
          createdByRunId: next.createdByRunId ?? null,
        });

        if (normalizedPatch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.orgId, existing.orgId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
              ),
            );
        }

        return await tx
          .update(issueWorkProducts)
          .set({ ...normalizedPatch, updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    remove: async (id: string) => {
      const row = await db
        .delete(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },
  };
}

export { toIssueWorkProduct };
