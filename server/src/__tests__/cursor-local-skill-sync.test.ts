import {
  listCursorSkills,
  syncCursorSkills,
} from "@rudderhq/agent-runtime-cursor-local/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
  it("reports selected Rudder skills as prompt-injected configuration", async () => {
    const root = await makeTempDir("rudder-cursor-skill-sync-");
    const operatorSkillHome = path.join(root, ".cursor", "skills");
    await fs.mkdir(path.join(operatorSkillHome, "operator-skill"), { recursive: true });
    await fs.writeFile(path.join(operatorSkillHome, "operator-skill", "SKILL.md"), "---\nname: operator-skill\n---\n", "utf8");

    try {
      const ctx = {
        agentId: "agent-1",
        orgId: "organization-1",
        agentRuntimeType: "cursor",
        config: {
          env: {
            HOME: root,
          },
          rudderSkillSync: {
            desiredSkills: ["rudder/rudder"],
          },
        },
      } as const;

      const before = await listCursorSkills(ctx);
      expect(before.mode).toBe("ephemeral");
      expect(before.desiredSkills).toContain("rudder/rudder");
      expect(before.entries.find((entry) => entry.key === "rudder/rudder")?.state).toBe("configured");
      expect(before.entries.some((entry) => entry.key === "operator-skill")).toBe(false);

      const after = await syncCursorSkills(ctx, ["rudder/rudder"]);
      expect(after.mode).toBe("ephemeral");
      expect(after.entries.find((entry) => entry.key === "rudder/rudder")?.state).toBe("configured");
      await expect(fs.lstat(path.join(operatorSkillHome, "rudder"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes organization-library runtime skills supplied outside the bundled Rudder directory", async () => {
    const root = await makeTempDir("rudder-cursor-runtime-skills-");
    try {
      const rudderDir = await createSkillDir(root, "rudder");
      const asciiHeartDir = await createSkillDir(root, "ascii-heart");

      const ctx = {
        agentId: "agent-3",
        orgId: "organization-1",
        agentRuntimeType: "cursor",
        config: {
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

      const snapshot = await syncCursorSkills(ctx, ["ascii-heart"]);
      expect(snapshot.warnings).toEqual([]);
      expect(snapshot.desiredSkills).toEqual(["ascii-heart"]);
      expect(snapshot.entries.find((entry) => entry.key === "ascii-heart")?.state).toBe("configured");
      expect(snapshot.entries.find((entry) => entry.key === "rudder")?.state).toBe("available");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("marks unknown desired skills as missing", async () => {
    const ctx = {
      agentId: "agent-2",
      orgId: "organization-1",
      agentRuntimeType: "cursor",
      config: {
        rudderSkillSync: {
          desiredSkills: ["operator-only"],
        },
      },
    } as const;

    const snapshot = await syncCursorSkills(ctx, ["operator-only"]);
    expect(snapshot.entries.find((entry) => entry.key === "operator-only")?.state).toBe("missing");
    expect(snapshot.warnings).toEqual([
      'Desired skill "operator-only" is not available from the Rudder skills directory.',
    ]);
  });
});
