import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  organizationResources,
  projectResourceAttachments,
  projects,
} from "@rudderhq/db";
import type {
  CreateOrganizationResourceRequest,
  CreateProjectInlineResourceInput,
  OrganizationResource,
  ProjectResourceAttachment,
  ProjectResourceAttachmentInput,
  UpdateProjectResourceAttachmentRequest,
  UpdateOrganizationResourceRequest,
} from "@rudderhq/shared";
import { badRequest, conflict } from "../errors.js";

function toOrganizationResource(row: typeof organizationResources.$inferSelect): OrganizationResource {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    kind: row.kind as OrganizationResource["kind"],
    sourceType: (row.sourceType ?? "external") as OrganizationResource["sourceType"],
    locator: row.locator,
    description: row.description ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProjectResourceAttachment(
  row: typeof projectResourceAttachments.$inferSelect,
  resource: OrganizationResource,
): ProjectResourceAttachment {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    resourceId: row.resourceId,
    role: row.role as ProjectResourceAttachment["role"],
    note: row.note ?? null,
    sortOrder: row.sortOrder,
    resource,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeNullableText(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const LIBRARY_PATH_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function isValidLibraryProjectPath(locator: string, kind: string) {
  const trimmed = locator.trim();
  if (!trimmed) return false;
  if (LIBRARY_PATH_SCHEME_RE.test(trimmed)) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.startsWith("~")) return false;
  if (trimmed.includes("\\")) return false;
  const parts = trimmed.split("/");
  if (!parts.every((part) => part.length > 0 && part !== "." && part !== "..")) return false;
  if (parts[0] !== "projects") return false;
  return kind === "directory" ? parts.length >= 2 : parts.length >= 3;
}

function assertValidLibraryResource(input: {
  sourceType: string;
  kind: string;
  locator: string;
}) {
  if (input.sourceType !== "library") return;
  if (input.kind !== "file" && input.kind !== "directory") {
    throw badRequest("Library resources must be file or directory resources.");
  }
  if (!isValidLibraryProjectPath(input.locator, input.kind)) {
    throw badRequest("Library resource locator must be a normalized project Library path.");
  }
}

async function findLibraryResourceByLocator(dbOrTx: Db | any, orgId: string, locator: string) {
  return dbOrTx
    .select()
    .from(organizationResources)
    .where(
      and(
        eq(organizationResources.orgId, orgId),
        eq(organizationResources.sourceType, "library"),
        eq(organizationResources.locator, locator.trim()),
      ),
    )
    .limit(1)
    .then((rows: typeof organizationResources.$inferSelect[]) => rows[0] ?? null);
}

async function createOrReuseOrganizationResource(
  dbOrTx: Db | any,
  orgId: string,
  input: CreateOrganizationResourceRequest,
) {
  const sourceType = input.sourceType ?? "external";
  const locator = input.locator.trim();
  assertValidLibraryResource({ sourceType, kind: input.kind, locator });

  if (sourceType === "library") {
    const existing = await findLibraryResourceByLocator(dbOrTx, orgId, locator);
    if (existing) return existing;
  }

  return dbOrTx
    .insert(organizationResources)
    .values({
      orgId,
      name: input.name.trim(),
      kind: input.kind,
      sourceType,
      locator,
      description: normalizeNullableText(input.description) ?? null,
      metadata: input.metadata ?? null,
    })
    .returning()
    .then((rows: typeof organizationResources.$inferSelect[]) => rows[0]);
}

async function fetchProjectOrgId(db: Db, projectId: string) {
  return db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .then((rows) => rows[0]?.orgId ?? null);
}

async function listOrganizationResourceMap(db: Db, orgId: string, resourceIds: string[]) {
  if (resourceIds.length === 0) return new Map<string, OrganizationResource>();
  const rows = await db
    .select()
    .from(organizationResources)
    .where(and(eq(organizationResources.orgId, orgId), inArray(organizationResources.id, resourceIds)));
  return new Map(rows.map((row) => [row.id, toOrganizationResource(row)]));
}

export async function listProjectResourceAttachments(
  db: Db,
  orgId: string,
  projectId: string,
): Promise<ProjectResourceAttachment[]> {
  const byProjectId = await listProjectResourceAttachmentsByProjectIds(db, orgId, [projectId]);
  return byProjectId.get(projectId) ?? [];
}

export async function listOrganizationResources(
  db: Db,
  orgId: string,
): Promise<OrganizationResource[]> {
  const rows = await db
    .select()
    .from(organizationResources)
    .where(eq(organizationResources.orgId, orgId))
    .orderBy(asc(organizationResources.createdAt), asc(organizationResources.id));
  return rows.map(toOrganizationResource);
}

export async function listProjectResourceAttachmentsByProjectIds(
  db: Db,
  orgId: string,
  projectIds: string[],
): Promise<Map<string, ProjectResourceAttachment[]>> {
  const dedupedProjectIds = [...new Set(projectIds)];
  if (dedupedProjectIds.length === 0) return new Map<string, ProjectResourceAttachment[]>();

  const rows = await db
    .select()
    .from(projectResourceAttachments)
    .where(
      and(
        eq(projectResourceAttachments.orgId, orgId),
        inArray(projectResourceAttachments.projectId, dedupedProjectIds),
      ),
    )
    .orderBy(asc(projectResourceAttachments.sortOrder), asc(projectResourceAttachments.createdAt));

  const resourceMap = await listOrganizationResourceMap(
    db,
    orgId,
    [...new Set(rows.map((row) => row.resourceId))],
  );

  const attachments = rows
    .map((row) => {
      const resource = resourceMap.get(row.resourceId);
      return resource ? toProjectResourceAttachment(row, resource) : null;
    })
    .filter((row): row is ProjectResourceAttachment => Boolean(row));

  const byProjectId = new Map<string, ProjectResourceAttachment[]>();
  for (const attachment of attachments) {
    const existing = byProjectId.get(attachment.projectId);
    if (existing) existing.push(attachment);
    else byProjectId.set(attachment.projectId, [attachment]);
  }
  return byProjectId;
}

export async function replaceProjectResourceAttachments(
  dbOrTx: Db | any,
  input: {
    orgId: string;
    projectId: string;
    attachments: ProjectResourceAttachmentInput[];
    newResources?: CreateProjectInlineResourceInput[];
  },
): Promise<ProjectResourceAttachment[]> {
  const createdResourceIds: string[] = [];

  for (const inlineResource of input.newResources ?? []) {
    const created = await createOrReuseOrganizationResource(dbOrTx, input.orgId, inlineResource);
    createdResourceIds.push(created.id);
  }

  const combinedAttachments = [
    ...input.attachments,
    ...(input.newResources ?? []).map((resource, index) => ({
      resourceId: createdResourceIds[index]!,
      role: resource.role,
      note: resource.note,
      sortOrder: resource.sortOrder,
    })),
  ];
  const dedupedAttachments = combinedAttachments.filter((attachment, index, attachments) =>
    attachments.findIndex((candidate) => candidate.resourceId === attachment.resourceId) === index,
  );

  await dbOrTx
    .delete(projectResourceAttachments)
    .where(
      and(
        eq(projectResourceAttachments.orgId, input.orgId),
        eq(projectResourceAttachments.projectId, input.projectId),
      ),
    );

  if (dedupedAttachments.length > 0) {
    await dbOrTx.insert(projectResourceAttachments).values(
      dedupedAttachments.map((attachment, index) => ({
        orgId: input.orgId,
        projectId: input.projectId,
        resourceId: attachment.resourceId,
        role: attachment.role ?? "reference",
        note: normalizeNullableText(attachment.note) ?? null,
        sortOrder: attachment.sortOrder ?? index,
      })),
    );
  }

  return listProjectResourceAttachments(dbOrTx, input.orgId, input.projectId);
}

export function resourceCatalogService(db: Db) {
  return {
    listOrganizationResources: async (orgId: string): Promise<OrganizationResource[]> =>
      listOrganizationResources(db, orgId),

    getOrganizationResourceById: async (orgId: string, resourceId: string): Promise<OrganizationResource | null> => {
      const row = await db
        .select()
        .from(organizationResources)
        .where(and(eq(organizationResources.orgId, orgId), eq(organizationResources.id, resourceId)))
        .then((rows) => rows[0] ?? null);
      return row ? toOrganizationResource(row) : null;
    },

    createOrganizationResource: async (
      orgId: string,
      input: CreateOrganizationResourceRequest,
    ): Promise<OrganizationResource> => {
      const row = await createOrReuseOrganizationResource(db, orgId, input);
      return toOrganizationResource(row);
    },

    updateOrganizationResource: async (
      orgId: string,
      resourceId: string,
      input: UpdateOrganizationResourceRequest,
    ): Promise<OrganizationResource | null> => {
      const existing = await db
        .select()
        .from(organizationResources)
        .where(and(eq(organizationResources.orgId, orgId), eq(organizationResources.id, resourceId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      assertValidLibraryResource({
        sourceType: input.sourceType ?? existing.sourceType,
        kind: input.kind ?? existing.kind,
        locator: input.locator?.trim() ?? existing.locator,
      });
      const nextSourceType = input.sourceType ?? existing.sourceType;
      const nextLocator = input.locator?.trim() ?? existing.locator;
      if (nextSourceType === "library") {
        const duplicate = await db
          .select({ id: organizationResources.id })
          .from(organizationResources)
          .where(
            and(
              eq(organizationResources.orgId, orgId),
              eq(organizationResources.sourceType, "library"),
              eq(organizationResources.locator, nextLocator),
              ne(organizationResources.id, resourceId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (duplicate) {
          throw conflict("A Library resource already exists for this path.");
        }
      }

      const patch: Partial<typeof organizationResources.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.kind !== undefined) patch.kind = input.kind;
      if (input.sourceType !== undefined) patch.sourceType = input.sourceType;
      if (input.locator !== undefined) patch.locator = input.locator.trim();
      if (input.description !== undefined) patch.description = normalizeNullableText(input.description) ?? null;
      if (input.metadata !== undefined) patch.metadata = input.metadata;

      const row = await db
        .update(organizationResources)
        .set(patch)
        .where(and(eq(organizationResources.orgId, orgId), eq(organizationResources.id, resourceId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toOrganizationResource(row) : null;
    },

    removeOrganizationResource: async (orgId: string, resourceId: string): Promise<OrganizationResource | null> => {
      const row = await db
        .delete(organizationResources)
        .where(and(eq(organizationResources.orgId, orgId), eq(organizationResources.id, resourceId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toOrganizationResource(row) : null;
    },

    listProjectResourceAttachments: async (projectId: string): Promise<ProjectResourceAttachment[]> => {
      const orgId = await fetchProjectOrgId(db, projectId);
      if (!orgId) return [];
      return listProjectResourceAttachments(db, orgId, projectId);
    },

    replaceProjectResourceAttachments: async (input: {
      orgId: string;
      projectId: string;
      attachments: ProjectResourceAttachmentInput[];
      newResources?: CreateProjectInlineResourceInput[];
    }) => replaceProjectResourceAttachments(db, input),

    createProjectResourceAttachment: async (
      projectId: string,
      input: ProjectResourceAttachmentInput,
    ): Promise<ProjectResourceAttachment | null> => {
      const orgId = await fetchProjectOrgId(db, projectId);
      if (!orgId) return null;

      const resource = await db
        .select()
        .from(organizationResources)
        .where(and(eq(organizationResources.orgId, orgId), eq(organizationResources.id, input.resourceId)))
        .then((rows) => rows[0] ?? null);
      if (!resource) return null;

      const existing = await db
        .select()
        .from(projectResourceAttachments)
        .where(
          and(
            eq(projectResourceAttachments.projectId, projectId),
            eq(projectResourceAttachments.resourceId, input.resourceId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existing) {
        const updated = await db
          .update(projectResourceAttachments)
          .set({
            role: input.role ?? existing.role,
            note: normalizeNullableText(input.note) ?? existing.note ?? null,
            sortOrder: input.sortOrder ?? existing.sortOrder,
            updatedAt: new Date(),
          })
          .where(eq(projectResourceAttachments.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return updated ? toProjectResourceAttachment(updated, toOrganizationResource(resource)) : null;
      }

      const nextSortOrder = input.sortOrder ?? await db
        .select({ sortOrder: projectResourceAttachments.sortOrder })
        .from(projectResourceAttachments)
        .where(
          and(
            eq(projectResourceAttachments.orgId, orgId),
            eq(projectResourceAttachments.projectId, projectId),
          ),
        )
        .orderBy(desc(projectResourceAttachments.sortOrder))
        .then((rows) => (rows[0]?.sortOrder ?? -1) + 1);

      const row = await db
        .insert(projectResourceAttachments)
        .values({
          orgId,
          projectId,
          resourceId: input.resourceId,
          role: input.role ?? "reference",
          note: normalizeNullableText(input.note) ?? null,
          sortOrder: nextSortOrder,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toProjectResourceAttachment(row, toOrganizationResource(resource)) : null;
    },

    updateProjectResourceAttachment: async (
      projectId: string,
      attachmentId: string,
      input: UpdateProjectResourceAttachmentRequest,
    ): Promise<ProjectResourceAttachment | null> => {
      const existing = await db
        .select()
        .from(projectResourceAttachments)
        .where(and(eq(projectResourceAttachments.projectId, projectId), eq(projectResourceAttachments.id, attachmentId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const resource = await db
        .select()
        .from(organizationResources)
        .where(eq(organizationResources.id, existing.resourceId))
        .then((rows) => rows[0] ?? null);
      if (!resource) return null;

      const row = await db
        .update(projectResourceAttachments)
        .set({
          role: input.role ?? existing.role,
          note: input.note !== undefined ? normalizeNullableText(input.note) ?? null : existing.note ?? null,
          sortOrder: input.sortOrder ?? existing.sortOrder,
          updatedAt: new Date(),
        })
        .where(eq(projectResourceAttachments.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toProjectResourceAttachment(row, toOrganizationResource(resource)) : null;
    },

    removeProjectResourceAttachment: async (
      projectId: string,
      attachmentId: string,
    ): Promise<ProjectResourceAttachment | null> => {
      const existing = await db
        .select()
        .from(projectResourceAttachments)
        .where(and(eq(projectResourceAttachments.projectId, projectId), eq(projectResourceAttachments.id, attachmentId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const resource = await db
        .select()
        .from(organizationResources)
        .where(eq(organizationResources.id, existing.resourceId))
        .then((rows) => rows[0] ?? null);
      if (!resource) return null;

      const row = await db
        .delete(projectResourceAttachments)
        .where(eq(projectResourceAttachments.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toProjectResourceAttachment(row, toOrganizationResource(resource)) : null;
    },
  };
}
