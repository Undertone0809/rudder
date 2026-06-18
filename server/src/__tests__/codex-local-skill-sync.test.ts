import {
  listCodexSkills,
  syncCodexSkills,
} from "@rudderhq/agent-runtime-codex-local/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("codex local skill sync", () => {
  const rudderSkillKey = "rudder/rudder";
  const cleanupDirs = new Set<string>();
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalHome = process.env.HOME;
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(async () => {
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  function managedCodexHomePath(rudderHome: string, agentId: string, orgId = "organization-1"): string {
    return path.join(
      rudderHome,
      "instances",
      "default",
      "organizations",
      orgId,
      "codex-home",
      "agents",
      agentId,
    );
  }

  async function writeSkill(skillDir: string): Promise<void> {
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# External skill\n", "utf8");
  }

  it("reports explicitly enabled Rudder skills without promising workspace injection", async () => {
    const codexHome = await makeTempDir("rudder-codex-skill-sync-");
    const rudderHome = await makeTempDir("rudder-codex-skill-rudder-home-");
    cleanupDirs.add(codexHome);
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;

    const ctx = {
      agentId: "agent-1",
      orgId: "organization-1",
      agentRuntimeType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        rudderSkillSync: {
          desiredSkills: [rudderSkillKey],
        },
      },
    } as const;

    const before = await listCodexSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(rudderSkillKey);
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("missing");
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.description).toContain("CLI-backed references");
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.originLabel).toBeUndefined();
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.detail).toContain(
      "managed Codex skills home",
    );
  });

  it("realizes selected Rudder skills into the managed Codex skills home and disables external Codex skill roots during sync", async () => {
    const codexHome = await makeTempDir("rudder-codex-skill-prune-");
    const rudderHome = await makeTempDir("rudder-codex-skill-rudder-home-");
    const operatorHome = await makeTempDir("rudder-codex-skill-operator-home-");
    const workspace = await makeTempDir("rudder-codex-skill-workspace-");
    const managedCodexHome = managedCodexHomePath(rudderHome, "agent-2");
    cleanupDirs.add(codexHome);
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(operatorHome);
    cleanupDirs.add(workspace);
    process.env.RUDDER_HOME = rudderHome;
    process.env.HOME = operatorHome;
    delete process.env.CODEX_HOME;
    await writeSkill(path.join(operatorHome, ".agents", "skills", "home-leak"));
    await writeSkill(path.join(codexHome, "skills", "shared-leak"));
    await writeSkill(path.join(workspace, ".agents", "skills", "repo-leak"));

    const configuredCtx = {
      agentId: "agent-2",
      orgId: "organization-1",
      agentRuntimeType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        cwd: workspace,
        rudderSkillSync: {
          desiredSkills: [rudderSkillKey],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, [rudderSkillKey]);
    expect(after.mode).toBe("persistent");
    expect(after.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(managedCodexHome, "skills", "rudder"))).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(path.join(codexHome, "skills", "rudder"))).rejects.toThrow();
    const configToml = await fs.readFile(path.join(managedCodexHome, "config.toml"), "utf8");
    expect(configToml).toContain("[skills.bundled]");
    expect(configToml).toContain("enabled = false");
    expect(configToml).toContain("[[skills.config]]");
    expect(configToml).toContain(`path = ${JSON.stringify(path.join(operatorHome, ".agents", "skills"))}`);
    expect(configToml).toContain(`path = ${JSON.stringify(path.join(operatorHome, ".agents", "skills", "home-leak"))}`);
    expect(configToml).toContain(`path = ${JSON.stringify(path.join(operatorHome, ".agents", "skills", "home-leak", "SKILL.md"))}`);
    expect(configToml).toContain(`path = ${JSON.stringify(path.join(codexHome, "skills"))}`);
    expect(configToml).toContain(`path = ${JSON.stringify(path.join(codexHome, "skills", "shared-leak"))}`);
    expect(configToml).toContain(`path = ${JSON.stringify(path.join(codexHome, "skills", "shared-leak", "SKILL.md"))}`);
    expect(configToml).toContain(`path = ${JSON.stringify(path.join(workspace, ".agents", "skills"))}`);
    expect(configToml).toContain(`path = ${JSON.stringify(path.join(workspace, ".agents", "skills", "repo-leak"))}`);
    expect(configToml).toContain(`path = ${JSON.stringify(path.join(workspace, ".agents", "skills", "repo-leak", "SKILL.md"))}`);
  });

  it("does not auto-enable bundled Rudder skills when the desired set is empty", async () => {
    const codexHome = await makeTempDir("rudder-codex-skill-required-");
    const rudderHome = await makeTempDir("rudder-codex-skill-rudder-home-");
    cleanupDirs.add(codexHome);
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;

    const configuredCtx = {
      agentId: "agent-2",
      orgId: "organization-1",
      agentRuntimeType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        rudderSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, []);
    expect(after.desiredSkills).toEqual([]);
    expect(after.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("available");
  });

  it("keeps legacy paperclipSkillSync config compatible", async () => {
    const codexHome = await makeTempDir("rudder-codex-legacy-skill-sync-");
    const rudderHome = await makeTempDir("rudder-codex-skill-rudder-home-");
    cleanupDirs.add(codexHome);
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;

    const snapshot = await listCodexSkills({
      agentId: "agent-3",
      orgId: "organization-1",
      agentRuntimeType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        paperclipSkillSync: {
          desiredSkills: ["rudder"],
        },
      },
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toContain(rudderSkillKey);
    expect(snapshot.desiredSkills).not.toContain("rudder");
    expect(snapshot.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("missing");
    expect(snapshot.entries.find((entry) => entry.key === "rudder")).toBeUndefined();
  });

  it("treats adapter-local Codex skills as unavailable to Rudder-managed enablement", async () => {
    const codexHome = await makeTempDir("rudder-codex-enabled-user-skills-");
    const rudderHome = await makeTempDir("rudder-codex-skill-rudder-home-");
    cleanupDirs.add(codexHome);
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;

    const snapshot = await syncCodexSkills({
      agentId: "agent-5",
      orgId: "organization-1",
      agentRuntimeType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        rudderSkillSync: {
          desiredSkills: ["build-advisor"],
        },
      },
    }, ["build-advisor"]);

    expect(snapshot.desiredSkills).toContain("build-advisor");
    expect(snapshot.warnings).toContain(
      'Desired skill "build-advisor" is not available from the Rudder skills directory.',
    );
    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      key: "build-advisor",
      desired: true,
      state: "missing",
      origin: "external_unknown",
      detail: "Rudder cannot find this skill in the local runtime skills directory.",
    }));
  });
});
