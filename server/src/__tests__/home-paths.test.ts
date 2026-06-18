import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentWorkspaceKey } from "../agent-workspace-key.js";
import {
  ensureAgentWorkspaceLayout,
  ensureOrganizationWorkspaceLayout,
  ensureProjectLibraryLayout,
  migrateOrganizationStorageRoot,
  pruneOrphanedOrganizationStorage,
  reconcileOrganizationStorageRoots,
  removeOrganizationStorage,
  resolveAgentInstructionsDir,
  resolveAgentLifeDir,
  resolveAgentMemoryDir,
  resolveAgentSkillsDir,
  resolveDefaultAgentWorkspaceDir,
  resolveLegacyOrganizationRoot,
  resolveOrganizationAgentsDir,
  resolveOrganizationProjectsDir,
  resolveOrganizationRoot,
  resolveOrganizationSkillsDir,
  resolveProjectLibraryDir,
  resolveProjectLibraryRelativePath,
} from "../home-paths.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const orgId = "organization-1";
const uuidOrgId = "87e2f140-3876-4d47-b1e0-71d1bcd772ac";
const shortUuidOrgId = "87e2f1403876";
const agentId = "11111111-1111-4111-8111-111111111111";
const agentName = "Agent One";
const workspaceKey = buildAgentWorkspaceKey(agentName, agentId);
const agent = { id: agentId, orgId, name: agentName, workspaceKey };

describe("home paths", () => {
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalRudderInstanceId = process.env.RUDDER_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
    if (originalRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalRudderInstanceId;

    await Promise.all(Array.from(cleanupDirs).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("creates the canonical agent workspace layout under workspaceKey", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-layout-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const organization = await ensureOrganizationWorkspaceLayout(orgId);
    const agentWorkspace = await ensureAgentWorkspaceLayout(agent);

    expect(organization).toEqual({
      root: path.join(
        rudderHome,
        "instances",
        "test-instance",
        "organizations",
        orgId,
        "workspaces",
      ),
      agentsDir: resolveOrganizationAgentsDir(orgId),
      skillsDir: resolveOrganizationSkillsDir(orgId),
      projectsDir: resolveOrganizationProjectsDir(orgId),
    });
    expect(agentWorkspace).toEqual({
      root: resolveDefaultAgentWorkspaceDir(orgId, workspaceKey),
      instructionsDir: resolveAgentInstructionsDir(orgId, workspaceKey),
      memoryDir: resolveAgentMemoryDir(orgId, workspaceKey),
      lifeDir: resolveAgentLifeDir(orgId, workspaceKey),
      skillsDir: resolveAgentSkillsDir(orgId, workspaceKey),
    });

    await expect(fs.stat(resolveOrganizationAgentsDir(orgId))).resolves.toBeDefined();
    await expect(fs.stat(resolveOrganizationSkillsDir(orgId))).resolves.toBeDefined();
    await expect(fs.stat(path.join(organization.root, "plans"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(organization.root, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(resolveOrganizationProjectsDir(orgId))).resolves.toBeDefined();
    await expect(fs.stat(resolveDefaultAgentWorkspaceDir(orgId, workspaceKey))).resolves.toBeDefined();
    await expect(fs.stat(resolveAgentInstructionsDir(orgId, workspaceKey))).resolves.toBeDefined();
    await expect(fs.stat(resolveAgentMemoryDir(orgId, workspaceKey))).resolves.toBeDefined();
    await expect(fs.stat(resolveAgentLifeDir(orgId, workspaceKey))).resolves.toBeDefined();
    await expect(fs.stat(resolveAgentSkillsDir(orgId, workspaceKey))).resolves.toBeDefined();
  });

  it("uses short organization ids for UUID-backed workspace roots", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-short-org-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const organization = await ensureOrganizationWorkspaceLayout(uuidOrgId);

    expect(resolveOrganizationRoot(uuidOrgId)).toBe(path.join(
      rudderHome,
      "instances",
      "test-instance",
      "organizations",
      shortUuidOrgId,
    ));
    expect(organization.root).toBe(path.join(
      rudderHome,
      "instances",
      "test-instance",
      "organizations",
      shortUuidOrgId,
      "workspaces",
    ));
    await expect(fs.stat(organization.root)).resolves.toBeDefined();
  });

  it("migrates a legacy full UUID organization root to the short organization root", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-org-migration-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const legacyRoot = resolveLegacyOrganizationRoot(uuidOrgId);
    const legacyWorkspaceFile = path.join(legacyRoot, "workspaces", "projects", "demo", "README.md");
    const legacyRuntimeFile = path.join(legacyRoot, "codex-home", "config.toml");
    await fs.mkdir(path.dirname(legacyWorkspaceFile), { recursive: true });
    await fs.mkdir(path.dirname(legacyRuntimeFile), { recursive: true });
    await fs.writeFile(legacyWorkspaceFile, "# Demo\n", "utf8");
    await fs.writeFile(legacyRuntimeFile, "model = \"gpt\"\n", "utf8");

    const result = await migrateOrganizationStorageRoot(uuidOrgId);

    expect(result).toMatchObject({
      canonicalRootPath: resolveOrganizationRoot(uuidOrgId),
      legacyRootPath: legacyRoot,
      migrated: true,
      skippedBecauseTargetExists: false,
    });
    await expect(fs.stat(legacyRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(resolveOrganizationRoot(uuidOrgId), "workspaces", "projects", "demo", "README.md"), "utf8"))
      .resolves.toBe("# Demo\n");
    await expect(fs.readFile(path.join(resolveOrganizationRoot(uuidOrgId), "codex-home", "config.toml"), "utf8"))
      .resolves.toBe("model = \"gpt\"\n");
  });

  it("merges a legacy organization root into an existing short scaffold", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-org-migration-merge-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const legacyRoot = resolveLegacyOrganizationRoot(uuidOrgId);
    const canonicalRoot = resolveOrganizationRoot(uuidOrgId);
    await fs.mkdir(path.join(legacyRoot, "workspaces", "projects", "demo"), { recursive: true });
    await fs.mkdir(path.join(canonicalRoot, "workspaces", "agents"), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "workspaces", "projects", "demo", "README.md"), "# Demo\n", "utf8");

    await expect(migrateOrganizationStorageRoot(uuidOrgId)).resolves.toMatchObject({
      migrated: true,
      mergedIntoExistingTarget: true,
      skippedBecauseTargetExists: false,
    });
    await expect(fs.stat(legacyRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(canonicalRoot, "workspaces", "agents"))).resolves.toBeDefined();
    await expect(fs.readFile(path.join(canonicalRoot, "workspaces", "projects", "demo", "README.md"), "utf8"))
      .resolves.toBe("# Demo\n");
  });

  it("fails migration instead of overwriting conflicting short-root files", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-org-migration-conflict-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const legacyRoot = resolveLegacyOrganizationRoot(uuidOrgId);
    const canonicalRoot = resolveOrganizationRoot(uuidOrgId);
    await fs.mkdir(path.join(legacyRoot, "workspaces"), { recursive: true });
    await fs.mkdir(path.join(canonicalRoot, "workspaces"), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "workspaces", "README.md"), "legacy\n", "utf8");
    await fs.writeFile(path.join(canonicalRoot, "workspaces", "README.md"), "canonical\n", "utf8");

    await expect(migrateOrganizationStorageRoot(uuidOrgId)).rejects.toThrow("Cannot migrate organization storage root");
    await expect(fs.readFile(path.join(legacyRoot, "workspaces", "README.md"), "utf8")).resolves.toBe("legacy\n");
    await expect(fs.readFile(path.join(canonicalRoot, "workspaces", "README.md"), "utf8")).resolves.toBe("canonical\n");
  });

  it("creates a project Library root with a README anchor", async () => {
    const rudderHome = await makeTempDir("rudder-home-project-library-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const project = await ensureProjectLibraryLayout({
      orgId,
      projectId: "22222222-2222-4222-8222-222222222222",
      projectName: "Project Library Demo",
    });

    expect(project.relativePath).toBe("projects/project-library-demo");
    expect(project.root).toBe(resolveProjectLibraryDir({
      orgId,
      projectName: "Project Library Demo",
      projectId: "22222222-2222-4222-8222-222222222222",
    }));
    expect(resolveProjectLibraryRelativePath({
      projectName: "Project Library Demo",
      projectId: "22222222-2222-4222-8222-222222222222",
    })).toBe("projects/project-library-demo");
    await expect(fs.readFile(project.readmePath, "utf8")).resolves.toContain(
      "Agents should keep durable project work files inside this folder.",
    );
  });

  it("does not read or migrate legacy workspace roots", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-legacy-ignore-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const currentLegacyWorkspace = path.join(
      rudderHome,
      "instances",
      "test-instance",
      "organizations",
      orgId,
      "workspaces",
      "agents",
      agentId,
    );
    const olderLegacyWorkspace = path.join(
      rudderHome,
      "instances",
      "test-instance",
      "workspaces",
      agentId,
    );
    const legacyInstructions = path.join(
      rudderHome,
      "instances",
      "test-instance",
      "organizations",
      orgId,
      "agents",
      agentId,
      "instructions",
    );

    await fs.mkdir(path.join(currentLegacyWorkspace, "memory"), { recursive: true });
    await fs.mkdir(path.join(legacyInstructions, "docs"), { recursive: true });
    await fs.mkdir(olderLegacyWorkspace, { recursive: true });
    await fs.writeFile(path.join(currentLegacyWorkspace, "notes.txt"), "legacy org-scoped root\n", "utf8");
    await fs.writeFile(path.join(legacyInstructions, "AGENTS.md"), "# Legacy Agent\n", "utf8");
    await fs.writeFile(path.join(olderLegacyWorkspace, "old.txt"), "legacy workspace\n", "utf8");

    await ensureAgentWorkspaceLayout(agent);

    await expect(fs.readFile(path.join(resolveDefaultAgentWorkspaceDir(orgId, workspaceKey), "notes.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(resolveAgentInstructionsDir(orgId, workspaceKey), "AGENTS.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(currentLegacyWorkspace, "notes.txt"), "utf8")).resolves.toBe("legacy org-scoped root\n");
    await expect(fs.readFile(path.join(legacyInstructions, "AGENTS.md"), "utf8")).resolves.toBe("# Legacy Agent\n");
    await expect(fs.readFile(path.join(olderLegacyWorkspace, "old.txt"), "utf8")).resolves.toBe("legacy workspace\n");
  });

  it("removes the retired legacy projects root without preserving live org contents", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-legacy-projects-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const legacyProjectsRoot = path.join(rudderHome, "instances", "test-instance", "projects");
    const legacyLiveOrgRoot = path.join(legacyProjectsRoot, orgId);
    const legacyPlanPath = path.join(
      legacyLiveOrgRoot,
      "project-1",
      "_default",
      "plans",
      "2026-04-19-plan.md",
    );
    const legacyOrphanRoot = path.join(legacyProjectsRoot, "orphan-org");
    await fs.mkdir(path.dirname(legacyPlanPath), { recursive: true });
    await fs.writeFile(legacyPlanPath, "# Legacy plan\n", "utf8");
    await fs.mkdir(legacyOrphanRoot, { recursive: true });
    await fs.writeFile(path.join(legacyOrphanRoot, "old.txt"), "orphan\n", "utf8");
    await fs.writeFile(path.join(legacyProjectsRoot, ".DS_Store"), "", "utf8");

    const result = await pruneOrphanedOrganizationStorage([orgId]);

    expect(result.removedLegacyProjectDirNames).toEqual([orgId, "orphan-org"]);
    expect(result.removedLegacyProjectsRoot).toBe(true);
    await expect(fs.stat(legacyProjectsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves live canonical and legacy UUID organization roots while pruning orphaned storage", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-prune-short-org-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const canonicalRoot = resolveOrganizationRoot(uuidOrgId);
    const legacyRoot = resolveLegacyOrganizationRoot(uuidOrgId);
    const orphanRoot = path.join(rudderHome, "instances", "test-instance", "organizations", "orphan-org");
    await fs.mkdir(canonicalRoot, { recursive: true });
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.mkdir(orphanRoot, { recursive: true });

    const result = await pruneOrphanedOrganizationStorage([uuidOrgId]);

    expect(result.removedOrganizationDirNames).toEqual(["orphan-org"]);
    await expect(fs.stat(canonicalRoot)).resolves.toBeDefined();
    await expect(fs.stat(legacyRoot)).resolves.toBeDefined();
    await expect(fs.stat(orphanRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles live organization storage by migrating before pruning orphans", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-reconcile-short-org-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const legacyRoot = resolveLegacyOrganizationRoot(uuidOrgId);
    const canonicalRoot = resolveOrganizationRoot(uuidOrgId);
    const orphanRoot = path.join(rudderHome, "instances", "test-instance", "organizations", "orphan-org");
    await fs.mkdir(path.join(legacyRoot, "workspaces", "projects"), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "workspaces", "projects", "plan.md"), "# Plan\n", "utf8");
    await fs.mkdir(orphanRoot, { recursive: true });

    const result = await reconcileOrganizationStorageRoots([uuidOrgId]);

    expect(result.migrations).toEqual([
      expect.objectContaining({
        migrated: true,
        canonicalRootPath: canonicalRoot,
        legacyRootPath: legacyRoot,
      }),
    ]);
    expect(result.pruned.removedOrganizationDirNames).toEqual(["orphan-org"]);
    await expect(fs.stat(legacyRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(canonicalRoot, "workspaces", "projects", "plan.md"), "utf8"))
      .resolves.toBe("# Plan\n");
    await expect(fs.stat(orphanRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to reconcile colliding organization storage keys", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-reconcile-collision-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    await expect(reconcileOrganizationStorageRoots([
      "87e2f140-3876-4d47-b1e0-71d1bcd772ac",
      "87e2f1403876",
    ])).rejects.toThrow("Organization storage key collision");
  });

  it("removes both canonical and legacy UUID organization roots", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-remove-short-org-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const canonicalRoot = resolveOrganizationRoot(uuidOrgId);
    const legacyRoot = resolveLegacyOrganizationRoot(uuidOrgId);
    await fs.mkdir(canonicalRoot, { recursive: true });
    await fs.mkdir(legacyRoot, { recursive: true });

    await removeOrganizationStorage(uuidOrgId);

    await expect(fs.stat(canonicalRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(legacyRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
