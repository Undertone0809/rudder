import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { RudderSkillEntry } from "@rudder/agent-runtime-utils/server-utils";
import type { Db } from "@rudder/db";
import { agents, issues, projectWorkspaces } from "@rudder/db";
import type { AgentRuntimeType, ProjectResourceAttachment } from "@rudder/shared";
import { parseObject } from "../agent-runtimes/utils.js";
import {
  ensureAgentWorkspaceLayout,
  ensureOrganizationWorkspaceLayout,
  resolveAgentInstructionsDir,
} from "../home-paths.js";
import { deriveUniqueAgentWorkspaceKey } from "../agent-workspace-key.js";
import { agentService, deduplicateAgentName } from "./agents.js";
import { organizationSkillService } from "./organization-skills.js";
import { listProjectResourceAttachments } from "./resource-catalog.js";
import { secretService } from "./secrets.js";
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
const COPILOT_ROW_NAME = "Rudder Copilot (system)";
export const RUDDER_COPILOT_LABEL = "Rudder Copilot";
const COPILOT_TITLE = "System-managed chat copilot";
const COPILOT_ENTRY_FILE = "AGENTS.md";
const COPILOT_SYSTEM_KIND = "rudder_copilot";

export type AgentRunScene = "chat" | "heartbeat";

export type AgentRunContextAgent = {
  id: string;
  orgId: string;
  name: string;
  workspaceKey?: string | null;
  status?: string | null;
  agentRuntimeType: string;
  agentRuntimeConfig: unknown;
  metadata?: Record<string, unknown> | null;
};

export type ResolvedWorkspaceForRun = {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  workspaceHints: Array<{
    workspaceId: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  }>;
  warnings: string[];
};

type ProjectWorkspaceCandidate = {
  id: string;
};

type OrganizationChatConfig = {
  id: string;
  defaultChatAgentRuntimeType: string | null;
  defaultChatAgentRuntimeConfig: Record<string, unknown> | null;
};

type BuildSceneContextInput = {
  scene: AgentRunScene;
  agent: AgentRunContextAgent;
  resolvedWorkspace: ResolvedWorkspaceForRun;
  runtimeConfig: Record<string, unknown>;
  executionWorkspace?: {
    cwd: string;
    source: string | null;
    strategy: string | null;
    projectId: string | null;
    workspaceId: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
    worktreePath: string | null;
  } | null;
  executionWorkspaceMode?: string | null;
};

type PreparedAgentRunConfig = {
  resolvedConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  runtimeSkillEntries: RudderSkillEntry[];
  secretKeys: Set<string>;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function prioritizeProjectWorkspaceCandidatesForRun<T extends ProjectWorkspaceCandidate>(
  rows: T[],
  preferredWorkspaceId: string | null | undefined,
): T[] {
  if (!preferredWorkspaceId) return rows;
  const preferredIndex = rows.findIndex((row) => row.id === preferredWorkspaceId);
  if (preferredIndex <= 0) return rows;
  return [rows[preferredIndex]!, ...rows.slice(0, preferredIndex), ...rows.slice(preferredIndex + 1)];
}

export function isHiddenSystemAgentMetadata(metadata: unknown) {
  const parsed = asRecord(metadata);
  return parsed.hidden === true || readNonEmptyString(parsed.systemManaged) === COPILOT_SYSTEM_KIND;
}

function isCopilotMetadata(metadata: unknown) {
  return readNonEmptyString(asRecord(metadata).systemManaged) === COPILOT_SYSTEM_KIND;
}

function buildCopilotInstructions() {
  return [
    "# Rudder Copilot",
    "",
    "You are the system-managed chat copilot for this Rudder organization.",
    "Stay focused on Rudder control-plane work such as clarifying requests, shaping issue proposals, and discussing lightweight organization or agent configuration changes.",
    "Do not route, hand off, or dispatch work to another agent on your own.",
    "When the chat scene asks for a structured result envelope, follow it exactly.",
  ].join("\n");
}

function labelForResourceKind(kind: ProjectResourceAttachment["resource"]["kind"]) {
  return kind.replace(/_/g, " ");
}

function buildProjectResourcesPrompt(resources: ProjectResourceAttachment[]) {
  if (resources.length === 0) return "";
  return [
    "## Project Resources",
    "",
    ...resources.flatMap((attachment) => {
      const lines = [
        `- [${attachment.role}] ${attachment.resource.name}`,
        `  - Kind: ${labelForResourceKind(attachment.resource.kind)}`,
        `  - Locator: \`${attachment.resource.locator}\``,
      ];
      if (attachment.resource.description?.trim()) {
        lines.push(`  - Description: ${attachment.resource.description.trim()}`);
      }
      if (attachment.note?.trim()) {
        lines.push(`  - Project note: ${attachment.note.trim()}`);
      }
      return [...lines, ""];
    }),
  ].join("\n").trim();
}

function buildCompiledResourcesPrompt(projectResources: ProjectResourceAttachment[]) {
  return buildProjectResourcesPrompt(projectResources);
}

function buildCopilotRuntimeConfig(input: {
  orgId: string;
  agent: {
    id: string;
    name: string;
    workspaceKey?: string | null;
  };
  organization: OrganizationChatConfig;
}) {
  const instructionsRootPath = resolveAgentInstructionsDir(input.orgId, input.agent);
  const instructionsFilePath = path.join(instructionsRootPath, COPILOT_ENTRY_FILE);
  const baseConfig = asRecord(input.organization.defaultChatAgentRuntimeConfig);
  return {
    ...baseConfig,
    instructionsBundleMode: "managed",
    instructionsEntryFile: COPILOT_ENTRY_FILE,
    instructionsRootPath,
    instructionsFilePath,
  } satisfies Record<string, unknown>;
}

function buildCopilotMetadata(existing: unknown) {
  return {
    ...asRecord(existing),
    hidden: true,
    systemManaged: COPILOT_SYSTEM_KIND,
    systemScene: "chat",
    displayName: RUDDER_COPILOT_LABEL,
  } satisfies Record<string, unknown>;
}

export function agentRunContextService(db: Db) {
  const agentsSvc = agentService(db);
  const secretsSvc = secretService(db);
  const organizationSkills = organizationSkillService(db);

  async function prepareRuntimeConfig(input: {
    scene: AgentRunScene;
    agent: AgentRunContextAgent;
    baseConfig?: Record<string, unknown> | null;
  }): Promise<PreparedAgentRunConfig> {
    const baseConfig = input.baseConfig ?? asRecord(input.agent.agentRuntimeConfig);
    const { config: resolvedConfig, secretKeys } = await secretsSvc.resolveAdapterConfigForRuntime(
      input.agent.orgId,
      baseConfig,
    );
    const desiredSkills = await organizationSkills.getEnabledSkillKeysForAgent(input.agent.orgId, {
      id: input.agent.id,
      orgId: input.agent.orgId,
      agentRuntimeType: input.agent.agentRuntimeType,
      agentRuntimeConfig: baseConfig,
    });
    const runtimeSkillEntries = await organizationSkills.listRealizedSkillEntriesForAgent(
      input.agent.orgId,
      input.agent.id,
      input.agent.agentRuntimeType,
      resolvedConfig,
      desiredSkills,
    );
    const desiredRuntimeSkills = runtimeSkillEntries.map((entry) => entry.key);
    return {
      resolvedConfig,
      runtimeConfig: {
        ...resolvedConfig,
        rudderSkillSync: { desiredSkills: desiredRuntimeSkills },
        paperclipSkillSync: { desiredSkills: desiredRuntimeSkills },
        rudderRuntimeSkills: runtimeSkillEntries,
        paperclipRuntimeSkills: runtimeSkillEntries,
      },
      runtimeSkillEntries,
      secretKeys,
    };
  }

  async function ensureChatCopilotAgent(
    organization: OrganizationChatConfig,
  ) {
    const runtimeType = readNonEmptyString(organization.defaultChatAgentRuntimeType);
    if (!runtimeType) return null;

    const existing = await db
      .select()
      .from(agents)
      .where(eq(agents.orgId, organization.id))
      .orderBy(asc(agents.createdAt), asc(agents.id));
    const copilot = existing.find((row) => isCopilotMetadata(row.metadata)) ?? null;

    if (!copilot) {
      const id = randomUUID();
      const uniqueName = deduplicateAgentName(COPILOT_ROW_NAME, existing);
      const workspaceKey = deriveUniqueAgentWorkspaceKey({
        agentId: id,
        name: uniqueName,
        existingKeys: existing
          .map((agent) => agent.workspaceKey?.trim() ?? "")
          .filter((value) => value.length > 0),
      });
      const nextCopilot = { id, name: uniqueName, workspaceKey };
      await ensureAgentWorkspaceLayout({ orgId: organization.id, ...nextCopilot });
      await fs.writeFile(
        path.join(resolveAgentInstructionsDir(organization.id, nextCopilot), COPILOT_ENTRY_FILE),
        buildCopilotInstructions(),
        "utf8",
      );
      return agentsSvc.create(organization.id, {
        id,
        name: uniqueName,
        role: "general",
        title: COPILOT_TITLE,
        status: "idle",
        capabilities: "System-managed chat copilot",
        agentRuntimeType: runtimeType as AgentRuntimeType,
        agentRuntimeConfig: buildCopilotRuntimeConfig({
          orgId: organization.id,
          agent: nextCopilot,
          organization,
        }),
        runtimeConfig: { heartbeat: { intervalSec: 0 } },
        permissions: { canCreateAgents: false },
        metadata: buildCopilotMetadata(null),
      });
    }

    await ensureAgentWorkspaceLayout(copilot);
    await fs.writeFile(
      path.join(resolveAgentInstructionsDir(organization.id, copilot), COPILOT_ENTRY_FILE),
      buildCopilotInstructions(),
      "utf8",
    );

    const desiredMetadata = buildCopilotMetadata(copilot.metadata);
    const desiredRuntimeConfig = buildCopilotRuntimeConfig({
      orgId: organization.id,
      agent: copilot,
      organization,
    });
    const patch: Record<string, unknown> = {};
    if (copilot.name !== COPILOT_ROW_NAME) patch.name = COPILOT_ROW_NAME;
    if ((copilot.title ?? null) !== COPILOT_TITLE) patch.title = COPILOT_TITLE;
    if (copilot.status !== "idle") patch.status = "idle";
    if (copilot.agentRuntimeType !== runtimeType) patch.agentRuntimeType = runtimeType;
    if (!jsonEqual(copilot.agentRuntimeConfig, desiredRuntimeConfig)) {
      patch.agentRuntimeConfig = desiredRuntimeConfig;
    }
    if (!jsonEqual(copilot.metadata, desiredMetadata)) {
      patch.metadata = desiredMetadata;
    }
    if (Object.keys(patch).length === 0) {
      return agentsSvc.getById(copilot.id);
    }
    return agentsSvc.update(copilot.id, patch);
  }

  async function resolveWorkspaceForRun(
    agent: AgentRunContextAgent,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ): Promise<ResolvedWorkspaceForRun> {
    const agentWorkspace = await ensureAgentWorkspaceLayout(agent);
    const issueId = readNonEmptyString(context.issueId);
    const contextProjectId = readNonEmptyString(context.projectId);
    const contextProjectWorkspaceId = readNonEmptyString(context.projectWorkspaceId);
    const issueProjectRef = issueId
      ? await db
          .select({
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.orgId, agent.orgId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueProjectId = issueProjectRef?.projectId ?? null;
    const preferredProjectWorkspaceId =
      issueProjectRef?.projectWorkspaceId ?? contextProjectWorkspaceId ?? null;
    const resolvedProjectId = issueProjectId ?? contextProjectId;
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;
    const organizationWorkspace = workspaceProjectId
      ? await ensureOrganizationWorkspaceLayout(agent.orgId)
      : null;
    const sharedOrganizationCwd = organizationWorkspace?.root ?? null;

    const unorderedProjectWorkspaceRows = workspaceProjectId
      ? await db
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.orgId, agent.orgId),
              eq(projectWorkspaces.projectId, workspaceProjectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      : [];
    const projectWorkspaceRows = prioritizeProjectWorkspaceCandidatesForRun(
      unorderedProjectWorkspaceRows,
      preferredProjectWorkspaceId,
    );
    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0) {
      const preferredWorkspace = preferredProjectWorkspaceId
        ? projectWorkspaceRows.find((workspace) => workspace.id === preferredProjectWorkspaceId) ?? null
        : null;
      const missingProjectCwds: string[] = [];
      let hasConfiguredProjectCwd = false;
      let preferredWorkspaceWarning: string | null = null;
      if (preferredProjectWorkspaceId && !preferredWorkspace) {
        preferredWorkspaceWarning =
          `Selected project workspace "${preferredProjectWorkspaceId}" is not available on this project.`;
      }
      for (const workspace of projectWorkspaceRows) {
        const projectCwd = readNonEmptyString(workspace.cwd);
        if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) continue;
        hasConfiguredProjectCwd = true;
        const projectCwdExists = await fs
          .stat(projectCwd)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (projectCwdExists) {
          return {
            cwd: projectCwd,
            source: "project_primary",
            projectId: resolvedProjectId,
            workspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            workspaceHints,
            warnings: [preferredWorkspaceWarning].filter(
              (value): value is string => Boolean(value),
            ),
          };
        }
        if (preferredWorkspace?.id === workspace.id) {
          preferredWorkspaceWarning =
            `Selected project workspace path "${projectCwd}" is not available yet.`;
        }
        missingProjectCwds.push(projectCwd);
      }

      const fallbackCwd = sharedOrganizationCwd ?? agentWorkspace.root;
      const fallbackLabel = sharedOrganizationCwd
        ? `shared organization workspace "${fallbackCwd}"`
        : `canonical agent workspace "${fallbackCwd}"`;
      const warnings: string[] = [];
      if (preferredWorkspaceWarning) warnings.push(preferredWorkspaceWarning);
      if (missingProjectCwds.length > 0) {
        const firstMissing = missingProjectCwds[0];
        const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
        warnings.push(
          extraMissingCount > 0
            ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Run will start in ${fallbackLabel}.`
            : `Project workspace path "${firstMissing}" is not available yet. Run will start in ${fallbackLabel}.`,
        );
      } else if (!hasConfiguredProjectCwd) {
        warnings.push(
          `Project workspace has no local cwd configured. Run will start in ${fallbackLabel}.`,
        );
      }
      return {
        cwd: fallbackCwd,
        source: "project_primary",
        projectId: resolvedProjectId,
        workspaceId: projectWorkspaceRows[0]?.id ?? null,
        repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
        repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
        workspaceHints,
        warnings,
      };
    }

    if (workspaceProjectId && sharedOrganizationCwd) {
      return {
        cwd: sharedOrganizationCwd,
        source: "project_primary",
        projectId: resolvedProjectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        workspaceHints,
        warnings: [],
      };
    }

    const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
    if (sessionCwd) {
      const sessionCwdExists = await fs
        .stat(sessionCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (sessionCwdExists) {
        return {
          cwd: sessionCwd,
          source: "task_session",
          projectId: resolvedProjectId,
          workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
          repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
          repoRef: readNonEmptyString(previousSessionParams?.repoRef),
          workspaceHints,
          warnings: [],
        };
      }
    }

    const cwd = agentWorkspace.root;
    const warnings: string[] = [];
    if (sessionCwd) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" is not available. Run will start in canonical agent workspace "${cwd}".`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No shared workspace is currently available for this issue. Run will start in canonical agent workspace "${cwd}".`,
      );
    }
    return {
      cwd,
      source: "agent_home",
      projectId: resolvedProjectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
      warnings,
    };
  }

  async function buildSceneContext(input: BuildSceneContextInput) {
    const agentWorkspace = await ensureAgentWorkspaceLayout(input.agent);
    const organizationWorkspace = await ensureOrganizationWorkspaceLayout(input.agent.orgId);
    const workspaceSource = input.executionWorkspace?.source ?? input.resolvedWorkspace.source;
    const workspaceProjectId = input.executionWorkspace?.projectId ?? input.resolvedWorkspace.projectId;
    const workspaceId = input.executionWorkspace?.workspaceId ?? input.resolvedWorkspace.workspaceId;
    const workspaceRepoUrl = input.executionWorkspace?.repoUrl ?? input.resolvedWorkspace.repoUrl;
    const workspaceRepoRef = input.executionWorkspace?.repoRef ?? input.resolvedWorkspace.repoRef;
    const runtimeServiceIntents = (() => {
      const runtimeWorkspaceConfig = parseObject(input.runtimeConfig.workspaceRuntime);
      return Array.isArray(runtimeWorkspaceConfig.services)
        ? runtimeWorkspaceConfig.services.filter(
            (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
          )
        : [];
    })();

    const effectiveMode = input.executionWorkspaceMode
      ?? (input.resolvedWorkspace.source === "project_primary" ? "shared_workspace" : "agent_default");

    const executionWorkspaceCwd = input.executionWorkspace?.cwd ?? input.resolvedWorkspace.cwd;
    const projectResources = workspaceProjectId && typeof (db as Partial<Db>).select === "function"
      ? await listProjectResourceAttachments(db, input.agent.orgId, workspaceProjectId)
      : [];
    const compiledResourcesPrompt = buildCompiledResourcesPrompt(projectResources);
    const rudderWorkspace = {
      cwd: executionWorkspaceCwd,
      source: workspaceSource,
      mode: effectiveMode,
      strategy: input.executionWorkspace?.strategy ?? null,
      projectId: workspaceProjectId,
      workspaceId,
      repoUrl: workspaceRepoUrl,
      repoRef: workspaceRepoRef,
      branchName: input.executionWorkspace?.branchName ?? null,
      worktreePath: input.executionWorkspace?.worktreePath ?? null,
      executionWorkspaceCwd,
      executionWorkspaceSource: input.executionWorkspace?.source ?? input.resolvedWorkspace.source,
      agentHome: agentWorkspace.root,
      agentRoot: agentWorkspace.root,
      instructionsDir: agentWorkspace.instructionsDir,
      memoryDir: agentWorkspace.memoryDir,
      agentSkillsDir: agentWorkspace.skillsDir,
      orgWorkspaceRoot: organizationWorkspace.root,
      orgAgentsDir: organizationWorkspace.agentsDir,
      orgSkillsDir: organizationWorkspace.skillsDir,
      orgPlansDir: organizationWorkspace.plansDir,
      resourcesPrompt: compiledResourcesPrompt,
      orgResourcesPrompt: compiledResourcesPrompt,
    } satisfies Record<string, unknown>;

    return {
      rudderScene: input.scene,
      rudderWorkspace,
      rudderResourcesPrompt: compiledResourcesPrompt,
      rudderResources: projectResources,
      rudderOrganizationResources: [],
      rudderProjectResources: projectResources,
      rudderOrgNotes: "",
      rudderWorkspaces: input.resolvedWorkspace.workspaceHints,
      rudderRuntimeServiceIntents: runtimeServiceIntents.length > 0 ? runtimeServiceIntents : undefined,
    };
  }

  return {
    buildSceneContext,
    ensureChatCopilotAgent,
    isHiddenSystemAgentMetadata,
    prepareRuntimeConfig,
    resolveWorkspaceForRun,
  };
}
