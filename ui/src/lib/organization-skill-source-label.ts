import type { OrganizationSkillSourceBadge } from "@rudderhq/shared";

type SkillSourceLabelInput = {
  sourceBadge: OrganizationSkillSourceBadge;
  sourceLabel: string | null | undefined;
  sourceLocator?: string | null | undefined;
  sourcePath?: string | null | undefined;
  fallbackLabel: string;
};

function trimTrailingSkillFile(value: string) {
  return value.replace(/\/SKILL\.md$/iu, "").replace(/\/+$/u, "");
}

export function isFilesystemPathLike(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return (
    trimmed.startsWith("/")
    || trimmed.startsWith("~/")
    || /^[a-z]:[\\/]/iu.test(trimmed)
  );
}

function hostLabel(value: string) {
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}

export function formatOrganizationSkillSourceLabel(input: SkillSourceLabelInput) {
  const rawLabel = input.sourceLabel?.trim() || input.fallbackLabel;
  if (!rawLabel) return input.fallbackLabel;

  if (input.sourceBadge === "local" && isFilesystemPathLike(rawLabel)) {
    return "Local folder";
  }

  if ((input.sourceBadge === "url" || input.sourceBadge === "skills_sh") && /^https?:\/\//iu.test(rawLabel)) {
    return hostLabel(rawLabel);
  }

  return rawLabel;
}

export function formatOrganizationSkillSourceTooltip(input: SkillSourceLabelInput) {
  const candidates = [
    input.sourcePath,
    input.sourceLocator,
    input.sourceLabel,
  ];
  const fullSource = candidates
    .map((candidate) => candidate?.trim() ?? "")
    .find((candidate) => candidate.length > 0);
  if (!fullSource) return null;

  const displayLabel = formatOrganizationSkillSourceLabel(input);
  const normalizedFullSource = trimTrailingSkillFile(fullSource);
  if (normalizedFullSource === displayLabel) return null;
  return normalizedFullSource;
}

export function resolveOrganizationSkillSourceCopyText(input: Pick<SkillSourceLabelInput, "sourcePath" | "sourceLocator" | "sourceLabel">) {
  return input.sourcePath?.trim()
    || input.sourceLocator?.trim()
    || (isFilesystemPathLike(input.sourceLabel) ? input.sourceLabel!.trim() : null);
}
