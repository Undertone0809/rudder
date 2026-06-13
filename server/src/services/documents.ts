import type { Db } from "@rudderhq/db";
import { documentRevisions, documents, issueDocuments, issues } from "@rudderhq/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { conflict } from "../errors.js";

function mapLibraryDocumentRow(
  row: {
    id: string;
    orgId: string;
    title: string | null;
    format: string;
    latestBody: string;
    latestRevisionId: string | null;
    latestRevisionNumber: number;
    createdByAgentId: string | null;
    createdByUserId: string | null;
    updatedByAgentId: string | null;
    updatedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  includeBody: boolean,
) {
  return {
    id: row.id,
    orgId: row.orgId,
    title: row.title,
    format: row.format,
    ...(includeBody ? { body: row.latestBody } : {}),
    latestRevisionId: row.latestRevisionId ?? null,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listIssueLinksByDocumentId(db: Db, orgId: string, documentIds?: string[]) {
  if (documentIds && documentIds.length === 0) return new Map<string, Array<{
    issueId: string;
    issueIdentifier: string | null;
    issueTitle: string;
    key: string;
  }>>();

  const conditions = [eq(issueDocuments.orgId, orgId)];
  if (documentIds) {
    conditions.push(inArray(issueDocuments.documentId, documentIds));
  }

  const issueLinkRows = await db
    .select({
      documentId: issueDocuments.documentId,
      issueId: issues.id,
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
      key: issueDocuments.key,
    })
    .from(issueDocuments)
    .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
    .where(and(...conditions));

  const issueLinksByDocumentId = new Map<string, Array<{
    issueId: string;
    issueIdentifier: string | null;
    issueTitle: string;
    key: string;
  }>>();
  for (const row of issueLinkRows) {
    const current = issueLinksByDocumentId.get(row.documentId) ?? [];
    current.push({
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier,
      issueTitle: row.issueTitle,
      key: row.key,
    });
    issueLinksByDocumentId.set(row.documentId, current);
  }
  return issueLinksByDocumentId;
}

export function documentService(db: Db) {
  return {
    listLibraryDocuments: async (orgId: string) => {
      const documentRows = await db
        .select({
          id: documents.id,
          orgId: documents.orgId,
          title: documents.title,
          format: documents.format,
          latestBody: documents.latestBody,
          latestRevisionId: documents.latestRevisionId,
          latestRevisionNumber: documents.latestRevisionNumber,
          createdByAgentId: documents.createdByAgentId,
          createdByUserId: documents.createdByUserId,
          updatedByAgentId: documents.updatedByAgentId,
          updatedByUserId: documents.updatedByUserId,
          createdAt: documents.createdAt,
          updatedAt: documents.updatedAt,
        })
        .from(documents)
        .where(eq(documents.orgId, orgId))
        .orderBy(desc(documents.updatedAt));

      const issueLinksByDocumentId = await listIssueLinksByDocumentId(
        db,
        orgId,
        documentRows.map((row) => row.id),
      );

      return documentRows.map((row) => ({
        ...mapLibraryDocumentRow(row, false),
        issueLinks: issueLinksByDocumentId.get(row.id) ?? [],
      }));
    },

    createLibraryDocument: async (input: {
      orgId: string;
      title?: string | null;
      format: string;
      body: string;
      changeSummary?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      return db.transaction(async (tx) => {
        const now = new Date();
        const [document] = await tx
          .insert(documents)
          .values({
            orgId: input.orgId,
            title: input.title ?? null,
            format: input.format,
            latestBody: input.body,
            latestRevisionId: null,
            latestRevisionNumber: 1,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            orgId: input.orgId,
            documentId: document.id,
            revisionNumber: 1,
            body: input.body,
            changeSummary: input.changeSummary ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            createdAt: now,
          })
          .returning();

        await tx
          .update(documents)
          .set({ latestRevisionId: revision.id })
          .where(eq(documents.id, document.id));

        return {
          ...mapLibraryDocumentRow({
            ...document,
            latestRevisionId: revision.id,
          }, true),
          issueLinks: [],
        };
      });
    },

    getLibraryDocumentById: async (orgId: string, documentId: string) => {
      const row = await db
        .select({
          id: documents.id,
          orgId: documents.orgId,
          title: documents.title,
          format: documents.format,
          latestBody: documents.latestBody,
          latestRevisionId: documents.latestRevisionId,
          latestRevisionNumber: documents.latestRevisionNumber,
          createdByAgentId: documents.createdByAgentId,
          createdByUserId: documents.createdByUserId,
          updatedByAgentId: documents.updatedByAgentId,
          updatedByUserId: documents.updatedByUserId,
          createdAt: documents.createdAt,
          updatedAt: documents.updatedAt,
        })
        .from(documents)
        .where(and(eq(documents.orgId, orgId), eq(documents.id, documentId)))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const issueLinksByDocumentId = await listIssueLinksByDocumentId(db, orgId, [documentId]);
      return {
        ...mapLibraryDocumentRow(row, true),
        issueLinks: issueLinksByDocumentId.get(row.id) ?? [],
      };
    },

    updateLibraryDocument: async (input: {
      orgId: string;
      documentId: string;
      title?: string | null;
      format: string;
      body: string;
      changeSummary?: string | null;
      baseRevisionId?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      return db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: documents.id,
            orgId: documents.orgId,
            title: documents.title,
            format: documents.format,
            latestBody: documents.latestBody,
            latestRevisionId: documents.latestRevisionId,
            latestRevisionNumber: documents.latestRevisionNumber,
            createdByAgentId: documents.createdByAgentId,
            createdByUserId: documents.createdByUserId,
            updatedByAgentId: documents.updatedByAgentId,
            updatedByUserId: documents.updatedByUserId,
            createdAt: documents.createdAt,
            updatedAt: documents.updatedAt,
          })
          .from(documents)
          .where(and(eq(documents.orgId, input.orgId), eq(documents.id, input.documentId)))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;
        if (!input.baseRevisionId) {
          throw conflict("Document update requires baseRevisionId", {
            currentRevisionId: existing.latestRevisionId,
          });
        }
        if (input.baseRevisionId !== existing.latestRevisionId) {
          throw conflict("Document was updated by someone else", {
            currentRevisionId: existing.latestRevisionId,
          });
        }

        const nextTitle = input.title ?? null;
        if (
          existing.latestBody === input.body &&
          (existing.title ?? null) === nextTitle &&
          existing.format === input.format
        ) {
          return {
            ...mapLibraryDocumentRow(existing, true),
            issueLinks: [],
          };
        }

        const now = new Date();
        const nextRevisionNumber = existing.latestRevisionNumber + 1;
        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            orgId: input.orgId,
            documentId: existing.id,
            revisionNumber: nextRevisionNumber,
            body: input.body,
            changeSummary: input.changeSummary ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            createdAt: now,
          })
          .returning();

        await tx
          .update(documents)
          .set({
            title: nextTitle,
            format: input.format,
            latestBody: input.body,
            latestRevisionId: revision.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        return {
          ...mapLibraryDocumentRow({
            ...existing,
            title: nextTitle,
            format: input.format,
            latestBody: input.body,
            latestRevisionId: revision.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            updatedAt: now,
          }, true),
          issueLinks: [],
        };
      });
    },

    listLibraryDocumentRevisions: async (orgId: string, documentId: string) => {
      return db
        .select({
          id: documentRevisions.id,
          orgId: documentRevisions.orgId,
          documentId: documentRevisions.documentId,
          revisionNumber: documentRevisions.revisionNumber,
          body: documentRevisions.body,
          changeSummary: documentRevisions.changeSummary,
          createdByAgentId: documentRevisions.createdByAgentId,
          createdByUserId: documentRevisions.createdByUserId,
          createdAt: documentRevisions.createdAt,
        })
        .from(documentRevisions)
        .where(and(eq(documentRevisions.orgId, orgId), eq(documentRevisions.documentId, documentId)))
        .orderBy(desc(documentRevisions.revisionNumber));
    },

    restoreLibraryDocumentRevision: async (input: {
      orgId: string;
      documentId: string;
      revisionId: string;
      changeSummary?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      return db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: documents.id,
            orgId: documents.orgId,
            title: documents.title,
            format: documents.format,
            latestBody: documents.latestBody,
            latestRevisionId: documents.latestRevisionId,
            latestRevisionNumber: documents.latestRevisionNumber,
            createdByAgentId: documents.createdByAgentId,
            createdByUserId: documents.createdByUserId,
            updatedByAgentId: documents.updatedByAgentId,
            updatedByUserId: documents.updatedByUserId,
            createdAt: documents.createdAt,
            updatedAt: documents.updatedAt,
          })
          .from(documents)
          .where(and(eq(documents.orgId, input.orgId), eq(documents.id, input.documentId)))
          .then((rows) => rows[0] ?? null);
        const restoreRevision = await tx
          .select({
            body: documentRevisions.body,
            revisionNumber: documentRevisions.revisionNumber,
          })
          .from(documentRevisions)
          .where(and(
            eq(documentRevisions.orgId, input.orgId),
            eq(documentRevisions.documentId, input.documentId),
            eq(documentRevisions.id, input.revisionId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!existing || !restoreRevision) return null;

        const now = new Date();
        const nextRevisionNumber = existing.latestRevisionNumber + 1;
        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            orgId: input.orgId,
            documentId: existing.id,
            revisionNumber: nextRevisionNumber,
            body: restoreRevision.body,
            changeSummary: input.changeSummary ?? `Restored revision ${restoreRevision.revisionNumber}`,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            createdAt: now,
          })
          .returning();

        await tx
          .update(documents)
          .set({
            latestBody: restoreRevision.body,
            latestRevisionId: revision.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        return {
          ...mapLibraryDocumentRow({
            ...existing,
            latestBody: restoreRevision.body,
            latestRevisionId: revision.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            updatedAt: now,
          }, true),
          issueLinks: [],
        };
      });
    },

  };
}
