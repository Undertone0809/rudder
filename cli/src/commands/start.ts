import * as p from "@clack/prompts";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, constants as fsConstants, mkdirSync, readFileSync } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import pc from "picocolors";
import {
  expandHomePrefix,
  resolveDefaultEmbeddedPostgresDir,
  resolveRudderHomeDir,
  resolveRudderInstanceId,
} from "../config/home.js";
import { readConfig } from "../config/store.js";
import {
  createDesktopUpdateMaintenanceLock,
  createEmbeddedPostgresCheckpoint,
  hasResumableDesktopUpdateRecoveryTransaction,
  inspectDesktopUpdateRecoveryArtifacts,
  quarantineDesktopUpdateTarget,
  readDesktopUpdateTransaction,
  removeDesktopUpdateMaintenanceLock,
  removeDesktopUpdateRecoveryArtifacts,
  resolveDesktopUpdateBackupPath,
  resolveDesktopUpdateCheckpointPath,
  resolveDesktopUpdateMaintenanceLockPath,
  resolveDesktopUpdateTransactionPath,
  resolveOwnedDesktopUpdateTransactionPath,
  restorePathFromSnapshotAtomically,
  updateDesktopUpdateTransaction,
  waitForDesktopUpdateCandidate,
  waitForDesktopUpdateCandidateStability,
  withDesktopUpdateDecisionLock,
  writeDesktopUpdateTransaction,
  type DesktopUpdateFailureRecord,
  type DesktopUpdateTransaction,
} from "../desktop-update-recovery.js";
import {
  CLI_NPM_PACKAGE_NAME,
  getGlobalInstalledPackageVersion,
  installPersistentCli,
  resolvePersistentCliInstallSpec,
} from "../install.js";
import { ensureRuntimeInstalled, resolveRuntimePackageSpec, RuntimeInstallError, type RuntimeInstallResult } from "../runtime/install.js";
import { createByteProgress, formatBytes, type ByteProgressReporter } from "../utils/progress.js";
import { resolveCliVersion } from "../version.js";

export const DEFAULT_DESKTOP_RELEASE_REPO = "Undertone0809/rudder";
export const DESKTOP_UPDATE_QUIT_ARG = "--rudder-update-quit";
export const DESKTOP_UPDATE_FORCE_ARG = "--rudder-update-force";

type SupportedPlatform = "macos" | "windows" | "linux";

export interface DesktopAssetTarget {
  platform: SupportedPlatform;
  arch: "x64" | "arm64";
  extension: ".zip" | ".AppImage";
}

export interface DesktopInstallPaths {
  installRoot: string;
  appPath: string;
  executablePath: string;
  metadataPath: string;
}

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  url?: string;
}

interface GithubRelease {
  tag_name: string;
  assets: GithubReleaseAsset[];
}

export type DesktopAssetCandidate = {
  asset: GithubReleaseAsset;
  kind: "shell" | "full";
};

export type ChecksummedDesktopAssetCandidate = DesktopAssetCandidate & {
  expectedChecksum: string;
  warnings: string[];
};

interface StartCommandOptions {
  cli?: boolean;
  desktop?: boolean;
  serverOnly?: boolean;
  runtime?: boolean;
  version?: string;
  targetVersion?: string;
  repo?: string;
  outputDir?: string;
  desktopInstallDir?: string;
  open?: boolean;
  waitForActiveRuns?: boolean;
  desktopProgressJson?: boolean;
  desktopWaitForApply?: boolean;
  desktopUpdateId?: string;
  desktopUpdateOrigin?: "upgrade" | "fresh_install";
  desktopFromVersion?: string;
  desktopUpdateReadyTimeoutMs?: number;
  dryRun?: boolean;
  versionCheck?: boolean;
}

export interface DesktopInstallRecord {
  releaseTag: string;
  assetName: string;
  assetChecksum: string;
  assetKind?: "full" | "shell";
  installedAt: string;
}

export interface DesktopInstallMetadataV1 extends DesktopInstallRecord {
  version: 1;
}

export interface DesktopInstallMetadataV2 {
  version: 2;
  current: DesktopInstallRecord;
  lastKnownGood: DesktopInstallRecord;
  previous?: DesktopInstallRecord;
}

export type DesktopInstallMetadata = DesktopInstallMetadataV1 | DesktopInstallMetadataV2;

export interface DesktopAssetCacheRetentionOptions {
  now?: Date;
  protectedChecksums?: string[];
  maxEntries?: number;
  maxAgeMs?: number;
  maxTotalBytes?: number;
  keepPreviousEntries?: number;
}

export interface DesktopAssetCachePruneEntry {
  cacheDir: string;
  checksum: string;
  sizeBytes: number;
}

export interface DesktopAssetCachePruneResult {
  scanned: number;
  deleted: DesktopAssetCachePruneEntry[];
  protectedChecksums: string[];
  freedBytes: number;
  warnings: string[];
}

type UpdateQuitResponse =
  | { ok: true; status: "quitting"; pid?: number }
  | { ok: true; status: "not_running" }
  | { ok: false; status: "active_runs"; totalRuns: number }
  | { ok: false; status: "failed"; message: string };

export type ProgressReporterFactory = (label: string) => ByteProgressReporter;

type DesktopUpdateProgressPhase =
  | "starting"
  | "resolving_release"
  | "downloading_checksums"
  | "downloading_asset"
  | "verifying_checksum"
  | "ready_to_install"
  | "waiting_for_active_runs"
  | "preparing_restart"
  | "closing"
  | "failed";

type DesktopUpdateProgressEvent = {
  source: "rudder-desktop-update";
  phase: DesktopUpdateProgressPhase;
  message: string;
  percent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  totalRuns?: number;
  error?: string;
  at: string;
};

const STABLE_SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const CANARY_SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+-canary\.[0-9]+$/;
const CLI_REGISTRY_LATEST_URL = "https://registry.npmjs.org/@rudderhq%2fcli/latest";
const LEGACY_UPDATE_QUIT_GRACE_MS = 10_000;
const UPDATE_QUIT_FORCE_DELAY_MS = 1_000;
const DESKTOP_APP_NAME = "Rudder";
const DESKTOP_METADATA_FILE = ".rudder-desktop-install.json";
const DESKTOP_CHECKSUM_ASSET_NAME = "SHASUMS256.txt";
const DESKTOP_ASSET_CACHE_DIR = "desktop-assets";
const GITHUB_ASSET_DOWNLOAD_ACCEPT = "application/octet-stream";
const DEFAULT_DESKTOP_ASSET_CACHE_MAX_ENTRIES = 2;
const DEFAULT_DESKTOP_ASSET_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_DESKTOP_ASSET_CACHE_MAX_BYTES = 768 * 1024 * 1024;
const DEFAULT_DESKTOP_ASSET_CACHE_KEEP_PREVIOUS = 1;
const DESKTOP_INSTALL_LOCK_TIMEOUT_MS = 60 * 60 * 1000;
const DESKTOP_INSTALL_LOCK_POLL_MS = 250;

function normalizeProgressTotal(totalBytes: number | null | undefined): number | null {
  return typeof totalBytes === "number" && Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null;
}

function writeDesktopProgress(event: Omit<DesktopUpdateProgressEvent, "source" | "at">): void {
  const payload: DesktopUpdateProgressEvent = {
    source: "rudder-desktop-update",
    ...event,
    at: new Date().toISOString(),
  };
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code !== "EPIPE") throw error;
  }
}

function desktopDownloadPhase(label: string): DesktopUpdateProgressPhase {
  return label.toLowerCase().includes("shasums")
    ? "downloading_checksums"
    : "downloading_asset";
}

function createDesktopProgressFactory(): ProgressReporterFactory {
  return (label: string) => {
    const phase = desktopDownloadPhase(label);
    let latestReceivedBytes = 0;
    let latestTotalBytes: number | null | undefined = null;

    function emitByteProgress(
      message: string,
      receivedBytes: number,
      totalBytes: number | null | undefined,
    ): void {
      const total = normalizeProgressTotal(totalBytes);
      writeDesktopProgress({
        phase,
        message,
        transferredBytes: Math.max(0, receivedBytes),
        ...(total === null
          ? {}
          : {
            totalBytes: total,
            percent: Math.max(0, Math.min(100, Math.floor((Math.max(0, receivedBytes) / total) * 100))),
          }),
      });
    }

    return {
      start(totalBytes?: number | null) {
        latestReceivedBytes = 0;
        latestTotalBytes = totalBytes;
        emitByteProgress(label, 0, totalBytes);
      },
      update(receivedBytes: number, totalBytes?: number | null) {
        latestReceivedBytes = receivedBytes;
        latestTotalBytes = totalBytes;
        emitByteProgress(label, receivedBytes, totalBytes);
      },
      finish(receivedBytes = latestReceivedBytes, totalBytes = latestTotalBytes) {
        latestReceivedBytes = receivedBytes;
        latestTotalBytes = totalBytes;
        emitByteProgress(`${label} complete`, receivedBytes, totalBytes);
      },
      fail() {
        writeDesktopProgress({
          phase,
          message: `${label} failed`,
          transferredBytes: Math.max(0, latestReceivedBytes),
          error: `${label} failed`,
        });
      },
    };
  };
}

function createDesktopApplySignalController(): {
  waitForInitialSignal: () => Promise<{ force: boolean }>;
  waitForForceRequest: (timeoutMs: number) => Promise<boolean>;
  close: () => void;
} {
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  let buffer = "";
  let closed = false;
  let initialSettled = false;
  let forceRequested = false;
  let resolveInitial!: (value: { force: boolean }) => void;
  let rejectInitial!: (error: Error) => void;
  const forceWaiters = new Set<(force: boolean) => void>();
  const initialSignal = new Promise<{ force: boolean }>((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  });

  const settleForceWaiters = (force: boolean) => {
    for (const resolve of forceWaiters) resolve(force);
    forceWaiters.clear();
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    process.stdin.off("data", onData);
    process.stdin.off("end", onEnd);
    process.stdin.off("error", onError);
    settleForceWaiters(false);
  };
  const onData = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const command of lines.map((line) => line.trim())) {
      if (command === "force-apply") {
        forceRequested = true;
        if (!initialSettled) {
          initialSettled = true;
          resolveInitial({ force: true });
        }
        settleForceWaiters(true);
      } else if (command === "apply" && !initialSettled) {
        initialSettled = true;
        resolveInitial({ force: false });
      }
    }
  };
  const onEnd = () => {
    if (!initialSettled) {
      initialSettled = true;
      rejectInitial(new Error("Desktop update apply signal ended before confirmation."));
    }
    cleanup();
  };
  const onError = (error: Error) => {
    if (!initialSettled) {
      initialSettled = true;
      rejectInitial(error);
    }
    cleanup();
  };

  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);
  process.stdin.on("error", onError);
  return {
    waitForInitialSignal: () => initialSignal,
    waitForForceRequest: async (timeoutMs: number) => {
      if (forceRequested) return true;
      if (closed) return false;
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (force: boolean) => {
          if (settled) return;
          settled = true;
          forceWaiters.delete(finish);
          clearTimeout(timer);
          resolve(force);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        forceWaiters.add(finish);
      });
    },
    close: cleanup,
  };
}

export function resolveCurrentCliVersion(env: NodeJS.ProcessEnv = process.env): string {
  const version = resolveCliVersion(import.meta.url, env);
  return version === "0.0.0" ? "latest" : version;
}

export function resolveCliInstallSpec(version: string, env: NodeJS.ProcessEnv = process.env): string {
  if (version && version !== "latest") return `${CLI_NPM_PACKAGE_NAME}@${version}`;
  return resolvePersistentCliInstallSpec(env);
}

export function isPersistentCliVersionCurrent(version: string, installedVersion: string | null): boolean {
  return Boolean(version && version !== "latest" && installedVersion === version);
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
    `Desktop release lookup requires a release version like 0.1.0 or 0.1.0-canary.0. Received ${version}.`,
  );
}

export function isExactRuntimePackageSpec(version: string, packageSpec: string): boolean {
  return version !== "latest" && packageSpec === resolveRuntimePackageSpec(version);
}

export function runtimeSupportsDesktopShellAssets(
  version: string,
  runtime: Pick<RuntimeInstallResult, "packageSpec" | "postgresPayloadBinDir">,
): boolean {
  return isExactRuntimePackageSpec(version, runtime.packageSpec) && Boolean(runtime.postgresPayloadBinDir);
}

export function resolveDesktopAssetTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): DesktopAssetTarget {
  if (platform === "darwin") {
    if (arch !== "x64" && arch !== "arm64") {
      throw new Error(`Rudder Desktop does not publish portable assets for ${platform}/${arch}.`);
    }
    return { platform: "macos", arch, extension: ".zip" };
  }
  if (platform === "win32") return { platform: "windows", arch: "x64", extension: ".zip" };
  if (platform === "linux") {
    if (arch !== "x64") {
      throw new Error(`Rudder Desktop does not publish portable assets for ${platform}/${arch}.`);
    }
    return { platform: "linux", arch: "x64", extension: ".AppImage" };
  }

  throw new Error(`Rudder Desktop does not publish portable assets for ${platform}.`);
}

export function resolveDefaultDesktopInstallRoot(
  target: DesktopAssetTarget,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string {
  if (target.platform === "macos") return path.join(homeDir, "Applications");
  if (target.platform === "windows") {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(homeDir, "AppData", "Local");
    return path.join(localAppData, "Programs", DESKTOP_APP_NAME);
  }
  return path.join(homeDir, ".local", "share", "rudder");
}

export function resolveDesktopInstallPaths(
  target: DesktopAssetTarget,
  installRoot: string,
): DesktopInstallPaths {
  const root = path.resolve(installRoot);
  if (target.platform === "macos") {
    const appPath = path.join(root, `${DESKTOP_APP_NAME}.app`);
    return {
      installRoot: root,
      appPath,
      executablePath: path.join(appPath, "Contents", "MacOS", DESKTOP_APP_NAME),
      metadataPath: path.join(root, DESKTOP_METADATA_FILE),
    };
  }
  if (target.platform === "windows") {
    return {
      installRoot: root,
      appPath: root,
      executablePath: path.join(root, `${DESKTOP_APP_NAME}.exe`),
      metadataPath: path.join(root, DESKTOP_METADATA_FILE),
    };
  }
  const appPath = path.join(root, `${DESKTOP_APP_NAME}.AppImage`);
  return {
    installRoot: root,
    appPath,
    executablePath: appPath,
    metadataPath: path.join(root, DESKTOP_METADATA_FILE),
  };
}

function normalizeAssetName(name: string): string {
  return name.toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
}

function scoreDesktopAsset(asset: GithubReleaseAsset, target: DesktopAssetTarget): number {
  const normalized = normalizeAssetName(asset.name);
  const expectedExtension = target.extension.toLowerCase();
  if (!normalized.endsWith(expectedExtension.toLowerCase())) return -1;
  if (normalized.includes("blockmap") || normalized.includes("shasum")) return -1;
  if (normalized.includes("shell")) return -1;

  let score = 1;
  if (normalized.includes("rudder")) score += 2;
  if (normalized.includes(target.platform)) score += 4;
  if (normalized.includes("portable")) score += 6;
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

export function selectDesktopShellAsset(
  assets: GithubReleaseAsset[],
  target: DesktopAssetTarget,
): GithubReleaseAsset | null {
  if (!resolveDesktopShellAssetName("", target)) return null;

  const scored = assets
    .map((asset) => {
      const normalized = normalizeAssetName(asset.name);
      if (!normalized.endsWith(".zip")) return { asset, score: -1 };
      if (!normalized.includes("shell")) return { asset, score: -1 };
      if (!normalized.includes("rudder")) return { asset, score: -1 };
      if (!normalized.includes(target.platform)) return { asset, score: -1 };

      let score = 1;
      if (target.arch === "arm64" && normalized.includes("arm64")) score += 4;
      if (target.arch === "x64" && (normalized.includes("x64") || normalized.includes("amd64"))) score += 4;
      if (target.platform === "macos" && target.arch === "x64" && normalized.includes("arm64")) score -= 10;
      if (target.arch === "arm64" && normalized.includes("x64")) score -= 10;
      return { asset, score };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name));

  return scored[0]?.asset ?? null;
}

export function resolveDesktopAssetCandidates(options: {
  releaseAssets: GithubReleaseAsset[];
  target: DesktopAssetTarget;
  repo: string;
  tag: string;
  directReleaseVersion: string | null;
  allowShellAssets?: boolean;
}): DesktopAssetCandidate[] {
  const candidates: DesktopAssetCandidate[] = [];
  const deterministicShellName = options.directReleaseVersion
    ? resolveDesktopShellAssetName(options.directReleaseVersion, options.target)
    : null;
  if (options.allowShellAssets !== false) {
    const shellAsset = selectDesktopShellAsset(options.releaseAssets, options.target)
      ?? (
        options.releaseAssets.length === 0 && deterministicShellName
          ? buildGithubReleaseAsset(options.repo, options.tag, deterministicShellName)
          : null
      );
    if (shellAsset) candidates.push({ asset: shellAsset, kind: "shell" });
  }

  const fullAsset = selectDesktopAsset(options.releaseAssets, options.target)
    ?? (
      options.directReleaseVersion
        ? buildGithubReleaseAsset(options.repo, options.tag, resolveDesktopAssetName(options.directReleaseVersion, options.target))
        : null
    );
  if (fullAsset) candidates.push({ asset: fullAsset, kind: "full" });

  return candidates;
}

export function selectChecksummedDesktopAssetCandidate(
  candidates: DesktopAssetCandidate[],
  checksums: Map<string, string>,
): ChecksummedDesktopAssetCandidate {
  const warnings: string[] = [];

  for (const candidate of candidates) {
    try {
      return {
        ...candidate,
        expectedChecksum: resolveAssetChecksum(checksums, candidate.asset.name),
        warnings,
      };
    } catch (error) {
      if (candidate.kind === "shell") {
        warnings.push(
          `Layered Desktop shell asset is missing from ${DESKTOP_CHECKSUM_ASSET_NAME}; falling back to the full portable asset.`,
        );
        continue;
      }
      throw error;
    }
  }

  throw new Error("No checksummed Rudder Desktop asset candidate is available.");
}

export function selectChecksumAsset(assets: GithubReleaseAsset[]): GithubReleaseAsset | null {
  return assets.find((asset) => asset.name.toLowerCase() === DESKTOP_CHECKSUM_ASSET_NAME.toLowerCase()) ?? null;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function githubApiHeaders(): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "rudder-cli-installer",
  };
}

const GITHUB_API_TIMEOUT_MS = 15_000;

async function fetchGithubRelease(repo: string, tag: string): Promise<GithubRelease> {
  const endpoint =
    tag === "latest"
      ? `https://api.github.com/repos/${repo}/releases/latest`
      : `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await fetchWithTimeout(endpoint, { headers: githubApiHeaders() }, GITHUB_API_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`GitHub Release ${tag} was not found in ${repo} (${response.status}).`);
  }
  return (await response.json()) as GithubRelease;
}

export function resolveDesktopReleaseVersion(tag: string): string | null {
  if (!tag || tag === "latest") return null;

  const name = tag.split("/").pop() ?? tag;
  if (!name.startsWith("v")) return null;

  const version = name.slice(1);
  if (STABLE_SEMVER_RE.test(version) || CANARY_SEMVER_RE.test(version)) return version;

  return null;
}

export function resolveDesktopAssetName(version: string, target: DesktopAssetTarget): string {
  if (target.platform === "macos") return `${DESKTOP_APP_NAME}-${version}-macos-${target.arch}-portable.zip`;
  if (target.platform === "windows") return `${DESKTOP_APP_NAME}-${version}-windows-x64-portable.zip`;
  return `${DESKTOP_APP_NAME}-${version}-linux-x64.AppImage`;
}

export function resolveDesktopShellAssetName(version: string, target: DesktopAssetTarget): string | null {
  if (target.platform === "macos") return `${DESKTOP_APP_NAME}-${version}-macos-${target.arch}-shell.zip`;
  if (target.platform === "windows") return `${DESKTOP_APP_NAME}-${version}-windows-x64-shell.zip`;
  return null;
}

function encodeReleaseTagForDownloadUrl(tag: string): string {
  return tag.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function buildGithubReleaseAssetDownloadUrl(repo: string, tag: string, assetName: string): string {
  const encodedTag = encodeReleaseTagForDownloadUrl(tag);
  return `https://github.com/${repo}/releases/download/${encodedTag}/${encodeURIComponent(assetName)}`;
}

function buildGithubReleaseAsset(repo: string, tag: string, assetName: string): GithubReleaseAsset {
  return {
    name: assetName,
    browser_download_url: buildGithubReleaseAssetDownloadUrl(repo, tag, assetName),
  };
}

function uniqueAssetDownloadUrls(asset: GithubReleaseAsset): string[] {
  const urls = [asset.browser_download_url, asset.url].filter((url): url is string => Boolean(url));
  return Array.from(new Set(urls));
}

function downloadHeadersForAssetUrl(asset: GithubReleaseAsset, url: string): HeadersInit {
  return {
    Accept: url === asset.url ? GITHUB_ASSET_DOWNLOAD_ACCEPT : "*/*",
    "User-Agent": "rudder-cli-installer",
  };
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    const suffix = typeof code === "string" ? ` [${code}]` : "";
    return `${error.message}: ${cause.message}${suffix}`;
  }

  return error.message;
}

function contentLengthFromHeaders(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function downloadAsset(
  asset: GithubReleaseAsset,
  outputDir: string,
  progressFactory: ProgressReporterFactory = createByteProgress,
): Promise<string> {
  mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, path.basename(asset.name));

  const ASSET_DOWNLOAD_TIMEOUT_MS = 600_000;
  let response: Response | null = null;
  const failures: string[] = [];
  for (const url of uniqueAssetDownloadUrls(asset)) {
    try {
      const candidate = await fetchWithTimeout(
        url,
        { headers: downloadHeadersForAssetUrl(asset, url) },
        ASSET_DOWNLOAD_TIMEOUT_MS,
      );
      if (candidate.ok && candidate.body) {
        response = candidate;
        break;
      }
      failures.push(`Failed to download ${asset.name} from ${url} (${candidate.status}).`);
    } catch (error) {
      failures.push(`Failed to download ${asset.name} from ${url}: ${formatFetchError(error)}.`);
    }
  }

  if (!response) {
    throw new Error(failures.join("\n"));
  }

  const totalBytes = contentLengthFromHeaders(response.headers);
  const progress = progressFactory(`Downloading ${asset.name}`);
  let receivedBytes = 0;
  const monitor = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      receivedBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      progress.update(receivedBytes, totalBytes);
      callback(null, chunk);
    },
  });

  progress.start(totalBytes);
  try {
    await pipeline(Readable.fromWeb(response.body as never), monitor, createWriteStream(outputPath));
    progress.finish(receivedBytes, totalBytes);
  } catch (error) {
    progress.fail();
    throw error;
  }
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

export function resolveAssetChecksum(checksums: Map<string, string>, assetName: string): string {
  const expected = checksums.get(path.basename(assetName));
  if (!expected) {
    throw new Error(`Desktop release checksums do not include ${path.basename(assetName)}.`);
  }
  return expected;
}

export function assertChecksumMatch(filePath: string, expected: string): string {
  const actual = checksumForFile(filePath);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${path.basename(filePath)}.`);
  }
  return actual;
}

export async function downloadChecksums(
  checksumAsset: GithubReleaseAsset | null,
  outputDir: string,
  progressFactory: ProgressReporterFactory = createByteProgress,
): Promise<Map<string, string>> {
  if (!checksumAsset) {
    throw new Error("Desktop release is missing SHASUMS256.txt.");
  }
  const checksumPath = await downloadAsset(checksumAsset, outputDir, progressFactory);
  return parseChecksumFile(readFileSync(checksumPath, "utf8"));
}

function normalizeDesktopAssetChecksum(checksum: string): string {
  const normalized = checksum.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Desktop asset cache requires a SHA-256 checksum.");
  }
  return normalized;
}

export function resolveDesktopAssetCacheDir(
  assetChecksum: string,
  homeDir: string = resolveRudderHomeDir(),
): string {
  return path.join(homeDir, DESKTOP_ASSET_CACHE_DIR, normalizeDesktopAssetChecksum(assetChecksum));
}

export function resolveDesktopCachedAssetPath(
  assetName: string,
  assetChecksum: string,
  homeDir: string = resolveRudderHomeDir(),
): string {
  return path.join(resolveDesktopAssetCacheDir(assetChecksum, homeDir), path.basename(assetName));
}

interface DesktopAssetCacheEntry {
  cacheDir: string;
  checksum: string;
  lastUsedAtMs: number;
  sizeBytes: number;
}

export async function pruneDesktopAssetCache(
  options: DesktopAssetCacheRetentionOptions & { homeDir?: string } = {},
): Promise<DesktopAssetCachePruneResult> {
  const homeDir = options.homeDir ?? resolveRudderHomeDir();
  const entries = await scanDesktopAssetCacheEntries(homeDir);
  const protectedChecksums = resolveProtectedDesktopAssetChecksums(entries, {
    protectedChecksums: options.protectedChecksums ?? [],
    keepPreviousEntries: options.keepPreviousEntries ?? DEFAULT_DESKTOP_ASSET_CACHE_KEEP_PREVIOUS,
  });
  const protectedSet = new Set(protectedChecksums);
  const deletions = planDesktopAssetCacheDeletions(entries, {
    nowMs: (options.now ?? new Date()).getTime(),
    protectedChecksums: protectedSet,
    maxEntries: options.maxEntries ?? DEFAULT_DESKTOP_ASSET_CACHE_MAX_ENTRIES,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_DESKTOP_ASSET_CACHE_MAX_AGE_MS,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_DESKTOP_ASSET_CACHE_MAX_BYTES,
  });
  const deleted: DesktopAssetCachePruneEntry[] = [];
  const warnings: string[] = [];

  for (const entry of deletions) {
    try {
      await rm(entry.cacheDir, { recursive: true, force: true });
      deleted.push({
        cacheDir: entry.cacheDir,
        checksum: entry.checksum,
        sizeBytes: entry.sizeBytes,
      });
    } catch (error) {
      warnings.push(
        `Failed to remove Desktop asset cache ${entry.cacheDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    scanned: entries.length,
    deleted,
    protectedChecksums,
    freedBytes: deleted.reduce((total, entry) => total + entry.sizeBytes, 0),
    warnings,
  };
}

async function maybePruneDesktopAssetCache(options: {
  homeDir?: string;
  protectedChecksums: string[];
}): Promise<DesktopAssetCachePruneResult | null> {
  const result = await pruneDesktopAssetCache(options);
  return result.deleted.length > 0 || result.warnings.length > 0 ? result : null;
}

async function scanDesktopAssetCacheEntries(homeDir: string): Promise<DesktopAssetCacheEntry[]> {
  const cacheRoot = path.join(homeDir, DESKTOP_ASSET_CACHE_DIR);
  const dirents = await readdir(cacheRoot, { withFileTypes: true }).catch(() => null);
  if (!dirents) return [];

  const entries: DesktopAssetCacheEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    let checksum: string;
    try {
      checksum = normalizeDesktopAssetChecksum(dirent.name);
    } catch {
      continue;
    }
    const cacheDir = path.join(cacheRoot, dirent.name);
    const stats = await desktopCacheDirectoryStats(cacheDir);
    entries.push({
      cacheDir,
      checksum,
      lastUsedAtMs: stats.lastUsedAtMs,
      sizeBytes: stats.sizeBytes,
    });
  }
  return entries;
}

async function desktopCacheDirectoryStats(targetPath: string): Promise<{ sizeBytes: number; lastUsedAtMs: number }> {
  const fallbackStat = await stat(targetPath).catch(() => null);
  const dirents = await readdir(targetPath, { withFileTypes: true }).catch(() => null);
  if (!dirents) {
    return {
      sizeBytes: 0,
      lastUsedAtMs: Number(fallbackStat?.mtimeMs ?? 0),
    };
  }

  let sizeBytes = 0;
  let lastUsedAtMs = Number(fallbackStat?.mtimeMs ?? 0);
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue;
    const entryPath = path.join(targetPath, dirent.name);
    const entryStat = await stat(entryPath).catch(() => null);
    if (!entryStat) continue;
    lastUsedAtMs = Math.max(lastUsedAtMs, Number(entryStat.mtimeMs ?? 0));
    if (dirent.isDirectory()) {
      const nested = await desktopCacheDirectoryStats(entryPath);
      sizeBytes += nested.sizeBytes;
      lastUsedAtMs = Math.max(lastUsedAtMs, nested.lastUsedAtMs);
      continue;
    }
    sizeBytes += Number(entryStat.size ?? 0);
  }
  return { sizeBytes, lastUsedAtMs };
}

function resolveProtectedDesktopAssetChecksums(
  entries: DesktopAssetCacheEntry[],
  options: {
    protectedChecksums: string[];
    keepPreviousEntries: number;
  },
): string[] {
  const protectedChecksums = new Set<string>();
  for (const checksum of options.protectedChecksums) {
    try {
      protectedChecksums.add(normalizeDesktopAssetChecksum(checksum));
    } catch {
      continue;
    }
  }

  const previousEntries = [...entries]
    .filter((entry) => !protectedChecksums.has(entry.checksum))
    .sort((a, b) => b.lastUsedAtMs - a.lastUsedAtMs);
  for (const entry of previousEntries.slice(0, Math.max(0, options.keepPreviousEntries))) {
    protectedChecksums.add(entry.checksum);
  }

  return [...protectedChecksums].sort();
}

function planDesktopAssetCacheDeletions(
  entries: DesktopAssetCacheEntry[],
  options: {
    nowMs: number;
    protectedChecksums: Set<string>;
    maxEntries: number;
    maxAgeMs: number;
    maxTotalBytes: number;
  },
): DesktopAssetCacheEntry[] {
  const deletions = new Set<string>();
  const oldestFirst = [...entries].sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs);
  const canDelete = (entry: DesktopAssetCacheEntry): boolean =>
    !options.protectedChecksums.has(entry.checksum) && !deletions.has(entry.cacheDir);
  const mark = (entry: DesktopAssetCacheEntry): void => {
    if (canDelete(entry)) deletions.add(entry.cacheDir);
  };

  if (options.maxAgeMs >= 0) {
    for (const entry of oldestFirst) {
      if (options.nowMs - entry.lastUsedAtMs > options.maxAgeMs) mark(entry);
    }
  }

  if (options.maxEntries > 0) {
    for (const entry of oldestFirst) {
      if (entries.length - deletions.size <= options.maxEntries) break;
      mark(entry);
    }
  }

  if (options.maxTotalBytes > 0) {
    let remainingBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0)
      - [...deletions].reduce((total, cacheDir) => total + (entries.find((entry) => entry.cacheDir === cacheDir)?.sizeBytes ?? 0), 0);
    for (const entry of oldestFirst) {
      if (remainingBytes <= options.maxTotalBytes) break;
      if (!canDelete(entry)) continue;
      deletions.add(entry.cacheDir);
      remainingBytes -= entry.sizeBytes;
    }
  }

  return entries.filter((entry) => deletions.has(entry.cacheDir));
}

async function touchDesktopCachedAsset(cachePath: string): Promise<void> {
  try {
    const now = new Date();
    await utimes(cachePath, now, now);
  } catch {
    // Cache recency should not make a verified Desktop asset unusable.
  }
}

export async function downloadDesktopAssetWithCache(
  asset: GithubReleaseAsset,
  expectedChecksum: string,
  options: {
    homeDir?: string;
    outputDir?: string;
    progressFactory?: ProgressReporterFactory;
  } = {},
): Promise<{ path: string; checksum: string; cacheStatus: "hit" | "miss" }> {
  const normalizedChecksum = normalizeDesktopAssetChecksum(expectedChecksum);
  const cachePath = resolveDesktopCachedAssetPath(asset.name, normalizedChecksum, options.homeDir);

  if (await pathExists(cachePath)) {
    try {
      const checksum = assertChecksumMatch(cachePath, normalizedChecksum);
      await touchDesktopCachedAsset(cachePath);
      return { path: cachePath, checksum, cacheStatus: "hit" };
    } catch {
      await rm(cachePath, { force: true });
    }
  }

  const outputDir = options.outputDir ?? await mkdtemp(path.join(tmpdir(), "rudder-desktop-installer."));
  const removeOutputDir = options.outputDir ? false : true;
  try {
    const downloadedPath = await downloadAsset(asset, outputDir, options.progressFactory);
    const checksum = assertChecksumMatch(downloadedPath, normalizedChecksum);
    await mkdir(path.dirname(cachePath), { recursive: true });
    if (path.resolve(downloadedPath) !== path.resolve(cachePath)) {
      await copyFile(downloadedPath, cachePath);
    }
    return { path: cachePath, checksum, cacheStatus: "miss" };
  } finally {
    if (removeOutputDir) await rm(outputDir, { recursive: true, force: true });
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

type DesktopInstallLockPayload = {
  lockId: string;
  pid: number;
  installRoot: string;
  createdAt: string;
};

export function resolveDesktopInstallLockPath(paths: DesktopInstallPaths): string {
  const installRootHash = createHash("sha256").update(path.resolve(paths.installRoot)).digest("hex").slice(0, 16);
  return path.join(path.dirname(paths.appPath), `.rudder-desktop-install-${installRootHash}.lock`);
}

async function readDesktopInstallLock(lockPath: string): Promise<DesktopInstallLockPayload | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    if (
      typeof parsed.pid !== "number"
      || !Number.isInteger(parsed.pid)
      || parsed.pid <= 0
      || typeof parsed.lockId !== "string"
      || typeof parsed.installRoot !== "string"
      || typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return {
      lockId: parsed.lockId,
      pid: parsed.pid,
      installRoot: parsed.installRoot,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export async function withDesktopInstallLock<T>(
  paths: DesktopInstallPaths,
  fn: () => Promise<T>,
  options: {
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<T> {
  const lockPath = resolveDesktopInstallLockPath(paths);
  const lockDir = path.dirname(lockPath);
  const timeoutMs = options.timeoutMs ?? DESKTOP_INSTALL_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DESKTOP_INSTALL_LOCK_POLL_MS;
  const startedAt = Date.now();
  const payload: DesktopInstallLockPayload = {
    lockId: randomUUID(),
    pid: process.pid,
    installRoot: path.resolve(paths.installRoot),
    createdAt: new Date().toISOString(),
  };

  await mkdir(lockDir, { recursive: true });

  while (true) {
    try {
      await writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw error;

      const existing = await readDesktopInstallLock(lockPath);
      const stale = !existing || !processExists(existing.pid);
      if (stale) {
        await rm(lockPath, { force: true });
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for Rudder Desktop install lock for ${paths.appPath}. `
          + `Held by pid ${existing.pid} for ${existing.installRoot}.`,
        );
      }
      await delay(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    const existing = await readDesktopInstallLock(lockPath);
    if (existing?.lockId === payload.lockId) {
      await rm(lockPath, { force: true });
    }
  }
}

function runChecked(command: string, args: string[], options: { cwd?: string; shell?: boolean } = {}): void {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status === 0) return;

  const output = [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  throw new Error(`${command} ${args.join(" ")} failed${output ? `: ${output}` : ""}`);
}

function formatCommandFailure(command: string, args: string[], stdout: unknown, stderr: unknown): string {
  const output = [stdout, stderr]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  return `${command} ${args.join(" ")} failed${output ? `: ${output}` : ""}`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildWindowsZipExtractCommand(zipPath: string, outputDir: string): { command: string; args: string[] } {
  return { command: "tar.exe", args: ["-xf", zipPath, "-C", outputDir] };
}

export function buildWindowsRobocopyMirrorCommand(sourcePath: string, destinationPath: string): { command: string; args: string[] } {
  return {
    command: "robocopy.exe",
    args: [sourcePath, destinationPath, "/MIR", "/R:2", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"],
  };
}

export function isSuccessfulRobocopyExitCode(status: number | null): boolean {
  return typeof status === "number" && status >= 0 && status <= 7;
}

async function extractZip(zipPath: string, outputDir: string, target: DesktopAssetTarget): Promise<void> {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  if (target.platform === "macos") {
    runChecked("ditto", ["-x", "-k", zipPath, outputDir]);
    return;
  }

  if (target.platform === "windows") {
    const command = buildWindowsZipExtractCommand(zipPath, outputDir);
    runChecked(command.command, command.args);
    return;
  }

  throw new Error(`Zip assets are not supported for ${target.platform}.`);
}

async function findPath(
  root: string,
  predicate: (filePath: string, isDirectory: boolean) => boolean,
  maxDepth = 5,
): Promise<string | null> {
  async function visit(dir: string, depth: number): Promise<string | null> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (predicate(fullPath, entry.isDirectory())) return fullPath;
      if (entry.isDirectory() && depth < maxDepth) {
        const nested = await visit(fullPath, depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  }

  return await visit(root, 0);
}

async function findMacApp(extractDir: string): Promise<string> {
  const direct = path.join(extractDir, `${DESKTOP_APP_NAME}.app`);
  if (await pathExists(direct)) return direct;
  const found = await findPath(extractDir, (filePath, isDirectory) =>
    isDirectory && path.basename(filePath) === `${DESKTOP_APP_NAME}.app`);
  if (!found) throw new Error(`Portable macOS archive did not contain ${DESKTOP_APP_NAME}.app.`);
  return found;
}

async function findWindowsAppDir(extractDir: string): Promise<string> {
  const direct = path.join(extractDir, `${DESKTOP_APP_NAME}.exe`);
  if (await pathExists(direct)) return extractDir;
  const executable = await findPath(extractDir, (filePath, isDirectory) =>
    !isDirectory && path.basename(filePath).toLowerCase() === `${DESKTOP_APP_NAME.toLowerCase()}.exe`);
  if (!executable) throw new Error(`Portable Windows archive did not contain ${DESKTOP_APP_NAME}.exe.`);
  return path.dirname(executable);
}

async function readInstallMetadata(metadataPath: string): Promise<DesktopInstallMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as DesktopInstallMetadata;
    if (parsed.version !== 1 && parsed.version !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

function currentInstallRecord(metadata: DesktopInstallMetadata | null): DesktopInstallRecord | null {
  if (!metadata) return null;
  return metadata.version === 1
    ? {
        releaseTag: metadata.releaseTag,
        assetName: metadata.assetName,
        assetChecksum: metadata.assetChecksum,
        assetKind: metadata.assetKind,
        installedAt: metadata.installedAt,
      }
    : metadata.current;
}

export function isInstalledDesktopCurrent(
  metadata: DesktopInstallMetadata | null,
  releaseTag: string,
  assetName: string,
  assetChecksum: string,
): boolean {
  const current = currentInstallRecord(metadata);
  return Boolean(
    current &&
    current.releaseTag === releaseTag &&
    current.assetName === assetName &&
    current.assetChecksum === assetChecksum,
  );
}

function forceQuitDesktopProcess(pid: number, target: DesktopAssetTarget): void {
  if (target.platform === "windows") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may already have exited between the wait timeout and kill.
  }
}

function quotePowerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function findDesktopExecutablePids(executablePath: string, target: DesktopAssetTarget): number[] {
  if (target.platform === "windows") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${quotePowerShellString(executablePath)} } | Select-Object -ExpandProperty ProcessId`,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  }

  const result = spawnSync("ps", ["-eo", "pid=,args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return [];

  return result.stdout
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) return [];
      const pid = Number.parseInt(match[1], 10);
      const commandLine = match[2];
      const matchesExecutable = commandLine === executablePath || commandLine.startsWith(`${executablePath} `);
      return matchesExecutable && pid !== process.pid ? [pid] : [];
    });
}

function isRunningInsideDesktopExecutable(): boolean {
  return path.basename(process.execPath).toLowerCase().startsWith(DESKTOP_APP_NAME.toLowerCase());
}

async function waitForUpdateQuitResponse(responsePath: string, timeoutMs = 8_000): Promise<UpdateQuitResponse | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await pathExists(responsePath)) {
      return JSON.parse(await readFile(responsePath, "utf8")) as UpdateQuitResponse;
    }
    await delay(200);
  }
  return null;
}

async function requestDesktopQuit(
  executablePath: string,
  target: DesktopAssetTarget,
  options: { forceUpdate?: boolean; responseTimeoutMs?: number } = {},
): Promise<UpdateQuitResponse | null> {
  if (!(await pathExists(executablePath))) return { ok: true, status: "not_running" };
  const responsePath = path.join(tmpdir(), `rudder-update-quit-${process.pid}-${Date.now()}.json`);
  const result = spawnSync(executablePath, [
    `${DESKTOP_UPDATE_QUIT_ARG}=${responsePath}`,
    ...(options.forceUpdate ? [DESKTOP_UPDATE_FORCE_ARG] : []),
  ], {
    stdio: "ignore",
    timeout: 5_000,
  });
  if (result.error && target.platform === "windows") {
    return null;
  }

  try {
    return await waitForUpdateQuitResponse(responsePath, options.responseTimeoutMs);
  } finally {
    await rm(responsePath, { force: true });
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    return code === "EPERM";
  }
}

function readUpdateQuitPid(response: UpdateQuitResponse | null): number | null {
  if (!response?.ok || response.status !== "quitting") return null;
  return typeof response.pid === "number" && Number.isInteger(response.pid) && response.pid > 0
    ? response.pid
    : null;
}

function isLegacyUnconfirmedUpdateQuit(response: UpdateQuitResponse | null): boolean {
  return Boolean(response?.ok && response.status === "quitting" && !readUpdateQuitPid(response));
}

export async function waitForProcessExit(pid: number, timeoutMs = 20_000, intervalMs = 250): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!processExists(pid)) return true;
    await delay(intervalMs);
  }
  return !processExists(pid);
}

async function waitForProcessesExit(
  pids: number[],
  waitForExit: (pid: number) => Promise<boolean>,
): Promise<boolean> {
  const uniquePids = [...new Set(pids)];
  if (uniquePids.length === 0) return true;
  const results = await Promise.all(uniquePids.map((pid) => waitForExit(pid)));
  return results.every(Boolean);
}

async function removePathWithRetry(targetPath: string, attempts = 5): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      if (!(await pathExists(targetPath))) return true;
    } catch {
      // Retry below; Windows can keep files locked briefly after process exit.
    }
    await delay(500);
  }
  return false;
}

export async function prepareForDesktopReplace(
  paths: DesktopInstallPaths,
  target: DesktopAssetTarget,
  options: {
    waitForActiveRuns?: boolean;
    waitForForceUpdate?: (timeoutMs: number) => Promise<boolean>;
    onActiveRunsWaiting?: (totalRuns: number) => void;
    activeRunPollIntervalMs?: number;
    forceUpdate?: boolean;
    legacyUpdateQuitGraceMs?: number;
    updateQuitResponseTimeoutMs?: number;
    updateQuitForceDelayMs?: number;
    forceQuitDesktopProcess?: (pid: number, target: DesktopAssetTarget) => void;
    waitForDesktopProcessExit?: (pid: number) => Promise<boolean>;
    findDesktopExecutablePids?: (executablePath: string, target: DesktopAssetTarget) => number[];
    beforeRemove?: () => Promise<void>;
    preserveInstallPath?: boolean;
  } = {},
): Promise<void> {
  const forceQuitPid = options.forceQuitDesktopProcess ?? forceQuitDesktopProcess;
  const waitForExit = options.waitForDesktopProcessExit ?? waitForProcessExit;
  const findPids = options.findDesktopExecutablePids ?? findDesktopExecutablePids;
  async function forceQuitPidAndConfirm(pid: number): Promise<void> {
    forceQuitPid(pid, target);
    await delay(options.updateQuitForceDelayMs ?? UPDATE_QUIT_FORCE_DELAY_MS);
    if (!(await waitForExit(pid))) {
      throw new Error(`Rudder Desktop process ${pid} did not exit after force-quit fallback. Close Rudder and rerun start.`);
    }
  }
  async function forceQuitPidsAndConfirm(pids: number[]): Promise<void> {
    const uniquePids = [...new Set(pids)];
    for (const pid of uniquePids) {
      forceQuitPid(pid, target);
    }
    await delay(options.updateQuitForceDelayMs ?? UPDATE_QUIT_FORCE_DELAY_MS);
    if (!(await waitForProcessesExit(uniquePids, waitForExit))) {
      throw new Error(`Rudder Desktop process${uniquePids.length === 1 ? "" : "es"} ${uniquePids.join(", ")} did not exit after force-quit fallback. Close Rudder and rerun start.`);
    }
  }
  let quitPid: number | null = null;
  let managedExecutablePids: number[] = [];
  const hasManagedExecutable = await pathExists(paths.executablePath);
  if (hasManagedExecutable) {
    managedExecutablePids = findPids(paths.executablePath, target);
    let forceUpdate = options.forceUpdate === true;
    const requestQuit = () => requestDesktopQuit(paths.executablePath, target, {
      forceUpdate,
      responseTimeoutMs: options.updateQuitResponseTimeoutMs,
    });
    let quitResponse = await requestQuit();
    while (quitResponse && !quitResponse.ok && quitResponse.status === "active_runs" && options.waitForActiveRuns && !forceUpdate) {
      p.log.warn(
        `Rudder Desktop has ${quitResponse.totalRuns} active run${quitResponse.totalRuns === 1 ? "" : "s"}; waiting before replacing Desktop.`,
      );
      options.onActiveRunsWaiting?.(quitResponse.totalRuns);
      const pollIntervalMs = options.activeRunPollIntervalMs ?? 15_000;
      forceUpdate = options.waitForForceUpdate
        ? await options.waitForForceUpdate(pollIntervalMs)
        : (await delay(pollIntervalMs), false);
      quitResponse = await requestQuit();
    }
    if (quitResponse && !quitResponse.ok && quitResponse.status === "active_runs") {
      if (!forceUpdate) {
        throw new Error(
          `Rudder Desktop has ${quitResponse.totalRuns} active run${quitResponse.totalRuns === 1 ? "" : "s"}. Stop active work, then rerun start.`,
        );
      }
      throw new Error(
        `Rudder Desktop still has ${quitResponse.totalRuns} active run${quitResponse.totalRuns === 1 ? "" : "s"} after the force-update request. Stop active work, then rerun start.`,
      );
    }
    if (quitResponse && !quitResponse.ok && quitResponse.status === "failed") {
      throw new Error(quitResponse.message);
    }
    quitPid = readUpdateQuitPid(quitResponse);
    if (quitPid) {
      p.log.info(`Waiting for existing Rudder Desktop process ${quitPid} to exit before replacing it.`);
      if (!(await waitForExit(quitPid))) {
        p.log.warn(`Rudder Desktop process ${quitPid} did not exit in time; attempting force-quit fallback.`);
        await forceQuitPidAndConfirm(quitPid);
      }
    } else if (isLegacyUnconfirmedUpdateQuit(quitResponse)) {
      const graceMs = options.legacyUpdateQuitGraceMs ?? LEGACY_UPDATE_QUIT_GRACE_MS;
      p.log.warn(
        `Existing Rudder Desktop acknowledged update quit without a process id; waiting ${Math.ceil(graceMs / 1_000)}s before replacement.`,
      );
      await delay(graceMs);
      if (managedExecutablePids.length > 0 && !(await waitForProcessesExit(managedExecutablePids, waitForExit))) {
        p.log.warn(
          `Existing Rudder Desktop did not exit after acknowledging update quit; attempting path-scoped force-quit for process${managedExecutablePids.length === 1 ? "" : "es"} ${managedExecutablePids.join(", ")}.`,
        );
        await forceQuitPidsAndConfirm(managedExecutablePids);
      }
    } else if (!quitResponse) {
      if (options.forceUpdate && managedExecutablePids.length > 0) {
        p.log.warn(
          `Existing Rudder Desktop did not respond to the update quit request; attempting path-scoped force-quit for process${managedExecutablePids.length === 1 ? "" : "es"} ${managedExecutablePids.join(", ")}.`,
        );
        await forceQuitPidsAndConfirm(managedExecutablePids);
      } else {
        throw new Error("Existing Rudder Desktop did not respond to the update quit request. Close Rudder and rerun start.");
      }
    } else {
      await delay(options.updateQuitForceDelayMs ?? UPDATE_QUIT_FORCE_DELAY_MS);
    }
  }

  if (options.preserveInstallPath) return;
  await options.beforeRemove?.();
  const replacePath = target.platform === "windows" ? paths.installRoot : paths.appPath;
  if (await removePathWithRetry(replacePath)) return;

  if (!quitPid) {
    if (managedExecutablePids.length > 0) {
      await forceQuitPidsAndConfirm(managedExecutablePids);
      if (await removePathWithRetry(replacePath, 6)) return;
    }
    throw new Error(`Failed to replace existing Rudder Desktop at ${replacePath}. Close Rudder and rerun start.`);
  }
  await forceQuitPidAndConfirm(quitPid);
  if (await removePathWithRetry(replacePath, 6)) return;

  throw new Error(`Failed to replace existing Rudder Desktop at ${replacePath}. Close Rudder and rerun start.`);
}

async function installPortableDesktop(
  installerPath: string,
  paths: DesktopInstallPaths,
  target: DesktopAssetTarget,
): Promise<void> {
  await mkdir(paths.installRoot, { recursive: true });

  if (target.platform === "linux") {
    await copyFile(installerPath, paths.appPath);
    await chmod(paths.appPath, 0o755);
    return;
  }

  const extractDir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-extract."));
  try {
    await extractZip(installerPath, extractDir, target);
    if (target.platform === "macos") {
      const appSource = await findMacApp(extractDir);
      await copyPortableAppBundle(appSource, paths.appPath);
      return;
    }

    const appSource = await findWindowsAppDir(extractDir);
    await mkdir(path.dirname(paths.installRoot), { recursive: true });
    await copyPortableAppBundle(appSource, paths.installRoot);
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

export async function copyPortableAppBundle(sourcePath: string, destinationPath: string): Promise<void> {
  if (process.platform === "win32") {
    await mkdir(destinationPath, { recursive: true });
    const command = buildWindowsRobocopyMirrorCommand(sourcePath, destinationPath);
    const result = spawnSync(command.command, command.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (isSuccessfulRobocopyExitCode(result.status)) return;
    throw new Error(formatCommandFailure(command.command, command.args, result.stdout, result.stderr));
  }

  await cp(sourcePath, destinationPath, { recursive: true, verbatimSymlinks: true });
}

async function removeMacQuarantine(paths: DesktopInstallPaths, target: DesktopAssetTarget): Promise<void> {
  if (target.platform !== "macos") return;
  const result = spawnSync("xattr", ["-dr", "com.apple.quarantine", paths.appPath], { stdio: "ignore" });
  if (result.status !== 0) {
    p.log.warn(`Could not remove macOS quarantine attributes from ${paths.appPath}.`);
  }
}

function quoteDesktopExec(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export function buildLinuxDesktopEntry(executablePath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Rudder",
    `Exec=${quoteDesktopExec(executablePath)}`,
    "Terminal=false",
    "Categories=Development;",
    "",
  ].join("\n");
}

async function writeLinuxLaunchers(paths: DesktopInstallPaths): Promise<void> {
  const desktopDir = path.join(homedir(), ".local", "share", "applications");
  await mkdir(desktopDir, { recursive: true });
  await writeFile(path.join(desktopDir, "rudder.desktop"), buildLinuxDesktopEntry(paths.executablePath), "utf8");

  const binDir = path.join(homedir(), ".local", "bin");
  await mkdir(binDir, { recursive: true });
  const wrapperPath = path.join(binDir, "rudder-desktop");
  const escaped = paths.executablePath.replaceAll("'", "'\"'\"'");
  await writeFile(wrapperPath, `#!/bin/sh\nexec '${escaped}' "$@"\n`, "utf8");
  await chmod(wrapperPath, 0o755);
}

function buildWindowsShortcutScript(executablePath: string): string {
  const appData = process.env.APPDATA?.trim() || path.join(homedir(), "AppData", "Roaming");
  const shortcutPath = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Rudder.lnk");
  return [
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut(${powershellQuote(shortcutPath)})`,
    `$shortcut.TargetPath = ${powershellQuote(executablePath)}`,
    `$shortcut.WorkingDirectory = ${powershellQuote(path.dirname(executablePath))}`,
    "$shortcut.Save()",
  ].join("; ");
}

async function createPlatformLaunchers(paths: DesktopInstallPaths, target: DesktopAssetTarget): Promise<void> {
  if (target.platform === "linux") {
    await writeLinuxLaunchers(paths);
    return;
  }
  if (target.platform === "windows") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      buildWindowsShortcutScript(paths.executablePath),
    ], { stdio: "ignore" });
    if (result.status !== 0) p.log.warn("Could not create the Windows Start Menu shortcut.");
  }
}

function launchDesktop(paths: DesktopInstallPaths, target: DesktopAssetTarget, args: string[] = []): void {
  if (target.platform === "macos") {
    spawn("open", [paths.appPath, ...(args.length > 0 ? ["--args", ...args] : [])], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (target.platform === "windows") {
    spawn("cmd.exe", ["/c", "start", "", paths.executablePath, ...args], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn(paths.executablePath, args, { detached: true, stdio: "ignore" }).unref();
}

async function writeInstallMetadataValue(
  paths: DesktopInstallPaths,
  metadata: DesktopInstallMetadata,
): Promise<void> {
  mkdirSync(path.dirname(paths.metadataPath), { recursive: true });
  mkdirSync(paths.installRoot, { recursive: true });
  const tempPath = `${paths.metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, paths.metadataPath);
}

function createInstallRecord(
  releaseTag: string,
  assetName: string,
  assetChecksum: string,
  assetKind: "full" | "shell" = "full",
): DesktopInstallRecord {
  return {
    releaseTag,
    assetName,
    assetChecksum,
    assetKind,
    installedAt: new Date().toISOString(),
  };
}

async function writeCandidateInstallMetadata(
  paths: DesktopInstallPaths,
  current: DesktopInstallRecord,
  previousMetadata: DesktopInstallMetadata | null,
): Promise<void> {
  const previous = currentInstallRecord(previousMetadata);
  await writeInstallMetadataValue(paths, previous
    ? { version: 2, current, lastKnownGood: previous, previous }
    : { version: 2, current, lastKnownGood: current });
}

export type DesktopUpdateRecoveryContext = {
  maintenanceLockPath: string;
  transactionPath: string;
  transaction: DesktopUpdateTransaction;
};

export function resolveDesktopUpdateDatabasePlan(input: {
  databaseUrl?: string | null;
  config?: { database?: { mode?: unknown; connectionString?: unknown; embeddedPostgresDataDir?: unknown } } | null;
} = {}): { mode: "embedded-postgres"; dataDir: string } | { mode: "external-postgres" } {
  const databaseUrl = input.databaseUrl === undefined ? process.env.DATABASE_URL : input.databaseUrl;
  if (databaseUrl?.trim()) return { mode: "external-postgres" };
  const resolvedConfig = input.config === undefined ? readConfig() : input.config;
  if (
    resolvedConfig?.database?.mode === "postgres"
    && typeof resolvedConfig.database.connectionString === "string"
    && resolvedConfig.database.connectionString.trim()
  ) {
    return { mode: "external-postgres" };
  }
  const configured = typeof resolvedConfig?.database?.embeddedPostgresDataDir === "string"
    ? resolvedConfig.database.embeddedPostgresDataDir.trim()
    : "";
  const dataDir = configured
    ? path.resolve(expandHomePrefix(configured))
    : resolveDefaultEmbeddedPostgresDir();
  return { mode: "embedded-postgres", dataDir };
}

export async function movePath(
  sourcePath: string,
  destinationPath: string,
  options: {
    onDestinationReady?: () => Promise<void>;
    renamePath?: (source: string, destination: string) => Promise<void>;
    copyPath?: (source: string, destination: string) => Promise<void>;
    removeSourcePath?: (source: string) => Promise<void>;
  } = {},
): Promise<void> {
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await rm(destinationPath, { recursive: true, force: true });
  const renamePath = options.renamePath ?? rename;
  const copyPath = options.copyPath ?? ((source: string, destination: string) => (
    cp(source, destination, { recursive: true, verbatimSymlinks: true })
  ));
  const removeSourcePath = options.removeSourcePath ?? ((source: string) => (
    rm(source, { recursive: true, force: true })
  ));
  try {
    await renamePath(sourcePath, destinationPath);
    await options.onDestinationReady?.();
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code !== "EXDEV") throw error;
    await copyPath(sourcePath, destinationPath);
    await options.onDestinationReady?.();
    await removeSourcePath(sourcePath);
  }
}

function createTimeoutFailure(targetVersion: string): DesktopUpdateFailureRecord {
  return {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    stage: "readiness",
    attempt: 1,
    category: "runtime",
    summary: `Rudder ${targetVersion} did not become ready before the recovery timeout.`,
  };
}

async function prepareDesktopUpdateRecovery(input: {
  opts: StartCommandOptions;
  target: DesktopAssetTarget;
  installPaths: DesktopInstallPaths;
  previousMetadata: DesktopInstallMetadata | null;
  targetVersion: string;
  maintenanceLockPath: string;
}): Promise<DesktopUpdateRecoveryContext | null> {
  const updateId = input.opts.desktopUpdateId?.trim();
  if (!updateId || input.target.platform !== "macos") return null;
  const origin = input.opts.desktopUpdateOrigin === "fresh_install" ? "fresh_install" : "upgrade";
  const fromVersion = input.opts.desktopFromVersion?.trim();
  const databasePlan = resolveDesktopUpdateDatabasePlan();
  if (databasePlan.mode === "external-postgres") {
    throw new Error(
      "Rudder cannot safely auto-recover this update because the instance uses external PostgreSQL. "
      + "Keep the current version and update after a release explicitly declares database compatibility.",
    );
  }

  const homeDir = resolveRudderHomeDir();
  const backupAppPath = origin === "upgrade" && await pathExists(input.installPaths.appPath)
    ? resolveDesktopUpdateBackupPath({
        updateId,
        installRoot: input.installPaths.installRoot,
        appName: path.basename(input.installPaths.appPath),
        homeDir,
      })
    : undefined;
  if (origin === "upgrade" && !backupAppPath) {
    throw new Error(
      "Rudder could not preserve the currently installed Desktop app, so the update was not applied.",
    );
  }
  const checkpointPath = origin === "upgrade" && databasePlan.mode === "embedded-postgres"
    ? resolveDesktopUpdateCheckpointPath({ updateId, instanceId: resolveRudderInstanceId(), homeDir })
    : undefined;
  if (
    checkpointPath
    && databasePlan.mode === "embedded-postgres"
    && !await createEmbeddedPostgresCheckpoint(databasePlan.dataDir, checkpointPath)
  ) {
    throw new Error(
      "Rudder could not create a verified pre-update PostgreSQL checkpoint, so the update was not applied.",
    );
  }
  const now = new Date().toISOString();
  const transaction: DesktopUpdateTransaction = {
    version: 1,
    updateId,
    origin,
    phase: "prepared",
    ...(fromVersion ? { fromVersion } : {}),
    targetVersion: input.targetVersion,
    createdAt: now,
    updatedAt: now,
    install: {
      appPath: input.installPaths.appPath,
      ...(backupAppPath ? { backupAppPath } : {}),
      metadataPath: input.installPaths.metadataPath,
      ...(input.previousMetadata ? { previousMetadata: input.previousMetadata } : {}),
    },
    database: checkpointPath
      ? { mode: "embedded-postgres", dataDir: databasePlan.dataDir, checkpointPath }
      : { mode: "none" },
  };
  const transactionPath = resolveDesktopUpdateTransactionPath(updateId, homeDir);
  try {
    await writeDesktopUpdateTransaction(transactionPath, transaction);
    let backupReady = transaction;
    if (backupAppPath) {
      await movePath(input.installPaths.appPath, backupAppPath, {
        onDestinationReady: async () => {
          backupReady = await updateDesktopUpdateTransaction(
            transactionPath,
            (current) => ({ ...current, phase: "backup_ready" }),
          );
        },
      });
    }
    return { maintenanceLockPath: input.maintenanceLockPath, transactionPath, transaction: backupReady };
  } catch (error) {
    let restoreError: unknown;
    const latest = await readDesktopUpdateTransaction(transactionPath);
    const appPresent = await pathExists(input.installPaths.appPath);
    const backupPresent = Boolean(backupAppPath && await pathExists(backupAppPath));
    if (backupAppPath && backupPresent && (!appPresent || latest?.phase === "backup_ready")) {
      try {
        await restorePathFromSnapshotAtomically({
          snapshotPath: backupAppPath,
          destinationPath: input.installPaths.appPath,
          operationId: `${updateId}-preparation`,
        });
      } catch (caught) {
        restoreError = caught;
      }
    }
    if (!restoreError) {
      await rm(transactionPath, { force: true }).catch(() => undefined);
      if (checkpointPath) await rm(checkpointPath, { recursive: true, force: true }).catch(() => undefined);
      if (backupAppPath) await rm(backupAppPath, { recursive: true, force: true }).catch(() => undefined);
    }
    if (restoreError) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
      throw new Error(
        `Desktop update preparation failed (${originalMessage}) and the preserved app could not be restored (${restoreMessage}).`,
      );
    }
    throw error;
  }
}

async function commitDesktopUpdateRecovery(
  context: DesktopUpdateRecoveryContext,
  installPaths: DesktopInstallPaths,
): Promise<void> {
  const committed = await withDesktopUpdateDecisionLock(context.transactionPath, async () => {
    const transaction = await readDesktopUpdateTransaction(context.transactionPath);
    if (!transaction || transaction.phase !== "candidate_ready" || transaction.failure) {
      throw new Error("The Desktop update candidate failed the final commit decision.");
    }
    const metadata = await readInstallMetadata(installPaths.metadataPath);
    const current = currentInstallRecord(metadata);
    const previous = currentInstallRecord(
      context.transaction.install.previousMetadata as DesktopInstallMetadata | null,
    );
    if (current) {
      await writeInstallMetadataValue(installPaths, {
        version: 2,
        current,
        lastKnownGood: current,
        ...(previous ? { previous } : {}),
      });
    }
    return updateDesktopUpdateTransaction(context.transactionPath, (latest) => {
      if (latest.phase !== "candidate_ready" || latest.failure) {
        throw new Error("The Desktop update candidate changed before commit.");
      }
      return {
        ...latest,
        phase: "committed",
        committedAt: new Date().toISOString(),
      };
    });
  });
  await removeDesktopUpdateRecoveryArtifacts(committed, context.transactionPath);
  await removeDesktopUpdateMaintenanceLock(context.maintenanceLockPath, context.transaction.updateId);
}

export async function rollbackDesktopUpdateRecovery(input: {
  context: DesktopUpdateRecoveryContext;
  installPaths: DesktopInstallPaths;
  target: DesktopAssetTarget;
  failure?: DesktopUpdateFailureRecord;
}): Promise<void> {
  const current = await readDesktopUpdateTransaction(input.context.transactionPath) ?? input.context.transaction;
  if (current.phase === "rolled_back" || current.phase === "committed") {
    throw new Error("This Desktop update transaction already attempted automatic recovery.");
  }
  if (!current.install.backupAppPath) {
    throw new Error("No last-known-good Desktop bundle is available for automatic recovery.");
  }
  const artifacts = await inspectDesktopUpdateRecoveryArtifacts(current);
  if (!artifacts.backupAppPresent) {
    throw new Error("The last-known-good Desktop bundle is missing or incomplete; the current app was not closed.");
  }
  if (current.database.mode !== "embedded-postgres" || !artifacts.checkpointPresent) {
    throw new Error("The pre-update PostgreSQL checkpoint is missing or incomplete; the current app was not closed.");
  }
  if (current.phase === "prepared" && artifacts.appPresent) {
    throw new Error("The Desktop replacement did not start; destructive rollback is not required.");
  }
  const failure = input.failure ?? current.failure ?? createTimeoutFailure(current.targetVersion);
  const attemptedAt = current.rollback?.attemptedAt ?? new Date().toISOString();
  await updateDesktopUpdateTransaction(input.context.transactionPath, (transaction) => ({
    ...transaction,
    phase: "rollback_pending",
    failure,
    quarantinedTarget: transaction.targetVersion,
    rollback: { attemptedAt },
  }));

  try {
    await prepareForDesktopReplace(input.installPaths, input.target, {
      forceUpdate: true,
      preserveInstallPath: true,
    });
    await restorePathFromSnapshotAtomically({
      snapshotPath: current.install.backupAppPath,
      destinationPath: input.installPaths.appPath,
      operationId: `${current.updateId}-app`,
    });
    if (current.install.previousMetadata) {
      await writeInstallMetadataValue(
        input.installPaths,
        current.install.previousMetadata as DesktopInstallMetadata,
      );
    } else {
      await rm(input.installPaths.metadataPath, { force: true });
    }
    if (
      current.database.mode === "embedded-postgres"
      && current.database.dataDir
      && current.database.checkpointPath
    ) {
      await restorePathFromSnapshotAtomically({
        snapshotPath: current.database.checkpointPath,
        destinationPath: current.database.dataDir,
        operationId: `${current.updateId}-database`,
      });
    }
    await quarantineDesktopUpdateTarget({
      targetVersion: current.targetVersion,
      failedAt: failure.occurredAt,
      failureId: failure.id,
    });
    await updateDesktopUpdateTransaction(input.context.transactionPath, (transaction) => ({
      ...transaction,
      phase: "rolled_back",
      failure,
      quarantinedTarget: transaction.targetVersion,
      database: transaction.database.mode === "embedded-postgres"
        ? { ...transaction.database, restoredAt: new Date().toISOString() }
        : transaction.database,
      rollback: { attemptedAt, completedAt: new Date().toISOString() },
    }));
    await removeDesktopUpdateMaintenanceLock(input.context.maintenanceLockPath, current.updateId);
    await removeMacQuarantine(input.installPaths, input.target);
    await createPlatformLaunchers(input.installPaths, input.target);
    launchDesktop(input.installPaths, input.target, [
      `--rudder-update-recovery=${input.context.transactionPath}`,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateDesktopUpdateTransaction(input.context.transactionPath, (transaction) => ({
      ...transaction,
      phase: "rollback_failed",
      failure,
      rollback: { attemptedAt, error: message },
    })).catch(() => undefined);
    throw error;
  }
}

async function cancelPreparedDesktopUpdateRecovery(input: {
  context: DesktopUpdateRecoveryContext;
  installPaths: DesktopInstallPaths;
  target: DesktopAssetTarget;
}): Promise<void> {
  const current = await readDesktopUpdateTransaction(input.context.transactionPath);
  if (!current || current.phase !== "prepared") {
    throw new Error("The interrupted Desktop update is no longer eligible for safe cancellation.");
  }
  const artifacts = await inspectDesktopUpdateRecoveryArtifacts(current);
  if (!artifacts.appPresent || !artifacts.checkpointPresent) {
    throw new Error("The interrupted Desktop update cannot be cancelled without a complete current app and checkpoint.");
  }

  await removeDesktopUpdateMaintenanceLock(input.context.maintenanceLockPath, current.updateId);
  const cancelled = await updateDesktopUpdateTransaction(input.context.transactionPath, (transaction) => {
    if (transaction.phase !== "prepared") {
      throw new Error("The interrupted Desktop update changed before cancellation.");
    }
    return { ...transaction, phase: "cancelled" };
  });
  await removeDesktopUpdateRecoveryArtifacts(cancelled, input.context.transactionPath);
  await prepareForDesktopReplace(input.installPaths, input.target, {
    forceUpdate: true,
    preserveInstallPath: true,
  });
  await removeMacQuarantine(input.installPaths, input.target);
  await createPlatformLaunchers(input.installPaths, input.target);
  launchDesktop(input.installPaths, input.target);
}

export async function recoverPendingDesktopUpdateCommand(input: { transactionPath: string }): Promise<void> {
  const transactionPath = resolveOwnedDesktopUpdateTransactionPath(input.transactionPath);
  if (!transactionPath) throw new Error("The Desktop update recovery transaction path is outside RUDDER_HOME.");
  const transaction = await readDesktopUpdateTransaction(transactionPath);
  if (!transaction || ![
    "prepared",
    "backup_ready",
    "candidate_installed",
    "candidate_ready",
    "rollback_pending",
    "rollback_failed",
  ].includes(transaction.phase)) {
    throw new Error("No resumable Desktop update rollback transaction was found.");
  }
  const target = resolveDesktopAssetTarget();
  if (target.platform !== "macos") {
    throw new Error("Automatic Desktop update rollback resume is currently available only on macOS.");
  }
  const installPaths = resolveDesktopInstallPaths(target, path.dirname(transaction.install.appPath));
  if (
    installPaths.appPath !== path.resolve(transaction.install.appPath)
    || installPaths.metadataPath !== path.resolve(transaction.install.metadataPath)
  ) {
    throw new Error("The Desktop update recovery install paths do not match the current platform layout.");
  }
  const artifacts = await inspectDesktopUpdateRecoveryArtifacts(transaction);
  const canCancelBeforeReplacement = transaction.phase === "prepared"
    && artifacts.appPresent
    && artifacts.checkpointPresent;
  if (canCancelBeforeReplacement) {
    await cancelPreparedDesktopUpdateRecovery({
      context: {
        maintenanceLockPath: resolveDesktopUpdateMaintenanceLockPath(resolveRudderInstanceId()),
        transactionPath,
        transaction,
      },
      installPaths,
      target,
    });
    return;
  }
  if (
    !transaction.install.backupAppPath
    || transaction.database.mode !== "embedded-postgres"
    || !transaction.database.dataDir
    || !transaction.database.checkpointPath
    || !artifacts.backupAppPresent
    || !artifacts.checkpointPresent
  ) {
    throw new Error(
      "The interrupted Desktop update does not have complete physical recovery snapshots; the current app was not closed.",
    );
  }
  await rollbackDesktopUpdateRecovery({
    context: {
      maintenanceLockPath: resolveDesktopUpdateMaintenanceLockPath(resolveRudderInstanceId()),
      transactionPath,
      transaction,
    },
    installPaths,
    target,
    ...(transaction.failure ? { failure: transaction.failure } : {}),
  });
}

async function runStartPhase<T>(
  message: string,
  successMessage: string,
  task: () => Promise<T> | T,
  progressPhase?: DesktopUpdateProgressPhase | null,
): Promise<T> {
  if (progressPhase) {
    writeDesktopProgress({ phase: progressPhase, message });
  }
  const spinner = p.spinner();
  spinner.start(message);
  try {
    const result = await task();
    spinner.stop(successMessage);
    if (progressPhase) {
      writeDesktopProgress({ phase: progressPhase, message: successMessage });
    }
    return result;
  } catch (error) {
    spinner.stop(pc.red(`${message} failed.`));
    if (progressPhase) {
      writeDesktopProgress({
        phase: "failed",
        message: `${message} failed.`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

export async function startCommand(opts: StartCommandOptions): Promise<void> {
  const installCli = opts.cli !== false;
  const serverOnly = opts.serverOnly === true;
  const installDesktop = !serverOnly && opts.desktop !== false;
  const installRuntime = opts.runtime !== false;
  const repo = opts.repo?.trim() || DEFAULT_DESKTOP_RELEASE_REPO;
  const version = opts.targetVersion?.trim() || opts.version?.trim() || resolveCurrentCliVersion();
  const dryRun = opts.dryRun === true;
  const desktopProgressJson = opts.desktopProgressJson === true;
  let runtimeSupportsShellAssets = false;

  if (desktopProgressJson) {
    process.stdout.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }

  if (!installCli && !installDesktop && !installRuntime) {
    throw new Error("Nothing to start. Remove --no-cli, --no-runtime, --no-desktop, or --server-only.");
  }

  p.intro(pc.bgCyan(pc.black(serverOnly ? " rudder start --server-only " : " rudder start ")));

  if (opts.versionCheck !== false) {
    const updateNotice = await getCliUpdateNotice(version);
    if (updateNotice) p.log.warn(updateNotice);
  }

  if (installRuntime) {
    p.log.step("Preparing Rudder runtime");
    if (dryRun) {
      p.log.message(`[dry-run] Would install or reuse ${pc.cyan(`@rudderhq/server@${version}`)} in the Rudder runtime cache.`);
    } else {
      const spinner = p.spinner();
      spinner.start("Installing or reusing Rudder runtime...");
      try {
        const runtime = await ensureRuntimeInstalled({
          version,
          preparePostgresPayload: true,
          ...(opts.desktopFromVersion?.trim()
            ? { protectedVersions: [opts.desktopFromVersion.trim()] }
            : {}),
        });
        runtimeSupportsShellAssets = runtimeSupportsDesktopShellAssets(version, runtime);
        spinner.stop(
          runtime.status === "hit"
            ? `Rudder runtime cache hit at ${pc.cyan(runtime.cacheDir)}.`
            : `Rudder runtime installed at ${pc.cyan(runtime.cacheDir)}.`,
        );
        if (!runtime.postgresPayloadBinDir && installDesktop) {
          p.log.warn("Rudder runtime cache has no PostgreSQL 18.4 payload; the full portable Desktop asset will be used.");
        }
        if (!runtimeSupportsShellAssets && installDesktop) {
          p.log.warn("Rudder runtime did not resolve to the exact Desktop version; the full portable Desktop asset will be used.");
        }
      } catch (error) {
        spinner.stop(pc.red("Rudder runtime installation failed."));
        if (error instanceof RuntimeInstallError && error.output) {
          p.log.message(pc.dim(error.output));
        }
        throw error;
      }
    }
  }

  if (installCli) {
    const installSpec = resolveCliInstallSpec(version);
    const command = `npm install --global ${installSpec}`;
    const installedVersion = getGlobalInstalledPackageVersion(CLI_NPM_PACKAGE_NAME);
    p.log.step("Preparing persistent CLI");
    if (isPersistentCliVersionCurrent(version, installedVersion)) {
      p.log.success(`${pc.cyan("rudder")} CLI ${version} is already installed.`);
    } else if (dryRun) {
      p.log.message(`[dry-run] ${command}`);
    } else {
      p.log.message(pc.dim(`Running: ${command}`));
      const spinner = p.spinner();
      spinner.start("Installing persistent CLI...");
      let result: ReturnType<typeof installPersistentCli>;
      try {
        result = installPersistentCli({ installSpec });
      } catch (error) {
        spinner.stop(pc.red("Persistent CLI installation failed."));
        throw error;
      }
      if (!result.ok) {
        spinner.stop(pc.red("Persistent CLI installation failed."));
        if (result.output) p.log.message(pc.dim(result.output));
        throw new Error(`Persistent CLI installation failed. Re-run manually: ${result.command}`);
      }
      spinner.stop(`${pc.cyan("rudder")} CLI installed.`);
    }
  }

  if (installDesktop) {
    const target = resolveDesktopAssetTarget();
    const tag = resolveDesktopReleaseTag(version);
    const installRoot = opts.desktopInstallDir
      ? path.resolve(opts.desktopInstallDir)
      : resolveDefaultDesktopInstallRoot(target);
    const installPaths = resolveDesktopInstallPaths(target, installRoot);
    const outputDir = opts.outputDir
      ? path.resolve(opts.outputDir)
      : await mkdtemp(path.join(tmpdir(), "rudder-desktop-installer."));

    p.log.step("Installing desktop app");
    p.log.message(`Release: ${pc.cyan(`${repo}@${tag}`)}`);
    p.log.message(`Target: ${pc.cyan(`${target.platform}/${target.arch}`)}`);
    p.log.message(`Install: ${pc.cyan(installPaths.appPath)}`);

    if (dryRun) {
      p.log.message(`[dry-run] Would resolve, download, verify, install, and ${opts.open === false ? "not launch" : "launch"} Rudder Desktop.`);
      p.outro(pc.green("Dry run complete."));
      return;
    }

    await withDesktopInstallLock(installPaths, async () => {
      const directReleaseVersion = resolveDesktopReleaseVersion(tag);
      const progressFactory: ProgressReporterFactory = desktopProgressJson
        ? createDesktopProgressFactory()
        : createByteProgress;
      let release: GithubRelease | null = null;
      try {
        release = await runStartPhase(
          "Resolving Desktop release...",
          "Desktop release resolved.",
          () => fetchGithubRelease(repo, tag),
          desktopProgressJson ? "resolving_release" : null,
        );
      } catch (error) {
        if (!directReleaseVersion) throw error;
        p.log.warn(
          `Desktop release metadata could not be resolved; falling back to deterministic download URLs. ${formatFetchError(error)}`,
        );
      }

      const releaseTag = release?.tag_name ?? (directReleaseVersion ? tag : null);
      if (!releaseTag) {
        throw new Error(`Unable to resolve Rudder Desktop release tag for ${repo}@${tag}.`);
      }

      const assetCandidates = resolveDesktopAssetCandidates({
        releaseAssets: release?.assets ?? [],
        target,
        repo,
        tag,
        directReleaseVersion,
        allowShellAssets: runtimeSupportsShellAssets,
      });
      if (assetCandidates.length === 0) {
        throw new Error(`No Rudder Desktop portable asset found for ${target.platform}/${target.arch} in ${repo}@${releaseTag}.`);
      }

      const checksumAsset = selectChecksumAsset(release?.assets ?? [])
        ?? (
          directReleaseVersion
            ? buildGithubReleaseAsset(repo, tag, DESKTOP_CHECKSUM_ASSET_NAME)
            : null
        );
      const checksums = await downloadChecksums(checksumAsset, outputDir, progressFactory);
      let selectedCandidate: ChecksummedDesktopAssetCandidate;
      try {
        selectedCandidate = selectChecksummedDesktopAssetCandidate(assetCandidates, checksums);
      } catch (error) {
        throw new Error(`No checksummed Rudder Desktop asset found for ${target.platform}/${target.arch} in ${repo}@${releaseTag}.`);
      }
      for (const warning of selectedCandidate.warnings) p.log.warn(warning);
      let selectedAsset = selectedCandidate.asset;
      let selectedAssetKind = selectedCandidate.kind;
      let expectedChecksum = selectedCandidate.expectedChecksum;

      const metadata = await readInstallMetadata(installPaths.metadataPath);
      const previousInstall = currentInstallRecord(metadata);
      const recoveryState: {
        context: DesktopUpdateRecoveryContext | null;
        maintenanceLockPath: string | null;
      } = { context: null, maintenanceLockPath: null };
      if (target.platform === "macos" && opts.desktopUpdateId?.trim()) {
        const databasePlan = resolveDesktopUpdateDatabasePlan();
        if (databasePlan.mode === "external-postgres") {
          throw new Error(
            "Rudder cannot safely auto-recover this update because the instance uses external PostgreSQL. "
            + "Keep the current version and update after a release explicitly declares database compatibility.",
          );
        }
        if (
          opts.desktopUpdateOrigin === "fresh_install"
          && databasePlan.mode === "embedded-postgres"
          && await pathExists(path.join(databasePlan.dataDir, "PG_VERSION"))
        ) {
          throw new Error(
            "Rudder cannot install an older release automatically because this instance already has initialized database data.",
          );
        }
      }
      if (
        isInstalledDesktopCurrent(metadata, releaseTag, selectedAsset.name, expectedChecksum) &&
        await pathExists(installPaths.executablePath)
      ) {
        p.log.success(`Rudder Desktop is already installed at ${pc.cyan(installPaths.appPath)}.`);
        await runStartPhase(
          "Refreshing Desktop launchers...",
          "Desktop launchers ready.",
          async () => {
            await removeMacQuarantine(installPaths, target);
            await createPlatformLaunchers(installPaths, target);
          },
          desktopProgressJson ? "preparing_restart" : null,
        );
      } else {
        let cachedAsset: Awaited<ReturnType<typeof downloadDesktopAssetWithCache>>;
        try {
          cachedAsset = await downloadDesktopAssetWithCache(selectedAsset, expectedChecksum, {
            outputDir,
            progressFactory,
          });
        } catch (error) {
          const fullCandidate = assetCandidates.find((candidate) => candidate.kind === "full");
          if (selectedAssetKind !== "shell" || !fullCandidate) throw error;
          p.log.warn(
            `Layered Desktop shell asset download failed; falling back to the full portable asset. ${formatFetchError(error)}`,
          );
          selectedAsset = fullCandidate.asset;
          selectedAssetKind = fullCandidate.kind;
          expectedChecksum = resolveAssetChecksum(checksums, selectedAsset.name);
          cachedAsset = await downloadDesktopAssetWithCache(selectedAsset, expectedChecksum, {
            outputDir,
            progressFactory,
          });
        }
        if (cachedAsset.cacheStatus === "hit") {
          p.log.success(`Desktop asset cache hit at ${pc.cyan(cachedAsset.path)}.`);
          if (desktopProgressJson) {
            writeDesktopProgress({
              phase: "downloading_asset",
              message: `Desktop asset cache hit for ${selectedAsset.name}.`,
              percent: 100,
            });
          }
        }
        const checksum = await runStartPhase(
          "Verifying Desktop checksum...",
          `Verified ${pc.cyan(path.basename(cachedAsset.path))}.`,
          () => assertChecksumMatch(cachedAsset.path, expectedChecksum),
          desktopProgressJson ? "verifying_checksum" : null,
        );

        let applySignal: { force: boolean } | null = null;
        let applySignalController: ReturnType<typeof createDesktopApplySignalController> | null = null;
        if (desktopProgressJson && opts.desktopWaitForApply === true) {
          writeDesktopProgress({
            phase: "ready_to_install",
            message: "Desktop update is downloaded and verified.",
            percent: 100,
          });
          applySignalController = createDesktopApplySignalController();
          applySignal = await applySignalController.waitForInitialSignal();
          writeDesktopProgress({
            phase: "preparing_restart",
            message: applySignal.force
              ? "Applying Desktop update and quitting active runs..."
              : "Applying Desktop update...",
          });
        }

        if (target.platform === "macos" && opts.desktopUpdateId?.trim()) {
          recoveryState.maintenanceLockPath = await createDesktopUpdateMaintenanceLock({
            updateId: opts.desktopUpdateId.trim(),
            targetVersion: version,
            instanceId: resolveRudderInstanceId(),
          });
        }

        try {
          try {
            await runStartPhase(
              "Replacing existing Rudder Desktop if needed...",
              "Existing Desktop install is ready for replacement.",
              () => prepareForDesktopReplace(installPaths, target, {
                waitForActiveRuns: opts.waitForActiveRuns === true,
                forceUpdate: applySignal?.force === true,
                waitForForceUpdate: applySignalController?.waitForForceRequest,
                onActiveRunsWaiting: desktopProgressJson
                  ? (totalRuns) => writeDesktopProgress({
                    phase: "waiting_for_active_runs",
                    message: `Waiting for ${totalRuns} running agent run${totalRuns === 1 ? "" : "s"} before replacing Desktop.`,
                    totalRuns,
                  })
                  : undefined,
                beforeRemove: async () => {
                  recoveryState.context = await prepareDesktopUpdateRecovery({
                    opts,
                    target,
                    installPaths,
                    maintenanceLockPath: recoveryState.maintenanceLockPath!,
                    previousMetadata: metadata,
                    targetVersion: version,
                  });
                },
              }),
              desktopProgressJson ? (opts.waitForActiveRuns === true ? "waiting_for_active_runs" : "preparing_restart") : null,
            );
          } finally {
            applySignalController?.close();
          }
          await runStartPhase(
            "Installing portable Desktop app...",
            `Installed Rudder Desktop to ${pc.cyan(installPaths.appPath)}.`,
            () => installPortableDesktop(cachedAsset.path, installPaths, target),
            desktopProgressJson ? "preparing_restart" : null,
          );
          await runStartPhase(
            "Preparing Desktop launchers...",
            "Desktop launchers ready.",
            async () => {
              await removeMacQuarantine(installPaths, target);
              await createPlatformLaunchers(installPaths, target);
            },
            desktopProgressJson ? "preparing_restart" : null,
          );
          const candidateRecord = createInstallRecord(
            releaseTag,
            selectedAsset.name,
            checksum,
            selectedAssetKind,
          );
          await writeCandidateInstallMetadata(installPaths, candidateRecord, metadata);
          if (recoveryState.context) {
            recoveryState.context.transaction = await updateDesktopUpdateTransaction(
              recoveryState.context.transactionPath,
              (transaction) => ({ ...transaction, phase: "candidate_installed" }),
            );
          }
        } catch (error) {
          const updateId = opts.desktopUpdateId?.trim();
          const preserveMaintenanceLock = Boolean(
            !recoveryState.context
            && updateId
            && await hasResumableDesktopUpdateRecoveryTransaction(updateId),
          );
          if (recoveryState.context?.transaction.install.backupAppPath) {
            await rollbackDesktopUpdateRecovery({
              context: recoveryState.context,
              installPaths,
              target,
              failure: {
                id: randomUUID(),
                occurredAt: new Date().toISOString(),
                stage: "install",
                attempt: 1,
                category: "runtime",
                summary: "The new Rudder Desktop package could not be installed completely.",
              },
            });
          } else if (preserveMaintenanceLock) {
            p.log.warn(
              "Desktop update recovery remains pending; preserving the instance maintenance lock and recovery snapshots.",
            );
          } else if (updateId && await pathExists(installPaths.executablePath)) {
            if (recoveryState.maintenanceLockPath) {
              await removeDesktopUpdateMaintenanceLock(
                recoveryState.maintenanceLockPath,
                updateId,
              );
            }
            launchDesktop(installPaths, target);
          } else if (recoveryState.maintenanceLockPath && updateId) {
            await removeDesktopUpdateMaintenanceLock(
              recoveryState.maintenanceLockPath,
              updateId,
            );
          }
          throw error;
        }
      }

      const desktopAssetPrune = await maybePruneDesktopAssetCache({
        protectedChecksums: [expectedChecksum, previousInstall?.assetChecksum].filter(Boolean) as string[],
      });
      if (desktopAssetPrune) {
        if (desktopAssetPrune.deleted.length > 0) {
          p.log.success(
            `Pruned ${desktopAssetPrune.deleted.length} old Desktop asset cache(s), freed ${formatBytes(desktopAssetPrune.freedBytes)}.`,
          );
        }
        for (const warning of desktopAssetPrune.warnings) p.log.warn(warning);
      }

      if (opts.open !== false) {
        await runStartPhase(
          "Launching Rudder Desktop...",
          "Rudder Desktop launched.",
          () => launchDesktop(
            installPaths,
            target,
            recoveryState.context ? [`--rudder-update-transaction=${recoveryState.context.transactionPath}`] : [],
          ),
          desktopProgressJson ? "closing" : null,
        );
        if (recoveryState.context) {
          const outcome = await waitForDesktopUpdateCandidate(recoveryState.context.transactionPath, {
            ...(opts.desktopUpdateReadyTimeoutMs
              ? { timeoutMs: Math.max(1_000, opts.desktopUpdateReadyTimeoutMs) }
              : {}),
          });
          const candidateStable = outcome.status === "ready"
            ? await waitForDesktopUpdateCandidateStability(recoveryState.context.transactionPath)
            : false;
          if (outcome.status === "ready" && candidateStable) {
            try {
              await commitDesktopUpdateRecovery(recoveryState.context, installPaths);
            } catch (error) {
              const latest = await readDesktopUpdateTransaction(recoveryState.context.transactionPath);
              if (recoveryState.context.transaction.install.backupAppPath) {
                await rollbackDesktopUpdateRecovery({
                  context: recoveryState.context,
                  installPaths,
                  target,
                  ...(latest?.failure ? { failure: latest.failure } : {}),
                });
              } else {
                await removeDesktopUpdateMaintenanceLock(
                  recoveryState.context.maintenanceLockPath,
                  recoveryState.context.transaction.updateId,
                );
              }
              throw error;
            }
          } else if (recoveryState.context.transaction.install.backupAppPath) {
            await rollbackDesktopUpdateRecovery({
              context: recoveryState.context,
              installPaths,
              target,
              ...(outcome.transaction?.failure ? { failure: outcome.transaction.failure } : {}),
            });
            throw new Error(
              outcome.status === "timeout"
                ? `Rudder ${version} did not become ready; the last working version was restored.`
                : `Rudder ${version} failed to start; the last working version was restored.`,
            );
          } else {
            await removeDesktopUpdateMaintenanceLock(
              recoveryState.context.maintenanceLockPath,
              recoveryState.context.transaction.updateId,
            );
            throw new Error(
              outcome.status === "timeout"
                ? `Rudder ${version} did not become ready after the fallback install.`
                : `Rudder ${version} failed to start after the fallback install.`,
            );
          }
        }
      }
    });
  } else if (serverOnly) {
    p.log.step("Server-only install");
    p.log.message("Desktop app installation was skipped. Start the server with `rudder run` and open the printed local URL in a browser.");
  }

  p.outro(pc.green("Rudder start complete."));
}
