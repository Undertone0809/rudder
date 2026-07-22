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

  it("creates a handoff only while main is still on the published stable base", () => {
    expect(decideVersionHandoff("0.5.1", "0.5.1")).toEqual({
      action: "create",
      nextVersion: "0.5.2",
    });
    expect(decideVersionHandoff("0.5.2", "0.5.1")).toEqual({
      action: "skip",
      nextVersion: "0.5.2",
      reason: "main already advanced to 0.5.2",
    });
  });

  it("rejects a main branch behind the version that was published", () => {
    expect(() => decideVersionHandoff("0.5.0", "0.5.1")).toThrow(
      "main version 0.5.0 is behind published stable 0.5.1",
    );
  });

  it("plans the next-base pull request without mutating a real temporary repository", () => {
    const repo = createReleaseRepo();
    const before = exec("git", ["rev-parse", "HEAD"], repo).trim();
    const beforeBranch = exec("git", ["branch", "--show-current"], repo).trim();
    const outputFile = join(repo, "..", "github-output.txt");
    writeFileSync(outputFile, "");

    const result = spawnSync("node", [
      "scripts/prepare-next-release.mjs",
      "--stable-version", "0.5.1",
      "--repo", "example/rudder",
      "--dry-run",
    ], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("bump 0.5.1 -> 0.5.2");
    expect(result.stdout).toContain("automation/release-v0.5.2");
    expect(exec("git", ["rev-parse", "HEAD"], repo).trim()).toBe(before);
    expect(exec("git", ["branch", "--show-current"], repo).trim()).toBe(beforeBranch);
    expect(exec("git", ["status", "--porcelain"], repo)).toBe("");
    expect(readFileSync(outputFile, "utf8")).toContain("action=dry-run");
    expect(readFileSync(outputFile, "utf8")).toContain("branch=automation/release-v0.5.2");
  });

  it("restores the original branch when a dry-run plan fails", () => {
    const repo = createReleaseRepo();
    const before = exec("git", ["rev-parse", "HEAD"], repo).trim();
    const beforeBranch = exec("git", ["branch", "--show-current"], repo).trim();

    const result = spawnSync("node", [
      "scripts/prepare-next-release.mjs",
      "--stable-version", "0.5.2",
      "--repo", "example/rudder",
      "--dry-run",
    ], { cwd: repo, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("main version 0.5.1 is behind published stable 0.5.2");
    expect(exec("git", ["rev-parse", "HEAD"], repo).trim()).toBe(before);
    expect(exec("git", ["branch", "--show-current"], repo).trim()).toBe(beforeBranch);
    expect(exec("git", ["status", "--porcelain"], repo)).toBe("");
  });

  it("reuses only an existing next-version pull request with a valid remote head", () => {
    const repo = createReleaseRepo();
    const branch = "automation/release-v0.5.2";
    exec("git", ["checkout", "-b", branch], repo);
    exec("node", ["scripts/release-package-map.mjs", "set-version", "0.5.2"], repo);
    exec("git", ["add", "-u"], repo);
    exec("git", ["commit", "-m", "next version"], repo);
    exec("git", ["push", "origin", branch], repo);
    const headOid = exec("git", ["rev-parse", "HEAD"], repo).trim();
    exec("git", ["checkout", "main"], repo);

    const mockBin = join(repo, "..", "bin");
    mkdirSync(mockBin, { recursive: true });
    const ghPath = join(mockBin, "gh");
    writeFileSync(ghPath, [
      "#!/usr/bin/env node",
      `console.log(${JSON.stringify(JSON.stringify([{
        baseRefName: "main",
        headRefName: branch,
        headRefOid: headOid,
        url: "https://example.test/pull/1",
      }]))});`,
      "",
    ].join("\n"));
    chmodSync(ghPath, 0o755);
    const outputFile = join(repo, "..", "github-output-existing.txt");
    writeFileSync(outputFile, "");

    const result = spawnSync("node", [
      "scripts/prepare-next-release.mjs",
      "--stable-version", "0.5.1",
      "--repo", "example/rudder",
    ], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        PATH: `${mockBin}:${process.env.PATH}`,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("pull request already exists");
    expect(exec("git", ["branch", "--show-current"], repo).trim()).toBe("main");
    expect(readFileSync(outputFile, "utf8")).toContain("action=existing");
    expect(readFileSync(outputFile, "utf8")).toContain(`head_sha=${headOid}`);
  });
});
