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

export interface OrganizationPortabilityExportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: {
    stage: OrganizationExportJobStage;
    message: string;
    completed: number;
    total: number;
    fileCount?: number | null;
  }) => void;
}

/** Build OrgNode tree from manifest agent list (slug + reportsToSlug). */
export function buildOrgTreeFromManifest(agents: OrganizationPortabilityManifest["agents"]): OrgNode[] {
  const ROLE_LABELS: Record<string, string> = {
    ceo: "Chief Executive", cto: "Technology", cmo: "Marketing",
    cfo: "Finance", coo: "Operations", vp: "VP", manager: "Manager",
    engineer: "Engineer", agent: "Agent",
  };
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const childrenOf = new Map<string | null, typeof agents>();
  for (const a of agents) {
    const parent = a.reportsToSlug ?? null;
    const list = childrenOf.get(parent) ?? [];
    list.push(a);
    childrenOf.set(parent, list);
  }
  const build = (parentSlug: string | null): OrgNode[] => {
    const members = childrenOf.get(parentSlug) ?? [];
    return members.map((m) => ({
      id: m.slug,
      name: m.name,
      role: ROLE_LABELS[m.role] ?? m.role,
      status: "active",
      reports: build(m.slug),
    }));
  };
  // Find roots: agents whose reportsToSlug is null or points to a non-existent slug
  const roots = agents.filter((a) => !a.reportsToSlug || !bySlug.has(a.reportsToSlug));
  const rootSlugs = new Set(roots.map((r) => r.slug));
  // Start from null parent, but also include orphans
  const tree = build(null);
  for (const root of roots) {
    if (root.reportsToSlug && !bySlug.has(root.reportsToSlug)) {
      // Orphan root (parent slug doesn't exist)
      tree.push({
        id: root.slug,
        name: root.name,
        role: ROLE_LABELS[root.role] ?? root.role,
        status: "active",
        reports: build(root.slug),
      });
    }
  }
  return tree;
}

export const DEFAULT_INCLUDE: OrganizationPortabilityInclude = {
  organization: true,
  agents: true,
  projects: false,
  issues: false,
  skills: false,
};

export const DEFAULT_COLLISION_STRATEGY: OrganizationPortabilityCollisionStrategy = "rename";
export const PORTABLE_AGENT_ENTRY_FILE = "AGENTS.md";
export const execFileAsync = promisify(execFile);
export let bundledSkillsCommitPromise: Promise<string | null> | null = null;

export function resolveImportMode(options?: ImportBehaviorOptions): ImportMode {
  return options?.mode ?? "board_full";
}

export function resolveSkillConflictStrategy(mode: ImportMode, collisionStrategy: OrganizationPortabilityCollisionStrategy) {
  if (mode === "board_full") return "replace" as const;
  return collisionStrategy === "skip" ? "skip" as const : "rename" as const;
}

export function normalizePortablePath(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function classifyPortableFileKind(pathValue: string): OrganizationPortabilityExportPreviewResult["fileInventory"][number]["kind"] {
  const normalized = normalizePortablePath(pathValue);
  if (normalized === "ORGANIZATION.md") return "organization";
  if (normalized === ".rudder.yaml" || normalized === ".rudder.yml") return "extension";
  if (normalized === "README.md") return "readme";
  if (normalized.startsWith("agents/")) return "agent";
  if (normalized.startsWith("skills/") || normalized.startsWith(".agents/skills/")) return "skill";
  if (normalized.startsWith("projects/")) return "project";
  if (normalized.startsWith("tasks/")) return "issue";
  return "other";
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

export function readSkillKey(frontmatter: Record<string, unknown>) {
  const metadata = isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : null;
  const rudder = isPlainRecord(metadata?.rudder) ? metadata?.rudder as Record<string, unknown> : null;
  return normalizeSkillKey(
    asString(frontmatter.key)
    ?? asString(frontmatter.skillKey)
    ?? asString(metadata?.skillKey)
    ?? asString(metadata?.canonicalKey)
    ?? asString(metadata?.rudderSkillKey)
    ?? asString(rudder?.skillKey)
    ?? asString(rudder?.key),
  );
}

export function deriveManifestSkillKey(
  frontmatter: Record<string, unknown>,
  fallbackSlug: string,
  metadata: Record<string, unknown> | null,
  sourceType: string,
  sourceLocator: string | null,
) {
  const slug = normalizeSkillSlug(asString(frontmatter.slug) ?? fallbackSlug) ?? "skill";
  const sourceKind = asString(metadata?.sourceKind);
  const explicit = readSkillKey(frontmatter);
  if (explicit) {
    if (isBundledRudderSourceKind(sourceKind)) {
      return toBundledRudderSkillKey(getBundledRudderSkillSlug(explicit) ?? slug) ?? explicit;
    }
    return explicit;
  }
  const owner = normalizeSkillSlug(asString(metadata?.owner));
  const repo = normalizeSkillSlug(asString(metadata?.repo));
  if ((sourceType === "github" || sourceType === "skills_sh" || sourceKind === "github" || sourceKind === "skills_sh") && owner && repo) {
    return `${owner}/${repo}/${slug}`;
  }
  if (isBundledRudderSourceKind(sourceKind)) {
    return toBundledRudderSkillKey(slug) ?? `rudder/${slug}`;
  }
  if (sourceType === "url" || sourceKind === "url") {
    try {
      const host = normalizeSkillSlug(sourceLocator ? new URL(sourceLocator).host : null) ?? "url";
      return `url/${host}/${slug}`;
    } catch {
      return `url/unknown/${slug}`;
    }
  }
  return slug;
}

export function hashSkillValue(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function normalizeExportPathSegment(value: string | null | undefined, preserveCase = false) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return null;
  return preserveCase ? normalized : normalized.toLowerCase();
}

export function readSkillSourceKind(skill: OrganizationSkill) {
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  return asString(metadata?.sourceKind);
}

export function isBundledRudderSourceKind(value: string | null | undefined) {
  return value === "rudder_bundled" || value === "paperclip_bundled";
}

export function deriveLocalExportNamespace(skill: OrganizationSkill, slug: string) {
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  const candidates = [
    asString(metadata?.projectName),
    asString(metadata?.workspaceName),
  ];

  if (skill.sourceLocator) {
    const basename = path.basename(skill.sourceLocator);
    candidates.push(basename.toLowerCase() === "skill.md" ? path.basename(path.dirname(skill.sourceLocator)) : basename);
  }

  for (const value of candidates) {
    const normalized = normalizeSkillSlug(value);
    if (normalized && normalized !== slug) return normalized;
  }

  return null;
}

export function derivePrimarySkillExportDir(
  skill: OrganizationSkill,
  slug: string,
  organizationIssuePrefix: string | null | undefined,
) {
  const sourceKind = readSkillSourceKind(skill);
  const canonicalKey = isBundledRudderSourceKind(sourceKind)
    ? toBundledRudderSkillKey(getBundledRudderSkillSlug(skill.key) ?? slug) ?? skill.key
    : skill.key;
  const normalizedKey = normalizeSkillKey(canonicalKey);
  const keySegments = normalizedKey?.split("/") ?? [];
  const primaryNamespace = keySegments[0] ?? null;

  if (primaryNamespace === "organization") {
    const companySegment = normalizeExportPathSegment(organizationIssuePrefix, true)
      ?? normalizeExportPathSegment(keySegments[1], true)
      ?? "organization";
    return `skills/organization/${companySegment}/${slug}`;
  }

  if (primaryNamespace === "local") {
    const localNamespace = deriveLocalExportNamespace(skill, slug);
    return localNamespace
      ? `skills/local/${localNamespace}/${slug}`
      : `skills/local/${slug}`;
  }

  if (primaryNamespace === "url") {
    let derivedHost: string | null = keySegments[1] ?? null;
    if (!derivedHost) {
      try {
        derivedHost = normalizeSkillSlug(skill.sourceLocator ? new URL(skill.sourceLocator).host : null);
      } catch {
        derivedHost = null;
      }
    }
    const host = derivedHost ?? "url";
    return `skills/url/${host}/${slug}`;
  }

  if (keySegments.length > 1) {
    return `skills/${keySegments.join("/")}`;
  }

  return `skills/${slug}`;
}

export function appendSkillExportDirSuffix(packageDir: string, suffix: string) {
  const lastSeparator = packageDir.lastIndexOf("/");
  if (lastSeparator < 0) return `${packageDir}--${suffix}`;
  return `${packageDir.slice(0, lastSeparator + 1)}${packageDir.slice(lastSeparator + 1)}--${suffix}`;
}

export function deriveSkillExportDirCandidates(
  skill: OrganizationSkill,
  slug: string,
  organizationIssuePrefix: string | null | undefined,
) {
  const primaryDir = derivePrimarySkillExportDir(skill, slug, organizationIssuePrefix);
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  const sourceKind = readSkillSourceKind(skill);
  const suffixes = new Set<string>();
  const pushSuffix = (value: string | null | undefined, preserveCase = false) => {
    const normalized = normalizeExportPathSegment(value, preserveCase);
    if (normalized && normalized !== slug) {
      suffixes.add(normalized);
    }
  };

  if (isBundledRudderSourceKind(sourceKind)) {
    pushSuffix("rudder");
  }

  if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
    pushSuffix(asString(metadata?.repo));
    pushSuffix(asString(metadata?.owner));
    pushSuffix(skill.sourceType === "skills_sh" ? "skills_sh" : "github");
  } else if (skill.sourceType === "url") {
    try {
      pushSuffix(skill.sourceLocator ? new URL(skill.sourceLocator).host : null);
    } catch {
      // Ignore URL parse failures and fall through to generic suffixes.
    }
    pushSuffix("url");
  } else if (skill.sourceType === "local_path") {
    pushSuffix(asString(metadata?.projectName));
    pushSuffix(asString(metadata?.workspaceName));
    pushSuffix(deriveLocalExportNamespace(skill, slug));
    if (sourceKind === "managed_local") pushSuffix("organization");
    if (sourceKind === "project_scan") pushSuffix("project");
    pushSuffix("local");
  } else {
    pushSuffix(sourceKind);
    pushSuffix("skill");
  }

  return [primaryDir, ...Array.from(suffixes, (suffix) => appendSkillExportDirSuffix(primaryDir, suffix))];
}

export function buildSkillExportDirMap(skills: OrganizationSkill[], organizationIssuePrefix: string | null | undefined) {
  const usedDirs = new Set<string>();
  const keyToDir = new Map<string, string>();
  const orderedSkills = [...skills].sort((left, right) => left.key.localeCompare(right.key));
  for (const skill of orderedSkills) {
    const slug = normalizeSkillSlug(skill.slug) ?? "skill";
    const candidates = deriveSkillExportDirCandidates(skill, slug, organizationIssuePrefix);

    let packageDir = candidates.find((candidate) => !usedDirs.has(candidate)) ?? null;
    if (!packageDir) {
      packageDir = appendSkillExportDirSuffix(candidates[0] ?? `skills/${slug}`, hashSkillValue(skill.key));
      while (usedDirs.has(packageDir)) {
        packageDir = appendSkillExportDirSuffix(
          candidates[0] ?? `skills/${slug}`,
          hashSkillValue(`${skill.key}:${packageDir}`),
        );
      }
    }

    usedDirs.add(packageDir);
    keyToDir.set(skill.key, packageDir);
  }

  return keyToDir;
}

export function isSensitiveEnvKey(key: string) {
  const normalized = key.trim().toLowerCase();
  return (
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized.endsWith("-token") ||
    normalized.includes("apikey") ||
    normalized.includes("api_key") ||
    normalized.includes("api-key") ||
    normalized.includes("access_token") ||
    normalized.includes("access-token") ||
    normalized.includes("auth") ||
    normalized.includes("auth_token") ||
    normalized.includes("auth-token") ||
    normalized.includes("authorization") ||
    normalized.includes("bearer") ||
    normalized.includes("secret") ||
    normalized.includes("passwd") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("jwt") ||
    normalized.includes("privatekey") ||
    normalized.includes("private_key") ||
    normalized.includes("private-key") ||
    normalized.includes("cookie") ||
    normalized.includes("connectionstring")
  );
}

export type ResolvedSource = {
  manifest: OrganizationPortabilityManifest;
  files: Record<string, OrganizationPortabilityFileEntry>;
  warnings: string[];
};

export type MarkdownDoc = {
  frontmatter: Record<string, unknown>;
  body: string;
};

export type CompanyPackageIncludeEntry = {
  path: string;
};

export type PaperclipExtensionDoc = {
  schema?: string;
  organization?: Record<string, unknown> | null;
  agents?: Record<string, Record<string, unknown>> | null;
  projects?: Record<string, Record<string, unknown>> | null;
  tasks?: Record<string, Record<string, unknown>> | null;
  automations?: Record<string, Record<string, unknown>> | null;
};

export type ProjectLike = {
  id: string;
  name: string;
  description: string | null;
  leadAgentId: string | null;
  targetDate: string | null;
  color: string | null;
  status: string;
  executionWorkspacePolicy: Record<string, unknown> | null;
  workspaces?: Array<{
    id: string;
    name: string;
    sourceType: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    defaultRef: string | null;
    visibility: string;
    setupCommand: string | null;
    cleanupCommand: string | null;
    metadata?: Record<string, unknown> | null;
    isPrimary: boolean;
  }>;
  metadata?: Record<string, unknown> | null;
};

export type IssueLike = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  projectId: string | null;
  projectWorkspaceId: string | null;
  assigneeAgentId: string | null;
  status: string;
  priority: string;
  labelIds?: string[];
  billingCode: string | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
  assigneeAgentRuntimeOverrides: Record<string, unknown> | null;
};

export type AutomationLike = NonNullable<Awaited<ReturnType<ReturnType<typeof automationService>["getDetail"]>>>;

export type ImportPlanInternal = {
  preview: OrganizationPortabilityPreviewResult;
  source: ResolvedSource;
  include: OrganizationPortabilityInclude;
  collisionStrategy: OrganizationPortabilityCollisionStrategy;
  selectedAgents: OrganizationPortabilityAgentManifestEntry[];
};

export type ImportMode = "board_full" | "agent_safe";

export type ImportBehaviorOptions = {
  mode?: ImportMode;
  sourceOrganizationId?: string | null;
};

export type AgentLike = {
  id: string;
  name: string;
  agentRuntimeConfig: Record<string, unknown>;
};

export type EnvInputRecord = {
  kind: "secret" | "plain";
  requirement: "required" | "optional";
  default?: string | null;
  description?: string | null;
  portability?: "portable" | "system_dependent";
};

export const COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
};

export const COMPANY_LOGO_FILE_NAME = "organization-logo";

export const RUNTIME_DEFAULT_RULES: Array<{ path: string[]; value: unknown }> = [
  { path: ["heartbeat", "cooldownSec"], value: 10 },
  { path: ["heartbeat", "intervalSec"], value: 3600 },
  { path: ["heartbeat", "wakeOnOnDemand"], value: true },
  { path: ["heartbeat", "wakeOnAssignment"], value: true },
  { path: ["heartbeat", "wakeOnAutomation"], value: true },
  { path: ["heartbeat", "wakeOnDemand"], value: true },
  { path: ["heartbeat", "preflightEnabled"], value: true },
  { path: ["heartbeat", "maxConcurrentRuns"], value: 3 },
];

export const ADAPTER_DEFAULT_RULES_BY_TYPE: Record<string, Array<{ path: string[]; value: unknown }>> = {
  codex_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  gemini_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  opencode_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  cursor: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  claude_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
    { path: ["maxTurnsPerRun"], value: 300 },
  ],
  openclaw_gateway: [
    { path: ["timeoutSec"], value: 120 },
    { path: ["waitTimeoutMs"], value: 120000 },
    { path: ["sessionKeyStrategy"], value: "fixed" },
    { path: ["sessionKey"], value: "rudder" },
    { path: ["role"], value: "operator" },
    { path: ["scopes"], value: ["operator.admin"] },
  ],
};

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function normalizeAutomationTriggerExtension(value: unknown): OrganizationPortabilityIssueAutomationTriggerManifestEntry | null {
  if (!isPlainRecord(value)) return null;
  const kind = asString(value.kind);
  if (!kind) return null;
  return {
    kind,
    label: asString(value.label),
    enabled: asBoolean(value.enabled) ?? true,
    cronExpression: asString(value.cronExpression),
    timezone: asString(value.timezone),
    signingMode: asString(value.signingMode),
    replayWindowSec: asInteger(value.replayWindowSec),
  };
}

export function normalizeAutomationExtension(value: unknown): OrganizationPortabilityIssueAutomationManifestEntry | null {
  if (!isPlainRecord(value)) return null;
  const triggers = Array.isArray(value.triggers)
    ? value.triggers
      .map((entry) => normalizeAutomationTriggerExtension(entry))
      .filter((entry): entry is OrganizationPortabilityIssueAutomationTriggerManifestEntry => entry !== null)
    : [];
  const automation = {
    concurrencyPolicy: asString(value.concurrencyPolicy),
    catchUpPolicy: asString(value.catchUpPolicy),
    triggers,
  };
  return stripEmptyValues(automation) ? automation : null;
}

export function buildAutomationManifestFromLiveAutomation(automation: AutomationLike): OrganizationPortabilityIssueAutomationManifestEntry {
  return {
    concurrencyPolicy: automation.concurrencyPolicy,
    catchUpPolicy: automation.catchUpPolicy,
    triggers: automation.triggers.map((trigger) => ({
      kind: trigger.kind,
      label: trigger.label ?? null,
      enabled: Boolean(trigger.enabled),
      cronExpression: trigger.kind === "schedule" ? trigger.cronExpression ?? null : null,
      timezone: trigger.kind === "schedule" ? trigger.timezone ?? null : null,
      signingMode: trigger.kind === "webhook" ? trigger.signingMode ?? null : null,
      replayWindowSec: trigger.kind === "webhook" ? trigger.replayWindowSec ?? null : null,
    })),
  };
}

export function containsAbsolutePathFragment(value: string) {
  return /(^|\s)(\/[^/\s]|[A-Za-z]:[\\/])/.test(value);
}

export function containsSystemDependentPathValue(value: unknown): boolean {
  if (typeof value === "string") {
    return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || containsAbsolutePathFragment(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSystemDependentPathValue(entry));
  }
  if (isPlainRecord(value)) {
    return Object.values(value).some((entry) => containsSystemDependentPathValue(entry));
  }
  return false;
}

export function clonePortableRecord(value: unknown) {
  if (!isPlainRecord(value)) return null;
  return structuredClone(value) as Record<string, unknown>;
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
      .filter((entry) => entry !== undefined && !isEmptyObject(entry) && !isEmptyArray(entry));
    return next.length > 0 ? next : undefined;
  }

  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const stripped = stripEmptyValues(entry, opts);
      if (stripped === undefined || stripped === null) continue;
      if (!opts?.preserveEmptyStrings && stripped === "") continue;
      if (isEmptyObject(stripped) || isEmptyArray(stripped)) continue;
      out[key] = stripped;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return value;
}

export function disableImportedTimerHeartbeat(runtimeConfig: unknown) {
  const next = clonePortableRecord(runtimeConfig) ?? {};
  const heartbeat = isPlainRecord(next.heartbeat) ? { ...next.heartbeat } : {};
  heartbeat.enabled = false;
  next.heartbeat = heartbeat;
  return next;
}

export function normalizePortableProjectWorkspaceExtension(
  workspaceKey: string,
  value: unknown,
): OrganizationPortabilityProjectWorkspaceManifestEntry | null {
  if (!isPlainRecord(value)) return null;
  const normalizedKey = normalizeAgentUrlKey(workspaceKey) ?? workspaceKey.trim();
  if (!normalizedKey) return null;
  return {
    key: normalizedKey,
    name: asString(value.name) ?? normalizedKey,
    sourceType: asString(value.sourceType),
    repoUrl: asString(value.repoUrl),
    repoRef: asString(value.repoRef),
    defaultRef: asString(value.defaultRef),
    visibility: asString(value.visibility),
    setupCommand: asString(value.setupCommand),
    cleanupCommand: asString(value.cleanupCommand),
    metadata: isPlainRecord(value.metadata) ? value.metadata : null,
    isPrimary: asBoolean(value.isPrimary) ?? false,
  };
}

export function derivePortableProjectWorkspaceKey(
  workspace: NonNullable<ProjectLike["workspaces"]>[number],
  usedKeys: Set<string>,
) {
  const baseKey =
    normalizeAgentUrlKey(workspace.name)
    ?? normalizeAgentUrlKey(asString(workspace.repoUrl)?.split("/").pop()?.replace(/\.git$/i, "") ?? "")
    ?? "workspace";
  return uniqueSlug(baseKey, usedKeys);
}

export function exportPortableProjectExecutionWorkspacePolicy(
  projectSlug: string,
  policy: unknown,
  workspaceKeyById: Map<string, string>,
  warnings: string[],
) {
  const next = clonePortableRecord(policy);
  if (!next) return null;
  const defaultWorkspaceId = asString(next.defaultProjectWorkspaceId);
  if (defaultWorkspaceId) {
    const defaultWorkspaceKey = workspaceKeyById.get(defaultWorkspaceId);
    if (defaultWorkspaceKey) {
      next.defaultProjectWorkspaceKey = defaultWorkspaceKey;
    } else {
      warnings.push(`Project ${projectSlug} default workspace ${defaultWorkspaceId} was omitted from export because that workspace is not portable.`);
    }
    delete next.defaultProjectWorkspaceId;
  }
  const cleaned = stripEmptyValues(next);
  return isPlainRecord(cleaned) ? cleaned : null;
}

export function importPortableProjectExecutionWorkspacePolicy(
  projectSlug: string,
  policy: Record<string, unknown> | null | undefined,
  workspaceIdByKey: Map<string, string>,
  warnings: string[],
) {
  const next = clonePortableRecord(policy);
  if (!next) return null;
  const defaultWorkspaceKey = asString(next.defaultProjectWorkspaceKey);
  if (defaultWorkspaceKey) {
    const defaultWorkspaceId = workspaceIdByKey.get(defaultWorkspaceKey);
    if (defaultWorkspaceId) {
      next.defaultProjectWorkspaceId = defaultWorkspaceId;
    } else {
      warnings.push(`Project ${projectSlug} references missing workspace key ${defaultWorkspaceKey}; imported execution workspace policy without a default workspace.`);
    }
  }
  delete next.defaultProjectWorkspaceKey;
  const cleaned = stripEmptyValues(next);
  return isPlainRecord(cleaned) ? cleaned : null;
}

export function stripPortableProjectExecutionWorkspaceRefs(policy: Record<string, unknown> | null | undefined) {
  const next = clonePortableRecord(policy);
  if (!next) return null;
  delete next.defaultProjectWorkspaceId;
  delete next.defaultProjectWorkspaceKey;
  const cleaned = stripEmptyValues(next);
  return isPlainRecord(cleaned) ? cleaned : null;
}

export async function readGitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function inferPortableWorkspaceGitMetadata(workspace: NonNullable<ProjectLike["workspaces"]>[number]) {
  const cwd = asString(workspace.cwd);
  if (!cwd) {
    return {
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
    };
  }

  let repoUrl: string | null = null;
  try {
    repoUrl = await readGitOutput(cwd, ["remote", "get-url", "origin"]);
  } catch {
    try {
      const firstRemote = await readGitOutput(cwd, ["remote"]);
      const remoteName = firstRemote?.split("\n").map((entry) => entry.trim()).find(Boolean) ?? null;
      if (remoteName) {
        repoUrl = await readGitOutput(cwd, ["remote", "get-url", remoteName]);
      }
    } catch {
      repoUrl = null;
    }
  }

  let repoRef: string | null = null;
  try {
    repoRef = await readGitOutput(cwd, ["branch", "--show-current"]);
  } catch {
    repoRef = null;
  }

  let defaultRef: string | null = null;
  try {
    const remoteHead = await readGitOutput(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    defaultRef = remoteHead?.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
  } catch {
    defaultRef = null;
  }

  return {
    repoUrl,
    repoRef,
    defaultRef,
  };
}

export async function buildPortableProjectWorkspaces(
  projectSlug: string,
  workspaces: ProjectLike["workspaces"] | undefined,
  warnings: string[],
) {
  const exportedWorkspaces: Record<string, Record<string, unknown>> = {};
  const manifestWorkspaces: OrganizationPortabilityProjectWorkspaceManifestEntry[] = [];
  const workspaceKeyById = new Map<string, string>();
  const workspaceKeyBySignature = new Map<string, string>();
  const manifestWorkspaceByKey = new Map<string, OrganizationPortabilityProjectWorkspaceManifestEntry>();
  const usedKeys = new Set<string>();

  for (const workspace of workspaces ?? []) {
    const inferredGitMetadata =
      !asString(workspace.repoUrl) || !asString(workspace.repoRef) || !asString(workspace.defaultRef)
        ? await inferPortableWorkspaceGitMetadata(workspace)
        : { repoUrl: null, repoRef: null, defaultRef: null };
    const repoUrl = asString(workspace.repoUrl) ?? inferredGitMetadata.repoUrl;
    if (!repoUrl) {
      warnings.push(`Project ${projectSlug} workspace ${workspace.name} was omitted from export because it does not have a portable repoUrl.`);
      continue;
    }
    const repoRef = asString(workspace.repoRef) ?? inferredGitMetadata.repoRef;
    const defaultRef = asString(workspace.defaultRef) ?? inferredGitMetadata.defaultRef ?? repoRef;
    const workspaceSignature = JSON.stringify({
      name: workspace.name,
      repoUrl,
      repoRef,
      defaultRef,
    });
    const existingWorkspaceKey = workspaceKeyBySignature.get(workspaceSignature);
    if (existingWorkspaceKey) {
      workspaceKeyById.set(workspace.id, existingWorkspaceKey);
      const existingManifestWorkspace = manifestWorkspaceByKey.get(existingWorkspaceKey);
      if (existingManifestWorkspace && workspace.isPrimary) {
        existingManifestWorkspace.isPrimary = true;
        const existingExtensionWorkspace = exportedWorkspaces[existingWorkspaceKey];
        if (isPlainRecord(existingExtensionWorkspace)) existingExtensionWorkspace.isPrimary = true;
      }
      continue;
    }

    const workspaceKey = derivePortableProjectWorkspaceKey(workspace, usedKeys);
    workspaceKeyById.set(workspace.id, workspaceKey);
    workspaceKeyBySignature.set(workspaceSignature, workspaceKey);

    let setupCommand = asString(workspace.setupCommand);
    if (setupCommand && containsAbsolutePathFragment(setupCommand)) {
      warnings.push(`Project ${projectSlug} workspace ${workspaceKey} setupCommand was omitted from export because it is system-dependent.`);
      setupCommand = null;
    }

    let cleanupCommand = asString(workspace.cleanupCommand);
    if (cleanupCommand && containsAbsolutePathFragment(cleanupCommand)) {
      warnings.push(`Project ${projectSlug} workspace ${workspaceKey} cleanupCommand was omitted from export because it is system-dependent.`);
      cleanupCommand = null;
    }

    const metadata = isPlainRecord(workspace.metadata) && !containsSystemDependentPathValue(workspace.metadata)
      ? workspace.metadata
      : null;
    if (isPlainRecord(workspace.metadata) && metadata == null) {
      warnings.push(`Project ${projectSlug} workspace ${workspaceKey} metadata was omitted from export because it contains system-dependent paths.`);
    }

    const portableWorkspace = stripEmptyValues({
      name: workspace.name,
      sourceType: workspace.sourceType,
      repoUrl,
      repoRef,
      defaultRef,
      visibility: asString(workspace.visibility),
      setupCommand,
      cleanupCommand,
      metadata,
      isPrimary: workspace.isPrimary ? true : undefined,
    });
    if (!isPlainRecord(portableWorkspace)) continue;

    exportedWorkspaces[workspaceKey] = portableWorkspace;
    const manifestWorkspace = {
      key: workspaceKey,
      name: workspace.name,
      sourceType: asString(workspace.sourceType),
      repoUrl,
      repoRef,
      defaultRef,
      visibility: asString(workspace.visibility),
      setupCommand,
      cleanupCommand,
      metadata,
      isPrimary: workspace.isPrimary,
    };
    manifestWorkspaces.push(manifestWorkspace);
    manifestWorkspaceByKey.set(workspaceKey, manifestWorkspace);
  }

  return {
    extension: Object.keys(exportedWorkspaces).length > 0 ? exportedWorkspaces : undefined,
    manifest: manifestWorkspaces,
    workspaceKeyById,
  };
}

export const WEEKDAY_TO_CRON: Record<string, string> = {
  sunday: "0",
  monday: "1",
  tuesday: "2",
  wednesday: "3",
  thursday: "4",
  friday: "5",
  saturday: "6",
};

export function readZonedDateParts(startsAt: string, timeZone: string) {
  try {
    const date = new Date(startsAt);
    if (Number.isNaN(date.getTime())) return null;
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      weekday: "long",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((entry) => entry.type !== "literal")
        .map((entry) => [entry.type, entry.value]),
    ) as Record<string, string>;
    const weekday = WEEKDAY_TO_CRON[parts.weekday?.toLowerCase() ?? ""];
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    if (!weekday || !Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return { weekday, month, day, hour, minute };
  } catch {
    return null;
  }
}

export function normalizeCronList(values: string[]) {
  return Array.from(new Set(values)).sort((left, right) => Number(left) - Number(right)).join(",");
}

export function buildLegacyAutomationTriggerFromRecurrence(
  issue: Pick<OrganizationPortabilityIssueManifestEntry, "slug" | "legacyRecurrence">,
  scheduleValue: unknown,
) {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!issue.legacyRecurrence || !isPlainRecord(issue.legacyRecurrence)) {
    return { trigger: null, warnings, errors };
  }

  const schedule = isPlainRecord(scheduleValue) ? scheduleValue : null;
  const frequency = asString(issue.legacyRecurrence.frequency);
  const interval = asInteger(issue.legacyRecurrence.interval) ?? 1;
  if (!frequency) {
    errors.push(`Recurring task ${issue.slug} uses legacy recurrence without frequency; add .rudder.yaml automations.${issue.slug}.triggers.`);
    return { trigger: null, warnings, errors };
  }
  if (interval < 1) {
    errors.push(`Recurring task ${issue.slug} uses legacy recurrence with an invalid interval; add .rudder.yaml automations.${issue.slug}.triggers.`);
    return { trigger: null, warnings, errors };
  }

  const timezone = asString(schedule?.timezone) ?? "UTC";
  const startsAt = asString(schedule?.startsAt);
  const zonedStartsAt = startsAt ? readZonedDateParts(startsAt, timezone) : null;
  if (startsAt && !zonedStartsAt) {
    errors.push(`Recurring task ${issue.slug} has an invalid legacy startsAt/timezone combination; add .rudder.yaml automations.${issue.slug}.triggers.`);
    return { trigger: null, warnings, errors };
  }

  const time = isPlainRecord(issue.legacyRecurrence.time) ? issue.legacyRecurrence.time : null;
  const hour = asInteger(time?.hour) ?? zonedStartsAt?.hour ?? 0;
  const minute = asInteger(time?.minute) ?? zonedStartsAt?.minute ?? 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    errors.push(`Recurring task ${issue.slug} uses legacy recurrence with an invalid time; add .rudder.yaml automations.${issue.slug}.triggers.`);
    return { trigger: null, warnings, errors };
  }

  if (issue.legacyRecurrence.until != null || issue.legacyRecurrence.count != null) {
    warnings.push(`Recurring task ${issue.slug} uses legacy recurrence end bounds; Rudder will import the automation trigger without those limits.`);
  }

  let cronExpression: string | null = null;

  if (frequency === "hourly") {
    const hourField = interval === 1
      ? "*"
      : zonedStartsAt
        ? `${zonedStartsAt.hour}-23/${interval}`
        : `*/${interval}`;
    cronExpression = `${minute} ${hourField} * * *`;
  } else if (frequency === "daily") {
    if (Array.isArray(issue.legacyRecurrence.weekdays) || Array.isArray(issue.legacyRecurrence.monthDays) || Array.isArray(issue.legacyRecurrence.months)) {
      errors.push(`Recurring task ${issue.slug} uses unsupported legacy daily recurrence constraints; add .rudder.yaml automations.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    const dayField = interval === 1 ? "*" : `*/${interval}`;
    cronExpression = `${minute} ${hour} ${dayField} * *`;
  } else if (frequency === "weekly") {
    if (interval !== 1) {
      errors.push(`Recurring task ${issue.slug} uses legacy weekly recurrence with interval > 1; add .rudder.yaml automations.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    const weekdays = Array.isArray(issue.legacyRecurrence.weekdays)
      ? issue.legacyRecurrence.weekdays
        .map((entry) => asString(entry))
        .filter((entry): entry is string => Boolean(entry))
      : [];
    const cronWeekdays = weekdays
      .map((entry) => WEEKDAY_TO_CRON[entry.toLowerCase()])
      .filter((entry): entry is string => Boolean(entry));
    if (cronWeekdays.length === 0 && zonedStartsAt?.weekday) {
      cronWeekdays.push(zonedStartsAt.weekday);
    }
    if (cronWeekdays.length === 0) {
      errors.push(`Recurring task ${issue.slug} uses legacy weekly recurrence without weekdays; add .rudder.yaml automations.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    cronExpression = `${minute} ${hour} * * ${normalizeCronList(cronWeekdays)}`;
  } else if (frequency === "monthly") {
    if (interval !== 1) {
      errors.push(`Recurring task ${issue.slug} uses legacy monthly recurrence with interval > 1; add .rudder.yaml automations.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    if (Array.isArray(issue.legacyRecurrence.ordinalWeekdays) && issue.legacyRecurrence.ordinalWeekdays.length > 0) {
      errors.push(`Recurring task ${issue.slug} uses legacy ordinal monthly recurrence; add .rudder.yaml automations.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    const monthDays = Array.isArray(issue.legacyRecurrence.monthDays)
      ? issue.legacyRecurrence.monthDays
        .map((entry) => asInteger(entry))
        .filter((entry): entry is number => entry != null && entry >= 1 && entry <= 31)
      : [];
    if (monthDays.length === 0 && zonedStartsAt?.day) {
      monthDays.push(zonedStartsAt.day);
    }
    if (monthDays.length === 0) {
      errors.push(`Recurring task ${issue.slug} uses legacy monthly recurrence without monthDays; add .rudder.yaml automations.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    const months = Array.isArray(issue.legacyRecurrence.months)
      ? issue.legacyRecurrence.months
        .map((entry) => asInteger(entry))
        .filter((entry): entry is number => entry != null && entry >= 1 && entry <= 12)
      : [];
    const monthField = months.length > 0 ? normalizeCronList(months.map(String)) : "*";
    cronExpression = `${minute} ${hour} ${normalizeCronList(monthDays.map(String))} ${monthField} *`;
  } else if (frequency === "yearly") {
    if (interval !== 1) {
      errors.push(`Recurring task ${issue.slug} uses legacy yearly recurrence with interval > 1; add .rudder.yaml automations.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    const months = Array.isArray(issue.legacyRecurrence.months)
      ? issue.legacyRecurrence.months
        .map((entry) => asInteger(entry))
        .filter((entry): entry is number => entry != null && entry >= 1 && entry <= 12)
      : [];
    if (months.length === 0 && zonedStartsAt?.month) {
      months.push(zonedStartsAt.month);
    }
    const monthDays = Array.isArray(issue.legacyRecurrence.monthDays)
      ? issue.legacyRecurrence.monthDays
        .map((entry) => asInteger(entry))
        .filter((entry): entry is number => entry != null && entry >= 1 && entry <= 31)
      : [];
    if (monthDays.length === 0 && zonedStartsAt?.day) {
      monthDays.push(zonedStartsAt.day);
    }
    if (months.length === 0 || monthDays.length === 0) {
      errors.push(`Recurring task ${issue.slug} uses legacy yearly recurrence without month/monthDay anchors; add .rudder.yaml automations.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    cronExpression = `${minute} ${hour} ${normalizeCronList(monthDays.map(String))} ${normalizeCronList(months.map(String))} *`;
  } else {
    errors.push(`Recurring task ${issue.slug} uses unsupported legacy recurrence frequency "${frequency}"; add .rudder.yaml automations.${issue.slug}.triggers.`);
    return { trigger: null, warnings, errors };
  }

  return {
    trigger: {
      kind: "schedule",
      label: "Migrated legacy recurrence",
      enabled: true,
      cronExpression,
      timezone,
      signingMode: null,
      replayWindowSec: null,
    } satisfies OrganizationPortabilityIssueAutomationTriggerManifestEntry,
    warnings,
    errors,
  };
}

export function resolvePortableAutomationDefinition(
  issue: Pick<OrganizationPortabilityIssueManifestEntry, "slug" | "recurring" | "automation" | "legacyRecurrence">,
  scheduleValue: unknown,
) {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!issue.recurring) {
    return { automation: null, warnings, errors };
  }

  const automation = issue.automation
    ? {
      concurrencyPolicy: issue.automation.concurrencyPolicy,
      catchUpPolicy: issue.automation.catchUpPolicy,
      triggers: [...issue.automation.triggers],
    }
    : {
      concurrencyPolicy: null,
      catchUpPolicy: null,
      triggers: [] as OrganizationPortabilityIssueAutomationTriggerManifestEntry[],
    };

  if (automation.concurrencyPolicy && !AUTOMATION_CONCURRENCY_POLICIES.includes(automation.concurrencyPolicy as any)) {
    errors.push(`Recurring task ${issue.slug} uses unsupported automation concurrencyPolicy "${automation.concurrencyPolicy}".`);
  }
  if (automation.catchUpPolicy && !AUTOMATION_CATCH_UP_POLICIES.includes(automation.catchUpPolicy as any)) {
    errors.push(`Recurring task ${issue.slug} uses unsupported automation catchUpPolicy "${automation.catchUpPolicy}".`);
  }

  for (const trigger of automation.triggers) {
    if (!AUTOMATION_TRIGGER_KINDS.includes(trigger.kind as any)) {
      errors.push(`Recurring task ${issue.slug} uses unsupported trigger kind "${trigger.kind}".`);
      continue;
    }
    if (trigger.kind === "schedule") {
      if (!trigger.cronExpression || !trigger.timezone) {
        errors.push(`Recurring task ${issue.slug} has a schedule trigger missing cronExpression/timezone.`);
        continue;
      }
      const cronError = validateCron(trigger.cronExpression);
      if (cronError) {
        errors.push(`Recurring task ${issue.slug} has an invalid schedule trigger: ${cronError}`);
      }
      continue;
    }
    if (trigger.kind === "webhook" && trigger.signingMode && !AUTOMATION_TRIGGER_SIGNING_MODES.includes(trigger.signingMode as any)) {
      errors.push(`Recurring task ${issue.slug} uses unsupported webhook signingMode "${trigger.signingMode}".`);
    }
  }

  if (automation.triggers.length === 0 && issue.legacyRecurrence) {
    const migrated = buildLegacyAutomationTriggerFromRecurrence(issue, scheduleValue);
    warnings.push(...migrated.warnings);
    errors.push(...migrated.errors);
    if (migrated.trigger) {
      automation.triggers.push(migrated.trigger);
    }
  }

  return { automation, warnings, errors };
}

export function toSafeSlug(input: string, fallback: string) {
  return normalizeAgentUrlKey(input) ?? fallback;
}

export function uniqueSlug(base: string, used: Set<string>) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let idx = 2;
  while (true) {
    const candidate = `${base}-${idx}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    idx += 1;
  }
}

export function uniqueNameBySlug(baseName: string, existingSlugs: Set<string>) {
  const baseSlug = normalizeAgentUrlKey(baseName) ?? "agent";
  if (!existingSlugs.has(baseSlug)) return baseName;
  let idx = 2;
  while (true) {
    const candidateName = `${baseName} ${idx}`;
    const candidateSlug = normalizeAgentUrlKey(candidateName) ?? `agent-${idx}`;
    if (!existingSlugs.has(candidateSlug)) return candidateName;
    idx += 1;
  }
}

export function uniqueProjectName(baseName: string, existingProjectSlugs: Set<string>) {
  const baseSlug = deriveProjectUrlKey(baseName, baseName);
  if (!existingProjectSlugs.has(baseSlug)) return baseName;
  let idx = 2;
  while (true) {
    const candidateName = `${baseName} ${idx}`;
    const candidateSlug = deriveProjectUrlKey(candidateName, candidateName);
    if (!existingProjectSlugs.has(candidateSlug)) return candidateName;
    idx += 1;
  }
}
