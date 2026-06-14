#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_REPO = "Undertone0809/rudder";
const DEFAULT_REMOTE = "origin";
const DEFAULT_LIMIT = 1000;

export function parseStableVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match) {
    throw new Error(`stable version must be X.Y.Z, got: ${version || "<empty>"}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version,
  };
}

export function parseCanaryTag(tag) {
  const match = /^canary\/v(\d+)\.(\d+)\.(\d+)-canary\.(\d+)$/.exec(tag ?? "");
  if (!match) {
    return null;
  }
  return {
    tag,
    version: `${match[1]}.${match[2]}.${match[3]}-canary.${match[4]}`,
    base: {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      version: `${match[1]}.${match[2]}.${match[3]}`,
    },
    canary: Number(match[4]),
  };
}

export function compareStableVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

export function planCanaryCleanup({ stableVersion, releaseTags, remoteTags, preserveCanaryVersion }) {
  const stable = parseStableVersion(stableVersion);
  const releaseTagSet = new Set(releaseTags);
  const allTags = Array.from(new Set([...releaseTags, ...remoteTags])).sort((left, right) => {
    const parsedLeft = parseCanaryTag(left);
    const parsedRight = parseCanaryTag(right);
    if (parsedLeft && parsedRight) {
      const baseCompare = compareStableVersions(parsedLeft.base, parsedRight.base);
      return baseCompare || parsedLeft.canary - parsedRight.canary;
    }
    return left.localeCompare(right);
  });

  const releaseTagsToDelete = [];
  const tagOnlyRefsToDelete = [];
  const skipped = [];

  for (const tag of allTags) {
    const parsed = parseCanaryTag(tag);
    if (!parsed) {
      skipped.push({ tag, reason: "not a Rudder canary tag" });
      continue;
    }

    if (compareStableVersions(parsed.base, stable) > 0) {
      skipped.push({ tag, reason: `base ${parsed.base.version} is newer than stable ${stable.version}` });
      continue;
    }

    if (preserveCanaryVersion && parsed.version === preserveCanaryVersion) {
      skipped.push({ tag, reason: "current npm canary dist-tag" });
      continue;
    }

    if (releaseTagSet.has(tag)) {
      releaseTagsToDelete.push(tag);
    } else {
      tagOnlyRefsToDelete.push(tag);
    }
  }

  return { releaseTagsToDelete, tagOnlyRefsToDelete, skipped };
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    limit: DEFAULT_LIMIT,
    remote: DEFAULT_REMOTE,
    repo: process.env.GITHUB_REPOSITORY || DEFAULT_REPO,
    preserveNpmCanary: true,
    stableVersion: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--delete-current-npm-canary") {
      options.preserveNpmCanary = false;
    } else if (arg === "--stable-version") {
      options.stableVersion = requireValue(argv, ++index, arg);
    } else if (arg === "--repo") {
      options.repo = requireValue(argv, ++index, arg);
    } else if (arg === "--remote") {
      options.remote = requireValue(argv, ++index, arg);
    } else if (arg === "--limit") {
      options.limit = Number(requireValue(argv, ++index, arg));
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error(`--limit must be a positive integer, got: ${options.limit}`);
  }
  if (!options.stableVersion) {
    throw new Error("--stable-version is required");
  }
  parseStableVersion(options.stableVersion);
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printUsage() {
  console.log(`Usage:
  node scripts/cleanup-obsolete-canaries.mjs --stable-version <X.Y.Z> [--repo owner/repo] [--remote origin] [--dry-run]

Deletes canary GitHub Releases and canary/* git tags whose base version is less
than or equal to the stable version. By default it preserves the canary release
currently selected by npm's @rudderhq/cli canary dist-tag so @canary installs do
not lose Desktop assets before the next-base canary exists.

Options:
  --stable-version <X.Y.Z>       Stable version that has just shipped.
  --repo <owner/repo>            GitHub repository. Defaults to GITHUB_REPOSITORY.
  --remote <name>                Git remote used for tag cleanup. Defaults to origin.
  --limit <n>                    Maximum GitHub Releases to inspect. Defaults to 1000.
  --dry-run                      Print deletions without changing GitHub or git.
  --delete-current-npm-canary    Also delete the current npm canary dist-tag release.
`);
}

function execText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function readReleaseTags(repo, limit) {
  const output = execText("gh", [
    "release",
    "list",
    "--repo",
    repo,
    "--limit",
    String(limit),
    "--json",
    "tagName",
  ]);
  return JSON.parse(output)
    .map((release) => release.tagName)
    .filter((tagName) => tagName?.startsWith("canary/v"));
}

function readRemoteCanaryTags(remote) {
  const output = execText("git", ["ls-remote", "--tags", remote, "refs/tags/canary/v*"]);
  if (!output) {
    return [];
  }
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1] ?? "")
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""))
    .filter((tagName) => tagName.startsWith("canary/v"));
}

function readCurrentNpmCanaryVersion() {
  const output = execText("npm", ["view", "@rudderhq/cli", "dist-tags", "--json"]);
  return JSON.parse(output).canary ?? "";
}

function deleteRelease(repo, tag, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] gh release delete ${tag} --repo ${repo} --yes --cleanup-tag`);
    return;
  }
  execFileSync("gh", ["release", "delete", tag, "--repo", repo, "--yes", "--cleanup-tag"], {
    stdio: "inherit",
  });
}

function deleteRemoteTag(remote, tag, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] git push ${remote} :refs/tags/${tag}`);
    return;
  }
  execFileSync("git", ["push", remote, `:refs/tags/${tag}`], {
    stdio: "inherit",
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const preserveCanaryVersion = options.preserveNpmCanary ? readCurrentNpmCanaryVersion() : "";
  const releaseTags = readReleaseTags(options.repo, options.limit);
  const remoteTags = readRemoteCanaryTags(options.remote);
  const plan = planCanaryCleanup({
    stableVersion: options.stableVersion,
    releaseTags,
    remoteTags,
    preserveCanaryVersion,
  });

  console.log(`Obsolete canary cleanup for stable ${options.stableVersion}`);
  if (preserveCanaryVersion) {
    console.log(`Preserving current npm canary: ${preserveCanaryVersion}`);
  }

  for (const tag of plan.releaseTagsToDelete) {
    deleteRelease(options.repo, tag, options.dryRun);
  }
  for (const tag of plan.tagOnlyRefsToDelete) {
    deleteRemoteTag(options.remote, tag, options.dryRun);
  }

  console.log(`Deleted release-backed canaries: ${plan.releaseTagsToDelete.length}`);
  console.log(`Deleted tag-only canaries: ${plan.tagOnlyRefsToDelete.length}`);
  const preserved = plan.skipped.filter((entry) => entry.reason === "current npm canary dist-tag");
  if (preserved.length > 0) {
    console.log(`Preserved current npm canary tags: ${preserved.map((entry) => entry.tag).join(", ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
