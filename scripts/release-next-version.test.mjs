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

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const tempRoots = [];

function exec(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
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

  it("plans a direct next-base update without mutating a real temporary repository", () => {
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
    expect(result.stdout).toContain("push the release-maintenance commit directly");
    expect(exec("git", ["rev-parse", "HEAD"], repo).trim()).toBe(before);
    expect(exec("git", ["branch", "--show-current"], repo).trim()).toBe(beforeBranch);
    expect(exec("git", ["status", "--porcelain"], repo)).toBe("");
    expect(readFileSync(outputFile, "utf8")).toContain("action=dry-run");
    expect(readFileSync(outputFile, "utf8")).toContain("version=0.5.2");
  });

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

  it("pushes one idempotent release-maintenance commit directly to main", () => {
    const repo = createReleaseRepo();
    const outputFile = join(repo, "..", "github-output-update.txt");
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
    expect(result.stdout).toContain("Advanced origin/main to 0.5.2");
    expect(exec("git", ["branch", "--show-current"], repo).trim()).toBe("main");
    const remoteHead = exec("git", ["rev-parse", "origin/main"], repo).trim();
    expect(JSON.parse(exec("git", ["show", "origin/main:cli/package.json"], repo)).version).toBe("0.5.2");
    expect(exec("git", ["show", "-s", "--format=%s", remoteHead], repo).trim()).toBe(
      "chore(release): start v0.5.2 [skip release]",
    );
    expect(exec("git", ["ls-remote", "--heads", "origin"], repo)).not.toContain("automation/release-");
    expect(readFileSync(outputFile, "utf8")).toContain("action=updated");
    expect(readFileSync(outputFile, "utf8")).toContain(`head_sha=${remoteHead}`);

    writeFileSync(outputFile, "");
    const retry = spawnSync("node", [
      "scripts/prepare-next-release.mjs",
      "--stable-version", "0.5.1",
    ], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
    });

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toContain("main already advanced to 0.5.2");
    expect(exec("git", ["rev-parse", "origin/main"], repo).trim()).toBe(remoteHead);
    expect(readFileSync(outputFile, "utf8")).toContain("action=ready");
    expect(readFileSync(outputFile, "utf8")).toContain(`head_sha=${remoteHead}`);
  }, 15_000);

  it("rebases the version commit after a concurrent main update rejects the first push", () => {
    const repo = createReleaseRepo();
    const root = dirname(repo);
    const contender = join(root, "contender");
    exec("git", ["clone", join(root, "remote.git"), contender], root);
    exec("git", ["checkout", "main"], contender);
    exec("git", ["config", "user.name", "Concurrent Test"], contender);
    exec("git", ["config", "user.email", "concurrent-test@example.com"], contender);
    writeFileSync(join(contender, "concurrent.txt"), "landed during release handoff\n");
    exec("git", ["add", "concurrent.txt"], contender);
    exec("git", ["commit", "-m", "fix: concurrent main update"], contender);

    const hook = join(repo, ".git", "hooks", "pre-push");
    const marker = join(root, "concurrent-push-complete");
    writeFileSync(hook, [
      "#!/bin/sh",
      `if [ ! -f '${marker}' ]; then`,
      `  touch '${marker}'`,
      `  git -C '${contender}' push origin main`,
      "fi",
      "",
    ].join("\n"));
    chmodSync(hook, 0o755);

    const result = spawnSync("node", [
      "scripts/prepare-next-release.mjs",
      "--stable-version", "0.5.1",
    ], { cwd: repo, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("refetching before retry");
    expect(JSON.parse(exec("git", ["show", "origin/main:cli/package.json"], repo)).version).toBe("0.5.2");
    expect(exec("git", ["show", "origin/main:concurrent.txt"], repo)).toBe("landed during release handoff\n");
    expect(exec("git", ["log", "-2", "--format=%s", "origin/main"], repo).trim().split("\n")).toEqual([
      "chore(release): start v0.5.2 [skip release]",
      "fix: concurrent main update",
    ]);
  }, 15_000);
});
