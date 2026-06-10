import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@rudderhq/db";
import type {
  OrganizationPortabilityAgentManifestEntry,
  OrganizationPortabilityCollisionStrategy,
  OrganizationPortabilityEnvInput,
  OrganizationPortabilityExport,
  OrganizationPortabilityFileEntry,
  OrganizationPortabilityExportPreviewResult,
  OrganizationPortabilityExportResult,
  OrganizationPortabilityImport,
  OrganizationPortabilityImportResult,
  OrganizationPortabilityInclude,
  OrganizationPortabilityManifest,
  OrganizationPortabilityPreview,
  OrganizationPortabilityPreviewAgentPlan,
  OrganizationPortabilityPreviewResult,
  OrganizationPortabilityProjectManifestEntry,
  OrganizationPortabilityProjectWorkspaceManifestEntry,
  OrganizationPortabilityIssueAutomationManifestEntry,
  OrganizationPortabilityIssueAutomationTriggerManifestEntry,
  OrganizationPortabilityIssueManifestEntry,
  OrganizationPortabilitySidebarOrder,
  OrganizationPortabilitySkillManifestEntry,
  OrganizationSkill,
  OrganizationExportJobStage,
} from "@rudderhq/shared";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  PROJECT_STATUSES,
  AUTOMATION_CATCH_UP_POLICIES,
  AUTOMATION_CONCURRENCY_POLICIES,
  AUTOMATION_STATUSES,
  AUTOMATION_TRIGGER_KINDS,
  AUTOMATION_TRIGGER_SIGNING_MODES,
  deriveOrganizationUrlKey,
  deriveProjectUrlKey,
  getBundledRudderSkillSlug,
  normalizeAgentUrlKey,
  toBundledRudderSkillKey,
} from "@rudderhq/shared";
import { notFound, unprocessable } from "../../errors.js";
import type { StorageService } from "../../storage/types.js";
import { accessService } from "../access.js";
import { agentService } from "../agents.js";
import { agentInstructionsService } from "../agent-instructions.js";
import { assetService } from "../assets.js";
import { generateReadme } from "../organization-export-readme.js";
import { renderOrgChartPng, type OrgNode } from "../../routes/org-chart-svg.js";
import { organizationSkillService } from "../organization-skills.js";
import { organizationService } from "../orgs.js";
import { validateCron } from "../cron.js";
import { issueService } from "../issues.js";
import { projectService } from "../projects.js";
import { automationService } from "../automations.js";

import {
  ADAPTER_DEFAULT_RULES_BY_TYPE,
  COMPANY_LOGO_FILE_NAME,
  RUNTIME_DEFAULT_RULES,
  type AutomationLike,
  type OrganizationPortabilityExportOptions,
  asString,
  buildAutomationManifestFromLiveAutomation,
  buildOrgTreeFromManifest,
  buildPortableProjectWorkspaces,
  buildSkillExportDirMap,
  classifyPortableFileKind,
  exportPortableProjectExecutionWorkspacePolicy,
  isPlainRecord,
  normalizeSkillKey,
  normalizeSkillSlug,
  stripEmptyValues,
  toSafeSlug,
  uniqueSlug,
} from "./organization-portability.core.js";
import {
  buildMarkdown,
  bufferToPortableBinaryFile,
  extractPortableEnvInputs,
  filterExportFiles,
  inferContentTypeFromPath,
  isAbsoluteCommand,
  normalizeInclude,
  normalizePortableConfig,
  normalizePortablePath,
  normalizePortableSidebarOrder,
  pruneDefaultLikeValue,
  resolveCompanyLogoExtension,
  sortAgentsBySidebarOrder,
  streamToBuffer,
} from "./organization-portability.files.js";
import {
  buildEnvInputMap,
  buildManifestFromPackageFiles,
  buildReferencedSkillMarkdown,
  buildYamlFile,
  dedupeEnvInputs,
  ensurePortableAgentEntryFile,
  shouldReferenceSkillOnExport,
  withSkillSourceMetadata,
} from "./organization-portability.package.js";
import { resolveSource } from "./organization-portability.resolve-source.js";

type ExportContext = {
  db: Db;
  storage?: StorageService;
  organizations: ReturnType<typeof organizationService>;
  agents: ReturnType<typeof agentService>;
  assetRecords: ReturnType<typeof assetService>;
  instructions: ReturnType<typeof agentInstructionsService>;
  organizationSkills: ReturnType<typeof organizationSkillService>;
};

export function createOrganizationPortabilityExportHandlers(context: ExportContext) {
  const { db, storage, organizations, agents, assetRecords, instructions, organizationSkills } = context;

  async function exportBundle(
    orgId: string,
    input: OrganizationPortabilityExport,
    options: OrganizationPortabilityExportOptions = {},
  ): Promise<OrganizationPortabilityExportResult> {
    const totalProgressSteps = 8;
    const assertNotAborted = () => {
      if (options.signal?.aborted) {
        throw new Error("Export build canceled");
      }
    };
    const reportProgress = (
      stage: OrganizationExportJobStage,
      message: string,
      completed: number,
      fileCount?: number | null,
    ) => {
      options.onProgress?.({
        stage,
        message,
        completed,
        total: totalProgressSteps,
        fileCount: fileCount ?? null,
      });
    };
    assertNotAborted();
    reportProgress("collecting", "Collecting organization data.", 1);
    const include = normalizeInclude({
      ...input.include,
      agents: input.agents && input.agents.length > 0 ? true : input.include?.agents,
      projects: input.projects && input.projects.length > 0 ? true : input.include?.projects,
      issues:
        (input.issues && input.issues.length > 0) || (input.projectIssues && input.projectIssues.length > 0)
          ? true
          : input.include?.issues,
      skills: input.skills && input.skills.length > 0 ? true : input.include?.skills,
    });
    const organization = await organizations.getById(orgId);
    assertNotAborted();
    if (!organization) throw notFound("Organization not found");

    const files: Record<string, OrganizationPortabilityFileEntry> = {};
    const warnings: string[] = [];
    const envInputs: OrganizationPortabilityManifest["envInputs"] = [];
    const requestedSidebarOrder = normalizePortableSidebarOrder(input.sidebarOrder);
    const rootPath = normalizeAgentUrlKey(organization.name) ?? "organization-package";
    let companyLogoPath: string | null = null;

    const allAgentRows = include.agents ? await agents.list(orgId, { includeTerminated: true }) : [];
    assertNotAborted();
    const liveAgentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
    const organizationSkillRows = include.skills || include.agents ? await organizationSkills.listFull(orgId) : [];
    assertNotAborted();
    if (include.agents) {
      const skipped = allAgentRows.length - liveAgentRows.length;
      if (skipped > 0) {
        warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
      }
    }

    const agentByReference = new Map<string, typeof liveAgentRows[number]>();
    for (const agent of liveAgentRows) {
      agentByReference.set(agent.id, agent);
      agentByReference.set(agent.name, agent);
      const normalizedName = normalizeAgentUrlKey(agent.name);
      if (normalizedName) {
        agentByReference.set(normalizedName, agent);
      }
    }

    const selectedAgents = new Map<string, typeof liveAgentRows[number]>();
    for (const selector of input.agents ?? []) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      const normalized = normalizeAgentUrlKey(trimmed) ?? trimmed;
      const match = agentByReference.get(trimmed) ?? agentByReference.get(normalized);
      if (!match) {
        warnings.push(`Agent selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedAgents.set(match.id, match);
    }

    if (include.agents && selectedAgents.size === 0) {
      for (const agent of liveAgentRows) {
        selectedAgents.set(agent.id, agent);
      }
    }

    const agentRows = Array.from(selectedAgents.values())
      .sort((left, right) => left.name.localeCompare(right.name));

    const usedSlugs = new Set<string>();
    const idToSlug = new Map<string, string>();
    for (const agent of agentRows) {
      const baseSlug = toSafeSlug(agent.name, "agent");
      const slug = uniqueSlug(baseSlug, usedSlugs);
      idToSlug.set(agent.id, slug);
    }

    const projectsSvc = projectService(db);
    const issuesSvc = issueService(db);
    const automationsSvc = automationService(db);
    const allProjectsRaw = include.projects || include.issues ? await projectsSvc.list(orgId) : [];
    assertNotAborted();
    const allProjects = allProjectsRaw.filter((project) => !project.archivedAt);
    const allAutomations = include.issues ? await automationsSvc.list(orgId) : [];
    assertNotAborted();
    const projectById = new Map(allProjects.map((project) => [project.id, project]));
    const projectByReference = new Map<string, typeof allProjects[number]>();
    for (const project of allProjects) {
      projectByReference.set(project.id, project);
      projectByReference.set(project.urlKey, project);
    }

    const selectedProjects = new Map<string, typeof allProjects[number]>();
    const normalizeProjectSelector = (selector: string) => selector.trim().toLowerCase();
    for (const selector of input.projects ?? []) {
      const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
      if (!match) {
        warnings.push(`Project selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedProjects.set(match.id, match);
    }

    const selectedIssues = new Map<string, Awaited<ReturnType<typeof issuesSvc.getById>>>();
    const selectedAutomations = new Map<string, typeof allAutomations[number]>();
    const automationById = new Map(allAutomations.map((automation) => [automation.id, automation]));
    const resolveIssueBySelector = async (selector: string) => {
      const trimmed = selector.trim();
      if (!trimmed) return null;
      return trimmed.includes("-")
        ? issuesSvc.getByIdentifier(trimmed)
        : issuesSvc.getById(trimmed);
    };
    for (const selector of input.issues ?? []) {
      const issue = await resolveIssueBySelector(selector);
      if (!issue || issue.orgId !== orgId) {
        const automation = automationById.get(selector.trim());
        if (automation) {
          selectedAutomations.set(automation.id, automation);
          if (automation.projectId) {
            const parentProject = projectById.get(automation.projectId);
            if (parentProject) selectedProjects.set(parentProject.id, parentProject);
          }
          continue;
        }
        warnings.push(`Issue selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedIssues.set(issue.id, issue);
      if (issue.projectId) {
        const parentProject = projectById.get(issue.projectId);
        if (parentProject) selectedProjects.set(parentProject.id, parentProject);
      }
    }

    for (const selector of input.projectIssues ?? []) {
      const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
      if (!match) {
        warnings.push(`Project-issues selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedProjects.set(match.id, match);
      const projectIssues = await issuesSvc.list(orgId, { projectId: match.id });
      assertNotAborted();
      for (const issue of projectIssues) {
        selectedIssues.set(issue.id, issue);
      }
      for (const automation of allAutomations.filter((entry) => entry.projectId === match.id)) {
        selectedAutomations.set(automation.id, automation);
      }
    }

    if (include.projects && selectedProjects.size === 0) {
      for (const project of allProjects) {
        selectedProjects.set(project.id, project);
      }
    }

    if (include.issues && selectedIssues.size === 0) {
      const allIssues = await issuesSvc.list(orgId);
      assertNotAborted();
      for (const issue of allIssues) {
        selectedIssues.set(issue.id, issue);
        if (issue.projectId) {
          const parentProject = projectById.get(issue.projectId);
          if (parentProject) selectedProjects.set(parentProject.id, parentProject);
        }
      }
      if (selectedAutomations.size === 0) {
        for (const automation of allAutomations) {
          selectedAutomations.set(automation.id, automation);
          if (automation.projectId) {
            const parentProject = projectById.get(automation.projectId);
            if (parentProject) selectedProjects.set(parentProject.id, parentProject);
          }
        }
      }
    }

    const selectedProjectRows = Array.from(selectedProjects.values())
      .sort((left, right) => left.name.localeCompare(right.name));
    const selectedIssueRows = Array.from(selectedIssues.values())
      .filter((issue): issue is NonNullable<typeof issue> => issue != null)
      .sort((left, right) => (left.identifier ?? left.title).localeCompare(right.identifier ?? right.title));
    const selectedAutomationSummaries = Array.from(selectedAutomations.values())
      .sort((left, right) => left.title.localeCompare(right.title));
    const selectedAutomationRows = (
      await Promise.all(selectedAutomationSummaries.map((automation) => automationsSvc.getDetail(automation.id)))
    ).filter((automation): automation is AutomationLike => automation !== null);
    assertNotAborted();
    reportProgress(
      "resolving_selection",
      `Resolved ${selectedAgents.size} agents, ${selectedProjects.size} projects, and ${selectedIssues.size + selectedAutomations.size} tasks.`,
      2,
      Object.keys(files).length,
    );

    const taskSlugByIssueId = new Map<string, string>();
    const taskSlugByAutomationId = new Map<string, string>();
    const usedTaskSlugs = new Set<string>();
    for (const issue of selectedIssueRows) {
      const baseSlug = normalizeAgentUrlKey(issue.identifier ?? issue.title) ?? "task";
      taskSlugByIssueId.set(issue.id, uniqueSlug(baseSlug, usedTaskSlugs));
    }
    for (const automation of selectedAutomationRows) {
      const baseSlug = normalizeAgentUrlKey(automation.title) ?? "task";
      taskSlugByAutomationId.set(automation.id, uniqueSlug(baseSlug, usedTaskSlugs));
    }

    const projectSlugById = new Map<string, string>();
    const projectWorkspaceKeyByProjectId = new Map<string, Map<string, string>>();
    const usedProjectSlugs = new Set<string>();
    for (const project of selectedProjectRows) {
      const baseSlug = deriveProjectUrlKey(project.name, project.name);
      projectSlugById.set(project.id, uniqueSlug(baseSlug, usedProjectSlugs));
    }
    const sidebarOrder = requestedSidebarOrder ?? stripEmptyValues({
      agents: sortAgentsBySidebarOrder(Array.from(selectedAgents.values()))
        .map((agent) => idToSlug.get(agent.id))
        .filter((slug): slug is string => Boolean(slug)),
      projects: selectedProjectRows
        .map((project) => projectSlugById.get(project.id))
        .filter((slug): slug is string => Boolean(slug)),
    });

    const companyPath = "ORGANIZATION.md";
    files[companyPath] = buildMarkdown(
      {
        name: organization.name,
        description: organization.description ?? null,
        schema: "agentorganizations/v1",
        slug: rootPath,
      },
      "",
    );

    if (include.organization && organization.logoAssetId) {
      if (!storage) {
        warnings.push("Skipped organization logo from export because storage is unavailable.");
      } else {
        const logoAsset = await assetRecords.getById(organization.logoAssetId);
        if (!logoAsset) {
          warnings.push(`Skipped organization logo ${organization.logoAssetId} because the asset record was not found.`);
        } else {
          try {
            const object = await storage.getObject(organization.id, logoAsset.objectKey);
            const body = await streamToBuffer(object.stream);
            companyLogoPath = `images/${COMPANY_LOGO_FILE_NAME}${resolveCompanyLogoExtension(logoAsset.contentType, logoAsset.originalFilename)}`;
            files[companyLogoPath] = bufferToPortableBinaryFile(body, logoAsset.contentType);
          } catch (err) {
            warnings.push(`Failed to export organization logo ${organization.logoAssetId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    const rudderAgentsOut: Record<string, Record<string, unknown>> = {};
    const rudderProjectsOut: Record<string, Record<string, unknown>> = {};
    const rudderTasksOut: Record<string, Record<string, unknown>> = {};
    const unportableTaskWorkspaceRefs = new Map<string, { workspaceId: string; taskSlugs: string[] }>();
    const rudderAutomationsOut: Record<string, Record<string, unknown>> = {};

    const skillByReference = new Map<string, typeof organizationSkillRows[number]>();
    for (const skill of organizationSkillRows) {
      skillByReference.set(skill.id, skill);
      skillByReference.set(skill.key, skill);
      skillByReference.set(skill.slug, skill);
      skillByReference.set(skill.name, skill);
    }
    const selectedSkills = new Map<string, typeof organizationSkillRows[number]>();
    for (const selector of input.skills ?? []) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      const normalized = normalizeSkillKey(trimmed) ?? normalizeSkillSlug(trimmed) ?? trimmed;
      const match = skillByReference.get(trimmed) ?? skillByReference.get(normalized);
      if (!match) {
        warnings.push(`Skill selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedSkills.set(match.id, match);
    }
    if (selectedSkills.size === 0) {
      for (const skill of organizationSkillRows) {
        selectedSkills.set(skill.id, skill);
      }
    }
    const selectedSkillRows = Array.from(selectedSkills.values())
      .sort((left, right) => left.key.localeCompare(right.key));

    const skillExportDirs = buildSkillExportDirMap(selectedSkillRows, organization.issuePrefix);
    if (selectedSkillRows.length > 0) {
      reportProgress("rendering_skills", `Rendering ${selectedSkillRows.length} skill files.`, 3, Object.keys(files).length);
    }
    for (const skill of selectedSkillRows) {
      assertNotAborted();
      const packageDir = skillExportDirs.get(skill.key) ?? `skills/${normalizeSkillSlug(skill.slug) ?? "skill"}`;
      if (shouldReferenceSkillOnExport(skill, Boolean(input.expandReferencedSkills))) {
        files[`${packageDir}/SKILL.md`] = await buildReferencedSkillMarkdown(skill);
        assertNotAborted();
        continue;
      }

      for (const inventoryEntry of skill.fileInventory) {
        assertNotAborted();
        const fileDetail = await organizationSkills.readFile(orgId, skill.id, inventoryEntry.path).catch(() => null);
        if (!fileDetail) continue;
        const filePath = `${packageDir}/${inventoryEntry.path}`;
        files[filePath] = inventoryEntry.path === "SKILL.md"
          ? await withSkillSourceMetadata(skill, fileDetail.content)
          : fileDetail.content;
      }
    }

    if (include.agents) {
      reportProgress("rendering_agents", `Rendering ${agentRows.length} agent files.`, 4, Object.keys(files).length);
      for (const agent of agentRows) {
        assertNotAborted();
        const slug = idToSlug.get(agent.id)!;
        const exportedInstructions = await instructions.exportFiles(agent);
        assertNotAborted();
        warnings.push(...exportedInstructions.warnings);
        const portableInstructions = ensurePortableAgentEntryFile(
          exportedInstructions.files,
          exportedInstructions.entryFile,
          asString((agent.agentRuntimeConfig as Record<string, unknown>).promptTemplate) ?? "",
        );

        const envInputsStart = envInputs.length;
        const exportedEnvInputs = extractPortableEnvInputs(
          slug,
          (agent.agentRuntimeConfig as Record<string, unknown>).env,
          warnings,
        );
        envInputs.push(...exportedEnvInputs);
        const adapterDefaultRules = ADAPTER_DEFAULT_RULES_BY_TYPE[agent.agentRuntimeType] ?? [];
        const portableAdapterConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.agentRuntimeConfig),
          {
            dropFalseBooleans: true,
            defaultRules: adapterDefaultRules,
          },
        ) as Record<string, unknown>;
        const portableRuntimeConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.runtimeConfig),
          {
            dropFalseBooleans: true,
            defaultRules: RUNTIME_DEFAULT_RULES,
          },
        ) as Record<string, unknown>;
        const portablePermissions = pruneDefaultLikeValue(agent.permissions ?? {}, { dropFalseBooleans: true }) as Record<string, unknown>;
        const agentEnvInputs = dedupeEnvInputs(
          envInputs
            .slice(envInputsStart)
            .filter((inputValue) => inputValue.agentSlug === slug),
        );
        const reportsToSlug = agent.reportsTo ? (idToSlug.get(agent.reportsTo) ?? null) : null;
        const desiredSkills = await organizationSkills.getEnabledSkillKeysForAgent(agent.orgId, agent);
        assertNotAborted();

        const commandValue = asString(portableAdapterConfig.command);
        if (commandValue && isAbsoluteCommand(commandValue)) {
          warnings.push(`Agent ${slug} command ${commandValue} was omitted from export because it is system-dependent.`);
          delete portableAdapterConfig.command;
        }
        for (const [relativePath, content] of Object.entries(portableInstructions.files)) {
          const targetPath = `agents/${slug}/${relativePath}`;
          if (relativePath === portableInstructions.entryFile) {
            files[targetPath] = buildMarkdown(
              stripEmptyValues({
                name: agent.name,
                title: agent.title ?? null,
                reportsTo: reportsToSlug,
                skills: desiredSkills.length > 0 ? desiredSkills : undefined,
              }) as Record<string, unknown>,
              content,
            );
          } else {
            files[targetPath] = content;
          }
        }

        const extension = stripEmptyValues({
          role: agent.role !== "agent" ? agent.role : undefined,
          icon: agent.icon ?? null,
          capabilities: agent.capabilities ?? null,
          adapter: {
            type: agent.agentRuntimeType,
            config: portableAdapterConfig,
          },
          runtime: portableRuntimeConfig,
          permissions: portablePermissions,
          budgetMonthlyCents: (agent.budgetMonthlyCents ?? 0) > 0 ? agent.budgetMonthlyCents : undefined,
          metadata: (agent.metadata as Record<string, unknown> | null) ?? null,
        });
        if (isPlainRecord(extension) && agentEnvInputs.length > 0) {
          extension.inputs = {
            env: buildEnvInputMap(agentEnvInputs),
          };
        }
        rudderAgentsOut[slug] = isPlainRecord(extension) ? extension : {};
      }
    }

    if (selectedProjectRows.length > 0) {
      reportProgress("rendering_projects", `Rendering ${selectedProjectRows.length} project files.`, 5, Object.keys(files).length);
    }
    for (const project of selectedProjectRows) {
      assertNotAborted();
      const slug = projectSlugById.get(project.id)!;
      const projectPath = `projects/${slug}/PROJECT.md`;
      const portableWorkspaces = await buildPortableProjectWorkspaces(slug, project.workspaces, warnings);
      projectWorkspaceKeyByProjectId.set(project.id, portableWorkspaces.workspaceKeyById);
      files[projectPath] = buildMarkdown(
        {
          name: project.name,
          description: project.description ?? null,
          owner: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
        },
        project.description ?? "",
      );
      const extension = stripEmptyValues({
        leadAgentSlug: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
        targetDate: project.targetDate ?? null,
        color: project.color ?? null,
        icon: project.icon ?? null,
        status: project.status,
        executionWorkspacePolicy: exportPortableProjectExecutionWorkspacePolicy(
          slug,
          project.executionWorkspacePolicy,
          portableWorkspaces.workspaceKeyById,
          warnings,
        ) ?? undefined,
        workspaces: portableWorkspaces.extension,
      });
      rudderProjectsOut[slug] = isPlainRecord(extension) ? extension : {};
    }

    if (selectedIssueRows.length > 0 || selectedAutomationRows.length > 0) {
      reportProgress(
        "rendering_tasks",
        `Rendering ${selectedIssueRows.length + selectedAutomationRows.length} task files.`,
        6,
        Object.keys(files).length,
      );
    }
    for (const issue of selectedIssueRows) {
      assertNotAborted();
      const taskSlug = taskSlugByIssueId.get(issue.id)!;
      const projectSlug = issue.projectId ? (projectSlugById.get(issue.projectId) ?? null) : null;
      // All tasks go in top-level tasks/ folder, never nested under projects/
      const taskPath = `tasks/${taskSlug}/TASK.md`;
      const assigneeSlug = issue.assigneeAgentId ? (idToSlug.get(issue.assigneeAgentId) ?? null) : null;
      const parentSlug = issue.parentId ? (taskSlugByIssueId.get(issue.parentId) ?? null) : null;
      const projectWorkspaceKey = issue.projectId && issue.projectWorkspaceId
        ? projectWorkspaceKeyByProjectId.get(issue.projectId)?.get(issue.projectWorkspaceId) ?? null
        : null;
      if (issue.projectWorkspaceId && !projectWorkspaceKey) {
        const aggregateKey = `${issue.projectId ?? "no-project"}:${issue.projectWorkspaceId}`;
        const existing = unportableTaskWorkspaceRefs.get(aggregateKey);
        if (existing) {
          existing.taskSlugs.push(taskSlug);
        } else {
          unportableTaskWorkspaceRefs.set(aggregateKey, {
            workspaceId: issue.projectWorkspaceId,
            taskSlugs: [taskSlug],
          });
        }
      }
      files[taskPath] = buildMarkdown(
        {
          name: issue.title,
          project: projectSlug,
          assignee: assigneeSlug,
          parent: parentSlug,
        },
        issue.description ?? "",
      );
      const extension = stripEmptyValues({
        identifier: issue.identifier,
        status: issue.status,
        priority: issue.priority,
        labelIds: issue.labelIds ?? undefined,
        billingCode: issue.billingCode ?? null,
        projectWorkspaceKey: projectWorkspaceKey ?? undefined,
        executionWorkspaceSettings: issue.executionWorkspaceSettings ?? undefined,
        assigneeAgentRuntimeOverrides: issue.assigneeAgentRuntimeOverrides ?? undefined,
        parentIssueSlug: parentSlug ?? undefined,
      });
      rudderTasksOut[taskSlug] = isPlainRecord(extension) ? extension : {};
    }

    for (const { workspaceId, taskSlugs } of unportableTaskWorkspaceRefs.values()) {
      const preview = taskSlugs.slice(0, 4).join(", ");
      const remainder = taskSlugs.length > 4 ? ` and ${taskSlugs.length - 4} more` : "";
      warnings.push(`Tasks ${preview}${remainder} reference workspace ${workspaceId}, but that workspace could not be exported portably.`);
    }

    for (const automation of selectedAutomationRows) {
      assertNotAborted();
      const taskSlug = taskSlugByAutomationId.get(automation.id)!;
      const projectSlug = automation.projectId ? (projectSlugById.get(automation.projectId) ?? null) : null;
      const taskPath = `tasks/${taskSlug}/TASK.md`;
      const assigneeSlug = idToSlug.get(automation.assigneeAgentId) ?? null;
      files[taskPath] = buildMarkdown(
        {
          name: automation.title,
          project: projectSlug,
          assignee: assigneeSlug,
          recurring: true,
        },
        automation.description ?? "",
      );
      const extension = stripEmptyValues({
        status: automation.status !== "active" ? automation.status : undefined,
        priority: automation.priority !== "medium" ? automation.priority : undefined,
        concurrencyPolicy: automation.concurrencyPolicy !== "coalesce_if_active" ? automation.concurrencyPolicy : undefined,
        catchUpPolicy: automation.catchUpPolicy !== "skip_missed" ? automation.catchUpPolicy : undefined,
        triggers: automation.triggers.map((trigger) => stripEmptyValues({
          kind: trigger.kind,
          label: trigger.label ?? null,
          enabled: trigger.enabled ? undefined : false,
          cronExpression: trigger.kind === "schedule" ? trigger.cronExpression ?? null : undefined,
          timezone: trigger.kind === "schedule" ? trigger.timezone ?? null : undefined,
          signingMode: trigger.kind === "webhook" && trigger.signingMode !== "bearer" ? trigger.signingMode ?? null : undefined,
          replayWindowSec: trigger.kind === "webhook" && trigger.replayWindowSec !== 300
            ? trigger.replayWindowSec ?? null
            : undefined,
        })),
      });
      rudderAutomationsOut[taskSlug] = isPlainRecord(extension) ? extension : {};
    }

    const rudderExtensionPath = ".rudder.yaml";
    const rudderAgents = Object.fromEntries(
      Object.entries(rudderAgentsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const rudderProjects = Object.fromEntries(
      Object.entries(rudderProjectsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const rudderTasks = Object.fromEntries(
      Object.entries(rudderTasksOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const rudderAutomations = Object.fromEntries(
      Object.entries(rudderAutomationsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    files[rudderExtensionPath] = buildYamlFile(
      {
        schema: "rudder/v1",
        organization: stripEmptyValues({
          brandColor: organization.brandColor ?? null,
          logoPath: companyLogoPath,
          requireBoardApprovalForNewAgents: organization.requireBoardApprovalForNewAgents ? undefined : false,
        }),
        sidebar: stripEmptyValues(sidebarOrder),
        agents: Object.keys(rudderAgents).length > 0 ? rudderAgents : undefined,
        projects: Object.keys(rudderProjects).length > 0 ? rudderProjects : undefined,
        tasks: Object.keys(rudderTasks).length > 0 ? rudderTasks : undefined,
        automations: Object.keys(rudderAutomations).length > 0 ? rudderAutomations : undefined,
      },
      { preserveEmptyStrings: true },
    );

    let finalFiles = filterExportFiles(files, input.selectedFiles, rudderExtensionPath);
    let resolved = buildManifestFromPackageFiles(finalFiles, {
      sourceLabel: {
        orgId: organization.id,
        organizationName: organization.name,
      },
    });
    resolved.manifest.includes = {
      organization: resolved.manifest.organization !== null,
      agents: resolved.manifest.agents.length > 0,
      projects: resolved.manifest.projects.length > 0,
      issues: resolved.manifest.issues.length > 0,
      skills: resolved.manifest.skills.length > 0,
    };
    resolved.manifest.envInputs = dedupeEnvInputs(envInputs);
    resolved.warnings.unshift(...warnings);

    // Generate org chart PNG from manifest agents
    if (resolved.manifest.agents.length > 0) {
      try {
        assertNotAborted();
        reportProgress("generating_assets", "Generating organization chart image.", 7, Object.keys(finalFiles).length);
        const orgNodes = buildOrgTreeFromManifest(resolved.manifest.agents);
        const pngBuffer = await renderOrgChartPng(orgNodes);
        assertNotAborted();
        finalFiles["images/org-chart.png"] = bufferToPortableBinaryFile(pngBuffer, "image/png");
      } catch (err) {
        if (options.signal?.aborted) throw err;
        // Non-fatal: export still works without the org chart image
      }
    }

    reportProgress("finalizing", "Finalizing export manifest and README.", 7, Object.keys(finalFiles).length);
    if (!input.selectedFiles || input.selectedFiles.some((entry) => normalizePortablePath(entry) === "README.md")) {
      finalFiles["README.md"] = generateReadme(resolved.manifest, {
        organizationName: organization.name,
        organizationDescription: organization.description ?? null,
      });
    }

    resolved = buildManifestFromPackageFiles(finalFiles, {
      sourceLabel: {
        orgId: organization.id,
        organizationName: organization.name,
      },
    });
    resolved.manifest.includes = {
      organization: resolved.manifest.organization !== null,
      agents: resolved.manifest.agents.length > 0,
      projects: resolved.manifest.projects.length > 0,
      issues: resolved.manifest.issues.length > 0,
      skills: resolved.manifest.skills.length > 0,
    };
    resolved.manifest.envInputs = dedupeEnvInputs(envInputs);
    resolved.warnings.unshift(...warnings);
    assertNotAborted();
    reportProgress("ready", "Export package is ready.", 8, Object.keys(finalFiles).length);

    return {
      rootPath,
      manifest: resolved.manifest,
      files: finalFiles,
      warnings: resolved.warnings,
      rudderExtensionPath,
    };
  }

  async function previewExport(
    orgId: string,
    input: OrganizationPortabilityExport,
  ): Promise<OrganizationPortabilityExportPreviewResult> {
    const previewInput: OrganizationPortabilityExport = {
      ...input,
      include: {
        ...input.include,
        issues:
          input.include?.issues
          ?? Boolean((input.issues && input.issues.length > 0) || (input.projectIssues && input.projectIssues.length > 0))
          ?? false,
      },
    };
    if (previewInput.include && previewInput.include.issues === undefined) {
      previewInput.include.issues = false;
    }
    const exported = await exportBundle(orgId, previewInput);
    return {
      ...exported,
      fileInventory: Object.keys(exported.files)
        .sort((left, right) => left.localeCompare(right))
        .map((filePath) => ({
          path: filePath,
          kind: classifyPortableFileKind(filePath),
        })),
      counts: {
        files: Object.keys(exported.files).length,
        agents: exported.manifest.agents.length,
        skills: exported.manifest.skills.length,
        projects: exported.manifest.projects.length,
        issues: exported.manifest.issues.length,
      },
    };
  }

  return { exportBundle, previewExport };
}
