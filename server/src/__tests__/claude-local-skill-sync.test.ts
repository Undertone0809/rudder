import {
  listClaudeSkills,
  syncClaudeSkills,
} from "@rudderhq/agent-runtime-claude-local/server";
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

describe("claude local skill sync", () => {
  const rudderSkillKey = "rudder/rudder";
  const createAgentKey = "rudder/rudder-create-agent";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("defaults to no enabled Rudder skills when no explicit selection exists", async () => {
    const snapshot = await listClaudeSkills({
      agentId: "agent-1",
      orgId: "organization-1",
      agentRuntimeType: "claude_local",
      config: {},
    });

    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.desiredSkills).toEqual([]);
    expect(snapshot.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("available");
    expect(snapshot.entries.find((entry) => entry.key === rudderSkillKey)?.description).toContain("CLI-backed references");
    expect(snapshot.entries.find((entry) => entry.key === rudderSkillKey)?.originLabel).toBeUndefined();
  });

  it("respects an explicit desired skill list without mutating a persistent home", async () => {
    const snapshot = await syncClaudeSkills({
      agentId: "agent-2",
      orgId: "organization-1",
      agentRuntimeType: "claude_local",
      config: {
        rudderSkillSync: {
          desiredSkills: [rudderSkillKey],
        },
      },
    }, [rudderSkillKey]);

    expect(snapshot.desiredSkills).toContain(rudderSkillKey);
    expect(snapshot.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === createAgentKey)?.state).toBe("available");
  });

  it("keeps legacy paperclipSkillSync config compatible", async () => {
    const snapshot = await listClaudeSkills({
      agentId: "agent-3",
      orgId: "organization-1",
      agentRuntimeType: "claude_local",
      config: {
        paperclipSkillSync: {
          desiredSkills: ["rudder"],
        },
      },
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toContain(rudderSkillKey);
    expect(snapshot.desiredSkills).not.toContain("rudder");
    expect(snapshot.entries.find((entry) => entry.key === rudderSkillKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === "rudder")).toBeUndefined();
  });

  it("does not expose host-level user-installed Claude skills as Rudder-selectable entries", async () => {
    const home = await makeTempDir("rudder-claude-user-skills-");
    cleanupDirs.add(home);
    await createSkillDir(path.join(home, ".claude", "skills"), "crack-python");

    const snapshot = await listClaudeSkills({
      agentId: "agent-4",
      orgId: "organization-1",
      agentRuntimeType: "claude_local",
      config: {
        env: {
          HOME: home,
        },
      },
    });

    expect(snapshot.entries.find((entry) => entry.key === "crack-python")).toBeUndefined();
  });

  it("marks unknown desired Claude skills as missing instead of loading adapter-home skills", async () => {
    const home = await makeTempDir("rudder-claude-enabled-user-skills-");
    cleanupDirs.add(home);
    await createSkillDir(path.join(home, ".claude", "skills"), "build-advisor");

    const snapshot = await syncClaudeSkills({
      agentId: "agent-5",
      orgId: "organization-1",
      agentRuntimeType: "claude_local",
      config: {
        env: {
          HOME: home,
        },
        rudderSkillSync: {
          desiredSkills: ["build-advisor"],
        },
      },
    }, ["build-advisor"]);

    expect(snapshot.warnings).toContain('Desired skill "build-advisor" is not available from the Rudder skills directory.');
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
