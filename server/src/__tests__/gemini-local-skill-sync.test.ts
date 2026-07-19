import {
  listGeminiSkills,
  syncGeminiSkills,
} from "@rudderhq/agent-runtime-gemini-local/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("gemini local skill sync", () => {
  const rudderSkillKey = "rudder/rudder-docs";
  const cleanupDirs = new Set<string>();

  function managedGeminiSkillsHome(home: string, orgId = "organization-1") {
    return path.join(home, ".rudder", "instances", "default", "organizations", orgId, "gemini-home", ".gemini", "skills");
  }

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("removes the dangling legacy Rudder Docs entry before installing the canonical Gemini skill", async () => {
    const home = await makeTempDir("rudder-gemini-skill-sync-");
    cleanupDirs.add(home);
    const skillsHome = managedGeminiSkillsHome(home);
    const legacyTarget = path.join(skillsHome, "rudder");
    const legacySource = path.join(process.cwd(), "server", "resources", "bundled-skills", "rudder");
    const retiredAgentTarget = path.join(skillsHome, "rudder-create-agent");
    const retiredAgentSource = path.join(process.cwd(), "server", "resources", "bundled-skills", "rudder-create-agent");
    const retiredPluginTarget = path.join(skillsHome, "rudder-create-plugin");
    const retiredPluginSource = path.join(process.cwd(), "server", "resources", "bundled-skills", "rudder-create-plugin");
    const unrelatedSkill = path.join(skillsHome, "user-notes");
    await fs.mkdir(unrelatedSkill, { recursive: true });
    await fs.symlink(legacySource, legacyTarget);
    await fs.symlink(retiredAgentSource, retiredAgentTarget);
    await fs.symlink(retiredPluginSource, retiredPluginTarget);

    const ctx = {
      agentId: "agent-1",
      orgId: "organization-1",
      agentRuntimeType: "gemini_local",
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

    const before = await listGeminiSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(rudderSkillKey);
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("missing");

    const after = await syncGeminiSkills(ctx, [rudderSkillKey]);
    const installedEntry = after.entries.find((entry) => entry.key === rudderSkillKey);
    expect(installedEntry?.state).toBe("installed");
    expect(installedEntry?.targetPath).toContain(skillsHome);
    expect((await fs.lstat(installedEntry?.targetPath ?? "")).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(legacyTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(retiredAgentTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(retiredPluginTarget)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(unrelatedSkill)).isDirectory()).toBe(true);
    expect(after.warnings).toContain(
      `Removed legacy Rudder-managed skill entry "rudder" from ${skillsHome}.`,
    );
    expect(after.warnings).toContain(
      `Removed retired Rudder-managed skill entry "rudder-create-agent" from ${skillsHome}.`,
    );
    expect(after.warnings).toContain(
      `Removed retired Rudder-managed skill entry "rudder-create-plugin" from ${skillsHome}.`,
    );
  });

  it("removes Rudder-managed symlinks when the desired set is emptied", async () => {
    const home = await makeTempDir("rudder-gemini-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      orgId: "organization-1",
      agentRuntimeType: "gemini_local",
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

    await syncGeminiSkills(configuredCtx, [rudderSkillKey]);

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

    const after = await syncGeminiSkills(clearedCtx, []);
    expect(after.desiredSkills).toEqual([]);
    expect(after.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("available");
    const targetPath = after.entries.find((entry) => entry.key === rudderSkillKey)?.targetPath ?? "";
    expect(targetPath).toContain(managedGeminiSkillsHome(home));
    await expect(fs.lstat(targetPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
