import type {
  OrganizationPortabilityEnvInput,
  OrganizationPortabilityFileEntry,
  OrganizationPortabilityManifest,
  OrganizationPortabilityProjectWorkspaceManifestEntry,
  OrganizationSkill
} from "@rudderhq/shared";
import {
  deriveProjectUrlKey,
  getBundledRudderSkillSlug,
  normalizeAgentUrlKey,
  toBundledRudderSkillKey
} from "@rudderhq/shared";
import path from "node:path";
import { unprocessable } from "../../errors.js";

import {
  PORTABLE_AGENT_ENTRY_FILE,
  asBoolean,
  asString,
  deriveManifestSkillKey,
  execFileAsync,
  isBundledRudderSourceKind,
  isPlainRecord,
  normalizeAutomationExtension,
  normalizePortableProjectWorkspaceExtension,
  normalizeSkillKey,
  readSkillSourceKind,
  stripEmptyValues,
  type CompanyPackageIncludeEntry,
  type EnvInputRecord,
  type MarkdownDoc,
  type ResolvedSource
} from "./organization-portability.core.js";
import {
  buildMarkdown,
  findPaperclipExtensionPath,
  normalizeFileMap,
  normalizePortablePath,
  normalizePortableSidebarOrder,
  readPortableTextFile,
  renderYamlBlock,
  resolvePortablePath
} from "./organization-portability.files.js";

let bundledSkillsCommitPromise: Promise<string | null> | null = null;
export async function resolveBundledSkillsCommit() {
  if (!bundledSkillsCommitPromise) {
    bundledSkillsCommitPromise = execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() => null);
  }
  return bundledSkillsCommitPromise;
}

export async function buildSkillSourceEntry(skill: OrganizationSkill) {
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  if (isBundledRudderSourceKind(asString(metadata?.sourceKind))) {
    const commit = await resolveBundledSkillsCommit();
    return {
      kind: "github-dir",
      repo: "rudder/rudder",
      path: `.agents/skills/${skill.slug}`,
      commit,
      trackingRef: "master",
      url: `https://github.com/Undertone0809/rudder/tree/master/.agents/skills/${skill.slug}`,
    };
  }

  if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
    const owner = asString(metadata?.owner);
    const repo = asString(metadata?.repo);
    const repoSkillDir = asString(metadata?.repoSkillDir);
    if (!owner || !repo || !repoSkillDir) return null;
    return {
      kind: "github-dir",
      repo: `${owner}/${repo}`,
      path: repoSkillDir,
      commit: skill.sourceRef ?? null,
      trackingRef: asString(metadata?.trackingRef),
      url: skill.sourceLocator,
    };
  }

  if (skill.sourceType === "url" && skill.sourceLocator) {
    return {
      kind: "url",
      url: skill.sourceLocator,
    };
  }

  return null;
}

export function shouldReferenceSkillOnExport(skill: OrganizationSkill, expandReferencedSkills: boolean) {
  if (expandReferencedSkills) return false;
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  if (isBundledRudderSourceKind(asString(metadata?.sourceKind))) return true;
  return skill.sourceType === "github" || skill.sourceType === "skills_sh" || skill.sourceType === "url";
}

export async function buildReferencedSkillMarkdown(skill: OrganizationSkill) {
  const sourceEntry = await buildSkillSourceEntry(skill);
  const sourceKind = readSkillSourceKind(skill);
  const canonicalKey = isBundledRudderSourceKind(sourceKind)
    ? toBundledRudderSkillKey(getBundledRudderSkillSlug(skill.key) ?? skill.slug) ?? skill.key
    : skill.key;
  const frontmatter: Record<string, unknown> = {
    key: canonicalKey,
    slug: skill.slug,
    name: skill.name,
    description: skill.description ?? null,
  };
  if (sourceEntry) {
    frontmatter.metadata = {
      sources: [sourceEntry],
    };
  }
  return buildMarkdown(frontmatter, "");
}

export async function withSkillSourceMetadata(skill: OrganizationSkill, markdown: string) {
  const sourceEntry = await buildSkillSourceEntry(skill);
  const parsed = parseFrontmatterMarkdown(markdown);
  const metadata = isPlainRecord(parsed.frontmatter.metadata)
    ? { ...parsed.frontmatter.metadata }
    : {};
  const existingSources = Array.isArray(metadata.sources)
    ? metadata.sources.filter((entry) => isPlainRecord(entry))
    : [];
  if (sourceEntry) {
    metadata.sources = [...existingSources, sourceEntry];
  }
  metadata.skillKey = skill.key;
  metadata.rudderSkillKey = skill.key;
  metadata.rudder = {
    ...(isPlainRecord(metadata.rudder) ? metadata.rudder : {}),
    skillKey: skill.key,
    slug: skill.slug,
  };
  const frontmatter = {
    ...parsed.frontmatter,
    key: skill.key,
    slug: skill.slug,
    metadata,
  };
  return buildMarkdown(frontmatter, parsed.body);
}


export function parseYamlScalar(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    trimmed.startsWith("\"") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function prepareYamlLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => ({
      indent: line.match(/^ */)?.[0].length ?? 0,
      content: line.trim(),
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));
}

export function parseYamlBlock(
  lines: Array<{ indent: number; content: string }>,
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && lines[index]!.content.length === 0) {
    index += 1;
  }
  if (index >= lines.length || lines[index]!.indent < indentLevel) {
    return { value: {}, nextIndex: index };
  }

  const isArray = lines[index]!.indent === indentLevel && lines[index]!.content.startsWith("-");
  if (isArray) {
    const values: unknown[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.indent < indentLevel) break;
      if (line.indent !== indentLevel || !line.content.startsWith("-")) break;
      const remainder = line.content.slice(1).trim();
      index += 1;
      if (!remainder) {
        const nested = parseYamlBlock(lines, index, indentLevel + 2);
        values.push(nested.value);
        index = nested.nextIndex;
        continue;
      }
      const inlineObjectSeparator = remainder.indexOf(":");
      if (
        inlineObjectSeparator > 0 &&
        !remainder.startsWith("\"") &&
        !remainder.startsWith("{") &&
        !remainder.startsWith("[")
      ) {
        const key = remainder.slice(0, inlineObjectSeparator).trim();
        const rawValue = remainder.slice(inlineObjectSeparator + 1).trim();
        const nextObject: Record<string, unknown> = {
          [key]: parseYamlScalar(rawValue),
        };
        if (index < lines.length && lines[index]!.indent > indentLevel) {
          const nested = parseYamlBlock(lines, index, indentLevel + 2);
          if (isPlainRecord(nested.value)) {
            Object.assign(nextObject, nested.value);
          }
          index = nested.nextIndex;
        }
        values.push(nextObject);
        continue;
      }
      values.push(parseYamlScalar(remainder));
    }
    return { value: values, nextIndex: index };
  }

  const record: Record<string, unknown> = {};
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indentLevel) break;
    if (line.indent !== indentLevel) {
      index += 1;
      continue;
    }
    const separatorIndex = line.content.indexOf(":");
    if (separatorIndex <= 0) {
      index += 1;
      continue;
    }
    const key = line.content.slice(0, separatorIndex).trim();
    const remainder = line.content.slice(separatorIndex + 1).trim();
    index += 1;
    if (!remainder) {
      const nested = parseYamlBlock(lines, index, indentLevel + 2);
      record[key] = nested.value;
      index = nested.nextIndex;
      continue;
    }
    record[key] = parseYamlScalar(remainder);
  }

  return { value: record, nextIndex: index };
}

export function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const prepared = prepareYamlLines(raw);
  if (prepared.length === 0) return {};
  const parsed = parseYamlBlock(prepared, 0, prepared[0]!.indent);
  return isPlainRecord(parsed.value) ? parsed.value : {};
}

export function parseYamlFile(raw: string): Record<string, unknown> {
  return parseYamlFrontmatter(raw);
}

export function buildYamlFile(value: Record<string, unknown>, opts?: { preserveEmptyStrings?: boolean }) {
  const cleaned = stripEmptyValues(value, opts);
  if (!isPlainRecord(cleaned)) return "{}\n";
  return renderYamlBlock(cleaned, 0).join("\n") + "\n";
}

export function parseFrontmatterMarkdown(raw: string): MarkdownDoc {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.replace(/\n$/, "") };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.replace(/\n$/, "") };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).replace(/^\n/, "").replace(/\n$/, "");
  return {
    frontmatter: parseYamlFrontmatter(frontmatterRaw),
    body,
  };
}

export async function fetchText(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

export async function fetchOptionalText(url: string) {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

export async function fetchBinary(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function dedupeEnvInputs(values: OrganizationPortabilityManifest["envInputs"]) {
  const seen = new Set<string>();
  const out: OrganizationPortabilityManifest["envInputs"] = [];
  for (const value of values) {
    const key = `${value.agentSlug ?? ""}:${value.key.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function buildEnvInputMap(inputs: OrganizationPortabilityEnvInput[]) {
  const env: Record<string, Record<string, unknown>> = {};
  for (const input of inputs) {
    const entry: Record<string, unknown> = {
      kind: input.kind,
      requirement: input.requirement,
    };
    if (input.defaultValue !== null) entry.default = input.defaultValue;
    if (input.description) entry.description = input.description;
    if (input.portability === "system_dependent") entry.portability = "system_dependent";
    env[input.key] = entry;
  }
  return env;
}

export function readCompanyApprovalDefault(_frontmatter: Record<string, unknown>) {
  return true;
}

export function readIncludeEntries(frontmatter: Record<string, unknown>): CompanyPackageIncludeEntry[] {
  const includes = frontmatter.includes;
  if (!Array.isArray(includes)) return [];
  return includes.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ path: entry }];
    }
    if (isPlainRecord(entry)) {
      const pathValue = asString(entry.path);
      return pathValue ? [{ path: pathValue }] : [];
    }
    return [];
  });
}

export function readAgentEnvInputs(
  extension: Record<string, unknown>,
  agentSlug: string,
): OrganizationPortabilityManifest["envInputs"] {
  const inputs = isPlainRecord(extension.inputs) ? extension.inputs : null;
  const env = inputs && isPlainRecord(inputs.env) ? inputs.env : null;
  if (!env) return [];

  return Object.entries(env).flatMap(([key, value]) => {
    if (!isPlainRecord(value)) return [];
    const record = value as EnvInputRecord;
    return [{
      key,
      description: asString(record.description) ?? null,
      agentSlug,
      kind: record.kind === "plain" ? "plain" : "secret",
      requirement: record.requirement === "required" ? "required" : "optional",
      defaultValue: typeof record.default === "string" ? record.default : null,
      portability: record.portability === "system_dependent" ? "system_dependent" : "portable",
    }];
  });
}

export function readAgentSkillRefs(frontmatter: Record<string, unknown>) {
  const skills = frontmatter.skills;
  if (!Array.isArray(skills)) return [];
  return Array.from(new Set(
    skills
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizeSkillKey(entry) ?? entry.trim())
      .filter(Boolean),
  ));
}

export function isPortableAgentEntryPath(relativePath: string) {
  return path.posix.basename(normalizePortablePath(relativePath)) === PORTABLE_AGENT_ENTRY_FILE;
}

export function ensurePortableAgentEntryFile(
  exportedFiles: Record<string, string>,
  exportedEntryFile: string,
  fallbackBody: string,
) {
  const files = { ...exportedFiles };
  const normalizedEntryFile = normalizePortablePath(exportedEntryFile);
  if (isPortableAgentEntryPath(normalizedEntryFile) && typeof files[normalizedEntryFile] === "string") {
    return { files, entryFile: normalizedEntryFile };
  }

  const existingPortableEntry = Object.keys(files)
    .map((entry) => normalizePortablePath(entry))
    .find((entry) => isPortableAgentEntryPath(entry));
  if (existingPortableEntry) {
    return { files, entryFile: existingPortableEntry };
  }

  files[PORTABLE_AGENT_ENTRY_FILE] = fallbackBody || "_No AGENTS instructions were resolved from current agent config._";
  return { files, entryFile: PORTABLE_AGENT_ENTRY_FILE };
}

export function buildManifestFromPackageFiles(
  files: Record<string, OrganizationPortabilityFileEntry>,
  opts?: { sourceLabel?: { orgId: string; organizationName: string } | null },
): ResolvedSource {
  const normalizedFiles = normalizeFileMap(files);
  const companyPath = typeof normalizedFiles["ORGANIZATION.md"] === "string"
    ? normalizedFiles["ORGANIZATION.md"]
    : undefined;
  const resolvedCompanyPath = companyPath !== undefined
    ? "ORGANIZATION.md"
    : Object.keys(normalizedFiles).find((entry) => entry.endsWith("/ORGANIZATION.md") || entry === "ORGANIZATION.md");
  if (!resolvedCompanyPath) {
    throw unprocessable("Organization package is missing ORGANIZATION.md");
  }

  const companyMarkdown = readPortableTextFile(normalizedFiles, resolvedCompanyPath);
  if (typeof companyMarkdown !== "string") {
    throw unprocessable(`Organization package file is not readable as text: ${resolvedCompanyPath}`);
  }
  const companyDoc = parseFrontmatterMarkdown(companyMarkdown);
  const companyFrontmatter = companyDoc.frontmatter;
  const rudderExtensionPath = findPaperclipExtensionPath(normalizedFiles);
  const rudderExtension = rudderExtensionPath
    ? parseYamlFile(readPortableTextFile(normalizedFiles, rudderExtensionPath) ?? "")
    : {};
  const rudderCompany = isPlainRecord(rudderExtension.organization) ? rudderExtension.organization : {};
  const rudderSidebar = normalizePortableSidebarOrder(rudderExtension.sidebar);
  const rudderAgents = isPlainRecord(rudderExtension.agents) ? rudderExtension.agents : {};
  const rudderProjects = isPlainRecord(rudderExtension.projects) ? rudderExtension.projects : {};
  const rudderTasks = isPlainRecord(rudderExtension.tasks) ? rudderExtension.tasks : {};
  const rudderAutomations = isPlainRecord(rudderExtension.automations) ? rudderExtension.automations : {};
  const organizationName =
    asString(companyFrontmatter.name)
    ?? opts?.sourceLabel?.organizationName
    ?? "Imported Organization";
  const companySlug =
    asString(companyFrontmatter.slug)
    ?? normalizeAgentUrlKey(organizationName)
    ?? "organization";

  const includeEntries = readIncludeEntries(companyFrontmatter);
  const referencedAgentPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/AGENTS.md") || entry === "AGENTS.md");
  const referencedProjectPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/PROJECT.md") || entry === "PROJECT.md");
  const referencedTaskPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/TASK.md") || entry === "TASK.md");
  const referencedSkillPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/SKILL.md") || entry === "SKILL.md");
  const discoveredAgentPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/AGENTS.md") || entry === "AGENTS.md",
  );
  const discoveredProjectPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/PROJECT.md") || entry === "PROJECT.md",
  );
  const discoveredTaskPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/TASK.md") || entry === "TASK.md",
  );
  const discoveredSkillPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/SKILL.md") || entry === "SKILL.md",
  );
  const agentPaths = Array.from(new Set([...referencedAgentPaths, ...discoveredAgentPaths])).sort();
  const projectPaths = Array.from(new Set([...referencedProjectPaths, ...discoveredProjectPaths])).sort();
  const taskPaths = Array.from(new Set([...referencedTaskPaths, ...discoveredTaskPaths])).sort();
  const skillPaths = Array.from(new Set([...referencedSkillPaths, ...discoveredSkillPaths])).sort();

  const manifest: OrganizationPortabilityManifest = {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    source: opts?.sourceLabel ?? null,
    includes: {
      organization: true,
      agents: true,
      projects: projectPaths.length > 0,
      issues: taskPaths.length > 0,
      skills: skillPaths.length > 0,
    },
    organization: {
      path: resolvedCompanyPath,
      name: organizationName,
      description: asString(companyFrontmatter.description),
      brandColor: asString(rudderCompany.brandColor),
      logoPath: asString(rudderCompany.logoPath) ?? asString(rudderCompany.logo),
      requireBoardApprovalForNewAgents:
        typeof rudderCompany.requireBoardApprovalForNewAgents === "boolean"
          ? rudderCompany.requireBoardApprovalForNewAgents
          : readCompanyApprovalDefault(companyFrontmatter),
    },
    sidebar: rudderSidebar,
    agents: [],
    skills: [],
    projects: [],
    issues: [],
    envInputs: [],
  };

  const warnings: string[] = [];
  if (manifest.organization?.logoPath && !normalizedFiles[manifest.organization.logoPath]) {
    warnings.push(`Referenced organization logo file is missing from package: ${manifest.organization.logoPath}`);
  }
  for (const agentPath of agentPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, agentPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced agent file is missing from package: ${agentPath}`);
      continue;
    }
    const agentDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = agentDoc.frontmatter;
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(path.posix.dirname(agentPath))) ?? "agent";
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(rudderAgents[slug]) ? rudderAgents[slug] : {};
    const extensionAdapter = isPlainRecord(extension.adapter) ? extension.adapter : null;
    const extensionRuntime = isPlainRecord(extension.runtime) ? extension.runtime : null;
    const extensionPermissions = isPlainRecord(extension.permissions) ? extension.permissions : null;
    const extensionMetadata = isPlainRecord(extension.metadata) ? extension.metadata : null;
    const agentRuntimeConfig = isPlainRecord(extensionAdapter?.config)
      ? extensionAdapter.config
      : {};
    const runtimeConfig = extensionRuntime ?? {};
    const title = asString(frontmatter.title);

    manifest.agents.push({
      slug,
      name: asString(frontmatter.name) ?? title ?? slug,
      path: agentPath,
      skills: readAgentSkillRefs(frontmatter),
      role: asString(extension.role) ?? "agent",
      title,
      icon: asString(extension.icon),
      capabilities: asString(extension.capabilities),
      reportsToSlug: asString(frontmatter.reportsTo) ?? asString(extension.reportsTo),
      agentRuntimeType: asString(extensionAdapter?.type) ?? "process",
      agentRuntimeConfig,
      runtimeConfig,
      permissions: extensionPermissions ?? {},
      budgetMonthlyCents:
        typeof extension.budgetMonthlyCents === "number" && Number.isFinite(extension.budgetMonthlyCents)
          ? Math.max(0, Math.floor(extension.budgetMonthlyCents))
          : 0,
      metadata: extensionMetadata,
    });

    manifest.envInputs.push(...readAgentEnvInputs(extension, slug));

    if (frontmatter.kind && frontmatter.kind !== "agent") {
      warnings.push(`Agent markdown ${agentPath} does not declare kind: agent in frontmatter.`);
    }
  }

  for (const skillPath of skillPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, skillPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced skill file is missing from package: ${skillPath}`);
      continue;
    }
    const skillDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = skillDoc.frontmatter;
    const skillDir = path.posix.dirname(skillPath);
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(skillDir)) ?? "skill";
    const slug = asString(frontmatter.slug) ?? normalizeAgentUrlKey(asString(frontmatter.name) ?? "") ?? fallbackSlug;
    const inventory = Object.keys(normalizedFiles)
      .filter((entry) => entry === skillPath || entry.startsWith(`${skillDir}/`))
      .map((entry) => ({
        path: entry === skillPath ? "SKILL.md" : entry.slice(skillDir.length + 1),
        kind: entry === skillPath
          ? "skill"
          : entry.startsWith(`${skillDir}/references/`)
            ? "reference"
            : entry.startsWith(`${skillDir}/scripts/`)
              ? "script"
              : entry.startsWith(`${skillDir}/assets/`)
                ? "asset"
                : entry.endsWith(".md")
                  ? "markdown"
                  : "other",
      }));
    const metadata = isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : null;
    const sources = metadata && Array.isArray(metadata.sources) ? metadata.sources : [];
    const primarySource = sources.find((entry) => isPlainRecord(entry)) as Record<string, unknown> | undefined;
    const sourceKind = asString(primarySource?.kind);
    let sourceType = "catalog";
    let sourceLocator: string | null = null;
    let sourceRef: string | null = null;
    let normalizedMetadata: Record<string, unknown> | null = null;

    if (sourceKind === "github-dir" || sourceKind === "github-file") {
      const repo = asString(primarySource?.repo);
      const repoPath = asString(primarySource?.path);
      const commit = asString(primarySource?.commit);
      const trackingRef = asString(primarySource?.trackingRef);
      const [owner, repoName] = (repo ?? "").split("/");
      sourceType = "github";
      sourceLocator = asString(primarySource?.url)
        ?? (repo ? `https://github.com/${repo}${repoPath ? `/tree/${trackingRef ?? commit ?? "main"}/${repoPath}` : ""}` : null);
      sourceRef = commit;
      normalizedMetadata = owner && repoName
        ? {
            sourceKind: "github",
            owner,
            repo: repoName,
            ref: commit,
            trackingRef,
            repoSkillDir: repoPath ?? `skills/${slug}`,
          }
        : null;
    } else if (sourceKind === "url") {
      sourceType = "url";
      sourceLocator = asString(primarySource?.url) ?? asString(primarySource?.rawUrl);
      normalizedMetadata = {
        sourceKind: "url",
      };
    } else if (metadata) {
      normalizedMetadata = {
        sourceKind: "catalog",
      };
    }
    const key = deriveManifestSkillKey(frontmatter, slug, normalizedMetadata, sourceType, sourceLocator);

    manifest.skills.push({
      key,
      slug,
      name: asString(frontmatter.name) ?? slug,
      path: skillPath,
      description: asString(frontmatter.description),
      sourceType,
      sourceLocator,
      sourceRef,
      trustLevel: null,
      compatibility: "compatible",
      metadata: normalizedMetadata,
      fileInventory: inventory,
    });
  }

  for (const projectPath of projectPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, projectPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced project file is missing from package: ${projectPath}`);
      continue;
    }
    const projectDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = projectDoc.frontmatter;
    const fallbackSlug = deriveProjectUrlKey(
      asString(frontmatter.name) ?? path.posix.basename(path.posix.dirname(projectPath)) ?? "project",
      projectPath,
    );
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(rudderProjects[slug]) ? rudderProjects[slug] : {};
    const workspaceExtensions = isPlainRecord(extension.workspaces) ? extension.workspaces : {};
    const workspaces = Object.entries(workspaceExtensions)
      .map(([workspaceKey, entry]) => normalizePortableProjectWorkspaceExtension(workspaceKey, entry))
      .filter((entry): entry is OrganizationPortabilityProjectWorkspaceManifestEntry => entry !== null);
    manifest.projects.push({
      slug,
      name: asString(frontmatter.name) ?? slug,
      path: projectPath,
      description: asString(frontmatter.description),
      ownerAgentSlug: asString(frontmatter.owner),
      leadAgentSlug: asString(extension.leadAgentSlug),
      targetDate: asString(extension.targetDate),
      color: asString(extension.color),
      icon: asString(extension.icon),
      status: asString(extension.status),
      executionWorkspacePolicy: isPlainRecord(extension.executionWorkspacePolicy)
        ? extension.executionWorkspacePolicy
        : null,
      workspaces,
      metadata: isPlainRecord(extension.metadata) ? extension.metadata : null,
    });
    if (frontmatter.kind && frontmatter.kind !== "project") {
      warnings.push(`Project markdown ${projectPath} does not declare kind: project in frontmatter.`);
    }
  }

  for (const taskPath of taskPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, taskPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced task file is missing from package: ${taskPath}`);
      continue;
    }
    const taskDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = taskDoc.frontmatter;
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(path.posix.dirname(taskPath))) ?? "task";
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(rudderTasks[slug]) ? rudderTasks[slug] : {};
    const automationExtension = normalizeAutomationExtension(rudderAutomations[slug]);
    const automationExtensionRaw = isPlainRecord(rudderAutomations[slug]) ? rudderAutomations[slug] : {};
    const schedule = isPlainRecord(frontmatter.schedule) ? frontmatter.schedule : null;
    const legacyRecurrence = schedule && isPlainRecord(schedule.recurrence)
      ? schedule.recurrence
      : isPlainRecord(extension.recurrence)
        ? extension.recurrence
        : null;
    const recurring =
      asBoolean(frontmatter.recurring) === true
      || automationExtension !== null
      || legacyRecurrence !== null;
    manifest.issues.push({
      slug,
      identifier: asString(extension.identifier),
      title: asString(frontmatter.name) ?? asString(frontmatter.title) ?? slug,
      path: taskPath,
      projectSlug: asString(frontmatter.project),
      projectWorkspaceKey: asString(extension.projectWorkspaceKey),
      assigneeAgentSlug: asString(frontmatter.assignee),
      parentIssueSlug: asString(frontmatter.parent) ?? asString(extension.parentIssueSlug) ?? null,
      description: taskDoc.body || asString(frontmatter.description),
      recurring,
      automation: automationExtension,
      legacyRecurrence,
      status: asString(extension.status) ?? asString(automationExtensionRaw.status),
      priority: asString(extension.priority) ?? asString(automationExtensionRaw.priority),
      labelIds: Array.isArray(extension.labelIds)
        ? extension.labelIds.filter((entry): entry is string => typeof entry === "string")
        : [],
      billingCode: asString(extension.billingCode),
      executionWorkspaceSettings: isPlainRecord(extension.executionWorkspaceSettings)
        ? extension.executionWorkspaceSettings
        : null,
      assigneeAgentRuntimeOverrides: isPlainRecord(extension.assigneeAgentRuntimeOverrides)
        ? extension.assigneeAgentRuntimeOverrides
        : null,
      metadata: isPlainRecord(extension.metadata) ? extension.metadata : null,
    });
    if (frontmatter.kind && frontmatter.kind !== "task") {
      warnings.push(`Task markdown ${taskPath} does not declare kind: task in frontmatter.`);
    }
  }

  manifest.envInputs = dedupeEnvInputs(manifest.envInputs);
  return {
    manifest,
    files: normalizedFiles,
    warnings,
  };
}


export function normalizeGitHubSourcePath(value: string | null | undefined) {
  if (!value) return "";
  return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function parseGitHubSourceUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.hostname !== "github.com") {
    throw unprocessable("GitHub source must use github.com URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw unprocessable("Invalid GitHub URL");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  const queryRef = url.searchParams.get("ref")?.trim();
  const queryPath = normalizeGitHubSourcePath(url.searchParams.get("path"));
  const queryCompanyPath = normalizeGitHubSourcePath(url.searchParams.get("companyPath"))?.replace(
    /(^|\/)COMPANY\.md$/i,
    "$1ORGANIZATION.md",
  );
  if (queryRef || queryPath || queryCompanyPath) {
    const companyPath = queryCompanyPath || [queryPath, "ORGANIZATION.md"].filter(Boolean).join("/") || "ORGANIZATION.md";
    let basePath = queryPath;
    if (!basePath && companyPath !== "ORGANIZATION.md") {
      basePath = path.posix.dirname(companyPath);
      if (basePath === ".") basePath = "";
    }
    return {
      owner,
      repo,
      ref: queryRef || "main",
      basePath,
      companyPath,
    };
  }
  let ref = "main";
  let basePath = "";
  let companyPath = "ORGANIZATION.md";
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
  } else if (parts[2] === "blob") {
    ref = parts[3] ?? "main";
    const blobPath = parts.slice(4).join("/");
    if (!blobPath) {
      throw unprocessable("Invalid GitHub blob URL");
    }
    companyPath = blobPath.replace(/(^|\/)COMPANY\.md$/i, "$1ORGANIZATION.md");
    basePath = path.posix.dirname(blobPath);
    if (basePath === ".") basePath = "";
  }
  return { owner, repo, ref, basePath, companyPath };
}

export function resolveRawGitHubUrl(owner: string, repo: string, ref: string, filePath: string) {
  const normalizedFilePath = filePath.replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${normalizedFilePath}`;
}
