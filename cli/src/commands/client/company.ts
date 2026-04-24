import { Command } from "commander";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type {
  Organization,
  OrganizationPortabilityFileEntry,
  OrganizationPortabilityExportResult,
  OrganizationPortabilityInclude,
  OrganizationPortabilityPreviewResult,
  OrganizationPortabilityImportResult,
} from "@rudderhq/shared";
import { ApiRequestError } from "../../client/http.js";
import { openUrl } from "../../client/board-auth.js";
import { binaryContentTypeByExtension, readZipArchive } from "./zip.js";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyCommandOptions extends BaseClientOptions {}
type CompanyDeleteSelectorMode = "auto" | "id" | "prefix";
type CompanyImportTargetMode = "new" | "existing";
type CompanyCollisionMode = "rename" | "skip" | "replace";

interface CompanyDeleteOptions extends BaseClientOptions {
  by?: CompanyDeleteSelectorMode;
  yes?: boolean;
  confirm?: string;
}

interface CompanyExportOptions extends BaseClientOptions {
  out?: string;
  include?: string;
  skills?: string;
  projects?: string;
  issues?: string;
  projectIssues?: string;
  expandReferencedSkills?: boolean;
}

interface CompanyImportOptions extends BaseClientOptions {
  include?: string;
  target?: CompanyImportTargetMode;
  orgId?: string;
  newOrganizationName?: string;
  agents?: string;
  collision?: CompanyCollisionMode;
  ref?: string;
  rudderUrl?: string;
  yes?: boolean;
  dryRun?: boolean;
}

const DEFAULT_EXPORT_INCLUDE: OrganizationPortabilityInclude = {
  organization: true,
  agents: true,
  projects: false,
  issues: false,
  skills: false,
};

const DEFAULT_IMPORT_INCLUDE: OrganizationPortabilityInclude = {
  organization: true,
  agents: true,
  projects: true,
  issues: true,
  skills: true,
};

const IMPORT_INCLUDE_OPTIONS: Array<{
  value: keyof OrganizationPortabilityInclude;
  label: string;
  hint: string;
}> = [
  { value: "organization", label: "Organization", hint: "name, branding, and organization settings" },
  { value: "projects", label: "Projects", hint: "projects and workspace metadata" },
  { value: "issues", label: "Tasks", hint: "tasks and recurring automations" },
  { value: "agents", label: "Agents", hint: "agent records and organization structure" },
  { value: "skills", label: "Skills", hint: "organization skill packages and references" },
];

const IMPORT_PREVIEW_SAMPLE_LIMIT = 6;

type ImportSelectableGroup = "projects" | "issues" | "agents" | "skills";

type ImportSelectionCatalog = {
  organization: {
    includedByDefault: boolean;
    files: string[];
  };
  projects: Array<{ key: string; label: string; hint?: string; files: string[] }>;
  issues: Array<{ key: string; label: string; hint?: string; files: string[] }>;
  agents: Array<{ key: string; label: string; hint?: string; files: string[] }>;
  skills: Array<{ key: string; label: string; hint?: string; files: string[] }>;
  extensionPath: string | null;
};

type ImportSelectionState = {
  organization: boolean;
  projects: Set<string>;
  issues: Set<string>;
  agents: Set<string>;
  skills: Set<string>;
};

function readPortableFileEntry(filePath: string, contents: Buffer): OrganizationPortabilityFileEntry {
  const contentType = binaryContentTypeByExtension[path.extname(filePath).toLowerCase()];
  if (!contentType) return contents.toString("utf8");
  return {
    encoding: "base64",
    data: contents.toString("base64"),
    contentType,
  };
}

function portableFileEntryToWriteValue(entry: OrganizationPortabilityFileEntry): string | Uint8Array {
  if (typeof entry === "string") return entry;
  return Buffer.from(entry.data, "base64");
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeSelector(input: string): string {
  return input.trim();
}

function parseInclude(
  input: string | undefined,
  fallback: OrganizationPortabilityInclude = DEFAULT_EXPORT_INCLUDE,
): OrganizationPortabilityInclude {
  if (!input || !input.trim()) return { ...fallback };
  const values = input.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const include = {
    organization: values.includes("organization") || values.includes("company"),
    agents: values.includes("agents"),
    projects: values.includes("projects"),
    issues: values.includes("issues") || values.includes("tasks"),
    skills: values.includes("skills"),
  };
  if (!include.organization && !include.agents && !include.projects && !include.issues && !include.skills) {
    throw new Error("Invalid --include value. Use one or more of: organization,agents,projects,issues,tasks,skills");
  }
  return include;
}

function parseAgents(input: string | undefined): "all" | string[] {
  if (!input || !input.trim()) return "all";
  const normalized = input.trim().toLowerCase();
  if (normalized === "all") return "all";
  const values = input.split(",").map((part) => part.trim()).filter(Boolean);
  if (values.length === 0) return "all";
  return Array.from(new Set(values));
}

function parseCsvValues(input: string | undefined): string[] {
  if (!input || !input.trim()) return [];
  return Array.from(new Set(input.split(",").map((part) => part.trim()).filter(Boolean)));
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function resolveImportInclude(input: string | undefined): OrganizationPortabilityInclude {
  return parseInclude(input, DEFAULT_IMPORT_INCLUDE);
}

function normalizePortablePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function shouldIncludePortableFile(filePath: string): boolean {
  const baseName = path.basename(filePath);
  const isMarkdown = baseName.endsWith(".md");
  const isPaperclipYaml = baseName === ".rudder.yaml" || baseName === ".rudder.yml";
  const contentType = binaryContentTypeByExtension[path.extname(baseName).toLowerCase()];
  return isMarkdown || isPaperclipYaml || Boolean(contentType);
}

function findPortableExtensionPath(files: Record<string, OrganizationPortabilityFileEntry>): string | null {
  if (files[".rudder.yaml"] !== undefined) return ".rudder.yaml";
  if (files[".rudder.yml"] !== undefined) return ".rudder.yml";
  return Object.keys(files).find((entry) => entry.endsWith("/.rudder.yaml") || entry.endsWith("/.rudder.yml")) ?? null;
}

function collectFilesUnderDirectory(
  files: Record<string, OrganizationPortabilityFileEntry>,
  directory: string,
  opts?: { excludePrefixes?: string[] },
): string[] {
  const normalizedDirectory = normalizePortablePath(directory).replace(/\/+$/, "");
  if (!normalizedDirectory) return [];
  const prefix = `${normalizedDirectory}/`;
  const excluded = (opts?.excludePrefixes ?? []).map((entry) => normalizePortablePath(entry).replace(/\/+$/, "")).filter(Boolean);
  return Object.keys(files)
    .map(normalizePortablePath)
    .filter((filePath) => filePath.startsWith(prefix))
    .filter((filePath) => !excluded.some((excludePrefix) => filePath.startsWith(`${excludePrefix}/`)))
    .sort((left, right) => left.localeCompare(right));
}

function collectEntityFiles(
  files: Record<string, OrganizationPortabilityFileEntry>,
  entryPath: string,
  opts?: { excludePrefixes?: string[] },
): string[] {
  const normalizedPath = normalizePortablePath(entryPath);
  const directory = normalizedPath.includes("/") ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) : "";
  const selected = new Set<string>([normalizedPath]);
  if (directory) {
    for (const filePath of collectFilesUnderDirectory(files, directory, opts)) {
      selected.add(filePath);
    }
  }
  return Array.from(selected).sort((left, right) => left.localeCompare(right));
}

export function buildImportSelectionCatalog(preview: OrganizationPortabilityPreviewResult): ImportSelectionCatalog {
  const selectedAgentSlugs = new Set(preview.selectedAgentSlugs);
  const organizationFiles = new Set<string>();
  const organizationPath = preview.manifest.organization?.path
    ? normalizePortablePath(preview.manifest.organization.path)
    : null;
  if (organizationPath) {
    organizationFiles.add(organizationPath);
  }
  const readmePath = Object.keys(preview.files).find((entry) => normalizePortablePath(entry) === "README.md");
  if (readmePath) {
    organizationFiles.add(normalizePortablePath(readmePath));
  }
  const logoPath = preview.manifest.organization?.logoPath
    ? normalizePortablePath(preview.manifest.organization.logoPath)
    : null;
  if (logoPath && preview.files[logoPath] !== undefined) {
    organizationFiles.add(logoPath);
  }

  return {
    organization: {
      includedByDefault: preview.include.organization && preview.manifest.organization !== null,
      files: Array.from(organizationFiles).sort((left, right) => left.localeCompare(right)),
    },
    projects: preview.manifest.projects.map((project) => {
      const projectPath = normalizePortablePath(project.path);
      const projectDir = projectPath.includes("/") ? projectPath.slice(0, projectPath.lastIndexOf("/")) : "";
      return {
        key: project.slug,
        label: project.name,
        hint: project.slug,
        files: collectEntityFiles(preview.files, projectPath, {
          excludePrefixes: projectDir ? [`${projectDir}/issues`] : [],
        }),
      };
    }),
    issues: preview.manifest.issues.map((issue) => ({
      key: issue.slug,
      label: issue.title,
      hint: issue.identifier ?? issue.slug,
      files: collectEntityFiles(preview.files, normalizePortablePath(issue.path)),
    })),
    agents: preview.manifest.agents
      .filter((agent) => selectedAgentSlugs.size === 0 || selectedAgentSlugs.has(agent.slug))
      .map((agent) => ({
        key: agent.slug,
        label: agent.name,
        hint: agent.slug,
        files: collectEntityFiles(preview.files, normalizePortablePath(agent.path)),
      })),
    skills: preview.manifest.skills.map((skill) => ({
      key: skill.slug,
      label: skill.name,
      hint: skill.slug,
      files: collectEntityFiles(preview.files, normalizePortablePath(skill.path)),
    })),
    extensionPath: findPortableExtensionPath(preview.files),
  };
}

function toKeySet(items: Array<{ key: string }>): Set<string> {
  return new Set(items.map((item) => item.key));
}

export function buildDefaultImportSelectionState(catalog: ImportSelectionCatalog): ImportSelectionState {
  return {
    organization: catalog.organization.includedByDefault,
    projects: toKeySet(catalog.projects),
    issues: toKeySet(catalog.issues),
    agents: toKeySet(catalog.agents),
    skills: toKeySet(catalog.skills),
  };
}

function countSelected(state: ImportSelectionState, group: ImportSelectableGroup): number {
  return state[group].size;
}

function countTotal(catalog: ImportSelectionCatalog, group: ImportSelectableGroup): number {
  return catalog[group].length;
}

function summarizeGroupSelection(catalog: ImportSelectionCatalog, state: ImportSelectionState, group: ImportSelectableGroup): string {
  return `${countSelected(state, group)}/${countTotal(catalog, group)} selected`;
}

function getGroupLabel(group: ImportSelectableGroup): string {
  switch (group) {
    case "projects":
      return "Projects";
    case "issues":
      return "Tasks";
    case "agents":
      return "Agents";
    case "skills":
      return "Skills";
  }
}

export function buildSelectedFilesFromImportSelection(
  catalog: ImportSelectionCatalog,
  state: ImportSelectionState,
): string[] {
  const selected = new Set<string>();

  if (state.organization) {
    for (const filePath of catalog.organization.files) {
      selected.add(normalizePortablePath(filePath));
    }
  }

  for (const group of ["projects", "issues", "agents", "skills"] as const) {
    const selectedKeys = state[group];
    for (const item of catalog[group]) {
      if (!selectedKeys.has(item.key)) continue;
      for (const filePath of item.files) {
        selected.add(normalizePortablePath(filePath));
      }
    }
  }

  if (selected.size > 0 && catalog.extensionPath) {
    selected.add(normalizePortablePath(catalog.extensionPath));
  }

  return Array.from(selected).sort((left, right) => left.localeCompare(right));
}

export function buildDefaultImportAdapterOverrides(
  preview: Pick<OrganizationPortabilityPreviewResult, "manifest" | "selectedAgentSlugs">,
): Record<string, { agentRuntimeType: string }> | undefined {
  const selectedAgentSlugs = new Set(preview.selectedAgentSlugs);
  const overrides = Object.fromEntries(
    preview.manifest.agents
      .filter((agent) => selectedAgentSlugs.size === 0 || selectedAgentSlugs.has(agent.slug))
      .filter((agent) => agent.agentRuntimeType === "process")
      .map((agent) => [
        agent.slug,
        {
          // TODO: replace this temporary claude_local fallback with adapter selection in the import TUI.
          agentRuntimeType: "claude_local",
        },
      ]),
  );
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function buildDefaultImportAdapterMessages(
  overrides: Record<string, { agentRuntimeType: string }> | undefined,
): string[] {
  if (!overrides) return [];
  const agentRuntimeTypes = Array.from(new Set(Object.values(overrides).map((override) => override.agentRuntimeType)))
    .map((agentRuntimeType) => agentRuntimeType.replace(/_/g, "-"));
  const agentCount = Object.keys(overrides).length;
  return [
    `Using ${agentRuntimeTypes.join(", ")} adapter${agentRuntimeTypes.length === 1 ? "" : "s"} for ${agentCount} imported ${pluralize(agentCount, "agent")} without an explicit adapter.`,
  ];
}

async function promptForImportSelection(preview: OrganizationPortabilityPreviewResult): Promise<string[]> {
  const catalog = buildImportSelectionCatalog(preview);
  const state = buildDefaultImportSelectionState(catalog);

  while (true) {
    const choice = await p.select<ImportSelectableGroup | "organization" | "confirm">({
      message: "Select what Rudder should import",
      options: [
        {
          value: "organization",
          label: state.organization ? "Organization: included" : "Organization: skipped",
          hint: catalog.organization.files.length > 0
            ? "toggle organization metadata"
            : "no organization metadata in package",
        },
        {
          value: "projects",
          label: "Select Projects",
          hint: summarizeGroupSelection(catalog, state, "projects"),
        },
        {
          value: "issues",
          label: "Select Tasks",
          hint: summarizeGroupSelection(catalog, state, "issues"),
        },
        {
          value: "agents",
          label: "Select Agents",
          hint: summarizeGroupSelection(catalog, state, "agents"),
        },
        {
          value: "skills",
          label: "Select Skills",
          hint: summarizeGroupSelection(catalog, state, "skills"),
        },
        {
          value: "confirm",
          label: "Confirm",
          hint: `${buildSelectedFilesFromImportSelection(catalog, state).length} files selected`,
        },
      ],
      initialValue: "confirm",
    });

    if (p.isCancel(choice)) {
      p.cancel("Import cancelled.");
      process.exit(0);
    }

    if (choice === "confirm") {
      const selectedFiles = buildSelectedFilesFromImportSelection(catalog, state);
      if (selectedFiles.length === 0) {
        p.note("Select at least one import target before confirming.", "Nothing selected");
        continue;
      }
      return selectedFiles;
    }

    if (choice === "organization") {
      if (catalog.organization.files.length === 0) {
        p.note("This package does not include organization metadata to toggle.", "No organization metadata");
        continue;
      }
      state.organization = !state.organization;
      continue;
    }

    const group = choice;
    const groupItems = catalog[group];
    if (groupItems.length === 0) {
      p.note(`This package does not include any ${getGroupLabel(group).toLowerCase()}.`, `No ${getGroupLabel(group)}`);
      continue;
    }

    const selection = await p.multiselect<string>({
      message: `${getGroupLabel(group)} to import. Space toggles, enter returns to the main menu.`,
      options: groupItems.map((item) => ({
        value: item.key,
        label: item.label,
        hint: item.hint,
      })),
      initialValues: Array.from(state[group]),
    });

    if (p.isCancel(selection)) {
      p.cancel("Import cancelled.");
      process.exit(0);
    }

    state[group] = new Set(selection);
  }
}

function summarizeInclude(include: OrganizationPortabilityInclude): string {
  const labels = IMPORT_INCLUDE_OPTIONS
    .filter((option) => include[option.value])
    .map((option) => option.label.toLowerCase());
  return labels.length > 0 ? labels.join(", ") : "nothing selected";
}

function formatSourceLabel(source: { type: "inline"; rootPath?: string | null } | { type: "github"; url: string }): string {
  if (source.type === "github") {
    return `GitHub: ${source.url}`;
  }
  return `Local package: ${source.rootPath?.trim() || "(current folder)"}`;
}

function formatTargetLabel(
  target: { mode: "existing_organization"; orgId?: string | null } | { mode: "new_organization"; newOrganizationName?: string | null },
  preview?: OrganizationPortabilityPreviewResult,
): string {
  if (target.mode === "existing_organization") {
    const targetName = preview?.targetOrganizationName?.trim();
    const targetId = preview?.targetOrganizationId?.trim() || target.orgId?.trim() || "unknown-organization";
    return targetName ? `${targetName} (${targetId})` : targetId;
  }
  return target.newOrganizationName?.trim() || preview?.manifest.organization?.name || "new organization";
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function summarizePlanCounts(
  plans: Array<{ action: "create" | "update" | "skip" }>,
  noun: string,
): string {
  if (plans.length === 0) return `0 ${pluralize(0, noun)} selected`;
  const createCount = plans.filter((plan) => plan.action === "create").length;
  const updateCount = plans.filter((plan) => plan.action === "update").length;
  const skipCount = plans.filter((plan) => plan.action === "skip").length;
  const parts: string[] = [];
  if (createCount > 0) parts.push(`${createCount} create`);
  if (updateCount > 0) parts.push(`${updateCount} update`);
  if (skipCount > 0) parts.push(`${skipCount} skip`);
  return `${plans.length} ${pluralize(plans.length, noun)} total (${parts.join(", ")})`;
}

function summarizeImportAgentResults(agents: OrganizationPortabilityImportResult["agents"]): string {
  if (agents.length === 0) return "0 agents changed";
  const created = agents.filter((agent) => agent.action === "created").length;
  const updated = agents.filter((agent) => agent.action === "updated").length;
  const skipped = agents.filter((agent) => agent.action === "skipped").length;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${agents.length} ${pluralize(agents.length, "agent")} total (${parts.join(", ")})`;
}

function summarizeImportProjectResults(projects: OrganizationPortabilityImportResult["projects"]): string {
  if (projects.length === 0) return "0 projects changed";
  const created = projects.filter((project) => project.action === "created").length;
  const updated = projects.filter((project) => project.action === "updated").length;
  const skipped = projects.filter((project) => project.action === "skipped").length;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${projects.length} ${pluralize(projects.length, "project")} total (${parts.join(", ")})`;
}

function actionChip(action: string): string {
  switch (action) {
    case "create":
    case "created":
      return pc.green(action);
    case "update":
    case "updated":
      return pc.yellow(action);
    case "skip":
    case "skipped":
    case "none":
    case "unchanged":
      return pc.dim(action);
    default:
      return action;
  }
}

function appendPreviewExamples(
  lines: string[],
  title: string,
  entries: Array<{ action: string; label: string; reason?: string | null }>,
): void {
  if (entries.length === 0) return;
  lines.push("");
  lines.push(pc.bold(title));
  const shown = entries.slice(0, IMPORT_PREVIEW_SAMPLE_LIMIT);
  for (const entry of shown) {
    const reason = entry.reason?.trim() ? pc.dim(` (${entry.reason.trim()})`) : "";
    lines.push(`- ${actionChip(entry.action)} ${entry.label}${reason}`);
  }
  if (entries.length > shown.length) {
    lines.push(pc.dim(`- +${entries.length - shown.length} more`));
  }
}

function appendMessageBlock(lines: string[], title: string, messages: string[]): void {
  if (messages.length === 0) return;
  lines.push("");
  lines.push(pc.bold(title));
  for (const message of messages) {
    lines.push(`- ${message}`);
  }
}

export function renderCompanyImportPreview(
  preview: OrganizationPortabilityPreviewResult,
  meta: {
    sourceLabel: string;
    targetLabel: string;
    infoMessages?: string[];
  },
): string {
  const lines: string[] = [
    `${pc.bold("Source")}  ${meta.sourceLabel}`,
    `${pc.bold("Target")}  ${meta.targetLabel}`,
    `${pc.bold("Include")} ${summarizeInclude(preview.include)}`,
    `${pc.bold("Mode")}    ${preview.collisionStrategy} collisions`,
    "",
    pc.bold("Package"),
    `- organization: ${preview.manifest.organization?.name ?? preview.manifest.source?.organizationName ?? "not included"}`,
    `- agents: ${preview.manifest.agents.length}`,
    `- projects: ${preview.manifest.projects.length}`,
    `- tasks: ${preview.manifest.issues.length}`,
    `- skills: ${preview.manifest.skills.length}`,
  ];

  if (preview.envInputs.length > 0) {
    const requiredCount = preview.envInputs.filter((item) => item.requirement === "required").length;
    lines.push(`- env inputs: ${preview.envInputs.length} (${requiredCount} required)`);
  }

  lines.push("");
  lines.push(pc.bold("Plan"));
  lines.push(
    `- organization: ${actionChip(
      preview.plan.organizationAction === "none" ? "unchanged" : preview.plan.organizationAction,
    )}`,
  );
  lines.push(`- agents: ${summarizePlanCounts(preview.plan.agentPlans, "agent")}`);
  lines.push(`- projects: ${summarizePlanCounts(preview.plan.projectPlans, "project")}`);
  lines.push(`- tasks: ${summarizePlanCounts(preview.plan.issuePlans, "task")}`);
  if (preview.include.skills) {
    lines.push(`- skills: ${preview.manifest.skills.length} ${pluralize(preview.manifest.skills.length, "skill")} packaged`);
  }

  appendPreviewExamples(
    lines,
    "Agent examples",
    preview.plan.agentPlans.map((plan) => ({
      action: plan.action,
      label: `${plan.slug} -> ${plan.plannedName}`,
      reason: plan.reason,
    })),
  );
  appendPreviewExamples(
    lines,
    "Project examples",
    preview.plan.projectPlans.map((plan) => ({
      action: plan.action,
      label: `${plan.slug} -> ${plan.plannedName}`,
      reason: plan.reason,
    })),
  );
  appendPreviewExamples(
    lines,
    "Task examples",
    preview.plan.issuePlans.map((plan) => ({
      action: plan.action,
      label: `${plan.slug} -> ${plan.plannedTitle}`,
      reason: plan.reason,
    })),
  );

  appendMessageBlock(lines, pc.cyan("Info"), meta.infoMessages ?? []);
  appendMessageBlock(lines, pc.yellow("Warnings"), preview.warnings);
  appendMessageBlock(lines, pc.red("Errors"), preview.errors);

  return lines.join("\n");
}

export function renderCompanyImportResult(
  result: OrganizationPortabilityImportResult,
  meta: { targetLabel: string; organizationUrl?: string; infoMessages?: string[] },
): string {
  const lines: string[] = [
    `${pc.bold("Target")}  ${meta.targetLabel}`,
    `${pc.bold("Organization")} ${result.organization.name} (${actionChip(result.organization.action)})`,
    `${pc.bold("Agents")}  ${summarizeImportAgentResults(result.agents)}`,
    `${pc.bold("Projects")} ${summarizeImportProjectResults(result.projects)}`,
  ];

  if (meta.organizationUrl) {
    lines.splice(1, 0, `${pc.bold("URL")}     ${meta.organizationUrl}`);
  }

  appendPreviewExamples(
    lines,
    "Agent results",
    result.agents.map((agent) => ({
      action: agent.action,
      label: `${agent.slug} -> ${agent.name}`,
      reason: agent.reason,
    })),
  );
  appendPreviewExamples(
    lines,
    "Project results",
    result.projects.map((project) => ({
      action: project.action,
      label: `${project.slug} -> ${project.name}`,
      reason: project.reason,
    })),
  );

  if (result.envInputs.length > 0) {
    lines.push("");
    lines.push(pc.bold("Env inputs"));
    lines.push(
      `- ${result.envInputs.length} ${pluralize(result.envInputs.length, "input")} may need values after import`,
    );
  }

  appendMessageBlock(lines, pc.cyan("Info"), meta.infoMessages ?? []);
  appendMessageBlock(lines, pc.yellow("Warnings"), result.warnings);

  return lines.join("\n");
}

function printCompanyImportView(title: string, body: string, opts?: { interactive?: boolean }): void {
  if (opts?.interactive) {
    p.note(body, title);
    return;
  }
  console.log(pc.bold(title));
  console.log(body);
}

export function resolveCompanyImportApiPath(input: {
  dryRun: boolean;
  targetMode: "new_organization" | "existing_organization";
  orgId?: string | null;
}): string {
  if (input.targetMode === "existing_organization") {
    const orgId = input.orgId?.trim();
    if (!orgId) {
      throw new Error("Existing-organization imports require an orgId to resolve the API route.");
    }
    return input.dryRun
      ? `/api/orgs/${orgId}/imports/preview`
      : `/api/orgs/${orgId}/imports/apply`;
  }

  return input.dryRun ? "/api/orgs/import/preview" : "/api/orgs/import";
}

export function buildCompanyDashboardUrl(apiBase: string, issuePrefix: string): string {
  const url = new URL(apiBase);
  const normalizedPrefix = issuePrefix.trim().replace(/^\/+|\/+$/g, "");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${normalizedPrefix}/dashboard`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function resolveCompanyImportApplyConfirmationMode(input: {
  yes?: boolean;
  interactive: boolean;
  json: boolean;
}): "skip" | "prompt" {
  if (input.yes) {
    return "skip";
  }
  if (input.json) {
    throw new Error(
      "Applying an organization import with --json requires --yes. Use --dry-run first to inspect the preview.",
    );
  }
  if (!input.interactive) {
    throw new Error(
      "Applying an organization import from a non-interactive terminal requires --yes. Use --dry-run first to inspect the preview.",
    );
  }
  return "prompt";
}

export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

export function isGithubUrl(input: string): boolean {
  return /^https?:\/\/github\.com\//i.test(input.trim());
}

function isGithubSegment(input: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(input);
}

export function isGithubShorthand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || isHttpUrl(trimmed)) return false;
  if (
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.includes("\\") ||
    /^[A-Za-z]:/.test(trimmed)
  ) {
    return false;
  }

  const segments = trimmed.split("/").filter(Boolean);
  return segments.length >= 2 && segments.every(isGithubSegment);
}

function normalizeGithubImportPath(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  return trimmed || null;
}

function buildGithubImportUrl(input: {
  owner: string;
  repo: string;
  ref?: string | null;
  path?: string | null;
  companyPath?: string | null;
}): string {
  const url = new URL(`https://github.com/${input.owner}/${input.repo.replace(/\.git$/i, "")}`);
  const ref = input.ref?.trim();
  if (ref) {
    url.searchParams.set("ref", ref);
  }
  const companyPath = normalizeGithubImportPath(input.companyPath);
  if (companyPath) {
    url.searchParams.set("companyPath", companyPath);
    return url.toString();
  }
  const sourcePath = normalizeGithubImportPath(input.path);
  if (sourcePath) {
    url.searchParams.set("path", sourcePath);
  }
  return url.toString();
}

export function normalizeGithubImportSource(input: string, refOverride?: string): string {
  const trimmed = input.trim();
  const ref = refOverride?.trim();

  if (isGithubShorthand(trimmed)) {
    const [owner, repo, ...repoPath] = trimmed.split("/").filter(Boolean);
    return buildGithubImportUrl({
      owner: owner!,
      repo: repo!,
      ref: ref || "main",
      path: repoPath.join("/"),
    });
  }

  if (!isGithubUrl(trimmed)) {
    throw new Error("GitHub source must be a github.com URL or owner/repo[/path] shorthand.");
  }
  if (!ref) {
    return trimmed;
  }

  const url = new URL(trimmed);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Invalid GitHub URL.");
  }

  const owner = parts[0]!;
  const repo = parts[1]!;
  const existingPath = normalizeGithubImportPath(url.searchParams.get("path"));
  const existingCompanyPath = normalizeGithubImportPath(url.searchParams.get("companyPath"));
  if (existingCompanyPath) {
    return buildGithubImportUrl({ owner, repo, ref, companyPath: existingCompanyPath });
  }
  if (existingPath) {
    return buildGithubImportUrl({ owner, repo, ref, path: existingPath });
  }
  if (parts[2] === "tree") {
    return buildGithubImportUrl({ owner, repo, ref, path: parts.slice(4).join("/") });
  }
  if (parts[2] === "blob") {
    return buildGithubImportUrl({ owner, repo, ref, companyPath: parts.slice(4).join("/") });
  }
  return buildGithubImportUrl({ owner, repo, ref });
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await stat(path.resolve(inputPath));
    return true;
  } catch {
    return false;
  }
}

async function collectPackageFiles(
  root: string,
  current: string,
  files: Record<string, OrganizationPortabilityFileEntry>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".git")) continue;
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectPackageFiles(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
    if (!shouldIncludePortableFile(relativePath)) continue;
    files[relativePath] = readPortableFileEntry(relativePath, await readFile(absolutePath));
  }
}

export async function resolveInlineSourceFromPath(inputPath: string): Promise<{
  rootPath: string;
  files: Record<string, OrganizationPortabilityFileEntry>;
}> {
  const resolved = path.resolve(inputPath);
  const resolvedStat = await stat(resolved);
  if (resolvedStat.isFile() && path.extname(resolved).toLowerCase() === ".zip") {
    const archive = await readZipArchive(await readFile(resolved));
    const filteredFiles = Object.fromEntries(
      Object.entries(archive.files).filter(([relativePath]) => shouldIncludePortableFile(relativePath)),
    );
    return {
      rootPath: archive.rootPath ?? path.basename(resolved, ".zip"),
      files: filteredFiles,
    };
  }

  const rootDir = resolvedStat.isDirectory() ? resolved : path.dirname(resolved);
  const files: Record<string, OrganizationPortabilityFileEntry> = {};
  await collectPackageFiles(rootDir, rootDir, files);
  return {
    rootPath: path.basename(rootDir),
    files,
  };
}

async function writeExportToFolder(outDir: string, exported: OrganizationPortabilityExportResult): Promise<void> {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(exported.files)) {
    const normalized = relativePath.replace(/\\/g, "/");
    const filePath = path.join(root, normalized);
    await mkdir(path.dirname(filePath), { recursive: true });
    const writeValue = portableFileEntryToWriteValue(content);
    if (typeof writeValue === "string") {
      await writeFile(filePath, writeValue, "utf8");
    } else {
      await writeFile(filePath, writeValue);
    }
  }
}

async function confirmOverwriteExportDirectory(outDir: string): Promise<void> {
  const root = path.resolve(outDir);
  const stats = await stat(root).catch(() => null);
  if (!stats) return;
  if (!stats.isDirectory()) {
    throw new Error(`Export output path ${root} exists and is not a directory.`);
  }

  const entries = await readdir(root);
  if (entries.length === 0) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Export output directory ${root} already contains files. Re-run interactively or choose an empty directory.`);
  }

  const confirmed = await p.confirm({
    message: `Overwrite existing files in ${root}?`,
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    throw new Error("Export cancelled.");
  }
}

function matchesPrefix(company: Organization, selector: string): boolean {
  return company.issuePrefix.toUpperCase() === selector.toUpperCase();
}

export function resolveCompanyForDeletion(
  organizations: Organization[],
  selectorRaw: string,
  by: CompanyDeleteSelectorMode = "auto",
): Organization {
  const selector = normalizeSelector(selectorRaw);
  if (!selector) {
    throw new Error("Organization selector is required.");
  }

  const idMatch = organizations.find((company) => company.id === selector);
  const prefixMatch = organizations.find((company) => matchesPrefix(company, selector));

  if (by === "id") {
    if (!idMatch) {
      throw new Error(`No organization found by ID '${selector}'.`);
    }
    return idMatch;
  }

  if (by === "prefix") {
    if (!prefixMatch) {
      throw new Error(`No organization found by shortname/prefix '${selector}'.`);
    }
    return prefixMatch;
  }

  if (idMatch && prefixMatch && idMatch.id !== prefixMatch.id) {
    throw new Error(
      `Selector '${selector}' is ambiguous (matches both an ID and a shortname). Re-run with --by id or --by prefix.`,
    );
  }

  if (idMatch) return idMatch;
  if (prefixMatch) return prefixMatch;

  throw new Error(
    `No organization found for selector '${selector}'. Use organization ID or issue prefix (for example PAP).`,
  );
}

export function assertDeleteConfirmation(company: Organization, opts: CompanyDeleteOptions): void {
  if (!opts.yes) {
    throw new Error("Deletion requires --yes.");
  }

  const confirm = opts.confirm?.trim();
  if (!confirm) {
    throw new Error(
      "Deletion requires --confirm <value> where value matches the company ID or issue prefix.",
    );
  }

  const confirmsById = confirm === company.id;
  const confirmsByPrefix = confirm.toUpperCase() === company.issuePrefix.toUpperCase();
  if (!confirmsById && !confirmsByPrefix) {
    throw new Error(
      `Confirmation '${confirm}' does not match target organization. Expected ID '${company.id}' or prefix '${company.issuePrefix}'.`,
    );
  }
}

function assertDeleteFlags(opts: CompanyDeleteOptions): void {
  if (!opts.yes) {
    throw new Error("Deletion requires --yes.");
  }
  if (!opts.confirm?.trim()) {
    throw new Error(
      "Deletion requires --confirm <value> where value matches the company ID or issue prefix.",
    );
  }
}

export function registerCompanyCommands(program: Command): void {
  const company = program.command("org").description("Organization operations");

  addCommonClientOptions(
    company
      .command("list")
      .description("List organizations")
      .action(async (opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<Organization[]>("/api/orgs")) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          const formatted = rows.map((row) => ({
            id: row.id,
            name: row.name,
            status: row.status,
            budgetMonthlyCents: row.budgetMonthlyCents,
            spentMonthlyCents: row.spentMonthlyCents,
            requireBoardApprovalForNewAgents: row.requireBoardApprovalForNewAgents,
          }));
          for (const row of formatted) {
            console.log(formatInlineRecord(row));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("get")
      .description("Get one organization")
      .argument("<orgId>", "Organization ID")
      .action(async (orgId: string, opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Organization>(`/api/orgs/${orgId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("export")
      .description("Export an organization into a portable markdown package")
      .argument("<orgId>", "Organization ID")
      .requiredOption("--out <path>", "Output directory")
      .option(
        "--include <values>",
        "Comma-separated include set: organization,agents,projects,issues,tasks,skills",
        "organization,agents",
      )
      .option("--skills <values>", "Comma-separated skill slugs/keys to export")
      .option("--projects <values>", "Comma-separated project shortnames/ids to export")
      .option("--issues <values>", "Comma-separated issue identifiers/ids to export")
      .option("--project-issues <values>", "Comma-separated project shortnames/ids whose issues should be exported")
      .option("--expand-referenced-skills", "Vendor skill contents instead of exporting upstream references", false)
      .action(async (orgId: string, opts: CompanyExportOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const include = parseInclude(opts.include);
          const exported = await ctx.api.post<OrganizationPortabilityExportResult>(
            `/api/orgs/${orgId}/export`,
            {
              include,
              skills: parseCsvValues(opts.skills),
              projects: parseCsvValues(opts.projects),
              issues: parseCsvValues(opts.issues),
              projectIssues: parseCsvValues(opts.projectIssues),
              expandReferencedSkills: Boolean(opts.expandReferencedSkills),
            },
          );
          if (!exported) {
            throw new Error("Export request returned no data");
          }
          await confirmOverwriteExportDirectory(opts.out!);
          await writeExportToFolder(opts.out!, exported);
          printOutput(
            {
              ok: true,
              out: path.resolve(opts.out!),
              rootPath: exported.rootPath,
              filesWritten: Object.keys(exported.files).length,
              rudderExtensionPath: exported.rudderExtensionPath,
              warningCount: exported.warnings.length,
            },
            { json: ctx.json },
          );
          if (!ctx.json && exported.warnings.length > 0) {
            for (const warning of exported.warnings) {
              console.log(`warning=${warning}`);
            }
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("import")
      .description("Import a portable markdown organization package from local path, URL, or GitHub")
      .argument("<fromPathOrUrl>", "Source path or URL")
      .option("--include <values>", "Comma-separated include set: organization,agents,projects,issues,tasks,skills")
      .option("--target <mode>", "Target mode: new | existing")
      .option("-O, --org-id <id>", "Existing target organization ID")
      .option("--new-organization-name <name>", "Name override for --target new")
      .option("--agents <list>", "Comma-separated agent slugs to import, or all", "all")
      .option("--collision <mode>", "Collision strategy: rename | skip | replace", "rename")
      .option("--ref <value>", "Git ref to use for GitHub imports (branch, tag, or commit)")
      .option("--rudder-url <url>", "Alias for --api-base on this command")
      .option("--yes", "Accept default selection and skip the pre-import confirmation prompt", false)
      .option("--dry-run", "Run preview only without applying", false)
      .action(async (fromPathOrUrl: string, opts: CompanyImportOptions) => {
        try {
          if (!opts.apiBase?.trim() && opts.rudderUrl?.trim()) {
            opts.apiBase = opts.rudderUrl.trim();
          }
          const ctx = resolveCommandContext(opts);
          const interactiveView = isInteractiveTerminal() && !ctx.json;
          const from = fromPathOrUrl.trim();
          if (!from) {
            throw new Error("Source path or URL is required.");
          }

          const include = resolveImportInclude(opts.include);
          const agents = parseAgents(opts.agents);
          const collision = (opts.collision ?? "rename").toLowerCase() as CompanyCollisionMode;
          if (!["rename", "skip", "replace"].includes(collision)) {
            throw new Error("Invalid --collision value. Use: rename, skip, replace");
          }

          const inferredTarget = opts.target ?? (opts.orgId || ctx.orgId ? "existing" : "new");
          const target = inferredTarget.toLowerCase() as CompanyImportTargetMode;
          if (!["new", "existing"].includes(target)) {
            throw new Error("Invalid --target value. Use: new | existing");
          }

          const existingTargetOrganizationId = opts.orgId?.trim() || ctx.orgId;
          const targetPayload =
            target === "existing"
              ? {
                  mode: "existing_organization" as const,
                  orgId: existingTargetOrganizationId,
                }
              : {
                  mode: "new_organization" as const,
                  newOrganizationName: opts.newOrganizationName?.trim() || null,
                };

          if (targetPayload.mode === "existing_organization" && !targetPayload.orgId) {
            throw new Error("Target existing organization requires --org-id (or context default orgId).");
          }

          let sourcePayload:
            | { type: "inline"; rootPath?: string | null; files: Record<string, OrganizationPortabilityFileEntry> }
            | { type: "github"; url: string };

          const treatAsLocalPath = !isHttpUrl(from) && await pathExists(from);
          const isGithubSource = isGithubUrl(from) || (isGithubShorthand(from) && !treatAsLocalPath);

          if (isHttpUrl(from) || isGithubSource) {
            if (!isGithubUrl(from) && !isGithubShorthand(from)) {
              throw new Error(
                "Only GitHub URLs and local paths are supported for import. " +
                "Generic HTTP URLs are not supported. Use a GitHub URL (https://github.com/...) or a local directory path.",
              );
            }
            sourcePayload = { type: "github", url: normalizeGithubImportSource(from, opts.ref) };
          } else {
            if (opts.ref?.trim()) {
              throw new Error("--ref is only supported for GitHub import sources.");
            }
            const inline = await resolveInlineSourceFromPath(from);
            sourcePayload = {
              type: "inline",
              rootPath: inline.rootPath,
              files: inline.files,
            };
          }

          const sourceLabel = formatSourceLabel(sourcePayload);
          const targetLabel = formatTargetLabel(targetPayload);
          const previewApiPath = resolveCompanyImportApiPath({
            dryRun: true,
            targetMode: targetPayload.mode,
            orgId: targetPayload.mode === "existing_organization" ? targetPayload.orgId : null,
          });

          let selectedFiles: string[] | undefined;
          if (interactiveView && !opts.yes && !opts.include?.trim()) {
            const initialPreview = await ctx.api.post<OrganizationPortabilityPreviewResult>(previewApiPath, {
              source: sourcePayload,
              include,
              target: targetPayload,
              agents,
              collisionStrategy: collision,
            });
            if (!initialPreview) {
              throw new Error("Import preview returned no data.");
            }
            selectedFiles = await promptForImportSelection(initialPreview);
          }

          const previewPayload = {
            source: sourcePayload,
            include,
            target: targetPayload,
            agents,
            collisionStrategy: collision,
            selectedFiles,
          };
          const preview = await ctx.api.post<OrganizationPortabilityPreviewResult>(previewApiPath, previewPayload);
          if (!preview) {
            throw new Error("Import preview returned no data.");
          }
          const agentRuntimeOverrides = buildDefaultImportAdapterOverrides(preview);
          const adapterMessages = buildDefaultImportAdapterMessages(agentRuntimeOverrides);

          if (opts.dryRun) {
            if (ctx.json) {
              printOutput(preview, { json: true });
            } else {
              printCompanyImportView(
                "Import Preview",
                renderCompanyImportPreview(preview, {
                  sourceLabel,
                  targetLabel: formatTargetLabel(targetPayload, preview),
                  infoMessages: adapterMessages,
                }),
                { interactive: interactiveView },
              );
            }
            return;
          }

          if (!ctx.json) {
            printCompanyImportView(
              "Import Preview",
              renderCompanyImportPreview(preview, {
                sourceLabel,
                targetLabel: formatTargetLabel(targetPayload, preview),
                infoMessages: adapterMessages,
              }),
              { interactive: interactiveView },
            );
          }

          const confirmationMode = resolveCompanyImportApplyConfirmationMode({
            yes: opts.yes,
            interactive: interactiveView,
            json: ctx.json,
          });
          if (confirmationMode === "prompt") {
            const confirmed = await p.confirm({
              message: "Apply this import? (y/N)",
              initialValue: false,
            });
            if (p.isCancel(confirmed) || !confirmed) {
              p.log.warn("Import cancelled.");
              return;
            }
          }

          const importApiPath = resolveCompanyImportApiPath({
            dryRun: false,
            targetMode: targetPayload.mode,
            orgId: targetPayload.mode === "existing_organization" ? targetPayload.orgId : null,
          });
          const imported = await ctx.api.post<OrganizationPortabilityImportResult>(importApiPath, {
            ...previewPayload,
            agentRuntimeOverrides,
          });
          if (!imported) {
            throw new Error("Import request returned no data.");
          }
          let organizationUrl: string | undefined;
          if (!ctx.json) {
            try {
              const importedOrganization = await ctx.api.get<Organization>(`/api/orgs/${imported.organization.id}`);
              const issuePrefix = importedOrganization?.issuePrefix?.trim();
              if (issuePrefix) {
                organizationUrl = buildCompanyDashboardUrl(ctx.api.apiBase, issuePrefix);
              }
            } catch {
              organizationUrl = undefined;
            }
          }
          if (ctx.json) {
            printOutput(imported, { json: true });
          } else {
            printCompanyImportView(
              "Import Result",
              renderCompanyImportResult(imported, {
                targetLabel,
                organizationUrl,
                infoMessages: adapterMessages,
              }),
              { interactive: interactiveView },
            );
            if (interactiveView && organizationUrl) {
              const openImportedOrganization = await p.confirm({
                message: "Open the imported organization in your browser?",
                initialValue: true,
              });
              if (!p.isCancel(openImportedOrganization) && openImportedOrganization) {
                if (openUrl(organizationUrl)) {
                  p.log.info(`Opened ${organizationUrl}`);
                } else {
                  p.log.warn(`Could not open your browser automatically. Open this URL manually:\n${organizationUrl}`);
                }
              }
            }
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("delete")
      .description("Delete an organization by ID or shortname/prefix (destructive)")
      .argument("<selector>", "Organization ID or issue prefix (for example PAP)")
      .option(
        "--by <mode>",
        "Selector mode: auto | id | prefix",
        "auto",
      )
      .option("--yes", "Required safety flag to confirm destructive action", false)
      .option(
        "--confirm <value>",
        "Required safety value: target organization ID or shortname/prefix",
      )
      .action(async (selector: string, opts: CompanyDeleteOptions) => {
        try {
          const by = (opts.by ?? "auto").trim().toLowerCase() as CompanyDeleteSelectorMode;
          if (!["auto", "id", "prefix"].includes(by)) {
            throw new Error(`Invalid --by mode '${opts.by}'. Expected one of: auto, id, prefix.`);
          }

          const ctx = resolveCommandContext(opts);
          const normalizedSelector = normalizeSelector(selector);
          assertDeleteFlags(opts);

          let target: Organization | null = null;
          const shouldTryIdLookup = by === "id" || (by === "auto" && isUuidLike(normalizedSelector));
          if (shouldTryIdLookup) {
            const byId = await ctx.api.get<Organization>(`/api/orgs/${normalizedSelector}`, { ignoreNotFound: true });
            if (byId) {
              target = byId;
            } else if (by === "id") {
              throw new Error(`No organization found by ID '${normalizedSelector}'.`);
            }
          }

          if (!target && ctx.orgId) {
            const scoped = await ctx.api.get<Organization>(`/api/orgs/${ctx.orgId}`, { ignoreNotFound: true });
            if (scoped) {
              try {
                target = resolveCompanyForDeletion([scoped], normalizedSelector, by);
              } catch {
                // Fallback to board-wide lookup below.
              }
            }
          }

          if (!target) {
            try {
              const organizations = (await ctx.api.get<Organization[]>("/api/orgs")) ?? [];
              target = resolveCompanyForDeletion(organizations, normalizedSelector, by);
            } catch (error) {
              if (error instanceof ApiRequestError && error.status === 403 && error.message.includes("Board access required")) {
                throw new Error(
                  "Board access is required to resolve organizations across the instance. Use an organization ID/prefix for your current organization, or run with board authentication.",
                );
              }
              throw error;
            }
          }

          if (!target) {
            throw new Error(`No organization found for selector '${normalizedSelector}'.`);
          }

          assertDeleteConfirmation(target, opts);

          await ctx.api.delete<{ ok: true }>(`/api/orgs/${target.id}`);

          printOutput(
            {
              ok: true,
              deletedOrganizationId: target.id,
              deletedOrganizationName: target.name,
              deletedOrganizationPrefix: target.issuePrefix,
            },
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
