#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

function parseStableVersion(version) {
  const match = String(version ?? "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`expected a stable semver like 0.5.1, found: ${version || "<empty>"}`);
  }
  return match.slice(1).map(Number);
}

export function nextPatchVersion(version) {
  const [major, minor, patch] = parseStableVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

export function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function decideVersionHandoff(currentVersion, stableVersion) {
  const comparison = compareStableVersions(currentVersion, stableVersion);
  const nextVersion = nextPatchVersion(stableVersion);
  if (comparison < 0) {
    throw new Error(
      `main version ${currentVersion} is behind published stable ${stableVersion}; `
      + "merge or reconcile the stable source before preparing another release line",
    );
  }
  if (comparison > 0) {
    return {
      action: "skip",
      nextVersion,
      reason: `main already advanced to ${currentVersion}`,
    };
  }
  return { action: "create", nextVersion };
}

function run(command, args, { capture = false, env = {} } = {}) {
  const output = execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return capture ? output.trim() : "";
}

function parseArgs(argv) {
  const options = {
    base: "main",
    dryRun: false,
    remote: "origin",
    repository: process.env.GITHUB_REPOSITORY ?? "",
    stableVersion: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const key = {
      "--base": "base",
      "--remote": "remote",
      "--repo": "repository",
      "--stable-version": "stableVersion",
    }[arg];
    if (!key || !argv[index + 1]) {
      throw new Error(`unexpected or incomplete argument: ${arg}`);
    }
    options[key] = argv[index + 1];
    index += 1;
  }

  parseStableVersion(options.stableVersion);
  if (!options.repository && !options.dryRun) {
    throw new Error("--repo or GITHUB_REPOSITORY is required when creating the pull request");
  }
  return options;
}

function readWorkspaceVersion() {
  const rows = run("node", ["scripts/release-package-map.mjs", "list"], { capture: true })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  if (rows.length === 0) throw new Error("no public packages found on main");

  const versions = [...new Set(rows.map(([, , version]) => version))];
  if (versions.length !== 1) {
    throw new Error(`public package versions on main do not match: ${versions.join(", ")}`);
  }
  parseStableVersion(versions[0]);
  return versions[0];
}

function findOpenPullRequest(repository, branch) {
  const result = run("gh", [
    "pr", "list",
    "--repo", repository,
    "--head", branch,
    "--state", "open",
    "--json", "url,baseRefName,headRefName,headRefOid",
  ], { capture: true });
  const pullRequests = JSON.parse(result || "[]");
  return pullRequests[0] ?? null;
}

function readWorkspaceVersionAtRevision(revision) {
  const packageDirs = run("node", ["scripts/release-package-map.mjs", "list"], { capture: true })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[0]);
  const versions = [...new Set(packageDirs.map((packageDir) => {
    const manifest = JSON.parse(run("git", ["show", `${revision}:${packageDir}/package.json`], { capture: true }));
    return manifest.version;
  }))];
  if (versions.length !== 1) {
    throw new Error(`existing next-release branch has mismatched public package versions: ${versions.join(", ")}`);
  }
  return versions[0];
}

function validateExistingPullRequest(pullRequest, options, branch, nextVersion) {
  if (pullRequest.baseRefName !== options.base || pullRequest.headRefName !== branch) {
    throw new Error(`existing pull request ${pullRequest.url} does not target ${options.base} from ${branch}`);
  }

  const remoteRef = `refs/remotes/${options.remote}/${branch}`;
  run("git", [
    "fetch",
    options.remote,
    `+refs/heads/${branch}:${remoteRef}`,
  ]);
  const remoteOid = run("git", ["rev-parse", remoteRef], { capture: true });
  if (remoteOid !== pullRequest.headRefOid) {
    throw new Error(`existing pull request ${pullRequest.url} head does not match ${options.remote}/${branch}`);
  }

  const ancestry = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `${options.remote}/${options.base}`, remoteOid],
    { cwd: repoRoot, stdio: "ignore" },
  );
  if (ancestry.status !== 0) {
    throw new Error(`existing pull request ${pullRequest.url} is not based on current ${options.remote}/${options.base}`);
  }

  const branchVersion = readWorkspaceVersionAtRevision(remoteOid);
  if (branchVersion !== nextVersion) {
    throw new Error(
      `existing pull request ${pullRequest.url} has version ${branchVersion}, expected ${nextVersion}`,
    );
  }
}

function writeActionOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const status = run("git", ["status", "--porcelain"], { capture: true });
  if (status) throw new Error("working tree must be clean before preparing the next release base");
  const originalBranch = run("git", ["branch", "--show-current"], { capture: true });
  const originalCheckout = originalBranch || run("git", ["rev-parse", "HEAD"], { capture: true });
  const restoreOriginalCheckout = () => run("git", ["checkout", originalCheckout]);
  let shouldRestoreCheckout = true;

  try {
    run("git", [
      "fetch",
      options.remote,
      "--prune",
      `+refs/heads/${options.base}:refs/remotes/${options.remote}/${options.base}`,
    ]);
    run("git", ["checkout", "--detach", `${options.remote}/${options.base}`]);

    const currentVersion = readWorkspaceVersion();
    const decision = decideVersionHandoff(currentVersion, options.stableVersion);
    if (decision.action === "skip") {
      writeActionOutput("action", "skip");
      console.log(`Next release base not needed: ${decision.reason}.`);
      return;
    }

    const branch = `automation/release-v${decision.nextVersion}`;
    writeActionOutput("branch", branch);
    writeActionOutput("version", decision.nextVersion);
    if (!options.dryRun) {
      const existingPullRequest = findOpenPullRequest(options.repository, branch);
      if (existingPullRequest) {
        validateExistingPullRequest(existingPullRequest, options, branch, decision.nextVersion);
        writeActionOutput("action", "existing");
        writeActionOutput("head_sha", existingPullRequest.headRefOid);
        writeActionOutput("pull_request_url", existingPullRequest.url);
        console.log(`Next release base pull request already exists: ${existingPullRequest.url}`);
        return;
      }
    }

    if (options.dryRun) {
      writeActionOutput("action", "dry-run");
      console.log(
        `Would create ${branch} from ${options.remote}/${options.base}, bump `
        + `${currentVersion} -> ${decision.nextVersion}, and open a pull request.`,
      );
      return;
    }

    run("git", ["checkout", "-B", branch, `${options.remote}/${options.base}`]);
    shouldRestoreCheckout = false;
    run("node", ["scripts/release-package-map.mjs", "set-version", decision.nextVersion]);
    run("git", ["add", "-u"]);
    run("git", ["commit", "-m", `chore(release): start v${decision.nextVersion}`]);

    const remoteBranch = run(
      "git",
      ["ls-remote", "--heads", options.remote, `refs/heads/${branch}`],
      { capture: true },
    );
    const pushArgs = [options.remote, `HEAD:refs/heads/${branch}`];
    if (remoteBranch) {
      const remoteOid = remoteBranch.split(/\s+/)[0];
      pushArgs.unshift(`--force-with-lease=refs/heads/${branch}:${remoteOid}`);
    }
    run("git", ["push", ...pushArgs]);

    const pullRequestUrl = run("gh", [
      "pr", "create",
      "--repo", options.repository,
      "--base", options.base,
      "--head", branch,
      "--title", `chore(release): start v${decision.nextVersion}`,
      "--body",
      [
        `Automated follow-up to stable v${options.stableVersion}.`,
        "",
        `Advances the committed public package base to ${decision.nextVersion} so subsequent main-branch canaries can publish without reusing an already released stable version.`,
        "",
        "This pull request does not publish a release.",
      ].join("\n"),
    ], { capture: true });
    writeActionOutput("action", "created");
    writeActionOutput("head_sha", run("git", ["rev-parse", "HEAD"], { capture: true }));
    writeActionOutput("pull_request_url", pullRequestUrl);
    console.log(`Created next release base pull request: ${pullRequestUrl}`);
  } finally {
    if (shouldRestoreCheckout) restoreOriginalCheckout();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
