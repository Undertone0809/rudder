import {
  listPiSkills,
  syncPiSkills,
} from "@rudderhq/agent-runtime-pi-local/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("pi local skill sync", () => {
  const rudderSkillKey = "rudder/rudder";
  const cleanupDirs = new Set<string>();

  function managedPiSkillsHome(home: string, orgId = "organization-1") {
    return path.join(home, ".rudder", "instances", "default", "organizations", orgId, "pi-home", ".pi", "agent", "skills");
  }

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Rudder skills and installs them into the Pi skills home", async () => {
    const home = await makeTempDir("rudder-pi-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      orgId: "organization-1",
      agentRuntimeType: "pi_local",
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

    const before = await listPiSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(rudderSkillKey);
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("missing");

    const after = await syncPiSkills(ctx, [rudderSkillKey]);
    const installedEntry = after.entries.find((entry) => entry.key === rudderSkillKey);
    expect(installedEntry?.state).toBe("installed");
    expect(installedEntry?.targetPath).toContain(managedPiSkillsHome(home));
    expect((await fs.lstat(installedEntry?.targetPath ?? "")).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(path.join(home, ".pi", "agent", "skills", "rudder"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes Rudder-managed symlinks when the desired set is emptied", async () => {
    const home = await makeTempDir("rudder-pi-skill-prune-");
    cleanupDirs.add(home);

    const configuredCtx = {
      agentId: "agent-2",
      orgId: "organization-1",
      agentRuntimeType: "pi_local",
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

    await syncPiSkills(configuredCtx, [rudderSkillKey]);

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

    const after = await syncPiSkills(clearedCtx, []);
    expect(after.desiredSkills).toEqual([]);
    expect(after.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("available");
    const targetPath = after.entries.find((entry) => entry.key === rudderSkillKey)?.targetPath ?? "";
    expect(targetPath).toContain(managedPiSkillsHome(home));
    await expect(fs.lstat(targetPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
