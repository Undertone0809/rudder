export const SKILLS_LIBRARY_DIRECTORY_HREF = "/library?directory=skills";

function encodeSkillFilePath(filePath: string) {
  return filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function decodeSkillFilePath(filePath: string | undefined) {
  if (!filePath) return "SKILL.md";
  return filePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

export function buildLibrarySkillHref(skillId: string, filePath: string = "SKILL.md") {
  const search = new URLSearchParams();
  search.set("skill", skillId);
  search.set("skillFile", filePath);
  return `/library?${search.toString()}`;
}

export function parseLegacySkillRoute(routePath: string | undefined) {
  const segments = (routePath ?? "").split("/").filter(Boolean);
  if (segments.length === 0) {
    return { skillId: null, filePath: "SKILL.md" };
  }

  const [rawSkillId, rawMode, ...rest] = segments;
  const skillId = rawSkillId ? decodeURIComponent(rawSkillId) : null;
  if (!skillId) {
    return { skillId: null, filePath: "SKILL.md" };
  }

  if (rawMode === "files") {
    return {
      skillId,
      filePath: decodeSkillFilePath(rest.join("/")),
    };
  }

  return { skillId, filePath: "SKILL.md" };
}

export function legacySkillRouteToLibraryHref(routePath: string | undefined) {
  const parsed = parseLegacySkillRoute(routePath);
  if (!parsed.skillId) return SKILLS_LIBRARY_DIRECTORY_HREF;
  return buildLibrarySkillHref(parsed.skillId, parsed.filePath);
}

export function legacySkillFileRoute(skillId: string, filePath?: string | null) {
  return filePath
    ? `/skills/${skillId}/files/${encodeSkillFilePath(filePath)}`
    : `/skills/${skillId}`;
}
