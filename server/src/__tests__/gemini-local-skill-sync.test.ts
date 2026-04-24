import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listGeminiSkills,
  syncGeminiSkills,
} from "@rudderhq/agent-runtime-gemini-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("gemini local skill sync", () => {
  const rudderSkillKey = "rudder/rudder";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Rudder skills and installs them into the Gemini skills home", async () => {
    const home = await makeTempDir("rudder-gemini-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      orgId: "organization-1",
      agentRuntimeType: "gemini_local",
      config: {
        env: {
          HOME: home,
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
    expect(after.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".gemini", "skills", "rudder"))).isSymbolicLink()).toBe(true);
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
        },
        rudderSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncGeminiSkills(clearedCtx, []);
    expect(after.desiredSkills).toEqual([]);
    expect(after.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("available");
    await expect(fs.lstat(path.join(home, ".gemini", "skills", "rudder"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
