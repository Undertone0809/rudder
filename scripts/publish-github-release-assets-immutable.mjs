#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

export async function publishGithubReleaseAssetsImmutable(options) {
  const {
    repo,
    tag,
    assetDir,
    phase,
    githubToken,
    fetchImpl = fetch,
    githubApiBase = "https://api.github.com",
    uploadImpl = uploadWithGh,
    log = console.log,
  } = options;
  validateRepo(repo);
  validateTag(tag);
  if (!assetDir) throw new Error("--asset-dir is required.");
  if (phase !== "binaries" && phase !== "checksum") {
    throw new Error("--phase must be binaries or checksum.");
  }
  if (!githubToken) throw new Error("GH_TOKEN or GITHUB_TOKEN is required.");

  const localAssets = await readLocalAssets(assetDir);
  const release = await readGithubRelease({ fetchImpl, githubApiBase, githubToken, repo, tag });
  const existingByName = new Map(release.assets.map((asset) => [asset.name, asset]));
  const unexpected = release.assets
    .map((asset) => asset.name)
    .filter((name) => isDesktopReleaseAsset(name) && !localAssets.has(name));
  if (unexpected.length > 0) {
    throw new Error(`GitHub Release contains unexpected Desktop assets: ${unexpected.join(", ")}.`);
  }

  const targets = phase === "binaries"
    ? [...localAssets.values()].filter((asset) => asset.name.startsWith("Rudder-"))
    : [localAssets.get("SHASUMS256.txt")];
  if (targets.some((asset) => !asset)) throw new Error(`${assetDir} is missing SHASUMS256.txt.`);

  // A visible checksum marks a completed release. Once it exists, the entire
  // Desktop asset set must already be present and immutable; repair is only
  // allowed before publication of that marker.
  const checksum = localAssets.get("SHASUMS256.txt");
  const existingChecksum = existingByName.get("SHASUMS256.txt");
  if (existingChecksum) {
    await assertExistingAssetMatches({
      asset: existingChecksum,
      fetchImpl,
      githubToken,
      local: checksum,
      repo,
      tag,
    });
    await assertCompleteBinarySet({
      existingByName,
      fetchImpl,
      githubToken,
      localAssets,
      repo,
      tag,
      completionMarkerExists: true,
    });
    return { phase, uploaded: 0, verified: targets.length };
  }

  if (phase === "checksum") {
    await assertCompleteBinarySet({
      existingByName,
      fetchImpl,
      githubToken,
      localAssets,
      repo,
      tag,
      completionMarkerExists: false,
    });
  }

  let uploaded = 0;
  for (const local of targets) {
    const existing = existingByName.get(local.name);
    if (existing) {
      await assertExistingAssetMatches({ asset: existing, fetchImpl, githubToken, local, repo, tag });
      log(`existing\t${local.sha256}\t${local.name}`);
      continue;
    }
    try {
      await uploadImpl({ filePath: local.path, githubToken, repo, tag });
      uploaded += 1;
      log(`uploaded\t${local.sha256}\t${local.name}`);
    } catch (error) {
      const refreshed = await readGithubRelease({ fetchImpl, githubApiBase, githubToken, repo, tag });
      const racedAsset = refreshed.assets.find((asset) => asset.name === local.name);
      if (!racedAsset) throw error;
      await assertExistingAssetMatches({ asset: racedAsset, fetchImpl, githubToken, local, repo, tag });
      log(`existing-after-race\t${local.sha256}\t${local.name}`);
    }
  }
  return { phase, uploaded, verified: targets.length - uploaded };
}

async function assertCompleteBinarySet({
  existingByName,
  fetchImpl,
  githubToken,
  localAssets,
  repo,
  tag,
  completionMarkerExists,
}) {
  const localBinaries = [...localAssets.values()].filter((asset) => asset.name.startsWith("Rudder-"));
  const missing = localBinaries
    .filter((local) => !existingByName.has(local.name))
    .map((local) => local.name);
  if (missing.length > 0) {
    const state = completionMarkerExists ? "completed" : "not ready for its checksum marker";
    throw new Error(
      `GitHub Release ${repo}@${tag} is ${state}; missing Desktop assets: ${missing.join(", ")}.`,
    );
  }
  for (const local of localBinaries) {
    await assertExistingAssetMatches({
      asset: existingByName.get(local.name),
      fetchImpl,
      githubToken,
      local,
      repo,
      tag,
    });
  }
}

async function readGithubRelease({ fetchImpl, githubApiBase, githubToken, repo, tag }) {
  const url = `${githubApiBase.replace(/\/$/, "")}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await fetchImpl(url, { headers: githubHeaders(githubToken, "application/vnd.github+json") });
  if (!response.ok) throw await httpError(`read GitHub Release ${repo}@${tag}`, response);
  const release = await response.json();
  if (release?.draft || !Array.isArray(release?.assets)) {
    throw new Error(`GitHub Release ${repo}@${tag} is missing or still a draft.`);
  }
  for (const asset of release.assets) {
    if (!asset?.name || !asset?.url || !Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error(`GitHub Release ${repo}@${tag} returned invalid asset metadata.`);
    }
  }
  return release;
}

async function readLocalAssets(assetDir) {
  const names = (await readdir(assetDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && isDesktopReleaseAsset(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!names.includes("SHASUMS256.txt")) throw new Error(`${assetDir} is missing SHASUMS256.txt.`);
  if (!names.some((name) => name.startsWith("Rudder-"))) {
    throw new Error(`${assetDir} has no Rudder release binaries.`);
  }
  const assets = await Promise.all(names.map(async (name) => {
    const filePath = path.join(assetDir, name);
    const [size, sha256] = await Promise.all([stat(filePath), hashFile(filePath)]);
    return { name, path: filePath, sha256, size: size.size };
  }));
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  await verifyChecksumManifest(byName);
  return byName;
}

async function verifyChecksumManifest(assets) {
  const checksum = assets.get("SHASUMS256.txt");
  const text = await readFile(checksum.path, "utf8");
  const expected = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match || !match[2].startsWith("Rudder-") || /[\\/?#]/.test(match[2])) {
      throw new Error(`Invalid SHASUMS256.txt line: ${line}`);
    }
    if (expected.has(match[2])) throw new Error(`Duplicate SHASUMS256.txt entry: ${match[2]}.`);
    expected.set(match[2], match[1].toLowerCase());
  }
  const binaries = [...assets.values()].filter((asset) => asset.name.startsWith("Rudder-"));
  const unexpected = [...expected.keys()].filter((name) => !assets.has(name));
  if (unexpected.length > 0) {
    throw new Error(`SHASUMS256.txt contains assets absent from the release directory: ${unexpected.join(", ")}.`);
  }
  for (const binary of binaries) {
    const expectedSha256 = expected.get(binary.name);
    if (!expectedSha256) throw new Error(`SHASUMS256.txt is missing ${binary.name}.`);
    if (expectedSha256 !== binary.sha256) {
      throw new Error(`Local asset ${binary.name} does not match SHASUMS256.txt.`);
    }
  }
}

async function assertExistingAssetMatches({ asset, fetchImpl, githubToken, local, repo, tag }) {
  if (asset.size !== local.size) throw assetConflict(repo, tag, local, `${asset.size} bytes`);
  if (typeof asset.digest === "string" && /^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
    const remoteSha256 = asset.digest.slice("sha256:".length).toLowerCase();
    if (remoteSha256 !== local.sha256) throw assetConflict(repo, tag, local, remoteSha256);
    return;
  }
  const response = await fetchImpl(asset.url, {
    headers: githubHeaders(githubToken, "application/octet-stream"),
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw await httpError(`download GitHub Release asset ${asset.name}`, response);
  }
  const remoteSha256 = await hashResponse(response);
  if (remoteSha256 !== local.sha256) throw assetConflict(repo, tag, local, remoteSha256);
}

function assetConflict(repo, tag, local, received) {
  return new Error(
    `Immutable GitHub Release asset conflict for ${repo}@${tag}/${local.name}: expected ${local.sha256}/${local.size}, received ${received}.`,
  );
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function hashResponse(response) {
  const hash = createHash("sha256");
  for await (const chunk of Readable.fromWeb(response.body)) hash.update(chunk);
  return hash.digest("hex");
}

function uploadWithGh({ filePath, githubToken, repo, tag }) {
  const result = spawnSync("gh", ["release", "upload", tag, filePath, "--repo", repo], {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: githubToken },
  });
  if (result.status !== 0) {
    throw new Error(`Upload GitHub Release asset ${path.basename(filePath)} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

function githubHeaders(token, accept) {
  return {
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": "rudder-release-asset-publisher",
    "x-github-api-version": "2022-11-28",
  };
}

function isDesktopReleaseAsset(name) {
  return name === "SHASUMS256.txt" || (name.startsWith("Rudder-") && !/[\\/?#]/.test(name));
}

function validateRepo(repo) {
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repository: ${repo || "<empty>"}`);
  }
}

function validateTag(tag) {
  if (!tag || tag.startsWith("/") || tag.endsWith("/") || /[\\?#]/.test(tag)) {
    throw new Error(`Invalid release tag: ${tag || "<empty>"}`);
  }
  if (tag.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
}

async function httpError(action, response) {
  let detail = "";
  try {
    detail = (await response.text()).trim().slice(0, 500);
  } catch {
    // The status is sufficient when a response body cannot be read.
  }
  return new Error(`${action} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}

function parseArgs(argv, env) {
  const options = {
    assetDir: "",
    githubToken: env.GH_TOKEN || env.GITHUB_TOKEN,
    phase: "",
    repo: env.GITHUB_REPOSITORY || "Undertone0809/rudder",
    tag: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") options.repo = argv[++index];
    else if (arg === "--tag") options.tag = argv[++index];
    else if (arg === "--asset-dir") options.assetDir = argv[++index];
    else if (arg === "--phase") options.phase = argv[++index];
    else if (arg === "--help" || arg === "-h") return null;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}

function usage() {
  console.error(
    "Usage: node scripts/publish-github-release-assets-immutable.mjs --tag <tag> --asset-dir <dir> --phase binaries|checksum [--repo <owner/repo>]",
  );
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2), process.env);
    if (!options) return usage();
    const result = await publishGithubReleaseAssetsImmutable(options);
    console.log(`ok\t${options.repo}@${options.tag}\tphase=${result.phase}\tuploaded=${result.uploaded}\tverified=${result.verified}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    usage();
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
