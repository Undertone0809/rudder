import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  CLI_NPM_PACKAGE_NAME,
  installPersistentCli,
  resolvePersistentCliInstallSpec,
} from "../install.js";

export const DEFAULT_DESKTOP_RELEASE_REPO = "Undertone0809/rudder";

type SupportedPlatform = "macos" | "windows" | "linux";

export interface DesktopAssetTarget {
  platform: SupportedPlatform;
  arch: "x64" | "arm64";
  extension: ".dmg" | ".exe" | ".AppImage";
}

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  assets: GithubReleaseAsset[];
}

interface StartCommandOptions {
  cli?: boolean;
  desktop?: boolean;
  version?: string;
  repo?: string;
  outputDir?: string;
  open?: boolean;
  dryRun?: boolean;
  versionCheck?: boolean;
}

const STABLE_SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const CANARY_SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+-canary\.[0-9]+$/;
const CLI_REGISTRY_LATEST_URL = "https://registry.npmjs.org/@rudderhq%2fcli/latest";

export function resolveCurrentCliVersion(env: NodeJS.ProcessEnv = process.env): string {
  const envPackageName = env.npm_package_name?.trim();
  const envPackageVersion = env.npm_package_version?.trim();
  if (envPackageName === CLI_NPM_PACKAGE_NAME && envPackageVersion) return envPackageVersion;

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../package.json"),
    path.resolve(moduleDir, "../../package.json"),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === CLI_NPM_PACKAGE_NAME && parsed.version) return parsed.version;
    } catch {
      // Continue to the next candidate.
    }
  }

  return "latest";
}

export function resolveCliInstallSpec(version: string, env: NodeJS.ProcessEnv = process.env): string {
  if (version && version !== "latest") return `${CLI_NPM_PACKAGE_NAME}@${version}`;
  return resolvePersistentCliInstallSpec(env);
}

export function compareStableSemver(a: string, b: string): number {
  const aMatch = a.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)$/);
  const bMatch = b.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)$/);
  if (!aMatch || !bMatch) return 0;

  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(aMatch[index]) - Number(bMatch[index]);
    if (diff !== 0) return diff;
  }

  return 0;
}

async function fetchLatestCliVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);

  try {
    const response = await fetch(CLI_REGISTRY_LATEST_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "rudder-cli-version-check" },
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as { version?: string };
    return parsed.version?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCliUpdateNotice(currentVersion: string): Promise<string | null> {
  if (!STABLE_SEMVER_RE.test(currentVersion)) return null;
  const latestVersion = await fetchLatestCliVersion();
  if (!latestVersion || !STABLE_SEMVER_RE.test(latestVersion)) return null;
  if (compareStableSemver(latestVersion, currentVersion) <= 0) return null;

  return `Rudder ${latestVersion} is available. Update with ${pc.cyan(`npx ${CLI_NPM_PACKAGE_NAME}@latest start`)}.`;
}

export function resolveDesktopReleaseTag(version: string): string {
  if (!version || version === "latest") return "latest";
  if (STABLE_SEMVER_RE.test(version)) return `v${version}`;
  if (CANARY_SEMVER_RE.test(version)) return `canary/v${version}`;

  throw new Error(
    `Desktop installer lookup requires a release version like 0.1.0 or 0.1.0-canary.0. Received ${version}.`,
  );
}

export function resolveDesktopAssetTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): DesktopAssetTarget {
  const normalizedArch = arch === "x64" || arch === "arm64" ? arch : null;
  if (!normalizedArch) {
    throw new Error(`Rudder Desktop does not publish installers for ${platform}/${arch}.`);
  }

  if (platform === "darwin") return { platform: "macos", arch: normalizedArch, extension: ".dmg" };
  if (platform === "win32") return { platform: "windows", arch: normalizedArch, extension: ".exe" };
  if (platform === "linux") return { platform: "linux", arch: normalizedArch, extension: ".AppImage" };

  throw new Error(`Rudder Desktop does not publish installers for ${platform}.`);
}

function normalizeAssetName(name: string): string {
  return name.toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
}

function scoreDesktopAsset(asset: GithubReleaseAsset, target: DesktopAssetTarget): number {
  const normalized = normalizeAssetName(asset.name);
  const expectedExtension = target.extension.toLowerCase();
  if (!normalized.endsWith(expectedExtension.toLowerCase())) return -1;
  if (normalized.includes("blockmap") || normalized.includes("shasum")) return -1;

  let score = 1;
  if (normalized.includes("rudder")) score += 2;
  if (normalized.includes(target.platform)) score += 4;
  if (target.platform === "macos" && (normalized.includes("macos") || normalized.includes("darwin") || normalized.includes("mac-"))) {
    score += 4;
  }
  if (target.platform === "windows" && (normalized.includes("windows") || normalized.includes("win"))) {
    score += 4;
  }
  if (target.arch === "arm64" && normalized.includes("arm64")) score += 4;
  if (target.arch === "x64" && (normalized.includes("x64") || normalized.includes("amd64"))) score += 4;

  if (target.platform === "macos" && target.arch === "x64" && normalized.includes("arm64")) score -= 10;
  if (target.arch === "arm64" && normalized.includes("x64")) score -= 10;

  return score;
}

export function selectDesktopAsset(
  assets: GithubReleaseAsset[],
  target: DesktopAssetTarget,
): GithubReleaseAsset | null {
  const scored = assets
    .map((asset) => ({ asset, score: scoreDesktopAsset(asset, target) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name));

  if (scored.length === 0) return null;

  const best = scored[0];
  if (!best) return null;

  const equallyGood = scored.filter((item) => item.score === best.score);
  if (equallyGood.length === 1) return best.asset;

  const exactArch = equallyGood.find((item) => normalizeAssetName(item.asset.name).includes(target.arch));
  return exactArch?.asset ?? best.asset;
}

export function selectChecksumAsset(assets: GithubReleaseAsset[]): GithubReleaseAsset | null {
  return assets.find((asset) => /^SHASUMS256\.txt$/i.test(asset.name)) ?? null;
}

function githubApiHeaders(): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "rudder-cli-installer",
  };
}

async function fetchGithubRelease(repo: string, tag: string): Promise<GithubRelease> {
  const endpoint =
    tag === "latest"
      ? `https://api.github.com/repos/${repo}/releases/latest`
      : `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await fetch(endpoint, { headers: githubApiHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub Release ${tag} was not found in ${repo} (${response.status}).`);
  }
  return (await response.json()) as GithubRelease;
}

async function downloadAsset(asset: GithubReleaseAsset, outputDir: string): Promise<string> {
  mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, path.basename(asset.name));
  const response = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "rudder-cli-installer" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${asset.name} (${response.status}).`);
  }

  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(outputPath));
  return outputPath;
}

function checksumForFile(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

export function parseChecksumFile(contents: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!match) continue;
    checksums.set(match[2].trim(), match[1].toLowerCase());
  }
  return checksums;
}

async function verifyChecksum(installerPath: string, checksumAsset: GithubReleaseAsset | null, outputDir: string): Promise<boolean> {
  if (!checksumAsset) return false;
  const checksumPath = await downloadAsset(checksumAsset, outputDir);
  const checksums = parseChecksumFile(readFileSync(checksumPath, "utf8"));
  const expected = checksums.get(path.basename(installerPath));
  if (!expected) return false;

  const actual = checksumForFile(installerPath);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${path.basename(installerPath)}.`);
  }
  return true;
}

function openInstaller(installerPath: string, target: DesktopAssetTarget): void {
  if (target.platform === "macos") {
    spawnSync("open", [installerPath], { stdio: "inherit" });
    return;
  }

  if (target.platform === "windows") {
    spawnSync("cmd.exe", ["/c", "start", "", installerPath], { stdio: "inherit" });
    return;
  }

  spawnSync("xdg-open", [installerPath], { stdio: "inherit" });
}

export async function startCommand(opts: StartCommandOptions): Promise<void> {
  const installCli = opts.cli !== false;
  const installDesktop = opts.desktop !== false;
  const repo = opts.repo?.trim() || DEFAULT_DESKTOP_RELEASE_REPO;
  const version = opts.version?.trim() || resolveCurrentCliVersion();
  const dryRun = opts.dryRun === true;

  if (!installCli && !installDesktop) {
    throw new Error("Nothing to start. Remove --no-cli or --no-desktop.");
  }

  p.intro(pc.bgCyan(pc.black(" rudder start ")));

  if (opts.versionCheck !== false) {
    const updateNotice = await getCliUpdateNotice(version);
    if (updateNotice) p.log.warn(updateNotice);
  }

  if (installCli) {
    const installSpec = resolveCliInstallSpec(version);
    const command = `npm install --global ${installSpec}`;
    p.log.step("Preparing persistent CLI");
    if (dryRun) {
      p.log.message(`[dry-run] ${command}`);
    } else {
      p.log.message(pc.dim(`Running: ${command}`));
      const result = installPersistentCli({ installSpec });
      if (!result.ok) {
        if (result.output) p.log.message(pc.dim(result.output));
        throw new Error(`Persistent CLI installation failed. Re-run manually: ${result.command}`);
      }
      p.log.success(`${pc.cyan("rudder")} CLI installed.`);
    }
  }

  if (installDesktop) {
    const target = resolveDesktopAssetTarget();
    const tag = resolveDesktopReleaseTag(version);
    const outputDir = opts.outputDir
      ? path.resolve(opts.outputDir)
      : await mkdtemp(path.join(tmpdir(), "rudder-desktop-installer."));

    p.log.step("Starting desktop app");
    p.log.message(`Release: ${pc.cyan(`${repo}@${tag}`)}`);
    p.log.message(`Target: ${pc.cyan(`${target.platform}/${target.arch}`)}`);

    if (dryRun) {
      p.log.message(`[dry-run] Would resolve and download/open the matching desktop installer to ${outputDir}`);
      p.outro(pc.green("Dry run complete."));
      return;
    }

    const release = await fetchGithubRelease(repo, tag);
    const asset = selectDesktopAsset(release.assets ?? [], target);
    if (!asset) {
      throw new Error(`No Rudder Desktop installer found for ${target.platform}/${target.arch} in ${repo}@${release.tag_name}.`);
    }

    const installerPath = await downloadAsset(asset, outputDir);
    const checksumVerified = await verifyChecksum(installerPath, selectChecksumAsset(release.assets ?? []), outputDir);

    if (target.platform === "linux") {
      await chmod(installerPath, 0o755);
    }

    p.log.success(`Downloaded ${pc.cyan(path.basename(installerPath))}`);
    if (checksumVerified) p.log.success("Verified SHA-256 checksum.");

    if (opts.open !== false) {
      openInstaller(installerPath, target);
      p.log.message(`Installer path: ${pc.cyan(installerPath)}`);
    } else {
      p.log.message(`Installer path: ${pc.cyan(installerPath)}`);
    }
  }

  p.outro(pc.green("Rudder start complete."));
}
