import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCursorSkills,
  syncCursorSkills,
} from "@rudderhq/agent-runtime-cursor-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSkillDir(root: string, name: string) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
}

describe("cursor local skill sync", () => {
  const rudderSkillKey = "rudder/rudder";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Rudder skills and installs them into the Cursor skills home", async () => {
    const home = await makeTempDir("rudder-cursor-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      orgId: "organization-1",
      agentRuntimeType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        rudderSkillSync: {
          desiredSkills: [rudderSkillKey],
        },
      },
    } as const;

    const before = await listCursorSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(rudderSkillKey);
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("missing");

    const after = await syncCursorSkills(ctx, [rudderSkillKey]);
    expect(after.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "rudder"))).isSymbolicLink()).toBe(true);
  });

  it("recognizes organization-library runtime skills supplied outside the bundled Rudder directory", async () => {
    const home = await makeTempDir("rudder-cursor-runtime-skills-home-");
    const runtimeSkills = await makeTempDir("rudder-cursor-runtime-skills-src-");
    cleanupDirs.add(home);
    cleanupDirs.add(runtimeSkills);

    const rudderDir = await createSkillDir(runtimeSkills, "rudder");
    const asciiHeartDir = await createSkillDir(runtimeSkills, "ascii-heart");

    const ctx = {
      agentId: "agent-3",
      orgId: "organization-1",
      agentRuntimeType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        rudderRuntimeSkills: [
          {
            key: "rudder",
            runtimeName: "rudder",
            source: rudderDir,
          },
          {
            key: "ascii-heart",
            runtimeName: "ascii-heart",
            source: asciiHeartDir,
          },
        ],
        rudderSkillSync: {
          desiredSkills: ["ascii-heart"],
        },
      },
    } as const;

    const before = await listCursorSkills(ctx);
    expect(before.warnings).toEqual([]);
    expect(before.desiredSkills).toEqual(["ascii-heart"]);
    expect(before.entries.find((entry) => entry.key === "ascii-heart")?.state).toBe("missing");

    const after = await syncCursorSkills(ctx, ["ascii-heart"]);
    expect(after.warnings).toEqual([]);
    expect(after.entries.find((entry) => entry.key === "ascii-heart")?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".cursor", "skills", "ascii-heart"))).isSymbolicLink()).toBe(true);
  });

  it("removes Rudder-managed symlinks when the desired set is emptied", async () => {
    const home = await makeTempDir("rudder-cursor-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      orgId: "organization-1",
      agentRuntimeType: "cursor",
      config: {
        env: {
          HOME: home,
        },
        rudderSkillSync: {
          desiredSkills: [rudderSkillKey],
        },
      },
    } as const;

    await syncCursorSkills(configuredCtx, [rudderSkillKey]);

    const clearedCtx = {
      ...configuredCtx,
      config: {
        env: {
          HOME: home,
        },
        rudderSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncCursorSkills(clearedCtx, []);
    expect(after.desiredSkills).toEqual([]);
    expect(after.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("available");
    await expect(fs.lstat(path.join(home, ".cursor", "skills", "rudder"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
