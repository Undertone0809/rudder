import { execFileSync, spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRudderHomeDir } from "../config/home.js";

export const RUNTIME_NPM_PACKAGE_NAME = "@rudderhq/server";
export const NPM_PUBLIC_REGISTRY_URL = "https://registry.npmjs.org";
export const RUNTIME_METADATA_FILE = "runtime.json";
export const RUNTIME_POSTGRES_PAYLOAD_DIR = "postgres-18.4";
export const DEFAULT_RUNTIME_CACHE_MAX_ENTRIES = 2;
export const DEFAULT_RUNTIME_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_RUNTIME_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_RUNTIME_CACHE_KEEP_PREVIOUS = 0;
const RUNTIME_NPM_INSTALL_FLAGS = ["--omit=dev", "--include=optional", "--no-audit", "--no-fund"];
const RUNTIME_NPM_PACK_FLAGS = ["--registry", NPM_PUBLIC_REGISTRY_URL, "--silent"];
const EMBEDDED_POSTGRES_PACKAGE_NAME = "embedded-postgres";
const RUDDER_POSTGRES_BIN_DIR_ENV = "RUDDER_POSTGRES_BIN_DIR";
const RUNTIME_CACHE_PACKAGE_JSON = {
  name: "rudder-runtime-cache",
  version: "0.0.0",
  private: true,
  type: "module",
};
const NPM_PLATFORM_REPAIR_ENV = {
  npm_config_registry: NPM_PUBLIC_REGISTRY_URL,
  npm_config_update_notifier: "false",
  NO_UPDATE_NOTIFIER: "1",
};

type PackageJsonLike = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

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
  postgresPayloadBinDir?: string;
  prune?: RuntimeCachePruneResult;
}

export interface EnsureRuntimeInstalledOptions {
  version: string;
  homeDir?: string;
  packageName?: string;
  spawnSyncImpl?: typeof spawnSync;
  preparePostgresPayload?: boolean;
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

function resolveEmbeddedPostgresPlatformPackage(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  if (platform === "darwin" && arch === "arm64") return "@embedded-postgres/darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "@embedded-postgres/darwin-x64";
  if (platform === "linux" && arch === "arm64") return "@embedded-postgres/linux-arm64";
  if (platform === "linux" && arch === "arm") return "@embedded-postgres/linux-arm";
  if (platform === "linux" && arch === "ia32") return "@embedded-postgres/linux-ia32";
  if (platform === "linux" && arch === "ppc64") return "@embedded-postgres/linux-ppc64";
  if (platform === "linux" && arch === "x64") return "@embedded-postgres/linux-x64";
  if (platform === "win32" && arch === "x64") return "@embedded-postgres/windows-x64";
  return null;
}

async function canResolveRuntimePackage(cacheDir: string, packageName: string): Promise<boolean> {
  try {
    await readFile(path.join(cacheDir, "node_modules", ...packageName.split("/"), "package.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function hasRequiredRuntimePlatformDependencies(cacheDir: string): Promise<boolean> {
  if (!await canResolveRuntimePackage(cacheDir, EMBEDDED_POSTGRES_PACKAGE_NAME)) return true;
  const platformPackage = resolveEmbeddedPostgresPlatformPackage();
  if (!platformPackage) return true;
  return await canResolveRuntimePackage(cacheDir, platformPackage);
}

async function assertRequiredRuntimePlatformDependencies(cacheDir: string, command: string, output: string): Promise<void> {
  if (!await canResolveRuntimePackage(cacheDir, EMBEDDED_POSTGRES_PACKAGE_NAME)) return;
  const platformPackage = resolveEmbeddedPostgresPlatformPackage();
  if (!platformPackage || await canResolveRuntimePackage(cacheDir, platformPackage)) return;

  throw new RuntimeInstallError(
    `Rudder runtime installation is missing required platform package ${platformPackage}. Re-run manually: ${command}`,
    {
      cacheDir,
      command,
      output: [
        output,
        `Missing required optional dependency: ${platformPackage}`,
        "Your npm registry, mirror, proxy, or cache may have skipped the embedded PostgreSQL platform package.",
      ].filter((line) => line.trim().length > 0).join("\n"),
    },
  );
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
    const packageVersionMatches = packageVersion === "latest" || packageJson.version === packageVersion;
    return packageVersionMatches && await hasRequiredRuntimePlatformDependencies(options.cacheDir);
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
  const preparePostgresPayload = options.preparePostgresPayload === true;

  if (await isRuntimeCacheHit({ cacheDir, version: packageVersion, packageName })) {
    const postgresPayload = await stageRuntimePostgresPayload(cacheDir, preparePostgresPayload);
    await touchRuntimeInstallMetadata(cacheDir);
    const prune = await maybePruneRuntimeCache({
      homeDir: options.homeDir,
      requestedVersion: packageVersion,
      enabled: options.pruneRuntimeCache !== false,
      retention: options.retention,
    });
    return withPostgresPayload(
      { status: "hit", cacheDir, packageSpec, command, output: "", ...(prune ? { prune } : {}) },
      postgresPayload,
    );
  }

  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const existingRuntimeOutput = await tryRepairExistingRuntimePackage({
    spawnSyncImpl,
    cacheDir,
    packageName,
    packageVersion,
  });
  if (existingRuntimeOutput !== null) {
    const postgresPayload = await stageRuntimePostgresPayload(cacheDir, preparePostgresPayload);
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
    return withPostgresPayload(
      { status: "installed", cacheDir, packageSpec, command, output: existingRuntimeOutput, ...(prune ? { prune } : {}) },
      postgresPayload,
    );
  }

  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, "package.json"), `${JSON.stringify(RUNTIME_CACHE_PACKAGE_JSON, null, 2)}\n`, "utf8");

  const result = runNpmRuntimeInstall(spawnSyncImpl, cacheDir, packageSpec);
  let output = collectSpawnOutput(result);

  if (result.status !== 0 && packageVersion !== "latest" && isVersionNotFoundError(output)) {
    const fallbackVersion = "latest";
    const fallbackCacheDir = resolveRuntimeCacheDir(fallbackVersion, options.homeDir);
    const fallbackSpec = resolveRuntimePackageSpec(fallbackVersion, packageName);

    if (await isRuntimeCacheHit({ cacheDir: fallbackCacheDir, version: fallbackVersion, packageName })) {
      const fallbackPostgresPayload = await stageRuntimePostgresPayload(fallbackCacheDir, preparePostgresPayload);
      await touchRuntimeInstallMetadata(fallbackCacheDir);
      return withPostgresPayload(
        {
          status: "hit",
          cacheDir: fallbackCacheDir,
          packageSpec: fallbackSpec,
          command: formatRuntimeInstallCommand(fallbackCacheDir, fallbackSpec),
          output: "",
        },
        fallbackPostgresPayload,
      );
    }

    await rm(fallbackCacheDir, { recursive: true, force: true });
    await mkdir(fallbackCacheDir, { recursive: true });
    await writeFile(path.join(fallbackCacheDir, "package.json"), `${JSON.stringify(RUNTIME_CACHE_PACKAGE_JSON, null, 2)}\n`, "utf8");

    const fallbackResult = runNpmRuntimeInstall(spawnSyncImpl, fallbackCacheDir, fallbackSpec);
    let fallbackOutput = collectSpawnOutput(fallbackResult);
    if (fallbackResult.status === 0) {
      fallbackOutput = collectOutputParts(
        fallbackOutput,
        await ensureRequiredEmbeddedPostgresPlatformPackage(spawnSyncImpl, fallbackCacheDir),
      );
      const postgresPayload = await stageRuntimePostgresPayload(fallbackCacheDir, preparePostgresPayload);
      const fallbackMetadata: RuntimeInstallMetadata = {
        version: 1,
        packageName,
        packageVersion: fallbackVersion,
        installedAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      };
      await writeRuntimeInstallMetadata(fallbackCacheDir, fallbackMetadata);
      return withPostgresPayload(
        {
          status: "installed",
          cacheDir: fallbackCacheDir,
          packageSpec: fallbackSpec,
          command: formatRuntimeInstallCommand(fallbackCacheDir, fallbackSpec),
          output: fallbackOutput,
        },
        postgresPayload,
      );
    }
  }

  if (result.status !== 0) {
    throw new RuntimeInstallError(
      `Rudder runtime installation failed. Re-run manually: ${command}`,
      { cacheDir, command, output },
    );
  }

  output = collectOutputParts(
    output,
    await ensureRequiredEmbeddedPostgresPlatformPackage(spawnSyncImpl, cacheDir),
  );
  const postgresPayload = await stageRuntimePostgresPayload(cacheDir, preparePostgresPayload);

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
  return withPostgresPayload(
    { status: "installed", cacheDir, packageSpec, command, output, ...(prune ? { prune } : {}) },
    postgresPayload,
  );
}

export function resolveRuntimePostgresPayloadBinDir(
  cacheDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  return path.join(cacheDir, RUNTIME_POSTGRES_PAYLOAD_DIR, runtimePostgresPlatformSegment(platform, arch), "bin");
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

function formatRuntimePlatformRepairCommand(cacheDir: string, packageSpec: string): string {
  return `npm pack ${packageSpec} --registry=${NPM_PUBLIC_REGISTRY_URL} --silent, then extract it into ${path.join(cacheDir, "node_modules")}`;
}

function collectSpawnOutput(result: SpawnSyncResultLike): string {
  return [result.stdout, result.stderr, result.error instanceof Error ? result.error.message : null]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
}

function collectOutputParts(...parts: string[]): string {
  return parts.filter((part) => part.trim().length > 0).join("\n").trim();
}

type RuntimePostgresPayloadStageResult = {
  output: string;
  binDir?: string;
};

function withPostgresPayload<T extends Omit<RuntimeInstallResult, "postgresPayloadBinDir">>(
  result: T,
  postgresPayload: RuntimePostgresPayloadStageResult,
): T & Pick<RuntimeInstallResult, "postgresPayloadBinDir"> {
  return {
    ...result,
    output: collectOutputParts(result.output, postgresPayload.output),
    ...(postgresPayload.binDir ? { postgresPayloadBinDir: postgresPayload.binDir } : {}),
  };
}

function runtimePackageJsonPath(cacheDir: string, packageName: string): string {
  return path.join(cacheDir, "node_modules", ...packageName.split("/"), "package.json");
}

async function readRuntimePackageJson(cacheDir: string, packageName: string): Promise<PackageJsonLike | null> {
  try {
    return JSON.parse(await readFile(runtimePackageJsonPath(cacheDir, packageName), "utf8")) as PackageJsonLike;
  } catch {
    return null;
  }
}

async function tryRepairExistingRuntimePackage(options: {
  spawnSyncImpl: typeof spawnSync;
  cacheDir: string;
  packageName: string;
  packageVersion: string;
}): Promise<string | null> {
  const runtimePackage = await readRuntimePackageJson(options.cacheDir, options.packageName);
  if (!runtimePackage) return null;
  if (options.packageVersion !== "latest" && runtimePackage.version !== options.packageVersion) return null;

  const output = await ensureRequiredEmbeddedPostgresPlatformPackage(options.spawnSyncImpl, options.cacheDir);
  return await hasRequiredRuntimePlatformDependencies(options.cacheDir) ? output : null;
}

export function embeddedPostgresPlatformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  return resolveEmbeddedPostgresPlatformPackage(platform, arch);
}

async function resolveEmbeddedPostgresPlatformPackageSpec(cacheDir: string): Promise<string | null> {
  if (!await canResolveRuntimePackage(cacheDir, EMBEDDED_POSTGRES_PACKAGE_NAME)) return null;

  const packageName = resolveEmbeddedPostgresPlatformPackage();
  if (!packageName) return null;

  const embeddedPostgresPackage = await readRuntimePackageJson(cacheDir, EMBEDDED_POSTGRES_PACKAGE_NAME);
  const versionRange = embeddedPostgresPackage?.optionalDependencies?.[packageName];
  const packageVersion = normalizeOptionalDependencyVersion(versionRange);
  return packageVersion ? `${packageName}@${packageVersion}` : packageName;
}

async function ensureRequiredEmbeddedPostgresPlatformPackage(
  spawnSyncImpl: typeof spawnSync,
  cacheDir: string,
): Promise<string> {
  const packageSpec = await resolveEmbeddedPostgresPlatformPackageSpec(cacheDir);
  if (!packageSpec) return "";

  const packageName = packageNameFromSpec(packageSpec);
  if (packageName && await canResolveRuntimePackage(cacheDir, packageName)) return "";

  await removeRuntimeInstallLocks(cacheDir);
  const result = await installRuntimePackageInStaging(spawnSyncImpl, cacheDir, packageSpec, packageName);
  const output = collectSpawnOutput(result);
  if (result.status === 0 && packageName && await canResolveRuntimePackage(cacheDir, packageName)) {
    return output;
  }

  const command = formatRuntimePlatformRepairCommand(cacheDir, packageSpec);
  throw new RuntimeInstallError(
    `Rudder runtime installation is missing required platform package ${packageName || packageSpec}. Re-run manually: ${command}`,
    { cacheDir, command, output },
  );
}

async function installRuntimePackageInStaging(
  spawnSyncImpl: typeof spawnSync,
  cacheDir: string,
  packageSpec: string,
  packageName: string,
): Promise<SpawnSyncResultLike> {
  const stagingDir = path.join(cacheDir, `.platform-repair-${process.pid}-${Date.now()}`);
  await mkdir(stagingDir, { recursive: true });

  try {
    const packResult = runNpmPack(spawnSyncImpl, packageSpec, stagingDir);
    if (packResult.status !== 0) return packResult;

    const packFilename = parseNpmPackFilename(packResult.stdout);
    if (!packFilename) {
      return createSyntheticSpawnResult(1, "", `Unable to parse npm pack output for ${packageSpec}.`);
    }

    const archivePath = path.join(stagingDir, packFilename);
    const targetDir = path.dirname(runtimePackageJsonPath(cacheDir, packageName));
    await mkdir(path.dirname(targetDir), { recursive: true });
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });

    const extractResult = runTarExtract(spawnSyncImpl, archivePath, targetDir);
    return combineSpawnResults(packResult, extractResult);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

function runNpmPack(
  spawnSyncImpl: typeof spawnSync,
  packageSpec: string,
  destinationDir: string,
): SpawnSyncResultLike {
  return spawnSyncImpl(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", packageSpec, "--pack-destination", destinationDir, ...RUNTIME_NPM_PACK_FLAGS],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...NPM_PLATFORM_REPAIR_ENV },
      ...(process.platform === "win32" ? { shell: true, windowsHide: true } : {}),
    },
  );
}

function runTarExtract(
  spawnSyncImpl: typeof spawnSync,
  archivePath: string,
  targetDir: string,
): SpawnSyncResultLike {
  return spawnSyncImpl(
    "tar",
    ["-xzf", archivePath, "-C", targetDir, "--strip-components", "1"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    },
  );
}

function parseNpmPackFilename(stdout: unknown): string | null {
  if (typeof stdout !== "string") return null;
  const filename = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return filename?.endsWith(".tgz") ? filename : null;
}

function createSyntheticSpawnResult(status: number, stdout: string, stderr: string): SpawnSyncResultLike {
  return { status, stdout, stderr } as SpawnSyncResultLike;
}

function combineSpawnResults(...results: SpawnSyncResultLike[]): SpawnSyncResultLike {
  const last = results.at(-1);
  return {
    status: last?.status ?? 0,
    stdout: results.map((result) => result.stdout).filter(Boolean).join("\n"),
    stderr: results.map((result) => result.stderr).filter(Boolean).join("\n"),
    error: results.find((result) => result.error)?.error,
  } as SpawnSyncResultLike;
}

async function removeRuntimeInstallLocks(cacheDir: string): Promise<void> {
  await Promise.all([
    rm(path.join(cacheDir, "package-lock.json"), { force: true }),
    rm(path.join(cacheDir, "node_modules", ".package-lock.json"), { force: true }),
  ]);
}

function packageNameFromSpec(packageSpec: string): string {
  if (!packageSpec.startsWith("@")) {
    const versionSeparator = packageSpec.indexOf("@");
    return versionSeparator === -1 ? packageSpec : packageSpec.slice(0, versionSeparator);
  }

  const versionSeparator = packageSpec.indexOf("@", 1);
  return versionSeparator === -1 ? packageSpec : packageSpec.slice(0, versionSeparator);
}

function normalizeOptionalDependencyVersion(versionRange: string | undefined): string | null {
  const trimmed = versionRange?.trim();
  if (!trimmed) return null;
  const exactVersion = /^[~^]\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/.exec(trimmed);
  return exactVersion?.[1] ?? trimmed;
}

function runtimePostgresPlatformSegment(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  return `${platform}-${arch}`;
}

function runtimePostgresExecutableName(baseName: "initdb" | "pg_ctl" | "postgres"): string {
  return process.platform === "win32" ? `${baseName}.exe` : baseName;
}

async function assertRuntimePostgresBinDirComplete(cacheDir: string, binDir: string): Promise<void> {
  const requiredBinaries = ["initdb", "pg_ctl", "postgres"] as const;
  const missing: string[] = [];
  for (const binary of requiredBinaries) {
    const binaryPath = path.join(binDir, runtimePostgresExecutableName(binary));
    try {
      await stat(binaryPath);
    } catch {
      missing.push(binaryPath);
    }
  }
  if (missing.length > 0) {
    throw new RuntimeInstallError(
      `${RUDDER_POSTGRES_BIN_DIR_ENV} must contain PostgreSQL 18.4 initdb, pg_ctl, and postgres binaries; missing ${missing.join(", ")}`,
      { cacheDir, command: "validate PostgreSQL 18.4 runtime payload", output: "" },
    );
  }
}

async function isRuntimePostgresPayloadUsable(cacheDir: string, binDir: string): Promise<boolean> {
  try {
    await assertRuntimePostgresBinDirComplete(cacheDir, binDir);
    const postgresBinary = path.join(binDir, runtimePostgresExecutableName("postgres"));
    const result = execFileSync(postgresBinary, ["--version"], { encoding: "utf8" });
    return /\bPostgreSQL\)?\s+18\.4\b/i.test(result);
  } catch {
    return false;
  }
}

async function stageRuntimePostgresPayload(cacheDir: string, enabled: boolean): Promise<RuntimePostgresPayloadStageResult> {
  const targetRuntimeDir = path.join(cacheDir, RUNTIME_POSTGRES_PAYLOAD_DIR);
  const targetBinDir = resolveRuntimePostgresPayloadBinDir(cacheDir);
  if (await isRuntimePostgresPayloadUsable(cacheDir, targetBinDir)) {
    return { output: "", binDir: targetBinDir };
  }
  if (!enabled) return { output: "" };
  const sourceBinDir = process.env[RUDDER_POSTGRES_BIN_DIR_ENV]?.trim();
  if (!sourceBinDir) return { output: "" };

  const resolvedSourceBinDir = path.resolve(sourceBinDir);
  await assertRuntimePostgresBinDirComplete(cacheDir, resolvedSourceBinDir);
  const postgresBinary = path.join(resolvedSourceBinDir, runtimePostgresExecutableName("postgres"));
  const result = execFileSync(postgresBinary, ["--version"], { encoding: "utf8" });
  if (!/\bPostgreSQL\)?\s+18\.4\b/i.test(result)) {
    throw new RuntimeInstallError(
      `${RUDDER_POSTGRES_BIN_DIR_ENV} must contain PostgreSQL 18.4 production binaries; got ${result.trim() || "unknown version"}`,
      { cacheDir, command: `${postgresBinary} --version`, output: result },
    );
  }

  await rm(targetRuntimeDir, { recursive: true, force: true });
  await mkdir(path.dirname(targetBinDir), { recursive: true });
  await cp(resolvedSourceBinDir, targetBinDir, { recursive: true });
  return { output: `staged PostgreSQL 18.4 runtime payload at ${targetBinDir}`, binDir: targetBinDir };
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
