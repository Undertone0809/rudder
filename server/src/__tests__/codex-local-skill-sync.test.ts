import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCodexSkills,
  syncCodexSkills,
} from "@rudder/agent-runtime-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("codex local skill sync", () => {
  const rudderSkillKey = "rudder/rudder";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports explicitly enabled Rudder skills without promising workspace injection", async () => {
    const codexHome = await makeTempDir("rudder-codex-skill-sync-");
    cleanupDirs.add(codexHome);

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
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.description).toContain("`rudder` CLI");
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.originLabel).toBeUndefined();
    expect(before.entries.find((entry) => entry.key === rudderSkillKey)?.detail).toContain(
      "managed Codex skills home",
    );
  });

  it("realizes selected Rudder skills into the managed Codex skills home during sync", async () => {
    const codexHome = await makeTempDir("rudder-codex-skill-prune-");
    cleanupDirs.add(codexHome);

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
    expect((await fs.lstat(path.join(codexHome, "skills", "rudder"))).isSymbolicLink()).toBe(true);
    const configToml = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    expect(configToml).toContain("[skills.bundled]");
    expect(configToml).toContain("enabled = false");
    expect(configToml).not.toContain("[[skills.config]]");
  });

  it("does not auto-enable bundled Rudder skills when the desired set is empty", async () => {
    const codexHome = await makeTempDir("rudder-codex-skill-required-");
    cleanupDirs.add(codexHome);

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
    cleanupDirs.add(codexHome);

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
    cleanupDirs.add(codexHome);

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
