#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    if (currentVersion === nextVersion) {
      return {
        action: "ready",
        nextVersion,
        reason: `main already advanced to ${currentVersion}`,
      };
    }
    return {
      action: "skip",
      nextVersion,
      reason: `main already advanced to ${currentVersion}`,
    };
  }
  return { action: "update", nextVersion };
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
      "--stable-version": "stableVersion",
    }[arg];
    if (!key || !argv[index + 1]) {
      throw new Error(`unexpected or incomplete argument: ${arg}`);
    }
    options[key] = argv[index + 1];
    index += 1;
  }

  parseStableVersion(options.stableVersion);
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

function writeActionOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function fetchBase(options) {
  run("git", [
    "fetch",
    options.remote,
    "--prune",
    `+refs/heads/${options.base}:refs/remotes/${options.remote}/${options.base}`,
  ]);
}

function findPullRequest(options, branch) {
  const prs = JSON.parse(run("gh", [
    "pr", "list", "--state", "open", "--base", options.base,
    "--head", branch, "--json", "url",
  ], { capture: true }));
  if (prs.length > 1) throw new Error(`multiple open handoff pull requests for ${branch}`);
  return prs[0]?.url;
}

function ensurePullRequest(options, branch, version) {
  const existing = findPullRequest(options, branch);
  if (existing) return existing;
  const temp = mkdtempSync(join(tmpdir(), "rudder-release-pr-"));
  try {
    const bodyFile = join(temp, "body.md");
    writeFileSync(bodyFile,
      `Stable v${options.stableVersion} is published. Advance the workspace to v${version} for subsequent releases.\n\n`
      + "Validation: Release explicitly dispatches Test for this commit. Merge through the protected PR workflow after required checks pass; do not push to main.\n");
    try {
      return run("gh", [
        "pr", "create", "--base", options.base, "--head", branch,
        "--title", `chore(release): start v${version} [skip release]`,
        "--body-file", bodyFile,
      ], { capture: true });
    } catch (error) {
      // A timeout or competing run may have created the PR already.
      const recovered = findPullRequest(options, branch);
      if (recovered) return recovered;
      throw error;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function readHandoffBranch(options, branch, expectedPatch) {
  const remoteRef = `refs/remotes/${options.remote}/${branch}`;
  const exists = run("git", ["ls-remote", "--heads", options.remote, `refs/heads/${branch}`], { capture: true });
  if (!exists) return null;
  run("git", ["fetch", options.remote, `refs/heads/${branch}:${remoteRef}`]);
  const actualPatch = run("git", ["diff", "--binary", `${options.remote}/${options.base}...${remoteRef}`], { capture: true });
  if (actualPatch !== expectedPatch) {
    throw new Error(`existing handoff branch ${branch} differs from the expected version-only change; reconcile its PR`);
  }
  return run("git", ["rev-parse", remoteRef], { capture: true });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const status = run("git", ["status", "--porcelain"], { capture: true });
  if (status) throw new Error("working tree must be clean before preparing the next release base");
  const originalBranch = run("git", ["branch", "--show-current"], { capture: true });
  const originalCheckout = originalBranch || run("git", ["rev-parse", "HEAD"], { capture: true });
  const restoreOriginalCheckout = () => run("git", ["checkout", originalCheckout]);

  try {
    if (options.dryRun) {
      fetchBase(options);
      run("git", ["checkout", "--detach", `${options.remote}/${options.base}`]);
      const currentVersion = readWorkspaceVersion();
      const decision = decideVersionHandoff(currentVersion, options.stableVersion);
      if (decision.action !== "update") {
        writeActionOutput("action", decision.action);
        writeActionOutput("version", decision.nextVersion);
        console.log(`Next release base not needed: ${decision.reason}.`);
        return;
      }
      writeActionOutput("action", "dry-run");
      writeActionOutput("version", decision.nextVersion);
      console.log(
        `Would bump ${options.remote}/${options.base} from `
        + `${currentVersion} -> ${decision.nextVersion} on a release-maintenance branch and open a pull request.`,
      );
      return;
    }

    fetchBase(options);
    run("git", ["checkout", "--detach", `${options.remote}/${options.base}`]);

    const currentVersion = readWorkspaceVersion();
    const decision = decideVersionHandoff(currentVersion, options.stableVersion);
    writeActionOutput("version", decision.nextVersion);
    if (decision.action !== "update") {
      writeActionOutput("action", decision.action);
      const headSha = run("git", ["rev-parse", "HEAD"], { capture: true });
      writeActionOutput("head_sha", headSha);
      console.log(`Next release base not needed: ${decision.reason}.`);
      return;
    }

    run("node", ["scripts/release-package-map.mjs", "set-version", decision.nextVersion]);
    run("node", [
      "scripts/update-release-compatibility-matrix.mjs",
      "--candidate-version", decision.nextVersion,
      "--stable-version", options.stableVersion,
    ]);
    run("git", ["add", "-u"]);
    run("git", ["commit", "-m", `chore(release): start v${decision.nextVersion} [skip release]`]);

    const branch = `codex/release-v${decision.nextVersion}`;
    const expectedPatch = run("git", ["diff", "--binary", `${options.remote}/${options.base}`, "HEAD"], { capture: true });
    let headSha = readHandoffBranch(options, branch, expectedPatch);
    if (!headSha) {
      try {
        run("git", ["push", options.remote, `HEAD:refs/heads/${branch}`]);
        headSha = run("git", ["rev-parse", "HEAD"], { capture: true });
      } catch (error) {
        headSha = readHandoffBranch(options, branch, expectedPatch);
        if (!headSha) throw error;
      }
    }
    const prUrl = ensurePullRequest(options, branch, decision.nextVersion);
    writeActionOutput("action", "proposed");
    writeActionOutput("branch", branch);
    writeActionOutput("head_sha", headSha);
    writeActionOutput("pr_url", prUrl);
    console.log(`Next release v${decision.nextVersion} is proposed at ${prUrl}; merge after required checks pass.`);
  } finally {
    restoreOriginalCheckout();
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
