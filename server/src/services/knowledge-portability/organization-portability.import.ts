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
  COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS,
  type ImportBehaviorOptions,
  asString,
  disableImportedTimerHeartbeat,
  importPortableProjectExecutionWorkspacePolicy,
  resolveImportMode,
  resolvePortableAutomationDefinition,
  resolveSkillConflictStrategy,
  stripPortableProjectExecutionWorkspaceRefs,
} from "./organization-portability.core.js";
import {
  inferContentTypeFromPath,
  isPortableBinaryFile,
  normalizePortablePath,
  pickTextFiles,
  portableFileToBuffer,
  readPortableTextFile,
} from "./organization-portability.files.js";
import { parseFrontmatterMarkdown } from "./organization-portability.package.js";
import type { createOrganizationPortabilityPreviewHandlers } from "./organization-portability.preview.js";

type ImportContext = {
  db: Db;
  storage?: StorageService;
  access: ReturnType<typeof accessService>;
  organizations: ReturnType<typeof organizationService>;
  agents: ReturnType<typeof agentService>;
  assetRecords: ReturnType<typeof assetService>;
  instructions: ReturnType<typeof agentInstructionsService>;
  projects: ReturnType<typeof projectService>;
  issues: ReturnType<typeof issueService>;
  organizationSkills: ReturnType<typeof organizationSkillService>;
  buildPreview: ReturnType<typeof createOrganizationPortabilityPreviewHandlers>["buildPreview"];
};

export function createOrganizationPortabilityImportHandlers(context: ImportContext) {
  const { db, storage, access, organizations, agents, assetRecords, instructions, projects, issues, organizationSkills, buildPreview } = context;

  async function importBundle(
    input: OrganizationPortabilityImport,
    actorUserId: string | null | undefined,
    options?: ImportBehaviorOptions,
  ): Promise<OrganizationPortabilityImportResult> {
    const mode = resolveImportMode(options);
    const plan = await buildPreview(input, options);
    if (plan.preview.errors.length > 0) {
      throw unprocessable(`Import preview has errors: ${plan.preview.errors.join("; ")}`);
    }
    if (
      mode === "agent_safe"
      && (
        plan.preview.plan.organizationAction === "update"
        || plan.preview.plan.agentPlans.some((entry) => entry.action === "update")
        || plan.preview.plan.projectPlans.some((entry) => entry.action === "update")
      )
    ) {
      throw unprocessable("Safe import routes only allow create or skip actions.");
    }

    const sourceManifest = plan.source.manifest;
    const warnings = [...plan.preview.warnings];
    const include = plan.include;

    let targetOrganization: { id: string; name: string } | null = null;
    let organizationAction: "created" | "updated" | "unchanged" = "unchanged";

    if (input.target.mode === "new_organization") {
      if (mode === "agent_safe" && !options?.sourceOrganizationId) {
        throw unprocessable("Safe new-organization imports require a source organization context.");
      }
      if (mode === "agent_safe" && options?.sourceOrganizationId) {
        const sourceMemberships = await access.listActiveUserMemberships(options.sourceOrganizationId);
        if (sourceMemberships.length === 0) {
          throw unprocessable("Safe new-organization import requires at least one active user membership on the source organization.");
        }
      }
      const organizationName =
        asString(input.target.newOrganizationName) ??
        sourceManifest.organization?.name ??
        sourceManifest.source?.organizationName ??
        "Imported Organization";
      const created = await organizations.create({
        name: organizationName,
        urlKey: deriveOrganizationUrlKey(organizationName),
        description: include.organization ? (sourceManifest.organization?.description ?? null) : null,
        brandColor: include.organization ? (sourceManifest.organization?.brandColor ?? null) : null,
        budgetMonthlyCents: 0,
        defaultChatIssueCreationMode: "manual_approval",
        requireBoardApprovalForNewAgents: include.organization
          ? (sourceManifest.organization?.requireBoardApprovalForNewAgents ?? true)
          : true,
      });
      if (mode === "agent_safe" && options?.sourceOrganizationId) {
        await access.copyActiveUserMemberships(options.sourceOrganizationId, created.id);
      } else {
        await access.ensureMembership(created.id, "user", actorUserId ?? "board", "owner", "active");
      }
      targetOrganization = created;
      organizationAction = "created";
    } else {
      targetOrganization = await organizations.getById(input.target.orgId);
      if (!targetOrganization) throw notFound("Target organization not found");
      if (include.organization && sourceManifest.organization && mode === "board_full") {
        const updated = await organizations.update(targetOrganization.id, {
          name: sourceManifest.organization.name,
          description: sourceManifest.organization.description,
          brandColor: sourceManifest.organization.brandColor,
          requireBoardApprovalForNewAgents: sourceManifest.organization.requireBoardApprovalForNewAgents,
        });
        targetOrganization = updated ?? targetOrganization;
        organizationAction = "updated";
      }
    }

    if (!targetOrganization) throw notFound("Target organization not found");

    if (include.organization) {
      const logoPath = sourceManifest.organization?.logoPath ?? null;
      if (!logoPath) {
        const cleared = await organizations.update(targetOrganization.id, { logoAssetId: null });
        targetOrganization = cleared ?? targetOrganization;
      } else {
        const logoFile = plan.source.files[logoPath];
        if (!logoFile) {
          warnings.push(`Skipped organization logo import because ${logoPath} is missing from the package.`);
        } else if (!storage) {
          warnings.push("Skipped organization logo import because storage is unavailable.");
        } else {
          const contentType = isPortableBinaryFile(logoFile)
            ? (logoFile.contentType ?? inferContentTypeFromPath(logoPath))
            : inferContentTypeFromPath(logoPath);
          if (!contentType || !COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS[contentType]) {
            warnings.push(`Skipped organization logo import for ${logoPath} because the file type is unsupported.`);
          } else {
            try {
              const body = portableFileToBuffer(logoFile, logoPath);
              const stored = await storage.putFile({
                orgId: targetOrganization.id,
                namespace: "assets/orgs",
                originalFilename: path.posix.basename(logoPath),
                contentType,
                body,
              });
              const createdAsset = await assetRecords.create(targetOrganization.id, {
                provider: stored.provider,
                objectKey: stored.objectKey,
                contentType: stored.contentType,
                byteSize: stored.byteSize,
                sha256: stored.sha256,
                originalFilename: stored.originalFilename,
                createdByAgentId: null,
                createdByUserId: actorUserId ?? null,
              });
              const updated = await organizations.update(targetOrganization.id, {
                logoAssetId: createdAsset.id,
              });
              targetOrganization = updated ?? targetOrganization;
            } catch (err) {
              warnings.push(`Failed to import organization logo ${logoPath}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    }

    const resultAgents: OrganizationPortabilityImportResult["agents"] = [];
    const resultProjects: OrganizationPortabilityImportResult["projects"] = [];
    const importedSlugToAgentId = new Map<string, string>();
    const existingSlugToAgentId = new Map<string, string>();
    const existingAgents = await agents.list(targetOrganization.id);
    for (const existing of existingAgents) {
      existingSlugToAgentId.set(normalizeAgentUrlKey(existing.name) ?? existing.id, existing.id);
    }
    const importedSlugToProjectId = new Map<string, string>();
    const importedProjectWorkspaceIdByProjectSlug = new Map<string, Map<string, string>>();
    const existingProjectSlugToId = new Map<string, string>();
    const existingProjects = await projects.list(targetOrganization.id);
    for (const existing of existingProjects) {
      existingProjectSlugToId.set(existing.urlKey, existing.id);
    }

    const importedSkills = include.skills || include.agents
      ? await organizationSkills.importPackageFiles(targetOrganization.id, pickTextFiles(plan.source.files), {
          onConflict: resolveSkillConflictStrategy(mode, plan.collisionStrategy),
        })
      : [];
    const desiredSkillRefMap = new Map<string, string>();
    for (const importedSkill of importedSkills) {
      desiredSkillRefMap.set(importedSkill.originalKey, importedSkill.skill.key);
      desiredSkillRefMap.set(importedSkill.originalSlug, importedSkill.skill.key);
      if (importedSkill.action === "skipped") {
        warnings.push(`Skipped skill ${importedSkill.originalSlug}; existing skill ${importedSkill.skill.slug} was kept.`);
      } else if (importedSkill.originalKey !== importedSkill.skill.key) {
        warnings.push(`Imported skill ${importedSkill.originalSlug} as ${importedSkill.skill.slug} to avoid overwriting an existing skill.`);
      }
    }

    if (include.agents) {
      for (const planAgent of plan.preview.plan.agentPlans) {
        const manifestAgent = plan.selectedAgents.find((agent) => agent.slug === planAgent.slug);
        if (!manifestAgent) continue;
        if (planAgent.action === "skip") {
          resultAgents.push({
            slug: planAgent.slug,
            id: planAgent.existingAgentId,
            action: "skipped",
            name: planAgent.plannedName,
            reason: planAgent.reason,
          });
          continue;
        }

        const bundlePrefix = `agents/${manifestAgent.slug}/`;
        const bundleFiles = Object.fromEntries(
          Object.entries(plan.source.files)
            .filter(([filePath]) => filePath.startsWith(bundlePrefix))
            .flatMap(([filePath, content]) => typeof content === "string"
              ? [[normalizePortablePath(filePath.slice(bundlePrefix.length)), content] as const]
              : []),
        );
        const markdownRaw = bundleFiles["AGENTS.md"] ?? readPortableTextFile(plan.source.files, manifestAgent.path);
        const entryRelativePath = normalizePortablePath(manifestAgent.path).startsWith(bundlePrefix)
          ? normalizePortablePath(manifestAgent.path).slice(bundlePrefix.length)
          : "AGENTS.md";
        if (typeof markdownRaw === "string") {
          const importedInstructionsBody = parseFrontmatterMarkdown(markdownRaw).body;
          bundleFiles[entryRelativePath] = importedInstructionsBody;
          if (entryRelativePath !== "AGENTS.md") {
            bundleFiles["AGENTS.md"] = importedInstructionsBody;
          }
        }
        const fallbackPromptTemplate = asString((manifestAgent.agentRuntimeConfig as Record<string, unknown>).promptTemplate) || "";
        if (!markdownRaw && fallbackPromptTemplate) {
          bundleFiles["AGENTS.md"] = fallbackPromptTemplate;
        }
        if (!markdownRaw && !fallbackPromptTemplate) {
          warnings.push(`Missing AGENTS markdown for ${manifestAgent.slug}; imported with an empty managed bundle.`);
        }

        // Apply adapter overrides from request if present
        const adapterOverride = input.agentRuntimeOverrides?.[planAgent.slug];
        const effectiveAdapterType = adapterOverride?.agentRuntimeType ?? manifestAgent.agentRuntimeType;
        const baseAdapterConfig = adapterOverride?.agentRuntimeConfig
          ? { ...adapterOverride.agentRuntimeConfig }
          : { ...manifestAgent.agentRuntimeConfig } as Record<string, unknown>;

        const desiredSkills = (manifestAgent.skills ?? []).map((skillRef) => desiredSkillRefMap.get(skillRef) ?? skillRef);
        const agentRuntimeConfigWithoutSkills = { ...baseAdapterConfig };
        delete agentRuntimeConfigWithoutSkills.promptTemplate;
        delete agentRuntimeConfigWithoutSkills.bootstrapPromptTemplate;
        delete agentRuntimeConfigWithoutSkills.instructionsFilePath;
        delete agentRuntimeConfigWithoutSkills.instructionsBundleMode;
        delete agentRuntimeConfigWithoutSkills.instructionsRootPath;
        delete agentRuntimeConfigWithoutSkills.instructionsEntryFile;
        delete agentRuntimeConfigWithoutSkills.rudderSkillSync;
        delete agentRuntimeConfigWithoutSkills.paperclipSkillSync;
        delete agentRuntimeConfigWithoutSkills.rudderRuntimeSkills;
        delete agentRuntimeConfigWithoutSkills.paperclipRuntimeSkills;
        const patch = {
          name: planAgent.plannedName,
          role: manifestAgent.role,
          title: manifestAgent.title,
          icon: manifestAgent.icon,
          capabilities: manifestAgent.capabilities,
          reportsTo: null,
          agentRuntimeType: effectiveAdapterType,
          agentRuntimeConfig: agentRuntimeConfigWithoutSkills,
          runtimeConfig: disableImportedTimerHeartbeat(manifestAgent.runtimeConfig),
          budgetMonthlyCents: manifestAgent.budgetMonthlyCents,
          permissions: manifestAgent.permissions,
          metadata: manifestAgent.metadata,
        };

        if (planAgent.action === "update" && planAgent.existingAgentId) {
          let updated = await agents.update(planAgent.existingAgentId, patch);
          if (!updated) {
            warnings.push(`Skipped update for missing agent ${planAgent.existingAgentId}.`);
            resultAgents.push({
              slug: planAgent.slug,
              id: null,
              action: "skipped",
              name: planAgent.plannedName,
              reason: "Existing target agent not found.",
            });
            continue;
          }
          await organizationSkills.replaceEnabledSkillKeysForAgent(
            targetOrganization.id,
            updated.id,
            desiredSkills,
          );
          try {
            const materialized = await instructions.materializeManagedBundle(updated, bundleFiles, {
              clearLegacyPromptTemplate: true,
              replaceExisting: true,
            });
            updated = await agents.update(updated.id, { agentRuntimeConfig: materialized.agentRuntimeConfig }) ?? updated;
          } catch (err) {
            warnings.push(`Failed to materialize instructions bundle for ${manifestAgent.slug}: ${err instanceof Error ? err.message : String(err)}`);
          }
          importedSlugToAgentId.set(planAgent.slug, updated.id);
          existingSlugToAgentId.set(normalizeAgentUrlKey(updated.name) ?? updated.id, updated.id);
          resultAgents.push({
            slug: planAgent.slug,
            id: updated.id,
            action: "updated",
            name: updated.name,
            reason: planAgent.reason,
          });
          continue;
        }

        let created = await agents.create(targetOrganization.id, patch);
        await organizationSkills.replaceEnabledSkillKeysForAgent(
          targetOrganization.id,
          created.id,
          desiredSkills,
        );
        await access.ensureMembership(targetOrganization.id, "agent", created.id, "member", "active");
        await access.setPrincipalPermission(
          targetOrganization.id,
          "agent",
          created.id,
          "tasks:assign",
          true,
          actorUserId ?? null,
        );
        try {
          const materialized = await instructions.materializeManagedBundle(created, bundleFiles, {
            clearLegacyPromptTemplate: true,
            replaceExisting: true,
          });
          created = await agents.update(created.id, { agentRuntimeConfig: materialized.agentRuntimeConfig }) ?? created;
        } catch (err) {
          warnings.push(`Failed to materialize instructions bundle for ${manifestAgent.slug}: ${err instanceof Error ? err.message : String(err)}`);
        }
        importedSlugToAgentId.set(planAgent.slug, created.id);
        existingSlugToAgentId.set(normalizeAgentUrlKey(created.name) ?? created.id, created.id);
        resultAgents.push({
          slug: planAgent.slug,
          id: created.id,
          action: "created",
          name: created.name,
          reason: planAgent.reason,
        });
      }

      // Apply reporting links once all imported agent ids are available.
      for (const manifestAgent of plan.selectedAgents) {
        const agentId = importedSlugToAgentId.get(manifestAgent.slug);
        if (!agentId) continue;
        const managerSlug = manifestAgent.reportsToSlug;
        if (!managerSlug) continue;
        const managerId = importedSlugToAgentId.get(managerSlug) ?? existingSlugToAgentId.get(managerSlug) ?? null;
        if (!managerId || managerId === agentId) continue;
        try {
          await agents.update(agentId, { reportsTo: managerId });
        } catch {
          warnings.push(`Could not assign manager ${managerSlug} for imported agent ${manifestAgent.slug}.`);
        }
      }
    }

    if (include.projects) {
      for (const planProject of plan.preview.plan.projectPlans) {
        const manifestProject = sourceManifest.projects.find((project) => project.slug === planProject.slug);
        if (!manifestProject) continue;
        if (planProject.action === "skip") {
          resultProjects.push({
            slug: planProject.slug,
            id: planProject.existingProjectId,
            action: "skipped",
            name: planProject.plannedName,
            reason: planProject.reason,
          });
          continue;
        }

        const projectLeadAgentId = manifestProject.leadAgentSlug
          ? importedSlugToAgentId.get(manifestProject.leadAgentSlug)
            ?? existingSlugToAgentId.get(manifestProject.leadAgentSlug)
            ?? null
          : null;
        const projectWorkspaceIdByKey = new Map<string, string>();
        const projectPatch = {
          name: planProject.plannedName,
          description: manifestProject.description,
          leadAgentId: projectLeadAgentId,
          targetDate: manifestProject.targetDate,
          color: manifestProject.color,
          status: manifestProject.status && PROJECT_STATUSES.includes(manifestProject.status as any)
            ? manifestProject.status as typeof PROJECT_STATUSES[number]
            : "backlog",
          executionWorkspacePolicy: stripPortableProjectExecutionWorkspaceRefs(manifestProject.executionWorkspacePolicy),
        };

        let projectId: string | null = null;
        if (planProject.action === "update" && planProject.existingProjectId) {
          const updated = await projects.update(planProject.existingProjectId, projectPatch);
          if (!updated) {
            warnings.push(`Skipped update for missing project ${planProject.existingProjectId}.`);
            resultProjects.push({
              slug: planProject.slug,
              id: null,
              action: "skipped",
              name: planProject.plannedName,
              reason: "Existing target project not found.",
            });
            continue;
          }
          projectId = updated.id;
          importedSlugToProjectId.set(planProject.slug, updated.id);
          existingProjectSlugToId.set(updated.urlKey, updated.id);
          resultProjects.push({
            slug: planProject.slug,
            id: updated.id,
            action: "updated",
            name: updated.name,
            reason: planProject.reason,
          });
        } else {
          const created = await projects.create(targetOrganization.id, projectPatch);
          projectId = created.id;
          importedSlugToProjectId.set(planProject.slug, created.id);
          existingProjectSlugToId.set(created.urlKey, created.id);
          resultProjects.push({
            slug: planProject.slug,
            id: created.id,
            action: "created",
            name: created.name,
            reason: planProject.reason,
          });
        }

        if (!projectId) continue;

        for (const workspace of manifestProject.workspaces) {
          const createdWorkspace = await projects.createWorkspace(projectId, {
            name: workspace.name,
            sourceType: workspace.sourceType ?? undefined,
            repoUrl: workspace.repoUrl ?? undefined,
            repoRef: workspace.repoRef ?? undefined,
            defaultRef: workspace.defaultRef ?? undefined,
            visibility: workspace.visibility ?? undefined,
            setupCommand: workspace.setupCommand ?? undefined,
            cleanupCommand: workspace.cleanupCommand ?? undefined,
            metadata: workspace.metadata ?? undefined,
            isPrimary: workspace.isPrimary,
          });
          if (!createdWorkspace) {
            warnings.push(`Project ${planProject.slug} workspace ${workspace.key} could not be created during import.`);
            continue;
          }
          projectWorkspaceIdByKey.set(workspace.key, createdWorkspace.id);
        }
        importedProjectWorkspaceIdByProjectSlug.set(planProject.slug, projectWorkspaceIdByKey);

        const hydratedProjectExecutionWorkspacePolicy = importPortableProjectExecutionWorkspacePolicy(
          planProject.slug,
          manifestProject.executionWorkspacePolicy,
          projectWorkspaceIdByKey,
          warnings,
        );
        if (hydratedProjectExecutionWorkspacePolicy) {
          await projects.update(projectId, {
            executionWorkspacePolicy: hydratedProjectExecutionWorkspacePolicy,
          });
        }
      }
    }

    if (include.issues) {
      const automations = automationService(db);
      const importedSlugToIssueId = new Map<string, string>();
      const issueBySlug = new Map(sourceManifest.issues.map((i) => [i.slug, i]));

      // Topologically sort issues so parents are created before children
      const sortedIssues = [...sourceManifest.issues];
      const inDegree = new Map<string, number>();
      for (const issue of sortedIssues) {
        inDegree.set(issue.slug, issue.parentIssueSlug && issueBySlug.has(issue.parentIssueSlug) ? 1 : 0);
      }
      for (let i = 0; i < sortedIssues.length; i++) {
        const parent = sortedIssues[i];
        for (let j = i + 1; j < sortedIssues.length; j++) {
          const child = sortedIssues[j];
          if (child.parentIssueSlug === parent.slug) {
            inDegree.set(child.slug, (inDegree.get(child.slug) ?? 0) + 1);
          }
        }
      }
      sortedIssues.sort((a, b) => (inDegree.get(a.slug) ?? 0) - (inDegree.get(b.slug) ?? 0));

      for (const manifestIssue of sortedIssues) {
        const markdownRaw = readPortableTextFile(plan.source.files, manifestIssue.path);
        const parsed = markdownRaw ? parseFrontmatterMarkdown(markdownRaw) : null;
        const description = parsed?.body || manifestIssue.description || null;
        const assigneeAgentId = manifestIssue.assigneeAgentSlug
          ? importedSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? existingSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? null
          : null;
        const projectId = manifestIssue.projectSlug
          ? importedSlugToProjectId.get(manifestIssue.projectSlug)
            ?? existingProjectSlugToId.get(manifestIssue.projectSlug)
            ?? null
          : null;
        const projectWorkspaceId = manifestIssue.projectSlug && manifestIssue.projectWorkspaceKey
          ? importedProjectWorkspaceIdByProjectSlug.get(manifestIssue.projectSlug)?.get(manifestIssue.projectWorkspaceKey) ?? null
          : null;
        if (manifestIssue.projectWorkspaceKey && !projectWorkspaceId) {
          warnings.push(`Task ${manifestIssue.slug} references workspace key ${manifestIssue.projectWorkspaceKey}, but that workspace was not imported.`);
        }
        let parentIssueId: string | null = null;
        if (manifestIssue.parentIssueSlug) {
          parentIssueId = importedSlugToIssueId.get(manifestIssue.parentIssueSlug) ?? null;
          if (!parentIssueId) {
            warnings.push(`Task ${manifestIssue.slug} references parent ${manifestIssue.parentIssueSlug}, but that parent was not found in the import.`);
          }
        }
        if (manifestIssue.recurring) {
          if (!assigneeAgentId) {
            throw unprocessable(`Recurring task ${manifestIssue.slug} is missing the assignee required to create an automation.`);
          }
          const resolvedAutomation = resolvePortableAutomationDefinition(manifestIssue, parsed?.frontmatter.schedule);
          if (resolvedAutomation.errors.length > 0) {
            throw unprocessable(`Recurring task ${manifestIssue.slug} could not be imported as an automation: ${resolvedAutomation.errors.join("; ")}`);
          }
          warnings.push(...resolvedAutomation.warnings);
          const automationDefinition = resolvedAutomation.automation ?? {
            concurrencyPolicy: null,
            catchUpPolicy: null,
            triggers: [],
          };
          const createAutomationInput = {
            projectId,
            goalId: null,
            parentIssueId,
            title: manifestIssue.title,
            description,
            assigneeAgentId,
            priority: manifestIssue.priority && ISSUE_PRIORITIES.includes(manifestIssue.priority as any)
              ? manifestIssue.priority as typeof ISSUE_PRIORITIES[number]
              : "medium",
            status: manifestIssue.status && AUTOMATION_STATUSES.includes(manifestIssue.status as any)
              ? manifestIssue.status as typeof AUTOMATION_STATUSES[number]
              : "active",
            concurrencyPolicy:
              automationDefinition.concurrencyPolicy && AUTOMATION_CONCURRENCY_POLICIES.includes(automationDefinition.concurrencyPolicy as any)
                ? automationDefinition.concurrencyPolicy as typeof AUTOMATION_CONCURRENCY_POLICIES[number]
                : "coalesce_if_active",
            catchUpPolicy:
              automationDefinition.catchUpPolicy && AUTOMATION_CATCH_UP_POLICIES.includes(automationDefinition.catchUpPolicy as any)
                ? automationDefinition.catchUpPolicy as typeof AUTOMATION_CATCH_UP_POLICIES[number]
                : "skip_missed",
          } as Parameters<typeof automations.create>[1] & {
            outputMode?: "track_issue";
            chatConversationId?: null;
            allowAssigneeChatMismatch?: false;
          };
          createAutomationInput.outputMode = "track_issue";
          createAutomationInput.chatConversationId = null;
          createAutomationInput.allowAssigneeChatMismatch = false;
          const createdAutomation = await automations.create(targetOrganization.id, createAutomationInput, {
            agentId: null,
            userId: actorUserId ?? null,
          });
          for (const trigger of automationDefinition.triggers) {
            if (trigger.kind === "schedule") {
              await automations.createTrigger(createdAutomation.id, {
                kind: "schedule",
                label: trigger.label,
                enabled: trigger.enabled,
                cronExpression: trigger.cronExpression!,
                timezone: trigger.timezone!,
              }, {
                agentId: null,
                userId: actorUserId ?? null,
              });
              continue;
            }
            if (trigger.kind === "webhook") {
              await automations.createTrigger(createdAutomation.id, {
                kind: "webhook",
                label: trigger.label,
                enabled: trigger.enabled,
                signingMode:
                  trigger.signingMode && AUTOMATION_TRIGGER_SIGNING_MODES.includes(trigger.signingMode as any)
                    ? trigger.signingMode as typeof AUTOMATION_TRIGGER_SIGNING_MODES[number]
                    : "bearer",
                replayWindowSec: trigger.replayWindowSec ?? 300,
              }, {
                agentId: null,
                userId: actorUserId ?? null,
              });
              continue;
            }
            await automations.createTrigger(createdAutomation.id, {
              kind: "api",
              label: trigger.label,
              enabled: trigger.enabled,
            }, {
              agentId: null,
              userId: actorUserId ?? null,
            });
          }
          importedSlugToIssueId.set(manifestIssue.slug, createdAutomation.id);
          continue;
        }
        const createdIssue = await issues.create(targetOrganization.id, {
          projectId,
          projectWorkspaceId,
          title: manifestIssue.title,
          description,
          assigneeAgentId,
          parentId: parentIssueId,
          status: manifestIssue.status && ISSUE_STATUSES.includes(manifestIssue.status as any)
            ? manifestIssue.status as typeof ISSUE_STATUSES[number]
            : "backlog",
          priority: manifestIssue.priority && ISSUE_PRIORITIES.includes(manifestIssue.priority as any)
            ? manifestIssue.priority as typeof ISSUE_PRIORITIES[number]
            : "medium",
          billingCode: manifestIssue.billingCode,
          assigneeAgentRuntimeOverrides: manifestIssue.assigneeAgentRuntimeOverrides,
          executionWorkspaceSettings: manifestIssue.executionWorkspaceSettings,
          labelIds: [],
        });
        importedSlugToIssueId.set(manifestIssue.slug, createdIssue.id);
      }
    }

    return {
      organization: {
        id: targetOrganization.id,
        name: targetOrganization.name,
        action: organizationAction,
      },
      agents: resultAgents,
      projects: resultProjects,
      envInputs: sourceManifest.envInputs ?? [],
      warnings,
    };
  }

  return { importBundle };
}
