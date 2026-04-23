import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@rudder/db";
import { projects, projectGoals, goals, projectWorkspaces, workspaceRuntimeServices } from "@rudder/db";
import {
  PROJECT_COLORS,
  deriveProjectUrlKey,
  isUuidLike,
  type CreateProjectInlineResourceInput,
  normalizeProjectUrlKey,
  type ProjectCodebase,
  type ProjectExecutionWorkspacePolicy,
  type ProjectGoalRef,
  type ProjectResourceAttachment,
  type ProjectResourceAttachmentInput,
  type ProjectWorkspace,
  type WorkspaceRuntimeService,
} from "@rudder/shared";
import { listWorkspaceRuntimeServicesForProjectWorkspaces } from "./workspace-runtime.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import {
  listProjectResourceAttachmentsByProjectIds,
  replaceProjectResourceAttachments,
} from "./resource-catalog.js";
import {
  ensureOrganizationWorkspaceLayout,
  resolveOrganizationWorkspaceRoot,
} from "../home-paths.js";

type ProjectRow = typeof projects.$inferSelect;
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
type CreateWorkspaceInput = {
  name?: string | null;
  sourceType?: string | null;
  cwd?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  defaultRef?: string | null;
  visibility?: string | null;
  setupCommand?: string | null;
  cleanupCommand?: string | null;
  remoteProvider?: string | null;
  remoteWorkspaceRef?: string | null;
  sharedWorkspaceKey?: string | null;
  metadata?: Record<string, unknown> | null;
  isPrimary?: boolean;
};
type UpdateWorkspaceInput = Partial<CreateWorkspaceInput>;

interface ProjectWithGoals extends Omit<ProjectRow, "executionWorkspacePolicy"> {
  urlKey: string;
  goalIds: string[];
  goals: ProjectGoalRef[];
  executionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  codebase: ProjectCodebase;
  resources: ProjectResourceAttachment[];
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
}

interface ProjectShortnameRow {
  id: string;
  name: string;
}

interface ResolveProjectNameOptions {
  excludeProjectId?: string | null;
}

/** Batch-load goal refs for a set of projects. */
async function attachGoals(db: Db, rows: ProjectRow[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);

  // Fetch join rows + goal titles in one query
  const links = await db
    .select({
      projectId: projectGoals.projectId,
      goalId: projectGoals.goalId,
      goalTitle: goals.title,
    })
    .from(projectGoals)
    .innerJoin(goals, eq(projectGoals.goalId, goals.id))
    .where(inArray(projectGoals.projectId, projectIds));

  const map = new Map<string, ProjectGoalRef[]>();
  for (const link of links) {
    let arr = map.get(link.projectId);
    if (!arr) {
      arr = [];
      map.set(link.projectId, arr);
    }
    arr.push({ id: link.goalId, title: link.goalTitle });
  }

  return rows.map((r) => {
    const g = map.get(r.id) ?? [];
    return {
      ...r,
      urlKey: deriveProjectUrlKey(r.name, r.id),
      goalIds: g.map((x) => x.id),
      goals: g,
      executionWorkspacePolicy: parseProjectExecutionWorkspacePolicy(r.executionWorkspacePolicy),
      codebase: deriveProjectCodebase({ orgId: r.orgId }),
      resources: [],
      workspaces: [],
      primaryWorkspace: null,
    } satisfies ProjectWithGoals;
  });
}

function toRuntimeService(row: WorkspaceRuntimeServiceRow): WorkspaceRuntimeService {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    scopeType: row.scopeType as WorkspaceRuntimeService["scopeType"],
    scopeId: row.scopeId ?? null,
    serviceName: row.serviceName,
    status: row.status as WorkspaceRuntimeService["status"],
    lifecycle: row.lifecycle as WorkspaceRuntimeService["lifecycle"],
    reuseKey: row.reuseKey ?? null,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    port: row.port ?? null,
    url: row.url ?? null,
    provider: row.provider as WorkspaceRuntimeService["provider"],
    providerRef: row.providerRef ?? null,
    ownerAgentId: row.ownerAgentId ?? null,
    startedByRunId: row.startedByRunId ?? null,
    lastUsedAt: row.lastUsedAt,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt ?? null,
    stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
    healthStatus: row.healthStatus as WorkspaceRuntimeService["healthStatus"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWorkspace(
  row: ProjectWorkspaceRow,
  runtimeServices: WorkspaceRuntimeService[] = [],
): ProjectWorkspace {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    name: row.name,
    sourceType: row.sourceType as ProjectWorkspace["sourceType"],
    cwd: normalizeWorkspaceCwd(row.cwd),
    repoUrl: row.repoUrl ?? null,
    repoRef: row.repoRef ?? null,
    defaultRef: row.defaultRef ?? row.repoRef ?? null,
    visibility: row.visibility as ProjectWorkspace["visibility"],
    setupCommand: row.setupCommand ?? null,
    cleanupCommand: row.cleanupCommand ?? null,
    remoteProvider: row.remoteProvider ?? null,
    remoteWorkspaceRef: row.remoteWorkspaceRef ?? null,
    sharedWorkspaceKey: row.sharedWorkspaceKey ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    isPrimary: row.isPrimary,
    runtimeServices,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function deriveProjectCodebase(input: {
  orgId: string;
}): ProjectCodebase {
  const localFolder = resolveOrganizationWorkspaceRoot(input.orgId);
  const managedFolder = localFolder;

  return {
    configured: true,
    scope: "organization",
    workspaceId: null,
    repoUrl: null,
    repoRef: null,
    defaultRef: null,
    repoName: null,
    localFolder,
    managedFolder,
    effectiveLocalFolder: localFolder,
    origin: "local_folder",
  };
}

function pickPrimaryWorkspace(
  rows: ProjectWorkspaceRow[],
  runtimeServicesByWorkspaceId?: Map<string, WorkspaceRuntimeService[]>,
): ProjectWorkspace | null {
  if (rows.length === 0) return null;
  const explicitPrimary = rows.find((row) => row.isPrimary);
  const primary = explicitPrimary ?? rows[0];
  return toWorkspace(primary, runtimeServicesByWorkspaceId?.get(primary.id) ?? []);
}

/** Batch-load workspace refs for a set of projects. */
async function attachWorkspaces(db: Db, rows: ProjectWithGoals[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);
  const orgIds = [...new Set(rows.map((row) => row.orgId))];
  await Promise.all(orgIds.map((orgId) => ensureOrganizationWorkspaceLayout(orgId)));
  const workspaceRows = await db
    .select()
    .from(projectWorkspaces)
    .where(inArray(projectWorkspaces.projectId, projectIds))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
  const runtimeServicesByWorkspaceId = await listWorkspaceRuntimeServicesForProjectWorkspaces(
    db,
    rows[0]!.orgId,
    workspaceRows.map((workspace) => workspace.id),
  );
  const sharedRuntimeServicesByWorkspaceId = new Map(
    Array.from(runtimeServicesByWorkspaceId.entries()).map(([workspaceId, services]) => [
      workspaceId,
      services.map(toRuntimeService),
    ]),
  );

  const map = new Map<string, ProjectWorkspaceRow[]>();
  for (const row of workspaceRows) {
    let arr = map.get(row.projectId);
    if (!arr) {
      arr = [];
      map.set(row.projectId, arr);
    }
    arr.push(row);
  }

  return rows.map((row) => {
    const projectWorkspaceRows = map.get(row.id) ?? [];
    const workspaces = projectWorkspaceRows.map((workspace) =>
      toWorkspace(
        workspace,
        sharedRuntimeServicesByWorkspaceId.get(workspace.id) ?? [],
      ),
    );
    const primaryWorkspace = pickPrimaryWorkspace(projectWorkspaceRows, sharedRuntimeServicesByWorkspaceId);
    return {
      ...row,
      codebase: deriveProjectCodebase({
        orgId: row.orgId,
      }),
      workspaces,
      primaryWorkspace,
    };
  });
}

/** Sync the project_goals join table for a single project. */
async function syncGoalLinks(dbOrTx: Db | any, projectId: string, orgId: string, goalIds: string[]) {
  // Delete existing links
  await dbOrTx.delete(projectGoals).where(eq(projectGoals.projectId, projectId));

  // Insert new links
  if (goalIds.length > 0) {
    await dbOrTx.insert(projectGoals).values(
      goalIds.map((goalId) => ({ projectId, goalId, orgId })),
    );
  }
}

async function attachResources(db: Db, rows: ProjectWithGoals[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((row) => row.id);
  const rowsByOrgId = new Map<string, ProjectWithGoals[]>();
  for (const row of rows) {
    const existing = rowsByOrgId.get(row.orgId);
    if (existing) existing.push(row);
    else rowsByOrgId.set(row.orgId, [row]);
  }

  const attachmentsByProjectId = new Map<string, ProjectResourceAttachment[]>();
  for (const [orgId, orgRows] of rowsByOrgId.entries()) {
    const byProjectId = await listProjectResourceAttachmentsByProjectIds(
      db,
      orgId,
      orgRows.map((row) => row.id),
    );
    for (const [projectId, attachments] of byProjectId.entries()) {
      attachmentsByProjectId.set(projectId, attachments);
    }
  }

  return rows.map((row) => ({
    ...row,
    resources: attachmentsByProjectId.get(row.id) ?? [],
  }));
}

/** Resolve goalIds from input, handling the legacy goalId field. */
function resolveGoalIds(data: { goalIds?: string[]; goalId?: string | null }): string[] | undefined {
  if (data.goalIds !== undefined) return data.goalIds;
  if (data.goalId !== undefined) {
    return data.goalId ? [data.goalId] : [];
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWorkspaceCwd(value: unknown): string | null {
  const cwd = readNonEmptyString(value);
  if (!cwd) return null;
  return cwd === REPO_ONLY_CWD_SENTINEL ? null : cwd;
}

function deriveNameFromCwd(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "Local folder";
}

function deriveNameFromRepoUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    const cleanedPath = url.pathname.replace(/\/+$/, "");
    const lastSegment = cleanedPath.split("/").filter(Boolean).pop() ?? "";
    const noGitSuffix = lastSegment.replace(/\.git$/i, "");
    return noGitSuffix || repoUrl;
  } catch {
    return repoUrl;
  }
}

function deriveWorkspaceName(input: {
  name?: string | null;
  cwd?: string | null;
  repoUrl?: string | null;
}) {
  const explicit = readNonEmptyString(input.name);
  if (explicit) return explicit;

  const cwd = readNonEmptyString(input.cwd);
  if (cwd) return deriveNameFromCwd(cwd);

  const repoUrl = readNonEmptyString(input.repoUrl);
  if (repoUrl) return deriveNameFromRepoUrl(repoUrl);

  return "Workspace";
}

export function resolveProjectNameForUniqueShortname(
  requestedName: string,
  existingProjects: ProjectShortnameRow[],
  options?: ResolveProjectNameOptions,
): string {
  const requestedShortname = normalizeProjectUrlKey(requestedName);
  if (!requestedShortname) return requestedName;

  const usedShortnames = new Set(
    existingProjects
      .filter((project) => !(options?.excludeProjectId && project.id === options.excludeProjectId))
      .map((project) => normalizeProjectUrlKey(project.name))
      .filter((value): value is string => value !== null),
  );
  if (!usedShortnames.has(requestedShortname)) return requestedName;

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidateName = `${requestedName} ${suffix}`;
    const candidateShortname = normalizeProjectUrlKey(candidateName);
    if (candidateShortname && !usedShortnames.has(candidateShortname)) {
      return candidateName;
    }
  }

  // Fallback guard for pathological naming collisions.
  return `${requestedName} ${Date.now()}`;
}

async function ensureSinglePrimaryWorkspace(
  dbOrTx: any,
  input: {
    orgId: string;
    projectId: string;
    keepWorkspaceId: string;
  },
) {
  await dbOrTx
    .update(projectWorkspaces)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(projectWorkspaces.orgId, input.orgId),
        eq(projectWorkspaces.projectId, input.projectId),
      ),
    );

  await dbOrTx
    .update(projectWorkspaces)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(
      and(
        eq(projectWorkspaces.orgId, input.orgId),
        eq(projectWorkspaces.projectId, input.projectId),
        eq(projectWorkspaces.id, input.keepWorkspaceId),
      ),
    );
}

export function projectService(db: Db) {
  return {
    list: async (orgId: string): Promise<ProjectWithGoals[]> => {
      const rows = await db.select().from(projects).where(eq(projects.orgId, orgId));
      const withGoals = await attachGoals(db, rows);
      const withWorkspaces = await attachWorkspaces(db, withGoals);
      return attachResources(db, withWorkspaces);
    },

    listByIds: async (orgId: string, ids: string[]): Promise<ProjectWithGoals[]> => {
      const dedupedIds = [...new Set(ids)];
      if (dedupedIds.length === 0) return [];
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.orgId, orgId), inArray(projects.id, dedupedIds)));
      const withGoals = await attachGoals(db, rows);
      const withWorkspaces = await attachWorkspaces(db, withGoals);
      const withResources = await attachResources(db, withWorkspaces);
      const byId = new Map(withResources.map((project) => [project.id, project]));
      return dedupedIds.map((id) => byId.get(id)).filter((project): project is ProjectWithGoals => Boolean(project));
    },

    getById: async (id: string): Promise<ProjectWithGoals | null> => {
      const row = await db
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [withGoals] = await attachGoals(db, [row]);
      if (!withGoals) return null;
      const [withWorkspaces] = await attachWorkspaces(db, [withGoals]);
      if (!withWorkspaces) return null;
      const [enriched] = await attachResources(db, [withWorkspaces]);
      return enriched ?? null;
    },

    create: async (
      orgId: string,
      data: Omit<typeof projects.$inferInsert, "orgId"> & {
        goalIds?: string[];
        resourceAttachments?: ProjectResourceAttachmentInput[];
        newResources?: CreateProjectInlineResourceInput[];
      },
    ): Promise<ProjectWithGoals> => {
      const {
        goalIds: inputGoalIds,
        resourceAttachments,
        newResources,
        ...projectData
      } = data;
      const ids = resolveGoalIds({ goalIds: inputGoalIds, goalId: projectData.goalId });

      // Auto-assign a color from the palette if none provided
      if (!projectData.color) {
        const existing = await db.select({ color: projects.color }).from(projects).where(eq(projects.orgId, orgId));
        const usedColors = new Set(existing.map((r) => r.color).filter(Boolean));
        const nextColor = PROJECT_COLORS.find((c) => !usedColors.has(c)) ?? PROJECT_COLORS[existing.length % PROJECT_COLORS.length];
        projectData.color = nextColor;
      }

      const existingProjects = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.orgId, orgId));
      projectData.name = resolveProjectNameForUniqueShortname(projectData.name, existingProjects);

      // Also write goalId to the legacy column (first goal or null)
      const legacyGoalId = ids && ids.length > 0 ? ids[0] : projectData.goalId ?? null;

      const row = await db.transaction(async (tx) => {
        const created = await tx
          .insert(projects)
          .values({ ...projectData, goalId: legacyGoalId, orgId })
          .returning()
          .then((rows) => rows[0]);

        if (ids && ids.length > 0) {
          await syncGoalLinks(tx, created.id, orgId, ids);
        }

        if ((resourceAttachments?.length ?? 0) > 0 || (newResources?.length ?? 0) > 0) {
          await replaceProjectResourceAttachments(tx, {
            orgId,
            projectId: created.id,
            attachments: resourceAttachments ?? [],
            newResources,
          });
        }

        return created;
      });

      await ensureOrganizationWorkspaceLayout(orgId);
      const [withGoals] = await attachGoals(db, [row]);
      const [withWorkspaces] = withGoals ? await attachWorkspaces(db, [withGoals]) : [];
      const [enriched] = withWorkspaces ? await attachResources(db, [withWorkspaces]) : [];
      return enriched!;
    },

    update: async (
      id: string,
      data: Partial<typeof projects.$inferInsert> & {
        goalIds?: string[];
        resourceAttachments?: ProjectResourceAttachmentInput[];
        newResources?: CreateProjectInlineResourceInput[];
      },
    ): Promise<ProjectWithGoals | null> => {
      const {
        goalIds: inputGoalIds,
        resourceAttachments,
        newResources,
        ...projectData
      } = data;
      const ids = resolveGoalIds({ goalIds: inputGoalIds, goalId: projectData.goalId });
      const existingProject = await db
        .select({ id: projects.id, orgId: projects.orgId, name: projects.name })
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existingProject) return null;

      if (projectData.name !== undefined) {
        const existingShortname = normalizeProjectUrlKey(existingProject.name);
        const nextShortname = normalizeProjectUrlKey(projectData.name);
        if (existingShortname !== nextShortname) {
          const existingProjects = await db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(eq(projects.orgId, existingProject.orgId));
          projectData.name = resolveProjectNameForUniqueShortname(projectData.name, existingProjects, {
            excludeProjectId: id,
          });
        }
      }

      // Keep legacy goalId column in sync
      const updates: Partial<typeof projects.$inferInsert> = {
        ...projectData,
        updatedAt: new Date(),
      };
      if (ids !== undefined) {
        updates.goalId = ids.length > 0 ? ids[0] : null;
      }

      const existingAttachments = resourceAttachments !== undefined || newResources !== undefined
        ? await listProjectResourceAttachmentsByProjectIds(db, existingProject.orgId, [id]).then((byProjectId) =>
          byProjectId.get(id) ?? [],
        )
        : [];

      const row = await db.transaction(async (tx) => {
        const updatedRow = await tx
          .update(projects)
          .set(updates)
          .where(eq(projects.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updatedRow) return null;

        if (ids !== undefined) {
          await syncGoalLinks(tx, id, updatedRow.orgId, ids);
        }

        if (resourceAttachments !== undefined || newResources !== undefined) {
          await replaceProjectResourceAttachments(tx, {
            orgId: updatedRow.orgId,
            projectId: id,
            attachments: resourceAttachments ?? existingAttachments.map((attachment) => ({
              resourceId: attachment.resourceId,
              role: attachment.role,
              note: attachment.note,
              sortOrder: attachment.sortOrder,
            })),
            newResources,
          });
        }

        return updatedRow;
      });
      if (!row) return null;

      const [withGoals] = await attachGoals(db, [row]);
      const [withWorkspaces] = withGoals ? await attachWorkspaces(db, [withGoals]) : [];
      const [enriched] = withWorkspaces ? await attachResources(db, [withWorkspaces]) : [];
      return enriched ?? null;
    },

    remove: (id: string) =>
      db
        .delete(projects)
        .where(eq(projects.id, id))
        .returning()
        .then((rows) => {
          const row = rows[0] ?? null;
          if (!row) return null;
          return { ...row, urlKey: deriveProjectUrlKey(row.name, row.id) };
        }),

    listWorkspaces: async (projectId: string): Promise<ProjectWorkspace[]> => {
      const rows = await db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
      if (rows.length === 0) return [];
      const runtimeServicesByWorkspaceId = await listWorkspaceRuntimeServicesForProjectWorkspaces(
        db,
        rows[0]!.orgId,
        rows.map((workspace) => workspace.id),
      );
      return rows.map((row) =>
        toWorkspace(
          row,
          (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
        ),
      );
    },

    createWorkspace: async (
      projectId: string,
      data: CreateWorkspaceInput,
    ): Promise<ProjectWorkspace | null> => {
      const project = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .then((rows) => rows[0] ?? null);
      if (!project) return null;

      const cwd = normalizeWorkspaceCwd(data.cwd);
      const repoUrl = readNonEmptyString(data.repoUrl);
      const sourceType = readNonEmptyString(data.sourceType) ?? (repoUrl ? "git_repo" : cwd ? "local_path" : "remote_managed");
      const remoteWorkspaceRef = readNonEmptyString(data.remoteWorkspaceRef);
      if (sourceType === "remote_managed") {
        if (!remoteWorkspaceRef && !repoUrl) return null;
      } else if (!cwd && !repoUrl) {
        return null;
      }
      const name = deriveWorkspaceName({
        name: data.name,
        cwd,
        repoUrl,
      });

      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .orderBy(asc(projectWorkspaces.createdAt))
        .then((rows) => rows);

      const shouldBePrimary = data.isPrimary === true || existing.length === 0;
      const created = await db.transaction(async (tx) => {
        if (shouldBePrimary) {
          await tx
            .update(projectWorkspaces)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(projectWorkspaces.orgId, project.orgId),
                eq(projectWorkspaces.projectId, projectId),
              ),
            );
        }

        const row = await tx
          .insert(projectWorkspaces)
          .values({
            orgId: project.orgId,
            projectId,
            name,
            sourceType,
            cwd: cwd ?? null,
            repoUrl: repoUrl ?? null,
            repoRef: readNonEmptyString(data.repoRef),
            defaultRef: readNonEmptyString(data.defaultRef) ?? readNonEmptyString(data.repoRef),
            visibility: readNonEmptyString(data.visibility) ?? "default",
            setupCommand: readNonEmptyString(data.setupCommand),
            cleanupCommand: readNonEmptyString(data.cleanupCommand),
            remoteProvider: readNonEmptyString(data.remoteProvider),
            remoteWorkspaceRef,
            sharedWorkspaceKey: readNonEmptyString(data.sharedWorkspaceKey),
            metadata: (data.metadata as Record<string, unknown> | null | undefined) ?? null,
            isPrimary: shouldBePrimary,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        return row;
      });

      return created ? toWorkspace(created) : null;
    },

    updateWorkspace: async (
      projectId: string,
      workspaceId: string,
      data: UpdateWorkspaceInput,
    ): Promise<ProjectWorkspace | null> => {
      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.id, workspaceId),
            eq(projectWorkspaces.projectId, projectId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const nextCwd =
        data.cwd !== undefined
          ? normalizeWorkspaceCwd(data.cwd)
          : normalizeWorkspaceCwd(existing.cwd);
      const nextRepoUrl =
        data.repoUrl !== undefined
          ? readNonEmptyString(data.repoUrl)
          : readNonEmptyString(existing.repoUrl);
      const nextSourceType =
        data.sourceType !== undefined
          ? readNonEmptyString(data.sourceType)
          : readNonEmptyString(existing.sourceType);
      const nextRemoteWorkspaceRef =
        data.remoteWorkspaceRef !== undefined
          ? readNonEmptyString(data.remoteWorkspaceRef)
          : readNonEmptyString(existing.remoteWorkspaceRef);
      if (nextSourceType === "remote_managed") {
        if (!nextRemoteWorkspaceRef && !nextRepoUrl) return null;
      } else if (!nextCwd && !nextRepoUrl) {
        return null;
      }

      const patch: Partial<typeof projectWorkspaces.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (data.name !== undefined) patch.name = deriveWorkspaceName({ name: data.name, cwd: nextCwd, repoUrl: nextRepoUrl });
      if (data.name === undefined && (data.cwd !== undefined || data.repoUrl !== undefined)) {
        patch.name = deriveWorkspaceName({ cwd: nextCwd, repoUrl: nextRepoUrl });
      }
      if (data.cwd !== undefined) patch.cwd = nextCwd ?? null;
      if (data.repoUrl !== undefined) patch.repoUrl = nextRepoUrl ?? null;
      if (data.repoRef !== undefined) patch.repoRef = readNonEmptyString(data.repoRef);
      if (data.sourceType !== undefined && nextSourceType) patch.sourceType = nextSourceType;
      if (data.defaultRef !== undefined) patch.defaultRef = readNonEmptyString(data.defaultRef);
      if (data.visibility !== undefined && readNonEmptyString(data.visibility)) {
        patch.visibility = readNonEmptyString(data.visibility)!;
      }
      if (data.setupCommand !== undefined) patch.setupCommand = readNonEmptyString(data.setupCommand);
      if (data.cleanupCommand !== undefined) patch.cleanupCommand = readNonEmptyString(data.cleanupCommand);
      if (data.remoteProvider !== undefined) patch.remoteProvider = readNonEmptyString(data.remoteProvider);
      if (data.remoteWorkspaceRef !== undefined) patch.remoteWorkspaceRef = nextRemoteWorkspaceRef;
      if (data.sharedWorkspaceKey !== undefined) patch.sharedWorkspaceKey = readNonEmptyString(data.sharedWorkspaceKey);
      if (data.metadata !== undefined) patch.metadata = data.metadata;

      const updated = await db.transaction(async (tx) => {
        if (data.isPrimary === true) {
          await tx
            .update(projectWorkspaces)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(projectWorkspaces.orgId, existing.orgId),
                eq(projectWorkspaces.projectId, projectId),
              ),
            );
          patch.isPrimary = true;
        } else if (data.isPrimary === false) {
          patch.isPrimary = false;
        }

        const row = await tx
          .update(projectWorkspaces)
          .set(patch)
          .where(eq(projectWorkspaces.id, workspaceId))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) return null;

        if (row.isPrimary) return row;

        const hasPrimary = await tx
          .select({ id: projectWorkspaces.id })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.orgId, row.orgId),
              eq(projectWorkspaces.projectId, row.projectId),
              eq(projectWorkspaces.isPrimary, true),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (!hasPrimary) {
          const nextPrimaryCandidate = await tx
            .select({ id: projectWorkspaces.id })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.orgId, row.orgId),
                eq(projectWorkspaces.projectId, row.projectId),
                eq(projectWorkspaces.id, row.id),
              ),
            )
            .then((rows) => rows[0] ?? null);
          const alternateCandidate = await tx
            .select({ id: projectWorkspaces.id })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.orgId, row.orgId),
                eq(projectWorkspaces.projectId, row.projectId),
              ),
            )
            .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
            .then((rows) => rows.find((candidate) => candidate.id !== row.id) ?? null);

          await ensureSinglePrimaryWorkspace(tx, {
            orgId: row.orgId,
            projectId: row.projectId,
            keepWorkspaceId: alternateCandidate?.id ?? nextPrimaryCandidate?.id ?? row.id,
          });
          const refreshed = await tx
            .select()
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.id, row.id))
            .then((rows) => rows[0] ?? row);
          return refreshed;
        }

        return row;
      });

      return updated ? toWorkspace(updated) : null;
    },

    removeWorkspace: async (projectId: string, workspaceId: string): Promise<ProjectWorkspace | null> => {
      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.id, workspaceId),
            eq(projectWorkspaces.projectId, projectId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const removed = await db.transaction(async (tx) => {
        const row = await tx
          .delete(projectWorkspaces)
          .where(eq(projectWorkspaces.id, workspaceId))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) return null;

        if (!row.isPrimary) return row;

        const next = await tx
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.orgId, row.orgId),
              eq(projectWorkspaces.projectId, row.projectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (next) {
          await ensureSinglePrimaryWorkspace(tx, {
            orgId: row.orgId,
            projectId: row.projectId,
            keepWorkspaceId: next.id,
          });
        }

        return row;
      });

      return removed ? toWorkspace(removed) : null;
    },

    resolveByReference: async (orgId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { project: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const row = await db
          .select({ id: projects.id, orgId: projects.orgId, name: projects.name })
          .from(projects)
          .where(and(eq(projects.id, raw), eq(projects.orgId, orgId)))
          .then((rows) => rows[0] ?? null);
        if (!row) return { project: null, ambiguous: false } as const;
        return {
          project: { id: row.id, orgId: row.orgId, urlKey: deriveProjectUrlKey(row.name, row.id) },
          ambiguous: false,
        } as const;
      }

      const urlKey = normalizeProjectUrlKey(raw);
      if (!urlKey) {
        return { project: null, ambiguous: false } as const;
      }

      const rows = await db
        .select({ id: projects.id, orgId: projects.orgId, name: projects.name })
        .from(projects)
        .where(eq(projects.orgId, orgId));
      const matches = rows.filter((row) => deriveProjectUrlKey(row.name, row.id) === urlKey);
      if (matches.length === 1) {
        const match = matches[0]!;
        return {
          project: { id: match.id, orgId: match.orgId, urlKey: deriveProjectUrlKey(match.name, match.id) },
          ambiguous: false,
        } as const;
      }
      if (matches.length > 1) {
        return { project: null, ambiguous: true } as const;
      }
      return { project: null, ambiguous: false } as const;
    },
  };
}
