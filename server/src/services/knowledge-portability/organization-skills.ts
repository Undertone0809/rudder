import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@rudder/db";
import { agents as agentRows, organizationSkills } from "@rudder/db";
import { readRudderSkillSyncPreference, writeRudderSkillSyncPreference } from "@rudder/agent-runtime-utils/server-utils";
import type { RudderSkillEntry } from "@rudder/agent-runtime-utils/server-utils";
import { readSkillMetadataFromPath } from "@rudder/agent-runtime-utils/server-utils";
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
} from "@rudder/shared";
import {
  RUDDER_BUNDLED_SKILL_SLUGS,
  getBundledRudderSkillSlug,
  isCanonicalBundledRudderSkillKey,
  normalizeAgentUrlKey,
  resolveOrganizationSkillReference,
  toBundledRudderSkillKey,
} from "@rudder/shared";
import {
  resolveAgentSkillsDir,
  resolveOrganizationSkillsDir,
  resolveOrganizationWorkspaceRoot,
} from "../../home-paths.js";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { agentEnabledSkillsService } from "../agent-enabled-skills.js";
import { agentService } from "../agents.js";
import { projectService } from "../projects.js";

type OrganizationSkillRow = typeof organizationSkills.$inferSelect;

type ImportedSkill = {
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

type PackageSkillConflictStrategy = "replace" | "rename" | "skip";

export type ImportPackageSkillResult = {
  skill: OrganizationSkill;
  action: "created" | "updated" | "skipped";
  originalKey: string;
  originalSlug: string;
  requestedRefs: string[];
  reason: string | null;
};

type ParsedSkillImportSource = {
  resolvedSource: string;
  requestedSkillSlug: string | null;
  originalSkillsShUrl: string | null;
  warnings: string[];
};

type SkillSourceMeta = {
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

type RuntimeSkillEntryOptions = {
  materializeMissing?: boolean;
};

type AgentWorkspaceRow = {
  id: string;
  name: string;
  workspaceKey: string | null;
};

type AgentSkillCatalogEntry = AgentSkillEntry & {
  organizationSkillKey: string | null;
  runtimeSourcePath: string | null;
};

type AgentSkillCatalog = {
  desiredSkills: string[];
  entries: AgentSkillCatalogEntry[];
  warnings: string[];
};

type AgentSkillSelectionResolution = {
  desiredSkills: string[];
  warnings: string[];
};

type EnabledSkillsAgentRef = {
  id: string | null;
  orgId: string;
  agentRuntimeConfig: unknown;
  agentRuntimeType: string;
} | null;

type AdapterSkillHomeDefinition = {
  mode: AgentSkillSyncMode;
  label: string;
  locationLabel: string;
  resolveRoot: (config: Record<string, unknown>) => string;
};

type CommunityPresetDefinition =
  | {
    slug: string;
    source: "repo";
  }
  | {
    slug: string;
    source: "github";
    sourceUrl: string;
  };

const skillInventoryRefreshPromises = new Map<string, Promise<void>>();
const CANONICAL_BUNDLED_SKILL_KEYS = new Set(RUDDER_BUNDLED_SKILL_SLUGS.map((slug) => `rudder/${slug}`));
const COMMUNITY_PRESET_SKILLS: readonly CommunityPresetDefinition[] = [
  {
    slug: "deep-research",
    source: "repo",
  },
  {
    slug: "skill-creator",
    source: "github",
    sourceUrl: "https://github.com/Undertone0809/skill-creator/tree/main/.agents/skills",
  },
  {
    slug: "software-product-advisor",
    source: "repo",
  },
] as const;
const COMMUNITY_PRESET_SKILL_SLUGS = COMMUNITY_PRESET_SKILLS.map((preset) => preset.slug);
const BUNDLED_SELECTION_PREFIX = "bundled:";
const ORGANIZATION_SELECTION_PREFIX = "org:";
const AGENT_SELECTION_PREFIX = "agent:";
const GLOBAL_SELECTION_PREFIX = "global:";
const ADAPTER_SELECTION_PREFIX = "adapter:";
const AGENT_SKILL_SOURCE_CLASS_ORDER: Record<AgentSkillSourceClass, number> = {
  bundled: 0,
  organization: 1,
  agent_home: 2,
  global: 3,
  adapter_home: 4,
};
const ADAPTER_SKILL_HOME_DEFINITIONS: Record<string, AdapterSkillHomeDefinition> = {
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

const PROJECT_SCAN_DIRECTORY_ROOTS = [
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

const PROJECT_ROOT_SKILL_SUBDIRECTORIES = [
  "references",
  "scripts",
  "assets",
] as const;

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSkillDescription(value: unknown): string | null {
  const description = asString(value);
  if (!description) return null;
  return /^[>|][+-]?$/.test(description) ? null : description;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveConfigEnvRecord(config: Record<string, unknown>) {
  return isPlainRecord(config.env) ? config.env : {};
}

function resolveConfiguredHomeDir(config: Record<string, unknown>) {
  const env = resolveConfigEnvRecord(config);
  const configuredHome = asString(env.HOME);
  return configuredHome ? path.resolve(configuredHome) : os.homedir();
}

function resolveConfiguredCodexHomeDir(config: Record<string, unknown>) {
  const env = resolveConfigEnvRecord(config);
  const configuredCodexHome = asString(env.CODEX_HOME);
  return configuredCodexHome
    ? path.resolve(configuredCodexHome)
    : path.join(resolveConfiguredHomeDir(config), ".codex");
}

function normalizePortablePath(input: string) {
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

function normalizePackageFileMap(files: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [rawPath, content] of Object.entries(files)) {
    const nextPath = normalizePortablePath(rawPath);
    if (!nextPath) continue;
    out[nextPath] = content;
  }
  return out;
}

function normalizeSkillSlug(value: string | null | undefined) {
  return value ? normalizeAgentUrlKey(value) ?? null : null;
}

function normalizeSkillKey(value: string | null | undefined) {
  if (!value) return null;
  const segments = value
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("/") : null;
}

function isBundledRudderSourceKind(value: string | null | undefined) {
  return value === "rudder_bundled" || value === "paperclip_bundled";
}

function isBundledRudderSkillKey(value: string | null | undefined) {
  return isCanonicalBundledRudderSkillKey(value);
}

function buildBundledSelectionKey(skillKey: string) {
  return `${BUNDLED_SELECTION_PREFIX}${skillKey}`;
}

function buildOrganizationSelectionKey(skillKey: string) {
  return `${ORGANIZATION_SELECTION_PREFIX}${skillKey}`;
}

function buildAgentSelectionKey(slug: string) {
  return `${AGENT_SELECTION_PREFIX}${slug}`;
}

function buildGlobalSelectionKey(slug: string) {
  return `${GLOBAL_SELECTION_PREFIX}${slug}`;
}

function buildAdapterSelectionKey(agentRuntimeType: string, slug: string) {
  return `${ADAPTER_SELECTION_PREFIX}${agentRuntimeType}:${slug}`;
}

function parseSelectionKey(selectionKey: string): {
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

function normalizeSelectionRef(
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

async function discoverLocalSkillDirectories(root: string): Promise<string[]> {
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

async function readDiscoveredSkillEntries(
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

function buildDraftSkillMarkdown(input: OrganizationSkillCreateRequest) {
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

function buildAgentPrivateSkillEntry(
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
    detail: "Created in AGENT_HOME/skills.",
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

interface SkillWithMetadata {
  id: string;
  key: string;
  metadata: {
    sourceKind?: string | null;
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

function hashSkillValue(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function uniqueSkillSlug(baseSlug: string, usedSlugs: Set<string>) {
  if (!usedSlugs.has(baseSlug)) return baseSlug;
  let attempt = 2;
  let candidate = `${baseSlug}-${attempt}`;
  while (usedSlugs.has(candidate)) {
    attempt += 1;
    candidate = `${baseSlug}-${attempt}`;
  }
  return candidate;
}

function uniqueImportedSkillKey(orgId: string, baseSlug: string, usedKeys: Set<string>) {
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

function buildSkillRuntimeName(key: string, slug: string) {
  if (getBundledRudderSkillSlug(key)) return slug;
  return `${slug}--${hashSkillValue(key)}`;
}

function readCanonicalSkillKey(frontmatter: Record<string, unknown>, metadata: Record<string, unknown> | null) {
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

function deriveCanonicalSkillKey(
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

function classifyInventoryKind(relativePath: string): OrganizationSkillFileInventoryEntry["kind"] {
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

function deriveTrustLevel(fileInventory: OrganizationSkillFileInventoryEntry[]): OrganizationSkillTrustLevel {
  if (fileInventory.some((entry) => entry.kind === "script")) return "scripts_executables";
  if (fileInventory.some((entry) => entry.kind === "asset" || entry.kind === "other")) return "assets";
  return "markdown_only";
}

function prepareYamlLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => ({
      indent: line.match(/^ */)?.[0].length ?? 0,
      content: line.trim(),
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));
}

function parseYamlScalar(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("\"") || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parseYamlBlockScalar(
  lines: Array<{ indent: number; content: string }>,
  startIndex: number,
  indentLevel: number,
  style: "|" | ">",
): { value: string; nextIndex: number } {
  const parts: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indentLevel) break;
    parts.push(line.content);
    index += 1;
  }

  if (style === ">") {
    return { value: parts.join(" "), nextIndex: index };
  }

  return { value: parts.join("\n"), nextIndex: index };
}

function parseYamlBlock(
  lines: Array<{ indent: number; content: string }>,
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && lines[index]!.content.length === 0) index += 1;
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
    if (/^[>|][+-]?$/.test(remainder)) {
      const blockScalar = parseYamlBlockScalar(
        lines,
        index,
        indentLevel + 2,
        remainder.startsWith(">") ? ">" : "|",
      );
      record[key] = blockScalar.value;
      index = blockScalar.nextIndex;
      continue;
    }
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

function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const prepared = prepareYamlLines(raw);
  if (prepared.length === 0) return {};
  const parsed = parseYamlBlock(prepared, 0, prepared[0]!.indent);
  return isPlainRecord(parsed.value) ? parsed.value : {};
}

function parseFrontmatterMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();
  return {
    frontmatter: parseYamlFrontmatter(frontmatterRaw),
    body,
  };
}

async function fetchText(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchJson<T>(url: string): Promise<T> {
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

async function resolveGitHubDefaultBranch(owner: string, repo: string) {
  const response = await fetchJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${owner}/${repo}`,
  );
  return asString(response.default_branch) ?? "main";
}

async function resolveGitHubCommitSha(owner: string, repo: string, ref: string) {
  const response = await fetchJson<{ sha?: string }>(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
  );
  const sha = asString(response.sha);
  if (!sha) {
    throw unprocessable(`Failed to resolve GitHub ref ${ref}`);
  }
  return sha;
}

function parseGitHubSourceUrl(rawUrl: string) {
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
  let ref = "main";
  let basePath = "";
  let filePath: string | null = null;
  let explicitRef = false;
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
    explicitRef = true;
  } else if (parts[2] === "blob") {
    ref = parts[3] ?? "main";
    filePath = parts.slice(4).join("/");
    basePath = filePath ? path.posix.dirname(filePath) : "";
    explicitRef = true;
  }
  return { owner, repo, ref, basePath, filePath, explicitRef };
}

async function resolveGitHubPinnedRef(parsed: ReturnType<typeof parseGitHubSourceUrl>) {
  if (/^[0-9a-f]{40}$/i.test(parsed.ref.trim())) {
    return {
      pinnedRef: parsed.ref,
      trackingRef: parsed.explicitRef ? parsed.ref : null,
    };
  }

  const trackingRef = parsed.explicitRef
    ? parsed.ref
    : await resolveGitHubDefaultBranch(parsed.owner, parsed.repo);
  const pinnedRef = await resolveGitHubCommitSha(parsed.owner, parsed.repo, trackingRef);
  return { pinnedRef, trackingRef };
}

function resolveRawGitHubUrl(owner: string, repo: string, ref: string, filePath: string) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath.replace(/^\/+/, "")}`;
}

function extractCommandTokens(raw: string) {
  const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

export function parseSkillImportSourceInput(rawInput: string): ParsedSkillImportSource {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw unprocessable("Skill source is required.");
  }

  const warnings: string[] = [];
  let source = trimmed;
  let requestedSkillSlug: string | null = null;

  if (/^npx\s+skills\s+add\s+/i.test(trimmed)) {
    const tokens = extractCommandTokens(trimmed);
    const addIndex = tokens.findIndex(
      (token, index) =>
        token === "add"
        && index > 0
        && tokens[index - 1]?.toLowerCase() === "skills",
    );
    if (addIndex >= 0) {
      source = tokens[addIndex + 1] ?? "";
      for (let index = addIndex + 2; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (token === "--skill") {
          requestedSkillSlug = normalizeSkillSlug(tokens[index + 1] ?? null);
          index += 1;
          continue;
        }
        if (token.startsWith("--skill=")) {
          requestedSkillSlug = normalizeSkillSlug(token.slice("--skill=".length));
        }
      }
    }
  }

  const normalizedSource = source.trim();
  if (!normalizedSource) {
    throw unprocessable("Skill source is required.");
  }

  // Key-style imports (org/repo/skill) originate from the skills.sh registry
  if (!/^https?:\/\//i.test(normalizedSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedSource)) {
    const [owner, repo, skillSlugRaw] = normalizedSource.split("/");
    return {
      resolvedSource: `https://github.com/${owner}/${repo}`,
      requestedSkillSlug: normalizeSkillSlug(skillSlugRaw),
      originalSkillsShUrl: `https://skills.sh/${owner}/${repo}/${skillSlugRaw}`,
      warnings,
    };
  }

  if (!/^https?:\/\//i.test(normalizedSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedSource)) {
    return {
      resolvedSource: `https://github.com/${normalizedSource}`,
      requestedSkillSlug,
      originalSkillsShUrl: null,
      warnings,
    };
  }

  // Detect skills.sh URLs and resolve to GitHub: https://skills.sh/org/repo/skill → org/repo/skill key
  const skillsShMatch = normalizedSource.match(/^https?:\/\/(?:www\.)?skills\.sh\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?(?:[?#].*)?$/i);
  if (skillsShMatch) {
    const [, owner, repo, skillSlugRaw] = skillsShMatch;
    return {
      resolvedSource: `https://github.com/${owner}/${repo}`,
      requestedSkillSlug: skillSlugRaw ? normalizeSkillSlug(skillSlugRaw) : requestedSkillSlug,
      originalSkillsShUrl: normalizedSource,
      warnings,
    };
  }

  return {
    resolvedSource: normalizedSource,
    requestedSkillSlug,
    originalSkillsShUrl: null,
    warnings,
  };
}

function resolveBundledSkillsRoot() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDir, "../../../resources/bundled-skills"),
    path.resolve(process.cwd(), "server/resources/bundled-skills"),
  ];
}

async function readCommunityPresetFallbackImport(
  orgId: string,
  slug: string,
  skillKey: string,
  sourceUrl: string,
): Promise<ImportedSkill | null> {
  for (const skillsRoot of resolveCommunityPresetSkillsRoot()) {
    const stats = await fs.stat(skillsRoot).catch(() => null);
    if (!stats?.isDirectory()) continue;
    const skillDir = path.join(skillsRoot, slug);
    const skillStats = await fs.stat(skillDir).catch(() => null);
    if (!skillStats?.isDirectory()) continue;
    const imported = await readLocalSkillImportFromDirectory(orgId, skillDir, {
      metadata: {
        sourceKind: "community_preset",
        skillKey,
      },
    }).catch(() => null);
    if (!imported) continue;
    return {
      ...imported,
      key: skillKey,
      slug,
      sourceType: "github",
      sourceLocator: sourceUrl,
      sourceRef: imported.sourceRef ?? null,
      metadata: {
        ...(imported.metadata ?? {}),
        sourceKind: "community_preset",
        skillKey,
      },
    };
  }
  return null;
}

function resolveCommunityPresetSkillsRoot() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDir, "../../../resources/community-skills"),
    path.resolve(process.cwd(), "server/resources/community-skills"),
  ];
}

function matchesRequestedSkill(relativeSkillPath: string, requestedSkillSlug: string | null) {
  if (!requestedSkillSlug) return true;
  const skillDir = path.posix.dirname(relativeSkillPath);
  return normalizeSkillSlug(path.posix.basename(skillDir)) === requestedSkillSlug;
}

function deriveImportedSkillSlug(frontmatter: Record<string, unknown>, fallback: string) {
  return normalizeSkillSlug(asString(frontmatter.slug))
    ?? normalizeSkillSlug(asString(frontmatter.name))
    ?? normalizeAgentUrlKey(fallback)
    ?? "skill";
}

function deriveImportedSkillSource(
  frontmatter: Record<string, unknown>,
  fallbackSlug: string,
): Pick<ImportedSkill, "sourceType" | "sourceLocator" | "sourceRef" | "metadata"> {
  const metadata = isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : null;
  const canonicalKey = readCanonicalSkillKey(frontmatter, metadata);
  const rawSources = metadata && Array.isArray(metadata.sources) ? metadata.sources : [];
  const sourceEntry = rawSources.find((entry) => isPlainRecord(entry)) as Record<string, unknown> | undefined;
  const kind = asString(sourceEntry?.kind);

  if (kind === "github-dir" || kind === "github-file") {
    const repo = asString(sourceEntry?.repo);
    const repoPath = asString(sourceEntry?.path);
    const commit = asString(sourceEntry?.commit);
    const trackingRef = asString(sourceEntry?.trackingRef);
    const url = asString(sourceEntry?.url)
      ?? (repo
        ? `https://github.com/${repo}${repoPath ? `/tree/${trackingRef ?? commit ?? "main"}/${repoPath}` : ""}`
        : null);
    const [owner, repoName] = (repo ?? "").split("/");
    if (repo && owner && repoName) {
      return {
        sourceType: "github",
        sourceLocator: url,
        sourceRef: commit,
        metadata: {
          ...(canonicalKey ? { skillKey: canonicalKey } : {}),
          sourceKind: "github",
          owner,
          repo: repoName,
          ref: commit,
          trackingRef,
          repoSkillDir: repoPath ?? `skills/${fallbackSlug}`,
        },
      };
    }
  }

  if (kind === "url") {
    const url = asString(sourceEntry?.url) ?? asString(sourceEntry?.rawUrl);
    if (url) {
      return {
        sourceType: "url",
        sourceLocator: url,
        sourceRef: null,
        metadata: {
          ...(canonicalKey ? { skillKey: canonicalKey } : {}),
          sourceKind: "url",
        },
      };
    }
  }

  return {
    sourceType: "catalog",
    sourceLocator: null,
    sourceRef: null,
    metadata: {
      ...(canonicalKey ? { skillKey: canonicalKey } : {}),
      sourceKind: "catalog",
    },
  };
}

function readInlineSkillImports(orgId: string, files: Record<string, string>): ImportedSkill[] {
  const normalizedFiles = normalizePackageFileMap(files);
  const skillPaths = Object.keys(normalizedFiles).filter(
    (entry) => path.posix.basename(entry).toLowerCase() === "skill.md",
  );
  const imports: ImportedSkill[] = [];

  for (const skillPath of skillPaths) {
    const dir = path.posix.dirname(skillPath);
    const skillDir = dir === "." ? "" : dir;
    const slugFallback = path.posix.basename(skillDir || path.posix.dirname(skillPath));
    const markdown = normalizedFiles[skillPath]!;
    const parsed = parseFrontmatterMarkdown(markdown);
    const slug = deriveImportedSkillSlug(parsed.frontmatter, slugFallback);
    const source = deriveImportedSkillSource(parsed.frontmatter, slug);
    const inventory = Object.keys(normalizedFiles)
      .filter((entry) => entry === skillPath || (skillDir ? entry.startsWith(`${skillDir}/`) : false))
      .map((entry) => {
        const relative = entry === skillPath ? "SKILL.md" : entry.slice(skillDir.length + 1);
        return {
          path: normalizePortablePath(relative),
          kind: classifyInventoryKind(relative),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));

    imports.push({
      key: "",
      slug,
      name: asString(parsed.frontmatter.name) ?? slug,
      description: normalizeSkillDescription(parsed.frontmatter.description),
      markdown,
      packageDir: skillDir,
      sourceType: source.sourceType,
      sourceLocator: source.sourceLocator,
      sourceRef: source.sourceRef,
      trustLevel: deriveTrustLevel(inventory),
      compatibility: "compatible",
      fileInventory: inventory,
      metadata: source.metadata,
    });
    imports[imports.length - 1]!.key = deriveCanonicalSkillKey(orgId, imports[imports.length - 1]!);
  }

  return imports;
}

async function walkLocalFiles(root: string, current: string, out: string[]) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkLocalFiles(root, absolutePath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(normalizePortablePath(path.relative(root, absolutePath)));
  }
}

async function statPath(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

async function collectLocalSkillInventory(
  skillDir: string,
  mode: LocalSkillInventoryMode = "full",
): Promise<OrganizationSkillFileInventoryEntry[]> {
  const skillFilePath = path.join(skillDir, "SKILL.md");
  const skillFileStat = await statPath(skillFilePath);
  if (!skillFileStat?.isFile()) {
    throw unprocessable(`No SKILL.md file was found in ${skillDir}.`);
  }

  const allFiles = new Set<string>(["SKILL.md"]);
  if (mode === "full") {
    const discoveredFiles: string[] = [];
    await walkLocalFiles(skillDir, skillDir, discoveredFiles);
    for (const relativePath of discoveredFiles) {
      allFiles.add(relativePath);
    }
  } else {
    for (const relativeDir of PROJECT_ROOT_SKILL_SUBDIRECTORIES) {
      const absoluteDir = path.join(skillDir, relativeDir);
      const dirStat = await statPath(absoluteDir);
      if (!dirStat?.isDirectory()) continue;
      const discoveredFiles: string[] = [];
      await walkLocalFiles(skillDir, absoluteDir, discoveredFiles);
      for (const relativePath of discoveredFiles) {
        allFiles.add(relativePath);
      }
    }
  }

  return Array.from(allFiles)
    .map((relativePath) => ({
      path: normalizePortablePath(relativePath),
      kind: classifyInventoryKind(relativePath),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function readLocalSkillImportFromDirectory(
  orgId: string,
  skillDir: string,
  options?: {
    inventoryMode?: LocalSkillInventoryMode;
    metadata?: Record<string, unknown> | null;
  },
): Promise<ImportedSkill> {
  const resolvedSkillDir = path.resolve(skillDir);
  const skillFilePath = path.join(resolvedSkillDir, "SKILL.md");
  const markdown = await fs.readFile(skillFilePath, "utf8");
  const parsed = parseFrontmatterMarkdown(markdown);
  const slug = deriveImportedSkillSlug(parsed.frontmatter, path.basename(resolvedSkillDir));
  const parsedMetadata = isPlainRecord(parsed.frontmatter.metadata) ? parsed.frontmatter.metadata : null;
  const skillKey = readCanonicalSkillKey(parsed.frontmatter, parsedMetadata);
  const metadata = {
    ...(skillKey ? { skillKey } : {}),
    ...(parsedMetadata ?? {}),
    sourceKind: "local_path",
    ...(options?.metadata ?? {}),
  };
  const inventory = await collectLocalSkillInventory(resolvedSkillDir, options?.inventoryMode ?? "full");

  return {
    key: deriveCanonicalSkillKey(orgId, {
      slug,
      sourceType: "local_path",
      sourceLocator: resolvedSkillDir,
      metadata,
    }),
    slug,
    name: asString(parsed.frontmatter.name) ?? slug,
    description: normalizeSkillDescription(parsed.frontmatter.description),
    markdown,
    packageDir: resolvedSkillDir,
    sourceType: "local_path",
    sourceLocator: resolvedSkillDir,
    sourceRef: null,
    trustLevel: deriveTrustLevel(inventory),
    compatibility: "compatible",
    fileInventory: inventory,
    metadata,
  };
}

export async function discoverProjectWorkspaceSkillDirectories(target: ProjectSkillScanTarget): Promise<Array<{
  skillDir: string;
  inventoryMode: LocalSkillInventoryMode;
}>> {
  const discovered = new Map<string, LocalSkillInventoryMode>();
  const rootSkillPath = path.join(target.workspaceCwd, "SKILL.md");
  if ((await statPath(rootSkillPath))?.isFile()) {
    discovered.set(path.resolve(target.workspaceCwd), "project_root");
  }

  for (const relativeRoot of PROJECT_SCAN_DIRECTORY_ROOTS) {
    const absoluteRoot = path.join(target.workspaceCwd, relativeRoot);
    const rootStat = await statPath(absoluteRoot);
    if (!rootStat?.isDirectory()) continue;

    const entries = await fs.readdir(absoluteRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const absoluteSkillDir = path.resolve(absoluteRoot, entry.name);
      if (!(await statPath(path.join(absoluteSkillDir, "SKILL.md")))?.isFile()) continue;
      discovered.set(absoluteSkillDir, "full");
    }
  }

  return Array.from(discovered.entries())
    .map(([skillDir, inventoryMode]) => ({ skillDir, inventoryMode }))
    .sort((left, right) => left.skillDir.localeCompare(right.skillDir));
}

async function readLocalSkillImports(orgId: string, sourcePath: string): Promise<ImportedSkill[]> {
  const resolvedPath = path.resolve(sourcePath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat) {
    throw unprocessable(`Skill source path does not exist: ${sourcePath}`);
  }

  if (stat.isFile()) {
    if (path.basename(resolvedPath).toLowerCase() !== "skill.md") {
      throw unprocessable("Local skill imports must point at SKILL.md or a directory that contains skill folders.");
    }
    return [await readLocalSkillImportFromDirectory(orgId, path.dirname(resolvedPath))];
  }

  const discovered = new Set<string>();
  if ((await statPath(path.join(resolvedPath, "SKILL.md")))?.isFile()) {
    discovered.add(resolvedPath);
  }

  for (const candidateRoot of [resolvedPath, path.join(resolvedPath, "skills")]) {
    const candidateStat = await statPath(candidateRoot);
    if (!candidateStat?.isDirectory()) continue;
    const entries = await fs.readdir(candidateRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(candidateRoot, entry.name);
      if ((await statPath(path.join(skillDir, "SKILL.md")))?.isFile()) {
        discovered.add(path.resolve(skillDir));
      }
    }
  }

  if (discovered.size === 0) {
    throw unprocessable("No SKILL.md files were found in the provided path.");
  }

  return Promise.all(
    Array.from(discovered)
      .sort((left, right) => left.localeCompare(right))
      .map((skillDir) => readLocalSkillImportFromDirectory(orgId, skillDir)),
  );
}

async function readUrlSkillImports(
  orgId: string,
  sourceUrl: string,
  requestedSkillSlug: string | null = null,
): Promise<{ skills: ImportedSkill[]; warnings: string[] }> {
  const url = sourceUrl.trim();
  const warnings: string[] = [];
  if (url.includes("github.com/")) {
    const parsed = parseGitHubSourceUrl(url);
    const { pinnedRef, trackingRef } = await resolveGitHubPinnedRef(parsed);
    let ref = pinnedRef;
    const tree = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
    ).catch(() => {
      throw unprocessable(`Failed to read GitHub tree for ${url}`);
    });
    const allPaths = (tree.tree ?? [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entry): entry is string => typeof entry === "string");
    const basePrefix = parsed.basePath ? `${parsed.basePath.replace(/^\/+|\/+$/g, "")}/` : "";
    const scopedPaths = basePrefix
      ? allPaths.filter((entry) => entry.startsWith(basePrefix))
      : allPaths;
    const relativePaths = scopedPaths.map((entry) => basePrefix ? entry.slice(basePrefix.length) : entry);
    const filteredPaths = parsed.filePath
      ? relativePaths.filter((entry) => entry === path.posix.relative(parsed.basePath || ".", parsed.filePath!))
      : relativePaths;
    const skillPaths = filteredPaths.filter(
      (entry) => path.posix.basename(entry).toLowerCase() === "skill.md",
    );
    if (skillPaths.length === 0) {
      throw unprocessable(
        "No SKILL.md files were found in the provided GitHub source.",
      );
    }
    const skills: ImportedSkill[] = [];
    for (const relativeSkillPath of skillPaths) {
      const repoSkillPath = basePrefix ? `${basePrefix}${relativeSkillPath}` : relativeSkillPath;
      const markdown = await fetchText(resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, repoSkillPath));
      const parsedMarkdown = parseFrontmatterMarkdown(markdown);
      const skillDir = path.posix.dirname(relativeSkillPath);
      const slug = deriveImportedSkillSlug(parsedMarkdown.frontmatter, path.posix.basename(skillDir));
      const skillKey = readCanonicalSkillKey(
        parsedMarkdown.frontmatter,
        isPlainRecord(parsedMarkdown.frontmatter.metadata) ? parsedMarkdown.frontmatter.metadata : null,
      );
      if (requestedSkillSlug && !matchesRequestedSkill(relativeSkillPath, requestedSkillSlug) && slug !== requestedSkillSlug) {
        continue;
      }
      const metadata = {
        ...(skillKey ? { skillKey } : {}),
        sourceKind: "github",
        owner: parsed.owner,
        repo: parsed.repo,
        ref: ref,
        trackingRef,
        repoSkillDir: normalizeGitHubSkillDirectory(
          basePrefix ? `${basePrefix}${skillDir}` : skillDir,
          slug,
        ),
      };
      const inventory = filteredPaths
        .filter((entry) => entry === relativeSkillPath || entry.startsWith(`${skillDir}/`))
        .map((entry) => ({
          path: entry === relativeSkillPath ? "SKILL.md" : entry.slice(skillDir.length + 1),
          kind: classifyInventoryKind(entry === relativeSkillPath ? "SKILL.md" : entry.slice(skillDir.length + 1)),
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
      skills.push({
        key: deriveCanonicalSkillKey(orgId, {
          slug,
          sourceType: "github",
          sourceLocator: sourceUrl,
          metadata,
        }),
        slug,
        name: asString(parsedMarkdown.frontmatter.name) ?? slug,
        description: normalizeSkillDescription(parsedMarkdown.frontmatter.description),
        markdown,
        sourceType: "github",
        sourceLocator: sourceUrl,
        sourceRef: ref,
        trustLevel: deriveTrustLevel(inventory),
        compatibility: "compatible",
        fileInventory: inventory,
        metadata,
      });
    }
    if (skills.length === 0) {
      throw unprocessable(
        requestedSkillSlug
          ? `Skill ${requestedSkillSlug} was not found in the provided GitHub source.`
          : "No SKILL.md files were found in the provided GitHub source.",
      );
    }
    return { skills, warnings };
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    const markdown = await fetchText(url);
    const parsedMarkdown = parseFrontmatterMarkdown(markdown);
    const urlObj = new URL(url);
    const fileName = path.posix.basename(urlObj.pathname);
    const slug = deriveImportedSkillSlug(parsedMarkdown.frontmatter, fileName.replace(/\.md$/i, ""));
    const skillKey = readCanonicalSkillKey(
      parsedMarkdown.frontmatter,
      isPlainRecord(parsedMarkdown.frontmatter.metadata) ? parsedMarkdown.frontmatter.metadata : null,
    );
    const metadata = {
      ...(skillKey ? { skillKey } : {}),
      sourceKind: "url",
    };
    const inventory: OrganizationSkillFileInventoryEntry[] = [{ path: "SKILL.md", kind: "skill" }];
    return {
      skills: [{
        key: deriveCanonicalSkillKey(orgId, {
          slug,
          sourceType: "url",
          sourceLocator: url,
          metadata,
        }),
        slug,
        name: asString(parsedMarkdown.frontmatter.name) ?? slug,
        description: normalizeSkillDescription(parsedMarkdown.frontmatter.description),
        markdown,
        sourceType: "url",
        sourceLocator: url,
        sourceRef: null,
        trustLevel: deriveTrustLevel(inventory),
        compatibility: "compatible",
        fileInventory: inventory,
        metadata,
      }],
      warnings,
    };
  }

  throw unprocessable("Unsupported skill source. Use a local path or URL.");
}

function toCompanySkill(row: OrganizationSkillRow): OrganizationSkill {
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

function serializeFileInventory(
  fileInventory: OrganizationSkillFileInventoryEntry[],
): Array<Record<string, unknown>> {
  return fileInventory.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
  }));
}

function getSkillMeta(skill: OrganizationSkill): SkillSourceMeta {
  return isPlainRecord(skill.metadata) ? skill.metadata as SkillSourceMeta : {};
}

function resolveSkillReference(
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

function resolveRequestedSkillKeysOrThrow(
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

function resolveDesiredSkillKeys(
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

function getRequiredBundledSkillKeys(
  skills: Array<Pick<OrganizationSkill, "key">>,
): string[] {
  const availableKeys = new Set(skills.map((skill) => skill.key));
  return RUDDER_BUNDLED_SKILL_SLUGS
    .map((slug) => `rudder/${slug}`)
    .filter((key) => availableKeys.has(key));
}

function sortUniqueSkillKeys(skillKeys: string[]) {
  return Array.from(
    new Set(
      skillKeys
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function sortUniqueSelectionRefs(selectionRefs: string[]) {
  return Array.from(
    new Set(
      selectionRefs
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function arraysEqual(left: string[], right: string[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function buildMissingSelectionEntry(
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

function applyDesiredSelectionsToCatalog(
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
          : (entry.detail ?? "Enabled for this agent and loaded on the next run.")
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

function stripBundledRequiredSkillKeys(skillKeys: string[]) {
  return sortUniqueSkillKeys(skillKeys).filter((skillKey) => !isBundledRudderSkillKey(skillKey));
}

function mergeRequiredBundledSkillKeys(
  skills: Array<Pick<OrganizationSkill, "key">>,
  skillKeys: string[],
) {
  return sortUniqueSkillKeys([
    ...stripBundledRequiredSkillKeys(skillKeys),
    ...getRequiredBundledSkillKeys(skills),
  ]);
}

function normalizeSkillDirectory(skill: OrganizationSkill) {
  if ((skill.sourceType !== "local_path" && skill.sourceType !== "catalog") || !skill.sourceLocator) return null;
  const resolved = path.resolve(skill.sourceLocator);
  if (path.basename(resolved).toLowerCase() === "skill.md") {
    return path.dirname(resolved);
  }
  return resolved;
}

function normalizeSourceLocatorDirectory(sourceLocator: string | null) {
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

function resolveManagedSkillsRoot(orgId: string) {
  return resolveOrganizationSkillsDir(orgId);
}

function resolveWorkspaceEditPath(orgId: string, sourcePath: string | null | undefined) {
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

function resolveLocalSkillFilePath(skill: OrganizationSkill, relativePath: string) {
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

function inferLanguageFromPath(filePath: string) {
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

function isMarkdownPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  return fileName === "skill.md" || fileName.endsWith(".md");
}

function deriveSkillSourceInfo(skill: OrganizationSkill): {
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
        sourceLabel: "Rudder workspace",
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

function enrichSkill(skill: OrganizationSkill, attachedAgentCount: number, usedByAgents: OrganizationSkillUsageAgent[] = []) {
  const source = deriveSkillSourceInfo(skill);
  return {
    ...skill,
    attachedAgentCount,
    usedByAgents,
    ...source,
    workspaceEditPath: resolveWorkspaceEditPath(skill.orgId, normalizeSkillDirectory(skill)),
  };
}

function toCompanySkillListItem(skill: OrganizationSkill, attachedAgentCount: number): OrganizationSkillListItem {
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

function compareOrganizationSkillListItems(left: OrganizationSkillListItem, right: OrganizationSkillListItem) {
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

export function organizationSkillService(db: Db) {
  const agents = agentService(db);
  const enabledSkills = agentEnabledSkillsService(db);
  const projects = projectService(db);

  async function getAgentWorkspaceRow(orgId: string, agentId: string): Promise<AgentWorkspaceRow> {
    const row = await db
      .select({
        id: agentRows.id,
        name: agentRows.name,
        workspaceKey: agentRows.workspaceKey,
      })
      .from(agentRows)
      .where(and(eq(agentRows.orgId, orgId), eq(agentRows.id, agentId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Agent not found");
    return row;
  }

  async function ensureBundledSkills(orgId: string) {
    for (const skillsRoot of resolveBundledSkillsRoot()) {
      const stats = await fs.stat(skillsRoot).catch(() => null);
      if (!stats?.isDirectory()) continue;
      let bundledSkillCandidates: Array<ImportedSkill | null> = [];
      try {
        bundledSkillCandidates = await Promise.all(
          RUDDER_BUNDLED_SKILL_SLUGS.map(async (slug) => {
            const skillDir = path.join(skillsRoot, slug);
            const skillStats = await fs.stat(skillDir).catch(() => null);
            if (!skillStats?.isDirectory()) return null;
            const imported = await readLocalSkillImportFromDirectory(orgId, skillDir, {
              metadata: {
                sourceKind: "rudder_bundled",
                skillKey: `rudder/${slug}`,
              },
            }).catch(() => null);
            if (!imported) return null;
            return {
              ...imported,
              key: `rudder/${slug}`,
              slug,
              metadata: {
                ...(imported.metadata ?? {}),
                sourceKind: "rudder_bundled",
                skillKey: `rudder/${slug}`,
              },
            };
          }),
        );
      } catch {
        bundledSkillCandidates = [];
      }
      const bundledSkills = bundledSkillCandidates.filter((skill): skill is ImportedSkill => skill !== null);
      if (bundledSkills.length === 0) continue;

      const persisted = await upsertImportedSkills(orgId, bundledSkills);
      const existingRows = await db
        .select({
          id: organizationSkills.id,
          key: organizationSkills.key,
          metadata: organizationSkills.metadata,
        })
        .from(organizationSkills)
        .where(eq(organizationSkills.orgId, orgId));
      const staleBundledIds = listStaleBundledSkillIds(existingRows, Array.from(CANONICAL_BUNDLED_SKILL_KEYS));
      if (staleBundledIds.length > 0) {
        const staleKeys = existingRows
          .filter((row) => staleBundledIds.includes(row.id))
          .map((row) => String(row.key));
        await enabledSkills.removeSkillKeys(orgId, staleKeys);
        for (const staleId of staleBundledIds) {
          await db.delete(organizationSkills).where(eq(organizationSkills.id, staleId));
        }
      }

      return persisted;
    }
    return [];
  }

  /**
   * Seed community presets into the org library without upgrading them to
   * bundled Rudder runtime skills.
   *
   * Reasoning:
   * - Presets should behave like optional organization skills in agent pickers.
   * - Existing non-preset rows with the same canonical key win, so a local
   *   org-managed replacement is not overwritten by refresh.
   * - Presets can come from repo-owned packages or GitHub-managed sources
   *   without changing their product meaning in the UI.
   *
   * Traceability:
   * - doc/plans/2026-04-19-community-preset-skills.md
   */
  async function ensureCommunityPresetSkills(orgId: string) {
    const currentCommunityPresetKeys = COMMUNITY_PRESET_SKILL_SLUGS.map((slug) => `organization/${orgId}/${slug}`);
    const localPresetRoots = resolveCommunityPresetSkillsRoot();

    const presetCandidates: Array<ImportedSkill | null> = await Promise.all(
      COMMUNITY_PRESET_SKILLS.map(async (preset): Promise<ImportedSkill | null> => {
        const skillKey = `organization/${orgId}/${preset.slug}`;
        if (preset.source === "repo") {
          for (const skillsRoot of localPresetRoots) {
            const stats = await fs.stat(skillsRoot).catch(() => null);
            if (!stats?.isDirectory()) continue;
            const skillDir = path.join(skillsRoot, preset.slug);
            const skillStats = await fs.stat(skillDir).catch(() => null);
            if (!skillStats?.isDirectory()) continue;
            const imported = await readLocalSkillImportFromDirectory(orgId, skillDir, {
              metadata: {
                sourceKind: "community_preset",
                skillKey,
              },
            }).catch(() => null);
            if (!imported) continue;
            return {
              ...imported,
              key: skillKey,
              slug: preset.slug,
              metadata: {
                ...(imported.metadata ?? {}),
                sourceKind: "community_preset",
                skillKey,
              },
            };
          }
          return null;
        }

        const imported = await readUrlSkillImports(orgId, preset.sourceUrl, preset.slug)
          .then((result) => result.skills.find((skill) => skill.slug === preset.slug) ?? result.skills[0] ?? null)
          .catch(() => null);
        const resolvedImported = imported ?? await readCommunityPresetFallbackImport(
          orgId,
          preset.slug,
          skillKey,
          preset.sourceUrl,
        );
        if (!resolvedImported) return null;
        return {
          ...resolvedImported,
          key: skillKey,
          slug: preset.slug,
          metadata: {
            ...(resolvedImported.metadata ?? {}),
            sourceKind: "community_preset",
            skillKey,
          },
        };
      }),
    );

    const presetSkills = presetCandidates.filter((skill): skill is ImportedSkill => skill !== null);
    const existingRows = await db
      .select({
        id: organizationSkills.id,
        key: organizationSkills.key,
        metadata: organizationSkills.metadata,
      })
      .from(organizationSkills)
      .where(eq(organizationSkills.orgId, orgId));
    const existingByKey = new Map(existingRows.map((row) => [String(row.key), row]));
    const toPersist = presetSkills.filter((skill) => {
      const existing = existingByKey.get(skill.key);
      if (!existing) return true;
      return asString((existing.metadata as Record<string, unknown> | null | undefined)?.sourceKind) === "community_preset";
    });
    const persisted = toPersist.length > 0 ? await upsertImportedSkills(orgId, toPersist) : [];
    const stalePresetIds = listStaleCommunityPresetSkillIds(existingRows, currentCommunityPresetKeys);
    if (stalePresetIds.length > 0) {
      const staleKeys = existingRows
        .filter((row) => stalePresetIds.includes(row.id))
        .map((row) => String(row.key));
      await enabledSkills.removeSkillKeys(orgId, staleKeys);
      for (const staleId of stalePresetIds) {
        await db.delete(organizationSkills).where(eq(organizationSkills.id, staleId));
      }
    }

    return persisted;
  }

  async function pruneMissingLocalPathSkills(orgId: string) {
    const rows = await db
      .select()
      .from(organizationSkills)
      .where(eq(organizationSkills.orgId, orgId));
    const skills = rows.map((row) => toCompanySkill(row));
    const missingIds = new Set(await findMissingLocalSkillIds(skills));
    if (missingIds.size === 0) return;

    for (const skill of skills) {
      if (!missingIds.has(skill.id)) continue;
      await db
        .delete(organizationSkills)
        .where(eq(organizationSkills.id, skill.id));
      await fs.rm(resolveRuntimeSkillMaterializedPath(orgId, skill), { recursive: true, force: true });
    }
  }

  async function backfillMissingSkillDescriptions(orgId: string) {
    const rows = await db
      .select()
      .from(organizationSkills)
      .where(eq(organizationSkills.orgId, orgId));

    for (const row of rows) {
      if (normalizeSkillDescription(row.description)) continue;

      const skill = toCompanySkill(row);
      let description = normalizeSkillDescription(parseFrontmatterMarkdown(skill.markdown).frontmatter.description);

      if (!description) {
        const skillDir = normalizeSkillDirectory(skill);
        if (skillDir) {
          const markdown = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8").catch(() => null);
          if (markdown) {
            description = normalizeSkillDescription(parseFrontmatterMarkdown(markdown).frontmatter.description);
          }
        }
      }

      if (!description) continue;

      await db
        .update(organizationSkills)
        .set({ description })
        .where(eq(organizationSkills.id, skill.id));
    }
  }

  async function ensureSkillInventoryCurrent(orgId: string) {
    const existingRefresh = skillInventoryRefreshPromises.get(orgId);
    if (existingRefresh) {
      await existingRefresh;
      return;
    }

    const refreshPromise = (async () => {
      await ensureBundledSkills(orgId);
      await ensureCommunityPresetSkills(orgId);
      await pruneMissingLocalPathSkills(orgId);
      await backfillMissingSkillDescriptions(orgId);
    })();

    skillInventoryRefreshPromises.set(orgId, refreshPromise);
    try {
      await refreshPromise;
    } finally {
      if (skillInventoryRefreshPromises.get(orgId) === refreshPromise) {
        skillInventoryRefreshPromises.delete(orgId);
      }
    }
  }

  function resolveSkillMode(agentRuntimeType: string): AgentSkillSyncMode {
    return ADAPTER_SKILL_HOME_DEFINITIONS[agentRuntimeType]?.mode ?? "unsupported";
  }

  function selectionRefsToOrganizationSkillKeys(
    skills: OrganizationSkill[],
    selectionRefs: string[],
  ) {
    const selected = new Set<string>(getRequiredBundledSkillKeys(skills));
    const skillKeys = new Set(skills.map((skill) => skill.key));
    for (const selectionRef of selectionRefs) {
      const parsed = parseSelectionKey(selectionRef);
      if (parsed.sourceClass === "bundled" && parsed.orgKey && skillKeys.has(parsed.orgKey)) {
        selected.add(parsed.orgKey);
        continue;
      }
      if (parsed.sourceClass === "organization" && parsed.orgKey && skillKeys.has(parsed.orgKey)) {
        selected.add(parsed.orgKey);
      }
    }
    return Array.from(selected).sort((left, right) => left.localeCompare(right));
  }

  function normalizeStoredSelectionRefs(
    orgId: string,
    agent: EnabledSkillsAgentRef,
    skills: OrganizationSkill[],
    refs: string[],
  ) {
    if (!agent) return [] as string[];
    const normalized = refs
      .map((reference) => normalizeSelectionRef(reference, skills, orgId, agent.agentRuntimeType))
      .filter((value): value is string => Boolean(value))
      .filter((value) => parseSelectionKey(value).sourceClass !== "bundled");
    return sortUniqueSelectionRefs(normalized);
  }

  async function migrateLegacyEnabledSkills(
    orgId: string,
    agent: EnabledSkillsAgentRef,
    skills: OrganizationSkill[],
  ): Promise<string[]> {
    if (!agent?.id) return [];

    const currentRefs = await enabledSkills.listKeys(agent.id);
    if (currentRefs.length > 0) {
      const normalizedCurrentRefs = normalizeStoredSelectionRefs(orgId, agent, skills, currentRefs);
      if (!arraysEqual(currentRefs, normalizedCurrentRefs)) {
        await enabledSkills.replaceKeys(orgId, agent.id, normalizedCurrentRefs);
      }
      return normalizedCurrentRefs;
    }

    const legacyPreference = readRudderSkillSyncPreference(
      (agent.agentRuntimeConfig as Record<string, unknown>) ?? {},
    );
    if (!legacyPreference.explicit && legacyPreference.desiredSkills.length === 0) {
      return [];
    }

    const migratedRefs = normalizeStoredSelectionRefs(
      orgId,
      agent,
      skills,
      legacyPreference.desiredSkills,
    );

    if (migratedRefs.length > 0) {
      await enabledSkills.addMissingKeys(orgId, agent.id, migratedRefs);
    }

    await agents.update(agent.id, {
      agentRuntimeConfig: writeRudderSkillSyncPreference(
        (agent.agentRuntimeConfig as Record<string, unknown>) ?? {},
        [],
      ),
    });

    return migratedRefs;
  }

  async function getEnabledSkillSelectionMap(
    orgId: string,
    skills: OrganizationSkill[],
    agentRows: Awaited<ReturnType<typeof agents.list>>,
  ) {
    const selectionMap = await enabledSkills.listKeyMap(agentRows.map((agent) => agent.id));

    for (const agent of agentRows) {
      const existing = selectionMap.get(agent.id);
      if (existing) {
        const normalizedExisting = normalizeStoredSelectionRefs(orgId, agent, skills, existing);
        if (!arraysEqual(existing, normalizedExisting)) {
          await enabledSkills.replaceKeys(orgId, agent.id, normalizedExisting);
        }
        selectionMap.set(agent.id, normalizedExisting);
        continue;
      }
      selectionMap.set(agent.id, await migrateLegacyEnabledSkills(orgId, agent, skills));
    }

    return selectionMap;
  }

  async function list(orgId: string): Promise<OrganizationSkillListItem[]> {
    const rows = await listFull(orgId);
    const agentRows = await agents.list(orgId);
    const enabledSkillSelectionMap = await getEnabledSkillSelectionMap(orgId, rows, agentRows);
    return rows.map((skill) => {
      const attachedAgentCount = agentRows.filter((agent) => {
        const desiredSelectionRefs = enabledSkillSelectionMap.get(agent.id) ?? [];
        return selectionRefsToOrganizationSkillKeys(rows, desiredSelectionRefs).includes(skill.key);
      }).length;
      return toCompanySkillListItem(skill, attachedAgentCount);
    }).sort(compareOrganizationSkillListItems);
  }

  async function listFull(orgId: string): Promise<OrganizationSkill[]> {
    await ensureSkillInventoryCurrent(orgId);
    const rows = await db
      .select()
      .from(organizationSkills)
      .where(eq(organizationSkills.orgId, orgId))
      .orderBy(asc(organizationSkills.name), asc(organizationSkills.key));
    return rows.map((row) => toCompanySkill(row));
  }

  async function buildAgentSkillCatalogEntries(
    orgId: string,
    agentId: string | null,
    agentRuntimeType: string,
    runtimeConfig: Record<string, unknown>,
    skills: OrganizationSkill[],
  ): Promise<AgentSkillCatalogEntry[]> {
    const entries: AgentSkillCatalogEntry[] = [];

    for (const skill of skills) {
      const bundled = isBundledRudderSkillKey(skill.key);
      entries.push({
        key: skill.slug,
        selectionKey: bundled
          ? buildBundledSelectionKey(skill.key)
          : buildOrganizationSelectionKey(skill.key),
        runtimeName: skill.slug,
        description: skill.description ?? null,
        desired: bundled,
        configurable: !bundled,
        alwaysEnabled: bundled,
        managed: true,
        state: bundled ? "configured" : "available",
        sourceClass: bundled ? "bundled" : "organization",
        origin: "organization_managed",
        originLabel: bundled ? "Bundled by Rudder" : "Organization skill",
        locationLabel: null,
        readOnly: bundled,
        sourcePath: normalizeSkillDirectory(skill),
        targetPath: null,
        workspaceEditPath: resolveWorkspaceEditPath(orgId, normalizeSkillDirectory(skill)),
        detail: bundled ? "Always loaded by Rudder for every agent run." : null,
        organizationSkillKey: skill.key,
        runtimeSourcePath: null,
      });
    }

    if (agentId) {
      const agentWorkspace = await getAgentWorkspaceRow(orgId, agentId);
      entries.push(...await readDiscoveredSkillEntries(
        orgId,
        resolveAgentSkillsDir(orgId, agentWorkspace),
        (slug) => buildAgentSelectionKey(slug),
        {
          sourceClass: "agent_home",
          originLabel: "Agent skill",
          locationLabel: "AGENT_HOME/skills",
        },
      ));
    }

    const globalRoot = path.join(resolveConfiguredHomeDir(runtimeConfig), ".agents", "skills");
    entries.push(...await readDiscoveredSkillEntries(
      orgId,
      globalRoot,
      (slug) => buildGlobalSelectionKey(slug),
      {
        sourceClass: "global",
        originLabel: "Global skill",
        locationLabel: "~/.agents/skills",
      },
    ));

    const adapterHome = ADAPTER_SKILL_HOME_DEFINITIONS[agentRuntimeType];
    if (adapterHome) {
      entries.push(...await readDiscoveredSkillEntries(
        orgId,
        adapterHome.resolveRoot(runtimeConfig),
        (slug) => buildAdapterSelectionKey(agentRuntimeType, slug),
        {
          sourceClass: "adapter_home",
          originLabel: "Adapter skill",
          locationLabel: adapterHome.locationLabel,
        },
      ));
    }

    return entries.sort((left, right) =>
      left.key.localeCompare(right.key) || left.selectionKey.localeCompare(right.selectionKey));
  }

  function validateDesiredSelectionRefs(
    entries: AgentSkillCatalogEntry[],
    requestedDesiredRefs: string[],
  ): AgentSkillSelectionResolution {
    const bySelectionKey = new Map(entries.map((entry) => [entry.selectionKey, entry]));
    const desiredRefs = sortUniqueSelectionRefs(requestedDesiredRefs).filter((selectionRef) => {
      const entry = bySelectionKey.get(selectionRef);
      return entry?.configurable ?? true;
    });

    const unknownRefs = desiredRefs.filter((selectionRef) => !bySelectionKey.has(selectionRef));
    if (unknownRefs.length > 0) {
      throw unprocessable(`Invalid skill selection (unknown references: ${unknownRefs.join(", ")}).`);
    }

    const conflicts = new Map<string, string[]>();
    for (const selectionRef of desiredRefs) {
      const entry = bySelectionKey.get(selectionRef);
      if (!entry) continue;
      const existing = conflicts.get(entry.key) ?? [];
      existing.push(selectionRef);
      conflicts.set(entry.key, existing);
    }

    const conflictMessages = Array.from(conflicts.entries())
      .filter(([, refs]) => refs.length > 1)
      .map(([skillKey, refs]) => `${skillKey}: ${refs.join(", ")}`);
    if (conflictMessages.length > 0) {
      throw unprocessable(`Invalid skill selection (conflicting skill names: ${conflictMessages.join("; ")}).`);
    }

    return {
      desiredSkills: desiredRefs,
      warnings: [],
    };
  }

  async function getEnabledSkillSelectionRefsForAgent(
    orgId: string,
    agent: EnabledSkillsAgentRef,
    skills?: OrganizationSkill[],
  ) {
    const availableSkills = skills ?? await listFull(orgId);
    return migrateLegacyEnabledSkills(orgId, agent, availableSkills);
  }

  async function buildAgentSkillSnapshot(
    agent: EnabledSkillsAgentRef,
    runtimeConfig: Record<string, unknown>,
  ): Promise<AgentSkillSnapshot> {
    if (!agent) {
      return {
        agentRuntimeType: "",
        supported: false,
        mode: "unsupported",
        desiredSkills: [],
        entries: [],
        warnings: [],
      };
    }

    const skills = await listFull(agent.orgId);
    const desiredSkills = await getEnabledSkillSelectionRefsForAgent(agent.orgId, agent, skills);
    const entries = await buildAgentSkillCatalogEntries(
      agent.orgId,
      agent.id,
      agent.agentRuntimeType,
      runtimeConfig,
      skills,
    );
    const applied = applyDesiredSelectionsToCatalog(entries, desiredSkills, agent.agentRuntimeType);
    return {
      agentRuntimeType: agent.agentRuntimeType,
      supported: resolveSkillMode(agent.agentRuntimeType) !== "unsupported",
      mode: resolveSkillMode(agent.agentRuntimeType),
      desiredSkills: applied.desiredSkills,
      entries: applied.entries,
      warnings: applied.warnings,
    };
  }

  function resolveRequestedSelectionRefAgainstCatalog(
    reference: string,
    skills: OrganizationSkill[],
    catalogEntries: AgentSkillCatalogEntry[],
    agent: NonNullable<EnabledSkillsAgentRef>,
  ) {
    const trimmed = reference.trim();
    if (!trimmed) return { selectionKey: null as string | null, ambiguous: false };

    const parsed = parseSelectionKey(trimmed);
    if (parsed.sourceClass) {
      return {
        selectionKey: catalogEntries.some((entry) => entry.selectionKey === trimmed) ? trimmed : null,
        ambiguous: false,
      };
    }

    const normalized = normalizeSelectionRef(trimmed, skills, agent.orgId, agent.agentRuntimeType);
    if (normalized) {
      const normalizedParsed = parseSelectionKey(normalized);
      if (normalizedParsed.sourceClass === "bundled") {
        return { selectionKey: null, ambiguous: false };
      }
      if (catalogEntries.some((entry) => entry.selectionKey === normalized)) {
        return { selectionKey: normalized, ambiguous: false };
      }
    }

    const externalMatches = catalogEntries.filter((entry) =>
      entry.configurable
      && !entry.organizationSkillKey
      && (entry.key === normalizeSkillSlug(trimmed)
        || entry.runtimeName?.trim().toLowerCase() === trimmed.toLowerCase()),
    );
    if (externalMatches.length === 1) {
      return { selectionKey: externalMatches[0]!.selectionKey, ambiguous: false };
    }
    if (externalMatches.length > 1) {
      return { selectionKey: null, ambiguous: true };
    }

    return { selectionKey: null, ambiguous: false };
  }

  async function resolveDesiredSkillSelectionForAgent(
    agent: EnabledSkillsAgentRef,
    runtimeConfig: Record<string, unknown>,
    requestedDesiredSkills: string[] | undefined,
  ): Promise<AgentSkillSelectionResolution> {
    if (!agent) {
      return { desiredSkills: [], warnings: [] };
    }
    const skills = await listFull(agent.orgId);
    const catalogEntries = await buildAgentSkillCatalogEntries(
      agent.orgId,
      agent.id,
      agent.agentRuntimeType,
      runtimeConfig,
      skills,
    );
    const ambiguousRefs = new Set<string>();
    const unresolvedRefs = new Set<string>();
    const requestedRefs = sortUniqueSelectionRefs((requestedDesiredSkills ?? []).flatMap((reference) => {
      const resolved = resolveRequestedSelectionRefAgainstCatalog(reference, skills, catalogEntries, agent);
      if (resolved.ambiguous) {
        ambiguousRefs.add(reference.trim());
        return [];
      }
      if (!resolved.selectionKey) {
        const normalized = normalizeSelectionRef(reference, skills, agent.orgId, agent.agentRuntimeType);
        if (!normalized || parseSelectionKey(normalized).sourceClass !== "bundled") {
          unresolvedRefs.add(reference.trim());
        }
        return [];
      }
      return [resolved.selectionKey];
    }));
    if (ambiguousRefs.size > 0 || unresolvedRefs.size > 0) {
      const problems: string[] = [];
      if (ambiguousRefs.size > 0) {
        problems.push(`ambiguous references: ${sortUniqueSelectionRefs(Array.from(ambiguousRefs)).join(", ")}`);
      }
      if (unresolvedRefs.size > 0) {
        problems.push(`unknown references: ${sortUniqueSelectionRefs(Array.from(unresolvedRefs)).join(", ")}`);
      }
      throw unprocessable(`Invalid skill selection (${problems.join("; ")}).`);
    }

    return validateDesiredSelectionRefs(catalogEntries, requestedRefs);
  }

  async function listRealizedSkillEntriesForAgent(
    orgId: string,
    agentId: string,
    agentRuntimeType: string,
    runtimeConfig: Record<string, unknown>,
    selectionRefs: string[],
    options: RuntimeSkillEntryOptions = {},
  ): Promise<RudderSkillEntry[]> {
    const skills = await listFull(orgId);
    const skillByKey = new Map(skills.map((skill) => [skill.key, skill]));
    const catalogEntries = await buildAgentSkillCatalogEntries(orgId, agentId, agentRuntimeType, runtimeConfig, skills);
    const bySelectionKey = new Map(catalogEntries.map((entry) => [entry.selectionKey, entry]));
    const desiredSet = new Set(selectionRefs);
    const activeEntries = catalogEntries.filter((entry) => entry.alwaysEnabled || desiredSet.has(entry.selectionKey));
    const out: RudderSkillEntry[] = [];

    for (const entry of activeEntries) {
      if (entry.organizationSkillKey) {
        const skill = skillByKey.get(entry.organizationSkillKey);
        if (!skill) continue;
        let source = normalizeSkillDirectory(skill);
        if (!source) {
          source = options.materializeMissing === false
            ? resolveRuntimeSkillMaterializedPath(orgId, skill)
            : await materializeRuntimeSkillFiles(orgId, skill).catch(() => null);
        }
        if (!source) continue;
        out.push({
          key: entry.selectionKey,
          runtimeName: entry.key,
          source,
          name: skill.name,
          description: skill.description,
        });
        continue;
      }

      const catalogEntry = bySelectionKey.get(entry.selectionKey);
      if (!catalogEntry?.runtimeSourcePath) continue;
      out.push({
        key: entry.selectionKey,
        runtimeName: entry.key,
        source: catalogEntry.runtimeSourcePath,
        name: catalogEntry.runtimeName ?? entry.key,
        description: catalogEntry.description ?? null,
      });
    }

    return out.sort((left, right) => left.key.localeCompare(right.key));
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(organizationSkills)
      .where(eq(organizationSkills.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkill(row) : null;
  }

  async function getByKey(orgId: string, key: string) {
    const exactRow = await db
      .select()
      .from(organizationSkills)
      .where(and(eq(organizationSkills.orgId, orgId), eq(organizationSkills.key, key)))
      .then((rows) => rows[0] ?? null);
    if (exactRow) return toCompanySkill(exactRow);

    const bundledSlug = getBundledRudderSkillSlug(key);
    if (!bundledSlug) return null;

    const canonicalKey = toBundledRudderSkillKey(bundledSlug);
    const legacyKey = canonicalKey ? `rudder/${canonicalKey}` : null;
    const alternateKey = key === canonicalKey ? legacyKey : canonicalKey;
    if (!alternateKey) return null;

    const alternateRow = await db
      .select()
      .from(organizationSkills)
      .where(and(eq(organizationSkills.orgId, orgId), eq(organizationSkills.key, alternateKey)))
      .then((rows) => rows[0] ?? null);
    return alternateRow ? toCompanySkill(alternateRow) : null;
  }

  async function usage(orgId: string, key: string): Promise<OrganizationSkillUsageAgent[]> {
    const skills = await listFull(orgId);
    const agentRows = await agents.list(orgId);
    const enabledSkillSelectionMap = await getEnabledSkillSelectionMap(orgId, skills, agentRows);
    const desiredAgents = agentRows.filter((agent) =>
      selectionRefsToOrganizationSkillKeys(skills, enabledSkillSelectionMap.get(agent.id) ?? []).includes(key));

    return Promise.all(
      desiredAgents.map(async (agent) => {
        const actualState = resolveSkillMode(agent.agentRuntimeType) === "unsupported"
          ? "unsupported"
          : "configured";

        return {
          id: agent.id,
          name: agent.name,
          urlKey: agent.urlKey,
          agentRuntimeType: agent.agentRuntimeType,
          desired: true,
          actualState,
        };
      }),
    );
  }

  async function detail(orgId: string, id: string): Promise<OrganizationSkillDetail | null> {
    await ensureSkillInventoryCurrent(orgId);
    const skill = await getById(id);
    if (!skill || skill.orgId !== orgId) return null;
    const usedByAgents = await usage(orgId, skill.key);
    return enrichSkill(skill, usedByAgents.length, usedByAgents);
  }

  async function updateStatus(orgId: string, skillId: string): Promise<OrganizationSkillUpdateStatus | null> {
    await ensureSkillInventoryCurrent(orgId);
    const skill = await getById(skillId);
    if (!skill || skill.orgId !== orgId) return null;

    if (skill.sourceType !== "github" && skill.sourceType !== "skills_sh") {
      return {
        supported: false,
        reason: "Only GitHub-managed skills support update checks.",
        trackingRef: null,
        currentRef: skill.sourceRef ?? null,
        latestRef: null,
        hasUpdate: false,
      };
    }

    const metadata = getSkillMeta(skill);
    const owner = asString(metadata.owner);
    const repo = asString(metadata.repo);
    const trackingRef = asString(metadata.trackingRef) ?? asString(metadata.ref);
    if (!owner || !repo || !trackingRef) {
      return {
        supported: false,
        reason: "This GitHub skill does not have enough metadata to track updates.",
        trackingRef: trackingRef ?? null,
        currentRef: skill.sourceRef ?? null,
        latestRef: null,
        hasUpdate: false,
      };
    }

    const latestRef = await resolveGitHubCommitSha(owner, repo, trackingRef);
    return {
      supported: true,
      reason: null,
      trackingRef,
      currentRef: skill.sourceRef ?? null,
      latestRef,
      hasUpdate: latestRef !== (skill.sourceRef ?? null),
    };
  }

  async function readFile(orgId: string, skillId: string, relativePath: string): Promise<OrganizationSkillFileDetail | null> {
    await ensureSkillInventoryCurrent(orgId);
    const skill = await getById(skillId);
    if (!skill || skill.orgId !== orgId) return null;

    const normalizedPath = normalizePortablePath(relativePath || "SKILL.md");
    const fileEntry = skill.fileInventory.find((entry) => entry.path === normalizedPath);
    if (!fileEntry) {
      throw notFound("Skill file not found");
    }

    const source = deriveSkillSourceInfo(skill);
    let content = "";

    if (skill.sourceType === "local_path" || skill.sourceType === "catalog") {
      const absolutePath = resolveLocalSkillFilePath(skill, normalizedPath);
      if (absolutePath) {
        content = await fs.readFile(absolutePath, "utf8");
      } else if (normalizedPath === "SKILL.md") {
        content = skill.markdown;
      } else {
        throw notFound("Skill file not found");
      }
    } else if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
      const metadata = getSkillMeta(skill);
      const owner = asString(metadata.owner);
      const repo = asString(metadata.repo);
      const ref = skill.sourceRef ?? asString(metadata.ref) ?? "main";
      const repoSkillDir = normalizeGitHubSkillDirectory(asString(metadata.repoSkillDir), skill.slug);
      if (!owner || !repo) {
        throw unprocessable("Skill source metadata is incomplete.");
      }
      const repoPath = normalizePortablePath(path.posix.join(repoSkillDir, normalizedPath));
      content = await fetchText(resolveRawGitHubUrl(owner, repo, ref, repoPath));
    } else if (skill.sourceType === "url") {
      if (normalizedPath !== "SKILL.md") {
        throw notFound("This skill source only exposes SKILL.md");
      }
      content = skill.markdown;
    } else {
      throw unprocessable("Unsupported skill source.");
    }

    return {
      skillId: skill.id,
      path: normalizedPath,
      kind: fileEntry.kind,
      content,
      language: inferLanguageFromPath(normalizedPath),
      markdown: isMarkdownPath(normalizedPath),
      editable: source.editable,
    };
  }

  async function createLocalSkill(orgId: string, input: OrganizationSkillCreateRequest): Promise<OrganizationSkill> {
    const slug = normalizeSkillSlug(input.slug ?? input.name) ?? "skill";
    const managedRoot = resolveManagedSkillsRoot(orgId);
    const skillDir = path.resolve(managedRoot, slug);
    const skillFilePath = path.resolve(skillDir, "SKILL.md");

    await fs.mkdir(skillDir, { recursive: true });

    const markdown = buildDraftSkillMarkdown(input);

    await fs.writeFile(skillFilePath, markdown, "utf8");

    const parsed = parseFrontmatterMarkdown(markdown);
    const imported = await upsertImportedSkills(orgId, [{
      key: `organization/${orgId}/${slug}`,
      slug,
      name: asString(parsed.frontmatter.name) ?? input.name,
      description: normalizeSkillDescription(parsed.frontmatter.description) ?? input.description?.trim() ?? null,
      markdown,
      sourceType: "local_path",
      sourceLocator: skillDir,
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "managed_local" },
    }]);

    return imported[0]!;
  }

  async function createAgentPrivateSkill(
    orgId: string,
    agentId: string,
    input: OrganizationSkillCreateRequest,
  ): Promise<AgentSkillEntry> {
    const slug = normalizeSkillSlug(input.slug ?? input.name) ?? "skill";
    const agentWorkspace = await getAgentWorkspaceRow(orgId, agentId);
    const skillsRoot = resolveAgentSkillsDir(orgId, agentWorkspace);
    const skillDir = path.resolve(skillsRoot, slug);
    const relativePath = path.relative(skillsRoot, skillDir);
    if (
      relativePath.startsWith("..")
      || path.isAbsolute(relativePath)
      || relativePath === ""
      || relativePath === "."
    ) {
      throw unprocessable("Invalid agent skill slug.");
    }

    const skillFilePath = path.resolve(skillDir, "SKILL.md");
    const existing = await statPath(skillFilePath);
    if (existing?.isFile()) {
      throw conflict(`Agent skill already exists: ${slug}`);
    }

    await fs.mkdir(skillDir, { recursive: true });
    const markdown = buildDraftSkillMarkdown(input);
    await fs.writeFile(skillFilePath, markdown, "utf8");

    const parsed = parseFrontmatterMarkdown(markdown);
    const description = normalizeSkillDescription(parsed.frontmatter.description) ?? input.description?.trim() ?? null;
    return buildAgentPrivateSkillEntry(orgId, slug, skillDir, description);
  }

  async function updateFile(orgId: string, skillId: string, relativePath: string, content: string): Promise<OrganizationSkillFileDetail> {
    await ensureSkillInventoryCurrent(orgId);
    const skill = await getById(skillId);
    if (!skill || skill.orgId !== orgId) throw notFound("Skill not found");

    const source = deriveSkillSourceInfo(skill);
    if (!source.editable || skill.sourceType !== "local_path") {
      throw unprocessable(source.editableReason ?? "This skill cannot be edited.");
    }

    const normalizedPath = normalizePortablePath(relativePath);
    const absolutePath = resolveLocalSkillFilePath(skill, normalizedPath);
    if (!absolutePath) throw notFound("Skill file not found");

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");

    if (normalizedPath === "SKILL.md") {
      const parsed = parseFrontmatterMarkdown(content);
      await db
        .update(organizationSkills)
        .set({
          name: asString(parsed.frontmatter.name) ?? skill.name,
          description: normalizeSkillDescription(parsed.frontmatter.description) ?? skill.description,
          markdown: content,
          updatedAt: new Date(),
        })
        .where(eq(organizationSkills.id, skill.id));
    } else {
      await db
        .update(organizationSkills)
        .set({ updatedAt: new Date() })
        .where(eq(organizationSkills.id, skill.id));
    }

    const detail = await readFile(orgId, skillId, normalizedPath);
    if (!detail) throw notFound("Skill file not found");
    return detail;
  }

  async function syncWorkspaceFileChange(orgId: string, workspaceFilePath: string, content: string): Promise<void> {
    await ensureSkillInventoryCurrent(orgId);
    const normalizedWorkspaceFilePath = normalizePortablePath(workspaceFilePath);
    if (!normalizedWorkspaceFilePath) return;

    const absoluteTargetPath = path.resolve(resolveOrganizationWorkspaceRoot(orgId), normalizedWorkspaceFilePath);
    const skills = await listFull(orgId);
    const matchingSkill = skills.find((skill) => {
      const skillDir = normalizeSkillDirectory(skill);
      if (!skillDir) return false;
      const absoluteSkillDir = path.resolve(skillDir);
      return absoluteTargetPath === path.resolve(absoluteSkillDir, "SKILL.md")
        || absoluteTargetPath.startsWith(`${absoluteSkillDir}${path.sep}`);
    });
    if (!matchingSkill) return;

    const updatePatch: Partial<typeof organizationSkills.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (absoluteTargetPath === path.resolve(normalizeSkillDirectory(matchingSkill)!, "SKILL.md")) {
      const parsed = parseFrontmatterMarkdown(content);
      updatePatch.markdown = content;
      updatePatch.name = asString(parsed.frontmatter.name) ?? matchingSkill.name;
      updatePatch.description = normalizeSkillDescription(parsed.frontmatter.description) ?? matchingSkill.description;
    }

    await db
      .update(organizationSkills)
      .set(updatePatch)
      .where(eq(organizationSkills.id, matchingSkill.id));
  }

  async function installUpdate(orgId: string, skillId: string): Promise<OrganizationSkill | null> {
    await ensureSkillInventoryCurrent(orgId);
    const skill = await getById(skillId);
    if (!skill || skill.orgId !== orgId) return null;

    const status = await updateStatus(orgId, skillId);
    if (!status?.supported) {
      throw unprocessable(status?.reason ?? "This skill does not support updates.");
    }
    if (!skill.sourceLocator) {
      throw unprocessable("Skill source locator is missing.");
    }

    const result = await readUrlSkillImports(orgId, skill.sourceLocator, skill.slug);
    const matching = result.skills.find((entry) => entry.key === skill.key) ?? result.skills[0] ?? null;
    if (!matching) {
      throw unprocessable(`Skill ${skill.key} could not be re-imported from its source.`);
    }

    const imported = await upsertImportedSkills(orgId, [matching]);
    return imported[0] ?? null;
  }

  async function scanProjectWorkspaces(
    orgId: string,
    input: OrganizationSkillProjectScanRequest = {},
  ): Promise<OrganizationSkillProjectScanResult> {
    await ensureSkillInventoryCurrent(orgId);
    const projectRows = input.projectIds?.length
      ? await projects.listByIds(orgId, input.projectIds)
      : await projects.list(orgId);
    const workspaceFilter = new Set(input.workspaceIds ?? []);
    const skipped: OrganizationSkillProjectScanSkipped[] = [];
    const conflicts: OrganizationSkillProjectScanConflict[] = [];
    const warnings: string[] = [];
    const imported: OrganizationSkill[] = [];
    const updated: OrganizationSkill[] = [];
    const availableSkills = await listFull(orgId);
    const acceptedSkills = [...availableSkills];
    const acceptedByKey = new Map(acceptedSkills.map((skill) => [skill.key, skill]));
    const scanTargets: ProjectSkillScanTarget[] = [];
    const scannedProjectIds = new Set<string>();
    let discovered = 0;

    const trackWarning = (message: string) => {
      warnings.push(message);
      return message;
    };
    const upsertAcceptedSkill = (skill: OrganizationSkill) => {
      const nextIndex = acceptedSkills.findIndex((entry) => entry.id === skill.id || entry.key === skill.key);
      if (nextIndex >= 0) acceptedSkills[nextIndex] = skill;
      else acceptedSkills.push(skill);
      acceptedByKey.set(skill.key, skill);
    };

    for (const project of projectRows) {
      for (const workspace of project.workspaces) {
        if (workspaceFilter.size > 0 && !workspaceFilter.has(workspace.id)) continue;
        const workspaceCwd = asString(workspace.cwd);
        if (!workspaceCwd) {
          skipped.push({
            projectId: project.id,
            projectName: project.name,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            path: null,
            reason: trackWarning(`Skipped ${project.name} / ${workspace.name}: no local workspace path is configured.`),
          });
          continue;
        }

        const workspaceStat = await statPath(workspaceCwd);
        if (!workspaceStat?.isDirectory()) {
          skipped.push({
            projectId: project.id,
            projectName: project.name,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            path: workspaceCwd,
            reason: trackWarning(`Skipped ${project.name} / ${workspace.name}: local workspace path is not available at ${workspaceCwd}.`),
          });
          continue;
        }

        scanTargets.push({
          projectId: project.id,
          projectName: project.name,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceCwd,
        });
      }
    }

    for (const target of scanTargets) {
      scannedProjectIds.add(target.projectId);
      const directories = await discoverProjectWorkspaceSkillDirectories(target);

      for (const directory of directories) {
        discovered += 1;

        let nextSkill: ImportedSkill;
        try {
          nextSkill = await readLocalSkillImportFromDirectory(orgId, directory.skillDir, {
            inventoryMode: directory.inventoryMode,
            metadata: {
              sourceKind: "project_scan",
              projectId: target.projectId,
              projectName: target.projectName,
              workspaceId: target.workspaceId,
              workspaceName: target.workspaceName,
              workspaceCwd: target.workspaceCwd,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          skipped.push({
            projectId: target.projectId,
            projectName: target.projectName,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            path: directory.skillDir,
            reason: trackWarning(`Skipped ${directory.skillDir}: ${message}`),
          });
          continue;
        }

        const normalizedSourceDir = normalizeSourceLocatorDirectory(nextSkill.sourceLocator);
        const existingByKey = acceptedByKey.get(nextSkill.key) ?? null;
        if (existingByKey) {
          const existingSourceDir = normalizeSkillDirectory(existingByKey);
          if (
            existingByKey.sourceType !== "local_path"
            || !existingSourceDir
            || !normalizedSourceDir
            || existingSourceDir !== normalizedSourceDir
          ) {
            conflicts.push({
              slug: nextSkill.slug,
              key: nextSkill.key,
              projectId: target.projectId,
              projectName: target.projectName,
              workspaceId: target.workspaceId,
              workspaceName: target.workspaceName,
              path: directory.skillDir,
              existingSkillId: existingByKey.id,
              existingSkillKey: existingByKey.key,
              existingSourceLocator: existingByKey.sourceLocator,
              reason: `Skill key ${nextSkill.key} already points at ${existingByKey.sourceLocator ?? "another source"}.`,
            });
            continue;
          }

          const persisted = (await upsertImportedSkills(orgId, [nextSkill]))[0];
          if (!persisted) continue;
          updated.push(persisted);
          upsertAcceptedSkill(persisted);
          continue;
        }

        const slugConflict = acceptedSkills.find((skill) => {
          if (skill.slug !== nextSkill.slug) return false;
          return normalizeSkillDirectory(skill) !== normalizedSourceDir;
        });
        if (slugConflict) {
          conflicts.push({
            slug: nextSkill.slug,
            key: nextSkill.key,
            projectId: target.projectId,
            projectName: target.projectName,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            path: directory.skillDir,
            existingSkillId: slugConflict.id,
            existingSkillKey: slugConflict.key,
            existingSourceLocator: slugConflict.sourceLocator,
            reason: `Slug ${nextSkill.slug} is already in use by ${slugConflict.sourceLocator ?? slugConflict.key}.`,
          });
          continue;
        }

        const persisted = (await upsertImportedSkills(orgId, [nextSkill]))[0];
        if (!persisted) continue;
        imported.push(persisted);
        upsertAcceptedSkill(persisted);
      }
    }

    return {
      scannedProjects: scannedProjectIds.size,
      scannedWorkspaces: scanTargets.length,
      discovered,
      imported,
      updated,
      skipped,
      conflicts,
      warnings,
    };
  }

  async function scanLocalSkillRoots(
    orgId: string,
    input: OrganizationSkillLocalScanRequest = {},
  ): Promise<OrganizationSkillLocalScanResult> {
    await ensureSkillInventoryCurrent(orgId);

    const requestedRoots = input.roots?.length
      ? input.roots
      : [path.join(os.homedir(), ".agents")];
    const roots = Array.from(
      new Set(
        requestedRoots
          .map((root) => root.trim())
          .filter(Boolean)
          .map((root) => path.resolve(root)),
      ),
    );

    const skipped: OrganizationSkillLocalScanSkipped[] = [];
    const conflicts: OrganizationSkillLocalScanConflict[] = [];
    const warnings: string[] = [];
    const imported: OrganizationSkill[] = [];
    const updated: OrganizationSkill[] = [];
    const availableSkills = await listFull(orgId);
    const acceptedSkills = [...availableSkills];
    const acceptedByKey = new Map(acceptedSkills.map((skill) => [skill.key, skill]));
    let discovered = 0;

    const trackWarning = (message: string) => {
      warnings.push(message);
      return message;
    };
    const upsertAcceptedSkill = (skill: OrganizationSkill) => {
      const nextIndex = acceptedSkills.findIndex((entry) => entry.id === skill.id || entry.key === skill.key);
      if (nextIndex >= 0) acceptedSkills[nextIndex] = skill;
      else acceptedSkills.push(skill);
      acceptedByKey.set(skill.key, skill);
    };

    for (const root of roots) {
      const rootStat = await statPath(root);
      if (!rootStat?.isDirectory()) {
        skipped.push({
          root,
          path: null,
          reason: trackWarning(`Skipped ${root}: local skill root is not available.`),
        });
        continue;
      }

      let discoveredSkills: ImportedSkill[];
      try {
        discoveredSkills = await readLocalSkillImports(orgId, root);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        skipped.push({
          root,
          path: root,
          reason: trackWarning(`Skipped ${root}: ${message}`),
        });
        continue;
      }

      discovered += discoveredSkills.length;

      for (const nextSkill of discoveredSkills) {
        nextSkill.metadata = {
          ...(nextSkill.metadata ?? {}),
          sourceKind: "local_scan",
          sourceRoot: root,
        };

        const normalizedSourceDir = normalizeSourceLocatorDirectory(nextSkill.sourceLocator);
        const existingByKey = acceptedByKey.get(nextSkill.key) ?? null;
        if (existingByKey) {
          const existingSourceDir = normalizeSkillDirectory(existingByKey);
          if (
            existingByKey.sourceType !== "local_path"
            || !existingSourceDir
            || !normalizedSourceDir
            || existingSourceDir !== normalizedSourceDir
          ) {
            conflicts.push({
              root,
              slug: nextSkill.slug,
              key: nextSkill.key,
              path: nextSkill.sourceLocator ?? root,
              existingSkillId: existingByKey.id,
              existingSkillKey: existingByKey.key,
              existingSourceLocator: existingByKey.sourceLocator,
              reason: `Skill key ${nextSkill.key} already points at ${existingByKey.sourceLocator ?? "another source"}.`,
            });
            continue;
          }

          const persisted = (await upsertImportedSkills(orgId, [nextSkill]))[0];
          if (!persisted) continue;
          updated.push(persisted);
          upsertAcceptedSkill(persisted);
          continue;
        }

        const slugConflict = acceptedSkills.find((skill) => {
          if (skill.slug !== nextSkill.slug) return false;
          return normalizeSkillDirectory(skill) !== normalizedSourceDir;
        });
        if (slugConflict) {
          conflicts.push({
            root,
            slug: nextSkill.slug,
            key: nextSkill.key,
            path: nextSkill.sourceLocator ?? root,
            existingSkillId: slugConflict.id,
            existingSkillKey: slugConflict.key,
            existingSourceLocator: slugConflict.sourceLocator,
            reason: `Slug ${nextSkill.slug} is already in use by ${slugConflict.sourceLocator ?? slugConflict.key}.`,
          });
          continue;
        }

        const persisted = (await upsertImportedSkills(orgId, [nextSkill]))[0];
        if (!persisted) continue;
        imported.push(persisted);
        upsertAcceptedSkill(persisted);
      }
    }

    return {
      scannedRoots: roots.length,
      discovered,
      imported,
      updated,
      skipped,
      conflicts,
      warnings,
    };
  }

  async function materializeCatalogSkillFiles(
    orgId: string,
    skill: ImportedSkill,
    normalizedFiles: Record<string, string>,
  ) {
    const packageDir = skill.packageDir ? normalizePortablePath(skill.packageDir) : null;
    if (!packageDir) return null;
    const catalogRoot = path.resolve(resolveManagedSkillsRoot(orgId), "__catalog__");
    const skillDir = path.resolve(catalogRoot, buildSkillRuntimeName(skill.key, skill.slug));
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    for (const entry of skill.fileInventory) {
      const sourcePath = entry.path === "SKILL.md"
        ? `${packageDir}/SKILL.md`
        : `${packageDir}/${entry.path}`;
      const content = normalizedFiles[sourcePath];
      if (typeof content !== "string") continue;
      const targetPath = path.resolve(skillDir, entry.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
    }

    return skillDir;
  }

  async function materializeRuntimeSkillFiles(orgId: string, skill: OrganizationSkill) {
    const runtimeRoot = path.resolve(resolveManagedSkillsRoot(orgId), "__runtime__");
    const skillDir = path.resolve(runtimeRoot, buildSkillRuntimeName(skill.key, skill.slug));
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    for (const entry of skill.fileInventory) {
      const detail = await readFile(orgId, skill.id, entry.path).catch(() => null);
      if (!detail) continue;
      const targetPath = path.resolve(skillDir, entry.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, detail.content, "utf8");
    }

    return skillDir;
  }

  function resolveRuntimeSkillMaterializedPath(orgId: string, skill: OrganizationSkill) {
    const runtimeRoot = path.resolve(resolveManagedSkillsRoot(orgId), "__runtime__");
    return path.resolve(runtimeRoot, buildSkillRuntimeName(skill.key, skill.slug));
  }

  async function listRuntimeSkillEntries(
    orgId: string,
    options: RuntimeSkillEntryOptions = {},
  ): Promise<RudderSkillEntry[]> {
    const skills = await listFull(orgId);

    const out: RudderSkillEntry[] = [];
    for (const skill of skills) {
      let source = normalizeSkillDirectory(skill);
      if (!source) {
        source = options.materializeMissing === false
          ? resolveRuntimeSkillMaterializedPath(orgId, skill)
          : await materializeRuntimeSkillFiles(orgId, skill).catch(() => null);
      }
      if (!source) continue;

      out.push({
        key: skill.key,
        runtimeName: buildSkillRuntimeName(skill.key, skill.slug),
        source,
        name: skill.name,
        description: skill.description,
      });
    }

    out.sort((left, right) => left.key.localeCompare(right.key));
    return out;
  }

  async function importPackageFiles(
    orgId: string,
    files: Record<string, string>,
    options?: {
      onConflict?: PackageSkillConflictStrategy;
    },
  ): Promise<ImportPackageSkillResult[]> {
    await ensureSkillInventoryCurrent(orgId);
    const normalizedFiles = normalizePackageFileMap(files);
    const importedSkills = readInlineSkillImports(orgId, normalizedFiles);
    if (importedSkills.length === 0) return [];

    for (const skill of importedSkills) {
      if (skill.sourceType !== "catalog") continue;
      const materializedDir = await materializeCatalogSkillFiles(orgId, skill, normalizedFiles);
      if (materializedDir) {
        skill.sourceLocator = materializedDir;
      }
    }

    const conflictStrategy = options?.onConflict ?? "replace";
    const existingSkills = await listFull(orgId);
    const existingByKey = new Map(existingSkills.map((skill) => [skill.key, skill]));
    const existingBySlug = new Map(
      existingSkills.map((skill) => [normalizeSkillSlug(skill.slug) ?? skill.slug, skill]),
    );
    const usedSlugs = new Set(existingBySlug.keys());
    const usedKeys = new Set(existingByKey.keys());

    const toPersist: ImportedSkill[] = [];
    const prepared: Array<{
      skill: ImportedSkill;
      originalKey: string;
      originalSlug: string;
      existingBefore: OrganizationSkill | null;
      actionHint: "created" | "updated";
      reason: string | null;
    }> = [];
    const out: ImportPackageSkillResult[] = [];

    for (const importedSkill of importedSkills) {
      const originalKey = importedSkill.key;
      const originalSlug = importedSkill.slug;
      const normalizedSlug = normalizeSkillSlug(importedSkill.slug) ?? importedSkill.slug;
      const existingByIncomingKey = existingByKey.get(importedSkill.key) ?? null;
      const existingByIncomingSlug = existingBySlug.get(normalizedSlug) ?? null;
      const conflict = existingByIncomingKey ?? existingByIncomingSlug;

      if (!conflict || conflictStrategy === "replace") {
        toPersist.push(importedSkill);
        prepared.push({
          skill: importedSkill,
          originalKey,
          originalSlug,
          existingBefore: existingByIncomingKey,
          actionHint: existingByIncomingKey ? "updated" : "created",
          reason: existingByIncomingKey ? "Existing skill key matched; replace strategy." : null,
        });
        usedSlugs.add(normalizedSlug);
        usedKeys.add(importedSkill.key);
        continue;
      }

      if (conflictStrategy === "skip") {
        out.push({
          skill: conflict,
          action: "skipped",
          originalKey,
          originalSlug,
          requestedRefs: Array.from(new Set([originalKey, originalSlug])),
          reason: "Existing skill matched; skip strategy.",
        });
        continue;
      }

      const renamedSlug = uniqueSkillSlug(normalizedSlug || "skill", usedSlugs);
      const renamedKey = uniqueImportedSkillKey(orgId, renamedSlug, usedKeys);
      const renamedSkill: ImportedSkill = {
        ...importedSkill,
        slug: renamedSlug,
        key: renamedKey,
        metadata: {
          ...(importedSkill.metadata ?? {}),
          skillKey: renamedKey,
          importedFromSkillKey: originalKey,
          importedFromSkillSlug: originalSlug,
        },
      };
      toPersist.push(renamedSkill);
      prepared.push({
        skill: renamedSkill,
        originalKey,
        originalSlug,
        existingBefore: null,
        actionHint: "created",
        reason: `Existing skill matched; renamed to ${renamedSlug}.`,
      });
      usedSlugs.add(renamedSlug);
      usedKeys.add(renamedKey);
    }

    if (toPersist.length === 0) return out;

    const persisted = await upsertImportedSkills(orgId, toPersist);
    for (let index = 0; index < prepared.length; index += 1) {
      const persistedSkill = persisted[index];
      const preparedSkill = prepared[index];
      if (!persistedSkill || !preparedSkill) continue;
      out.push({
        skill: persistedSkill,
        action: preparedSkill.actionHint,
        originalKey: preparedSkill.originalKey,
        originalSlug: preparedSkill.originalSlug,
        requestedRefs: Array.from(new Set([preparedSkill.originalKey, preparedSkill.originalSlug])),
        reason: preparedSkill.reason,
      });
    }

    return out;
  }

  async function upsertImportedSkills(orgId: string, imported: ImportedSkill[]): Promise<OrganizationSkill[]> {
    const out: OrganizationSkill[] = [];
    for (const skill of imported) {
      const existing = await getByKey(orgId, skill.key);
      const existingMeta = existing ? getSkillMeta(existing) : {};
      const incomingMeta = skill.metadata && isPlainRecord(skill.metadata) ? skill.metadata : {};
      const incomingOwner = asString(incomingMeta.owner);
      const incomingRepo = asString(incomingMeta.repo);
      const incomingKind = asString(incomingMeta.sourceKind);
      if (
        existing
        && isBundledRudderSourceKind(asString(existingMeta.sourceKind))
        && incomingKind === "github"
        && incomingOwner === "rudder"
        && incomingRepo === "rudder"
      ) {
        out.push(existing);
        continue;
      }

      const metadata = {
        ...(skill.metadata ?? {}),
        skillKey: skill.key,
      };
      const values = {
        orgId,
        key: skill.key,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        markdown: skill.markdown,
        sourceType: skill.sourceType,
        sourceLocator: skill.sourceLocator,
        sourceRef: skill.sourceRef,
        trustLevel: skill.trustLevel,
        compatibility: skill.compatibility,
        fileInventory: serializeFileInventory(skill.fileInventory),
        metadata,
        updatedAt: new Date(),
      };
      const row = existing
        ? await db
          .update(organizationSkills)
          .set(values)
          .where(eq(organizationSkills.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null)
        : await db
          .insert(organizationSkills)
          .values(values)
          .returning()
          .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Failed to persist organization skill");
      out.push(toCompanySkill(row));
    }
    return out;
  }

  async function importFromSource(orgId: string, source: string): Promise<OrganizationSkillImportResult> {
    await ensureSkillInventoryCurrent(orgId);
    const parsed = parseSkillImportSourceInput(source);
    const local = !/^https?:\/\//i.test(parsed.resolvedSource);
    const { skills, warnings } = local
      ? {
        skills: (await readLocalSkillImports(orgId, parsed.resolvedSource))
          .filter((skill) => !parsed.requestedSkillSlug || skill.slug === parsed.requestedSkillSlug),
        warnings: parsed.warnings,
      }
      : await readUrlSkillImports(orgId, parsed.resolvedSource, parsed.requestedSkillSlug)
        .then((result) => ({
          skills: result.skills,
          warnings: [...parsed.warnings, ...result.warnings],
        }));
    const filteredSkills = parsed.requestedSkillSlug
      ? skills.filter((skill) => skill.slug === parsed.requestedSkillSlug)
      : skills;
    if (filteredSkills.length === 0) {
      throw unprocessable(
        parsed.requestedSkillSlug
          ? `Skill ${parsed.requestedSkillSlug} was not found in the provided source.`
          : "No skills were found in the provided source.",
      );
    }
    // Override sourceType/sourceLocator for skills imported via skills.sh
    if (parsed.originalSkillsShUrl) {
      for (const skill of filteredSkills) {
        skill.sourceType = "skills_sh";
        skill.sourceLocator = parsed.originalSkillsShUrl;
        if (skill.metadata) {
          (skill.metadata as Record<string, unknown>).sourceKind = "skills_sh";
        }
        skill.key = deriveCanonicalSkillKey(orgId, skill);
      }
    }
    const imported = await upsertImportedSkills(orgId, filteredSkills);
    return { imported, warnings };
  }

  async function deleteSkill(orgId: string, skillId: string): Promise<OrganizationSkill | null> {
    const row = await db
      .select()
      .from(organizationSkills)
      .where(and(eq(organizationSkills.id, skillId), eq(organizationSkills.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;

    const skill = toCompanySkill(row);

    // Remove from any agent enabled skills that reference this skill
    await enabledSkills.removeSkillKeys(orgId, [skill.key]);

    // Delete DB row
    await db
      .delete(organizationSkills)
      .where(eq(organizationSkills.id, skillId));

    // Clean up materialized runtime files
    await fs.rm(resolveRuntimeSkillMaterializedPath(orgId, skill), { recursive: true, force: true });

    return skill;
  }

  return {
    list,
    listFull,
    getById,
    getByKey,
    resolveRequestedSkillKeys: async (orgId: string, requestedReferences: string[]) => {
      const skills = await listFull(orgId);
      return resolveRequestedSkillKeysOrThrow(skills, requestedReferences, orgId);
    },
    detail,
    updateStatus,
    readFile,
    updateFile,
    syncWorkspaceFileChange,
    createLocalSkill,
    createAgentPrivateSkill,
    deleteSkill,
    importFromSource,
    scanProjectWorkspaces,
    scanLocalSkillRoots,
    importPackageFiles,
    installUpdate,
    listRuntimeSkillEntries,
    mergeWithRequiredSkillKeys: async (
      orgId: string,
      skillKeys: string[],
    ) => {
      const skills = await listFull(orgId);
      return sortUniqueSelectionRefs(
        skillKeys.flatMap((skillKey) => {
          const normalized = normalizeSelectionRef(skillKey, skills, orgId, "claude_local");
          if (!normalized) return [];
          return parseSelectionKey(normalized).sourceClass === "bundled" ? [] : [normalized];
        }),
      );
    },
    getEnabledSkillKeysForAgent: async (
      orgId: string,
      agent: EnabledSkillsAgentRef,
    ) => getEnabledSkillSelectionRefsForAgent(orgId, agent),
    buildAgentSkillSnapshot,
    resolveDesiredSkillSelectionForAgent,
    listRealizedSkillEntriesForAgent,
    replaceEnabledSkillKeysForAgent: async (
      orgId: string,
      agentId: string,
      skillKeys: string[],
    ) => enabledSkills.replaceKeys(orgId, agentId, sortUniqueSelectionRefs(skillKeys)),
  };
}
