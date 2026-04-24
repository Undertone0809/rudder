import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listRudderSkillEntries,
  removeMaintainerOnlySkillSymlinks,
} from "@rudder/agent-runtime-utils/server-utils";

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
});
