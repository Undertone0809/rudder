import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  agents,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  costEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  organizations,
} from "@rudderhq/db";
import type { AgentRuntimeType } from "@rudderhq/shared";
import { isUuidLike, normalizeAgentUrlKey } from "@rudderhq/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { resolveHomeAwarePath, resolveOrganizationAgentsDir } from "../home-paths.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";
import { deriveUniqueAgentWorkspaceKey } from "../agent-workspace-key.js";
import { pickUniqueAgentName } from "./agent-name-pool.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "reportsTo",
  "capabilities",
  "agentRuntimeType",
  "agentRuntimeConfig",
  "runtimeConfig",
  "budgetMonthlyCents",
  "metadata",
] as const;

const ORGANIZATION_DEFAULT_CHAT_RUNTIME_TYPES = new Set<AgentRuntimeType>([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "openclaw_gateway",
]);

const ORGANIZATION_DEFAULT_CHAT_CONFIG_KEYS_TO_STRIP = new Set([
  "promptTemplate",
  "bootstrapPromptTemplate",
  "instructionsFilePath",
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "agentsMdPath",
  "rudderSkillSync",
  "paperclipSkillSync",
  "rudderRuntimeSkills",
  "paperclipRuntimeSkills",
]);

type ConfigRevisionField = (typeof CONFIG_REVISION_FIELDS)[number];
type AgentConfigSnapshot = Pick<typeof agents.$inferSelect, ConfigRevisionField>;

interface RevisionMetadata {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  source?: string;
  rolledBackFromRevisionId?: string | null;
}

interface UpdateAgentOptions {
  recordRevision?: RevisionMetadata;
}

interface AgentShortnameRow {
  id: string;
  name: string;
  status: string;
  workspaceKey?: string | null;
}

interface AgentShortnameCollisionOptions {
  excludeAgentId?: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHiddenSystemAgentMetadata(metadata: unknown) {
  if (!isPlainRecord(metadata)) return false;
  return metadata.hidden === true || metadata.systemManaged === "rudder_copilot";
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sanitizeOrganizationDefaultChatConfig(agentRuntimeConfig: unknown): Record<string, unknown> {
  const sanitized = sanitizeRecord(isPlainRecord(agentRuntimeConfig) ? agentRuntimeConfig : {});
  for (const key of ORGANIZATION_DEFAULT_CHAT_CONFIG_KEYS_TO_STRIP) {
    delete sanitized[key];
  }
  return sanitized;
}

function buildConfigSnapshot(
  row: Pick<typeof agents.$inferSelect, ConfigRevisionField>,
): AgentConfigSnapshot {
  const agentRuntimeConfig =
    typeof row.agentRuntimeConfig === "object" && row.agentRuntimeConfig !== null && !Array.isArray(row.agentRuntimeConfig)
      ? sanitizeRecord(row.agentRuntimeConfig as Record<string, unknown>)
      : {};
  const runtimeConfig =
    typeof row.runtimeConfig === "object" && row.runtimeConfig !== null && !Array.isArray(row.runtimeConfig)
      ? sanitizeRecord(row.runtimeConfig as Record<string, unknown>)
      : {};
  const metadata =
    typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
      ? sanitizeRecord(row.metadata as Record<string, unknown>)
      : row.metadata ?? null;
  return {
    name: row.name,
    role: row.role,
    title: row.title,
    reportsTo: row.reportsTo,
    capabilities: row.capabilities,
    agentRuntimeType: row.agentRuntimeType,
    agentRuntimeConfig,
    runtimeConfig,
    budgetMonthlyCents: row.budgetMonthlyCents,
    metadata,
  };
}

function containsRedactedMarker(value: unknown): boolean {
  if (value === REDACTED_EVENT_VALUE) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedMarker(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((entry) => containsRedactedMarker(entry));
}

function hasConfigPatchFields(data: Partial<typeof agents.$inferInsert>) {
  return CONFIG_REVISION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractWorkspaceKeyFromManagedInstructionsConfig(
  orgId: string,
  agentRuntimeConfig: unknown,
): string | null {
  if (!isPlainRecord(agentRuntimeConfig)) return null;
  const managedAgentsRoot = path.resolve(resolveOrganizationAgentsDir(orgId));
  const candidatePaths = [
    readNonEmptyString(agentRuntimeConfig.instructionsRootPath),
    readNonEmptyString(agentRuntimeConfig.instructionsFilePath),
    readNonEmptyString(agentRuntimeConfig.agentsMdPath),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => resolveHomeAwarePath(value));

  for (const candidatePath of candidatePaths) {
    const relativePath = path.relative(managedAgentsRoot, candidatePath);
    if (
      relativePath.length === 0
      || relativePath === ".."
      || relativePath.startsWith(`..${path.sep}`)
    ) {
      continue;
    }
    const segments = relativePath.split(path.sep).filter((segment) => segment.length > 0);
    const instructionsIndex = segments.indexOf("instructions");
    if (instructionsIndex <= 0) continue;
    const workspaceKey = segments[instructionsIndex - 1]?.trim();
    if (workspaceKey) return workspaceKey;
  }

  return null;
}

function diffConfigSnapshot(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): string[] {
  return CONFIG_REVISION_FIELDS.filter((field) => !jsonEqual(before[field], after[field]));
}

function configPatchFromSnapshot(snapshot: unknown): Partial<typeof agents.$inferInsert> {
  if (!isPlainRecord(snapshot)) throw unprocessable("Invalid revision snapshot");

  if (typeof snapshot.name !== "string" || snapshot.name.length === 0) {
    throw unprocessable("Invalid revision snapshot: name");
  }
  if (typeof snapshot.role !== "string" || snapshot.role.length === 0) {
    throw unprocessable("Invalid revision snapshot: role");
  }
  if (typeof snapshot.agentRuntimeType !== "string" || snapshot.agentRuntimeType.length === 0) {
    throw unprocessable("Invalid revision snapshot: agentRuntimeType");
  }
  if (typeof snapshot.budgetMonthlyCents !== "number" || !Number.isFinite(snapshot.budgetMonthlyCents)) {
    throw unprocessable("Invalid revision snapshot: budgetMonthlyCents");
  }

  return {
    name: snapshot.name,
    role: snapshot.role,
    title: typeof snapshot.title === "string" || snapshot.title === null ? snapshot.title : null,
    reportsTo:
      typeof snapshot.reportsTo === "string" || snapshot.reportsTo === null ? snapshot.reportsTo : null,
    capabilities:
      typeof snapshot.capabilities === "string" || snapshot.capabilities === null
        ? snapshot.capabilities
        : null,
    agentRuntimeType: snapshot.agentRuntimeType,
    agentRuntimeConfig: isPlainRecord(snapshot.agentRuntimeConfig) ? snapshot.agentRuntimeConfig : {},
    runtimeConfig: isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
    budgetMonthlyCents: Math.max(0, Math.floor(snapshot.budgetMonthlyCents)),
    metadata: isPlainRecord(snapshot.metadata) || snapshot.metadata === null ? snapshot.metadata : null,
  };
}

export function hasAgentShortnameCollision(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
  options?: AgentShortnameCollisionOptions,
): boolean {
  const candidateShortname = normalizeAgentUrlKey(candidateName);
  if (!candidateShortname) return false;

  return existingAgents.some((agent) => {
    if (agent.status === "terminated") return false;
    if (options?.excludeAgentId && agent.id === options.excludeAgentId) return false;
    return normalizeAgentUrlKey(agent.name) === candidateShortname;
  });
}

export function deduplicateAgentName(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
): string {
  if (!hasAgentShortnameCollision(candidateName, existingAgents)) {
    return candidateName;
  }
  for (let i = 2; i <= 100; i++) {
    const suffixed = `${candidateName} ${i}`;
    if (!hasAgentShortnameCollision(suffixed, existingAgents)) {
      return suffixed;
    }
  }
  return `${candidateName} ${Date.now()}`;
}

export function agentService(db: Db) {
  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  function withUrlKey<T extends { id: string; name: string }>(row: T) {
    return {
      ...row,
      urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    };
  }

  function normalizeAgentInternalRow(row: typeof agents.$inferSelect) {
    return withUrlKey({
      ...row,
      permissions: normalizeAgentPermissions(row.permissions, row.role),
    });
  }

  function stripWorkspaceKey<T extends { workspaceKey?: string | null }>(row: T) {
    const { workspaceKey: _workspaceKey, ...rest } = row;
    return rest;
  }

  function normalizeAgentRow(row: typeof agents.$inferSelect) {
    return stripWorkspaceKey(normalizeAgentInternalRow(row));
  }

  function isVisibleAgentRow(row: Pick<typeof agents.$inferSelect, "metadata" | "status">) {
    return row.status !== "terminated" && !isHiddenSystemAgentMetadata(row.metadata);
  }

  async function getMonthlySpendByAgentIds(orgId: string, agentIds: string[]) {
    if (agentIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await db
      .select({
        agentId: costEvents.agentId,
        spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.orgId, orgId),
          inArray(costEvents.agentId, agentIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.agentId);
    return new Map(rows.map((row) => [row.agentId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateAgentSpend<T extends { id: string; orgId: string; spentMonthlyCents: number }>(rows: T[]) {
    const agentIds = rows.map((row) => row.id);
    const orgId = rows[0]?.orgId;
    if (!orgId || agentIds.length === 0) return rows;
    const spendByAgentId = await getMonthlySpendByAgentIds(orgId, agentIds);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByAgentId.get(row.id) ?? 0,
    }));
  }

  async function ensureStoredWorkspaceKey(row: typeof agents.$inferSelect) {
    const storedWorkspaceKey = row.workspaceKey?.trim();
    if (storedWorkspaceKey) return row;

    const existingRows = await db
      .select({ workspaceKey: agents.workspaceKey })
      .from(agents)
      .where(and(eq(agents.orgId, row.orgId), ne(agents.id, row.id)));
    const existingKeys = new Set(
      existingRows
        .map((entry) => entry.workspaceKey?.trim() ?? "")
        .filter((value) => value.length > 0),
    );
    const preferredWorkspaceKey = extractWorkspaceKeyFromManagedInstructionsConfig(
      row.orgId,
      row.agentRuntimeConfig,
    );
    const workspaceKey =
      preferredWorkspaceKey && !existingKeys.has(preferredWorkspaceKey)
        ? preferredWorkspaceKey
        : deriveUniqueAgentWorkspaceKey({
            agentId: row.id,
            name: row.name,
            existingKeys,
          });

    if (typeof (db as { update?: unknown }).update !== "function") {
      return { ...row, workspaceKey };
    }

    const updated = await db
      .update(agents)
      .set({
        workspaceKey,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, row.id), isNull(agents.workspaceKey)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (updated) return updated;

    return db
      .select()
      .from(agents)
      .where(eq(agents.id, row.id))
      .then((rows) => rows[0] ?? { ...row, workspaceKey });
  }

  async function getStoredById(id: string) {
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return ensureStoredWorkspaceKey(row);
  }

  async function getInternalById(id: string) {
    const row = await getStoredById(id);
    if (!row) return null;
    const [hydrated] = await hydrateAgentSpend([row]);
    return normalizeAgentInternalRow(hydrated);
  }

  async function getById(id: string) {
    const row = await getInternalById(id);
    if (!row) return null;
    return stripWorkspaceKey(row);
  }

  async function ensureManager(orgId: string, managerId: string) {
    const manager = await getById(managerId);
    if (!manager) throw notFound("Manager not found");
    if (manager.orgId !== orgId) {
      throw unprocessable("Manager must belong to same organization");
    }
    return manager;
  }

  async function assertNoCycle(agentId: string, reportsTo: string | null | undefined) {
    if (!reportsTo) return;
    if (reportsTo === agentId) throw unprocessable("Agent cannot report to itself");

    let cursor: string | null = reportsTo;
    while (cursor) {
      if (cursor === agentId) throw unprocessable("Reporting relationship would create cycle");
      const next = await getById(cursor);
      cursor = next?.reportsTo ?? null;
    }
  }

  async function assertCompanyShortnameAvailable(
    orgId: string,
    candidateName: string,
    options?: AgentShortnameCollisionOptions,
  ) {
    const candidateShortname = normalizeAgentUrlKey(candidateName);
    if (!candidateShortname) return;

    const existingAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.orgId, orgId));

    const hasCollision = hasAgentShortnameCollision(candidateName, existingAgents, options);
    if (hasCollision) {
      throw conflict(
        `Agent shortname '${candidateShortname}' is already in use in this organization`,
      );
    }
  }

  async function updateAgent(
    id: string,
    data: Partial<typeof agents.$inferInsert>,
    options?: UpdateAgentOptions,
  ) {
    const existing = await getStoredById(id);
    if (!existing) return null;

    if (existing.status === "terminated" && data.status && data.status !== "terminated") {
      throw conflict("Terminated agents cannot be resumed");
    }
    if (
      existing.status === "pending_approval" &&
      data.status &&
      data.status !== "pending_approval" &&
      data.status !== "terminated"
    ) {
      throw conflict("Pending approval agents cannot be activated directly");
    }
    if (data.workspaceKey !== undefined && data.workspaceKey !== existing.workspaceKey) {
      throw conflict("Agent workspace key is immutable");
    }

    if (data.reportsTo !== undefined) {
      if (data.reportsTo) {
        await ensureManager(existing.orgId, data.reportsTo);
      }
      await assertNoCycle(id, data.reportsTo);
    }

    if (data.name !== undefined) {
      const previousShortname = normalizeAgentUrlKey(existing.name);
      const nextShortname = normalizeAgentUrlKey(data.name);
      if (previousShortname !== nextShortname) {
        await assertCompanyShortnameAvailable(existing.orgId, data.name, { excludeAgentId: id });
      }
    }

    const normalizedPatch = { ...data } as Partial<typeof agents.$inferInsert>;
    if (data.permissions !== undefined) {
      const role = (data.role ?? existing.role) as string;
      normalizedPatch.permissions = normalizeAgentPermissions(data.permissions, role);
    }
    delete normalizedPatch.workspaceKey;

    const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);
    const beforeConfig = shouldRecordRevision ? buildConfigSnapshot(existing) : null;

    const updated = await db
      .update(agents)
      .set({ ...normalizedPatch, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    const normalizedUpdated = updated ? normalizeAgentRow(updated) : null;

    if (normalizedUpdated && shouldRecordRevision && beforeConfig) {
      const afterConfig = buildConfigSnapshot(normalizedUpdated);
      const changedKeys = diffConfigSnapshot(beforeConfig, afterConfig);
      if (changedKeys.length > 0) {
        await db.insert(agentConfigRevisions).values({
          orgId: normalizedUpdated.orgId,
          agentId: normalizedUpdated.id,
          createdByAgentId: options?.recordRevision?.createdByAgentId ?? null,
          createdByUserId: options?.recordRevision?.createdByUserId ?? null,
          source: options?.recordRevision?.source ?? "patch",
          rolledBackFromRevisionId: options?.recordRevision?.rolledBackFromRevisionId ?? null,
          changedKeys,
          beforeConfig: beforeConfig as unknown as Record<string, unknown>,
          afterConfig: afterConfig as unknown as Record<string, unknown>,
        });
      }
    }

    return normalizedUpdated;
  }

  return {
    list: async (orgId: string, options?: { includeTerminated?: boolean; includeHidden?: boolean }) => {
      const conditions = [eq(agents.orgId, orgId)];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const rows = await db.select().from(agents).where(and(...conditions));
      const visibleRows = options?.includeHidden ? rows : rows.filter((row) => !isHiddenSystemAgentMetadata(row.metadata));
      const hydrated = await hydrateAgentSpend(visibleRows);
      return hydrated.map(normalizeAgentRow);
    },

    getById,
    getInternalById,

    suggestName: async (orgId: string) => {
      const existingAgents = await db
        .select({
          id: agents.id,
          name: agents.name,
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.orgId, orgId));
      const baseName = pickUniqueAgentName(existingAgents);
      return deduplicateAgentName(baseName, existingAgents);
    },

    create: async (
      orgId: string,
      data: Omit<typeof agents.$inferInsert, "orgId"> & { name?: string | null },
    ) => {
      if (data.reportsTo) {
        await ensureManager(orgId, data.reportsTo);
      }

      const existingAgents = await db
        .select({
          id: agents.id,
          name: agents.name,
          status: agents.status,
          metadata: agents.metadata,
          workspaceKey: agents.workspaceKey,
        })
        .from(agents)
        .where(eq(agents.orgId, orgId));
      const hasVisibleExistingAgents = existingAgents.some((agent) => isVisibleAgentRow(agent));
      const requestedName = typeof data.name === "string" ? data.name.trim() : "";
      const baseName =
        requestedName.length > 0 ? requestedName : pickUniqueAgentName(existingAgents);
      const uniqueName = deduplicateAgentName(baseName, existingAgents);
      const agentId = data.id ?? randomUUID();
      const workspaceKey = deriveUniqueAgentWorkspaceKey({
        agentId,
        name: uniqueName,
        existingKeys: existingAgents
          .map((agent) => agent.workspaceKey?.trim() ?? "")
          .filter((value) => value.length > 0),
      });

      const role = data.role ?? "general";
      const normalizedPermissions = normalizeAgentPermissions(data.permissions, role);
      const created = await db
        .insert(agents)
        .values({
          ...data,
          id: agentId,
          name: uniqueName,
          orgId,
          role,
          permissions: normalizedPermissions,
          workspaceKey,
        })
        .returning()
        .then((rows) => rows[0]);

      if (
        !hasVisibleExistingAgents
        && ORGANIZATION_DEFAULT_CHAT_RUNTIME_TYPES.has(created.agentRuntimeType as AgentRuntimeType)
      ) {
        await db
          .update(organizations)
          .set({
            defaultChatAgentRuntimeType: created.agentRuntimeType,
            defaultChatAgentRuntimeConfig: sanitizeOrganizationDefaultChatConfig(created.agentRuntimeConfig),
            updatedAt: new Date(),
          })
          .where(and(eq(organizations.id, orgId), isNull(organizations.defaultChatAgentRuntimeType)));
      }

      return normalizeAgentRow(created);
    },

    update: updateAgent,

    pause: async (id: string, reason: "manual" | "budget" | "system" = "manual") => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot pause terminated agent");

      const updated = await db
        .update(agents)
        .set({
          status: "paused",
          pauseReason: reason,
          pausedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    resume: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot resume terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot be resumed");
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    terminate: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      await db
        .update(agents)
        .set({
          status: "terminated",
          pauseReason: null,
          pausedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id));

      await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.agentId, id));

      return getById(id);
    },

    remove: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      return db.transaction(async (tx) => {
        await tx.update(agents).set({ reportsTo: null }).where(eq(agents.reportsTo, id));
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
        const deleted = await tx
          .delete(agents)
          .where(eq(agents.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return deleted ? normalizeAgentRow(deleted) : null;
      });
    },

    activatePendingApproval: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status !== "pending_approval") return existing;

      const updated = await db
        .update(agents)
        .set({ status: "idle", updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    updatePermissions: async (id: string, permissions: { canCreateAgents: boolean }) => {
      const existing = await getById(id);
      if (!existing) return null;

      const updated = await db
        .update(agents)
        .set({
          permissions: normalizeAgentPermissions(permissions, existing.role),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    listConfigRevisions: async (id: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(eq(agentConfigRevisions.agentId, id))
        .orderBy(desc(agentConfigRevisions.createdAt)),

    getConfigRevision: async (id: string, revisionId: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null),

    rollbackConfigRevision: async (
      id: string,
      revisionId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const revision = await db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null);
      if (!revision) return null;
      if (containsRedactedMarker(revision.afterConfig)) {
        throw unprocessable("Cannot roll back a revision that contains redacted secret values");
      }

      const patch = configPatchFromSnapshot(revision.afterConfig);
      return updateAgent(id, patch, {
        recordRevision: {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          source: "rollback",
          rolledBackFromRevisionId: revision.id,
        },
      });
    },

    createApiKey: async (id: string, name: string) => {
      const existing = await getById(id);
      if (!existing) throw notFound("Agent not found");
      if (existing.status === "pending_approval") {
        throw conflict("Cannot create keys for pending approval agents");
      }
      if (existing.status === "terminated") {
        throw conflict("Cannot create keys for terminated agents");
      }

      const token = createToken();
      const keyHash = hashToken(token);
      const created = await db
        .insert(agentApiKeys)
        .values({
          agentId: id,
          orgId: existing.orgId,
          name,
          keyHash,
        })
        .returning()
        .then((rows) => rows[0]);

      return {
        id: created.id,
        name: created.name,
        token,
        createdAt: created.createdAt,
      };
    },

    listKeys: (id: string) =>
      db
        .select({
          id: agentApiKeys.id,
          name: agentApiKeys.name,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, id)),

    revokeKey: async (keyId: string) => {
      const rows = await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.id, keyId))
        .returning();
      return rows[0] ?? null;
    },

    orgForCompany: async (orgId: string) => {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.orgId, orgId), ne(agents.status, "terminated")));
      const normalizedRows = rows.filter((row) => !isHiddenSystemAgentMetadata(row.metadata)).map(normalizeAgentRow);
      const byManager = new Map<string | null, typeof normalizedRows>();
      for (const row of normalizedRows) {
        const key = row.reportsTo ?? null;
        const group = byManager.get(key) ?? [];
        group.push(row);
        byManager.set(key, group);
      }

      const build = (managerId: string | null): Array<Record<string, unknown>> => {
        const members = byManager.get(managerId) ?? [];
        return members.map((member) => ({
          ...member,
          reports: build(member.id),
        }));
      };

      return build(null);
    },

    getChainOfCommand: async (agentId: string) => {
      const chain: { id: string; name: string; role: string; title: string | null }[] = [];
      const visited = new Set<string>([agentId]);
      const start = await getById(agentId);
      let currentId = start?.reportsTo ?? null;
      while (currentId && !visited.has(currentId) && chain.length < 50) {
        visited.add(currentId);
        const mgr = await getById(currentId);
        if (!mgr) break;
        chain.push({ id: mgr.id, name: mgr.name, role: mgr.role, title: mgr.title ?? null });
        currentId = mgr.reportsTo ?? null;
      }
      return chain;
    },

    runningForAgent: (agentId: string) =>
      db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"]))),

    resolveByReference: async (orgId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { agent: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const byId = await getById(raw);
        if (!byId || byId.orgId !== orgId) {
          return { agent: null, ambiguous: false } as const;
        }
        return { agent: byId, ambiguous: false } as const;
      }

      const urlKey = normalizeAgentUrlKey(raw);
      if (!urlKey) {
        return { agent: null, ambiguous: false } as const;
      }

      const rows = await db.select().from(agents).where(eq(agents.orgId, orgId));
      const matches = rows
        .map(normalizeAgentRow)
        .filter((agent) => isVisibleAgentRow(agent) && agent.urlKey === urlKey);
      if (matches.length === 1) {
        return { agent: matches[0] ?? null, ambiguous: false } as const;
      }
      if (matches.length > 1) {
        return { agent: null, ambiguous: true } as const;
      }
      return { agent: null, ambiguous: false } as const;
    },
  };
}
