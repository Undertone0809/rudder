import type { TranscriptSkillTarget } from "@/components/transcript/RunTranscriptView";
import type { OrganizationSkillListItem } from "@rudderhq/shared";
import type { SidePanelTarget } from "./side-panel-targets";

function normalizePath(value: string | null | undefined) {
  const trimmed = value?.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return trimmed?.replace(/\/$/g, "") || null;
}

function normalizeIdentity(value: string | null | undefined) {
  const trimmed = value?.trim().toLowerCase().replace(/^\$/, "");
  if (!trimmed) return null;
  return trimmed
    .replace(/^bundled:/, "")
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || null;
}

function skillPaths(skill: OrganizationSkillListItem) {
  return [skill.sourcePath, skill.workspaceEditPath].flatMap((value) => {
    const normalized = normalizePath(value);
    if (!normalized) return [];
    const lowerPath = normalized.toLowerCase();
    return lowerPath === "skill.md" || lowerPath.endsWith("/skill.md")
      ? [normalized]
      : [`${normalized}/SKILL.md`];
  });
}

function matchesIdentity(skill: OrganizationSkillListItem, identity: string) {
  return [skill.slug, skill.key, skill.name]
    .map(normalizeIdentity)
    .some((candidate) => candidate === identity);
}

export function resolveTranscriptSkillSidePanelTarget(
  target: TranscriptSkillTarget,
  organizationSkills: OrganizationSkillListItem[] | null | undefined,
): SidePanelTarget | null {
  const targetPath = normalizePath(target.path);
  const skills = organizationSkills ?? [];

  if (targetPath) {
    const pathMatches = skills.filter((skill) => (
      skillPaths(skill).some((candidate) => candidate === targetPath)
    ));
    if (pathMatches.length === 1) {
      const skill = pathMatches[0]!;
      return {
        kind: "organization_skill_file",
        skillId: skill.id,
        filePath: "SKILL.md",
        label: skill.slug || skill.name,
      };
    }
  }

  const identity = normalizeIdentity(target.name);
  if (identity) {
    const identityMatches = skills.filter((skill) => matchesIdentity(skill, identity));
    if (identityMatches.length === 1) {
      const skill = identityMatches[0]!;
      return {
        kind: "organization_skill_file",
        skillId: skill.id,
        filePath: "SKILL.md",
        label: skill.slug || skill.name,
      };
    }
  }

  if (targetPath) {
    return {
      kind: "local_file",
      filePath: targetPath,
      label: target.name || targetPath.split("/").at(-2) || "Skill",
    };
  }

  return null;
}
