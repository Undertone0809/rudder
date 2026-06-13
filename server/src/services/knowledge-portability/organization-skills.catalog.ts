import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import { agents as agentRows, organizationSkills } from "@rudderhq/db";
import { readRudderSkillSyncPreference, writeRudderSkillSyncPreference } from "@rudderhq/agent-runtime-utils/server-utils";
import type { RudderSkillEntry } from "@rudderhq/agent-runtime-utils/server-utils";
import { readSkillMetadataFromPath } from "@rudderhq/agent-runtime-utils/server-utils";
import type {
  AgentSkillEntry,
  AgentSkillSnapshot,
  AgentSkillSourceClass,
  AgentSkillState,
  AgentSkillSyncMode,
  OrganizationSkill,
  OrganizationSkillCreateRequest,
  OrganizationSkillCompatibility,
  OrganizationSkillDetail,
  OrganizationSkillFileDetail,
  OrganizationSkillFileInventoryEntry,
  OrganizationSkillImportResult,
  OrganizationSkillListItem,
  OrganizationSkillLocalScanConflict,
  OrganizationSkillLocalScanRequest,
  OrganizationSkillLocalScanResult,
  OrganizationSkillLocalScanSkipped,
  OrganizationSkillProjectScanConflict,
  OrganizationSkillProjectScanRequest,
  OrganizationSkillProjectScanResult,
  OrganizationSkillProjectScanSkipped,
  OrganizationSkillSourceBadge,
  OrganizationSkillSourceType,
  OrganizationSkillTrustLevel,
  OrganizationSkillUpdateStatus,
  OrganizationSkillUsageAgent,
} from "@rudderhq/shared";
import {
  RUDDER_BUNDLED_SKILL_SLUGS,
  getBundledRudderSkillSlug,
  isCanonicalBundledRudderSkillKey,
  normalizeAgentUrlKey,
  resolveOrganizationSkillReference,
  toBundledRudderSkillKey,
} from "@rudderhq/shared";
import {
  resolveAgentSkillsDir,
  resolveOrganizationSkillsDir,
  resolveOrganizationWorkspaceRoot,
} from "../../home-paths.js";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { agentEnabledSkillsService } from "../agent-enabled-skills.js";
import { agentService } from "../agents.js";
import { projectService } from "../projects.js";

export type OrganizationSkillRow = typeof organizationSkills.$inferSelect;

export type ImportedSkill = {
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  packageDir?: string | null;
  sourceType: OrganizationSkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: OrganizationSkillTrustLevel;
  compatibility: OrganizationSkillCompatibility;
  fileInventory: OrganizationSkillFileInventoryEntry[];
  metadata: Record<string, unknown> | null;
};

export type PackageSkillConflictStrategy = "replace" | "rename" | "skip";

export type ImportPackageSkillResult = {
  skill: OrganizationSkill;
  action: "created" | "updated" | "skipped";
  originalKey: string;
  originalSlug: string;
  requestedRefs: string[];
  reason: string | null;
};

export type ParsedSkillImportSource = {
  resolvedSource: string;
  requestedSkillSlug: string | null;
  originalSkillsShUrl: string | null;
  warnings: string[];
};

export type SkillSourceMeta = {
  skillKey?: string;
  sourceKind?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  trackingRef?: string;
  repoSkillDir?: string;
  projectId?: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceCwd?: string;
};

export type LocalSkillInventoryMode = "full" | "project_root";

export type ProjectSkillScanTarget = {
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  workspaceCwd: string;
};

export type RuntimeSkillEntryOptions = {
  materializeMissing?: boolean;
};

export type AgentWorkspaceRow = {
  id: string;
  name: string;
  workspaceKey: string | null;
};

export type AgentSkillCatalogEntry = AgentSkillEntry & {
  organizationSkillKey: string | null;
  runtimeSourcePath: string | null;
};

export type AgentSkillCatalog = {
  desiredSkills: string[];
  entries: AgentSkillCatalogEntry[];
  warnings: string[];
};

export type AgentSkillSelectionResolution = {
  desiredSkills: string[];
  warnings: string[];
};

export type EnabledSkillsAgentRef = {
  id: string | null;
  orgId: string;
  agentRuntimeConfig: unknown;
  agentRuntimeType: string;
} | null;

export type AdapterSkillHomeDefinition = {
  mode: AgentSkillSyncMode;
  label: string;
  locationLabel: string;
  resolveRoot: (config: Record<string, unknown>) => string;
};

export type CommunityPresetDefinition =
  | {
    slug: string;
    source: "repo";
  }
  | {
    slug: string;
    source: "github";
    sourceUrl: string;
  };

export const skillInventoryRefreshPromises = new Map<string, Promise<void>>();
export const CANONICAL_BUNDLED_SKILL_KEYS = new Set(RUDDER_BUNDLED_SKILL_SLUGS.map((slug) => `rudder/${slug}`));
export const COMMUNITY_PRESET_SKILLS: readonly CommunityPresetDefinition[] = [
  {
    slug: "deep-research",
    source: "repo",
  },
  {
    slug: "software-product-advisor",
    source: "repo",
  },
] as const;
export const COMMUNITY_PRESET_SKILL_SLUGS = COMMUNITY_PRESET_SKILLS.map((preset) => preset.slug);
export const BUNDLED_SELECTION_PREFIX = "bundled:";
export const ORGANIZATION_SELECTION_PREFIX = "org:";
export const AGENT_SELECTION_PREFIX = "agent:";
export const GLOBAL_SELECTION_PREFIX = "global:";
export const ADAPTER_SELECTION_PREFIX = "adapter:";
export const AGENT_SKILL_SOURCE_CLASS_ORDER: Record<AgentSkillSourceClass, number> = {
  bundled: 0,
  organization: 1,
  agent_home: 2,
  global: 3,
  adapter_home: 4,
};
export const ADAPTER_SKILL_HOME_DEFINITIONS: Record<string, AdapterSkillHomeDefinition> = {
  claude_local: {
    mode: "ephemeral",
    label: "Adapter skill",
    locationLabel: "~/.claude/skills",
    resolveRoot: (config) => path.join(resolveConfiguredHomeDir(config), ".claude", "skills"),
  },
  opencode_local: {
    mode: "ephemeral",
    label: "Adapter skill",
    locationLabel: "~/.claude/skills",
    resolveRoot: (config) => path.join(resolveConfiguredHomeDir(config), ".claude", "skills"),
  },
  codex_local: {
    mode: "persistent",
    label: "Adapter skill",
    locationLabel: "~/.codex/skills",
    resolveRoot: (config) => path.join(resolveConfiguredCodexHomeDir(config), "skills"),
  },
  cursor: {
    mode: "persistent",
    label: "Adapter skill",
    locationLabel: "~/.cursor/skills",
    resolveRoot: (config) => path.join(resolveConfiguredHomeDir(config), ".cursor", "skills"),
  },
  gemini_local: {
    mode: "persistent",
    label: "Adapter skill",
    locationLabel: "~/.gemini/skills",
    resolveRoot: (config) => path.join(resolveConfiguredHomeDir(config), ".gemini", "skills"),
  },
  pi_local: {
    mode: "persistent",
    label: "Adapter skill",
    locationLabel: "~/.pi/agent/skills",
    resolveRoot: (config) => path.join(resolveConfiguredHomeDir(config), ".pi", "agent", "skills"),
  },
};

export const PROJECT_SCAN_DIRECTORY_ROOTS = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".agents/skills",
  ".agent/skills",
  ".augment/skills",
  ".claude/skills",
  ".codebuddy/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cortex/skills",
  ".crush/skills",
  ".factory/skills",
  ".goose/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kilocode/skills",
  ".kiro/skills",
  ".kode/skills",
  ".mcpjam/skills",
  ".vibe/skills",
  ".mux/skills",
  ".openhands/skills",
  ".pi/skills",
  ".qoder/skills",
  ".qwen/skills",
  ".roo/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills",
] as const;

export const PROJECT_ROOT_SKILL_SUBDIRECTORIES = [
  "references",
  "scripts",
  "assets",
] as const;

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeSkillDescription(value: unknown): string | null {
  const description = asString(value);
  if (!description) return null;
  return /^[>|][+-]?$/.test(description) ? null : description;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveConfigEnvRecord(config: Record<string, unknown>) {
  return isPlainRecord(config.env) ? config.env : {};
}

export function resolveConfiguredHomeDir(config: Record<string, unknown>) {
  const env = resolveConfigEnvRecord(config);
  const configuredHome = asString(env.HOME);
  return configuredHome ? path.resolve(configuredHome) : os.homedir();
}

export function resolveConfiguredCodexHomeDir(config: Record<string, unknown>) {
  const env = resolveConfigEnvRecord(config);
  const configuredCodexHome = asString(env.CODEX_HOME);
  return configuredCodexHome
    ? path.resolve(configuredCodexHome)
    : path.join(resolveConfiguredHomeDir(config), ".codex");
}

export function normalizePortablePath(input: string) {
  const parts: string[] = [];
  for (const segment of input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

export async function statPath(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

export function normalizePackageFileMap(files: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [rawPath, content] of Object.entries(files)) {
    const nextPath = normalizePortablePath(rawPath);
    if (!nextPath) continue;
    out[nextPath] = content;
  }
  return out;
}

export function normalizeSkillSlug(value: string | null | undefined) {
  return value ? normalizeAgentUrlKey(value) ?? null : null;
}

export function normalizeSkillKey(value: string | null | undefined) {
  if (!value) return null;
  const segments = value
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("/") : null;
}

export function isBundledRudderSourceKind(value: string | null | undefined) {
  return value === "rudder_bundled" || value === "paperclip_bundled";
}

export function isBundledRudderSkillKey(value: string | null | undefined) {
  return isCanonicalBundledRudderSkillKey(value);
}

export function buildBundledSelectionKey(skillKey: string) {
  return `${BUNDLED_SELECTION_PREFIX}${skillKey}`;
}

export function buildOrganizationSelectionKey(skillKey: string) {
  return `${ORGANIZATION_SELECTION_PREFIX}${skillKey}`;
}

export function buildAgentSelectionKey(slug: string) {
  return `${AGENT_SELECTION_PREFIX}${slug}`;
}

export function buildGlobalSelectionKey(slug: string) {
  return `${GLOBAL_SELECTION_PREFIX}${slug}`;
}

export function buildAdapterSelectionKey(agentRuntimeType: string, slug: string) {
  return `${ADAPTER_SELECTION_PREFIX}${agentRuntimeType}:${slug}`;
}

export function parseSelectionKey(selectionKey: string): {
  sourceClass: AgentSkillSourceClass | null;
  orgKey: string | null;
  slug: string | null;
  agentRuntimeType: string | null;
} {
  const trimmed = selectionKey.trim();
  if (!trimmed) {
    return { sourceClass: null, orgKey: null, slug: null, agentRuntimeType: null };
  }
  if (trimmed.startsWith(BUNDLED_SELECTION_PREFIX)) {
    const orgKey = trimmed.slice(BUNDLED_SELECTION_PREFIX.length).trim();
    return {
      sourceClass: "bundled",
      orgKey: orgKey || null,
      slug: normalizeSkillSlug(orgKey.split("/").pop() ?? null),
      agentRuntimeType: null,
    };
  }
  if (trimmed.startsWith(ORGANIZATION_SELECTION_PREFIX)) {
    const orgKey = trimmed.slice(ORGANIZATION_SELECTION_PREFIX.length).trim();
    return {
      sourceClass: "organization",
      orgKey: orgKey || null,
      slug: normalizeSkillSlug(orgKey.split("/").pop() ?? null),
      agentRuntimeType: null,
    };
  }
  if (trimmed.startsWith(AGENT_SELECTION_PREFIX)) {
    const slug = normalizeSkillSlug(trimmed.slice(AGENT_SELECTION_PREFIX.length));
    return {
      sourceClass: "agent_home",
      orgKey: null,
      slug,
      agentRuntimeType: null,
    };
  }
  if (trimmed.startsWith(GLOBAL_SELECTION_PREFIX)) {
    const slug = normalizeSkillSlug(trimmed.slice(GLOBAL_SELECTION_PREFIX.length));
    return {
      sourceClass: "global",
      orgKey: null,
      slug,
      agentRuntimeType: null,
    };
  }
  if (trimmed.startsWith(ADAPTER_SELECTION_PREFIX)) {
    const payload = trimmed.slice(ADAPTER_SELECTION_PREFIX.length);
    const delimiter = payload.indexOf(":");
    if (delimiter <= 0) {
      return { sourceClass: "adapter_home", orgKey: null, slug: null, agentRuntimeType: null };
    }
    return {
      sourceClass: "adapter_home",
      orgKey: null,
      slug: normalizeSkillSlug(payload.slice(delimiter + 1)),
      agentRuntimeType: payload.slice(0, delimiter).trim() || null,
    };
  }
  return { sourceClass: null, orgKey: null, slug: null, agentRuntimeType: null };
}

export function normalizeSelectionRef(
  reference: string,
  skills: OrganizationSkill[],
  orgId: string,
  agentRuntimeType: string,
): string | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;

  const parsedSelection = parseSelectionKey(trimmed);
  if (parsedSelection.sourceClass === "bundled") {
    return parsedSelection.orgKey ? buildBundledSelectionKey(parsedSelection.orgKey) : null;
  }
  if (parsedSelection.sourceClass === "organization") {
    return parsedSelection.orgKey ? buildOrganizationSelectionKey(parsedSelection.orgKey) : null;
  }
  if (parsedSelection.sourceClass === "agent_home") {
    return parsedSelection.slug ? buildAgentSelectionKey(parsedSelection.slug) : null;
  }
  if (parsedSelection.sourceClass === "global") {
    return parsedSelection.slug ? buildGlobalSelectionKey(parsedSelection.slug) : null;
  }
  if (parsedSelection.sourceClass === "adapter_home") {
    if (!parsedSelection.slug || !parsedSelection.agentRuntimeType) return null;
    return buildAdapterSelectionKey(parsedSelection.agentRuntimeType, parsedSelection.slug);
  }

  const orgMatch = resolveSkillReference(skills, trimmed, orgId);
  if (orgMatch.skill) {
    if (isBundledRudderSkillKey(orgMatch.skill.key)) {
      return buildBundledSelectionKey(orgMatch.skill.key);
    }
    return buildOrganizationSelectionKey(orgMatch.skill.key);
  }

  const bundledSlug = getBundledRudderSkillSlug(trimmed);
  if (bundledSlug) {
    const bundledKey = toBundledRudderSkillKey(bundledSlug);
    return bundledKey ? buildBundledSelectionKey(bundledKey) : null;
  }

  const normalizedSlug = normalizeSkillSlug(trimmed);
  if (!normalizedSlug) return null;
  return buildAdapterSelectionKey(agentRuntimeType, normalizedSlug);
}

export async function discoverLocalSkillDirectories(root: string): Promise<string[]> {
  const discovered = new Set<string>();
  for (const candidateRoot of [root, path.join(root, "skills")]) {
    const candidateStat = await statPath(candidateRoot);
    if (!candidateStat?.isDirectory()) continue;
    const entries = await fs.readdir(candidateRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.resolve(candidateRoot, entry.name);
      if (!(await statPath(path.join(skillDir, "SKILL.md")))?.isFile()) continue;
      discovered.add(skillDir);
    }
  }
  return Array.from(discovered).sort((left, right) => left.localeCompare(right));
}

export async function readDiscoveredSkillEntries(
  orgId: string,
  root: string,
  selectionKeyForSlug: (slug: string) => string,
  options: {
    sourceClass: "agent_home" | "global" | "adapter_home";
    originLabel: string;
    locationLabel: string;
  },
): Promise<AgentSkillCatalogEntry[]> {
  const out: AgentSkillCatalogEntry[] = [];
  const seenSelectionKeys = new Set<string>();
  for (const skillDir of await discoverLocalSkillDirectories(root)) {
    const slug = normalizeSkillSlug(path.basename(skillDir));
    if (!slug) continue;
    const selectionKey = selectionKeyForSlug(slug);
    if (seenSelectionKeys.has(selectionKey)) continue;
    seenSelectionKeys.add(selectionKey);
    const metadata = await readSkillMetadataFromPath(skillDir).catch(() => ({ name: null, description: null }));
    out.push({
      key: slug,
      selectionKey,
      runtimeName: slug,
      description: metadata.description ?? null,
      desired: false,
      configurable: true,
      alwaysEnabled: false,
      managed: false,
      state: "external",
      sourceClass: options.sourceClass,
      origin: "user_installed",
      originLabel: options.originLabel,
      locationLabel: options.locationLabel,
      readOnly: false,
      sourcePath: skillDir,
      targetPath: null,
      workspaceEditPath: resolveWorkspaceEditPath(orgId, skillDir),
      detail: null,
      organizationSkillKey: null,
      runtimeSourcePath: skillDir,
    });
  }
  return out;
}

export function buildDraftSkillMarkdown(input: OrganizationSkillCreateRequest) {
  return (input.markdown?.trim().length
    ? input.markdown
    : [
      "---",
      `name: ${input.name}`,
      ...(input.description?.trim() ? [`description: ${input.description.trim()}`] : []),
      "---",
      "",
      `# ${input.name}`,
      "",
      input.description?.trim() ? input.description.trim() : "Describe what this skill does.",
      "",
    ].join("\n"));
}

export function buildAgentPrivateSkillEntry(
  orgId: string,
  slug: string,
  skillDir: string,
  description: string | null,
): AgentSkillCatalogEntry {
  return {
    key: slug,
    selectionKey: buildAgentSelectionKey(slug),
    runtimeName: slug,
    description,
    desired: false,
    configurable: true,
    alwaysEnabled: false,
    managed: false,
    state: "external",
    sourceClass: "agent_home",
    origin: "user_installed",
    originLabel: "Agent skill",
    locationLabel: "AGENT_HOME/skills",
    readOnly: false,
    sourcePath: skillDir,
    targetPath: null,
    workspaceEditPath: resolveWorkspaceEditPath(orgId, skillDir),
    detail: "Installed, not enabled. Future runs will not load it until enabled.",
    organizationSkillKey: null,
    runtimeSourcePath: skillDir,
  };
}

export function normalizeGitHubSkillDirectory(
  value: string | null | undefined,
  fallback: string,
) {
  const normalized = normalizePortablePath(value ?? "");
  if (!normalized) return normalizePortablePath(fallback);
  if (path.posix.basename(normalized).toLowerCase() === "skill.md") {
    return normalizePortablePath(path.posix.dirname(normalized));
  }
  return normalized;
}

export interface SkillWithMetadata {
  id: string;
  key: string;
  sourceLocator?: string | null;
  metadata: {
    sourceKind?: string | null;
    sourceRoot?: string | null;
  } | null;
}

export function listStaleBundledSkillIds(
  existingSkills: SkillWithMetadata[],
  currentBundledKeys: string[],
): string[] {
  const currentKeysSet = new Set(
    currentBundledKeys.map((key) => {
      const bundledKey = toBundledRudderSkillKey(getBundledRudderSkillSlug(key));
      return bundledKey ?? key;
    }),
  );
  return existingSkills
    .filter((skill) => {
      const sourceKind = skill.metadata?.sourceKind;
      if (sourceKind !== "rudder_bundled" && sourceKind !== "paperclip_bundled") {
        return false;
      }
      const canonicalKey = toBundledRudderSkillKey(getBundledRudderSkillSlug(skill.key)) ?? skill.key;
      return !currentKeysSet.has(canonicalKey);
    })
    .map((skill) => skill.id);
}

export function listStaleCommunityPresetSkillIds(
  existingSkills: SkillWithMetadata[],
  currentCommunityPresetKeys: string[],
): string[] {
  const currentKeysSet = new Set(currentCommunityPresetKeys);
  return existingSkills
    .filter((skill) => skill.metadata?.sourceKind === "community_preset")
    .filter((skill) => !currentKeysSet.has(skill.key))
    .map((skill) => skill.id);
}

function isSameOrChildPath(parentPath: string, candidatePath: string) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function listLegacyUserHomeLocalScanSkillIds(
  existingSkills: SkillWithMetadata[],
  userAgentsRoot = path.join(os.homedir(), ".agents"),
): string[] {
  const normalizedUserAgentsRoot = path.resolve(userAgentsRoot);
  return existingSkills
    .filter((skill) => {
      if (skill.metadata?.sourceKind !== "local_scan") return false;
      const sourceRoot = asString(skill.metadata.sourceRoot);
      const sourceLocator = normalizeSourceLocatorDirectory(skill.sourceLocator ?? null);
      return [sourceRoot, sourceLocator]
        .filter((value): value is string => !!value)
        .some((value) => isSameOrChildPath(normalizedUserAgentsRoot, value));
    })
    .map((skill) => skill.id);
}

export function hashSkillValue(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

export function uniqueSkillSlug(baseSlug: string, usedSlugs: Set<string>) {
  if (!usedSlugs.has(baseSlug)) return baseSlug;
  let attempt = 2;
  let candidate = `${baseSlug}-${attempt}`;
  while (usedSlugs.has(candidate)) {
    attempt += 1;
    candidate = `${baseSlug}-${attempt}`;
  }
  return candidate;
}

export function uniqueImportedSkillKey(orgId: string, baseSlug: string, usedKeys: Set<string>) {
  const initial = `organization/${orgId}/${baseSlug}`;
  if (!usedKeys.has(initial)) return initial;
  let attempt = 2;
  let candidate = `organization/${orgId}/${baseSlug}-${attempt}`;
  while (usedKeys.has(candidate)) {
    attempt += 1;
    candidate = `organization/${orgId}/${baseSlug}-${attempt}`;
  }
  return candidate;
}

export function buildSkillRuntimeName(key: string, slug: string) {
  if (getBundledRudderSkillSlug(key)) return slug;
  return `${slug}--${hashSkillValue(key)}`;
}

export function readCanonicalSkillKey(frontmatter: Record<string, unknown>, metadata: Record<string, unknown> | null) {
  const direct = normalizeSkillKey(
    asString(frontmatter.key)
    ?? asString(frontmatter.skillKey)
    ?? asString(metadata?.skillKey)
    ?? asString(metadata?.canonicalKey)
    ?? asString(metadata?.rudderSkillKey),
  );
  if (direct) return direct;
  const rudder = isPlainRecord(metadata?.rudder) ? metadata?.rudder as Record<string, unknown> : null;
  return normalizeSkillKey(
    asString(rudder?.skillKey)
    ?? asString(rudder?.key),
  );
}

export function deriveCanonicalSkillKey(
  orgId: string,
  input: Pick<ImportedSkill, "slug" | "sourceType" | "sourceLocator" | "metadata">,
) {
  const slug = normalizeSkillSlug(input.slug) ?? "skill";
  const metadata = isPlainRecord(input.metadata) ? input.metadata : null;
  const sourceKind = asString(metadata?.sourceKind);
  const explicitKey = readCanonicalSkillKey({}, metadata);
  if (explicitKey) {
    if (isBundledRudderSourceKind(sourceKind)) {
      return toBundledRudderSkillKey(getBundledRudderSkillSlug(explicitKey) ?? slug) ?? explicitKey;
    }
    return explicitKey;
  }
  if (isBundledRudderSourceKind(sourceKind)) {
    return toBundledRudderSkillKey(slug) ?? `rudder/${slug}`;
  }
  if (sourceKind === "community_preset") {
    return `organization/${orgId}/${slug}`;
  }

  const owner = normalizeSkillSlug(asString(metadata?.owner));
  const repo = normalizeSkillSlug(asString(metadata?.repo));
  if ((input.sourceType === "github" || input.sourceType === "skills_sh" || sourceKind === "github" || sourceKind === "skills_sh") && owner && repo) {
    return `${owner}/${repo}/${slug}`;
  }

  if (input.sourceType === "url" || sourceKind === "url") {
    const locator = asString(input.sourceLocator);
    if (locator) {
      try {
        const url = new URL(locator);
        const host = normalizeSkillSlug(url.host) ?? "url";
        return `url/${host}/${hashSkillValue(locator)}/${slug}`;
      } catch {
        return `url/unknown/${hashSkillValue(locator)}/${slug}`;
      }
    }
  }

  if (input.sourceType === "local_path") {
    if (sourceKind === "managed_local") {
      return `organization/${orgId}/${slug}`;
    }
    const locator = asString(input.sourceLocator);
    if (locator) {
      return `local/${hashSkillValue(path.resolve(locator))}/${slug}`;
    }
  }

  return `organization/${orgId}/${slug}`;
}

export function classifyInventoryKind(relativePath: string): OrganizationSkillFileInventoryEntry["kind"] {
  const normalized = normalizePortablePath(relativePath).toLowerCase();
  if (normalized.endsWith("/skill.md") || normalized === "skill.md") return "skill";
  if (normalized.startsWith("references/")) return "reference";
  if (normalized.startsWith("scripts/")) return "script";
  if (normalized.startsWith("assets/")) return "asset";
  if (normalized.endsWith(".md")) return "markdown";
  const fileName = path.posix.basename(normalized);
  if (
    fileName.endsWith(".sh")
    || fileName.endsWith(".js")
    || fileName.endsWith(".mjs")
    || fileName.endsWith(".cjs")
    || fileName.endsWith(".ts")
    || fileName.endsWith(".py")
    || fileName.endsWith(".rb")
    || fileName.endsWith(".bash")
  ) {
    return "script";
  }
  if (
    fileName.endsWith(".png")
    || fileName.endsWith(".jpg")
    || fileName.endsWith(".jpeg")
    || fileName.endsWith(".gif")
    || fileName.endsWith(".svg")
    || fileName.endsWith(".webp")
    || fileName.endsWith(".pdf")
  ) {
    return "asset";
  }
  return "other";
}

export function deriveTrustLevel(fileInventory: OrganizationSkillFileInventoryEntry[]): OrganizationSkillTrustLevel {
  if (fileInventory.some((entry) => entry.kind === "script")) return "scripts_executables";
  if (fileInventory.some((entry) => entry.kind === "asset" || entry.kind === "other")) return "assets";
  return "markdown_only";
}

export function toCompanySkill(row: OrganizationSkillRow): OrganizationSkill {
  return {
    ...row,
    description: row.description ?? null,
    sourceType: row.sourceType as OrganizationSkillSourceType,
    sourceLocator: row.sourceLocator ?? null,
    sourceRef: row.sourceRef ?? null,
    trustLevel: row.trustLevel as OrganizationSkillTrustLevel,
    compatibility: row.compatibility as OrganizationSkillCompatibility,
    fileInventory: Array.isArray(row.fileInventory)
      ? row.fileInventory.flatMap((entry) => {
        if (!isPlainRecord(entry)) return [];
        return [{
          path: String(entry.path ?? ""),
          kind: (String(entry.kind ?? "other") as OrganizationSkillFileInventoryEntry["kind"]),
        }];
      })
      : [],
    metadata: isPlainRecord(row.metadata) ? row.metadata : null,
  };
}

export function serializeFileInventory(
  fileInventory: OrganizationSkillFileInventoryEntry[],
): Array<Record<string, unknown>> {
  return fileInventory.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
  }));
}

export function getSkillMeta(skill: OrganizationSkill): SkillSourceMeta {
  return isPlainRecord(skill.metadata) ? skill.metadata as SkillSourceMeta : {};
}

export function resolveSkillReference(
  skills: OrganizationSkill[],
  reference: string,
  orgId: string,
): { skill: OrganizationSkill | null; ambiguous: boolean } {
  const trimmed = reference.trim();
  if (!trimmed) {
    return { skill: null, ambiguous: false };
  }

  const byId = skills.find((skill) => skill.id === trimmed);
  if (byId) {
    return { skill: byId, ambiguous: false };
  }

  return resolveOrganizationSkillReference(skills, trimmed, { orgId });
}

export function resolveRequestedSkillKeysOrThrow(
  skills: OrganizationSkill[],
  requestedReferences: string[],
  orgId: string,
) {
  const missing = new Set<string>();
  const ambiguous = new Set<string>();
  const resolved = new Set<string>();

  for (const reference of requestedReferences) {
    const trimmed = reference.trim();
    if (!trimmed) continue;

    const match = resolveSkillReference(skills, trimmed, orgId);
    if (match.skill) {
      resolved.add(match.skill.key);
      continue;
    }

    if (match.ambiguous) {
      ambiguous.add(trimmed);
      continue;
    }

    missing.add(trimmed);
  }

  if (ambiguous.size > 0 || missing.size > 0) {
    const problems: string[] = [];
    if (ambiguous.size > 0) {
      problems.push(`ambiguous references: ${Array.from(ambiguous).sort().join(", ")}`);
    }
    if (missing.size > 0) {
      problems.push(`unknown references: ${Array.from(missing).sort().join(", ")}`);
    }
    throw unprocessable(`Invalid organization skill selection (${problems.join("; ")}).`);
  }

  return Array.from(resolved);
}

export function resolveDesiredSkillKeys(
  skills: OrganizationSkill[],
  config: Record<string, unknown>,
  orgId: string,
) {
  const preference = readRudderSkillSyncPreference(config);
  return Array.from(new Set(
    preference.desiredSkills
      .map((reference) => {
        const resolved = resolveSkillReference(skills, reference, orgId).skill?.key;
        if (resolved) return resolved;
        const bundledKey = toBundledRudderSkillKey(getBundledRudderSkillSlug(reference));
        return bundledKey ?? normalizeSkillKey(reference);
      })
      .filter((value): value is string => Boolean(value)),
  ));
}

export function getRequiredBundledSkillKeys(
  skills: Array<Pick<OrganizationSkill, "key">>,
): string[] {
  const availableKeys = new Set(skills.map((skill) => skill.key));
  return RUDDER_BUNDLED_SKILL_SLUGS
    .map((slug) => `rudder/${slug}`)
    .filter((key) => availableKeys.has(key));
}

export function sortUniqueSkillKeys(skillKeys: string[]) {
  return Array.from(
    new Set(
      skillKeys
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

export function sortUniqueSelectionRefs(selectionRefs: string[]) {
  return Array.from(
    new Set(
      selectionRefs
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

export function arraysEqual(left: string[], right: string[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function buildMissingSelectionEntry(
  selectionKey: string,
  agentRuntimeType: string,
): AgentSkillCatalogEntry {
  const parsed = parseSelectionKey(selectionKey);
  const key = parsed.slug ?? parsed.orgKey ?? selectionKey;
  const runtimeTypeMismatch =
    parsed.sourceClass === "adapter_home"
    && parsed.agentRuntimeType
    && parsed.agentRuntimeType !== agentRuntimeType;
  const locationLabel = (() => {
    if (parsed.sourceClass === "agent_home") return "AGENT_HOME/skills";
    if (parsed.sourceClass === "global") return "~/.agents/skills";
    if (parsed.sourceClass === "adapter_home" && parsed.agentRuntimeType) {
      return ADAPTER_SKILL_HOME_DEFINITIONS[parsed.agentRuntimeType]?.locationLabel ?? null;
    }
    return null;
  })();
  const detail = runtimeTypeMismatch
    ? `This adapter-specific skill was saved for ${parsed.agentRuntimeType} and is unavailable on ${agentRuntimeType}.`
    : "Rudder cannot find this enabled skill in the current Rudder-owned catalog.";

  return {
    key,
    selectionKey,
    runtimeName: parsed.slug ?? key,
    description: null,
    desired: true,
    configurable: parsed.sourceClass !== "bundled",
    alwaysEnabled: parsed.sourceClass === "bundled",
    managed: parsed.sourceClass === "bundled" || parsed.sourceClass === "organization",
    state: "missing",
    sourceClass: parsed.sourceClass ?? "adapter_home",
    origin: "external_unknown",
    originLabel: runtimeTypeMismatch ? "Unavailable for this runtime" : "Unavailable",
    locationLabel,
    readOnly: parsed.sourceClass === "bundled",
    sourcePath: null,
    targetPath: null,
    detail,
    organizationSkillKey: parsed.orgKey ?? null,
    runtimeSourcePath: null,
  };
}

export function applyDesiredSelectionsToCatalog(
  entries: AgentSkillCatalogEntry[],
  desiredSelectionRefs: string[],
  agentRuntimeType: string,
): AgentSkillCatalog {
  const desiredSet = new Set(desiredSelectionRefs);
  const warnings: string[] = [];
  const out = entries.map<AgentSkillCatalogEntry>((entry) => {
    const desired = entry.alwaysEnabled || desiredSet.has(entry.selectionKey);
    const state: AgentSkillState = entry.alwaysEnabled
        ? "configured"
        : desired
          ? "configured"
          : entry.sourceClass === "agent_home" || entry.sourceClass === "global" || entry.sourceClass === "adapter_home"
            ? "external"
            : "available";
    return {
      ...entry,
      desired,
      state,
      detail: desired
        ? entry.alwaysEnabled
          ? (entry.detail ?? "Always loaded by Rudder for every agent run.")
          : "Enabled for this agent and loaded on the next run."
        : (entry.detail ?? null),
    };
  });
  const knownSelectionKeys = new Set(out.map((entry) => entry.selectionKey));
  for (const selectionKey of desiredSelectionRefs) {
    if (knownSelectionKeys.has(selectionKey)) continue;
    warnings.push(`Enabled skill "${selectionKey}" is no longer available in the current skill catalog.`);
    out.push(buildMissingSelectionEntry(selectionKey, agentRuntimeType));
  }

  out.sort((left, right) => {
    const orderDelta = AGENT_SKILL_SOURCE_CLASS_ORDER[left.sourceClass] - AGENT_SKILL_SOURCE_CLASS_ORDER[right.sourceClass];
    if (orderDelta !== 0) return orderDelta;
    return left.key.localeCompare(right.key) || left.selectionKey.localeCompare(right.selectionKey);
  });

  const conflictGroups = new Map<string, string[]>();
  for (const entry of out) {
    if (!entry.desired || entry.alwaysEnabled) continue;
    const existing = conflictGroups.get(entry.key) ?? [];
    existing.push(entry.selectionKey);
    conflictGroups.set(entry.key, existing);
  }
  for (const [skillKey, selectionKeys] of conflictGroups.entries()) {
    if (selectionKeys.length <= 1) continue;
    warnings.push(`Enabled skill collision for "${skillKey}": ${selectionKeys.join(", ")}`);
  }

  return {
    desiredSkills: sortUniqueSelectionRefs(desiredSelectionRefs),
    entries: out,
    warnings,
  };
}

export function stripBundledRequiredSkillKeys(skillKeys: string[]) {
  return sortUniqueSkillKeys(skillKeys).filter((skillKey) => !isBundledRudderSkillKey(skillKey));
}

export function mergeRequiredBundledSkillKeys(
  skills: Array<Pick<OrganizationSkill, "key">>,
  skillKeys: string[],
) {
  return sortUniqueSkillKeys([
    ...stripBundledRequiredSkillKeys(skillKeys),
    ...getRequiredBundledSkillKeys(skills),
  ]);
}

export function normalizeSkillDirectory(skill: OrganizationSkill) {
  if ((skill.sourceType !== "local_path" && skill.sourceType !== "catalog") || !skill.sourceLocator) return null;
  const resolved = path.resolve(skill.sourceLocator);
  if (path.basename(resolved).toLowerCase() === "skill.md") {
    return path.dirname(resolved);
  }
  return resolved;
}

export function normalizeSourceLocatorDirectory(sourceLocator: string | null) {
  if (!sourceLocator) return null;
  const resolved = path.resolve(sourceLocator);
  return path.basename(resolved).toLowerCase() === "skill.md" ? path.dirname(resolved) : resolved;
}

export async function findMissingLocalSkillIds(
  skills: Array<Pick<OrganizationSkill, "id" | "sourceType" | "sourceLocator">>,
) {
  const missingIds: string[] = [];

  for (const skill of skills) {
    if (skill.sourceType !== "local_path") continue;
    const skillDir = normalizeSourceLocatorDirectory(skill.sourceLocator);
    if (!skillDir) {
      missingIds.push(skill.id);
      continue;
    }

    const skillDirStat = await statPath(skillDir);
    const skillFileStat = await statPath(path.join(skillDir, "SKILL.md"));
    if (!skillDirStat?.isDirectory() || !skillFileStat?.isFile()) {
      missingIds.push(skill.id);
    }
  }

  return missingIds;
}

export function resolveManagedSkillsRoot(orgId: string) {
  return resolveOrganizationSkillsDir(orgId);
}

export function resolveWorkspaceEditPath(orgId: string, sourcePath: string | null | undefined) {
  if (!sourcePath) return null;
  const workspaceRoot = path.resolve(resolveOrganizationWorkspaceRoot(orgId));
  const skillDir = path.resolve(sourcePath);
  const entryFilePath = path.resolve(skillDir, "SKILL.md");
  const relativePath = path.relative(workspaceRoot, entryFilePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }
  return normalizePortablePath(relativePath);
}

export function resolveLocalSkillFilePath(skill: OrganizationSkill, relativePath: string) {
  const normalized = normalizePortablePath(relativePath);
  const skillDir = normalizeSkillDirectory(skill);
  if (skillDir) {
    return path.resolve(skillDir, normalized);
  }

  if (!skill.sourceLocator) return null;
  const fallbackRoot = path.resolve(skill.sourceLocator);
  const directPath = path.resolve(fallbackRoot, normalized);
  return directPath;
}

export function inferLanguageFromPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  if (fileName === "skill.md" || fileName.endsWith(".md")) return "markdown";
  if (fileName.endsWith(".ts")) return "typescript";
  if (fileName.endsWith(".tsx")) return "tsx";
  if (fileName.endsWith(".js")) return "javascript";
  if (fileName.endsWith(".jsx")) return "jsx";
  if (fileName.endsWith(".json")) return "json";
  if (fileName.endsWith(".yml") || fileName.endsWith(".yaml")) return "yaml";
  if (fileName.endsWith(".sh")) return "bash";
  if (fileName.endsWith(".py")) return "python";
  if (fileName.endsWith(".html")) return "html";
  if (fileName.endsWith(".css")) return "css";
  return null;
}

export function isMarkdownPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  return fileName === "skill.md" || fileName.endsWith(".md");
}

export function deriveSkillSourceInfo(skill: OrganizationSkill): {
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: OrganizationSkillSourceBadge;
  sourcePath: string | null;
} {
  const metadata = getSkillMeta(skill);
  const localSkillDir = normalizeSkillDirectory(skill);
  if (isBundledRudderSourceKind(asString(metadata.sourceKind))) {
    return {
      editable: false,
      editableReason: "Bundled Rudder skills are read-only.",
      sourceLabel: "Bundled by Rudder",
      sourceBadge: "rudder",
      sourcePath: null,
    };
  }

  if (asString(metadata.sourceKind) === "community_preset") {
    return {
      editable: false,
      editableReason: "Community preset skills are read-only.",
      sourceLabel: "Community preset",
      sourceBadge: "community",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "skills_sh") {
    const owner = asString(metadata.owner) ?? null;
    const repo = asString(metadata.repo) ?? null;
    return {
      editable: false,
      editableReason: "Skills.sh-managed skills are read-only.",
      sourceLabel: skill.sourceLocator ?? (owner && repo ? `${owner}/${repo}` : null),
      sourceBadge: "skills_sh",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "github") {
    const owner = asString(metadata.owner) ?? null;
    const repo = asString(metadata.repo) ?? null;
    return {
      editable: false,
      editableReason: "Remote GitHub skills are read-only. Fork or import locally to edit them.",
      sourceLabel: owner && repo ? `${owner}/${repo}` : skill.sourceLocator,
      sourceBadge: "github",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "url") {
    return {
      editable: false,
      editableReason: "URL-based skills are read-only. Save them locally to edit them.",
      sourceLabel: skill.sourceLocator,
      sourceBadge: "url",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "local_path") {
    const managedRoot = resolveManagedSkillsRoot(skill.orgId);
    const projectName = asString(metadata.projectName);
    const workspaceName = asString(metadata.workspaceName);
    const isProjectScan = metadata.sourceKind === "project_scan";
    if (localSkillDir && localSkillDir.startsWith(managedRoot)) {
      return {
        editable: true,
        editableReason: null,
        sourceLabel: "Organization library",
        sourceBadge: "rudder",
        sourcePath: managedRoot,
      };
    }

    return {
      editable: true,
      editableReason: null,
      sourceLabel: isProjectScan
        ? [projectName, workspaceName].filter((value): value is string => Boolean(value)).join(" / ")
          || skill.sourceLocator
        : skill.sourceLocator,
      sourceBadge: "local",
      sourcePath: null,
    };
  }

  return {
    editable: false,
    editableReason: "This skill source is read-only.",
    sourceLabel: skill.sourceLocator,
    sourceBadge: "catalog",
    sourcePath: null,
  };
}

export function enrichSkill(skill: OrganizationSkill, attachedAgentCount: number, usedByAgents: OrganizationSkillUsageAgent[] = []) {
  const source = deriveSkillSourceInfo(skill);
  return {
    ...skill,
    attachedAgentCount,
    usedByAgents,
    ...source,
    workspaceEditPath: resolveWorkspaceEditPath(skill.orgId, normalizeSkillDirectory(skill)),
  };
}

export function toCompanySkillListItem(skill: OrganizationSkill, attachedAgentCount: number): OrganizationSkillListItem {
  const source = deriveSkillSourceInfo(skill);
  return {
    id: skill.id,
    orgId: skill.orgId,
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    sourceType: skill.sourceType,
    sourceLocator: skill.sourceLocator,
    sourceRef: skill.sourceRef,
    trustLevel: skill.trustLevel,
    compatibility: skill.compatibility,
    fileInventory: skill.fileInventory,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    attachedAgentCount,
    editable: source.editable,
    editableReason: source.editableReason,
    sourceLabel: source.sourceLabel,
    sourceBadge: source.sourceBadge,
    sourcePath: source.sourcePath,
    workspaceEditPath: resolveWorkspaceEditPath(skill.orgId, normalizeSkillDirectory(skill)),
  };
}

export function compareOrganizationSkillListItems(left: OrganizationSkillListItem, right: OrganizationSkillListItem) {
  const leftBundledSlug = getBundledRudderSkillSlug(left.key);
  const rightBundledSlug = getBundledRudderSkillSlug(right.key);

  if (leftBundledSlug && rightBundledSlug) {
    const leftIndex = RUDDER_BUNDLED_SKILL_SLUGS.findIndex((slug) => slug === leftBundledSlug);
    const rightIndex = RUDDER_BUNDLED_SKILL_SLUGS.findIndex((slug) => slug === rightBundledSlug);
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  } else if (leftBundledSlug) {
    return -1;
  } else if (rightBundledSlug) {
    return 1;
  }

  const byName = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  return left.key.localeCompare(right.key, undefined, { sensitivity: "base" });
}
