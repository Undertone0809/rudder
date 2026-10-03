import type { OrganizationSkill } from "@rudderhq/shared";
import { promises as fs } from "node:fs";
import path from "node:path";
import { unprocessable } from "../../errors.js";
import type { ImportedSkill } from "./organization-skills.catalog.js";
import {
  normalizeSkillDirectory,
  resolveLocalSkillFilePath,
  resolveManagedSkillsRoot,
} from "./organization-skills.catalog.js";

export async function resolveCurrentSkillDirectory(skill: OrganizationSkill) {
  const directory = normalizeSkillDirectory(skill);
  if (
    directory
    && (await fs.stat(path.join(directory, "SKILL.md")).catch(() => null))?.isFile()
  ) {
    return directory;
  }
  return null;
}

function isStrictlyWithinPath(root: string, target: string) {
  const relative = path.relative(root, target);
  return Boolean(relative)
    && !relative.startsWith("..")
    && !path.isAbsolute(relative);
}

export async function resolveValidatedLocalSkillFilePath(
  skill: OrganizationSkill,
  relativePath: string,
) {
  const absolutePath = resolveLocalSkillFilePath(skill, relativePath);
  const skillRoot = normalizeSkillDirectory(skill);
  if (!absolutePath || !skillRoot) return null;
  const realRoot = await fs.realpath(skillRoot).catch(() => null);
  if (!realRoot) return null;

  const targetEntry = await fs.lstat(absolutePath).catch(() => null);
  if (targetEntry) {
    const realTarget = await fs.realpath(absolutePath).catch(() => null);
    return realTarget && isStrictlyWithinPath(realRoot, realTarget)
      ? absolutePath
      : null;
  }

  let existingAncestor = path.dirname(absolutePath);
  while (
    !(await fs.lstat(existingAncestor).catch(() => null))
    && existingAncestor !== path.dirname(existingAncestor)
  ) {
    existingAncestor = path.dirname(existingAncestor);
  }
  const realAncestor = await fs.realpath(existingAncestor).catch(() => null);
  if (
    !realAncestor
    || (realAncestor !== realRoot && !isStrictlyWithinPath(realRoot, realAncestor))
  ) {
    return null;
  }
  const projectedTarget = path.resolve(
    realAncestor,
    path.relative(existingAncestor, absolutePath),
  );
  return isStrictlyWithinPath(realRoot, projectedTarget) ? absolutePath : null;
}

export async function assertDirectLocalSourceIsUnmanaged(orgId: string, skill: ImportedSkill) {
  const sourcePath = skill.packageDir ?? skill.sourceLocator;
  if (!sourcePath) throw unprocessable("Local skill source path is missing.");
  const sourceDirectory = path.basename(sourcePath).toLowerCase() === "skill.md"
    ? path.dirname(sourcePath)
    : sourcePath;
  const managedInstalledRoot = path.resolve(resolveManagedSkillsRoot(orgId), "__installed__");
  const [resolvedSource, resolvedManagedRoot] = await Promise.all([
    fs.realpath(path.resolve(sourceDirectory)).catch(() => path.resolve(sourceDirectory)),
    fs.realpath(managedInstalledRoot).catch(() => managedInstalledRoot),
  ]);
  const relative = path.relative(resolvedManagedRoot, resolvedSource);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw unprocessable(
      "Managed organization skill installations cannot be imported as direct local sources.",
    );
  }
}
