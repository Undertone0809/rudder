import type {
  OrganizationSkillFileDetail,
  OrganizationSkillListItem,
  OrganizationWorkspaceFileDetail,
} from "@rudderhq/shared";
import { organizationsApi } from "./orgs";
import { organizationSkillsApi } from "./organizationSkills";
import { resolveLocalFileDisplayTarget } from "../lib/local-file-targets";

function normalizeAbsolutePath(value: string) {
  if (value.includes("\0")) return null;
  const slashPath = value.trim().replaceAll("\\", "/");
  const isDrivePath = /^[A-Za-z]:\//u.test(slashPath);
  const isUncPath = slashPath.startsWith("//");
  if (!slashPath.startsWith("/") && !isDrivePath) return null;

  const prefix = isDrivePath
    ? slashPath.slice(0, 2).toUpperCase() + "/"
    : isUncPath
      ? "//"
      : "/";
  const remainder = slashPath.slice(isDrivePath ? 3 : isUncPath ? 2 : 1);
  const segments = remainder.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const normalizedSegments = segments.filter((segment) => segment && segment !== ".");
  if (isUncPath && normalizedSegments.length < 2) return null;
  return prefix + normalizedSegments.join("/");
}

function relativePathUnder(rootPath: string, targetPath: string) {
  const root = normalizeAbsolutePath(rootPath);
  const target = normalizeAbsolutePath(targetPath);
  if (!root || !target) return null;

  const caseInsensitive = /^[A-Z]:\//u.test(root) || root.startsWith("//");
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparableTarget = caseInsensitive ? target.toLowerCase() : target;
  const prefix = comparableRoot.endsWith("/") ? comparableRoot : comparableRoot + "/";
  if (!comparableTarget.startsWith(prefix)) return null;

  const relative = target.slice(prefix.length);
  if (!relative || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return relative;
}

function skillFilePreview(
  skillFile: OrganizationSkillFileDetail,
  skillRoot: string,
): OrganizationWorkspaceFileDetail {
  const extension = skillFile.path.split(".").at(-1)?.toLowerCase();
  const contentType = skillFile.markdown
    ? "text/markdown"
    : extension === "csv"
      ? "text/csv"
      : extension === "json"
        ? "application/json"
        : "text/plain";
  return {
    source: "org_root",
    rootPath: skillRoot,
    repoUrl: null,
    filePath: skillFile.path,
    libraryEntryId: null,
    mentionHref: null,
    markdownLink: null,
    rootExists: true,
    content: skillFile.content,
    contentType,
    previewKind: "text",
    contentPath: null,
    message: null,
    truncated: false,
  };
}

function findRegisteredSkillFile(
  skills: OrganizationSkillListItem[],
  targetPath: string,
) {
  const matches = skills
    .map((skill) => ({
      skill,
      relativePath: skill.sourcePath ? relativePathUnder(skill.sourcePath, targetPath) : null,
    }))
    .filter((match): match is { skill: OrganizationSkillListItem; relativePath: string } => (
      match.relativePath !== null
    ))
    .sort((left, right) => right.skill.sourcePath!.length - left.skill.sourcePath!.length);

  for (const match of matches) {
    const entry = match.skill.fileInventory.find((file) => file.path === match.relativePath);
    if (entry) return { ...match, entry };
  }
  if (matches.length > 0) {
    throw new Error("This file is not part of the selected organization's skill inventory.");
  }
  return null;
}

export async function readAuthorizedLocalFilePreview(
  orgId: string,
  localPath: string,
): Promise<OrganizationWorkspaceFileDetail> {
  const targetPath = resolveLocalFileDisplayTarget(localPath) ?? localPath.trim();
  if (!normalizeAbsolutePath(targetPath)) {
    throw new Error("This local file is not available through the selected organization.");
  }

  const skills = await organizationSkillsApi.list(orgId);
  const registeredSkillFile = findRegisteredSkillFile(skills, targetPath);
  if (registeredSkillFile) {
    if (registeredSkillFile.entry.kind === "asset") {
      throw new Error("This organization skill asset does not support an inline text preview.");
    }
    const skillFile = await organizationSkillsApi.file(
      orgId,
      registeredSkillFile.skill.id,
      registeredSkillFile.relativePath,
    );
    return skillFilePreview(skillFile, registeredSkillFile.skill.sourcePath!);
  }

  return organizationsApi.readWorkspaceFile(orgId, targetPath);
}
