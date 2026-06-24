import type { RudderSkillEntry } from "@rudderhq/agent-runtime-utils/server-utils";
import type { Db } from "@rudderhq/db";
import { automations, automationTriggers, issues, projects, projectWorkspaces } from "@rudderhq/db";
import {
  deriveProjectUrlKey,
  type ProjectResourceAttachment,
} from "@rudderhq/shared";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import fs from "node:fs/promises";
import { parseObject } from "../agent-runtimes/utils.js";
import {
  ensureAgentWorkspaceLayout,
  ensureOrganizationWorkspaceLayout,
  ensureProjectLibraryLayout,
} from "../home-paths.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { agentStartupContextService } from "./agent-startup-context.js";
import { organizationSkillService } from "./organization-skills.js";
import { listProjectResourceAttachments } from "./resource-catalog.js";
import { secretService } from "./secrets.js";
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
const LEGACY_COPILOT_SYSTEM_KIND = "rudder_copilot";

export type AgentRunScene = "issue" | "chat" | "automation" | "review" | "heartbeat";

export type AgentRunContextAgent = {
  id: string;
  orgId: string;
  name: string;
  role?: string | null;
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

type BuildSceneContextInput = {
  scene: AgentRunScene;
  agent: AgentRunContextAgent;
  resolvedWorkspace: ResolvedWorkspaceForRun;
  runtimeConfig: Record<string, unknown>;
  issueId?: string | null;
  chatConversationId?: string | null;
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

type AgentAutomationPromptTrigger = {
  id: string;
  kind: string;
  label: string | null;
  enabled: boolean;
  nextRunAt: Date | null;
  lastFiredAt: Date | null;
};

type AgentAutomationPromptItem = {
  id: string;
  title: string;
  outputMode: string;
  lastTriggeredAt: Date | null;
  triggers: AgentAutomationPromptTrigger[];
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function prioritizeProjectWorkspaceCandidatesForRun<
  T extends ProjectWorkspaceCandidate,
>(rows: T[], preferredWorkspaceId: string | null | undefined): T[] {
  if (!preferredWorkspaceId) return rows;
  const preferredIndex = rows.findIndex(
    (row) => row.id === preferredWorkspaceId,
  );
  if (preferredIndex <= 0) return rows;
  return [
    rows[preferredIndex]!,
    ...rows.slice(0, preferredIndex),
    ...rows.slice(preferredIndex + 1),
  ];
}

export function isHiddenSystemAgentMetadata(metadata: unknown) {
  const parsed = asRecord(metadata);
  return (
    parsed.hidden === true ||
    readNonEmptyString(parsed.systemManaged) === LEGACY_COPILOT_SYSTEM_KIND
  );
}

function labelForResourceKind(
  kind: ProjectResourceAttachment["resource"]["kind"],
) {
  return kind.replace(/_/g, " ");
}

function markdownTableCell(value: string | null | undefined) {
  const compact = formatPromptSingleLine(value ?? "");
  if (!compact) return "empty";
  return compact.replace(/\|/g, "\\|");
}

function markdownCodeCell(value: string | null | undefined) {
  const compact = markdownTableCell(value);
  return compact === "empty" ? "empty" : markdownInlineCode(compact);
}

function markdownInlineCode(value: string) {
  return `\`${formatPromptSingleLine(value).replace(/`/g, "'")}\``;
}

function appendMarkdownTable(lines: string[], headers: string[], rows: string[][]) {
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  rows.forEach((row) => {
    lines.push(`| ${row.join(" | ")} |`);
  });
}

function buildProjectResourcesPrompt(resources: ProjectResourceAttachment[]) {
  if (resources.length === 0) return "";
  const lines = [
    "## Project Context Resources",
    "",
  ];
  appendMarkdownTable(lines, [
    "Role",
    "Name",
    "Source",
    "Kind",
    "Locator",
    "Description",
    "Project note",
  ], resources.map((attachment) => {
      const sourceType = attachment.resource.sourceType ?? "external";
      return [
        markdownTableCell(attachment.role),
        markdownTableCell(attachment.resource.name),
        markdownTableCell(sourceType),
        markdownTableCell(labelForResourceKind(attachment.resource.kind)),
        markdownCodeCell(attachment.resource.locator),
        markdownTableCell(attachment.resource.description),
        markdownTableCell(attachment.note),
      ];
    }));
  const libraryResources = resources.filter((attachment) => (attachment.resource.sourceType ?? "external") === "library");
  if (libraryResources.length > 0) {
    lines.push("", "Library resource guidance:");
    libraryResources.forEach((attachment) => {
      const locator = attachment.resource.locator;
      lines.push(
        `- ${formatPromptSingleLine(attachment.resource.name)}: library path ${markdownInlineCode(`library:${locator}`)}; local file path in local trusted runs ${markdownInlineCode(`$RUDDER_ORG_WORKSPACE_ROOT/${locator}`)}; to cite this file in a comment or handoff, run ${markdownInlineCode(`rudder library file ref "${locator}" --json`)} and paste the returned ${markdownInlineCode("markdownLink")}.`,
      );
    });
  }
  return lines.join("\n").trim();
}

function buildCompiledResourcesPrompt(
  projectResources: ProjectResourceAttachment[],
  agentAutomations: AgentAutomationPromptItem[],
) {
  return [
    buildProjectResourcesPrompt(projectResources),
    buildAgentAutomationsPrompt(agentAutomations),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildAgentAutomationsPrompt(
  agentAutomations: AgentAutomationPromptItem[],
) {
  if (agentAutomations.length === 0) return "";
  return [
    "## Your Current Automations",
    "",
    "These are your current automations; use the ID to inspect details when needed.",
    "",
    tableForAgentAutomations(agentAutomations),
  ].join("\n");
}

function tableForAgentAutomations(agentAutomations: AgentAutomationPromptItem[]) {
  const lines: string[] = [];
  appendMarkdownTable(lines, [
    "Automation",
    "ID",
    "Output",
    "Last run",
    "Triggers",
  ], agentAutomations.map((automation) => [
    markdownTableCell(automation.title),
    markdownCodeCell(automation.id),
    markdownTableCell(formatAutomationOutputMode(automation.outputMode)),
    markdownTableCell(formatPromptDate(automation.lastTriggeredAt) ?? "never"),
    markdownTableCell(automation.triggers.length > 0
      ? automation.triggers.map(formatAutomationTriggerForPrompt).join(" / ")
      : "none configured"),
  ]));
  return lines.join("\n");
}

function formatPromptSingleLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function formatPromptDate(value: Date | string | number | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function formatAutomationOutputMode(outputMode: string) {
  if (outputMode === "track_issue") return "issue";
  if (outputMode === "chat_output") return "chat";
  return formatPromptSingleLine(outputMode);
}

function formatAutomationTriggerForPrompt(trigger: AgentAutomationPromptTrigger) {
  const label = trigger.label?.trim()
    ? `${formatPromptSingleLine(trigger.label)} (${trigger.kind})`
    : trigger.kind;
  const nextRun =
    trigger.kind === "schedule"
      ? `next trigger: ${formatPromptDate(trigger.nextRunAt) ?? "not scheduled"}`
      : "next trigger: event-driven";
  return [
    label,
    trigger.enabled ? "enabled" : "disabled",
    nextRun,
    `last fired: ${formatPromptDate(trigger.lastFiredAt) ?? "never"}`,
  ].join("; ");
}

async function listAgentAutomationsForPrompt(
  db: Db,
  orgId: string,
  agentId: string,
): Promise<AgentAutomationPromptItem[]> {
  if (typeof (db as Partial<Db>).select !== "function") return [];
  const query = db.select({
    id: automations.id,
    title: automations.title,
    outputMode: automations.outputMode,
    lastTriggeredAt: automations.lastTriggeredAt,
  });
  if (!query || typeof (query as { from?: unknown }).from !== "function") {
    return [];
  }
  const fromQuery = query.from(automations);
  if (
    !fromQuery ||
    typeof (fromQuery as { where?: unknown }).where !== "function"
  ) {
    return [];
  }
  const whereQuery = fromQuery.where(
    and(
      eq(automations.orgId, orgId),
      eq(automations.assigneeAgentId, agentId),
      ne(automations.status, "archived"),
    ),
  );
  if (
    !whereQuery ||
    typeof (whereQuery as { orderBy?: unknown }).orderBy !== "function"
  ) {
    return [];
  }
  const automationRows = await whereQuery.orderBy(asc(automations.title), asc(automations.id));
  const automationIds = automationRows.map((row) => row.id);
  if (automationIds.length === 0) return [];

  const triggersByAutomationId = new Map<string, AgentAutomationPromptTrigger[]>();
  const triggerQuery = db.select({
    automationId: automationTriggers.automationId,
    id: automationTriggers.id,
    kind: automationTriggers.kind,
    label: automationTriggers.label,
    enabled: automationTriggers.enabled,
    nextRunAt: automationTriggers.nextRunAt,
    lastFiredAt: automationTriggers.lastFiredAt,
  });
  if (triggerQuery && typeof (triggerQuery as { from?: unknown }).from === "function") {
    const triggerFromQuery = triggerQuery.from(automationTriggers);
    if (triggerFromQuery && typeof (triggerFromQuery as { where?: unknown }).where === "function") {
      const triggerWhereQuery = triggerFromQuery.where(
        and(
          eq(automationTriggers.orgId, orgId),
          inArray(automationTriggers.automationId, automationIds),
        ),
      );
      if (triggerWhereQuery && typeof (triggerWhereQuery as { orderBy?: unknown }).orderBy === "function") {
        const triggerRows = await triggerWhereQuery.orderBy(
          asc(automationTriggers.createdAt),
          asc(automationTriggers.id),
        );
        for (const trigger of triggerRows) {
          const current = triggersByAutomationId.get(trigger.automationId) ?? [];
          current.push({
            id: trigger.id,
            kind: trigger.kind,
            label: trigger.label,
            enabled: trigger.enabled,
            nextRunAt: trigger.nextRunAt,
            lastFiredAt: trigger.lastFiredAt,
          });
          triggersByAutomationId.set(trigger.automationId, current);
        }
      }
    }
  }

  return automationRows.map((automation) => ({
    id: automation.id,
    title: automation.title,
    outputMode: automation.outputMode,
    lastTriggeredAt: automation.lastTriggeredAt,
    triggers: triggersByAutomationId.get(automation.id) ?? [],
  }));
}

async function resolveProjectLibraryContext(
  db: Db,
  orgId: string,
  projectId: string | null | undefined,
) {
  if (!projectId || typeof (db as Partial<Db>).select !== "function") {
    return {
      projectLibraryRoot: null,
      projectLibraryRelativePath: null,
    };
  }

  const query = db.select({ id: projects.id, name: projects.name });
  if (!query || typeof (query as { from?: unknown }).from !== "function") {
    return {
      projectLibraryRoot: null,
      projectLibraryRelativePath: null,
    };
  }

  const [project] = await query.from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
    .limit(1);
  if (!project) {
    return {
      projectLibraryRoot: null,
      projectLibraryRelativePath: null,
    };
  }

  const layout = await ensureProjectLibraryLayout({
    orgId,
    projectId: project.id,
    projectName: project.name,
    projectUrlKey: deriveProjectUrlKey(project.name, project.id),
  });
  return {
    projectLibraryRoot: layout.root,
    projectLibraryRelativePath: layout.relativePath,
  };
}

export function agentRunContextService(db: Db) {
  const instructions = agentInstructionsService();
  const secretsSvc = secretService(db);
  const organizationSkills = organizationSkillService(db);
  const startupContextSvc = agentStartupContextService(db);

  async function prepareRuntimeConfig(input: {
    scene: AgentRunScene;
    agent: AgentRunContextAgent;
    baseConfig?: Record<string, unknown> | null;
  }): Promise<PreparedAgentRunConfig> {
    const baseConfig =
      input.baseConfig ?? asRecord(input.agent.agentRuntimeConfig);
    const { config: resolvedConfig, secretKeys } =
      await secretsSvc.resolveAdapterConfigForRuntime(
        input.agent.orgId,
        baseConfig,
      );
    const desiredSkills = await organizationSkills.getEnabledSkillKeysForAgent(
      input.agent.orgId,
      {
        id: input.agent.id,
        orgId: input.agent.orgId,
        agentRuntimeType: input.agent.agentRuntimeType,
        agentRuntimeConfig: baseConfig,
      },
    );
    const runtimeSkillEntries =
      await organizationSkills.listRealizedSkillEntriesForAgent(
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

  async function materializeManagedInstructionsForRun(
    agent: AgentRunContextAgent,
  ): Promise<Record<string, unknown>> {
    const result = await instructions.reconcileBundle(agent);
    return result.agentRuntimeConfig;
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
    const contextProjectWorkspaceId = readNonEmptyString(
      context.projectWorkspaceId,
    );
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
        ? (projectWorkspaceRows.find(
            (workspace) => workspace.id === preferredProjectWorkspaceId,
          ) ?? null)
        : null;
      const missingProjectCwds: string[] = [];
      let hasConfiguredProjectCwd = false;
      let preferredWorkspaceWarning: string | null = null;
      if (preferredProjectWorkspaceId && !preferredWorkspace) {
        preferredWorkspaceWarning = `Selected project workspace "${preferredProjectWorkspaceId}" is not available on this project.`;
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
          preferredWorkspaceWarning = `Selected project workspace path "${projectCwd}" is not available yet.`;
        }
        missingProjectCwds.push(projectCwd);
      }

      const fallbackCwd = sharedOrganizationCwd ?? agentWorkspace.root;
      const fallbackLabel = sharedOrganizationCwd
        ? `shared organization directory "${fallbackCwd}"`
        : `canonical agent directory "${fallbackCwd}"`;
      const warnings: string[] = [];
      if (preferredWorkspaceWarning) warnings.push(preferredWorkspaceWarning);
      if (missingProjectCwds.length > 0) {
        const firstMissing = missingProjectCwds[0];
        const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
        warnings.push(
          extraMissingCount > 0
            ? `Project working directory path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Run will start in ${fallbackLabel}.`
            : `Project working directory path "${firstMissing}" is not available yet. Run will start in ${fallbackLabel}.`,
        );
      } else if (!hasConfiguredProjectCwd) {
        warnings.push(
          `Project has no local working directory configured. Run will start in ${fallbackLabel}.`,
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
        `Saved session working directory "${sessionCwd}" is not available. Run will start in canonical agent directory "${cwd}".`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No shared directory is currently available for this issue. Run will start in canonical agent directory "${cwd}".`,
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
    const organizationWorkspace = await ensureOrganizationWorkspaceLayout(
      input.agent.orgId,
    );
    const workspaceSource =
      input.executionWorkspace?.source ?? input.resolvedWorkspace.source;
    const workspaceProjectId =
      input.executionWorkspace?.projectId ?? input.resolvedWorkspace.projectId;
    const workspaceId =
      input.executionWorkspace?.workspaceId ??
      input.resolvedWorkspace.workspaceId;
    const workspaceRepoUrl =
      input.executionWorkspace?.repoUrl ?? input.resolvedWorkspace.repoUrl;
    const workspaceRepoRef =
      input.executionWorkspace?.repoRef ?? input.resolvedWorkspace.repoRef;
    const runtimeServiceIntents = (() => {
      const runtimeWorkspaceConfig = parseObject(
        input.runtimeConfig.workspaceRuntime,
      );
      return Array.isArray(runtimeWorkspaceConfig.services)
        ? runtimeWorkspaceConfig.services.filter(
            (value): value is Record<string, unknown> =>
              typeof value === "object" && value !== null,
          )
        : [];
    })();

    const effectiveMode =
      input.executionWorkspaceMode ??
      (input.resolvedWorkspace.source === "project_primary"
        ? "shared_workspace"
        : "agent_default");

    const executionWorkspaceCwd =
      input.executionWorkspace?.cwd ?? input.resolvedWorkspace.cwd;
    const projectResources =
      workspaceProjectId && typeof (db as Partial<Db>).select === "function"
        ? await listProjectResourceAttachments(
            db,
            input.agent.orgId,
            workspaceProjectId,
          )
        : [];
    const projectLibraryContext = await resolveProjectLibraryContext(
      db,
      input.agent.orgId,
      workspaceProjectId,
    );
    const agentAutomations = await listAgentAutomationsForPrompt(
      db,
      input.agent.orgId,
      input.agent.id,
    );
    const startupContext = await startupContextSvc.buildForRun({
      orgId: input.agent.orgId,
      agentId: input.agent.id,
      agentHome: agentWorkspace.root,
      memoryDir: agentWorkspace.memoryDir,
      scene: input.scene,
      issueId: input.issueId ?? null,
      projectId: workspaceProjectId,
      chatConversationId: input.chatConversationId ?? null,
    });
    const compiledResourcesPrompt =
      [
        buildCompiledResourcesPrompt(projectResources, agentAutomations),
        startupContext.markdown,
      ]
        .filter(Boolean)
        .join("\n\n");
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
      executionWorkspaceSource:
        input.executionWorkspace?.source ?? input.resolvedWorkspace.source,
      agentHome: agentWorkspace.root,
      agentRoot: agentWorkspace.root,
      instructionsDir: agentWorkspace.instructionsDir,
      memoryDir: agentWorkspace.memoryDir,
      lifeDir: agentWorkspace.lifeDir,
      agentSkillsDir: agentWorkspace.skillsDir,
      orgWorkspaceRoot: organizationWorkspace.root,
      orgAgentsDir: organizationWorkspace.agentsDir,
      orgSkillsDir: organizationWorkspace.skillsDir,
      projectLibraryRoot: projectLibraryContext.projectLibraryRoot,
      projectLibraryRelativePath: projectLibraryContext.projectLibraryRelativePath,
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
      rudderRuntimeServiceIntents:
        runtimeServiceIntents.length > 0 ? runtimeServiceIntents : undefined,
      rudderStartupContext: startupContext,
      rudderStartupContextMetrics: startupContext.metrics,
    };
  }

  return {
    buildSceneContext,
    isHiddenSystemAgentMetadata,
    materializeManagedInstructionsForRun,
    prepareRuntimeConfig,
    resolveWorkspaceForRun,
  };
}
