import type {
  OrganizationPortabilityEnvInput,
  OrganizationPortabilityFileEntry,
  OrganizationPortabilityInclude,
  OrganizationPortabilitySidebarOrder
} from "@rudderhq/shared";
import path from "node:path";
import { unprocessable } from "../../errors.js";

import {
  COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS,
  DEFAULT_INCLUDE,
  asString,
  isPlainRecord,
  isSensitiveEnvKey,
  type ResolvedSource,
} from "./organization-portability.core.js";
import {
  buildManifestFromPackageFiles,
  buildYamlFile,
  parseFrontmatterMarkdown,
  parseYamlFile,
  readIncludeEntries,
} from "./organization-portability.package.js";
export function normalizeInclude(input?: Partial<OrganizationPortabilityInclude>): OrganizationPortabilityInclude {
  return {
    organization: input?.organization ?? DEFAULT_INCLUDE.organization,
    agents: input?.agents ?? DEFAULT_INCLUDE.agents,
    projects: input?.projects ?? DEFAULT_INCLUDE.projects,
    issues: input?.issues ?? DEFAULT_INCLUDE.issues,
    skills: input?.skills ?? DEFAULT_INCLUDE.skills,
  };
}

export function normalizePortablePath(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const parts: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

export function resolvePortablePath(fromPath: string, targetPath: string) {
  const baseDir = path.posix.dirname(fromPath.replace(/\\/g, "/"));
  return normalizePortablePath(path.posix.join(baseDir, targetPath.replace(/\\/g, "/")));
}

export function isPortableBinaryFile(
  value: OrganizationPortabilityFileEntry,
): value is Extract<OrganizationPortabilityFileEntry, { encoding: "base64" }> {
  return typeof value === "object" && value !== null && value.encoding === "base64" && typeof value.data === "string";
}

export function readPortableTextFile(
  files: Record<string, OrganizationPortabilityFileEntry>,
  filePath: string,
) {
  const value = files[filePath];
  return typeof value === "string" ? value : null;
}

export function inferContentTypeFromPath(filePath: string) {
  const extension = path.posix.extname(filePath).toLowerCase();
  switch (extension) {
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

export function resolveCompanyLogoExtension(contentType: string | null | undefined, originalFilename: string | null | undefined) {
  const fromContentType = contentType ? COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS[contentType.toLowerCase()] : null;
  if (fromContentType) return fromContentType;

  const extension = originalFilename ? path.extname(originalFilename).toLowerCase() : "";
  return extension || ".png";
}

export function portableBinaryFileToBuffer(entry: Extract<OrganizationPortabilityFileEntry, { encoding: "base64" }>) {
  return Buffer.from(entry.data, "base64");
}

export function portableFileToBuffer(entry: OrganizationPortabilityFileEntry, filePath: string) {
  if (typeof entry === "string") {
    return Buffer.from(entry, "utf8");
  }
  if (isPortableBinaryFile(entry)) {
    return portableBinaryFileToBuffer(entry);
  }
  throw unprocessable(`Unsupported file entry encoding for ${filePath}`);
}

export function bufferToPortableBinaryFile(buffer: Buffer, contentType: string | null): OrganizationPortabilityFileEntry {
  return {
    encoding: "base64",
    data: buffer.toString("base64"),
    contentType,
  };
}

export async function streamToBuffer(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function normalizeFileMap(
  files: Record<string, OrganizationPortabilityFileEntry>,
  rootPath?: string | null,
): Record<string, OrganizationPortabilityFileEntry> {
  const normalizedRoot = rootPath ? normalizePortablePath(rootPath) : null;
  const out: Record<string, OrganizationPortabilityFileEntry> = {};
  for (const [rawPath, content] of Object.entries(files)) {
    let nextPath = normalizePortablePath(rawPath);
    if (normalizedRoot && nextPath === normalizedRoot) {
      continue;
    }
    if (normalizedRoot && nextPath.startsWith(`${normalizedRoot}/`)) {
      nextPath = nextPath.slice(normalizedRoot.length + 1);
    }
    if (!nextPath) continue;
    out[nextPath] = content;
  }
  return out;
}

export function pickTextFiles(files: Record<string, OrganizationPortabilityFileEntry>) {
  const out: Record<string, string> = {};
  for (const [filePath, content] of Object.entries(files)) {
    if (typeof content === "string") {
      out[filePath] = content;
    }
  }
  return out;
}

export function collectSelectedExportSlugs(selectedFiles: Set<string>) {
  const agents = new Set<string>();
  const projects = new Set<string>();
  const tasks = new Set<string>();
  for (const filePath of selectedFiles) {
    const agentMatch = filePath.match(/^agents\/([^/]+)\//);
    if (agentMatch) agents.add(agentMatch[1]!);
    const projectMatch = filePath.match(/^projects\/([^/]+)\//);
    if (projectMatch) projects.add(projectMatch[1]!);
    const taskMatch = filePath.match(/^tasks\/([^/]+)\//);
    if (taskMatch) tasks.add(taskMatch[1]!);
  }
  return { agents, projects, tasks, automations: new Set(tasks) };
}

export function normalizePortableSlugList(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function normalizePortableSidebarOrder(value: unknown): OrganizationPortabilitySidebarOrder | null {
  if (!isPlainRecord(value)) return null;
  const sidebar = {
    agents: normalizePortableSlugList(value.agents),
    projects: normalizePortableSlugList(value.projects),
  };
  return sidebar.agents.length > 0 || sidebar.projects.length > 0 ? sidebar : null;
}

export function sortAgentsBySidebarOrder<T extends { id: string; name: string; reportsTo: string | null }>(agents: T[]) {
  if (agents.length === 0) return [];

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenOf = new Map<string | null, T[]>();
  for (const agent of agents) {
    const parentId = agent.reportsTo && byId.has(agent.reportsTo) ? agent.reportsTo : null;
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(agent);
    childrenOf.set(parentId, siblings);
  }

  for (const siblings of childrenOf.values()) {
    siblings.sort((left, right) => left.name.localeCompare(right.name));
  }

  const sorted: T[] = [];
  const queue = [...(childrenOf.get(null) ?? [])];
  while (queue.length > 0) {
    const agent = queue.shift();
    if (!agent) continue;
    sorted.push(agent);
    const children = childrenOf.get(agent.id);
    if (children) queue.push(...children);
  }

  return sorted;
}

export function filterPortableExtensionYaml(yaml: string, selectedFiles: Set<string>) {
  const selected = collectSelectedExportSlugs(selectedFiles);
  const parsed = parseYamlFile(yaml);
  for (const section of ["agents", "projects", "tasks", "automations"] as const) {
    const sectionValue = parsed[section];
    if (!isPlainRecord(sectionValue)) continue;
    const sectionSlugs = selected[section];
    const filteredEntries = Object.fromEntries(
      Object.entries(sectionValue).filter(([slug]) => sectionSlugs.has(slug)),
    );
    if (Object.keys(filteredEntries).length > 0) {
      parsed[section] = filteredEntries;
    } else {
      delete parsed[section];
    }
  }

  const companySection = parsed.organization;
  if (isPlainRecord(companySection)) {
    const logoPath = asString(companySection.logoPath) ?? asString(companySection.logo);
    if (logoPath && !selectedFiles.has(logoPath)) {
      delete companySection.logoPath;
      delete companySection.logo;
    }
  }

  const sidebarOrder = normalizePortableSidebarOrder(parsed.sidebar);
  if (sidebarOrder) {
    const filteredSidebar = stripEmptyValues({
      agents: sidebarOrder.agents.filter((slug) => selected.agents.has(slug)),
      projects: sidebarOrder.projects.filter((slug) => selected.projects.has(slug)),
    });
    if (isPlainRecord(filteredSidebar)) {
      parsed.sidebar = filteredSidebar;
    } else {
      delete parsed.sidebar;
    }
  } else {
    delete parsed.sidebar;
  }

  return buildYamlFile(parsed, { preserveEmptyStrings: true });
}

export function filterExportFiles(
  files: Record<string, OrganizationPortabilityFileEntry>,
  selectedFilesInput: string[] | undefined,
  rudderExtensionPath: string,
) {
  if (!selectedFilesInput || selectedFilesInput.length === 0) {
    return files;
  }

  const selectedFiles = new Set(
    selectedFilesInput
      .map((entry) => normalizePortablePath(entry))
      .filter((entry) => entry.length > 0),
  );
  const filtered: Record<string, OrganizationPortabilityFileEntry> = {};
  for (const [filePath, content] of Object.entries(files)) {
    if (!selectedFiles.has(filePath)) continue;
    filtered[filePath] = content;
  }

  const extensionEntry = filtered[rudderExtensionPath];
  if (selectedFiles.has(rudderExtensionPath) && typeof extensionEntry === "string") {
    filtered[rudderExtensionPath] = filterPortableExtensionYaml(extensionEntry, selectedFiles);
  }

  return filtered;
}

export function findPaperclipExtensionPath(files: Record<string, OrganizationPortabilityFileEntry>) {
  if (typeof files[".rudder.yaml"] === "string") return ".rudder.yaml";
  if (typeof files[".rudder.yml"] === "string") return ".rudder.yml";
  return Object.keys(files).find((entry) => entry.endsWith("/.rudder.yaml") || entry.endsWith("/.rudder.yml")) ?? null;
}

export function ensureMarkdownPath(pathValue: string) {
  const normalized = pathValue.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) {
    throw unprocessable(`Manifest file path must end in .md: ${pathValue}`);
  }
  return normalized;
}

export function normalizePortableConfig(
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(input)) {
    if (
      key === "cwd" ||
      key === "instructionsFilePath" ||
      key === "instructionsBundleMode" ||
      key === "instructionsRootPath" ||
      key === "instructionsEntryFile" ||
      key === "promptTemplate" ||
      key === "bootstrapPromptTemplate" ||
      key === "rudderSkillSync"
    ) continue;
    if (key === "env") continue;
    next[key] = entry;
  }

  return next;
}

export function isAbsoluteCommand(value: string) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

export function extractPortableEnvInputs(
  agentSlug: string,
  envValue: unknown,
  warnings: string[],
): OrganizationPortabilityEnvInput[] {
  if (!isPlainRecord(envValue)) return [];
  const env = envValue as Record<string, unknown>;
  const inputs: OrganizationPortabilityEnvInput[] = [];

  for (const [key, binding] of Object.entries(env)) {
    if (key.toUpperCase() === "PATH") {
      warnings.push(`Agent ${agentSlug} PATH override was omitted from export because it is system-dependent.`);
      continue;
    }

    if (isPlainRecord(binding) && binding.type === "secret_ref") {
      inputs.push({
        key,
        description: `Provide ${key} for agent ${agentSlug}`,
        agentSlug,
        kind: "secret",
        requirement: "optional",
        defaultValue: "",
        portability: "portable",
      });
      continue;
    }

    if (isPlainRecord(binding) && binding.type === "plain") {
      const defaultValue = asString(binding.value);
      const isSensitive = isSensitiveEnvKey(key);
      const portability = defaultValue && isAbsoluteCommand(defaultValue)
        ? "system_dependent"
        : "portable";
      if (portability === "system_dependent") {
        warnings.push(`Agent ${agentSlug} env ${key} default was exported as system-dependent.`);
      }
      inputs.push({
        key,
        description: `Optional default for ${key} on agent ${agentSlug}`,
        agentSlug,
        kind: isSensitive ? "secret" : "plain",
        requirement: "optional",
        defaultValue: isSensitive ? "" : defaultValue ?? "",
        portability,
      });
      continue;
    }

    if (typeof binding === "string") {
      const portability = isAbsoluteCommand(binding) ? "system_dependent" : "portable";
      if (portability === "system_dependent") {
        warnings.push(`Agent ${agentSlug} env ${key} default was exported as system-dependent.`);
      }
      inputs.push({
        key,
        description: `Optional default for ${key} on agent ${agentSlug}`,
        agentSlug,
        kind: isSensitiveEnvKey(key) ? "secret" : "plain",
        requirement: "optional",
        defaultValue: binding,
        portability,
      });
    }
  }

  return inputs;
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isPathDefault(pathSegments: string[], value: unknown, rules: Array<{ path: string[]; value: unknown }>) {
  return rules.some((rule) => jsonEqual(rule.path, pathSegments) && jsonEqual(rule.value, value));
}

export function pruneDefaultLikeValue(
  value: unknown,
  opts: {
    dropFalseBooleans: boolean;
    path?: string[];
    defaultRules?: Array<{ path: string[]; value: unknown }>;
  },
): unknown {
  const pathSegments = opts.path ?? [];
  if (opts.defaultRules && isPathDefault(pathSegments, value, opts.defaultRules)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => pruneDefaultLikeValue(entry, { ...opts, path: pathSegments }));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = pruneDefaultLikeValue(entry, {
        ...opts,
        path: [...pathSegments, key],
      });
      if (next === undefined) continue;
      out[key] = next;
    }
    return out;
  }
  if (value === undefined) return undefined;
  if (opts.dropFalseBooleans && value === false) return undefined;
  return value;
}

export function renderYamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

export function isEmptyObject(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

export function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

export function stripEmptyValues(value: unknown, opts?: { preserveEmptyStrings?: boolean }): unknown {
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => stripEmptyValues(entry, opts))
      .filter((entry) => entry !== undefined);
    return next.length > 0 ? next : undefined;
  }
  if (isPlainRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = stripEmptyValues(entry, opts);
      if (cleaned === undefined) continue;
      next[key] = cleaned;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }
  if (
    value === undefined ||
    value === null ||
    (!opts?.preserveEmptyStrings && value === "") ||
    isEmptyArray(value) ||
    isEmptyObject(value)
  ) {
    return undefined;
  }
  return value;
}

export const YAML_KEY_PRIORITY = [
  "name",
  "description",
  "title",
  "schema",
  "kind",
  "slug",
  "reportsTo",
  "skills",
  "owner",
  "assignee",
  "project",
  "schedule",
  "version",
  "license",
  "authors",
  "homepage",
  "tags",
  "includes",
  "requirements",
  "role",
  "icon",
  "capabilities",
  "brandColor",
  "logoPath",
  "adapter",
  "runtime",
  "permissions",
  "budgetMonthlyCents",
  "metadata",
] as const;

export const YAML_KEY_PRIORITY_INDEX = new Map<string, number>(
  YAML_KEY_PRIORITY.map((key, index) => [key, index]),
);

export function compareYamlKeys(left: string, right: string) {
  const leftPriority = YAML_KEY_PRIORITY_INDEX.get(left);
  const rightPriority = YAML_KEY_PRIORITY_INDEX.get(right);
  if (leftPriority !== undefined || rightPriority !== undefined) {
    if (leftPriority === undefined) return 1;
    if (rightPriority === undefined) return -1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  }
  return left.localeCompare(right);
}

export function orderedYamlEntries(value: Record<string, unknown>) {
  return Object.entries(value).sort(([leftKey], [rightKey]) => compareYamlKeys(leftKey, rightKey));
}

export function renderYamlBlock(value: unknown, indentLevel: number): string[] {
  const indent = "  ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines: string[] = [];
    for (const entry of value) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        Array.isArray(entry) && entry.length === 0 ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}- ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}-`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  if (isPlainRecord(value)) {
    const entries = orderedYamlEntries(value);
    if (entries.length === 0) return [`${indent}{}`];
    const lines: string[] = [];
    for (const [key, entry] of entries) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        Array.isArray(entry) && entry.length === 0 ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}${key}: ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  return [`${indent}${renderYamlScalar(value)}`];
}

export function renderFrontmatter(frontmatter: Record<string, unknown>) {
  const lines: string[] = ["---"];
  for (const [key, value] of orderedYamlEntries(frontmatter)) {
    // Skip null/undefined values — don't export empty fields
    if (value === null || value === undefined) continue;
    const scalar =
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      Array.isArray(value) && value.length === 0 ||
      isEmptyObject(value);
    if (scalar) {
      lines.push(`${key}: ${renderYamlScalar(value)}`);
      continue;
    }
    lines.push(`${key}:`);
    lines.push(...renderYamlBlock(value, 1));
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

export function buildMarkdown(frontmatter: Record<string, unknown>, body: string) {
  const cleanBody = body.replace(/\r\n/g, "\n");
  if (!cleanBody.trim()) {
    return `${renderFrontmatter(frontmatter)}\n`;
  }
  return `${renderFrontmatter(frontmatter)}${cleanBody}\n`;
}

export function normalizeSelectedFiles(selectedFiles?: string[]) {
  if (!selectedFiles) return null;
  return new Set(
    selectedFiles
      .map((entry) => normalizePortablePath(entry))
      .filter((entry) => entry.length > 0),
  );
}

export function filterCompanyMarkdownIncludes(
  companyPath: string,
  markdown: string,
  selectedFiles: Set<string>,
) {
  const parsed = parseFrontmatterMarkdown(markdown);
  const includeEntries = readIncludeEntries(parsed.frontmatter);
  const filteredIncludes = includeEntries.filter((entry) =>
    selectedFiles.has(resolvePortablePath(companyPath, entry.path)),
  );
  const nextFrontmatter: Record<string, unknown> = { ...parsed.frontmatter };
  if (filteredIncludes.length > 0) {
    nextFrontmatter.includes = filteredIncludes.map((entry) => entry.path);
  } else {
    delete nextFrontmatter.includes;
  }
  return buildMarkdown(nextFrontmatter, parsed.body);
}

export function applySelectedFilesToSource(source: ResolvedSource, selectedFiles?: string[]): ResolvedSource {
  const normalizedSelection = normalizeSelectedFiles(selectedFiles);
  if (!normalizedSelection) return source;

  const companyPath = source.manifest.organization
    ? ensureMarkdownPath(source.manifest.organization.path)
    : Object.keys(source.files).find((entry) => entry.endsWith("/ORGANIZATION.md") || entry === "ORGANIZATION.md") ?? null;
  if (!companyPath) {
    throw unprocessable("Organization package is missing ORGANIZATION.md");
  }

  const companyMarkdown = source.files[companyPath];
  if (typeof companyMarkdown !== "string") {
    throw unprocessable("Organization package is missing ORGANIZATION.md");
  }

  const effectiveFiles: Record<string, OrganizationPortabilityFileEntry> = {};
  for (const [filePath, content] of Object.entries(source.files)) {
    const normalizedPath = normalizePortablePath(filePath);
    if (!normalizedSelection.has(normalizedPath)) continue;
    effectiveFiles[normalizedPath] = content;
  }

  effectiveFiles[companyPath] = filterCompanyMarkdownIncludes(
    companyPath,
    companyMarkdown,
    normalizedSelection,
  );

  const filtered = buildManifestFromPackageFiles(effectiveFiles, {
    sourceLabel: source.manifest.source,
  });

  if (!normalizedSelection.has(companyPath)) {
    filtered.manifest.organization = null;
  }

  filtered.manifest.includes = {
    organization: filtered.manifest.organization !== null,
    agents: filtered.manifest.agents.length > 0,
    projects: filtered.manifest.projects.length > 0,
    issues: filtered.manifest.issues.length > 0,
    skills: filtered.manifest.skills.length > 0,
  };

  return filtered;
}
