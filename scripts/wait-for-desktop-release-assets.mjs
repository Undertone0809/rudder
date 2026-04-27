#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
let repo = process.env.GITHUB_REPOSITORY || "Undertone0809/rudder";
let tag = "";
let version = "";
let attempts = Number.parseInt(process.env.DESKTOP_RELEASE_VERIFY_ATTEMPTS ?? "180", 10);
let delaySeconds = Number.parseInt(process.env.DESKTOP_RELEASE_VERIFY_DELAY_SECONDS ?? "10", 10);

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--repo") {
    repo = args[++index] ?? "";
  } else if (arg === "--tag") {
    tag = args[++index] ?? "";
  } else if (arg === "--version") {
    version = args[++index] ?? "";
  } else if (arg === "--attempts") {
    attempts = Number.parseInt(args[++index] ?? "", 10);
  } else if (arg === "--delay-seconds") {
    delaySeconds = Number.parseInt(args[++index] ?? "", 10);
  } else if (arg === "--help" || arg === "-h") {
    usage(0);
  } else {
    console.error(`Unexpected argument: ${arg}`);
    usage(1);
  }
}

if (!repo || !tag) usage(1);
version ||= versionFromTag(tag);
if (!version) {
  console.error(`Could not derive desktop version from tag: ${tag}`);
  process.exit(1);
}

if (!Number.isFinite(attempts) || attempts <= 0) attempts = 180;
if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) delaySeconds = 10;

const expectedAssets = [
  `Rudder-${version}-linux-x64.AppImage`,
  `Rudder-${version}-macos-arm64-portable.zip`,
  `Rudder-${version}-macos-x64-portable.zip`,
  `Rudder-${version}-windows-x64-portable.zip`,
  "SHASUMS256.txt",
];

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const release = readRelease(repo, tag);
  if (release) {
    const assetNames = new Set((release.assets ?? []).map((asset) => asset.name));
    const missing = expectedAssets.filter((assetName) => !assetNames.has(assetName));
    if (missing.length === 0 && release.isDraft === false) {
      console.log(`ok\t${repo}@${tag}\tassets=${expectedAssets.length}`);
      process.exit(0);
    }

    console.log(
      `[${attempt}/${attempts}] waiting for ${repo}@${tag}: missing ${missing.join(", ") || "<none>"}`,
    );
  } else {
    console.log(`[${attempt}/${attempts}] waiting for ${repo}@${tag}: release not visible yet`);
  }

  if (attempt < attempts) await sleep(delaySeconds * 1000);
}

console.error(`Timed out waiting for desktop release assets for ${repo}@${tag}.`);
console.error(`Expected: ${expectedAssets.join(", ")}`);
process.exit(1);

function readRelease(repoName, releaseTag) {
  try {
    return JSON.parse(
      execFileSync(
        "gh",
        ["release", "view", releaseTag, "--repo", repoName, "--json", "assets,isDraft,tagName"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  } catch {
    return null;
  }
}

function versionFromTag(releaseTag) {
  const name = releaseTag.split("/").pop() ?? "";
  return name.startsWith("v") ? name.slice(1) : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage(code) {
  console.error(
    "Usage: node scripts/wait-for-desktop-release-assets.mjs --repo <owner/repo> --tag <tag> [--version <version>]",
  );
  process.exit(code);
}
