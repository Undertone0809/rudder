import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listClaudeSkills,
  syncClaudeSkills,
} from "@rudder/agent-runtime-claude-local/server";

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
    expect(snapshot.entries.find((entry) => entry.key === rudderSkillKey)?.description).toContain("`rudder` CLI");
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

  it("shows host-level user-installed Claude skills as external entries that stay off by default", async () => {
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

    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      key: "crack-python",
      runtimeName: "crack-python",
      description: "crack-python description.",
      state: "external",
      managed: false,
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: "~/.claude/skills",
      readOnly: false,
      detail: "Installed outside Rudder management in the Claude skills home.",
    }));
  });

  it("marks explicitly enabled user-installed Claude skills as configured for the next run", async () => {
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
      locationLabel: "~/.claude/skills",
      detail: "Enabled for this agent. Rudder will mount this user-installed Claude skill on the next run.",
    }));
  });
});
