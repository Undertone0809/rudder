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
  DEFAULT_COLLISION_STRATEGY,
  type ImportBehaviorOptions,
  type ImportPlanInternal,
  asString,
  normalizeSkillSlug,
  resolveImportMode,
  resolvePortableAutomationDefinition,
  uniqueNameBySlug,
  uniqueProjectName,
} from "./organization-portability.core.js";
import {
  applySelectedFilesToSource,
  ensureMarkdownPath,
  normalizeInclude,
  readPortableTextFile,
} from "./organization-portability.files.js";
import { parseFrontmatterMarkdown } from "./organization-portability.package.js";
import { resolveSource } from "./organization-portability.resolve-source.js";

type PreviewContext = {
  organizations: ReturnType<typeof organizationService>;
  agents: ReturnType<typeof agentService>;
  projects: ReturnType<typeof projectService>;
  organizationSkills: ReturnType<typeof organizationSkillService>;
};

export function createOrganizationPortabilityPreviewHandlers(context: PreviewContext) {
  const { organizations, agents, projects, organizationSkills } = context;

  async function buildPreview(
    input: OrganizationPortabilityPreview,
    options?: ImportBehaviorOptions,
  ): Promise<ImportPlanInternal> {
    const mode = resolveImportMode(options);
    const requestedInclude = normalizeInclude(input.include);
    const source = applySelectedFilesToSource(await resolveSource(input.source), input.selectedFiles);
    const manifest = source.manifest;
    const include: OrganizationPortabilityInclude = {
      organization: requestedInclude.organization && manifest.organization !== null,
      agents: requestedInclude.agents && manifest.agents.length > 0,
      projects: requestedInclude.projects && manifest.projects.length > 0,
      issues: requestedInclude.issues && manifest.issues.length > 0,
      skills: requestedInclude.skills && manifest.skills.length > 0,
    };
    const collisionStrategy = input.collisionStrategy ?? DEFAULT_COLLISION_STRATEGY;
    if (mode === "agent_safe" && collisionStrategy === "replace") {
      throw unprocessable("Safe import routes do not allow replace collision strategy.");
    }
    const warnings = [...source.warnings];
    const errors: string[] = [];

    if (include.organization && !manifest.organization) {
      errors.push("Manifest does not include organization metadata.");
    }

    const selectedSlugs = include.agents
      ? (
          input.agents && input.agents !== "all"
            ? Array.from(new Set(input.agents))
            : manifest.agents.map((agent) => agent.slug)
        )
      : [];

    const selectedAgents = include.agents
      ? manifest.agents.filter((agent) => selectedSlugs.includes(agent.slug))
      : [];
    const selectedMissing = selectedSlugs.filter((slug) => !manifest.agents.some((agent) => agent.slug === slug));
    for (const missing of selectedMissing) {
      errors.push(`Selected agent slug not found in manifest: ${missing}`);
    }

    if (include.agents && selectedAgents.length === 0) {
      warnings.push("No agents selected for import.");
    }

    const availableSkillKeys = new Set(source.manifest.skills.map((skill) => skill.key));
    const availableSkillSlugs = new Map<string, OrganizationPortabilitySkillManifestEntry[]>();
    for (const skill of source.manifest.skills) {
      const existing = availableSkillSlugs.get(skill.slug) ?? [];
      existing.push(skill);
      availableSkillSlugs.set(skill.slug, existing);
    }

    for (const agent of selectedAgents) {
      const filePath = ensureMarkdownPath(agent.path);
      const markdown = readPortableTextFile(source.files, filePath);
      if (typeof markdown !== "string") {
        errors.push(`Missing markdown file for agent ${agent.slug}: ${filePath}`);
        continue;
      }
      const parsed = parseFrontmatterMarkdown(markdown);
      if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "agent") {
        warnings.push(`Agent markdown ${filePath} does not declare kind: agent in frontmatter.`);
      }
      for (const skillRef of agent.skills) {
        const slugMatches = availableSkillSlugs.get(skillRef) ?? [];
        if (!availableSkillKeys.has(skillRef) && slugMatches.length !== 1) {
          warnings.push(`Agent ${agent.slug} references skill ${skillRef}, but that skill is not present in the package.`);
        }
      }
    }

    if (include.projects) {
      for (const project of manifest.projects) {
        const markdown = readPortableTextFile(source.files, ensureMarkdownPath(project.path));
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for project ${project.slug}: ${project.path}`);
          continue;
        }
        const parsed = parseFrontmatterMarkdown(markdown);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "project") {
          warnings.push(`Project markdown ${project.path} does not declare kind: project in frontmatter.`);
        }
      }
    }

    if (include.issues) {
      const projectBySlug = new Map(manifest.projects.map((project) => [project.slug, project]));
      for (const issue of manifest.issues) {
        const markdown = readPortableTextFile(source.files, ensureMarkdownPath(issue.path));
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for task ${issue.slug}: ${issue.path}`);
          continue;
        }
        const parsed = parseFrontmatterMarkdown(markdown);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "task") {
          warnings.push(`Task markdown ${issue.path} does not declare kind: task in frontmatter.`);
        }
        if (issue.projectWorkspaceKey) {
          const project = issue.projectSlug ? projectBySlug.get(issue.projectSlug) ?? null : null;
          if (!project) {
            warnings.push(`Task ${issue.slug} references workspace key ${issue.projectWorkspaceKey}, but its project is not present in the package.`);
          } else if (!project.workspaces.some((workspace) => workspace.key === issue.projectWorkspaceKey)) {
            warnings.push(`Task ${issue.slug} references missing project workspace key ${issue.projectWorkspaceKey}.`);
          }
        }
        if (issue.recurring) {
          if (!issue.projectSlug) {
            errors.push(`Recurring task ${issue.slug} must declare a project to import as an automation.`);
          }
          if (!issue.assigneeAgentSlug) {
            errors.push(`Recurring task ${issue.slug} must declare an assignee to import as an automation.`);
          }
          const resolvedAutomation = resolvePortableAutomationDefinition(issue, parsed.frontmatter.schedule);
          warnings.push(...resolvedAutomation.warnings);
          errors.push(...resolvedAutomation.errors);
        }
      }
    }

    for (const envInput of manifest.envInputs) {
      if (envInput.portability === "system_dependent") {
        warnings.push(`Environment input ${envInput.key}${envInput.agentSlug ? ` for ${envInput.agentSlug}` : ""} is system-dependent and may need manual adjustment after import.`);
      }
    }

    let targetOrganizationId: string | null = null;
    let targetOrganizationName: string | null = null;

    if (input.target.mode === "existing_organization") {
      const targetOrganization = await organizations.getById(input.target.orgId);
      if (!targetOrganization) throw notFound("Target organization not found");
      targetOrganizationId = targetOrganization.id;
      targetOrganizationName = targetOrganization.name;
    }

    const agentPlans: OrganizationPortabilityPreviewAgentPlan[] = [];
    const existingSlugToAgent = new Map<string, { id: string; name: string }>();
    const existingSlugs = new Set<string>();
    const projectPlans: OrganizationPortabilityPreviewResult["plan"]["projectPlans"] = [];
    const issuePlans: OrganizationPortabilityPreviewResult["plan"]["issuePlans"] = [];
    const existingProjectSlugToProject = new Map<string, { id: string; name: string }>();
    const existingProjectSlugs = new Set<string>();

    if (input.target.mode === "existing_organization") {
      const existingAgents = await agents.list(input.target.orgId);
      for (const existing of existingAgents) {
        const slug = normalizeAgentUrlKey(existing.name) ?? existing.id;
        if (!existingSlugToAgent.has(slug)) existingSlugToAgent.set(slug, existing);
        existingSlugs.add(slug);
      }
      const existingProjects = await projects.list(input.target.orgId);
      for (const existing of existingProjects) {
        if (!existingProjectSlugToProject.has(existing.urlKey)) {
          existingProjectSlugToProject.set(existing.urlKey, { id: existing.id, name: existing.name });
        }
        existingProjectSlugs.add(existing.urlKey);
      }

      const existingSkills = await organizationSkills.listFull(input.target.orgId);
      const existingSkillKeys = new Set(existingSkills.map((skill) => skill.key));
      const existingSkillSlugs = new Set(existingSkills.map((skill) => normalizeSkillSlug(skill.slug) ?? skill.slug));
      for (const skill of manifest.skills) {
        const skillSlug = normalizeSkillSlug(skill.slug) ?? skill.slug;
        if (existingSkillKeys.has(skill.key) || existingSkillSlugs.has(skillSlug)) {
          if (mode === "agent_safe") {
            warnings.push(`Existing skill "${skill.slug}" matched during safe import and will ${collisionStrategy === "skip" ? "be skipped" : "be renamed"} instead of overwritten.`);
          } else if (collisionStrategy === "replace") {
            warnings.push(`Existing skill "${skill.slug}" (${skill.key}) will be overwritten by import.`);
          }
        }
      }
    }

    for (const manifestAgent of selectedAgents) {
      const existing = existingSlugToAgent.get(manifestAgent.slug) ?? null;
      if (!existing) {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "create",
          plannedName: manifestAgent.name,
          existingAgentId: null,
          reason: null,
        });
        continue;
      }

      if (mode === "board_full" && collisionStrategy === "replace") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "update",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; replace strategy.",
        });
        continue;
      }

      if (collisionStrategy === "skip") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "skip",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; skip strategy.",
        });
        continue;
      }

      const renamed = uniqueNameBySlug(manifestAgent.name, existingSlugs);
      existingSlugs.add(normalizeAgentUrlKey(renamed) ?? manifestAgent.slug);
      agentPlans.push({
        slug: manifestAgent.slug,
        action: "create",
        plannedName: renamed,
        existingAgentId: existing.id,
        reason: "Existing slug matched; rename strategy.",
      });
    }

    if (include.projects) {
      for (const manifestProject of manifest.projects) {
        const existing = existingProjectSlugToProject.get(manifestProject.slug) ?? null;
        if (!existing) {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "create",
            plannedName: manifestProject.name,
            existingProjectId: null,
            reason: null,
          });
          continue;
        }
        if (mode === "board_full" && collisionStrategy === "replace") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "update",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; replace strategy.",
          });
          continue;
        }
        if (collisionStrategy === "skip") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "skip",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; skip strategy.",
          });
          continue;
        }
        const renamed = uniqueProjectName(manifestProject.name, existingProjectSlugs);
        existingProjectSlugs.add(deriveProjectUrlKey(renamed, renamed));
        projectPlans.push({
          slug: manifestProject.slug,
          action: "create",
          plannedName: renamed,
          existingProjectId: existing.id,
          reason: "Existing slug matched; rename strategy.",
        });
      }
    }

    // Apply user-specified name overrides (keyed by slug)
    if (input.nameOverrides) {
      for (const ap of agentPlans) {
        const override = input.nameOverrides[ap.slug];
        if (override) {
          ap.plannedName = override;
        }
      }
      for (const pp of projectPlans) {
        const override = input.nameOverrides[pp.slug];
        if (override) {
          pp.plannedName = override;
        }
      }
      for (const ip of issuePlans) {
        const override = input.nameOverrides[ip.slug];
        if (override) {
          ip.plannedTitle = override;
        }
      }
    }

    // Warn about agents that will be overwritten/updated
    for (const ap of agentPlans) {
      if (ap.action === "update") {
        warnings.push(`Existing agent "${ap.plannedName}" (${ap.slug}) will be overwritten by import.`);
      }
    }

    // Warn about projects that will be overwritten/updated
    for (const pp of projectPlans) {
      if (pp.action === "update") {
        warnings.push(`Existing project "${pp.plannedName}" (${pp.slug}) will be overwritten by import.`);
      }
    }

    if (include.issues) {
      for (const manifestIssue of manifest.issues) {
        issuePlans.push({
          slug: manifestIssue.slug,
          action: "create",
          plannedTitle: manifestIssue.title,
          reason: manifestIssue.recurring ? "Recurring task will be imported as an automation." : null,
        });
      }
    }

    const preview: OrganizationPortabilityPreviewResult = {
      include,
      targetOrganizationId,
      targetOrganizationName,
      collisionStrategy,
      selectedAgentSlugs: selectedAgents.map((agent) => agent.slug),
      plan: {
        organizationAction: input.target.mode === "new_organization"
          ? "create"
          : include.organization && mode === "board_full"
            ? "update"
            : "none",
        agentPlans,
        projectPlans,
        issuePlans,
      },
      manifest,
      files: source.files,
      envInputs: manifest.envInputs ?? [],
      warnings,
      errors,
    };

    return {
      preview,
      source,
      include,
      collisionStrategy,
      selectedAgents,
    };
  }

  async function previewImport(
    input: OrganizationPortabilityPreview,
    options?: ImportBehaviorOptions,
  ): Promise<OrganizationPortabilityPreviewResult> {
    const plan = await buildPreview(input, options);
    return plan.preview;
  }

  return { buildPreview, previewImport };
}
