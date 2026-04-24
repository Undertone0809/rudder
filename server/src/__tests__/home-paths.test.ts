import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentWorkspaceKey } from "../agent-workspace-key.js";
import {
  ensureAgentWorkspaceLayout,
  ensureOrganizationWorkspaceLayout,
  pruneOrphanedOrganizationStorage,
  resolveAgentInstructionsDir,
  resolveAgentMemoryDir,
  resolveAgentSkillsDir,
  resolveDefaultAgentWorkspaceDir,
  resolveOrganizationAgentsDir,
  resolveOrganizationPlansDir,
  resolveOrganizationSkillsDir,
} from "../home-paths.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const orgId = "organization-1";
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
      plansDir: resolveOrganizationPlansDir(orgId),
    });
    expect(agentWorkspace).toEqual({
      root: resolveDefaultAgentWorkspaceDir(orgId, workspaceKey),
      instructionsDir: resolveAgentInstructionsDir(orgId, workspaceKey),
      memoryDir: resolveAgentMemoryDir(orgId, workspaceKey),
      skillsDir: resolveAgentSkillsDir(orgId, workspaceKey),
    });

    await expect(fs.stat(resolveOrganizationAgentsDir(orgId))).resolves.toBeDefined();
    await expect(fs.stat(resolveOrganizationSkillsDir(orgId))).resolves.toBeDefined();
    await expect(fs.stat(resolveOrganizationPlansDir(orgId))).resolves.toBeDefined();
    await expect(fs.stat(resolveDefaultAgentWorkspaceDir(orgId, workspaceKey))).resolves.toBeDefined();
    await expect(fs.stat(resolveAgentInstructionsDir(orgId, workspaceKey))).resolves.toBeDefined();
    await expect(fs.stat(resolveAgentMemoryDir(orgId, workspaceKey))).resolves.toBeDefined();
    await expect(fs.stat(resolveAgentSkillsDir(orgId, workspaceKey))).resolves.toBeDefined();
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
});
