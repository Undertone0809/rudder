import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listOpenCodeSkills,
  syncOpenCodeSkills,
} from "@rudderhq/agent-runtime-opencode-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSkillDir(root: string, name: string, description = `${name} description.`) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`, "utf8");
  return skillDir;
}

describe("opencode local skill sync", () => {
  const rudderSkillKey = "rudder/rudder";
  const cleanupDirs = new Set<string>();

  function managedSkillsHome(home: string, agentId: string) {
    return path.join(
      home,
      "instances",
      "default",
      "organizations",
      "organization-1",
      "opencode-home",
      "agents",
      agentId,
      ".claude",
      "skills",
    );
  }

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Rudder skills for managed runtime injection on the next run", async () => {
    const home = await makeTempDir("rudder-opencode-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      orgId: "organization-1",
      agentRuntimeType: "opencode_local",
      config: {
        env: {
          RUDDER_HOME: home,
        },
        rudderSkillSync: {
          desiredSkills: [rudderSkillKey],
        },
      },
    } as const;

    const before = await listOpenCodeSkills(ctx);
    expect(before.mode).toBe("ephemeral");
    expect(before.warnings).toEqual([]);
    expect(before.desiredSkills).toContain(rudderSkillKey);
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("configured");
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.description).toContain("`rudder` CLI");
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.originLabel).toBeUndefined();

    const after = await syncOpenCodeSkills(ctx, [rudderSkillKey]);
    expect(after.mode).toBe("ephemeral");
    expect(after.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("configured");
    await expect(fs.lstat(path.join(managedSkillsHome(home, "agent-1"), "rudder"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not persist Rudder-managed skills when the desired set is emptied", async () => {
    const home = await makeTempDir("rudder-opencode-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      orgId: "organization-1",
      agentRuntimeType: "opencode_local",
      config: {
        env: {
          RUDDER_HOME: home,
        },
        rudderSkillSync: {
          desiredSkills: [rudderSkillKey],
        },
      },
    } as const;

    const clearedCtx = {
      ...configuredCtx,
      config: {
        env: {
          RUDDER_HOME: home,
        },
        rudderSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncOpenCodeSkills(clearedCtx, []);
    expect(after.desiredSkills).toEqual([]);
    expect(after.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("available");
    await expect(fs.lstat(path.join(managedSkillsHome(home, "agent-2"), "rudder"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("surfaces user-installed Claude-compatible skills as opt-in external entries", async () => {
    const home = await makeTempDir("rudder-opencode-user-skills-");
    cleanupDirs.add(home);
    await createSkillDir(managedSkillsHome(home, "agent-3"), "build-advisor");

    const snapshot = await listOpenCodeSkills({
      agentId: "agent-3",
      orgId: "organization-1",
      agentRuntimeType: "opencode_local",
      config: {
        env: {
          RUDDER_HOME: home,
        },
      },
    });

    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      key: "build-advisor",
      runtimeName: "build-advisor",
      description: "build-advisor description.",
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      locationLabel: "managed OpenCode skills home",
      readOnly: false,
    }));
  });

  it("keeps explicitly enabled user-installed OpenCode skills in the desired set", async () => {
    const home = await makeTempDir("rudder-opencode-enabled-user-skills-");
    cleanupDirs.add(home);
    await createSkillDir(managedSkillsHome(home, "agent-4"), "build-advisor");

    const snapshot = await syncOpenCodeSkills({
      agentId: "agent-4",
      orgId: "organization-1",
      agentRuntimeType: "opencode_local",
      config: {
        env: {
          RUDDER_HOME: home,
        },
        rudderSkillSync: {
          desiredSkills: ["build-advisor"],
        },
      },
    }, ["build-advisor"]);

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toContain("build-advisor");
    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      key: "build-advisor",
      runtimeName: "build-advisor",
      description: "build-advisor description.",
      desired: true,
      managed: false,
      state: "configured",
      origin: "user_installed",
      detail: "Enabled for this agent. Rudder will mount this user-installed OpenCode skill on the next run.",
    }));
  });
});
