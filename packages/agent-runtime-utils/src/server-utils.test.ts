import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupLegacyRudderDocsManagedEntry,
  cleanupRetiredRudderManagedEntries,
  createOperatorInterruptAbortReason,
  createRudderSkillDirectoryLink,
  ensureLocalCliCredentialShimsInPath,
  ensureRudderCliInPath,
  filterRudderDesiredSkillsForBrowserCapability,
  loadAgentInstructionsPrefix,
  prepareAgentInstructionRuntimeContext,
  readRudderRuntimeSkillEntries,
  renderTemplate,
  resolveDesktopCliSpawnTarget,
  resolveLocalOperatorHome,
  resolveRudderCliShimTarget,
  resolveRudderDesiredSkillNames,
  resolveRudderSkillDirectoryLinkType,
  RUDDER_AGENT_HEARTBEAT_INSTRUCTION,
  RUDDER_AGENT_OPERATING_CONTRACT,
  runChildProcess,
  selectPromptTemplate,
  shouldIncludeRuntimeHeartbeatInstructions,
  syncLocalCliCredentialHomeEntries,
} from "./server-utils.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_RUDDER_OPERATOR_HOME = process.env.RUDDER_OPERATOR_HOME;
const ORIGINAL_ZDOTDIR = process.env.ZDOTDIR;
const ORIGINAL_GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL;
const ORIGINAL_GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL;
const ORIGINAL_RUDDER_DESKTOP_CLI_ENTRY = process.env.RUDDER_DESKTOP_CLI_ENTRY;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_RUDDER_OPERATOR_HOME === undefined) delete process.env.RUDDER_OPERATOR_HOME;
  else process.env.RUDDER_OPERATOR_HOME = ORIGINAL_RUDDER_OPERATOR_HOME;
  if (ORIGINAL_ZDOTDIR === undefined) delete process.env.ZDOTDIR;
  else process.env.ZDOTDIR = ORIGINAL_ZDOTDIR;
  if (ORIGINAL_GIT_AUTHOR_EMAIL === undefined) delete process.env.GIT_AUTHOR_EMAIL;
  else process.env.GIT_AUTHOR_EMAIL = ORIGINAL_GIT_AUTHOR_EMAIL;
  if (ORIGINAL_GIT_COMMITTER_EMAIL === undefined) delete process.env.GIT_COMMITTER_EMAIL;
  else process.env.GIT_COMMITTER_EMAIL = ORIGINAL_GIT_COMMITTER_EMAIL;
  if (ORIGINAL_RUDDER_DESKTOP_CLI_ENTRY === undefined) delete process.env.RUDDER_DESKTOP_CLI_ENTRY;
  else process.env.RUDDER_DESKTOP_CLI_ENTRY = ORIGINAL_RUDDER_DESKTOP_CLI_ENTRY;
});

function readPathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? "";
}

function shimName(): string {
  return process.platform === "win32" ? "rudder.cmd" : "rudder";
}

describe("createRudderSkillDirectoryLink", () => {
  it("uses junctions for Windows directory materialization", () => {
    expect(resolveRudderSkillDirectoryLinkType("win32")).toBe("junction");
    expect(resolveRudderSkillDirectoryLinkType("linux")).toBe("dir");
    expect(resolveRudderSkillDirectoryLinkType("darwin")).toBe("dir");
  });

  it("materializes directory skills with a Windows-safe directory link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-skill-link-"));
    const source = path.join(root, "source-skill");
    const target = path.join(root, "managed-skills", "source-skill");

    try {
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), "# Windows-safe skill\n", "utf8");
      await fs.mkdir(path.dirname(target), { recursive: true });

      await expect(createRudderSkillDirectoryLink(source, target)).resolves.toBeUndefined();
      await expect(fs.readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toBe(
        "# Windows-safe skill\n",
      );
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(target)).toBe(await fs.realpath(source));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("cleanupLegacyRudderDocsManagedEntry", () => {
  it("is exposed by the shared runtime utilities", () => {
    expect(cleanupLegacyRudderDocsManagedEntry).toBeTypeOf("function");
  });

  it("removes the dangling legacy symlink derived from the selected canonical Rudder Docs source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-legacy-symlink-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const legacySource = path.join(root, "bundled-skills", "rudder");
    const legacyTarget = path.join(skillsHome, "rudder");

    try {
      await fs.mkdir(skillsHome, { recursive: true });
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.symlink(legacySource, legacyTarget);

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(result).toEqual({
        state: "removed",
        targetPath: legacyTarget,
        legacySourcePath: legacySource,
        kind: "symlink",
      });
      await expect(fs.lstat(legacyTarget)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes the canonical bundled selection key for a dangling legacy symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-bundled-legacy-symlink-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const legacySource = path.join(root, "bundled-skills", "rudder");
    const legacyTarget = path.join(skillsHome, "rudder");

    try {
      await fs.mkdir(skillsHome, { recursive: true });
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.symlink(legacySource, legacyTarget);

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "bundled:rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(result.state).toBe("removed");
      await expect(fs.lstat(legacyTarget)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an exact legacy-source symlink when its target still exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-live-legacy-symlink-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const legacySource = path.join(root, "bundled-skills", "rudder");
    const legacyTarget = path.join(skillsHome, "rudder");

    try {
      await fs.mkdir(skillsHome, { recursive: true });
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.mkdir(legacySource, { recursive: true });
      await fs.symlink(legacySource, legacyTarget);

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(result.state).toBe("collision");
      expect(result.kind).toBe("symlink");
      expect(await fs.realpath(legacyTarget)).toBe(await fs.realpath(legacySource));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a replacement swapped in after initial symlink validation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-symlink-swap-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const legacySource = path.join(root, "bundled-skills", "rudder");
    const legacyTarget = path.join(skillsHome, "rudder");
    let statSpy: { mockRestore: () => void } | null = null;

    try {
      await fs.mkdir(skillsHome, { recursive: true });
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.symlink(legacySource, legacyTarget);
      statSpy = vi.spyOn(fs, "stat").mockImplementationOnce(async () => {
        await fs.unlink(legacyTarget);
        await fs.writeFile(legacyTarget, "replacement\n", "utf8");
        throw Object.assign(new Error("legacy source missing"), { code: "ENOENT" });
      });

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(result.state).toBe("collision");
      await expect(fs.readFile(legacyTarget, "utf8")).resolves.toBe("replacement\n");
    } finally {
      statSpy?.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes a legacy materialized directory only when its Rudder provenance matches the derived source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-legacy-materialized-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const legacySource = path.join(root, "bundled-skills", "rudder");
    const legacyTarget = path.join(skillsHome, "rudder");

    try {
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.mkdir(path.join(legacyTarget, ".rudder"), { recursive: true });
      await fs.writeFile(
        path.join(legacyTarget, ".rudder", "materialized-skill.json"),
        JSON.stringify({ sourcePath: legacySource }),
        "utf8",
      );

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(result).toEqual({
        state: "removed",
        targetPath: legacyTarget,
        legacySourcePath: legacySource,
        kind: "directory",
      });
      await expect(fs.lstat(legacyTarget)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a materialized directory replacement with matching provenance but a different inode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-directory-swap-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const legacySource = path.join(root, "bundled-skills", "rudder");
    const legacyTarget = path.join(skillsHome, "rudder");
    const displacedTarget = path.join(skillsHome, "rudder-original");
    const manifestPath = path.join(legacyTarget, ".rudder", "materialized-skill.json");
    const replacementMarker = path.join(legacyTarget, "replacement.txt");
    let lstatSpy: { mockRestore: () => void } | null = null;

    try {
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.writeFile(manifestPath, JSON.stringify({ sourcePath: legacySource }), "utf8");
      const originalLstat = fs.lstat.bind(fs);
      lstatSpy = vi.spyOn(fs, "lstat").mockImplementationOnce(async () => {
        const originalStats = await originalLstat(legacyTarget);
        await fs.rename(legacyTarget, displacedTarget);
        await fs.mkdir(path.dirname(manifestPath), { recursive: true });
        await fs.writeFile(manifestPath, JSON.stringify({ sourcePath: legacySource }), "utf8");
        await fs.writeFile(replacementMarker, "replacement\n", "utf8");
        return originalStats;
      });

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(result.state).toBe("collision");
      await expect(fs.readFile(replacementMarker, "utf8")).resolves.toBe("replacement\n");
    } finally {
      lstatSpy?.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports a failed state when unlinking the proven dangling symlink fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-unlink-failure-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const legacySource = path.join(root, "bundled-skills", "rudder");
    const legacyTarget = path.join(skillsHome, "rudder");
    let unlinkSpy: { mockRestore: () => void } | null = null;

    try {
      await fs.mkdir(skillsHome, { recursive: true });
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.symlink(legacySource, legacyTarget);
      unlinkSpy = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("simulated unlink failure"));

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(result).toMatchObject({
        state: "failed",
        targetPath: legacyTarget,
        kind: "symlink",
        detail: "unlink failed: simulated unlink failure",
      });
      expect((await fs.lstat(legacyTarget)).isSymbolicLink()).toBe(true);
    } finally {
      unlinkSpy?.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports a failed state when removing the proven materialized directory fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-rm-failure-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const legacySource = path.join(root, "bundled-skills", "rudder");
    const legacyTarget = path.join(skillsHome, "rudder");
    const manifestPath = path.join(legacyTarget, ".rudder", "materialized-skill.json");
    let rmSpy: { mockRestore: () => void } | null = null;

    try {
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.writeFile(manifestPath, JSON.stringify({ sourcePath: legacySource }), "utf8");
      rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("simulated rm failure"));

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(result).toMatchObject({
        state: "failed",
        targetPath: legacyTarget,
        kind: "directory",
        detail: "recursive removal failed: simulated rm failure",
      });
      expect((await fs.lstat(legacyTarget)).isDirectory()).toBe(true);
    } finally {
      rmSpy?.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an unrecognized symlink and reports an ownership collision", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-legacy-symlink-collision-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const unrelatedSource = path.join(root, "user-skills", "rudder");
    const legacyTarget = path.join(skillsHome, "rudder");

    try {
      await fs.mkdir(skillsHome, { recursive: true });
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.symlink(unrelatedSource, legacyTarget);

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(result.state).toBe("collision");
      expect(result.kind).toBe("symlink");
      expect((await fs.lstat(legacyTarget)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(legacyTarget)).toBe(unrelatedSource);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a regular directory without matching Rudder provenance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-legacy-dir-collision-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const legacyTarget = path.join(skillsHome, "rudder");
    const marker = path.join(legacyTarget, "user-owned.txt");

    try {
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.mkdir(legacyTarget, { recursive: true });
      await fs.writeFile(marker, "keep me\n", "utf8");

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(result.state).toBe("collision");
      expect(result.kind).toBe("directory");
      await expect(fs.readFile(marker, "utf8")).resolves.toBe("keep me\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a regular file at the legacy child path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-legacy-file-collision-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const legacyTarget = path.join(skillsHome, "rudder");

    try {
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.mkdir(skillsHome, { recursive: true });
      await fs.writeFile(legacyTarget, "user-owned\n", "utf8");

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(result.state).toBe("collision");
      expect(result.kind).toBe("file");
      await expect(fs.readFile(legacyTarget, "utf8")).resolves.toBe("user-owned\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not trust a selected user skill merely because its runtime name is rudder-docs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-docs-user-skill-"));
    const skillsHome = path.join(root, "managed-skills");
    const userSource = path.join(root, "user-skills", "rudder-docs");
    const userSibling = path.join(root, "user-skills", "rudder");
    const legacyTarget = path.join(skillsHome, "rudder");

    try {
      await fs.mkdir(skillsHome, { recursive: true });
      await fs.mkdir(userSource, { recursive: true });
      await fs.symlink(userSibling, legacyTarget);

      const result = await cleanupLegacyRudderDocsManagedEntry(skillsHome, [{
        key: "user/rudder-docs",
        runtimeName: "rudder-docs",
        source: userSource,
      }]);

      expect(result).toEqual({
        state: "not_applicable",
        targetPath: legacyTarget,
        legacySourcePath: null,
        kind: null,
      });
      expect((await fs.lstat(legacyTarget)).isSymbolicLink()).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("cleanupRetiredRudderManagedEntries", () => {
  it("removes exact retired-source symlinks and provenance-marked materialized directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-retired-skills-"));
    const skillsHome = path.join(root, "managed-skills");
    const bundledRoot = path.join(root, "bundled-skills");
    const canonicalSource = path.join(bundledRoot, "rudder-docs");
    const createAgentSource = path.join(bundledRoot, "rudder-create-agent");
    const createPluginSource = path.join(bundledRoot, "rudder-create-plugin");
    const createAgentTarget = path.join(skillsHome, "rudder-create-agent");
    const createPluginTarget = path.join(skillsHome, "rudder-create-plugin");

    try {
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.mkdir(createAgentSource, { recursive: true });
      await fs.mkdir(path.join(createPluginTarget, ".rudder"), { recursive: true });
      await fs.symlink(createAgentSource, createAgentTarget);
      await fs.writeFile(
        path.join(createPluginTarget, ".rudder", "materialized-skill.json"),
        JSON.stringify({ sourcePath: createPluginSource }),
        "utf8",
      );

      const results = await cleanupRetiredRudderManagedEntries(skillsHome, [{
        key: "rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(results.find((result) => result.runtimeName === "rudder-create-agent")?.state).toBe("removed");
      expect(results.find((result) => result.runtimeName === "rudder-create-plugin")?.state).toBe("removed");
      await expect(fs.lstat(createAgentTarget)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(createPluginTarget)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves same-named user directories and unknown symlinks as reported collisions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-retired-skill-collisions-"));
    const skillsHome = path.join(root, "managed-skills");
    const canonicalSource = path.join(root, "bundled-skills", "rudder-docs");
    const createAgentTarget = path.join(skillsHome, "rudder-create-agent");
    const createPluginTarget = path.join(skillsHome, "rudder-create-plugin");
    const unknownSource = path.join(root, "user-skills", "rudder-create-agent");
    const marker = path.join(createPluginTarget, "USER_OWNED.md");

    try {
      await fs.mkdir(canonicalSource, { recursive: true });
      await fs.mkdir(path.dirname(unknownSource), { recursive: true });
      await fs.mkdir(createPluginTarget, { recursive: true });
      await fs.symlink(unknownSource, createAgentTarget);
      await fs.writeFile(marker, "keep\n", "utf8");

      const results = await cleanupRetiredRudderManagedEntries(skillsHome, [{
        key: "bundled:rudder/rudder-docs",
        runtimeName: "rudder-docs",
        source: canonicalSource,
      }]);

      expect(results.find((result) => result.runtimeName === "rudder-create-agent")).toMatchObject({
        state: "collision",
        kind: "symlink",
      });
      expect(results.find((result) => result.runtimeName === "rudder-create-plugin")).toMatchObject({
        state: "collision",
        kind: "directory",
      });
      expect((await fs.lstat(createAgentTarget)).isSymbolicLink()).toBe(true);
      await expect(fs.readFile(marker, "utf8")).resolves.toBe("keep\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("filterRudderDesiredSkillsForBrowserCapability", () => {
  const available = [
    { key: "bundled:rudder/browser", runtimeName: "browser" },
    { key: "org:keep-skill", runtimeName: "keep-skill" },
  ];
  const desired = available.map((entry) => entry.key);

  it("removes only Browser from the effective desired set after preflight disables it", () => {
    expect(filterRudderDesiredSkillsForBrowserCapability(available, desired, false)).toEqual(["org:keep-skill"]);
  });

  it("preserves the desired set when Browser remains available", () => {
    expect(filterRudderDesiredSkillsForBrowserCapability(available, desired, true)).toEqual(desired);
  });
});

describe("resolveRudderDesiredSkillNames", () => {
  it("preserves an exact nested Rudder repository skill key", () => {
    const nestedRepositorySkill = {
      key: "rudder/rudder/community-helper",
      runtimeName: "community-helper",
    };

    expect(resolveRudderDesiredSkillNames({
      rudderSkillSync: {
        desiredSkills: [nestedRepositorySkill.key],
      },
    }, [nestedRepositorySkill])).toEqual([nestedRepositorySkill.key]);
  });

  it("normalizes legacy Rudder Docs inputs and emits one canonical runtime key", () => {
    const available = [
      { key: "bundled:rudder/rudder-docs", runtimeName: "rudder-docs" },
    ];

    expect(resolveRudderDesiredSkillNames({
      rudderSkillSync: {
        desiredSkills: [
          "rudder",
          "rudder/rudder",
          "bundled:rudder/rudder",
          "bundled:rudder/rudder-docs",
        ],
      },
    }, available)).toEqual(["bundled:rudder/rudder-docs"]);
  });

  it("drops retired creation identities and entries before runtime materialization", () => {
    const available = [
      { key: "bundled:rudder/rudder-docs", runtimeName: "rudder-docs" },
      { key: "rudder/rudder-create-agent", runtimeName: "rudder-create-agent" },
      { key: "organization/org-123/custom-plugin-helper", runtimeName: "rudder-create-plugin" },
    ];

    expect(resolveRudderDesiredSkillNames({
      rudderSkillSync: {
        desiredSkills: [
          "bundled:rudder/rudder-docs",
          "rudder-create-agent",
          "rudder/rudder-create-agent",
          "rudder/rudder/rudder-create-agent",
          "bundled:rudder/rudder-create-agent",
          "rudder-create-plugin",
          "rudder/rudder-create-plugin",
          "rudder/rudder/rudder-create-plugin",
          "bundled:rudder/rudder-create-plugin",
          "organization/org-123/custom-plugin-helper",
        ],
      },
    }, available)).toEqual(["bundled:rudder/rudder-docs"]);
  });

  it("omits retired creation entries from configured runtime projections", async () => {
    await expect(readRudderRuntimeSkillEntries({
      rudderRuntimeSkills: [
        {
          key: "bundled:rudder/rudder-docs",
          runtimeName: "rudder-docs",
          source: "/managed/rudder-docs",
        },
        {
          key: "org:rudder/rudder-create-agent",
          runtimeName: "rudder-create-agent",
          source: "/user-owned/rudder-create-agent",
        },
        {
          key: "organization/org-123/custom-plugin-helper",
          runtimeName: "rudder-create-plugin",
          source: "/user-owned/rudder-create-plugin",
        },
      ],
    }, "/unused")).resolves.toEqual([
      expect.objectContaining({
        key: "bundled:rudder/rudder-docs",
        runtimeName: "rudder-docs",
      }),
    ]);
  });
});

describe("ensureRudderCliInPath", () => {
  it("runs packaged desktop CLIs in Electron's Node mode on every platform", () => {
    const cliEntry = String.raw`C:\Program Files\Rudder\resources\server-package\desktop-cli.js`;
    const cliRunner = String.raw`C:\Program Files\Rudder\resources\server-package\desktop-cli-runner.js`;
    const executable = String.raw`C:\Program Files\Rudder\Rudder.exe`;

    expect(resolveDesktopCliSpawnTarget(cliEntry, executable, "win32", cliRunner)).toEqual({
      command: executable,
      args: [cliRunner],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(resolveDesktopCliSpawnTarget(cliEntry, executable, "darwin", cliRunner)).toEqual({
      command: executable,
      args: [cliRunner],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(resolveDesktopCliSpawnTarget(cliEntry, executable, "linux", cliRunner)).toEqual({
      command: executable,
      args: [cliRunner],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(resolveDesktopCliSpawnTarget(cliEntry, executable, "win32")).toEqual({
      command: executable,
      args: ["--desktop-cli"],
    });
  });

  it("prefers the current source CLI shim over an existing rudder binary on PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cli-source-shim-"));
    const moduleDir = path.join(root, "packages", "agent-runtime-utils", "src");
    const staleBinDir = path.join(root, "stale-bin");
    const staleRudder = path.join(staleBinDir, shimName());
    const tsxEntry = path.join(root, "cli", "node_modules", "tsx", "dist", "cli.mjs");
    const cliSource = path.join(root, "cli", "src", "index.ts");

    try {
      await fs.mkdir(path.dirname(tsxEntry), { recursive: true });
      await fs.mkdir(path.dirname(cliSource), { recursive: true });
      await fs.mkdir(moduleDir, { recursive: true });
      await fs.mkdir(staleBinDir, { recursive: true });
      await fs.writeFile(tsxEntry, "console.log('fake tsx');\n", "utf8");
      await fs.writeFile(cliSource, "console.log('fake rudder source');\n", "utf8");
      await fs.writeFile(
        staleRudder,
        process.platform === "win32" ? "@echo off\r\necho stale\r\n" : "#!/bin/sh\necho stale\n",
        "utf8",
      );
      await fs.chmod(staleRudder, 0o755);

      const env = await ensureRudderCliInPath(moduleDir, {
        PATH: staleBinDir,
      });
      const firstPathEntry = readPathValue(env).split(path.delimiter)[0];
      const shimPath = path.join(firstPathEntry!, shimName());
      const shim = await fs.readFile(shimPath, "utf8");

      expect(firstPathEntry).not.toBe(staleBinDir);
      expect(shim).toContain(tsxEntry);
      expect(shim).toContain(cliSource);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("materializes a shim for non-executable packaged desktop CLI files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cli-packaged-shim-"));
    const packageRoot = path.join(root, "server-package");
    const moduleDir = path.join(packageRoot, "node_modules", "@rudderhq", "agent-runtime-utils", "dist");
    const desktopCli = path.join(packageRoot, "desktop-cli.js");

    try {
      await fs.mkdir(moduleDir, { recursive: true });
      await fs.writeFile(desktopCli, "console.log('fake desktop cli');\n", "utf8");

      const env = await ensureRudderCliInPath(moduleDir, {
        PATH: "",
      });
      const firstPathEntry = readPathValue(env).split(path.delimiter)[0];
      const shimPath = path.join(firstPathEntry!, shimName());
      const shim = await fs.readFile(shimPath, "utf8");

      expect(shim).toContain(desktopCli);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the Desktop CLI entry when the server runs from an external runtime cache", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-cli-external-runtime-shim-"));
    const runtimeModuleDir = path.join(root, "runtimes", "0.4.6", "node_modules", "@rudderhq", "agent-runtime-utils", "dist");
    const desktopCli = path.join(root, "Desktop.app", "Contents", "Resources", "server-package", "desktop-cli.js");
    const desktopExecutable = process.platform === "darwin"
      ? path.join(root, "Desktop.app", "Contents", "MacOS", "Rudder")
      : path.join(root, "Desktop.app", "Contents", process.platform === "win32" ? "Rudder.exe" : "Rudder");
    const desktopManifest = path.join(path.dirname(desktopCli), "rudder-cli-package.json");
    const staleBinDir = path.join(root, "stale-bin");
    const staleRudder = path.join(staleBinDir, shimName());

    try {
      await fs.mkdir(runtimeModuleDir, { recursive: true });
      await fs.mkdir(path.dirname(desktopCli), { recursive: true });
      await fs.mkdir(path.dirname(desktopExecutable), { recursive: true });
      await fs.mkdir(staleBinDir, { recursive: true });
      await fs.writeFile(desktopCli, "console.log('fresh desktop cli');\n", "utf8");
      await fs.writeFile(path.join(path.dirname(desktopCli), "desktop-cli-runner.js"), "console.log('desktop cli runner');\n", "utf8");
      await fs.writeFile(desktopExecutable, "desktop executable\n", "utf8");
      await fs.writeFile(desktopManifest, JSON.stringify({ name: "@rudderhq/cli", version: "0.4.6" }), "utf8");
      await fs.writeFile(
        staleRudder,
        process.platform === "win32" ? "@echo off\r\necho stale\r\n" : "#!/bin/sh\necho stale\n",
        "utf8",
      );
      await fs.chmod(staleRudder, 0o755);
      process.env.RUDDER_DESKTOP_CLI_ENTRY = desktopCli;

      const target = await resolveRudderCliShimTarget(runtimeModuleDir);
      const env = await ensureRudderCliInPath(runtimeModuleDir, { PATH: staleBinDir });
      const firstPathEntry = readPathValue(env).split(path.delimiter)[0];
      const shim = await fs.readFile(path.join(firstPathEntry!, shimName()), "utf8");

      expect(target).toMatchObject({
        command: desktopExecutable,
        args: [path.join(path.dirname(desktopCli), "desktop-cli-runner.js")],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        provenance: "desktop_bundle",
        version: "0.4.6",
      });
      expect(firstPathEntry).not.toBe(staleBinDir);
      expect(shim).toContain(desktopExecutable);
      expect(shim).toContain("ELECTRON_RUN_AS_NODE=1");
      expect(shim).toContain("desktop-cli-runner.js");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("selectPromptTemplate", () => {
  it("keeps issue assignment prompts neutral for non-code work", () => {
    const context = {
      wakeReason: "issue_assigned",
      issue: {
        id: "issue-screenshot",
        title: "Can you see this screen?",
        status: "todo",
        priority: "medium",
        description: "![](/api/assets/screenshot/content)",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-1", name: "Operator" },
      context,
      issue: context.issue,
    });

    expect(rendered).toContain("understand what kind of work it asks for");
    expect(rendered).toContain("Do not assume every issue is a codebase task.");
    expect(rendered).toContain("If the issue is a question, screenshot check, review, planning request, coordination task");
    expect(rendered).toContain("Inspect the codebase and implement a change only when");
    expect(rendered).not.toContain("Use the available tools to explore the codebase");
    expect(rendered).not.toContain("implement a solution.");
  });

  it("renders an issue-aware recovery prompt when recovery metadata and issue context are present", () => {
    const context = {
      wakeReason: "retry_failed_run",
      issue: {
        id: "issue-1",
        title: "Finish CMO onboarding",
        status: "in_progress",
        priority: "high",
        description: "Create the agent, update files, and leave the final comment.",
      },
      recovery: {
        originalRunId: "run-123",
        failureKind: "network_error",
        failureSummary: "Model connection dropped after creating the agent.",
        recoveryTrigger: "manual",
        recoveryMode: "continue_preferred",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-1", name: "CEO" },
      context,
      issue: context.issue,
    });

    expect(rendered).toContain("This is a recovery run, not a fresh task.");
    expect(rendered).toContain("- Original Run ID: run-123");
    expect(rendered).toContain("Finish CMO onboarding");
    expect(rendered).toContain("inspect what the previous run already completed");
    expect(rendered).toContain("Avoid blindly re-running the whole task.");
  });

  it("renders a generic recovery prompt when no issue snapshot is available", () => {
    const context = {
      wakeReason: "process_lost_retry",
      recovery: {
        originalRunId: "run-456",
        failureKind: "process_lost",
        failureSummary: "Local child pid disappeared during execution.",
        recoveryTrigger: "automatic",
        recoveryMode: "continue_preferred",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-2", name: "Worker" },
      context,
    });

    expect(rendered).toContain("This is a recovery run, not a fresh task.");
    expect(rendered).toContain("- Original Run ID: run-456");
    expect(rendered).toContain("- Failure Kind: process_lost");
    expect(rendered).toContain("inspect what the previous run already completed");
    expect(rendered).not.toContain("Current Issue Context");
  });

  it("renders a passive issue follow-up prompt when issue follow-up wakes the agent", () => {
    const context = {
      wakeReason: "issue_passive_followup",
      issue: {
        id: "issue-2",
        title: "Publish onboarding notes",
        status: "in_progress",
        priority: "medium",
        description: "Write the notes and close out the issue.",
      },
      passiveFollowup: {
        originRunId: "run-origin",
        previousRunId: "run-prev",
        attempt: 1,
        maxAttempts: 2,
        reason: "missing_closure",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-3", name: "Builder" },
      context,
      issue: context.issue,
    });

    expect(rendered).toContain("This is a passive issue follow-up");
    expect(rendered).toContain("The previous run ended without sufficient issue close-out.");
    expect(rendered).toContain("- Origin Run ID: run-origin");
    expect(rendered).toContain("Publish onboarding notes");
    expect(rendered).toContain("add a progress comment, mark the issue done, block it with a reason, or hand it off");
  });

  it("injects the shared org resources section into default prompts when present", () => {
    const context = {
      rudderWorkspace: {
        orgResourcesPrompt: "## Organization Resources\n\n- Rudder repo\n  - Kind: directory\n  - Locator: `~/projects/rudder`",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-3", name: "Builder" },
      context,
    });

    expect(rendered).toContain("Continue your Rudder work.");
    expect(rendered).toContain("## Organization Resources");
    expect(rendered).toContain("Locator: `~/projects/rudder`");
  });

  it("renders issue-aware prompts without legacy issue document injection", () => {
    const context = {
      wakeReason: "issue_assigned",
      issue: {
        id: "issue-3",
        title: "Use issue docs",
        status: "todo",
        priority: "medium",
        description: "Short description.",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-4", name: "Builder" },
      context,
      issue: context.issue,
    });

    expect(rendered).toContain("Use issue docs");
    expect(rendered).not.toContain("Legacy Issue Documents");
    expect(rendered).not.toContain("rudder issue documents");
  });

  it("renders reviewer changes-requested comment context before generic assignment prompts", () => {
    const context = {
      wakeSource: "assignment",
      wakeReason: "issue_changes_requested",
      issue: {
        id: "issue-4",
        title: "Fix reviewer feedback",
        status: "in_progress",
        priority: "high",
        description: "Address the review notes.",
      },
      comment: {
        id: "comment-4",
        authorKind: "agent",
        authorLabel: "Riley Reviewer",
        body: "Please add coverage for the todo return path.",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-5", name: "Builder" },
      context,
      issue: context.issue,
      comment: context.comment,
    });

    expect(rendered).toContain("A reviewer requested changes on an issue you own.");
    expect(rendered).toContain("Fix reviewer feedback");
    expect(rendered).toContain("From: Riley Reviewer (agent)");
    expect(rendered).toContain("Please add coverage for the todo return path.");
    expect(rendered).not.toContain("You have been assigned to work on an issue.");
  });

  it("renders comment attribution for assignee and mention wake prompts", () => {
    const issue = {
      id: "issue-5",
      title: "Clarify comment ownership",
      status: "todo",
      priority: "medium",
      description: "Make comment-triggered runs show who commented.",
    };
    const comment = {
      id: "comment-5",
      authorKind: "user",
      authorLabel: "Alex Operator",
      body: "@builder please use the compact interaction pattern.",
    };

    const assigneePrompt = renderTemplate(
      selectPromptTemplate(undefined, { wakeReason: "issue_commented", issue, comment }),
      {
        agent: { id: "agent-6", name: "Builder" },
        context: { wakeReason: "issue_commented", issue, comment },
        issue,
        comment,
      },
    );
    const mentionPrompt = renderTemplate(
      selectPromptTemplate(undefined, { wakeReason: "issue_comment_mentioned", issue, comment }),
      {
        agent: { id: "agent-7", name: "Mentioned Builder" },
        context: { wakeReason: "issue_comment_mentioned", issue, comment },
        issue,
        comment,
      },
    );

    expect(assigneePrompt).toContain("There is a new comment on an issue you own.");
    expect(assigneePrompt).toContain("From: Alex Operator (user)");
    expect(assigneePrompt).toContain("@builder please use the compact interaction pattern.");
    expect(mentionPrompt).toContain("You were mentioned in a comment and your attention is needed.");
    expect(mentionPrompt).toContain("From: Alex Operator (user)");
    expect(mentionPrompt).toContain("@builder please use the compact interaction pattern.");
    expect(mentionPrompt).toContain("A mention-triggered comment wake is a request for attention or collaboration");
    expect(mentionPrompt).toContain("Plain structured agent links such as `agent://agent-id` are reference-only");
    expect(mentionPrompt).toContain("not an automatic transfer of issue ownership");
  });
});

describe("renderTemplate short references", () => {
  it("renders agent-facing entity UUIDs as typed short refs while preserving non-UUID values", () => {
    const agentId = "d573266f-af95-44e6-9303-e903a54662b8";
    const runId = "609695f1-f90a-4b17-be61-4f0c6fe37c42";
    const issueId = "4a6dcb93-e3b8-4ab8-a56e-8ad9bc5e24a2";
    const commentId = "091492ab-3d85-4fcb-b066-1db769eed56d";
    const goalId = "14ff96a7-2518-456a-8aae-480360f0d9aa";
    const projectId = "c9623d48-0f8f-4fb0-965d-2ab264f5e55d";
    const userId = "f2131f87-d8f0-4e43-b955-161c2ac12c46";
    const messageId = "8cbac610-f182-4dae-81dc-03ee6a156deb";

    const rendered = renderTemplate(
      [
        "{{agent.id}}",
        "{{context.recovery.originalRunId}}",
        "{{issue.id}}",
        "{{comment.id}}",
        "{{context.goalRuntime.goalId}}",
        "{{context.agentIssueCreationRequest.projectId}}",
        "{{context.agentIssueCreationRequest.requestedByUserId}}",
        "{{context.messageId}}",
        "{{context.customId}}",
      ].join("|"),
      {
        agent: { id: agentId },
        issue: { id: issueId },
        comment: { id: commentId },
        context: {
          recovery: { originalRunId: runId },
          goalRuntime: { goalId },
          agentIssueCreationRequest: { projectId, requestedByUserId: userId },
          messageId,
          customId: "legacy-identifier",
        },
      },
    );

    expect(rendered).toBe(
      "agt_d573266f|run_609695f1|iss_4a6dcb93|cmt_091492ab|gol_14ff96a7|prj_c9623d48|usr_f2131f87|msg_8cbac610|legacy-identifier",
    );
  });
});

describe("loadAgentInstructionsPrefix", () => {
  it("loads the runtime operating contract without an instruction file", async () => {
    const loaded = await loadAgentInstructionsPrefix({
      instructionsFilePath: "",
      onLog: async () => {},
    });

    expect(loaded.prefix).toContain("<rudder_agent_operating_contract>");
    expect(loaded.prefix).toContain("</rudder_agent_operating_contract>");
    expect(loaded.prefix).not.toContain("# Rudder Agent Operating Contract");
    expect(loaded.prefix).toContain(RUDDER_AGENT_OPERATING_CONTRACT);
    expect(loaded.prefix).toContain("installed but not enabled");
    expect(loaded.prefix).toContain("library:projects/<project-key>/");
    expect(loaded.prefix).toContain("$RUDDER_PROJECT_LIBRARY_ROOT");
    expect(loaded.prefix).toContain("library:artifacts/YYYY-MM-DD/<conversation-title>/");
    expect(loaded.prefix).toContain("$RUDDER_ORG_WORKSPACE_ROOT/artifacts/YYYY-MM-DD/<conversation-title>/");
    expect(loaded.prefix).toContain("Do not choose an existing project, such as Getting Started");
    expect(loaded.prefix).toContain("always include a user-visible Markdown link");
    expect(loaded.prefix).toContain('rudder library file ref "$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>" --json');
    expect(loaded.prefix).toContain('rudder library file ref "artifacts/YYYY-MM-DD/<conversation-title>/<relative-file>" --json');
    expect(loaded.prefix).not.toContain("library-file://file?p=<url-encoded-relative-path>&t=<url-encoded-title>");
    expect(loaded.prefix).toContain("## Rudder Renderable Links");
    expect(loaded.prefix).toContain("prefer Rudder's renderable Markdown link syntax over plain IDs");
    expect(loaded.prefix).toContain("[](issue://<issue-id>)");
    expect(loaded.prefix).toContain("[](agent://<agent-id>)");
    expect(loaded.prefix).toContain("[](agent://<agent-id>?intent=wake)");
    expect(loaded.prefix).toContain("[](automation://<automation-id>)");
    expect(loaded.prefix).toContain("[](project://<project-id>)");
    expect(loaded.prefix).toContain("[](chat://<conversation-id>)");
    expect(loaded.prefix).toContain("[](skill://<skill-ref>)");
    expect(loaded.prefix).toContain("local-machine skill ref");
    expect(loaded.prefix).toContain("Library files: use the `markdownLink` returned by");
    expect(loaded.prefix).toContain("not inside code spans or code blocks");
    expect(loaded.prefix).toContain("Use `$RUDDER_RUNTIME_TMPDIR` for transient scratch files");
    expect(loaded.prefix).toContain("Local trusted runtimes may expose the host operator home as `$RUDDER_OPERATOR_HOME`");
    expect(loaded.prefix).toContain("[NameSilo transfer page](https://www.namesilo.com/account_domain_manage_transfer.php)");
    expect(loaded.prefix).toContain("Do not put action URLs in backticks or code blocks");
    expect(loaded.prefix).toContain("agent://agent-id?intent=wake");
    expect(loaded.prefix).toContain("Plain structured links such as `agent://agent-id` are reference-only links");
    expect(loaded.prefix).toContain("plain text agent names are not wake requests");
    expect(loaded.prefix).toContain("Use wake-intent links only when you intentionally want to wake another agent");
    expect(loaded.prefix).toContain("attach the image with the Rudder CLI `--image <path>` option");
    expect(loaded.prefix).not.toContain("## Current Time");
    expect(loaded.prefix).not.toContain("Instruction load time:");
    expect(loaded.prefix).not.toContain("Treat this as the current time for this run");
    expect(loaded.commandNotes).toEqual(["Loaded Rudder agent operating contract from runtime code"]);
    expect(loaded.readFailed).toBe(false);
    expect(loaded.memoryFilePath).toBeNull();
    expect(loaded.metrics.instructionsChars).toBe(loaded.prefix.length);
    expect(loaded.metrics.operatingContractChars).toBeGreaterThan(0);
    expect(loaded.metrics.runtimeHeartbeatChars).toBe(0);
    expect(loaded.metrics.instructionEntryChars).toBe(0);
    expect(loaded.metrics.memoryChars).toBe(0);
    expect(loaded.metrics.heartbeatFileChars).toBe(0);
    expect(loaded.metrics.heartbeatChars).toBe(0);
  });

  it("loads the runtime heartbeat instruction for heartbeat scenes without requiring a HEARTBEAT.md file", async () => {
    const loaded = await loadAgentInstructionsPrefix({
      instructionsFilePath: "",
      includeHeartbeatInstructions: true,
      onLog: async () => {},
    });

    expect(loaded.prefix).toContain("<rudder_agent_operating_contract>");
    expect(loaded.prefix).toContain("<rudder_heartbeat_instruction>");
    expect(loaded.prefix).toContain(RUDDER_AGENT_HEARTBEAT_INSTRUCTION);
    expect(loaded.prefix).toContain("platform-owned heartbeat/self-check pipeline");
    expect(loaded.commandNotes).toEqual([
      "Loaded Rudder agent operating contract from runtime code",
      "Loaded Rudder heartbeat instructions from runtime code",
    ]);
    expect(loaded.heartbeatFilePath).toBeNull();
    expect(loaded.metrics.runtimeHeartbeatChars).toBeGreaterThan(0);
    expect(loaded.metrics.heartbeatFileChars).toBe(0);
    expect(loaded.metrics.heartbeatChars).toBe(loaded.metrics.runtimeHeartbeatChars);
  });

  it("does not request runtime heartbeat instructions for comment-triggered issue wakes", () => {
    expect(shouldIncludeRuntimeHeartbeatInstructions({ rudderScene: "heartbeat" })).toBe(true);
    expect(shouldIncludeRuntimeHeartbeatInstructions({ rudderScene: "issue", wakeReason: "issue_assigned" })).toBe(false);
    expect(shouldIncludeRuntimeHeartbeatInstructions({ rudderScene: "review", wakeReason: "issue_review_requested" })).toBe(false);
    expect(shouldIncludeRuntimeHeartbeatInstructions({ rudderScene: "automation" })).toBe(false);
    expect(shouldIncludeRuntimeHeartbeatInstructions({ rudderScene: "chat" })).toBe(false);
    expect(shouldIncludeRuntimeHeartbeatInstructions({ rudderScene: "issue", wakeReason: "issue_commented" })).toBe(false);
    expect(shouldIncludeRuntimeHeartbeatInstructions({ rudderScene: "issue", wakeReason: "issue_comment_mentioned" })).toBe(false);
    expect(shouldIncludeRuntimeHeartbeatInstructions({ rudderScene: "issue", wakeReason: "issue_reopened_via_comment" })).toBe(false);
  });

  it("loads the operating contract and entry instructions when no sibling memory file exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-entry-"));
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(loaded.prefix).toContain("<rudder_agent_operating_contract>");
      expect(loaded.prefix).toContain("# Agent Instructions");
      expect(loaded.prefix).toContain("<AGENTS.md>\n# Agent Instructions\n</AGENTS.md>");
      expect(loaded.prefix).toContain("The above AGENTS.md instruction file was loaded from $AGENT_HOME/instructions.");
      expect(loaded.prefix).toContain("relative file references from $AGENT_HOME/instructions/");
      expect(loaded.prefix).not.toContain("Tacit Memory");
      expect(loaded.commandNotes).toEqual([
        "Loaded Rudder agent operating contract from runtime code",
        "Loaded agent instructions from $AGENT_HOME/instructions/AGENTS.md",
      ]);
      expect(loaded.memoryFilePath).toBeNull();
      expect(loaded.metrics.instructionsChars).toBe(loaded.prefix.length);
      expect(loaded.metrics.operatingContractChars).toBeGreaterThan(0);
      expect(loaded.metrics.runtimeHeartbeatChars).toBe(0);
      expect(loaded.metrics.instructionEntryChars).toBeGreaterThan(0);
      expect(loaded.metrics.memoryChars).toBe(0);
      expect(logs).toContainEqual(expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining("[rudder] Loaded agent instructions file: $AGENT_HOME/instructions/AGENTS.md"),
      }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses a stable escaped wrapper for a non-canonical configured entry file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-custom-entry-"));
    const instructionsPath = path.join(root, "instructions", "custom role.md");
    const contents = "    generic entry code block\n\nKeep <angle brackets> and Markdown unchanged.\n";
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, contents, "utf8");

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        onLog: async () => {},
      });

      expect(loaded.prefix).toContain(
        `<agent_instruction_file path="$AGENT_HOME/instructions/custom role.md">\n${contents.trimEnd()}\n</agent_instruction_file>`,
      );
      expect(loaded.prefix).not.toContain("<custom role.md>");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves leading blank lines and indented Markdown in canonical instruction files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-leading-markdown-"));
    const instructionsPath = path.join(root, "instructions", "SOUL.md");
    const contents = "\n    canonical code block\n\nKeep the leading bytes.\n";
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, contents, "utf8");

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        onLog: async () => {},
      });

      expect(loaded.prefix).toContain(
        `<SOUL.md>\n${contents.trimEnd()}\n</SOUL.md>`,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("loads the entry instructions file plus sibling SOUL.md, TOOLS.md, and MEMORY.md", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-memory-"));
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const soulPath = path.join(root, "instructions", "SOUL.md");
    const toolsPath = path.join(root, "instructions", "TOOLS.md");
    const memoryPath = path.join(root, "instructions", "MEMORY.md");
    const heartbeatPath = path.join(root, "instructions", "HEARTBEAT.md");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Instructions\n", "utf8");
    await fs.writeFile(soulPath, "# Persona\n\nYou are QA.\n", "utf8");
    await fs.writeFile(toolsPath, "# Tools\n\n- Use rudder.\n", "utf8");
    await fs.writeFile(memoryPath, "# Tacit Memory\n\n- Prefer concise updates.\n", "utf8");
    await fs.writeFile(heartbeatPath, "# Heartbeat\n\n- Check assignments.\n", "utf8");

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        onLog: async () => {},
      });

      expect(loaded.prefix).toContain("# Agent Instructions");
      expect(loaded.prefix).toContain("# Persona");
      expect(loaded.prefix).toContain("# Tools");
      expect(loaded.prefix).toContain("# Tacit Memory");
      expect(loaded.prefix).toContain("<AGENTS.md>\n# Agent Instructions\n</AGENTS.md>");
      expect(loaded.prefix).toContain("<SOUL.md>\n# Persona\n\nYou are QA.\n</SOUL.md>");
      expect(loaded.prefix).toContain("<TOOLS.md>\n# Tools\n\n- Use rudder.\n</TOOLS.md>");
      expect(loaded.prefix).toContain("<MEMORY.md>\n# Tacit Memory\n\n- Prefer concise updates.\n</MEMORY.md>");
      expect(loaded.prefix).not.toContain("# Heartbeat");
      expect(loaded.prefix).not.toContain("## Current Time");
      expect(loaded.prefix).toContain("The above AGENTS.md, SOUL.md, TOOLS.md, MEMORY.md instruction files were loaded from $AGENT_HOME/instructions.");
      expect(loaded.prefix.match(/Resolve any relative file references from \$AGENT_HOME\/instructions\/\./g)).toHaveLength(1);
      expect(loaded.prefix).not.toContain("Instruction load time:");
      expect(loaded.commandNotes).toContain("Loaded agent instructions from $AGENT_HOME/instructions/AGENTS.md");
      expect(loaded.commandNotes).toContain("Loaded agent soul instructions from $AGENT_HOME/instructions/SOUL.md");
      expect(loaded.commandNotes).toContain("Loaded agent tool notes from $AGENT_HOME/instructions/TOOLS.md");
      expect(loaded.commandNotes).toContain("Loaded agent memory instructions from $AGENT_HOME/instructions/MEMORY.md");
      expect(loaded.commandNotes).not.toContain("Loaded agent heartbeat instructions from $AGENT_HOME/instructions/HEARTBEAT.md");
      expect(loaded.soulFilePath).toBe(soulPath);
      expect(loaded.toolsFilePath).toBe(toolsPath);
      expect(loaded.memoryFilePath).toBe(memoryPath);
      expect(loaded.heartbeatFilePath).toBeNull();
      expect(loaded.metrics.instructionsChars).toBe(loaded.prefix.length);
      expect(loaded.metrics.operatingContractChars).toBeGreaterThan(0);
      expect(loaded.metrics.runtimeHeartbeatChars).toBe(0);
      expect(loaded.metrics.instructionEntryChars).toBeGreaterThan(0);
      expect(loaded.metrics.soulChars).toBeGreaterThan(0);
      expect(loaded.metrics.toolsChars).toBeGreaterThan(0);
      expect(loaded.metrics.memoryChars).toBeGreaterThan(0);
      expect(loaded.metrics.heartbeatFileChars).toBe(0);
      expect(loaded.metrics.heartbeatChars).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("loads instruction file contents without synthetic Agent Instruction headings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-soul-entry-boundaries-"));
    const instructionsPath = path.join(root, "instructions", "SOUL.md");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Persona\n\nYou are QA.\n", "utf8");
    await fs.writeFile(path.join(root, "instructions", "TOOLS.md"), "# Tool Notes\n\n- Use rudder.\n", "utf8");
    await fs.writeFile(path.join(root, "instructions", "MEMORY.md"), "# Memory Notes\n\n- Prefer concise updates.\n", "utf8");

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        includeHeartbeatInstructions: true,
        instructionContextSections: ["<recent_rudder_context>\n#### today memory: 2026-06-21.md\n- Calibrate prompt stack\n</recent_rudder_context>"],
        onLog: async () => {},
      });

      const operatingContractIndex = loaded.prefix.indexOf("<rudder_agent_operating_contract>");
      const soulIndex = loaded.prefix.indexOf("# Persona");
      const toolsIndex = loaded.prefix.indexOf("# Tool Notes");
      const memoryIndex = loaded.prefix.indexOf("# Memory Notes");
      const recentContextIndex = loaded.prefix.indexOf("<recent_rudder_context>");
      const heartbeatIndex = loaded.prefix.indexOf("<rudder_heartbeat_instruction>");

      expect(operatingContractIndex).toBeGreaterThanOrEqual(0);
      expect(soulIndex).toBeGreaterThan(operatingContractIndex);
      expect(toolsIndex).toBeGreaterThan(soulIndex);
      expect(memoryIndex).toBeGreaterThan(toolsIndex);
      expect(recentContextIndex).toBeGreaterThan(memoryIndex);
      expect(heartbeatIndex).toBeGreaterThan(recentContextIndex);
      expect(loaded.prefix).not.toContain("## Current Time");
      expect(loaded.prefix).toContain("# Persona");
      expect(loaded.prefix).toContain("# Tool Notes");
      expect(loaded.prefix).toContain("# Memory Notes");
      expect(loaded.prefix).toContain("<SOUL.md>\n# Persona");
      expect(loaded.prefix).toContain("<TOOLS.md>\n# Tool Notes");
      expect(loaded.prefix).toContain("<MEMORY.md>\n# Memory Notes");
      expect(loaded.prefix).not.toContain("## Agent Instruction:");
      expect(loaded.prefix).not.toContain("Agent Instruction: SOUL.md");
      expect(loaded.prefix).not.toContain("The above SOUL.md content was loaded");
      expect(loaded.prefix).not.toContain("The above TOOLS.md content was loaded");
      expect(loaded.prefix).not.toContain("The above MEMORY.md content was loaded");
      expect(loaded.prefix).toContain("The above SOUL.md, TOOLS.md, MEMORY.md instruction files were loaded from $AGENT_HOME/instructions.");
      expect(loaded.prefix.match(/Resolve any relative file references from \$AGENT_HOME\/instructions\/\./g)).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores sibling HEARTBEAT.md even when heartbeat instructions are requested", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-heartbeat-"));
    const instructionsPath = path.join(root, "instructions", "SOUL.md");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Persona\n\nYou are QA.\n", "utf8");
    await fs.writeFile(path.join(root, "instructions", "HEARTBEAT.md"), "# Heartbeat\n\n- Check assignments.\n", "utf8");

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        includeHeartbeatInstructions: true,
        onLog: async () => {},
      });

      expect(loaded.prefix).toContain("# Persona");
      expect(loaded.prefix).toContain("<rudder_heartbeat_instruction>");
      expect(loaded.prefix).not.toContain("# Heartbeat\n\n- Check assignments.");
      expect(loaded.commandNotes).toContain("Loaded Rudder heartbeat instructions from runtime code");
      expect(loaded.commandNotes).not.toContain("Loaded supplemental agent heartbeat notes from $AGENT_HOME/instructions/HEARTBEAT.md");
      expect(loaded.heartbeatFilePath).toBeNull();
      expect(loaded.metrics.runtimeHeartbeatChars).toBeGreaterThan(0);
      expect(loaded.metrics.heartbeatFileChars).toBe(0);
      expect(loaded.metrics.heartbeatChars).toBe(loaded.metrics.runtimeHeartbeatChars);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("appends runtime heartbeat instructions after the stable agent instruction stack", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-heartbeat-order-"));
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent Contract\n", "utf8");
    await fs.writeFile(path.join(root, "instructions", "SOUL.md"), "# Agent Soul\n", "utf8");
    await fs.writeFile(path.join(root, "instructions", "TOOLS.md"), "# Agent Tools\n", "utf8");
    await fs.writeFile(path.join(root, "instructions", "MEMORY.md"), "# Agent Memory\n", "utf8");

    try {
      const instructionContext = prepareAgentInstructionRuntimeContext({
        rudderWorkspace: {
          orgResourcesPrompt: "<current_automations>\n- Morning review\n</current_automations>",
          resourcesPrompt: "<current_automations>\n- Morning review\n</current_automations>",
        },
      });
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        includeHeartbeatInstructions: true,
        instructionContextSections: instructionContext.instructionContextSections,
        onLog: async () => {},
      });

      const operatingContractIndex = loaded.prefix.indexOf("<rudder_agent_operating_contract>");
      const agentContractIndex = loaded.prefix.indexOf("# Agent Contract");
      const soulIndex = loaded.prefix.indexOf("# Agent Soul");
      const toolsIndex = loaded.prefix.indexOf("# Agent Tools");
      const memoryIndex = loaded.prefix.indexOf("# Agent Memory");
      const automationsIndex = loaded.prefix.indexOf("<current_automations>");
      const heartbeatIndex = loaded.prefix.indexOf("<rudder_heartbeat_instruction>");

      expect(operatingContractIndex).toBeGreaterThanOrEqual(0);
      expect(agentContractIndex).toBeGreaterThan(operatingContractIndex);
      expect(soulIndex).toBeGreaterThan(agentContractIndex);
      expect(toolsIndex).toBeGreaterThan(soulIndex);
      expect(memoryIndex).toBeGreaterThan(toolsIndex);
      expect(automationsIndex).toBeGreaterThan(memoryIndex);
      expect(heartbeatIndex).toBeGreaterThan(automationsIndex);
      expect(loaded.prefix).not.toContain("## Current Time");
      expect(loaded.prefix).toMatch(/<rudder_heartbeat_instruction>[\s\S]*runtime\.\n<\/rudder_heartbeat_instruction>$/);
      expect(renderTemplate(
        "{{context.rudderWorkspace.orgResourcesPrompt}}",
        { context: instructionContext.promptContext },
      )).toBe("");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("moves all documented resource prompt aliases into the stable instruction stack", async () => {
    const canonicalPrompt = "<current_automations>\n- Canonical\n</current_automations>";
    const topLevelOnly = prepareAgentInstructionRuntimeContext({
      rudderResourcesPrompt: canonicalPrompt,
    });
    expect(topLevelOnly.instructionContextSections).toEqual([canonicalPrompt]);
    expect(renderTemplate("{{context.rudderResourcesPrompt}}", { context: topLevelOnly.promptContext })).toBe("");

    const resourcesOnly = prepareAgentInstructionRuntimeContext({
      rudderWorkspace: {
        resourcesPrompt: canonicalPrompt,
      },
    });
    expect(resourcesOnly.instructionContextSections).toEqual([canonicalPrompt]);
    expect(renderTemplate(
      "{{context.rudderWorkspace.resourcesPrompt}}",
      { context: resourcesOnly.promptContext },
    )).toBe("");

    const legacyOnly = prepareAgentInstructionRuntimeContext({
      rudderWorkspace: {
        orgResourcesPrompt: canonicalPrompt,
      },
    });
    expect(legacyOnly.instructionContextSections).toEqual([canonicalPrompt]);
    expect(renderTemplate(
      "{{context.rudderWorkspace.orgResourcesPrompt}}",
      { context: legacyOnly.promptContext },
    )).toBe("");
  });

  it("prefers canonical resourcesPrompt and only clears matching resource prompt aliases", async () => {
    const canonicalPrompt = "<project_context_resources>\n- Canonical library context\n</project_context_resources>";
    const legacyPrompt = "## Legacy Resources\n\n- Legacy fallback";
    const prepared = prepareAgentInstructionRuntimeContext({
      rudderResourcesPrompt: canonicalPrompt,
      rudderWorkspace: {
        resourcesPrompt: canonicalPrompt,
        orgResourcesPrompt: legacyPrompt,
      },
    });

    expect(prepared.instructionContextSections).toEqual([canonicalPrompt]);
    expect(renderTemplate("{{context.rudderResourcesPrompt}}", { context: prepared.promptContext })).toBe("");
    expect(renderTemplate(
      "{{context.rudderWorkspace.resourcesPrompt}}",
      { context: prepared.promptContext },
    )).toBe("");
    expect(renderTemplate(
      "{{context.rudderWorkspace.orgResourcesPrompt}}",
      { context: prepared.promptContext },
    )).toBe(legacyPrompt);
  });

  it("ignores HEARTBEAT.md when it is the entry file outside heartbeat runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-heartbeat-entry-skip-"));
    const instructionsPath = path.join(root, "instructions", "HEARTBEAT.md");
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Heartbeat\n\n- Check assignments.\n", "utf8");

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(loaded.prefix).toContain("<rudder_agent_operating_contract>");
      expect(loaded.prefix).not.toContain("# Heartbeat");
      expect(loaded.commandNotes).toContain("Ignored legacy HEARTBEAT.md instructions file: $AGENT_HOME/instructions/HEARTBEAT.md");
      expect(loaded.heartbeatFilePath).toBeNull();
      expect(loaded.readFailed).toBe(false);
      expect(loaded.metrics.instructionEntryChars).toBe(0);
      expect(loaded.metrics.runtimeHeartbeatChars).toBe(0);
      expect(loaded.metrics.heartbeatFileChars).toBe(0);
      expect(loaded.metrics.heartbeatChars).toBe(0);
      expect(logs).toContainEqual(expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining("[rudder] Ignored legacy agent heartbeat instructions file: $AGENT_HOME/instructions/HEARTBEAT.md"),
      }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores HEARTBEAT.md entry files for heartbeat runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-heartbeat-entry-load-"));
    const instructionsPath = path.join(root, "instructions", "HEARTBEAT.md");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "# Heartbeat\n\n- Check assignments.\n", "utf8");

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        includeHeartbeatInstructions: true,
        onLog: async () => {},
      });

      expect(loaded.prefix).toContain("<rudder_heartbeat_instruction>");
      expect(loaded.prefix).not.toContain("# Heartbeat\n\n- Check assignments.");
      expect(loaded.commandNotes).toContain("Loaded Rudder heartbeat instructions from runtime code");
      expect(loaded.commandNotes).toContain("Ignored legacy HEARTBEAT.md instructions file: $AGENT_HOME/instructions/HEARTBEAT.md");
      expect(loaded.heartbeatFilePath).toBeNull();
      expect(loaded.metrics.instructionEntryChars).toBe(0);
      expect(loaded.metrics.runtimeHeartbeatChars).toBeGreaterThan(0);
      expect(loaded.metrics.heartbeatFileChars).toBe(0);
      expect(loaded.metrics.heartbeatChars).toBe(loaded.metrics.runtimeHeartbeatChars);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the existing warning behavior when the entry file is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-load-agent-instructions-missing-"));
    const instructionsPath = path.join(root, "instructions", "AGENTS.md");
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    try {
      const loaded = await loadAgentInstructionsPrefix({
        instructionsFilePath: instructionsPath,
        warningStream: "stderr",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(loaded.prefix).toContain("<rudder_agent_operating_contract>");
      expect(loaded.prefix).not.toContain("# Agent Instructions");
      expect(loaded.readFailed).toBe(true);
      expect(loaded.commandNotes).toContain(
        "Configured instructionsFilePath $AGENT_HOME/instructions/AGENTS.md, but file could not be read; continuing without injected instructions.",
      );
      expect(loaded.metrics.instructionsChars).toBe(loaded.prefix.length);
      expect(loaded.metrics.operatingContractChars).toBeGreaterThan(0);
      expect(loaded.metrics.instructionEntryChars).toBe(0);
      expect(loaded.metrics.memoryChars).toBe(0);
      expect(logs).toContainEqual(expect.objectContaining({
        stream: "stderr",
        chunk: expect.stringContaining(`could not read agent instructions file "${instructionsPath}"`),
      }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("runChildProcess", () => {
  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : null;
      return code === "EPERM";
    }
  }

  async function waitForPidExit(pid: number, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`process ${pid} remained alive after ${timeoutMs}ms`);
  }

  function forceKillProcessGroup(pid: number | null): void {
    if (process.platform === "win32" || pid === null) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group already exited.
    }
  }

  it("does not expose the Desktop CLI entry to provider child processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-run-child-process-desktop-cli-env-"));
    const capturePath = path.join(root, "env.json");
    const scriptPath = path.join(root, "capture-env.mjs");
    await fs.writeFile(
      scriptPath,
      "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], JSON.stringify(process.env.RUDDER_DESKTOP_CLI_ENTRY ?? null));\n",
      "utf8",
    );
    process.env.RUDDER_DESKTOP_CLI_ENTRY = "/private/Desktop.app/desktop-cli.js";

    try {
      const result = await runChildProcess("run-child-process-desktop-cli-env", process.execPath, [scriptPath, capturePath], {
        cwd: root,
        env: {},
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(await fs.readFile(capturePath, "utf8"))).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves explicit blank Git identity env overrides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-run-child-process-git-env-"));
    const capturePath = path.join(root, "env.json");
    const scriptPath = path.join(root, "capture-env.mjs");
    await fs.writeFile(
      scriptPath,
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync(process.argv[2], JSON.stringify({",
        "  authorEmail: process.env.GIT_AUTHOR_EMAIL ?? null,",
        "  committerEmail: process.env.GIT_COMMITTER_EMAIL ?? null,",
        "}));",
      ].join("\n"),
      "utf8",
    );

    process.env.GIT_AUTHOR_EMAIL = "host@machine.local";
    process.env.GIT_COMMITTER_EMAIL = "host@machine.local";

    try {
      const result = await runChildProcess("run-child-process-git-env", process.execPath, [scriptPath, capturePath], {
        cwd: root,
        env: { GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_EMAIL: "" },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        authorEmail: string | null;
        committerEmail: string | null;
      };
      expect(capture.authorEmail).toBe("");
      expect(capture.committerEmail).toBe("");
    } finally {
      delete process.env.GIT_AUTHOR_EMAIL;
      delete process.env.GIT_COMMITTER_EMAIL;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("drops inherited ZDOTDIR when HOME is isolated for the child process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-run-child-process-"));
    const capturePath = path.join(root, "env.json");
    const childHome = path.join(root, "isolated-home");
    const scriptPath = path.join(root, "capture-env.mjs");
    await fs.mkdir(childHome, { recursive: true });
    await fs.writeFile(
      scriptPath,
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync(process.argv[2], JSON.stringify({",
        "  home: process.env.HOME ?? null,",
        "  zdotdir: process.env.ZDOTDIR ?? null,",
        "}));",
      ].join("\n"),
      "utf8",
    );

    process.env.HOME = "/Users/host-user";
    process.env.ZDOTDIR = "/Users/host-user";

    try {
      const result = await runChildProcess("run-child-process-zdotdir", process.execPath, [scriptPath, capturePath], {
        cwd: root,
        env: { HOME: childHome },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        home: string | null;
        zdotdir: string | null;
      };
      expect(capture.home).toBe(childHome);
      expect(capture.zdotdir).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an explicit ZDOTDIR override for the child process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-run-child-process-zdotdir-explicit-"));
    const capturePath = path.join(root, "env.json");
    const childHome = path.join(root, "isolated-home");
    const childZdotdir = path.join(root, "isolated-zdotdir");
    const scriptPath = path.join(root, "capture-env.mjs");
    await fs.mkdir(childHome, { recursive: true });
    await fs.mkdir(childZdotdir, { recursive: true });
    await fs.writeFile(
      scriptPath,
      [
        "import fs from 'node:fs';",
        "fs.writeFileSync(process.argv[2], JSON.stringify({",
        "  home: process.env.HOME ?? null,",
        "  zdotdir: process.env.ZDOTDIR ?? null,",
        "}));",
      ].join("\n"),
      "utf8",
    );

    process.env.HOME = "/Users/host-user";
    process.env.ZDOTDIR = "/Users/host-user";

    try {
      const result = await runChildProcess("run-child-process-zdotdir-explicit", process.execPath, [scriptPath, capturePath], {
        cwd: root,
        env: { HOME: childHome, ZDOTDIR: childZdotdir },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        home: string | null;
        zdotdir: string | null;
      };
      expect(capture.home).toBe(childHome);
      expect(capture.zdotdir).toBe(childZdotdir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("keeps the configured grace for a generic abort without an operator reason", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-run-child-process-abort-"));
    const scriptPath = path.join(root, "ignore-sigterm.mjs");
    let spawnedPid: number | null = null;
    let abortedAt = 0;
    await fs.writeFile(
      scriptPath,
      [
        "process.on('SIGTERM', () => {});",
        "console.log('ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const controller = new AbortController();
    const startedAt = Date.now();

    try {
      const result = await runChildProcess("run-child-process-ignore-sigterm", process.execPath, [scriptPath], {
        cwd: root,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        abortSignal: controller.signal,
        onSpawn: async ({ pid }) => {
          spawnedPid = pid;
        },
        onLog: async (_stream, chunk) => {
          if (chunk.includes("ready") && abortedAt === 0) {
            abortedAt = Date.now();
            controller.abort();
          }
        },
      });

      expect(result.signal).toBe("SIGTERM");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(abortedAt).toBeGreaterThan(0);
      expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(800);
      expect(spawnedPid).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => process.kill(spawnedPid!, 0)).toThrow();
    } finally {
      controller.abort();
      forceKillProcessGroup(spawnedPid);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it.runIf(process.platform !== "win32")("kills a stubborn parent and grandchild by the operator hard deadline without forwarding post-abort output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-run-child-process-group-abort-"));
    const parentScriptPath = path.join(root, "stubborn-parent.mjs");
    const grandchildScriptPath = path.join(root, "stubborn-grandchild.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    const controller = new AbortController();
    const liveLogs: string[] = [];
    let parentPid: number | null = null;
    let grandchildPid: number | null = null;
    let abortedAt = 0;

    await fs.writeFile(
      grandchildScriptPath,
      [
        "process.on('SIGTERM', () => console.log('grandchild-after-abort'));",
        "console.log('grandchild-ready');",
        "setInterval(() => console.log('grandchild-tick'), 25);",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      parentScriptPath,
      [
        "import { spawn } from 'node:child_process';",
        "import fs from 'node:fs';",
        "process.on('SIGTERM', () => console.log('parent-after-abort'));",
        `const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildScriptPath)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
        "fs.writeFileSync(process.argv[2], String(grandchild.pid));",
        "console.log('parent-ready');",
        "setInterval(() => console.log('parent-tick'), 25);",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = await runChildProcess(
        "run-child-process-group-operator-abort",
        process.execPath,
        [parentScriptPath, grandchildPidPath],
        {
          cwd: root,
          env: {},
          timeoutSec: 10,
          graceSec: 5,
          abortSignal: controller.signal,
          onSpawn: async ({ pid }) => {
            parentPid = pid;
          },
          onLog: async (_stream, chunk) => {
            liveLogs.push(chunk);
            if (abortedAt === 0 && chunk.includes("grandchild-ready")) {
              grandchildPid = Number(await fs.readFile(grandchildPidPath, "utf8"));
              abortedAt = Date.now();
              controller.abort(createOperatorInterruptAbortReason(250));
            }
          },
        },
      );

      expect(result.signal).toBe("SIGTERM");
      expect(abortedAt).toBeGreaterThan(0);
      expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(150);
      expect(Date.now() - abortedAt).toBeLessThan(1_500);
      expect(result.stdout).toContain("parent-after-abort");
      expect(result.stdout).toContain("grandchild-after-abort");
      expect(liveLogs.join("")).not.toContain("parent-after-abort");
      expect(liveLogs.join("")).not.toContain("grandchild-after-abort");
      expect(parentPid).not.toBeNull();
      expect(grandchildPid).not.toBeNull();
      await waitForPidExit(parentPid!);
      await waitForPidExit(grandchildPid!);
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(createOperatorInterruptAbortReason(1));
      }
      forceKillProcessGroup(parentPid);
      if (grandchildPid !== null && isPidAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // The process already exited.
        }
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it.runIf(process.platform === "win32")("times out Windows cmd wrappers without waiting for the wrapped process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-run-child-process-cmd-timeout-"));
    const scriptPath = path.join(root, "slow-child.mjs");
    const wrapperPath = path.join(root, "slow-child.cmd");
    await fs.writeFile(
      scriptPath,
      [
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      wrapperPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}"\r\n`,
      "utf8",
    );

    const startedAt = Date.now();

    try {
      const result = await runChildProcess("run-child-process-cmd-timeout", wrapperPath, [], {
        cwd: root,
        env: {},
        timeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
      });

      expect(result.timedOut).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("syncLocalCliCredentialHomeEntries", () => {
  it("uses explicit operator home when the source env HOME is already isolated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-creds-operator-"));
    const operatorHome = path.join(root, "operator-home");
    const isolatedHome = path.join(root, "isolated-home");
    const targetHome = path.join(root, "agent-home");
    const operatorGh = path.join(operatorHome, ".config", "gh");
    await fs.mkdir(operatorGh, { recursive: true });
    await fs.writeFile(path.join(operatorGh, "hosts.yml"), "github.com:\n  oauth_token: operator\n", "utf8");
    await fs.mkdir(path.join(isolatedHome, ".config", "gh"), { recursive: true });

    try {
      const resolvedSourceHome = resolveLocalOperatorHome({
        HOME: isolatedHome,
        RUDDER_OPERATOR_HOME: operatorHome,
      } as NodeJS.ProcessEnv);
      const result = await syncLocalCliCredentialHomeEntries({
        sourceHome: resolvedSourceHome,
        targetHome,
        entries: [".config/gh"],
      });

      expect(resolvedSourceHome).toBe(operatorHome);
      expect(result).toEqual({ linked: [".config/gh"], skipped: [] });
      expect(await fs.realpath(path.join(targetHome, ".config", "gh"))).toBe(await fs.realpath(operatorGh));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("links selected host CLI credential entries into a managed runtime home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-creds-"));
    const sourceHome = path.join(root, "host-home");
    const targetHome = path.join(root, "agent-home");
    const ghHosts = path.join(sourceHome, ".config", "gh", "hosts.yml");
    const sshKey = path.join(sourceHome, ".ssh", "id_ed25519");
    await fs.mkdir(path.dirname(ghHosts), { recursive: true });
    await fs.mkdir(path.dirname(sshKey), { recursive: true });
    await fs.writeFile(ghHosts, "github.com:\n  oauth_token: redacted\n", "utf8");
    await fs.writeFile(sshKey, "redacted-key\n", "utf8");

    try {
      const result = await syncLocalCliCredentialHomeEntries({
        sourceHome,
        targetHome,
        entries: [".config/gh", ".ssh"],
      });

      expect(result.linked.sort()).toEqual([".config/gh", ".ssh"]);
      const linkedGh = await fs.readlink(path.join(targetHome, ".config", "gh"));
      const linkedSsh = await fs.readlink(path.join(targetHome, ".ssh"));
      expect(path.resolve(path.join(targetHome, ".config"), linkedGh)).toBe(path.join(sourceHome, ".config", "gh"));
      expect(path.resolve(targetHome, linkedSsh)).toBe(path.join(sourceHome, ".ssh"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("repairs empty pre-existing credential directories into host symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-creds-repair-"));
    const sourceHome = path.join(root, "host-home");
    const targetHome = path.join(root, "agent-home");
    const sourceGh = path.join(sourceHome, ".config", "gh");
    const targetGh = path.join(targetHome, ".config", "gh");
    await fs.mkdir(sourceGh, { recursive: true });
    await fs.writeFile(path.join(sourceGh, "hosts.yml"), "github.com:\n  oauth_token: redacted\n", "utf8");
    await fs.mkdir(targetGh, { recursive: true });

    try {
      const result = await syncLocalCliCredentialHomeEntries({
        sourceHome,
        targetHome,
        entries: [".config/gh"],
      });

      expect(result).toEqual({ linked: [".config/gh"], skipped: [] });
      const linkedGh = await fs.readlink(targetGh);
      expect(path.resolve(path.dirname(targetGh), linkedGh)).toBe(sourceGh);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not replace non-empty credential directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-creds-non-empty-"));
    const sourceHome = path.join(root, "host-home");
    const targetHome = path.join(root, "agent-home");
    const sourceGh = path.join(sourceHome, ".config", "gh");
    const targetGh = path.join(targetHome, ".config", "gh");
    await fs.mkdir(sourceGh, { recursive: true });
    await fs.writeFile(path.join(sourceGh, "hosts.yml"), "github.com:\n  oauth_token: redacted\n", "utf8");
    await fs.mkdir(targetGh, { recursive: true });
    await fs.writeFile(path.join(targetGh, "hosts.yml"), "stale-but-user-owned\n", "utf8");

    try {
      const result = await syncLocalCliCredentialHomeEntries({
        sourceHome,
        targetHome,
        entries: [".config/gh"],
      });

      expect(result).toEqual({ linked: [], skipped: [".config/gh"] });
      await expect(fs.readFile(path.join(targetGh, "hosts.yml"), "utf8")).resolves.toBe("stale-but-user-owned\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("ensureLocalCliCredentialShimsInPath", () => {
  it("does not shim default commands when managed HOME credentials work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-shims-managed-"));
    const operatorHome = path.join(root, "operator-home");
    const targetHome = path.join(root, "agent-home");
    const binDir = path.join(root, "bin");
    const fakeVercel = path.join(binDir, "vercel");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.join(operatorHome, ".config", "vercel"), { recursive: true });
    await fs.mkdir(path.join(targetHome, ".config", "vercel"), { recursive: true });
    await fs.writeFile(path.join(targetHome, ".config", "vercel", "auth.json"), "{}\n", "utf8");
    await fs.writeFile(
      fakeVercel,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"whoami\" ] && [ -f \"$HOME/.config/vercel/auth.json\" ]; then exit 0; fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(fakeVercel, 0o755);

    try {
      const env = await ensureLocalCliCredentialShimsInPath({
        operatorHome,
        targetHome,
        env: {
          HOME: targetHome,
          PATH: binDir,
        },
      });

      expect(env.HOME).toBe(targetHome);
      expect(env.PATH?.split(":")[0]).toBe(binDir);
      await expect(fs.lstat(path.join(targetHome, ".rudder", "local-cli-shims", "vercel"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs selected host CLI commands with operator HOME when managed HOME auth fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-shims-"));
    const operatorHome = path.join(root, "operator-home");
    const targetHome = path.join(root, "agent-home");
    const binDir = path.join(root, "bin");
    const capturePath = path.join(root, "capture.json");
    const fakeGh = path.join(binDir, "gh");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(operatorHome, { recursive: true });
    await fs.mkdir(targetHome, { recursive: true });
    await fs.writeFile(
      fakeGh,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
        "  test -f \"$HOME/auth-ok\"",
        "  exit $?",
        "fi",
        `printf '{"home":"%s","userProfile":"%s"}\\n' "$HOME" "$USERPROFILE" > ${JSON.stringify(capturePath)}`,
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(fakeGh, 0o755);
    await fs.writeFile(path.join(operatorHome, "auth-ok"), "yes\n", "utf8");

    try {
      const env = await ensureLocalCliCredentialShimsInPath({
        operatorHome,
        targetHome,
        env: {
          HOME: targetHome,
          PATH: binDir,
        },
        commands: [{ command: "gh", authCheckArgs: ["auth", "status"] }],
      });

      expect(env.HOME).toBe(targetHome);
      expect(env.PATH?.split(path.delimiter)[0]).toBe(path.join(targetHome, ".rudder", "local-cli-shims"));

      await new Promise<void>((resolve, reject) => {
        const child = spawn("gh", [], { env });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`gh shim exited ${code}`));
        });
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        home: string;
        userProfile: string;
      };
      expect(capture.home).toBe(operatorHome);
      expect(capture.userProfile).toBe(operatorHome);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("shims commands when bridged credential files exist but managed HOME auth still fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-local-cli-shims-bridged-auth-fail-"));
    const operatorHome = path.join(root, "operator-home");
    const targetHome = path.join(root, "agent-home");
    const operatorGh = path.join(operatorHome, ".config", "gh");
    const targetGh = path.join(targetHome, ".config", "gh");
    const binDir = path.join(root, "bin");
    const capturePath = path.join(root, "capture.json");
    const fakeGh = path.join(binDir, "gh");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(operatorGh, { recursive: true });
    await fs.mkdir(path.dirname(targetGh), { recursive: true });
    await fs.writeFile(path.join(operatorGh, "hosts.yml"), "github.com:\n  oauth_token: keyring-backed\n", "utf8");
    await fs.symlink(operatorGh, targetGh);
    await fs.writeFile(
      fakeGh,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
        `  test "$HOME" = ${JSON.stringify(operatorHome)}`,
        "  exit $?",
        "fi",
        `printf '{"home":"%s","userProfile":"%s"}\\n' "$HOME" "$USERPROFILE" > ${JSON.stringify(capturePath)}`,
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(fakeGh, 0o755);

    try {
      expect(await fs.realpath(targetGh)).toBe(await fs.realpath(operatorGh));

      const env = await ensureLocalCliCredentialShimsInPath({
        operatorHome,
        targetHome,
        env: {
          HOME: targetHome,
          PATH: binDir,
        },
        commands: [{
          command: "gh",
          authCheckArgs: ["auth", "status"],
          credentialEntries: [".config/gh"],
        }],
      });

      expect(env.HOME).toBe(targetHome);
      expect(env.PATH?.split(path.delimiter)[0]).toBe(path.join(targetHome, ".rudder", "local-cli-shims"));

      await new Promise<void>((resolve, reject) => {
        const child = spawn("gh", [], { env });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`gh shim exited ${code}`));
        });
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        home: string;
        userProfile: string;
      };
      expect(capture.home).toBe(operatorHome);
      expect(capture.userProfile).toBe(operatorHome);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
