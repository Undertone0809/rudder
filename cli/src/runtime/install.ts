import { spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveRudderHomeDir } from "../config/home.js";

export const RUNTIME_NPM_PACKAGE_NAME = "@rudderhq/server";
export const RUNTIME_METADATA_FILE = "runtime.json";
export const DEFAULT_RUNTIME_CACHE_MAX_ENTRIES = 5;
export const DEFAULT_RUNTIME_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_RUNTIME_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_RUNTIME_CACHE_KEEP_PREVIOUS = 1;
const RUNTIME_NPM_INSTALL_FLAGS = ["--omit=dev", "--include=optional", "--no-audit", "--no-fund"];

export interface RuntimeInstallMetadata {
  version: 1;
  packageName: string;
  packageVersion: string;
  installedAt: string;
  lastUsedAt?: string;
}

export interface RuntimeInstallResult {
  status: "hit" | "installed";
  cacheDir: string;
  packageSpec: string;
  command: string;
  output: string;
  prune?: RuntimeCachePruneResult;
}

export interface EnsureRuntimeInstalledOptions {
  version: string;
  homeDir?: string;
  packageName?: string;
  spawnSyncImpl?: typeof spawnSync;
  pruneRuntimeCache?: boolean;
  retention?: RuntimeCacheRetentionOptions;
}

export interface RuntimeCacheRetentionOptions {
  now?: Date;
  requestedVersion?: string;
  protectedVersions?: string[];
  maxEntries?: number;
  maxAgeMs?: number;
  maxTotalBytes?: number;
  keepPreviousEntries?: number;
}

export interface RuntimeCachePruneEntry {
  cacheDir: string;
  packageVersion: string;
  sizeBytes: number;
}

export interface RuntimeCachePruneResult {
  scanned: number;
  deleted: RuntimeCachePruneEntry[];
  protectedVersions: string[];
  freedBytes: number;
  warnings: string[];
}

export class RuntimeInstallError extends Error {
  readonly cacheDir: string;
  readonly command: string;
  readonly output: string;

  constructor(message: string, options: { cacheDir: string; command: string; output?: string }) {
    super(message);
    this.name = "RuntimeInstallError";
    this.cacheDir = options.cacheDir;
    this.command = options.command;
    this.output = options.output ?? "";
  }
}

type SpawnSyncResultLike = ReturnType<typeof spawnSync>;

function sanitizeRuntimeCacheSegment(value: string): string {
  return encodeURIComponent(value.trim() || "latest").replaceAll("%", "_");
}

export function resolveRuntimePackageVersion(version: string): string {
  const normalized = version.trim();
  return normalized.length > 0 ? normalized : "latest";
}

export function resolveRuntimeCacheDir(
  version: string,
  homeDir: string = resolveRudderHomeDir(),
): string {
  return path.join(homeDir, "runtimes", sanitizeRuntimeCacheSegment(resolveRuntimePackageVersion(version)));
}

export function resolveRuntimePackageSpec(
  version: string,
  packageName: string = RUNTIME_NPM_PACKAGE_NAME,
): string {
  const packageVersion = resolveRuntimePackageVersion(version);
  return packageVersion === "latest" ? `${packageName}@latest` : `${packageName}@${packageVersion}`;
}

export async function readRuntimeInstallMetadata(
  cacheDir: string,
): Promise<RuntimeInstallMetadata | null> {
  try {
    const raw = await readFile(path.join(cacheDir, RUNTIME_METADATA_FILE), "utf8");
    const parsed = JSON.parse(raw) as RuntimeInstallMetadata;
    if (parsed.version !== 1) return null;
    if (typeof parsed.packageName !== "string" || typeof parsed.packageVersion !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeRuntimeInstallMetadata(cacheDir: string, metadata: RuntimeInstallMetadata): Promise<void> {
  await writeFile(path.join(cacheDir, RUNTIME_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function touchRuntimeInstallMetadata(cacheDir: string): Promise<void> {
  try {
    const metadata = await readRuntimeInstallMetadata(cacheDir);
    if (!metadata) return;
    await writeRuntimeInstallMetadata(cacheDir, {
      ...metadata,
      lastUsedAt: new Date().toISOString(),
    });
  } catch {
    // Cache recency should not make an otherwise valid runtime unusable.
  }
}

export async function isRuntimeCacheHit(options: {
  cacheDir: string;
  version: string;
  packageName?: string;
}): Promise<boolean> {
  const packageName = options.packageName ?? RUNTIME_NPM_PACKAGE_NAME;
  const packageVersion = resolveRuntimePackageVersion(options.version);
  const metadata = await readRuntimeInstallMetadata(options.cacheDir);
  if (!metadata || metadata.packageName !== packageName || metadata.packageVersion !== packageVersion) {
    return false;
  }

  try {
    const packageJsonPath = path.join(options.cacheDir, "node_modules", ...packageName.split("/"), "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: string };
    return packageVersion === "latest" || packageJson.version === packageVersion;
  } catch {
    return false;
  }
}

export async function ensureRuntimeInstalled(
  options: EnsureRuntimeInstalledOptions,
): Promise<RuntimeInstallResult> {
  const packageName = options.packageName ?? RUNTIME_NPM_PACKAGE_NAME;
  const packageVersion = resolveRuntimePackageVersion(options.version);
  const cacheDir = resolveRuntimeCacheDir(packageVersion, options.homeDir);
  const packageSpec = resolveRuntimePackageSpec(packageVersion, packageName);
  const command = formatRuntimeInstallCommand(cacheDir, packageSpec);

  if (await isRuntimeCacheHit({ cacheDir, version: packageVersion, packageName })) {
    await touchRuntimeInstallMetadata(cacheDir);
    const prune = await maybePruneRuntimeCache({
      homeDir: options.homeDir,
      requestedVersion: packageVersion,
      enabled: options.pruneRuntimeCache !== false,
      retention: options.retention,
    });
    return { status: "hit", cacheDir, packageSpec, command, output: "", ...(prune ? { prune } : {}) };
  }

  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`, "utf8");

  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = runNpmRuntimeInstall(spawnSyncImpl, cacheDir, packageSpec);
  const output = collectSpawnOutput(result);

  if (result.status !== 0 && packageVersion !== "latest" && isVersionNotFoundError(output)) {
    const fallbackVersion = "latest";
    const fallbackCacheDir = resolveRuntimeCacheDir(fallbackVersion, options.homeDir);
    const fallbackSpec = resolveRuntimePackageSpec(fallbackVersion, packageName);

    if (await isRuntimeCacheHit({ cacheDir: fallbackCacheDir, version: fallbackVersion, packageName })) {
      await touchRuntimeInstallMetadata(fallbackCacheDir);
      return {
        status: "hit",
        cacheDir: fallbackCacheDir,
        packageSpec: fallbackSpec,
        command: formatRuntimeInstallCommand(fallbackCacheDir, fallbackSpec),
        output: "",
      };
    }

    await mkdir(fallbackCacheDir, { recursive: true });
    await writeFile(path.join(fallbackCacheDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`, "utf8");

    const fallbackResult = runNpmRuntimeInstall(spawnSyncImpl, fallbackCacheDir, fallbackSpec);
    const fallbackOutput = collectSpawnOutput(fallbackResult);
    if (fallbackResult.status === 0) {
      const fallbackMetadata: RuntimeInstallMetadata = {
        version: 1,
        packageName,
        packageVersion: fallbackVersion,
        installedAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      };
      await writeRuntimeInstallMetadata(fallbackCacheDir, fallbackMetadata);
      return {
        status: "installed",
        cacheDir: fallbackCacheDir,
        packageSpec: fallbackSpec,
        command: formatRuntimeInstallCommand(fallbackCacheDir, fallbackSpec),
        output: fallbackOutput,
      };
    }
  }

  if (result.status !== 0) {
    throw new RuntimeInstallError(
      `Rudder runtime installation failed. Re-run manually: ${command}`,
      { cacheDir, command, output },
    );
  }

  const metadata: RuntimeInstallMetadata = {
    version: 1,
    packageName,
    packageVersion,
    installedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  await writeRuntimeInstallMetadata(cacheDir, metadata);

  const prune = await maybePruneRuntimeCache({
    homeDir: options.homeDir,
    requestedVersion: packageVersion,
    enabled: options.pruneRuntimeCache !== false,
    retention: options.retention,
  });
  return { status: "installed", cacheDir, packageSpec, command, output, ...(prune ? { prune } : {}) };
}

export function resolveRuntimeServerEntrypoint(cacheDir: string, packageName = RUNTIME_NPM_PACKAGE_NAME): string {
  return createRequire(path.join(cacheDir, "package.json")).resolve(packageName);
}

export async function importRuntimeServerModule(cacheDir: string, packageName = RUNTIME_NPM_PACKAGE_NAME): Promise<unknown> {
  const entrypoint = resolveRuntimeServerEntrypoint(cacheDir, packageName);
  return await import(pathToFileURL(entrypoint).href);
}

function runNpmRuntimeInstall(
  spawnSyncImpl: typeof spawnSync,
  cacheDir: string,
  packageSpec: string,
): SpawnSyncResultLike {
  return spawnSyncImpl(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--prefix", cacheDir, ...RUNTIME_NPM_INSTALL_FLAGS, packageSpec],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(process.platform === "win32" ? { shell: true, windowsHide: true } : {}),
    },
  );
}

function formatRuntimeInstallCommand(cacheDir: string, packageSpec: string): string {
  return `npm install --prefix ${cacheDir} ${RUNTIME_NPM_INSTALL_FLAGS.join(" ")} ${packageSpec}`;
}

function collectSpawnOutput(result: SpawnSyncResultLike): string {
  return [result.stdout, result.stderr, result.error instanceof Error ? result.error.message : null]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
}

function isVersionNotFoundError(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("enoent") ||
    normalized.includes("etarget") ||
    normalized.includes("no matching version found")
  );
}

interface RuntimeCacheEntry {
  cacheDir: string;
  packageVersion: string;
  installedAtMs: number;
  lastUsedAtMs: number;
  sizeBytes: number;
}

async function maybePruneRuntimeCache(options: {
  homeDir: string | undefined;
  requestedVersion: string;
  enabled: boolean;
  retention: RuntimeCacheRetentionOptions | undefined;
}): Promise<RuntimeCachePruneResult | null> {
  if (!options.enabled) return null;
  return pruneRuntimeCache({
    ...options.retention,
    homeDir: options.homeDir,
    requestedVersion: options.retention?.requestedVersion ?? options.requestedVersion,
  });
}

export async function pruneRuntimeCache(
  options: RuntimeCacheRetentionOptions & { homeDir?: string } = {},
): Promise<RuntimeCachePruneResult> {
  const homeDir = options.homeDir ?? resolveRudderHomeDir();
  const now = options.now ?? new Date();
  const entries = await scanRuntimeCacheEntries(homeDir);
  const activeVersions = await readActiveRuntimeVersions(homeDir);
  const protectedVersions = resolveProtectedRuntimeVersions(entries, {
    requestedVersion: options.requestedVersion,
    protectedVersions: [...(options.protectedVersions ?? []), ...activeVersions],
    keepPreviousEntries: options.keepPreviousEntries ?? DEFAULT_RUNTIME_CACHE_KEEP_PREVIOUS,
  });
  const protectedSet = new Set(protectedVersions);
  const maxEntries = options.maxEntries ?? DEFAULT_RUNTIME_CACHE_MAX_ENTRIES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_RUNTIME_CACHE_MAX_AGE_MS;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_RUNTIME_CACHE_MAX_BYTES;
  const deletions = planRuntimeCacheDeletions(entries, {
    nowMs: now.getTime(),
    protectedVersions: protectedSet,
    maxEntries,
    maxAgeMs,
    maxTotalBytes,
  });
  const deleted: RuntimeCachePruneEntry[] = [];
  const warnings: string[] = [];

  for (const entry of deletions) {
    try {
      await rm(entry.cacheDir, { recursive: true, force: true });
      deleted.push({
        cacheDir: entry.cacheDir,
        packageVersion: entry.packageVersion,
        sizeBytes: entry.sizeBytes,
      });
    } catch (error) {
      warnings.push(
        `Failed to remove runtime cache ${entry.cacheDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    scanned: entries.length,
    deleted,
    protectedVersions,
    freedBytes: deleted.reduce((total, entry) => total + entry.sizeBytes, 0),
    warnings,
  };
}

async function scanRuntimeCacheEntries(homeDir: string): Promise<RuntimeCacheEntry[]> {
  const runtimesDir = path.join(homeDir, "runtimes");
  const dirents = await readdir(runtimesDir, { withFileTypes: true }).catch(() => null);
  if (!dirents) return [];

  const entries: RuntimeCacheEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const cacheDir = path.join(runtimesDir, dirent.name);
    const metadata = await readRuntimeInstallMetadata(cacheDir);
    if (!metadata) continue;
    const fallbackStat = await safeStat(cacheDir);
    const installedAtMs = parseTimestampMs(metadata.installedAt) ?? Number(fallbackStat?.mtimeMs ?? 0);
    const lastUsedAtMs = parseTimestampMs(metadata.lastUsedAt) ?? installedAtMs;
    entries.push({
      cacheDir,
      packageVersion: metadata.packageVersion,
      installedAtMs,
      lastUsedAtMs,
      sizeBytes: await directorySizeBytes(cacheDir),
    });
  }
  return entries;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function safeStat(targetPath: string): Promise<Stats | null> {
  try {
    return await stat(targetPath);
  } catch {
    return null;
  }
}

async function directorySizeBytes(targetPath: string): Promise<number> {
  const dirents = await readdir(targetPath, { withFileTypes: true }).catch(() => null);
  if (!dirents) return 0;

  let total = 0;
  for (const dirent of dirents) {
    const entryPath = path.join(targetPath, dirent.name);
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      total += await directorySizeBytes(entryPath);
      continue;
    }
    const entryStat = await safeStat(entryPath);
    total += Number(entryStat?.size ?? 0);
  }
  return total;
}

async function readActiveRuntimeVersions(homeDir: string): Promise<string[]> {
  const instancesDir = path.join(homeDir, "instances");
  const dirents = await readdir(instancesDir, { withFileTypes: true }).catch(() => null);
  if (!dirents) return [];

  const versions = new Set<string>();
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    try {
      const descriptorPath = path.join(instancesDir, dirent.name, "runtime", "server.json");
      const parsed = JSON.parse(await readFile(descriptorPath, "utf8")) as Record<string, unknown>;
      if (typeof parsed.version !== "string") continue;
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 && isPidRunning(parsed.pid)) {
        versions.add(parsed.version);
      }
    } catch {
      continue;
    }
  }
  return [...versions];
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveProtectedRuntimeVersions(
  entries: RuntimeCacheEntry[],
  options: {
    requestedVersion?: string;
    protectedVersions: string[];
    keepPreviousEntries: number;
  },
): string[] {
  const protectedVersions = new Set<string>();
  const requestedVersion = options.requestedVersion ? resolveRuntimePackageVersion(options.requestedVersion) : null;
  if (requestedVersion) protectedVersions.add(requestedVersion);
  for (const version of options.protectedVersions) {
    const normalized = version.trim();
    if (normalized) protectedVersions.add(normalized);
  }

  const latestStable = latestRuntimeVersion(entries.filter((entry) => isStableVersion(entry.packageVersion)));
  if (latestStable) protectedVersions.add(latestStable);
  const latestCanary = latestRuntimeVersion(entries.filter((entry) => isCanaryVersion(entry.packageVersion)));
  if (latestCanary) protectedVersions.add(latestCanary);

  const previousEntries = [...entries]
    .filter((entry) => entry.packageVersion !== requestedVersion)
    .sort((a, b) => b.lastUsedAtMs - a.lastUsedAtMs);
  for (const entry of previousEntries.slice(0, Math.max(0, options.keepPreviousEntries))) {
    protectedVersions.add(entry.packageVersion);
  }

  return [...protectedVersions].sort();
}

function planRuntimeCacheDeletions(
  entries: RuntimeCacheEntry[],
  options: {
    nowMs: number;
    protectedVersions: Set<string>;
    maxEntries: number;
    maxAgeMs: number;
    maxTotalBytes: number;
  },
): RuntimeCacheEntry[] {
  const deletions = new Set<string>();
  const oldestFirst = [...entries].sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs);
  const canDelete = (entry: RuntimeCacheEntry): boolean =>
    !options.protectedVersions.has(entry.packageVersion) && !deletions.has(entry.cacheDir);
  const mark = (entry: RuntimeCacheEntry): void => {
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

function latestRuntimeVersion(entries: RuntimeCacheEntry[]): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    if (!latest || compareRuntimeVersions(entry.packageVersion, latest) > 0) {
      latest = entry.packageVersion;
    }
  }
  return latest;
}

function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function isCanaryVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-canary\.\d+$/.test(version);
}

function compareRuntimeVersions(a: string, b: string): number {
  const parsedA = parseRuntimeVersion(a);
  const parsedB = parseRuntimeVersion(b);
  if (!parsedA || !parsedB) return a.localeCompare(b);
  for (const key of ["major", "minor", "patch"] as const) {
    if (parsedA[key] !== parsedB[key]) return parsedA[key] - parsedB[key];
  }
  if (parsedA.prerelease === null && parsedB.prerelease !== null) return 1;
  if (parsedA.prerelease !== null && parsedB.prerelease === null) return -1;
  if (parsedA.canaryNumber !== null && parsedB.canaryNumber !== null) {
    return parsedA.canaryNumber - parsedB.canaryNumber;
  }
  return (parsedA.prerelease ?? "").localeCompare(parsedB.prerelease ?? "");
}

function parseRuntimeVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  canaryNumber: number | null;
} | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  const prerelease = match[4] ?? null;
  const canaryMatch = prerelease ? /^canary\.(\d+)$/.exec(prerelease) : null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    canaryNumber: canaryMatch ? Number(canaryMatch[1]) : null,
  };
}
