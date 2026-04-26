#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
let version = "";
let distTag = "latest";
let dryRun = false;
let onlyIfNoStable = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--version") {
    version = args[++index] ?? "";
  } else if (arg === "--tag") {
    distTag = args[++index] ?? "";
  } else if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg === "--only-if-no-stable") {
    onlyIfNoStable = true;
  } else if (arg === "--help" || arg === "-h") {
    usage(0);
  } else {
    console.error(`Unexpected argument: ${arg}`);
    usage(1);
  }
}

if (!version || !distTag) {
  usage(1);
}

if (!/^[a-z][a-z0-9._-]*$/i.test(distTag)) {
  console.error(`Invalid npm dist-tag: ${distTag}`);
  process.exit(1);
}

const packageRows = execFileSync("node", ["scripts/release-package-map.mjs", "list"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

const packages = packageRows.map((row) => row.split(/\s+/)[1]).filter(Boolean);

if (packages.length === 0) {
  console.error("No public packages found.");
  process.exit(1);
}

if (onlyIfNoStable && hasPublishedStableVersion("@rudderhq/cli")) {
  console.log("A stable @rudderhq/cli version already exists; leaving npm latest unchanged.");
  process.exit(0);
}

let failed = false;

for (const packageName of packages) {
  const publishedVersion = execFileSync(
    "npm",
    ["--prefer-online", "view", `${packageName}@${version}`, "version"],
    { encoding: "utf8" },
  ).trim();

  if (publishedVersion !== version) {
    console.error(`Version mismatch for ${packageName}: expected ${version}, got ${publishedVersion}`);
    failed = true;
    continue;
  }

  const beforeTags = npmDistTags(packageName);
  if (beforeTags[distTag] === version) {
    console.log(`ok\t${packageName}\t${distTag}=${version}`);
    continue;
  }

  if (dryRun) {
    console.log(`[dry-run]\tnpm dist-tag add ${packageName}@${version} ${distTag}`);
    continue;
  } else {
    execFileSync("npm", ["dist-tag", "add", `${packageName}@${version}`, distTag], {
      stdio: "inherit",
    });
  }

  const afterTags = npmDistTags(packageName);
  const ok = dryRun || afterTags[distTag] === version;
  console.log(`${ok ? "ok" : "bad"}\t${packageName}\t${distTag}=${afterTags[distTag] ?? "<missing>"}`);
  if (!ok) {
    failed = true;
  }
}

process.exit(failed ? 1 : 0);

function usage(code) {
  console.error(`Usage: node scripts/promote-npm-dist-tag.mjs --version <version> [--tag latest] [--dry-run] [--only-if-no-stable]`);
  process.exit(code);
}

function npmDistTags(packageName) {
  return JSON.parse(
    execFileSync("npm", ["--prefer-online", "view", packageName, "dist-tags", "--json"], {
      encoding: "utf8",
    }),
  );
}

function hasPublishedStableVersion(packageName) {
  const versions = JSON.parse(
    execFileSync("npm", ["--prefer-online", "view", packageName, "versions", "--json"], {
      encoding: "utf8",
    }),
  );
  return versions.some((candidate) => /^\d+\.\d+\.\d+$/.test(candidate));
}
