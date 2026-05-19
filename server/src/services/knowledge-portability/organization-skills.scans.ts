import os from "node:os";
import path from "node:path";
import type {
  OrganizationSkill,
  OrganizationSkillLocalScanConflict,
  OrganizationSkillLocalScanRequest,
  OrganizationSkillLocalScanResult,
  OrganizationSkillLocalScanSkipped,
  OrganizationSkillProjectScanConflict,
  OrganizationSkillProjectScanRequest,
  OrganizationSkillProjectScanResult,
  OrganizationSkillProjectScanSkipped,
} from "@rudderhq/shared";
import type { projectService } from "../projects.js";
import {
  asString,
  normalizeSkillDirectory,
  normalizeSkillSlug,
  normalizeSourceLocatorDirectory,
  statPath,
} from "./organization-skills.catalog.js";
import type { ImportedSkill, ProjectSkillScanTarget } from "./organization-skills.catalog.js";
import {
  discoverProjectWorkspaceSkillDirectories,
  readLocalSkillImportFromDirectory,
  readLocalSkillImports,
} from "./organization-skills.sources.js";

type ProjectLookup = Pick<ReturnType<typeof projectService>, "list" | "listByIds">;

type OrganizationSkillScanContext = {
  ensureSkillInventoryCurrent: (orgId: string) => Promise<void>;
  listFull: (orgId: string) => Promise<OrganizationSkill[]>;
  projects: ProjectLookup;
  upsertImportedSkills: (orgId: string, imported: ImportedSkill[]) => Promise<OrganizationSkill[]>;
};

export function createOrganizationSkillScanHandlers(context: OrganizationSkillScanContext) {
  const { ensureSkillInventoryCurrent, listFull, projects, upsertImportedSkills } = context;

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

  return {
    scanProjectWorkspaces,
    scanLocalSkillRoots,
  };
}
