import type { Db } from "@rudderhq/db";
import { agents, goals, projectGoalMutationState, projectGoals, projectWorkspaces, projects, workspaceRuntimeServices } from "@rudderhq/db";
import {
  DEFAULT_PROJECT_ICON,
  PROJECT_COLORS,
  deriveProjectUrlKey,
  isUuidLike,
  normalizeProjectUrlKey,
  parseShortRef,
  shortRefFor,
  type CreateProjectInlineResourceInput,
  type ProjectCodebase,
  type ProjectExecutionWorkspacePolicy,
  type ProjectGoalRef,
  type ProjectResourceAttachment,
  type ProjectResourceAttachmentInput,
  type ProjectWorkspace,
  type WorkspaceRuntimeService,
} from "@rudderhq/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HttpError, conflict, forbidden, unauthorized, unprocessable } from "../errors.js";
import {
  ensureOrganizationWorkspaceLayout,
  ensureProjectLibraryLayout,
  resolveOrganizationWorkspaceRoot,
  resolveRudderInstanceRoot,
} from "../home-paths.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { lockNodeMutationAuthority } from "./organization-mutation-fence.js";
import {
  lockNodeProjectGoalMutationAuthority,
} from "./project-goal-mutation-fence.js";
import {
  listProjectResourceAttachmentsByProjectIds,
  replaceProjectResourceAttachments,
} from "./resource-catalog.js";
import type { RustFoundationActor, RustFoundationBridge } from "./rust-foundation-bridge.js";
import { listWorkspaceRuntimeServicesForProjectWorkspaces } from "./workspace-runtime.js";

export type ProjectCreateContext =
  | { lane: "node"; caller: "import" }
  | {
    lane: "rust";
    caller: "public" | "onboarding";
    actor: RustFoundationActor;
    idempotencyKey?: string | null;
  };

type ProjectRow = typeof projects.$inferSelect;
// Legacy project workspace rows are still attached for compatibility with old
// data and runtime workspace resolution. Do not treat these helpers as a new
// user-facing Project Workspace management surface.
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
type WorkspaceImportIdentity = {
  importKey: string;
  portableWorkspaceKey: string;
};
type WorkspaceImportValues = Pick<
  ProjectWorkspaceRow,
  | "orgId"
  | "projectId"
  | "name"
  | "sourceType"
  | "cwd"
  | "repoUrl"
  | "repoRef"
  | "defaultRef"
  | "visibility"
  | "setupCommand"
  | "cleanupCommand"
  | "remoteProvider"
  | "remoteWorkspaceRef"
  | "sharedWorkspaceKey"
  | "metadata"
>;
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

function deriveImportedProjectWorkspaceId(
  orgId: string,
  projectId: string,
  identity: WorkspaceImportIdentity,
) {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const digest = createHash("sha1")
    .update(namespace)
    .update(JSON.stringify([
      "rudder:project-workspace-import:v1",
      identity.importKey,
      orgId,
      projectId,
      identity.portableWorkspaceKey,
    ]))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function matchesImportedWorkspace(row: ProjectWorkspaceRow, expected: WorkspaceImportValues) {
  return row.orgId === expected.orgId
    && row.projectId === expected.projectId
    && row.name === expected.name
    && row.sourceType === expected.sourceType
    && row.cwd === expected.cwd
    && row.repoUrl === expected.repoUrl
    && row.repoRef === expected.repoRef
    && row.defaultRef === expected.defaultRef
    && row.visibility === expected.visibility
    && row.setupCommand === expected.setupCommand
    && row.cleanupCommand === expected.cleanupCommand
    && row.remoteProvider === expected.remoteProvider
    && row.remoteWorkspaceRef === expected.remoteWorkspaceRef
    && row.sharedWorkspaceKey === expected.sharedWorkspaceKey
    && isDeepStrictEqual(row.metadata, expected.metadata);
}

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

function safeShortRef(kind: "goal" | "project", id: string): string | undefined {
  try {
    return shortRefFor(kind, id);
  } catch {
    return undefined;
  }
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
    arr.push({ id: link.goalId, ...(safeShortRef("goal", link.goalId) ? { shortRef: safeShortRef("goal", link.goalId) } : {}), title: link.goalTitle });
  }

  return rows.map((r) => {
    const g = map.get(r.id) ?? [];
    return {
      ...r,
      ...(safeShortRef("project", r.id) ? { shortRef: safeShortRef("project", r.id) } : {}),
      icon: r.icon ?? DEFAULT_PROJECT_ICON,
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
  await Promise.all([
    ...orgIds.map((orgId) => ensureOrganizationWorkspaceLayout(orgId)),
    ...rows.map((row) =>
      ensureProjectLibraryLayout({
        orgId: row.orgId,
        projectId: row.id,
        projectName: row.name,
        projectUrlKey: row.urlKey,
      }),
    ),
  ]);
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
  await dbOrTx
    .delete(projectGoals)
    .where(and(eq(projectGoals.projectId, projectId), eq(projectGoals.orgId, orgId)));

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

async function assertGoalsBelongToOrganization(db: Pick<Db, "select">, orgId: string, goalIds: string[] | undefined) {
  if (goalIds === undefined || goalIds.length === 0) return;

  const uniqueGoalIds = [...new Set(goalIds)];
  const rows = await db
    .select({ id: goals.id })
    .from(goals)
    .where(and(eq(goals.orgId, orgId), inArray(goals.id, uniqueGoalIds)));

  if (rows.length !== uniqueGoalIds.length) {
    throw unprocessable("Goals must belong to same organization");
  }
}

async function assertLeadAgentBelongsToOrganization(db: Pick<Db, "select">, orgId: string, leadAgentId: string | null | undefined) {
  if (!leadAgentId) return;

  const row = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, leadAgentId), eq(agents.orgId, orgId)))
    .then((rows) => rows[0] ?? null);

  if (!row) {
    throw unprocessable("Lead agent must belong to same organization");
  }
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

export function projectService(db: Db, rustFoundationBridge?: RustFoundationBridge) {
  return {
    // Admission only: public reads hydrate in Rust after organization access
    // has been checked, without invoking legacy read-time Library provisioning.
    getOrganizationId: async (id: string): Promise<string | null> => {
      if (!isUuidLike(id)) return null;
      const [row] = await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, id));
      return row?.orgId ?? null;
    },

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

    getMutationOwner: async (orgId: string, projectId: string): Promise<"node" | "rust" | null> => {
      const row = await db
        .select({ owner: projectGoalMutationState.owner })
        .from(projectGoalMutationState)
        .where(and(
          eq(projectGoalMutationState.orgId, orgId),
          eq(projectGoalMutationState.projectId, projectId),
        ))
        .then((rows) => rows[0] ?? null);
      return row?.owner ?? null;
    },

    create: async (
      orgId: string,
      data: Omit<typeof projects.$inferInsert, "orgId"> & {
        goalIds?: string[];
        resourceAttachments?: ProjectResourceAttachmentInput[];
        newResources?: CreateProjectInlineResourceInput[];
      },
      context: ProjectCreateContext,
    ): Promise<ProjectWithGoals> => {
      // Lane selection is trusted caller context, never a field of data. Once
      // dispatched to Rust, any failure ends this invocation without Node writes.
      if (!context) throw forbidden("Project creation requires an explicit trusted authority lane");
      if (context.lane === "rust") {
        if (context.caller !== "public" && context.caller !== "onboarding") {
          throw forbidden("Caller is not eligible for Rust Project creation");
        }
        const actor = context.actor;
        if (actor.type === "none") throw unauthorized();
        if (context.caller === "onboarding" && actor.type !== "board") {
          throw forbidden("Board access required");
        }
        if (actor.type === "agent" && actor.orgId !== orgId) {
          throw forbidden("Agent key cannot access another organization");
        }
        if (actor.type === "board" && actor.source !== "local_implicit"
          && !actor.isInstanceAdmin && !actor.orgIds?.includes(orgId)) {
          throw forbidden("User does not have access to this organization");
        }
        if (rustFoundationBridge?.projectGoalSetMode !== "required") {
          throw new HttpError(503, "Rust Project creation is not enabled");
        }
        const idempotencyKey = context.idempotencyKey?.trim() || randomUUID();
        // Organization layout remains Node-owned, including friendly mapping,
        // migration and ownership checks. Rust owns only Project provisioning.
        const organizationLayout = await ensureOrganizationWorkspaceLayout(orgId);
        const roots = {
          organizationWorkspaceRoot: organizationLayout.root,
          projectCreateStateRoot: join(resolveRudderInstanceRoot(), "data"),
        };
        let response;
        try {
          response = await rustFoundationBridge.projectCreate(
            actor, orgId, data, idempotencyKey, {}, roots,
          );
        } catch {
          throw new HttpError(503, "Rust Project creation is unavailable");
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(response.body.toString("utf8"));
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid response");
        } catch {
          throw new HttpError(502, "Rust Project creation returned an invalid response");
        }
        if (response.status !== 201) {
          throw new HttpError(
            response.status >= 400 && response.status <= 599 ? response.status : 502,
            typeof body.error === "string" ? body.error : "Rust Project creation failed",
            body.details,
          );
        }
        if (typeof body.id !== "string" || body.orgId !== orgId) {
          throw new HttpError(502, "Rust Project creation returned an invalid scope");
        }
        // The receipt contains the complete response. Live hydration would
        // provision Library paths again, including on replay after deletion.
        return body as unknown as ProjectWithGoals;
      }
      if (context.lane !== "node" || context.caller !== "import") {
        throw forbidden("Node Project creation is reserved for organization import");
      }
      const {
        goalIds: inputGoalIds,
        resourceAttachments,
        newResources,
        ...projectData
      } = data;
      const ids = resolveGoalIds({ goalIds: inputGoalIds, goalId: projectData.goalId });
      const projectId = projectData.id ?? randomUUID();

      // Also write goalId to the legacy column (first goal or null)
      const legacyGoalId = ids !== undefined ? (ids[0] ?? null) : projectData.goalId ?? null;

      const row = await db.transaction(async (tx) => {
        await lockNodeMutationAuthority(tx, orgId);
        await assertGoalsBelongToOrganization(tx, orgId, ids);
        await assertLeadAgentBelongsToOrganization(tx, orgId, projectData.leadAgentId);
        const existingProjects = await tx
          .select({ id: projects.id, name: projects.name, color: projects.color })
          .from(projects)
          .where(eq(projects.orgId, orgId));
        if (!projectData.color) {
          const usedColors = new Set(existingProjects.map((project) => project.color).filter(Boolean));
          projectData.color = PROJECT_COLORS.find((color) => !usedColors.has(color))
            ?? PROJECT_COLORS[existingProjects.length % PROJECT_COLORS.length];
        }
        projectData.icon = projectData.icon ?? DEFAULT_PROJECT_ICON;
        projectData.name = resolveProjectNameForUniqueShortname(projectData.name, existingProjects);
        await ensureProjectLibraryLayout({
          orgId,
          projectId,
          projectName: projectData.name,
          projectUrlKey: deriveProjectUrlKey(projectData.name, projectId),
        });
        const created = await tx
          .insert(projects)
          .values({ ...projectData, id: projectId, goalId: legacyGoalId, orgId })
          .returning()
          .then((rows) => rows[0]);

        // The insert trigger provisions the component row. Acquire it only
        // when this create actually writes the Project-Goal component; plain
        // Project creation remains independent of the migrated writer.
        if (ids !== undefined) {
          await lockNodeProjectGoalMutationAuthority(tx, orgId, created.id);
        }

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
      await assertGoalsBelongToOrganization(db, existingProject.orgId, ids);
      if (projectData.leadAgentId !== undefined) {
        await assertLeadAgentBelongsToOrganization(db, existingProject.orgId, projectData.leadAgentId);
      }

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
        await lockNodeProjectGoalMutationAuthority(tx, existingProject.orgId, id);
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
              isPrimary: attachment.isPrimary,
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
      db.transaction(async (tx) => {
        const existing = await tx
          .select({ orgId: projects.orgId })
          .from(projects)
          .where(eq(projects.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await lockNodeProjectGoalMutationAuthority(tx, existing.orgId, id);
        const row = await tx
          .delete(projects)
          .where(eq(projects.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        return { ...row, icon: row.icon ?? DEFAULT_PROJECT_ICON, urlKey: deriveProjectUrlKey(row.name, row.id) };
      }),

    // Legacy internal Project Workspace CRUD. These methods are intentionally
    // not exposed by project routes; current product flows resolve codebases and
    // run workspaces through newer organization/runtime surfaces.
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
      importIdentity?: WorkspaceImportIdentity,
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
      if (importIdentity && (!importIdentity.importKey.trim() || !importIdentity.portableWorkspaceKey.trim())) {
        throw unprocessable("Idempotent workspace imports require an import key and portable workspace key");
      }
      const importWorkspaceId = importIdentity
        ? deriveImportedProjectWorkspaceId(project.orgId, projectId, importIdentity)
        : null;
      const workspaceValues: WorkspaceImportValues = {
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
      };

      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .orderBy(asc(projectWorkspaces.createdAt))
        .then((rows) => rows);

      const shouldBePrimary = data.isPrimary === true || existing.length === 0;
      const created = await db.transaction(async (tx) => {
        await lockNodeMutationAuthority(tx, project.orgId);
        if (importWorkspaceId) {
          const existingImportedWorkspace = await tx
            .select()
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.id, importWorkspaceId))
            .then((rows) => rows[0] ?? null);
          if (existingImportedWorkspace) {
            if (!matchesImportedWorkspace(existingImportedWorkspace, workspaceValues)) {
              throw conflict("Project workspace import key conflicts with existing workspace content");
            }
            return existingImportedWorkspace;
          }
        }
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
            ...(importWorkspaceId ? { id: importWorkspaceId } : {}),
            ...workspaceValues,
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
        await lockNodeMutationAuthority(tx, existing.orgId);
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
      const removed = await db.transaction(async (tx) => {
        const existing = await tx
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

        await lockNodeMutationAuthority(tx, existing.orgId);
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

      const shortRef = parseShortRef(raw);
      if (shortRef?.kind === "project") {
        const rows = await db
          .select({ id: projects.id, orgId: projects.orgId, name: projects.name })
          .from(projects)
          .where(eq(projects.orgId, orgId));
        const matches = rows.filter((row) => row.id.replaceAll("-", "").toLowerCase().startsWith(shortRef.prefix));
        if (matches.length === 1) {
          const match = matches[0]!;
          return {
            project: { id: match.id, orgId: match.orgId, urlKey: deriveProjectUrlKey(match.name, match.id) },
            ambiguous: false,
          } as const;
        }
        return { project: null, ambiguous: matches.length > 1 } as const;
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
