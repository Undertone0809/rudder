import { normalizeAgentUrlKey } from "./agent-url-key.js";
import { normalizeOrganizationUrlKey } from "./organization-url-key.js";
import type {
  OrganizationSkillListItem,
  OrganizationSkillSourceType,
} from "./types/organization-skill.js";

type SkillReferenceSource = Pick<
  OrganizationSkillListItem,
  "key" | "slug" | "name" | "sourceType" | "sourceLocator"
> & Partial<Pick<OrganizationSkillListItem, "sourceBadge" | "sourceLabel" | "sourcePath">>;

export type OrganizationSkillPublicRefScope = "organization" | "agent";

export interface OrganizationSkillPublicRefContext {
  orgUrlKey: string;
  agentUrlKey?: string | null;
  scope?: OrganizationSkillPublicRefScope;
}

export type ParsedOrganizationSkillReferenceKind =
  | "raw_slug"
  | "organization"
  | "rudder"
  | "github"
  | "url"
  | "other";

export interface ParsedOrganizationSkillReference {
  kind: ParsedOrganizationSkillReferenceKind;
  normalized: string;
  slug: string | null;
  segments: string[];
}

export interface ResolveOrganizationSkillReferenceContext {
  orgId: string;
}

export interface ResolveOrganizationSkillReferenceResult<TSkill> {
  skill: TSkill | null;
  ambiguous: boolean;
}

function normalizeSkillSlug(value: string | null | undefined) {
  return value ? normalizeAgentUrlKey(value) ?? null : null;
}

export const RUDDER_BUNDLED_SKILL_SLUGS = [
  "para-memory-files",
  "rudder-docs",
  "skill-creator",
  "visualize",
  "browser",
] as const;

export function getActiveRudderBundledSkillSlugs(browserEnabled: boolean): string[] {
  return RUDDER_BUNDLED_SKILL_SLUGS.filter((slug) => slug !== "browser" || browserEnabled);
}

const RUDDER_BUNDLED_SKILL_KEYS = new Set(
  RUDDER_BUNDLED_SKILL_SLUGS.map((slug) => `rudder/${slug}`),
);

export const RUDDER_DOCS_SKILL_SLUG = "rudder-docs";
export const RUDDER_DOCS_SKILL_KEY = `rudder/${RUDDER_DOCS_SKILL_SLUG}`;
export const RUDDER_DOCS_SELECTION_KEY = `bundled:${RUDDER_DOCS_SKILL_KEY}`;

export const RETIRED_RUDDER_CREATION_SKILL_SLUGS = [
  "rudder-create-agent",
  "rudder-create-plugin",
] as const;

const RETIRED_RUDDER_CREATION_SKILL_SLUG_SET = new Set<string>(
  RETIRED_RUDDER_CREATION_SKILL_SLUGS,
);

const LEGACY_RUDDER_DOCS_SKILL_REFERENCES = new Set([
  "rudder",
  "rudder/rudder",
  "bundled:rudder/rudder",
]);

export function getBundledRudderSkillSlug(value: string | null | undefined) {
  if (!value) return null;
  const normalizedReference = value.trim().toLowerCase();
  if (LEGACY_RUDDER_DOCS_SKILL_REFERENCES.has(normalizedReference)) {
    return RUDDER_DOCS_SKILL_SLUG;
  }

  const selectionReference = normalizedReference.startsWith("bundled:")
    ? normalizedReference.slice("bundled:".length)
    : normalizedReference;
  if (selectionReference === RUDDER_DOCS_SKILL_SLUG) {
    return RUDDER_DOCS_SKILL_SLUG;
  }

  const segments = selectionReference
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment));

  if (segments.length === 2 && segments[0] === "rudder") {
    return segments[1] ?? null;
  }

  if (segments.length === 3 && segments[0] === "rudder" && segments[1] === "rudder") {
    return segments[2] ?? null;
  }

  return null;
}

export function toBundledRudderSkillKey(value: string | null | undefined) {
  const slug = getBundledRudderSkillSlug(value) ?? normalizeSkillSlug(value);
  if (!slug) return null;
  return `rudder/${slug === "rudder" ? RUDDER_DOCS_SKILL_SLUG : slug}`;
}

export function isCanonicalBundledRudderSkillKey(value: string | null | undefined) {
  return RUDDER_BUNDLED_SKILL_KEYS.has(value ?? "");
}

export function normalizeOrganizationSkillKey(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value
    .trim()
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment))
    .join("/");
  return normalized.length > 0 ? normalized : null;
}

function isOrganizationScopedSkill(skill: { sourceType?: OrganizationSkillSourceType | null; key: string }) {
  return skill.sourceType !== "github" && skill.sourceType !== "skills_sh" && skill.sourceType !== "url";
}

function isBundledRudderSkill(skill: SkillReferenceSource) {
  return getBundledRudderSkillSlug(skill.key) !== null;
}

function isLegacyRudderReferenceCandidate(skill: SkillReferenceSource) {
  return isBundledRudderSkill(skill) || skill.sourceBadge === "rudder";
}

function normalizeSegmentList(reference: string) {
  return reference
    .trim()
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment));
}

export function isRetiredRudderCreationSkillReference(value: string | null | undefined) {
  if (!value) return false;
  const normalizedReference = value.trim().toLowerCase();
  const selectionReference = normalizedReference.startsWith("bundled:")
    ? normalizedReference.slice("bundled:".length)
    : normalizedReference;
  const segments = normalizeSegmentList(selectionReference);

  if (segments.length === 1) {
    return RETIRED_RUDDER_CREATION_SKILL_SLUG_SET.has(segments[0]!);
  }
  if (segments.length === 2 && segments[0] === "rudder") {
    return RETIRED_RUDDER_CREATION_SKILL_SLUG_SET.has(segments[1]!);
  }
  if (segments.length === 3 && segments[0] === "rudder" && segments[1] === "rudder") {
    return RETIRED_RUDDER_CREATION_SKILL_SLUG_SET.has(segments[2]!);
  }
  return false;
}

function parseRepositoryLocator(sourceLocator: string | null | undefined, sourceLabel: string | null | undefined) {
  const tryParse = (value: string | null | undefined) => {
    if (!value) return null;
    try {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        return {
          owner: normalizeSkillSlug(parts[0]) ?? parts[0]!,
          repo: normalizeSkillSlug(parts[1]) ?? parts[1]!,
        };
      }
    } catch {
      const parts = value.split("/").map((part) => part.trim()).filter(Boolean);
      if (parts.length >= 2) {
        return {
          owner: normalizeSkillSlug(parts[0]) ?? parts[0]!,
          repo: normalizeSkillSlug(parts[1]) ?? parts[1]!,
        };
      }
    }
    return null;
  };

  return tryParse(sourceLocator) ?? tryParse(sourceLabel);
}

export function formatOrganizationSkillPublicRef(
  skill: SkillReferenceSource,
  context: OrganizationSkillPublicRefContext,
) {
  const normalizedKey = normalizeOrganizationSkillKey(skill.key) ?? skill.key.trim();
  const slug = (normalizeSkillSlug(skill.slug) ?? skill.slug.trim()) || "skill";
  const orgUrlKey = normalizeOrganizationUrlKey(context.orgUrlKey) ?? "organization";
  const agentUrlKey = normalizeAgentUrlKey(context.agentUrlKey ?? null);

  if (isBundledRudderSkill(skill)) {
    return `rudder/${slug}`;
  }

  if (normalizedKey.startsWith("organization/") || normalizedKey.startsWith("local/") || normalizedKey.startsWith("catalog/")) {
    if (context.scope === "agent" && agentUrlKey) {
      return `org/${orgUrlKey}/${agentUrlKey}/${slug}`;
    }
    return `org/${orgUrlKey}/${slug}`;
  }

  if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
    const repo = parseRepositoryLocator(skill.sourceLocator, skill.sourceLabel);
    if (repo) {
      return `${repo.owner}/${repo.repo}/${slug}`;
    }
  }

  if (normalizedKey.startsWith("url/")) {
    return normalizedKey;
  }

  return normalizedKey;
}

export function buildOrganizationSkillSearchText(
  skill: SkillReferenceSource,
  context: OrganizationSkillPublicRefContext,
) {
  return [
    formatOrganizationSkillPublicRef(skill, context),
    skill.name,
    skill.slug,
    skill.sourceLabel ?? "",
    skill.sourceBadge ?? "",
    skill.sourcePath ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export function parseOrganizationSkillReference(reference: string): ParsedOrganizationSkillReference {
  const normalized = reference.trim();
  const segments = normalizeSegmentList(normalized);
  if (segments.length === 0) {
    return {
      kind: "other",
      normalized: "",
      slug: null,
      segments: [],
    };
  }

  if (segments[0] === "org" || segments[0] === "organization") {
    return {
      kind: "organization",
      normalized: segments.join("/"),
      slug: segments.at(-1) ?? null,
      segments,
    };
  }

  if (segments[0] === "rudder") {
    return {
      kind: "rudder",
      normalized: segments.join("/"),
      slug: segments.at(-1) ?? null,
      segments,
    };
  }

  if (segments[0] === "url" && segments.length >= 4) {
    return {
      kind: "url",
      normalized: segments.join("/"),
      slug: segments.at(-1) ?? null,
      segments,
    };
  }

  if (segments[0] === "local" && segments.length >= 3) {
    return {
      kind: "other",
      normalized: segments.join("/"),
      slug: segments.at(-1) ?? null,
      segments,
    };
  }

  if (segments.length >= 3) {
    return {
      kind: "github",
      normalized: segments.join("/"),
      slug: segments.at(-1) ?? null,
      segments,
    };
  }

  return {
    kind: "raw_slug",
    normalized: segments.join("/"),
    slug: segments[0] ?? null,
    segments,
  };
}

export function resolveOrganizationSkillReference<TSkill extends SkillReferenceSource>(
  skills: TSkill[],
  reference: string,
  context: ResolveOrganizationSkillReferenceContext,
): ResolveOrganizationSkillReferenceResult<TSkill> {
  const trimmed = reference.trim();
  if (!trimmed) {
    return { skill: null, ambiguous: false };
  }
  if (isRetiredRudderCreationSkillReference(trimmed)) {
    return { skill: null, ambiguous: false };
  }

  const normalizedKey = normalizeOrganizationSkillKey(trimmed);
  if (normalizedKey) {
    const byKey = skills.find((skill) => normalizeOrganizationSkillKey(skill.key) === normalizedKey);
    if (byKey) {
      return { skill: byKey, ambiguous: false };
    }
  }

  const parsed = parseOrganizationSkillReference(trimmed);
  if (parsed.kind === "organization") {
    const slug = parsed.slug;
    if (!slug) return { skill: null, ambiguous: false };
    const exactKey = `organization/${context.orgId}/${slug}`;
    const byExactOrgKey = skills.find((skill) => skill.key === exactKey);
    if (byExactOrgKey) {
      return { skill: byExactOrgKey, ambiguous: false };
    }

    const orgScoped = skills.filter((skill) => isOrganizationScopedSkill(skill) && skill.slug === slug);
    if (orgScoped.length === 1) {
      return { skill: orgScoped[0] ?? null, ambiguous: false };
    }
    if (orgScoped.length > 1) {
      return { skill: null, ambiguous: true };
    }

    const bySlug = skills.filter((skill) => skill.slug === slug);
    if (bySlug.length === 1) {
      return { skill: bySlug[0] ?? null, ambiguous: false };
    }
    if (bySlug.length > 1) {
      return { skill: null, ambiguous: true };
    }
    return { skill: null, ambiguous: false };
  }

  if (parsed.kind === "rudder") {
    const slug = parsed.slug;
    if (!slug) return { skill: null, ambiguous: false };
    const canonicalSlug = getBundledRudderSkillSlug(trimmed) ?? slug;
    const canonicalKey = toBundledRudderSkillKey(canonicalSlug);
    const legacyKey = canonicalKey ? `rudder/${canonicalKey}` : null;
    const legacyRudderDocsKey = canonicalSlug === RUDDER_DOCS_SKILL_SLUG
      ? "rudder/rudder"
      : null;
    for (const exactKey of [canonicalKey, legacyKey, legacyRudderDocsKey]) {
      if (!exactKey) continue;
      const byExactKey = skills.find((skill) => skill.key === exactKey);
      if (byExactKey) {
        return { skill: byExactKey, ambiguous: false };
      }
    }

    const rudderSkills = skills.filter(
      (skill) => isLegacyRudderReferenceCandidate(skill) && skill.slug === slug,
    );
    if (rudderSkills.length === 1) {
      return { skill: rudderSkills[0] ?? null, ambiguous: false };
    }
    if (rudderSkills.length > 1) {
      return { skill: null, ambiguous: true };
    }
    return { skill: null, ambiguous: false };
  }

  if (parsed.kind === "raw_slug") {
    const slug = parsed.slug;
    if (!slug) return { skill: null, ambiguous: false };
    const bySlug = skills.filter((skill) => skill.slug === slug);
    if (bySlug.length === 1) {
      return { skill: bySlug[0] ?? null, ambiguous: false };
    }
    if (bySlug.length > 1) {
      return { skill: null, ambiguous: true };
    }
  }

  return { skill: null, ambiguous: false };
}
