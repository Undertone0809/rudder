import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRudderRuntimeSkillSymlinks,
  listRudderSkillEntries,
  renderRudderRuntimeSkillBoundaryPrompt,
  removeMaintainerOnlySkillSymlinks,
} from "@rudderhq/agent-runtime-utils/server-utils";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("rudder skill utils", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("prefers bundled runtime skills from ./server/resources/bundled-skills", async () => {
    const root = await makeTempDir("rudder-skill-roots-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(path.join(root, "server", "resources", "bundled-skills", "rudder"), { recursive: true });
    await fs.mkdir(path.join(root, "server", "resources", "bundled-skills", "rudder-create-agent"), { recursive: true });
    await fs.mkdir(path.join(root, "skills", "release"), { recursive: true });
    await fs.writeFile(
      path.join(root, "server", "resources", "bundled-skills", "rudder", "SKILL.md"),
      "---\nname: rudder\ndescription: Core Rudder coordination skill.\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "server", "resources", "bundled-skills", "rudder-create-agent", "SKILL.md"),
      "---\nname: rudder-create-agent\ndescription: Create agents.\n---\n",
      "utf8",
    );

    const entries = await listRudderSkillEntries(moduleDir);

    expect(entries.map((entry) => entry.key)).toEqual([
      "rudder/rudder",
      "rudder/rudder-create-agent",
    ]);
    expect(entries.map((entry) => entry.runtimeName)).toEqual([
      "rudder",
      "rudder-create-agent",
    ]);
    expect(entries[0]?.source).toBe(path.join(root, "server", "resources", "bundled-skills", "rudder"));
    expect(entries[0]?.name).toBe("rudder");
    expect(entries[0]?.description).toBe("Core Rudder coordination skill.");
  });

  it("falls back to packaged skills beside a runtime package dist directory", async () => {
    const root = await makeTempDir("rudder-package-skills-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "packages", "agent-runtimes", "codex-local", "dist", "server");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(path.join(root, "packages", "agent-runtimes", "codex-local", "skills", "rudder"), { recursive: true });
    await fs.writeFile(
      path.join(root, "packages", "agent-runtimes", "codex-local", "skills", "rudder", "SKILL.md"),
      "---\nname: rudder\ndescription: Packaged Rudder skill.\n---\n",
      "utf8",
    );

    const entries = await listRudderSkillEntries(moduleDir);

    expect(entries.map((entry) => entry.key)).toEqual(["rudder/rudder"]);
    expect(entries[0]?.source).toBe(path.join(root, "packages", "agent-runtimes", "codex-local", "skills", "rudder"));
    expect(entries[0]?.description).toBe("Packaged Rudder skill.");
  });

  it("removes stale maintainer-only symlinks from a shared skills home", async () => {
    const root = await makeTempDir("rudder-skill-cleanup-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const runtimeSkill = path.join(root, "server", "resources", "bundled-skills", "rudder");
    const customSkill = path.join(root, "custom", "release-notes");
    const staleMaintainerSkill = path.join(root, "server", "resources", "bundled-skills", "release");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(runtimeSkill, { recursive: true });
    await fs.mkdir(customSkill, { recursive: true });

    await fs.symlink(runtimeSkill, path.join(skillsHome, "rudder"));
    await fs.symlink(customSkill, path.join(skillsHome, "release-notes"));
    await fs.symlink(staleMaintainerSkill, path.join(skillsHome, "release"));

    const removed = await removeMaintainerOnlySkillSymlinks(skillsHome, ["rudder"]);

    expect(removed).toEqual(["release"]);
    await expect(fs.lstat(path.join(skillsHome, "release"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "rudder"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "release-notes"))).isSymbolicLink()).toBe(true);
  });

  it("syncs only desired runtime skills and prunes stale Rudder-managed symlinks", async () => {
    const root = await makeTempDir("rudder-runtime-skill-sync-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const desiredSkill = path.join(root, "server", "resources", "bundled-skills", "rudder");
    const staleSkill = path.join(root, "server", "resources", "bundled-skills", "rudder-create-agent");
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(desiredSkill, { recursive: true });
    await fs.mkdir(staleSkill, { recursive: true });
    await fs.symlink(staleSkill, path.join(skillsHome, "rudder-create-agent"));

    const logs: string[] = [];
    const loaded = await ensureRudderRuntimeSkillSymlinks({
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      runtimeLabel: "TestRuntime",
      skillsHome,
      availableEntries: [
        { key: "rudder/rudder", runtimeName: "rudder", source: desiredSkill },
        { key: "rudder/rudder-create-agent", runtimeName: "rudder-create-agent", source: staleSkill },
      ],
      desiredSkillKeys: ["rudder/rudder"],
    });

    expect(loaded.map((entry) => entry.key)).toEqual(["rudder/rudder"]);
    expect((await fs.lstat(path.join(skillsHome, "rudder"))).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(path.join(skillsHome, "rudder-create-agent"))).rejects.toThrow();
    expect(logs.some((line) => line.includes('Removed stale TestRuntime skill "rudder-create-agent"'))).toBe(true);
  });

  it("replaces a symlinked managed skills home before pruning to avoid mutating the operator home", async () => {
    const root = await makeTempDir("rudder-runtime-skill-home-symlink-");
    cleanupDirs.add(root);

    const operatorSkillsHome = path.join(root, "operator-home", ".gemini", "skills");
    const managedSkillsHome = path.join(root, "managed-home", ".gemini", "skills");
    const desiredSkill = path.join(root, "server", "resources", "bundled-skills", "rudder");
    const hostSkill = path.join(operatorSkillsHome, "host-only-skill");
    await fs.mkdir(operatorSkillsHome, { recursive: true });
    await fs.mkdir(hostSkill, { recursive: true });
    await fs.mkdir(path.dirname(managedSkillsHome), { recursive: true });
    await fs.mkdir(desiredSkill, { recursive: true });
    await fs.symlink(operatorSkillsHome, managedSkillsHome);

    await ensureRudderRuntimeSkillSymlinks({
      onLog: async () => {},
      runtimeLabel: "Gemini",
      skillsHome: managedSkillsHome,
      availableEntries: [{ key: "rudder/rudder", runtimeName: "rudder", source: desiredSkill }],
      desiredSkillKeys: ["rudder/rudder"],
    });

    expect((await fs.lstat(managedSkillsHome)).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(managedSkillsHome, "rudder"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(hostSkill)).isDirectory()).toBe(true);
  });

  it("prunes disabled adapter-home skills from managed runtime skill homes", async () => {
    const root = await makeTempDir("rudder-runtime-adapter-prune-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "managed-home", ".cursor", "skills");
    const desiredSkill = path.join(root, "server", "resources", "bundled-skills", "rudder");
    const adapterHomeSkill = path.join(root, "operator-home", ".cursor", "skills", "old-adapter-skill");
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(desiredSkill, { recursive: true });
    await fs.mkdir(adapterHomeSkill, { recursive: true });
    await fs.symlink(adapterHomeSkill, path.join(skillsHome, "old-adapter-skill"));

    await ensureRudderRuntimeSkillSymlinks({
      onLog: async () => {},
      runtimeLabel: "Cursor",
      skillsHome,
      availableEntries: [
        { key: "rudder/rudder", runtimeName: "rudder", source: desiredSkill },
        { key: "adapter:cursor:old-adapter-skill", runtimeName: "old-adapter-skill", source: adapterHomeSkill },
      ],
      desiredSkillKeys: ["rudder/rudder"],
    });

    await expect(fs.lstat(path.join(skillsHome, "old-adapter-skill"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "rudder"))).isSymbolicLink()).toBe(true);
  });

  it("replaces conflicting managed skill entries with the selected Rudder skill link", async () => {
    const root = await makeTempDir("rudder-runtime-conflict-replace-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "managed-home", ".gemini", "skills");
    const desiredSkill = path.join(root, "server", "resources", "bundled-skills", "rudder");
    const conflict = path.join(skillsHome, "rudder");
    await fs.mkdir(conflict, { recursive: true });
    await fs.mkdir(desiredSkill, { recursive: true });
    await fs.writeFile(path.join(conflict, "stale.txt"), "stale", "utf8");

    await ensureRudderRuntimeSkillSymlinks({
      onLog: async () => {},
      runtimeLabel: "Gemini",
      skillsHome,
      availableEntries: [{ key: "rudder/rudder", runtimeName: "rudder", source: desiredSkill }],
      desiredSkillKeys: ["rudder/rudder"],
    });

    expect((await fs.lstat(conflict)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(conflict)).toBe(await fs.realpath(desiredSkill));
  });

  it("fails fast when a selected runtime skill cannot be materialized", async () => {
    const root = await makeTempDir("rudder-runtime-skill-link-failure-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "managed-home", ".gemini", "skills");
    const desiredSkill = path.join(root, "server", "resources", "bundled-skills", "rudder");
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(desiredSkill, { recursive: true });

    const logs: string[] = [];
    await expect(ensureRudderRuntimeSkillSymlinks({
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      runtimeLabel: "Gemini",
      skillsHome,
      availableEntries: [{ key: "rudder/rudder", runtimeName: "rudder", source: desiredSkill }],
      desiredSkillKeys: ["rudder/rudder"],
      linkSkill: async () => {
        throw new Error("permission denied");
      },
    })).rejects.toThrow('Failed to inject Gemini skill "rudder/rudder"');

    expect(logs.some((line) => line.includes('Failed to inject Gemini skill "rudder/rudder"'))).toBe(true);
  });

  it("renders the shared runtime skill boundary as a self-reporting contract", () => {
    const prompt = renderRudderRuntimeSkillBoundaryPrompt([
      {
        key: "rudder/rudder",
        runtimeName: "rudder",
        name: "Rudder",
        description: "Use Rudder issue and comment workflows.",
      },
    ]);

    expect(prompt).toContain("# Rudder Runtime Skill Boundary");
    expect(prompt).toContain("Rudder Agent Skills for this run are controlled only by the Rudder Agent Skills page.");
    expect(prompt).toContain("Do not treat adapter-owned, runtime built-in, global, project, plugin, slash-command, or host-installed skills as Rudder Agent Skills unless they are listed above.");
    expect(prompt).toContain("When asked what agent skills you have, answer only from the Enabled Rudder Agent Skills list above.");
  });
});
