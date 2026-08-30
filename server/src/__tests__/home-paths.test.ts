import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentWorkspaceKey } from "../agent-workspace-key.js";
import {
  ensureAgentWorkspaceLayout,
  ensureOrganizationWorkspaceLayout,
  ensureProjectLibraryLayout,
  migrateOrganizationStorageRoot,
  migrateOrganizationWorkspaceRoot,
  pruneOrphanedOrganizationStorage,
  reconcileOrganizationStorageRoots,
  removeOrganizationStorage,
  resolveAgentInstructionsDir,
  resolveAgentLifeDir,
  resolveAgentMemoryDir,
  resolveAgentSkillsDir,
  resolveDefaultAgentWorkspaceDir,
  resolveLegacyOrganizationRoot,
  resolveLegacyOrganizationWorkspaceRoot,
  resolveOrganizationAgentsDir,
  resolveOrganizationProjectsDir,
  resolveOrganizationRoot,
  resolveOrganizationSkillsDir,
  resolveOrganizationWorkspaceHomeDir,
  resolveOrganizationWorkspaceMapPath,
  resolveOrganizationWorkspaceRoot,
  resolvePreviousDocumentsOrganizationWorkspaceRoot,
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
  const originalOrganizationWorkspaceHome = process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
    if (originalRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalRudderInstanceId;
    if (originalOrganizationWorkspaceHome === undefined) delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
    else process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = originalOrganizationWorkspaceHome;

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
    delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;

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

  it("keeps organization workspaces under the explicit RUDDER_HOME instance root", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-explicit-home-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;

    expect(resolveOrganizationWorkspaceHomeDir()).toBe(path.join(
      rudderHome,
      "instances",
      "test-instance",
      "organizations",
    ));
    expect(resolveOrganizationWorkspaceRoot(orgId)).toBe(path.join(
      rudderHome,
      "instances",
      "test-instance",
      "organizations",
      orgId,
      "workspaces",
    ));
  });

  it("migrates an existing organization workspace into the configured user workspace home", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-workspace-migration-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const legacyWorkspaceRoot = resolveLegacyOrganizationWorkspaceRoot(orgId);
    const legacyWorkspaceFile = path.join(legacyWorkspaceRoot, "projects", "demo", "README.md");
    await fs.mkdir(path.dirname(legacyWorkspaceFile), { recursive: true });
    await fs.writeFile(legacyWorkspaceFile, "# Demo\n", "utf8");

    const result = await migrateOrganizationWorkspaceRoot(orgId);

    expect(result).toMatchObject({
      canonicalRootPath: path.join(workspaceHome, orgId),
      legacyRootPath: legacyWorkspaceRoot,
      migrated: true,
      mergedIntoExistingTarget: false,
      skippedBecauseTargetExists: false,
    });
    expect((await fs.lstat(legacyWorkspaceRoot)).isSymbolicLink()).toBe(true);
    await expect(fs.realpath(legacyWorkspaceRoot)).resolves.toBe(
      await fs.realpath(resolveOrganizationWorkspaceRoot(orgId)),
    );
    await expect(fs.readFile(path.join(resolveOrganizationWorkspaceRoot(orgId), "projects", "demo", "README.md"), "utf8"))
      .resolves.toBe("# Demo\n");
  });

  it("keeps an active process cwd valid while migrating its organization workspace", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-active-cwd-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-active-cwd-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const legacyRoot = resolveLegacyOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(legacyRoot, { recursive: true });
    const child = spawn(process.execPath, [
      "-e",
      "process.stdout.write(process.cwd() + '\\n'); process.stdin.once('data', () => { process.stdout.write(process.cwd() + '\\n'); });",
    ], { cwd: legacyRoot, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    await once(child.stdout, "data");

    await migrateOrganizationWorkspaceRoot(orgId);
    child.stdin.write("continue\n");
    child.stdin.end();
    const [exitCode] = await once(child, "exit");

    expect(exitCode).toBe(0);
    const cwdLines = Buffer.concat(stdout).toString("utf8").trim().split("\n");
    expect(cwdLines).toHaveLength(2);
    expect(await fs.realpath(cwdLines[1]!)).toBe(await fs.realpath(resolveOrganizationWorkspaceRoot(orgId)));
  });

  it("allocates friendly organization workspace folders under the configured user workspace home", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-friendly-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-friendly-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const first = await ensureOrganizationWorkspaceLayout({
      id: "organization-1",
      name: "Acme Inc.",
      urlKey: "acme",
    });
    const second = await ensureOrganizationWorkspaceLayout({
      id: "organization-2",
      name: "Acme Inc.",
      urlKey: "acme-2",
    });

    expect(first.root).toBe(path.join(workspaceHome, "acme-inc"));
    expect(second.root).toBe(path.join(workspaceHome, "acme-inc-2"));
    await expect(fs.readFile(resolveOrganizationWorkspaceMapPath(), "utf8")).resolves.toContain("\"folderName\": \"acme-inc\"");
    expect(resolveOrganizationWorkspaceRoot("organization-1")).toBe(first.root);
  });

  it("keeps the friendly organization workspace map valid during concurrent layout creation", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-friendly-concurrent-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-friendly-concurrent-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        ensureOrganizationWorkspaceLayout({
          id: `organization-${index + 1}`,
          name: `Concurrent Org ${index + 1}`,
          urlKey: `concurrent-org-${index + 1}`,
        }),
      ),
    );

    const rawMap = await fs.readFile(resolveOrganizationWorkspaceMapPath(), "utf8");
    const parsed = JSON.parse(rawMap) as {
      version?: number;
      organizations?: Array<{ orgId?: string; folderName?: string }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.organizations).toHaveLength(12);
    expect(parsed.organizations?.map((entry) => entry.orgId).sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `organization-${index + 1}`).sort(),
    );
    expect(parsed.organizations?.map((entry) => entry.folderName).sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `concurrent-org-${index + 1}`).sort(),
    );
  });

  it("migrates the previous Documents instance workspace root into the friendly folder", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-documents-migration-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-documents-migration-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    await ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Demo Org",
      urlKey: "demo-org",
    });
    await fs.rm(resolveOrganizationWorkspaceRoot(orgId), { recursive: true, force: true });

    const previousRoot = resolvePreviousDocumentsOrganizationWorkspaceRoot(orgId);
    const previousFile = path.join(previousRoot, "projects", "demo", "README.md");
    await fs.mkdir(path.dirname(previousFile), { recursive: true });
    await fs.writeFile(previousFile, "# Previous\n", "utf8");

    const result = await migrateOrganizationWorkspaceRoot(orgId);

    expect(result).toMatchObject({
      canonicalRootPath: path.join(workspaceHome, "demo-org"),
      legacyRootPath: previousRoot,
      migrated: true,
    });
    expect((await fs.lstat(previousRoot)).isSymbolicLink()).toBe(true);
    await expect(fs.realpath(previousRoot)).resolves.toBe(
      await fs.realpath(resolveOrganizationWorkspaceRoot(orgId)),
    );
    await expect(fs.readFile(path.join(resolveOrganizationWorkspaceRoot(orgId), "projects", "demo", "README.md"), "utf8"))
      .resolves.toBe("# Previous\n");
  });

  it("archives identical files while merging a legacy workspace into the friendly folder", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-identical-merge-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-identical-merge-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const layout = await ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Identical Merge Org",
      urlKey: "identical-merge-org",
    });
    const legacyRoot = resolveLegacyOrganizationWorkspaceRoot(orgId);
    const relativeSharedPath = path.join("agents", "agent-1", "instructions", "MEMORY.md");
    const canonicalSharedPath = path.join(layout.root, relativeSharedPath);
    const legacySharedPath = path.join(legacyRoot, relativeSharedPath);
    const legacyOnlyPath = path.join(legacyRoot, "projects", "legacy", "README.md");
    const canonicalOnlyPath = path.join(layout.root, "projects", "canonical", "README.md");
    await fs.mkdir(path.dirname(canonicalSharedPath), { recursive: true });
    await fs.mkdir(path.dirname(legacySharedPath), { recursive: true });
    await fs.mkdir(path.dirname(legacyOnlyPath), { recursive: true });
    await fs.mkdir(path.dirname(canonicalOnlyPath), { recursive: true });
    await fs.writeFile(canonicalSharedPath, "# Shared memory\n", "utf8");
    await fs.writeFile(legacySharedPath, "# Shared memory\n", "utf8");
    await fs.writeFile(legacyOnlyPath, "# Legacy project\n", "utf8");
    await fs.writeFile(canonicalOnlyPath, "# Canonical project\n", "utf8");

    await expect(migrateOrganizationWorkspaceRoot(orgId)).resolves.toMatchObject({
      canonicalRootPath: layout.root,
      legacyRootPath: legacyRoot,
      migrated: true,
      mergedIntoExistingTarget: true,
      skippedBecauseTargetExists: false,
    });
    expect((await fs.lstat(legacyRoot)).isSymbolicLink()).toBe(true);
    await expect(fs.realpath(legacyRoot)).resolves.toBe(await fs.realpath(layout.root));
    await expect(fs.readFile(canonicalSharedPath, "utf8")).resolves.toBe("# Shared memory\n");
    await expect(fs.readFile(path.join(layout.root, "projects", "legacy", "README.md"), "utf8"))
      .resolves.toBe("# Legacy project\n");
    await expect(fs.readFile(canonicalOnlyPath, "utf8")).resolves.toBe("# Canonical project\n");
    const backupHome = path.join(path.dirname(legacyRoot), ".rudder-migration-backups");
    const backupDirs = await fs.readdir(backupHome);
    expect(backupDirs).toHaveLength(1);
    await expect(fs.readFile(path.join(backupHome, backupDirs[0]!, relativeSharedPath), "utf8"))
      .resolves.toBe("# Shared memory\n");
  });

  it("fails instead of recreating an empty folder when a mapped organization folder is missing", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-missing-friendly-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-missing-friendly-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const layout = await ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Missing Folder Org",
      urlKey: "missing-folder-org",
    });
    await fs.rm(layout.root, { recursive: true, force: true });

    await expect(ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Missing Folder Org",
      urlKey: "missing-folder-org",
    })).rejects.toThrow(/could not find the mapped organization Library folder/i);
    await expect(fs.stat(layout.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails string layout calls instead of recreating an empty mapped organization folder", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-string-missing-friendly-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-string-missing-friendly-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const layout = await ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "String Missing Folder Org",
      urlKey: "string-missing-folder-org",
    });
    await fs.rm(layout.root, { recursive: true, force: true });

    await expect(ensureOrganizationWorkspaceLayout(orgId)).rejects.toThrow(
      /could not find the mapped organization Library folder/i,
    );
    await expect(fs.stat(layout.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails startup reconciliation when an existing mapped organization folder is missing", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-reconcile-missing-friendly-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-reconcile-missing-friendly-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const org = {
      id: orgId,
      name: "Reconcile Missing Folder Org",
      urlKey: "reconcile-missing-folder-org",
    };
    const layout = await ensureOrganizationWorkspaceLayout(org);
    await fs.rm(layout.root, { recursive: true, force: true });

    await expect(reconcileOrganizationStorageRoots([org])).rejects.toThrow(
      /could not find the mapped organization Library folder/i,
    );
    await expect(fs.stat(layout.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps startup reconciliation available when macOS blocks the organization workspace map", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-reconcile-permission-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-reconcile-permission-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const org = {
      id: orgId,
      name: "Permission Blocked Org",
      urlKey: "permission-blocked-org",
    };
    const layout = await ensureOrganizationWorkspaceLayout(org);
    const mapPath = resolveOrganizationWorkspaceMapPath();
    const originalReadFile = fs.readFile;
    const permissionError = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
      path: mapPath,
    });
    fs.readFile = vi.fn(async (targetPath, options) => {
      if (path.resolve(String(targetPath)) === mapPath) throw permissionError;
      return originalReadFile.call(fs, targetPath, options as never);
    }) as typeof fs.readFile;

    try {
      const result = await reconcileOrganizationStorageRoots([org]);

      expect(result.workspacePermissionFailures).toEqual([
        expect.objectContaining({
          orgId,
          code: "EPERM",
          message: expect.stringMatching(/grant Rudder permission to access Documents/i),
        }),
      ]);
      expect(result.workspaceAvailableOrganizationIds).toEqual([]);
      await expect(fs.stat(layout.root)).resolves.toBeDefined();
    } finally {
      fs.readFile = originalReadFile;
    }
  });

  it("explains how to repair a blocked organization workspace map", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-map-permission-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-map-permission-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const org = {
      id: orgId,
      name: "Permission Blocked Org",
      urlKey: "permission-blocked-org",
    };
    await ensureOrganizationWorkspaceLayout(org);
    const mapPath = resolveOrganizationWorkspaceMapPath();
    const originalReadFile = fs.readFile;
    const permissionError = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
      path: mapPath,
    });
    fs.readFile = vi.fn(async (targetPath, options) => {
      if (path.resolve(String(targetPath)) === mapPath) throw permissionError;
      return originalReadFile.call(fs, targetPath, options as never);
    }) as typeof fs.readFile;

    try {
      await expect(ensureOrganizationWorkspaceLayout(org)).rejects.toThrow(
        /could not read the organization workspace mapping.*EPERM.*grant Rudder permission to access Documents/i,
      );
    } finally {
      fs.readFile = originalReadFile;
    }
  });

  it("reclaims an identified friendly folder when the mapping file is missing", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-reclaim-friendly-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-reclaim-friendly-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const existingRoot = path.join(workspaceHome, "reclaim-org");
    const existingFile = path.join(existingRoot, "projects", "demo", "README.md");
    await fs.mkdir(path.dirname(existingFile), { recursive: true });
    await fs.writeFile(existingFile, "# Reclaim\n", "utf8");
    await fs.writeFile(
      path.join(existingRoot, ".rudder-workspace.json"),
      `${JSON.stringify({ version: 1, orgId }, null, 2)}\n`,
      "utf8",
    );

    const layout = await ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Reclaim Org",
      urlKey: "reclaim-org",
    });

    expect(layout.root).toBe(existingRoot);
    await expect(fs.readFile(existingFile, "utf8")).resolves.toBe("# Reclaim\n");
    await expect(fs.readFile(resolveOrganizationWorkspaceMapPath(), "utf8")).resolves.toContain(
      "\"folderName\": \"reclaim-org\"",
    );
  });

  it("does not claim an unmarked friendly folder when the mapping file is missing", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-unmarked-friendly-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-unmarked-friendly-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const existingRoot = path.join(workspaceHome, "reclaim-org");
    const existingFile = path.join(existingRoot, "agents", "agent-1", "memory", "2026-08-30.md");
    await fs.mkdir(path.dirname(existingFile), { recursive: true });
    await fs.writeFile(existingFile, "preserve me\n", "utf8");

    const layout = await ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Reclaim Org",
      urlKey: "reclaim-org",
    });

    expect(layout.root).toBe(path.join(workspaceHome, "reclaim-org-2"));
    await expect(fs.readFile(existingFile, "utf8")).resolves.toBe("preserve me\n");
  });

  it("fails instead of resetting a corrupt organization workspace mapping file", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-corrupt-map-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-corrupt-map-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    await fs.mkdir(workspaceHome, { recursive: true });
    await fs.writeFile(resolveOrganizationWorkspaceMapPath(), "{\"version\":2,\"organizations\":[]}\n", "utf8");

    await expect(ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Corrupt Map Org",
      urlKey: "corrupt-map-org",
    })).rejects.toThrow(/Invalid organization workspace mapping file/);
    await expect(fs.stat(path.join(workspaceHome, "corrupt-map-org"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses short organization ids for UUID-backed workspace roots", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-short-org-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;

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

  it("fails migration instead of discarding executable mode differences", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-org-migration-mode-conflict-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const legacyRoot = resolveLegacyOrganizationRoot(uuidOrgId);
    const canonicalRoot = resolveOrganizationRoot(uuidOrgId);
    const legacyFile = path.join(legacyRoot, "workspaces", "script.sh");
    const canonicalFile = path.join(canonicalRoot, "workspaces", "script.sh");
    await fs.mkdir(path.dirname(legacyFile), { recursive: true });
    await fs.mkdir(path.dirname(canonicalFile), { recursive: true });
    await fs.writeFile(legacyFile, "#!/bin/sh\n", { mode: 0o755 });
    await fs.writeFile(canonicalFile, "#!/bin/sh\n", { mode: 0o644 });

    await expect(migrateOrganizationStorageRoot(uuidOrgId)).rejects.toThrow(
      "Cannot migrate organization storage root",
    );
    expect((await fs.stat(legacyFile)).mode & 0o111).toBe(0o111);
    expect((await fs.stat(canonicalFile)).mode & 0o111).toBe(0);
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

  it("preserves migration backups while pruning orphaned organization storage", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-prune-migration-backups-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const backupRoot = path.join(
      rudderHome,
      "instances",
      "test-instance",
      "organizations",
      ".rudder-migration-backups",
      "organization-legacy-copy",
    );
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.writeFile(path.join(backupRoot, "MEMORY.md"), "# Preserved\n", "utf8");

    const result = await pruneOrphanedOrganizationStorage([]);

    expect(result.removedOrganizationDirNames).toEqual([]);
    await expect(fs.readFile(path.join(backupRoot, "MEMORY.md"), "utf8")).resolves.toBe("# Preserved\n");
  });

  it("does not prune orphaned organization workspace roots from the configured user workspace home", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-prune-workspaces-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-prune-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const liveWorkspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    const orphanWorkspaceRoot = path.join(workspaceHome, "orphan-org");
    await fs.mkdir(liveWorkspaceRoot, { recursive: true });
    await fs.mkdir(orphanWorkspaceRoot, { recursive: true });

    const result = await pruneOrphanedOrganizationStorage([orgId]);

    expect(result.removedWorkspaceDirNames).toEqual([]);
    await expect(fs.stat(liveWorkspaceRoot)).resolves.toBeDefined();
    await expect(fs.stat(orphanWorkspaceRoot)).resolves.toBeDefined();
  });

  it("explains permission failures when creating a fresh organization workspace", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-create-permission-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-create-permission-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const originalMkdir = fs.mkdir;
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    fs.mkdir = vi.fn(async (targetPath, options) => {
      if (path.resolve(String(targetPath)) === resolveOrganizationWorkspaceRoot(orgId)) {
        throw permissionError;
      }
      return originalMkdir.call(fs, targetPath, options);
    }) as typeof fs.mkdir;

    try {
      await expect(ensureOrganizationWorkspaceLayout(orgId)).rejects.toThrow(
        /could not create the organization workspace.*EACCES.*Windows.*administrator/i,
      );
    } finally {
      fs.mkdir = originalMkdir;
    }
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
    expect(result.workspaceAvailableOrganizationIds).toEqual([uuidOrgId]);
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
