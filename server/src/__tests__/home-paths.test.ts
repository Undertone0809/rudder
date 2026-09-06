import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const serverPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

  it("keeps an active nested legacy cwd writing to the canonical root during a merge", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-active-nested-cwd-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-active-nested-cwd-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const layout = await ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Active Nested Cwd Org",
      urlKey: "active-nested-cwd-org",
    });
    const relativeCwd = path.join("agents", "noah", "memory");
    const canonicalCwd = path.join(layout.root, relativeCwd);
    const legacyRoot = resolveLegacyOrganizationWorkspaceRoot(orgId);
    const legacyCwd = path.join(legacyRoot, relativeCwd);
    await fs.mkdir(canonicalCwd, { recursive: true });
    await fs.mkdir(legacyCwd, { recursive: true });
    await fs.writeFile(path.join(canonicalCwd, "shared.md"), "shared\n", "utf8");
    await fs.writeFile(path.join(legacyCwd, "shared.md"), "shared\n", "utf8");

    const child = spawn(process.execPath, [
      "-e",
      [
        "const fs = require('node:fs/promises');",
        "const path = require('node:path');",
        "process.stdout.write(process.cwd() + '\\n');",
        "process.stdin.once('data', async () => {",
        "  await fs.writeFile(path.join(process.cwd(), 'post-migration.md'), 'post-migration\\n');",
        "  process.stdout.write(process.cwd() + '\\n');",
        "});",
      ].join(" "),
    ], { cwd: legacyCwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    await once(child.stdout, "data");

    await migrateOrganizationWorkspaceRoot(orgId);
    child.stdin.write("continue\n");
    child.stdin.end();
    const [exitCode] = await once(child, "exit");

    expect(exitCode).toBe(0);
    expect(Buffer.concat(stdout).toString("utf8").trim().split("\n")).toHaveLength(2);
    await expect(fs.readFile(path.join(canonicalCwd, "post-migration.md"), "utf8"))
      .resolves.toBe("post-migration\n");
  });

  it("fails before changing workspace contents when migration crosses filesystems", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-cross-device-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-cross-device-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const layout = await ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Cross Device Org",
      urlKey: "cross-device-org",
    });
    const legacyRoot = resolveLegacyOrganizationWorkspaceRoot(orgId);
    const canonicalFile = path.join(layout.root, "projects", "canonical", "README.md");
    const legacyFile = path.join(legacyRoot, "projects", "legacy", "README.md");
    await fs.mkdir(path.dirname(canonicalFile), { recursive: true });
    await fs.mkdir(path.dirname(legacyFile), { recursive: true });
    await fs.writeFile(canonicalFile, "# Canonical\n", "utf8");
    await fs.writeFile(legacyFile, "# Legacy\n", "utf8");

    const canonicalParent = path.dirname(layout.root);
    const legacyParent = path.dirname(legacyRoot);
    const originalStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await originalStat(...args);
      const targetPath = typeof args[0] === "string" ? path.resolve(args[0]) : null;
      if (targetPath === canonicalParent) Object.defineProperty(result, "dev", { value: 101 });
      if (targetPath === legacyParent) Object.defineProperty(result, "dev", { value: 202 });
      return result;
    });

    try {
      await expect(migrateOrganizationWorkspaceRoot(orgId)).rejects.toMatchObject({
        code: "RUDDER_WORKSPACE_CROSS_DEVICE_MIGRATION",
      });
    } finally {
      statSpy.mockRestore();
    }

    await expect(fs.readFile(canonicalFile, "utf8")).resolves.toBe("# Canonical\n");
    await expect(fs.readFile(legacyFile, "utf8")).resolves.toBe("# Legacy\n");
    expect((await fs.lstat(legacyRoot)).isSymbolicLink()).toBe(false);
  });

  it("fails closed before moving a nested workspace entry across filesystems", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-nested-cross-device-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-nested-cross-device-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const layout = await ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Nested Cross Device Org",
      urlKey: "nested-cross-device-org",
    });
    const legacyRoot = resolveLegacyOrganizationWorkspaceRoot(orgId);
    const canonicalFile = path.join(layout.root, "projects", "canonical", "README.md");
    const legacyFile = path.join(legacyRoot, "projects", "legacy", "README.md");
    await fs.mkdir(path.dirname(canonicalFile), { recursive: true });
    await fs.mkdir(path.dirname(legacyFile), { recursive: true });
    await fs.writeFile(canonicalFile, "canonical\n", "utf8");
    await fs.writeFile(legacyFile, "legacy\n", "utf8");

    const sourceParent = path.join(layout.root, "projects");
    const targetParent = path.join(legacyRoot, "projects");
    const originalStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await originalStat(...args);
      const targetPath = typeof args[0] === "string" ? path.resolve(args[0]) : null;
      if (targetPath === sourceParent) Object.defineProperty(result, "dev", { value: 101 });
      if (targetPath === targetParent) Object.defineProperty(result, "dev", { value: 202 });
      return result;
    });

    try {
      await expect(migrateOrganizationWorkspaceRoot(orgId)).rejects.toMatchObject({
        code: "RUDDER_WORKSPACE_CROSS_DEVICE_MIGRATION",
      });
    } finally {
      statSpy.mockRestore();
    }

    await expect(fs.readFile(canonicalFile, "utf8")).resolves.toBe("canonical\n");
    await expect(fs.readFile(legacyFile, "utf8")).resolves.toBe("legacy\n");
    await expect(fs.stat(path.join(legacyRoot, "projects", "canonical", "README.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
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

  it("treats friendly workspace mappings as case-insensitive during allocation", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-friendly-case-duplicate-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-friendly-case-duplicate-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    await fs.writeFile(
      resolveOrganizationWorkspaceMapPath(),
      `${JSON.stringify({
        version: 1,
        organizations: [{
          instanceId: "test-instance",
          orgId: "existing-org",
          folderName: "Acme",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }],
      }, null, 2)}\n`,
      "utf8",
    );

    const layout = await ensureOrganizationWorkspaceLayout({
      id: "new-org",
      name: "Acme",
      urlKey: "acme",
    });

    expect(layout.root).toBe(path.join(workspaceHome, "acme-2"));
  });

  it("keeps reserved friendly names away from shared workspace directories", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-friendly-reserved-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-friendly-reserved-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const layout = await ensureOrganizationWorkspaceLayout({
      id: "reserved-name-org",
      name: "Projects",
      urlKey: "organizations",
    });

    expect(layout.root).toBe(path.join(workspaceHome, "reserved-name-org"));
    expect(layout.root).not.toBe(path.join(workspaceHome, "projects"));
    expect(layout.root).not.toBe(path.join(workspaceHome, "organizations"));
  });

  it("keeps string organization IDs away from reserved friendly workspace directories", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-string-reserved-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-string-reserved-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const sentinel = path.join(workspaceHome, "projects", "keep.txt");
    await fs.mkdir(path.dirname(sentinel), { recursive: true });
    await fs.writeFile(sentinel, "preserve me\n", "utf8");

    const layout = await ensureOrganizationWorkspaceLayout("projects");

    expect(layout.root).toBe(path.join(workspaceHome, "organization-projects"));
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me\n");
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

  it("rejects a friendly workspace mapping that is not a single safe path segment", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-invalid-folder-map-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-invalid-folder-map-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    await fs.writeFile(
      resolveOrganizationWorkspaceMapPath(),
      `${JSON.stringify({
        version: 1,
        organizations: [{
          instanceId: "test-instance",
          orgId,
          folderName: "../outside",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }],
      }, null, 2)}\n`,
      "utf8",
    );

    expect(() => resolveOrganizationWorkspaceRoot(orgId)).toThrow(/Invalid organization workspace folder mapping/);
  });

  it("rejects reserved mappings before organization cleanup can remove sibling data", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-reserved-mapping-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-reserved-mapping-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const sharedProjectsRoot = path.join(workspaceHome, "projects");
    const sentinel = path.join(sharedProjectsRoot, "keep.txt");
    await fs.mkdir(sharedProjectsRoot, { recursive: true });
    await fs.writeFile(sentinel, "preserve me\n", "utf8");
    await fs.writeFile(
      resolveOrganizationWorkspaceMapPath(),
      `${JSON.stringify({
        version: 1,
        organizations: [{
          instanceId: "test-instance",
          orgId,
          folderName: "projects",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }],
      }, null, 2)}\n`,
      "utf8",
    );

    expect(() => resolveOrganizationWorkspaceRoot(orgId)).toThrow(/reserved/);
    await expect(removeOrganizationStorage(orgId)).rejects.toThrow(/reserved/);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me\n");
  });

  it("fails closed when removing a mapped workspace without a matching identity", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-remove-missing-identity-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-remove-missing-identity-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const workspaceRoot = path.join(workspaceHome, "mapped-org");
    const sentinel = path.join(workspaceRoot, "keep.txt");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(sentinel, "preserve me\n", "utf8");
    await fs.writeFile(
      resolveOrganizationWorkspaceMapPath(),
      `${JSON.stringify({
        version: 1,
        organizations: [{
          instanceId: "test-instance",
          orgId,
          folderName: "mapped-org",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }],
      }, null, 2)}\n`,
      "utf8",
    );

    await expect(removeOrganizationStorage(orgId)).rejects.toThrow(/identity does not match/);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me\n");
  });

  it("fails closed when a workspace mapping is shared by another organization", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-remove-duplicate-mapping-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-remove-duplicate-mapping-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const workspaceRoot = path.join(workspaceHome, "shared-org");
    const sentinel = path.join(workspaceRoot, "keep.txt");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(sentinel, "preserve me\n", "utf8");
    await fs.writeFile(
      path.join(workspaceRoot, ".rudder-workspace.json"),
      `${JSON.stringify({ version: 1, orgId }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      resolveOrganizationWorkspaceMapPath(),
      `${JSON.stringify({
        version: 1,
        organizations: [
          {
            instanceId: "test-instance",
            orgId,
            folderName: "shared-org",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            instanceId: "test-instance",
            orgId: "other-org",
            folderName: "Shared-Org",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    await expect(removeOrganizationStorage(orgId)).rejects.toThrow(/also mapped to organization 'other-org'/);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me\n");
  });

  it("fails closed before cleanup when the workspace mapping is corrupt", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-remove-corrupt-map-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-remove-corrupt-map-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const fallbackRoot = path.join(workspaceHome, orgId);
    const sentinel = path.join(fallbackRoot, "keep.txt");
    await fs.mkdir(fallbackRoot, { recursive: true });
    await fs.writeFile(sentinel, "preserve me\n", "utf8");
    await fs.writeFile(resolveOrganizationWorkspaceMapPath(), "{\"version\":1,\n", "utf8");

    await expect(removeOrganizationStorage(orgId)).rejects.toThrow(/Invalid organization workspace mapping/);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me\n");
  });

  it("fails closed before cleanup when an individual workspace map record is malformed", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-remove-malformed-record-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-remove-malformed-record-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const workspaceRoot = path.join(workspaceHome, "malformed-record-org");
    const sentinel = path.join(workspaceRoot, "keep.txt");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(sentinel, "preserve me\n", "utf8");
    await fs.writeFile(
      path.join(workspaceRoot, ".rudder-workspace.json"),
      `${JSON.stringify({ version: 1, orgId }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      resolveOrganizationWorkspaceMapPath(),
      `${JSON.stringify({
        version: 1,
        organizations: [
          {
            instanceId: "test-instance",
            orgId,
            folderName: "malformed-record-org",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            instanceId: "test-instance",
            orgId: "another-org",
            folderName: "another-org",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    await expect(removeOrganizationStorage(orgId)).rejects.toThrow(/Invalid organization workspace mapping/);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me\n");
    await expect(fs.readFile(resolveOrganizationWorkspaceMapPath(), "utf8")).resolves.toContain("another-org");
  });

  it("serializes direct organization storage migrations across processes", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-storage-migration-lock-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;

    const secondUuidOrgId = "98f3a140-3876-4d47-b1e0-71d1bcd772ac";
    const migrations = [
      { id: uuidOrgId, marker: "storage-a.txt" },
      { id: secondUuidOrgId, marker: "storage-b.txt" },
    ];
    await Promise.all(migrations.map(async ({ id, marker }) => {
      const markerPath = path.join(resolveLegacyOrganizationRoot(id), "workspaces", marker);
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, `${id}\n`, "utf8");
    }));

    const script = [
      "import { migrateOrganizationStorageRoot } from './src/home-paths.ts';",
      "await migrateOrganizationStorageRoot(process.argv[1]);",
    ].join("\n");
    const runChild = (id: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        id,
      ], {
        cwd: serverPackageRoot,
        env: {
          ...process.env,
          RUDDER_HOME: rudderHome,
          RUDDER_INSTANCE_ID: "test-instance",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(Buffer.concat(stderr).toString("utf8") || `child exited ${code}`));
      });
    });

    await Promise.all(migrations.map(({ id }) => runChild(id)));
    await Promise.all(migrations.map(async ({ id, marker }) => {
      await expect(fs.stat(resolveLegacyOrganizationRoot(id))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(resolveOrganizationRoot(id), "workspaces", marker), "utf8"))
        .resolves.toBe(`${id}\n`);
    }));
  });

  it("never deletes a pre-existing workspace that collides with the mapping lock path", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-lock-collision-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-lock-collision-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const collidingRoot = path.join(workspaceHome, ".rudder-organizations.lock");
    const sentinel = path.join(collidingRoot, "agents", "noah", "memory", "2026-08-30.md");
    await fs.mkdir(path.dirname(sentinel), { recursive: true });
    await fs.writeFile(sentinel, "preserve me\n", "utf8");

    await expect(ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: ".rudder-organizations.lock",
      urlKey: "legacy-lock-name",
    })).rejects.toMatchObject({ code: "RUDDER_WORKSPACE_MAP_LOCK_COLLISION" });
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me\n");
  });

  it("does not let an expired lock owner remove a successor lock during release", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-lock-successor-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-lock-successor-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const lockPath = path.join(workspaceHome, ".rudder-organizations.lock");
    const successorToken = "successor-owner";
    const successorOwnerPath = path.join(lockPath, `.rudder-lock-owner-${successorToken}.json`);
    const mapPath = resolveOrganizationWorkspaceMapPath();
    const originalRename = fs.rename;
    fs.rename = vi.fn(async (sourcePath, targetPath) => {
      if (path.resolve(String(targetPath)) === mapPath) {
        const ownerFiles = await fs.readdir(lockPath);
        await fs.rm(path.join(lockPath, ownerFiles[0]!), { force: true });
        await fs.writeFile(successorOwnerPath, "successor\n", "utf8");
      }
      return await originalRename.call(fs, sourcePath, targetPath);
    }) as typeof fs.rename;

    try {
      await ensureOrganizationWorkspaceLayout({
        id: orgId,
        name: "Successor Lock Org",
        urlKey: "successor-lock-org",
      });
      await expect(fs.readFile(successorOwnerPath, "utf8")).resolves.toBe("successor\n");
    } finally {
      fs.rename = originalRename;
    }
  });

  it("waits for a transient empty acquisition directory instead of treating it as user data", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-lock-acquiring-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-lock-acquiring-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const lockPath = path.join(workspaceHome, ".rudder-organizations.lock");
    await fs.mkdir(lockPath);
    const layoutPromise = ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Acquiring Lock Org",
      urlKey: "acquiring-lock-org",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rmdir(lockPath);

    await expect(layoutPromise).resolves.toMatchObject({
      root: path.join(workspaceHome, "acquiring-lock-org"),
    });
  });

  it("quarantines a stale empty runtime lock on restart without deleting it", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-lock-empty-restart-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-lock-empty-restart-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const lockPath = path.join(workspaceHome, ".rudder-organizations.lock");
    await fs.mkdir(lockPath, { mode: 0o700 });
    const staleTime = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(lockPath, staleTime, staleTime);

    await expect(ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Empty Lock Recovery Org",
      urlKey: "empty-lock-recovery-org",
    })).resolves.toMatchObject({ root: path.join(workspaceHome, "empty-lock-recovery-org") });

    const recoveredEntries = (await fs.readdir(workspaceHome)).filter((entry) =>
      entry.startsWith(".rudder-organizations.lock.recovered-"),
    );
    expect(recoveredEntries).toHaveLength(1);
    await expect(fs.readdir(path.join(workspaceHome, recoveredEntries[0]!))).resolves.toEqual([]);
  });

  it("removes only a captured stale lock tombstone when a successor appears", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-lock-reclaim-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-lock-reclaim-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const lockPath = path.join(workspaceHome, ".rudder-organizations.lock");
    const staleToken = "stale-owner";
    await fs.mkdir(lockPath);
    await fs.writeFile(
      path.join(lockPath, `.rudder-lock-owner-${staleToken}.json`),
      `${JSON.stringify({
        kind: "rudder-organization-workspace-map-lock",
        version: 1,
        token: staleToken,
        pid: 2_000_000_000,
        hostname: os.hostname(),
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const successorPath = `${lockPath}.successor`;
    const successorSentinel = path.join(lockPath, "sentinel.txt");
    const originalRename = fs.rename;
    let injectedSuccessor = false;
    let markSuccessorCreated!: () => void;
    const successorCreated = new Promise<void>((resolve) => {
      markSuccessorCreated = resolve;
    });
    fs.rename = vi.fn(async (sourcePath, targetPath) => {
      const result = await originalRename.call(fs, sourcePath, targetPath);
      if (
        !injectedSuccessor
        && path.resolve(String(sourcePath)) === lockPath
        && String(targetPath).includes(".reclaimed-")
      ) {
        injectedSuccessor = true;
        await fs.mkdir(lockPath);
        const successorToken = "successor-owner";
        await fs.writeFile(
          path.join(lockPath, `.rudder-lock-owner-${successorToken}.json`),
          `${JSON.stringify({
            kind: "rudder-organization-workspace-map-lock",
            version: 1,
            token: successorToken,
            pid: process.pid,
            hostname: os.hostname(),
            createdAt: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
        await fs.writeFile(successorSentinel, "successor survives\n", "utf8");
        markSuccessorCreated();
      }
      return result;
    }) as typeof fs.rename;

    try {
      const layoutPromise = ensureOrganizationWorkspaceLayout({
        id: orgId,
        name: "Reclaimed Lock Org",
        urlKey: "reclaimed-lock-org",
      });
      await successorCreated;
      await expect(fs.readFile(successorSentinel, "utf8")).resolves.toBe("successor survives\n");
      await originalRename.call(fs, lockPath, successorPath);
      await expect(layoutPromise).resolves.toMatchObject({
        root: path.join(workspaceHome, "reclaimed-lock-org"),
      });
    } finally {
      fs.rename = originalRename;
    }
  });

  it("recovers an abandoned stale-lock reclaim claim on restart", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-lock-abandoned-reclaim-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-lock-abandoned-reclaim-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const lockPath = path.join(workspaceHome, ".rudder-organizations.lock");
    const ownerToken = "stale-owner";
    const abandonedToken = "abandoned-reclaimer";
    await fs.mkdir(lockPath);
    await fs.writeFile(
      path.join(lockPath, `.rudder-lock-owner-${ownerToken}.json`),
      `${JSON.stringify({
        kind: "rudder-organization-workspace-map-lock",
        version: 1,
        token: ownerToken,
        pid: 2_000_000_000,
        hostname: os.hostname(),
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(lockPath, `.rudder-lock-reclaim-${abandonedToken}.json`),
      `${JSON.stringify({
        version: 1,
        token: abandonedToken,
        ownerToken,
        pid: 2_000_000_000,
        hostname: os.hostname(),
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    await expect(ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Restart Recovery Org",
      urlKey: "restart-recovery-org",
    })).resolves.toMatchObject({ root: path.join(workspaceHome, "restart-recovery-org") });
  });

  it("serializes two process-level stale-lock reclaimers without losing either map update", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-lock-two-reclaimers-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-lock-two-reclaimers-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);

    const lockPath = path.join(workspaceHome, ".rudder-organizations.lock");
    const ownerToken = "stale-owner";
    await fs.mkdir(lockPath);
    await fs.writeFile(
      path.join(lockPath, `.rudder-lock-owner-${ownerToken}.json`),
      `${JSON.stringify({
        kind: "rudder-organization-workspace-map-lock",
        version: 1,
        token: ownerToken,
        pid: 2_000_000_000,
        hostname: os.hostname(),
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const script = [
      "import { ensureOrganizationWorkspaceLayout } from './src/home-paths.ts';",
      "const [id, name] = process.argv.slice(1);",
      "await ensureOrganizationWorkspaceLayout({ id, name, urlKey: name });",
    ].join("\n");
    const runChild = (id: string, name: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        id,
        name,
      ], {
        cwd: serverPackageRoot,
        env: {
          ...process.env,
          RUDDER_HOME: rudderHome,
          RUDDER_INSTANCE_ID: "test-instance",
          RUDDER_ORGANIZATION_WORKSPACE_HOME: workspaceHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(Buffer.concat(stderr).toString("utf8") || `child exited ${code}`));
      });
    });

    await Promise.all([
      runChild("organization-a", "reclaimer-a"),
      runChild("organization-b", "reclaimer-b"),
    ]);
    const map = JSON.parse(await fs.readFile(path.join(workspaceHome, ".rudder-organizations.json"), "utf8")) as {
      organizations: Array<{ orgId: string }>;
    };
    expect(map.organizations.map((entry) => entry.orgId).sort()).toEqual([
      "organization-a",
      "organization-b",
    ]);
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

  it("repairs the compatibility alias after a crash following an atomic workspace move", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-move-recovery-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-move-recovery-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const legacyRoot = resolveLegacyOrganizationWorkspaceRoot(orgId);
    const memoryFile = path.join(legacyRoot, "agents", "noah", "memory", "2026-08-30.md");
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(memoryFile, "move recovery\n", "utf8");
    await migrateOrganizationWorkspaceRoot(orgId);
    await fs.rm(legacyRoot, { force: true });

    await expect(migrateOrganizationWorkspaceRoot(orgId)).resolves.toMatchObject({ migrated: true });
    expect((await fs.lstat(legacyRoot)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(memoryFile, "utf8")).resolves.toBe("move recovery\n");
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

  it("repairs the compatibility alias after a crash following a workspace merge archive", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-merge-recovery-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-merge-recovery-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const layout = await ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Merge Recovery Org",
      urlKey: "merge-recovery-org",
    });
    const legacyRoot = resolveLegacyOrganizationWorkspaceRoot(orgId);
    const sharedRelativePath = path.join("agents", "noah", "memory", "2026-08-30.md");
    await fs.mkdir(path.dirname(path.join(layout.root, sharedRelativePath)), { recursive: true });
    await fs.mkdir(path.dirname(path.join(legacyRoot, sharedRelativePath)), { recursive: true });
    await fs.writeFile(path.join(layout.root, sharedRelativePath), "merge recovery\n", "utf8");
    await fs.writeFile(path.join(legacyRoot, sharedRelativePath), "merge recovery\n", "utf8");
    await migrateOrganizationWorkspaceRoot(orgId);
    await fs.rm(legacyRoot, { force: true });

    await expect(migrateOrganizationWorkspaceRoot(orgId)).resolves.toMatchObject({ migrated: true });
    expect((await fs.lstat(legacyRoot)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(path.join(legacyRoot, sharedRelativePath), "utf8"))
      .resolves.toBe("merge recovery\n");
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

  it("recovers a torn workspace identity file without publishing partial JSON", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-torn-identity-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-torn-identity-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const root = path.join(workspaceHome, "torn-identity-org");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, ".rudder-workspace.json"), "{\"version\": 1,", "utf8");
    await fs.writeFile(
      resolveOrganizationWorkspaceMapPath(),
      `${JSON.stringify({
        version: 1,
        organizations: [{
          instanceId: "test-instance",
          orgId,
          folderName: "torn-identity-org",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }],
      }, null, 2)}\n`,
      "utf8",
    );

    await expect(ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Torn Identity Org",
      urlKey: "torn-identity-org",
    })).resolves.toMatchObject({ root });

    await expect(fs.readFile(path.join(root, ".rudder-workspace.json"), "utf8"))
      .resolves.toContain(`"orgId": "${orgId}"`);
    const recovered = (await fs.readdir(root)).filter((entry) => entry.startsWith(".rudder-workspace.json.corrupt-"));
    expect(recovered).toHaveLength(1);
  });

  it("can recover a directory created before a mapping write failed", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-map-write-retry-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-map-write-retry-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const mapPath = resolveOrganizationWorkspaceMapPath();
    const recoveredRoot = path.join(workspaceHome, "mapping-retry-org");
    await fs.mkdir(path.join(recoveredRoot, "projects", "demo"), { recursive: true });
    await fs.writeFile(path.join(recoveredRoot, "projects", "demo", "README.md"), "# Recovered\n", "utf8");
    await fs.writeFile(
      path.join(recoveredRoot, ".rudder-workspace.json"),
      `${JSON.stringify({ version: 1, orgId }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      mapPath,
      `${JSON.stringify({
        version: 1,
        organizations: [{
          instanceId: "test-instance",
          orgId: "another-organization",
          folderName: "another-organization",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }],
      }, null, 2)}\n`,
      "utf8",
    );
    const originalRename = fs.rename;
    let failedMapWrite = false;
    fs.rename = vi.fn(async (sourcePath, targetPath) => {
      if (!failedMapWrite && path.resolve(String(targetPath)) === mapPath) {
        failedMapWrite = true;
        const error = Object.assign(new Error("simulated map write failure"), { code: "EIO" });
        throw error;
      }
      return await originalRename.call(fs, sourcePath, targetPath);
    }) as typeof fs.rename;

    try {
      await expect(ensureOrganizationWorkspaceLayout({
        id: orgId,
        name: "Mapping Retry Org",
        urlKey: "mapping-retry-org",
      })).rejects.toThrow("simulated map write failure");
    } finally {
      fs.rename = originalRename;
    }

    await expect(fs.readFile(path.join(recoveredRoot, ".rudder-workspace.json"), "utf8")).resolves.toContain(orgId);
    await expect(ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Mapping Retry Org",
      urlKey: "mapping-retry-org",
    })).resolves.toMatchObject({ root: recoveredRoot });
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

  it("does not prune organization workspace map lock and recovery directories", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-prune-map-lock-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;

    const internalDirectoryNames = [
      ".rudder-organizations.lock",
      ".rudder-organizations.lock.acquire-active",
      ".rudder-organizations.lock.recovered-crash",
      ".rudder-organizations.lock.reclaimed-stale-owner",
      ".rudder-organizations.lock.released-owner",
    ];
    await Promise.all(internalDirectoryNames.map(async (name) => {
      const sentinel = path.join(resolveOrganizationWorkspaceHomeDir(), name, "sentinel.txt");
      await fs.mkdir(path.dirname(sentinel), { recursive: true });
      await fs.writeFile(sentinel, "keep\n", "utf8");
    }));

    const result = await pruneOrphanedOrganizationStorage([]);

    expect(result.removedOrganizationDirNames).toEqual([]);
    await Promise.all(internalDirectoryNames.map(async (name) => {
      await expect(fs.readFile(path.join(resolveOrganizationWorkspaceHomeDir(), name, "sentinel.txt"), "utf8"))
        .resolves.toBe("keep\n");
    }));
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

  it("removes friendly workspace aliases, legacy projects, and the mapping record", async () => {
    const rudderHome = await makeTempDir("rudder-home-paths-remove-friendly-org-");
    const workspaceHome = await makeTempDir("rudder-user-workspaces-remove-friendly-org-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(workspaceHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;

    const layout = await ensureOrganizationWorkspaceLayout({
      id: orgId,
      name: "Friendly Delete Org",
      urlKey: "friendly-delete-org",
    });
    const previousDocumentsRoot = resolvePreviousDocumentsOrganizationWorkspaceRoot(orgId);
    const legacyWorkspaceRoot = resolveLegacyOrganizationWorkspaceRoot(orgId);
    const legacyProjectsRoot = path.join(
      rudderHome,
      "instances",
      "test-instance",
      "projects",
      orgId,
    );
    await fs.mkdir(path.dirname(previousDocumentsRoot), { recursive: true });
    await fs.symlink(layout.root, previousDocumentsRoot, "dir");
    await fs.mkdir(legacyWorkspaceRoot, { recursive: true });
    await fs.mkdir(legacyProjectsRoot, { recursive: true });

    const mapPath = resolveOrganizationWorkspaceMapPath();
    const mapBefore = JSON.parse(await fs.readFile(mapPath, "utf8")) as {
      organizations: Array<{ instanceId: string; orgId: string }>;
    };
    expect(mapBefore.organizations).toEqual([
      expect.objectContaining({ instanceId: "test-instance", orgId }),
    ]);

    await removeOrganizationStorage(orgId);

    await expect(fs.stat(layout.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(previousDocumentsRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(legacyWorkspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(legacyProjectsRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const mapAfter = JSON.parse(await fs.readFile(mapPath, "utf8")) as {
      organizations: Array<{ instanceId: string; orgId: string }>;
    };
    expect(mapAfter.organizations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ instanceId: "test-instance", orgId }),
    ]));
  });
});
