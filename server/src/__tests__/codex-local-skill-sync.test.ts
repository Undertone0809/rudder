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

  afterEach(async () => {
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
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

  it("realizes selected Rudder skills into the managed Codex skills home during sync", async () => {
    const codexHome = await makeTempDir("rudder-codex-skill-prune-");
    const rudderHome = await makeTempDir("rudder-codex-skill-rudder-home-");
    const managedCodexHome = managedCodexHomePath(rudderHome, "agent-2");
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
    expect(configToml).not.toContain("[[skills.config]]");
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
