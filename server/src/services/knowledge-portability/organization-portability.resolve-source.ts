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
  buildManifestFromPackageFiles,
  fetchBinary,
  fetchJson,
  fetchOptionalText,
  fetchText,
  parseFrontmatterMarkdown,
  parseGitHubSourceUrl,
  readIncludeEntries,
  resolveRawGitHubUrl,
} from "./organization-portability.package.js";
import type { ResolvedSource } from "./organization-portability.core.js";
import {
  bufferToPortableBinaryFile,
  inferContentTypeFromPath,
  normalizeFileMap,
  normalizePortablePath,
} from "./organization-portability.files.js";

export async function resolveSource(source: OrganizationPortabilityPreview["source"]): Promise<ResolvedSource> {
  if (source.type === "inline") {
    return buildManifestFromPackageFiles(
      normalizeFileMap(source.files, source.rootPath),
    );
  }

  const parsed = parseGitHubSourceUrl(source.url);
  let ref = parsed.ref;
  const warnings: string[] = [];
  const companyRelativePath = parsed.companyPath === "ORGANIZATION.md"
    ? [parsed.basePath, "ORGANIZATION.md"].filter(Boolean).join("/")
    : parsed.companyPath;
  let companyMarkdown: string | null = null;
  try {
    companyMarkdown = await fetchOptionalText(
      resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, companyRelativePath),
    );
  } catch (err) {
    if (ref === "main") {
      ref = "master";
      warnings.push("GitHub ref main not found; falling back to master.");
      companyMarkdown = await fetchOptionalText(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, companyRelativePath),
      );
    } else {
      throw err;
    }
  }
  if (!companyMarkdown) {
    throw unprocessable("GitHub organization package is missing ORGANIZATION.md");
  }

  const companyPath = parsed.companyPath === "ORGANIZATION.md"
    ? "ORGANIZATION.md"
    : normalizePortablePath(path.posix.relative(parsed.basePath || ".", parsed.companyPath));
  const files: Record<string, OrganizationPortabilityFileEntry> = {
    [companyPath]: companyMarkdown,
  };
  const tree = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
  ).catch(() => ({ tree: [] }));
  const basePrefix = parsed.basePath ? `${parsed.basePath.replace(/^\/+|\/+$/g, "")}/` : "";
  const candidatePaths = (tree.tree ?? [])
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => {
      if (basePrefix && !entry.startsWith(basePrefix)) return false;
      const relative = basePrefix ? entry.slice(basePrefix.length) : entry;
      return (
        relative.endsWith(".md") ||
        relative.startsWith(".agents/skills/") ||
        relative.startsWith("skills/") ||
        relative === ".rudder.yaml" ||
        relative === ".rudder.yml"
      );
    });
  for (const repoPath of candidatePaths) {
    const relativePath = basePrefix ? repoPath.slice(basePrefix.length) : repoPath;
    if (files[relativePath] !== undefined) continue;
    files[normalizePortablePath(relativePath)] = await fetchText(
      resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, repoPath),
    );
  }
  const companyDoc = parseFrontmatterMarkdown(companyMarkdown);
  const includeEntries = readIncludeEntries(companyDoc.frontmatter);
  for (const includeEntry of includeEntries) {
    const repoPath = [parsed.basePath, includeEntry.path].filter(Boolean).join("/");
    const relativePath = normalizePortablePath(includeEntry.path);
    if (files[relativePath] !== undefined) continue;
    if (!(repoPath.endsWith(".md") || repoPath.endsWith(".yaml") || repoPath.endsWith(".yml"))) continue;
    files[relativePath] = await fetchText(
      resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, repoPath),
    );
  }

  const resolved = buildManifestFromPackageFiles(files);
  const companyLogoPath = resolved.manifest.organization?.logoPath;
  if (companyLogoPath && !resolved.files[companyLogoPath]) {
    const repoPath = [parsed.basePath, companyLogoPath].filter(Boolean).join("/");
    try {
      const binary = await fetchBinary(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, repoPath),
      );
      resolved.files[companyLogoPath] = bufferToPortableBinaryFile(binary, inferContentTypeFromPath(companyLogoPath));
    } catch (err) {
      warnings.push(`Failed to fetch organization logo ${companyLogoPath} from GitHub: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  resolved.warnings.unshift(...warnings);
  return resolved;
}
