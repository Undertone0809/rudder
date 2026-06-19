import {
  listOpenCodeSkills,
  syncOpenCodeSkills,
} from "@rudderhq/agent-runtime-opencode-local/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

  function managedOpenCodeSkillsHome(home: string, orgId = "organization-1") {
    return path.join(home, ".rudder", "instances", "default", "organizations", orgId, "opencode-home", ".claude", "skills");
  }

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Rudder skills and installs them into the OpenCode skills sidecar", async () => {
    const home = await makeTempDir("rudder-opencode-skill-sync-");
    cleanupDirs.add(home);
    await createSkillDir(path.join(home, ".claude", "skills"), "operator-skill");

    const ctx = {
      agentId: "agent-1",
      orgId: "organization-1",
      agentRuntimeType: "opencode_local",
      config: {
        env: {
          HOME: home,
          RUDDER_HOME: path.join(home, ".rudder"),
        },
        rudderSkillSync: {
          desiredSkills: [rudderSkillKey],
        },
      },
    } as const;

    const before = await listOpenCodeSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.warnings).toEqual([]);
    expect(before.desiredSkills).toContain(rudderSkillKey);
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("missing");
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.description).toContain("CLI-backed references");
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.originLabel).toBeUndefined();
    expect(before.entries.some((entry) => entry.key === "operator-skill")).toBe(false);

    const after = await syncOpenCodeSkills(ctx, [rudderSkillKey]);
    expect(after.mode).toBe("persistent");
    const installedEntry = after.entries.find((entry) => entry.key === rudderSkillKey);
    expect(installedEntry?.state).toBe("installed");
    expect(installedEntry?.targetPath).toBe(path.join(managedOpenCodeSkillsHome(home), "rudder"));
    expect((await fs.lstat(installedEntry?.targetPath ?? "")).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(path.join(home, ".claude", "skills", "rudder"))).rejects.toMatchObject({
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
          HOME: home,
          RUDDER_HOME: path.join(home, ".rudder"),
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
          HOME: home,
          RUDDER_HOME: path.join(home, ".rudder"),
        },
        rudderSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncOpenCodeSkills(clearedCtx, []);
    expect(after.desiredSkills).toEqual([]);
    expect(after.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("available");
    const targetPath = after.entries.find((entry) => entry.key === rudderSkillKey)?.targetPath ?? "";
    expect(targetPath).toContain(managedOpenCodeSkillsHome(home));
    await expect(fs.lstat(path.join(managedOpenCodeSkillsHome(home), "rudder"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not surface operator-home Claude-compatible skills as runtime enablement entries", async () => {
    const home = await makeTempDir("rudder-opencode-user-skills-");
    cleanupDirs.add(home);
    await createSkillDir(path.join(home, ".claude", "skills"), "build-advisor");

    const snapshot = await listOpenCodeSkills({
      agentId: "agent-3",
      orgId: "organization-1",
      agentRuntimeType: "opencode_local",
      config: {
        env: {
          HOME: home,
          RUDDER_HOME: path.join(home, ".rudder"),
        },
      },
    });

    expect(snapshot.entries.some((entry) => entry.key === "build-advisor")).toBe(false);
  });

  it("treats explicitly enabled operator-home OpenCode skills as unavailable", async () => {
    const home = await makeTempDir("rudder-opencode-enabled-user-skills-");
    cleanupDirs.add(home);
    await createSkillDir(path.join(home, ".claude", "skills"), "build-advisor");

    const snapshot = await syncOpenCodeSkills({
      agentId: "agent-4",
      orgId: "organization-1",
      agentRuntimeType: "opencode_local",
      config: {
        env: {
          HOME: home,
          RUDDER_HOME: path.join(home, ".rudder"),
        },
        rudderSkillSync: {
          desiredSkills: ["build-advisor"],
        },
      },
    }, ["build-advisor"]);

    expect(snapshot.warnings).toEqual(['Desired skill "build-advisor" is not available from the Rudder skills directory.']);
    expect(snapshot.desiredSkills).toContain("build-advisor");
    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      key: "build-advisor",
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      detail: "Rudder cannot find this skill in the local runtime skills directory.",
    }));
  });
});
