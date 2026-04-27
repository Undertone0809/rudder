import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { access, chmod, copyFile, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  CLI_NPM_PACKAGE_NAME,
  getGlobalInstalledPackageVersion,
  installPersistentCli,
  resolvePersistentCliInstallSpec,
} from "../install.js";

export const DEFAULT_DESKTOP_RELEASE_REPO = "Undertone0809/rudder";
export const DESKTOP_UPDATE_QUIT_ARG = "--rudder-update-quit";

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
  desktopInstallDir?: string;
  open?: boolean;
  dryRun?: boolean;
  versionCheck?: boolean;
}

export interface DesktopInstallMetadata {
  version: 1;
  releaseTag: string;
  assetName: string;
  assetChecksum: string;
  installedAt: string;
}

type UpdateQuitResponse =
  | { ok: true; status: "quitting" | "not_running" }
  | { ok: false; status: "active_runs"; totalRuns: number }
  | { ok: false; status: "failed"; message: string };

const STABLE_SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const CANARY_SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+-canary\.[0-9]+$/;
const CLI_REGISTRY_LATEST_URL = "https://registry.npmjs.org/@rudderhq%2fcli/latest";
const DESKTOP_APP_NAME = "Rudder";
const DESKTOP_METADATA_FILE = ".rudder-desktop-install.json";
const DESKTOP_CHECKSUM_ASSET_NAME = "SHASUMS256.txt";

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

export function selectChecksumAsset(assets: GithubReleaseAsset[]): GithubReleaseAsset | null {
  return assets.find((asset) => asset.name.toLowerCase() === DESKTOP_CHECKSUM_ASSET_NAME.toLowerCase()) ?? null;
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

async function downloadAsset(asset: GithubReleaseAsset, outputDir: string): Promise<string> {
  mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, path.basename(asset.name));
  const response = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "rudder-cli-installer" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${asset.name} from ${asset.browser_download_url} (${response.status}).`);
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

async function downloadChecksums(checksumAsset: GithubReleaseAsset | null, outputDir: string): Promise<Map<string, string>> {
  if (!checksumAsset) {
    throw new Error("Desktop release is missing SHASUMS256.txt.");
  }
  const checksumPath = await downloadAsset(checksumAsset, outputDir);
  return parseChecksumFile(readFileSync(checksumPath, "utf8"));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
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

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function extractZip(zipPath: string, outputDir: string, target: DesktopAssetTarget): Promise<void> {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  if (target.platform === "macos") {
    runChecked("ditto", ["-x", "-k", zipPath, outputDir]);
    return;
  }

  if (target.platform === "windows") {
    runChecked("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath ${powershellQuote(zipPath)} -DestinationPath ${powershellQuote(outputDir)} -Force`,
    ]);
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
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isInstalledDesktopCurrent(
  metadata: DesktopInstallMetadata | null,
  releaseTag: string,
  assetName: string,
  assetChecksum: string,
): boolean {
  return Boolean(
    metadata &&
    metadata.releaseTag === releaseTag &&
    metadata.assetName === assetName &&
    metadata.assetChecksum === assetChecksum,
  );
}

export function buildForceQuitCommand(target: DesktopAssetTarget): { command: string; args: string[] } {
  if (target.platform === "windows") return { command: "taskkill.exe", args: ["/IM", `${DESKTOP_APP_NAME}.exe`, "/T", "/F"] };
  return { command: "pkill", args: ["-x", DESKTOP_APP_NAME] };
}

function forceQuitDesktopProcesses(target: DesktopAssetTarget): void {
  const command = buildForceQuitCommand(target);
  spawnSync(command.command, command.args, { stdio: "ignore" });
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

async function requestDesktopQuit(executablePath: string, target: DesktopAssetTarget): Promise<UpdateQuitResponse | null> {
  if (!(await pathExists(executablePath))) return { ok: true, status: "not_running" };
  const responsePath = path.join(tmpdir(), `rudder-update-quit-${process.pid}-${Date.now()}.json`);
  const result = spawnSync(executablePath, [`${DESKTOP_UPDATE_QUIT_ARG}=${responsePath}`], {
    stdio: "ignore",
    timeout: 5_000,
  });
  if (result.error && target.platform === "windows") {
    return null;
  }

  try {
    return await waitForUpdateQuitResponse(responsePath);
  } finally {
    await rm(responsePath, { force: true });
  }
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

async function prepareForDesktopReplace(paths: DesktopInstallPaths, target: DesktopAssetTarget): Promise<void> {
  const hasManagedExecutable = await pathExists(paths.executablePath);
  if (hasManagedExecutable) {
    const quitResponse = await requestDesktopQuit(paths.executablePath, target);
    if (quitResponse && !quitResponse.ok && quitResponse.status === "active_runs") {
      throw new Error(
        `Rudder Desktop has ${quitResponse.totalRuns} active run${quitResponse.totalRuns === 1 ? "" : "s"}. Stop active work, then rerun start.`,
      );
    }
    await delay(1_000);
  } else if (!isRunningInsideDesktopExecutable()) {
    forceQuitDesktopProcesses(target);
  }

  const replacePath = target.platform === "windows" ? paths.installRoot : paths.appPath;
  if (await removePathWithRetry(replacePath)) return;

  forceQuitDesktopProcesses(target);
  await delay(1_000);
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

function launchDesktop(paths: DesktopInstallPaths, target: DesktopAssetTarget): void {
  if (target.platform === "macos") {
    spawn("open", [paths.appPath], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (target.platform === "windows") {
    spawn("cmd.exe", ["/c", "start", "", paths.executablePath], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn(paths.executablePath, [], { detached: true, stdio: "ignore" }).unref();
}

async function writeInstallMetadata(
  paths: DesktopInstallPaths,
  releaseTag: string,
  assetName: string,
  assetChecksum: string,
): Promise<void> {
  mkdirSync(path.dirname(paths.metadataPath), { recursive: true });
  const metadata: DesktopInstallMetadata = {
    version: 1,
    releaseTag,
    assetName,
    assetChecksum,
    installedAt: new Date().toISOString(),
  };
  mkdirSync(paths.installRoot, { recursive: true });
  await writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
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
    const installedVersion = getGlobalInstalledPackageVersion(CLI_NPM_PACKAGE_NAME);
    p.log.step("Preparing persistent CLI");
    if (isPersistentCliVersionCurrent(version, installedVersion)) {
      p.log.success(`${pc.cyan("rudder")} CLI ${version} is already installed.`);
    } else if (dryRun) {
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

    const directReleaseVersion = resolveDesktopReleaseVersion(tag);
    const release = directReleaseVersion ? null : await fetchGithubRelease(repo, tag);
    const releaseTag = directReleaseVersion ? tag : release?.tag_name;
    if (!releaseTag) {
      throw new Error(`Unable to resolve Rudder Desktop release tag for ${repo}@${tag}.`);
    }

    const asset = directReleaseVersion
      ? buildGithubReleaseAsset(repo, tag, resolveDesktopAssetName(directReleaseVersion, target))
      : selectDesktopAsset(release?.assets ?? [], target);
    if (!asset) {
      throw new Error(`No Rudder Desktop portable asset found for ${target.platform}/${target.arch} in ${repo}@${releaseTag}.`);
    }

    const checksumAsset = directReleaseVersion
      ? buildGithubReleaseAsset(repo, tag, DESKTOP_CHECKSUM_ASSET_NAME)
      : selectChecksumAsset(release?.assets ?? []);
    const checksums = await downloadChecksums(checksumAsset, outputDir);
    const expectedChecksum = resolveAssetChecksum(checksums, asset.name);

    const metadata = await readInstallMetadata(installPaths.metadataPath);
    if (
      isInstalledDesktopCurrent(metadata, releaseTag, asset.name, expectedChecksum) &&
      await pathExists(installPaths.executablePath)
    ) {
      p.log.success(`Rudder Desktop is already installed at ${pc.cyan(installPaths.appPath)}.`);
      await removeMacQuarantine(installPaths, target);
      await createPlatformLaunchers(installPaths, target);
    } else {
      const installerPath = await downloadAsset(asset, outputDir);
      const checksum = assertChecksumMatch(installerPath, expectedChecksum);
      p.log.success(`Downloaded and verified ${pc.cyan(path.basename(installerPath))}`);

      p.log.message("Replacing existing Rudder Desktop if needed.");
      await prepareForDesktopReplace(installPaths, target);
      await installPortableDesktop(installerPath, installPaths, target);
      await removeMacQuarantine(installPaths, target);
      await createPlatformLaunchers(installPaths, target);
      await writeInstallMetadata(installPaths, releaseTag, asset.name, checksum);
      p.log.success(`Installed Rudder Desktop to ${pc.cyan(installPaths.appPath)}.`);
    }

    if (opts.open !== false) {
      launchDesktop(installPaths, target);
      p.log.success("Rudder Desktop launched.");
    }
  }

  p.outro(pc.green("Rudder start complete."));
}
