import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  compareStableVersions,
  decideVersionHandoff,
  nextPatchVersion,
} from "./prepare-next-release.mjs";
import { buildMigrationManifest } from "./release-compatibility-matrix.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const tempRoots = [];

function mockGitHub(repo, { failAfterCreate = false } = {}) {
  const dir = join(dirname(repo), "bin");
  mkdirSync(dir);
  const state = join(dirname(repo), "pr.json");
  const calls = join(dirname(repo), "gh-calls.jsonl");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] !== "pr") process.exit(2);
if (args[1] === "list") {
  console.log(fs.existsSync(${JSON.stringify(state)}) ? fs.readFileSync(${JSON.stringify(state)}, "utf8") : "[]");
} else if (args[1] === "create") {
  const url = "https://github.com/test/release/pull/1";
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify([{ url }]));
  if (${failAfterCreate}) process.exit(1);
  console.log(url);
} else process.exit(2);
`);
  chmodSync(join(dir, "gh"), 0o755);
  return { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, calls };
}

function exec(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

function compatibilityFingerprint() {
  return buildMigrationManifest({
    label: "test fixture",
    journalRaw: JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [{
        idx: 0,
        version: "7",
        when: 1_700_000_000_000,
        tag: "0000_base",
        breakpoints: true,
      }],
    }),
    listSqlFiles: () => ["0000_base.sql"],
    readSqlFile: () => "SELECT 1;\n",
  }).fingerprint;
}

function writeCompatibilityFixture(repo) {
  const migrations = join(repo, "packages", "db", "src", "migrations");
  mkdirSync(join(migrations, "meta"), { recursive: true });
  const journalRaw = JSON.stringify({
    version: "7",
    dialect: "postgresql",
    entries: [{
      idx: 0,
      version: "7",
      when: 1_700_000_000_000,
      tag: "0000_base",
      breakpoints: true,
    }],
  });
  const sql = "SELECT 1;\n";
  const fingerprint = compatibilityFingerprint();

  writeFileSync(join(migrations, "meta", "_journal.json"), `${journalRaw}\n`);
  writeFileSync(join(migrations, "0000_base.sql"), sql);

  const matrixPath = join(repo, "scripts", "release-compatibility-matrix.mjs");
  const source = readFileSync(matrixPath, "utf8");
  const declaration = [
    '  "0.5.1": {',
    `    candidateFingerprint: "${fingerprint}",`,
    "    fixtures: [",
    "      {",
    '        version: "0.5.0",',
    '        ref: "v0.5.0",',
    `        fingerprint: "${fingerprint}",`,
    "      },",
    "    ],",
    "  },",
    "",
  ].join("\n");
  writeFileSync(
    matrixPath,
    source.replace(
      "export const migrationCompatibilityMatrix = {\n",
      `export const migrationCompatibilityMatrix = {\n${declaration}`,
    ),
  );
}

function createReleaseRepo() {
  const root = mkdtempSync(join(tmpdir(), "rudder-next-release-test-"));
  tempRoots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "cli"), { recursive: true });
  cpSync(join(scriptsDir, "prepare-next-release.mjs"), join(repo, "scripts", "prepare-next-release.mjs"));
  cpSync(join(scriptsDir, "release-package-map.mjs"), join(repo, "scripts", "release-package-map.mjs"));
  cpSync(
    join(scriptsDir, "release-compatibility-matrix.mjs"),
    join(repo, "scripts", "release-compatibility-matrix.mjs"),
  );
  cpSync(
    join(scriptsDir, "update-release-compatibility-matrix.mjs"),
    join(repo, "scripts", "update-release-compatibility-matrix.mjs"),
  );
  writeCompatibilityFixture(repo);
  writeFileSync(join(repo, "cli", "package.json"), `${JSON.stringify({
    name: "@rudderhq/cli",
    version: "0.5.1",
  }, null, 2)}\n`);

  exec("git", ["init", "--bare", remote], root);
  exec("git", ["init"], repo);
  exec("git", ["checkout", "-b", "main"], repo);
  exec("git", ["config", "user.name", "Release Test"], repo);
  exec("git", ["config", "user.email", "release-test@example.com"], repo);
  exec("git", ["add", "."], repo);
  exec("git", ["commit", "-m", "fixture"], repo);
  exec("git", ["tag", "v0.5.0"], repo);
  exec("git", ["tag", "v0.5.1"], repo);
  exec("git", ["remote", "add", "origin", remote], repo);
  exec("git", ["push", "-u", "origin", "main"], repo);
  return repo;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("next release version handoff", () => {
  it("increments only the patch component", () => {
    expect(nextPatchVersion("0.5.1")).toBe("0.5.2");
    expect(nextPatchVersion("12.34.99")).toBe("12.34.100");
    expect(() => nextPatchVersion("0.5.1-canary.0")).toThrow("stable semver");
  });

  it("compares stable semvers numerically", () => {
    expect(compareStableVersions("0.10.0", "0.9.99")).toBe(1);
    expect(compareStableVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareStableVersions("1.0.9", "1.1.0")).toBe(-1);
  });

  it("updates main only while it is still on the published stable base", () => {
    expect(decideVersionHandoff("0.5.1", "0.5.1")).toEqual({
      action: "update",
      nextVersion: "0.5.2",
    });
    expect(decideVersionHandoff("0.5.2", "0.5.1")).toEqual({
      action: "ready",
      nextVersion: "0.5.2",
      reason: "main already advanced to 0.5.2",
    });
  });

  it("rejects a main branch behind the version that was published", () => {
    expect(() => decideVersionHandoff("0.5.0", "0.5.1")).toThrow(
      "main version 0.5.0 is behind published stable 0.5.1",
    );
  });

  it("plans a PR handoff without mutating a real temporary repository", () => {
    const repo = createReleaseRepo();
    const before = exec("git", ["rev-parse", "HEAD"], repo).trim();
    const beforeBranch = exec("git", ["branch", "--show-current"], repo).trim();
    const outputFile = join(repo, "..", "github-output.txt");
    writeFileSync(outputFile, "");

    const result = spawnSync("node", [
      "scripts/prepare-next-release.mjs",
      "--stable-version", "0.5.1",
      "--dry-run",
    ], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("from 0.5.1 -> 0.5.2");
    expect(result.stdout).toContain("open a pull request");
    expect(exec("git", ["rev-parse", "HEAD"], repo).trim()).toBe(before);
    expect(exec("git", ["branch", "--show-current"], repo).trim()).toBe(beforeBranch);
    expect(exec("git", ["status", "--porcelain"], repo)).toBe("");
    expect(readFileSync(outputFile, "utf8")).toContain("action=dry-run");
    expect(readFileSync(outputFile, "utf8")).toContain("version=0.5.2");
  }, 15_000);

  it("restores the original branch when a dry-run plan fails", () => {
    const repo = createReleaseRepo();
    const before = exec("git", ["rev-parse", "HEAD"], repo).trim();
    const beforeBranch = exec("git", ["branch", "--show-current"], repo).trim();

    const result = spawnSync("node", [
      "scripts/prepare-next-release.mjs",
      "--stable-version", "0.5.2",
      "--dry-run",
    ], { cwd: repo, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("main version 0.5.1 is behind published stable 0.5.2");
    expect(exec("git", ["rev-parse", "HEAD"], repo).trim()).toBe(before);
    expect(exec("git", ["branch", "--show-current"], repo).trim()).toBe(beforeBranch);
    expect(exec("git", ["status", "--porcelain"], repo)).toBe("");
  });

  it("recognizes when main already has the next release base", () => {
    const repo = createReleaseRepo();
    const outputFile = join(repo, "..", "github-output-skip.txt");
    const packageJson = JSON.parse(readFileSync(join(repo, "cli", "package.json"), "utf8"));
    packageJson.version = "0.5.2";
    writeFileSync(join(repo, "cli", "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    exec("git", ["add", "cli/package.json"], repo);
    exec("git", ["commit", "-m", "chore: advance release base"], repo);
    exec("git", ["push", "origin", "main"], repo);
    writeFileSync(outputFile, "");

    const result = spawnSync("node", [
      "scripts/prepare-next-release.mjs",
      "--stable-version", "0.5.1",
    ], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("main already advanced to 0.5.2");
    expect(readFileSync(outputFile, "utf8")).toContain("action=ready");
    expect(readFileSync(outputFile, "utf8")).not.toContain("branch=");
    expect(exec("git", ["ls-remote", "--heads", "origin"], repo)).not.toContain(
      "automation/release-",
    );
  }, 15_000);

  it("opens one idempotent PR while a protected remote rejects all main pushes", () => {
    const repo = createReleaseRepo();
    const { env, calls } = mockGitHub(repo);
    const originalHead = exec("git", ["rev-parse", "HEAD"], repo).trim();
    const hook = join(dirname(repo), "remote.git", "hooks", "update");
    writeFileSync(hook, '#!/bin/sh\n[ "$1" != "refs/heads/main" ]\n');
    chmodSync(hook, 0o755);
    const outputFile = join(repo, "..", "github-output-update.txt");
    writeFileSync(outputFile, "");

    const result = spawnSync("node", [
      "scripts/prepare-next-release.mjs",
      "--stable-version", "0.5.1",
    ], {
      cwd: repo,
      encoding: "utf8",
      env: { ...env, GITHUB_OUTPUT: outputFile },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("proposed at https://github.com/test/release/pull/1");
    expect(exec("git", ["branch", "--show-current"], repo).trim()).toBe("main");
    exec("git", ["fetch", "origin"], repo);
    const remoteHead = exec("git", ["rev-parse", "origin/codex/release-v0.5.2"], repo).trim();
    expect(exec("git", ["rev-parse", "origin/main"], repo).trim()).toBe(originalHead);
    expect(exec("git", ["rev-parse", "HEAD"], repo).trim()).toBe(originalHead);
    expect(
      JSON.parse(exec("git", ["show", "origin/codex/release-v0.5.2:cli/package.json"], repo))
        .version,
    ).toBe("0.5.2");
    const handoffMatrix = exec(
      "git",
      ["show", "origin/codex/release-v0.5.2:scripts/release-compatibility-matrix.mjs"],
      repo,
    );
    expect(handoffMatrix).toContain('"0.5.2"');
    expect(handoffMatrix).toContain('version: "0.5.1"');
    expect(handoffMatrix).toContain(`candidateFingerprint: "${compatibilityFingerprint()}"`);
    expect(handoffMatrix).toContain(`fingerprint: "${compatibilityFingerprint()}"`);
    expect(exec("git", ["show", "-s", "--format=%s", remoteHead], repo).trim()).toBe(
      "chore(release): start v0.5.2 [skip release]",
    );
    expect(readFileSync(outputFile, "utf8")).toContain("action=proposed");
    expect(readFileSync(outputFile, "utf8")).toContain("branch=codex/release-v0.5.2");
    expect(readFileSync(outputFile, "utf8")).toContain(`head_sha=${remoteHead}`);

    writeFileSync(outputFile, "");
    const retry = spawnSync("node", [
      "scripts/prepare-next-release.mjs",
      "--stable-version", "0.5.1",
    ], {
      cwd: repo,
      encoding: "utf8",
      env: { ...env, GITHUB_OUTPUT: outputFile },
    });

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toContain("proposed at https://github.com/test/release/pull/1");
    expect(exec("git", ["rev-parse", "origin/main"], repo).trim()).toBe(originalHead);
    expect(exec("git", ["rev-parse", "origin/codex/release-v0.5.2"], repo).trim()).toBe(remoteHead);
    expect(readFileSync(outputFile, "utf8")).toContain("action=proposed");
    expect(readFileSync(outputFile, "utf8")).toContain(`head_sha=${remoteHead}`);
    expect(readFileSync(calls, "utf8").split("\n").filter((line) => line.includes('"create"'))).toHaveLength(1);
  }, 15_000);

  it("recovers an unknown PR-create outcome without creating a duplicate", () => {
    const repo = createReleaseRepo();
    const { env, calls } = mockGitHub(repo, { failAfterCreate: true });
    const result = spawnSync("node", [
      "scripts/prepare-next-release.mjs",
      "--stable-version", "0.5.1",
    ], {
      cwd: repo,
      encoding: "utf8",
      env,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("proposed at https://github.com/test/release/pull/1");
    expect(readFileSync(calls, "utf8").split("\n").filter((line) => line.includes('"create"'))).toHaveLength(1);
    expect(JSON.parse(
      exec("git", ["show", "origin/main:cli/package.json"], repo),
    ).version).toBe("0.5.1");
  }, 15_000);

  it("rejects a conflicting existing handoff branch without overwriting it", () => {
    const repo = createReleaseRepo();
    const { env } = mockGitHub(repo);
    exec("git", ["checkout", "-b", "codex/release-v0.5.2"], repo);
    writeFileSync(join(repo, "unexpected.txt"), "unrelated work\n");
    exec("git", ["add", "unexpected.txt"], repo);
    exec("git", ["commit", "-m", "other work"], repo);
    exec("git", ["push", "origin", "HEAD"], repo);
    const before = exec("git", ["rev-parse", "HEAD"], repo).trim();
    exec("git", ["checkout", "main"], repo);
    const result = spawnSync("node", ["scripts/prepare-next-release.mjs", "--stable-version", "0.5.1"], {
      cwd: repo, encoding: "utf8", env,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("differs from the expected version-only change");
    expect(exec("git", ["rev-parse", "origin/codex/release-v0.5.2"], repo).trim()).toBe(before);
    expect(exec("git", ["branch", "--show-current"], repo).trim()).toBe("main");
    expect(exec("git", ["status", "--porcelain"], repo)).toBe("");
  }, 15_000);

});
