import { execFileSync, spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { resolveRudderHomeDir } from "../config/home.js";
import { resolveNpmCommandInvocation } from "../npm-command.js";
import { tryInstallNativePayload } from "./native-payload.js";
import { downloadRuntimePostgresArchive } from "./postgres-runtime-download.js";
import { resolvePostgresRuntimeArchiveSource } from "./postgres-runtime-source.js";
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
const RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV = "RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR";
const RUDDER_POSTGRES_BIN_DIR_ENV = "RUDDER_POSTGRES_BIN_DIR";
const RUDDER_POSTGRES_RUNTIME_ARCHIVE_MAX_BYTES_ENV = "RUDDER_POSTGRES_RUNTIME_ARCHIVE_MAX_BYTES";
const DEFAULT_RUNTIME_POSTGRES_ARCHIVE_MAX_BYTES = 1_024 * 1024 * 1024;
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
  postgresRuntime?: {
    version: "18.4";
    platform: NodeJS.Platform;
    arch: NodeJS.Architecture;
    binDir: string;
    scope: "shared" | "external";
  };
}

export interface RuntimeInstallResult {
  status: "hit" | "installed";
  cacheDir: string;
  packageSpec: string;
  command: string;
  output: string;
  postgresPayloadBinDir?: string;
  postgresRuntime?: RuntimeInstallMetadata["postgresRuntime"];
  prune?: RuntimeCachePruneResult;
}

export interface EnsureRuntimeInstalledOptions {
  version: string;
  homeDir?: string;
  packageName?: string;
  spawnSyncImpl?: typeof spawnSync;
  postgresVersionProbe?: RuntimePostgresVersionProbe;
  preparePostgresPayload?: boolean;
  pruneRuntimeCache?: boolean;
  retention?: RuntimeCacheRetentionOptions;
  /** Shared monotonic budget for Desktop update runtime preparation. */
  timeoutMs?: number;
  /** Test-only monotonic clock injection. */
  now?: () => number;
  /** Remove only an incomplete requested-version cache while its lock is held. */
  cleanupIncompleteOnFailure?: boolean;
  /** Test-only incomplete-cache remover injection. */
  removeIncompleteCache?: (cacheDir: string) => Promise<void>;
  /** Test-only private PostgreSQL download work-directory cleanup injection. */
  cleanupPostgresDownloadWorkDir?: (workDir: string) => Promise<void>;
  /** Preserve ordinary startup compatibility; Desktop exact-version preparation disables this. */
  allowLatestFallback?: boolean;
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
export type RuntimePostgresVersionProbe = (postgresBinary: string) => string;

type RuntimeInstallDeadline = {
  expiresAt: number;
  now: () => number;
};

function createRuntimeInstallDeadline(options: EnsureRuntimeInstalledOptions): RuntimeInstallDeadline | undefined {
  if (options.timeoutMs === undefined) return undefined;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Runtime installation timeout must be a positive number of milliseconds.");
  }
  const now = options.now ?? (() => performance.now());
  return { expiresAt: now() + options.timeoutMs, now };
}

function remainingRuntimeInstallMs(
  deadline: RuntimeInstallDeadline | undefined,
  cacheDir: string,
  command: string,
): number | undefined {
  if (!deadline) return undefined;
  const remaining = Math.ceil(deadline.expiresAt - deadline.now());
  if (remaining <= 0) {
    throw new RuntimeInstallError(
      `Timed out while preparing the Rudder runtime during ${command}`,
      { cacheDir, command },
    );
  }
  return remaining;
}

function runtimeInstallDeadlineError(cacheDir: string, command: string): RuntimeInstallError {
  return new RuntimeInstallError(
    `Timed out while preparing the Rudder runtime during ${command}`,
    { cacheDir, command },
  );
}

function isRuntimeInstallDeadlineError(error: unknown): boolean {
  return error instanceof RuntimeInstallError
    && error.message.startsWith("Timed out while preparing the Rudder runtime during ");
}

function isChildProcessTimeoutError(error: unknown): boolean {
  const detail = error as { code?: unknown; killed?: unknown; signal?: unknown };
  return detail?.code === "ETIMEDOUT" || detail?.killed === true || detail?.signal === "SIGTERM";
}

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
    const metadata = { ...parsed };
    const postgresRuntime = parsed.postgresRuntime as unknown;
    if (
      postgresRuntime !== undefined
      && (
        postgresRuntime === null
        || typeof postgresRuntime !== "object"
        || (postgresRuntime as Record<string, unknown>).version !== "18.4"
        || typeof (postgresRuntime as Record<string, unknown>).platform !== "string"
        || typeof (postgresRuntime as Record<string, unknown>).arch !== "string"
        || typeof (postgresRuntime as Record<string, unknown>).binDir !== "string"
        || (
          (postgresRuntime as Record<string, unknown>).scope !== "shared"
          && (postgresRuntime as Record<string, unknown>).scope !== "external"
        )
      )
    ) {
      delete metadata.postgresRuntime;
    }
    return metadata;
  } catch {
    return null;
  }
}

async function writeRuntimeInstallMetadata(cacheDir: string, metadata: RuntimeInstallMetadata): Promise<void> {
  await writeFile(path.join(cacheDir, RUNTIME_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function touchRuntimeInstallMetadata(
  cacheDir: string,
  postgresRuntime?: RuntimeInstallMetadata["postgresRuntime"],
): Promise<void> {
  try {
    const metadata = await readRuntimeInstallMetadata(cacheDir);
    if (!metadata) return;
    await writeRuntimeInstallMetadata(cacheDir, {
      ...metadata,
      lastUsedAt: new Date().toISOString(),
      ...(postgresRuntime ? { postgresRuntime } : {}),
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

async function hasRequiredRuntimePlatformDependencies(
  cacheDir: string,
  metadata: RuntimeInstallMetadata,
  postgresVersionProbe: RuntimePostgresVersionProbe,
  deadline?: RuntimeInstallDeadline,
): Promise<boolean> {
  if (!await canResolveRuntimePackage(cacheDir, EMBEDDED_POSTGRES_PACKAGE_NAME)) return true;
  const platformPackage = resolveEmbeddedPostgresPlatformPackage();
  if (!platformPackage) return true;
  if (await canResolveRuntimePackage(cacheDir, platformPackage)) return true;
  const expectedSharedBinDir = resolveSharedRuntimePostgresPayloadBinDir(
    path.dirname(path.dirname(cacheDir)),
  );
  return metadata.postgresRuntime?.scope === "shared"
    && metadata.postgresRuntime.platform === process.platform
    && metadata.postgresRuntime.arch === process.arch
    && path.resolve(metadata.postgresRuntime.binDir) === path.resolve(expectedSharedBinDir)
    && await isRuntimePostgresPayloadUsable(
      cacheDir,
      metadata.postgresRuntime.binDir,
      postgresVersionProbe,
      deadline,
    );
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
  postgresVersionProbe?: RuntimePostgresVersionProbe;
}): Promise<boolean> {
  return isRuntimeCacheHitWithinDeadline(options);
}

async function isRuntimeCacheHitWithinDeadline(options: {
  cacheDir: string;
  version: string;
  packageName?: string;
  postgresVersionProbe?: RuntimePostgresVersionProbe;
}, deadline?: RuntimeInstallDeadline): Promise<boolean> {
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
    return packageVersionMatches && await hasRequiredRuntimePlatformDependencies(
      options.cacheDir,
      metadata,
      options.postgresVersionProbe ?? readPostgresVersion,
      deadline,
    );
  } catch (error) {
    if (isRuntimeInstallDeadlineError(error)) throw error;
    return false;
  }
}

export async function ensureRuntimeInstalled(
  options: EnsureRuntimeInstalledOptions,
): Promise<RuntimeInstallResult> {
  const packageVersion = resolveRuntimePackageVersion(options.version);
  const homeDir = options.homeDir ?? resolveRudderHomeDir();
  const cacheDir = resolveRuntimeCacheDir(packageVersion, homeDir);
  const deadline = createRuntimeInstallDeadline(options);
  return withRuntimeFilesystemLock(
    path.join(homeDir, "runtime-payloads", ".postgres-runtime.lifecycle.lock"),
    async () => withRuntimeFilesystemLock(
      `${cacheDir}.install.lock`,
      async () => {
        try {
          return await ensureRuntimeInstalledUnlocked(options, deadline);
        } catch (error) {
          if (options.cleanupIncompleteOnFailure === true) {
            scheduleIncompleteRuntimeCacheCleanup({
              cacheDir,
              packageVersion,
              remove: options.removeIncompleteCache,
            });
          }
          throw error;
        }
      },
      { deadline, cacheDir, command: "acquire target runtime install lock" },
    ),
    { deadline, cacheDir, command: "acquire PostgreSQL runtime lifecycle lock" },
  );
}

function scheduleIncompleteRuntimeCacheCleanup(options: {
  cacheDir: string;
  packageVersion: string;
  remove?: (cacheDir: string) => Promise<void>;
}): void {
  const remove = options.remove ?? ((cacheDir: string) => rm(cacheDir, { recursive: true, force: true }));
  // Runtime preparation must hand control back to the full-asset path at the
  // deadline. Cleanup reacquires the exact target lock and continues in the
  // background so a slow filesystem cannot extend that user-facing budget.
  void withRuntimeFilesystemLock(
    `${options.cacheDir}.install.lock`,
    async () => {
      const metadata = await readRuntimeInstallMetadata(options.cacheDir);
      if (!metadata || metadata.packageVersion !== options.packageVersion) {
        await remove(options.cacheDir);
      }
    },
    { cacheDir: options.cacheDir, command: "cleanup incomplete target runtime cache" },
  ).catch(() => {
    // Cleanup is best-effort; the exact target remains unusable without valid
    // metadata and a later preparation attempt will repair or replace it.
  });
}

async function ensureRuntimeInstalledUnlocked(
  options: EnsureRuntimeInstalledOptions,
  deadline?: RuntimeInstallDeadline,
): Promise<RuntimeInstallResult> {
  const packageName = options.packageName ?? RUNTIME_NPM_PACKAGE_NAME;
  const packageVersion = resolveRuntimePackageVersion(options.version);
  const homeDir = options.homeDir ?? resolveRudderHomeDir();
  const cacheDir = resolveRuntimeCacheDir(packageVersion, homeDir);
  const packageSpec = resolveRuntimePackageSpec(packageVersion, packageName);
  const command = formatRuntimeInstallCommand(cacheDir, packageSpec);
  const preparePostgresPayload = options.preparePostgresPayload === true;
  const postgresVersionProbe = options.postgresVersionProbe
    ?? ((binaryPath) => {
      const probeCommand = `${binaryPath} --version`;
      try {
        return readPostgresVersion(
          binaryPath,
          remainingRuntimeInstallMs(deadline, cacheDir, probeCommand),
        );
      } catch (error) {
        if (isChildProcessTimeoutError(error)) {
          throw runtimeInstallDeadlineError(cacheDir, probeCommand);
        }
        throw error;
      }
    });

  if (await isRuntimeCacheHitWithinDeadline(
    { cacheDir, version: packageVersion, packageName, postgresVersionProbe },
    deadline,
  )) {
    const postgresPayload = await stageRuntimePostgresPayload(
      cacheDir,
      homeDir,
      packageVersion,
      preparePostgresPayload,
      postgresVersionProbe,
      deadline,
      options.cleanupPostgresDownloadWorkDir,
    );
    await touchRuntimeInstallMetadata(cacheDir, postgresPayload.metadata);
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
    deadline,
  });
  if (existingRuntimeOutput !== null) {
    const postgresPayload = await stageRuntimePostgresPayload(
      cacheDir,
      homeDir,
      packageVersion,
      preparePostgresPayload,
      postgresVersionProbe,
      deadline,
      options.cleanupPostgresDownloadWorkDir,
    );
    const metadata: RuntimeInstallMetadata = {
      version: 1,
      packageName,
      packageVersion,
      installedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      ...(postgresPayload.metadata ? { postgresRuntime: postgresPayload.metadata } : {}),
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

  const result = runNpmRuntimeInstall(spawnSyncImpl, cacheDir, packageSpec, deadline);
  let output = collectSpawnOutput(result);

  if (
    result.status !== 0
    && packageVersion !== "latest"
    && options.allowLatestFallback !== false
    && isVersionNotFoundError(output)
  ) {
    const fallbackVersion = "latest";
    const fallbackCacheDir = resolveRuntimeCacheDir(fallbackVersion, options.homeDir);
    const fallbackSpec = resolveRuntimePackageSpec(fallbackVersion, packageName);
    const fallbackInstallResult = await withRuntimeFilesystemLock(
      `${fallbackCacheDir}.install.lock`,
      async (): Promise<RuntimeInstallResult | null> => {
        if (await isRuntimeCacheHitWithinDeadline({
          cacheDir: fallbackCacheDir,
          version: fallbackVersion,
          packageName,
          postgresVersionProbe,
        }, deadline)) {
          const fallbackPostgresPayload = await stageRuntimePostgresPayload(
            fallbackCacheDir,
            homeDir,
            fallbackVersion,
            preparePostgresPayload,
            postgresVersionProbe,
            deadline,
            options.cleanupPostgresDownloadWorkDir,
          );
          await touchRuntimeInstallMetadata(fallbackCacheDir, fallbackPostgresPayload.metadata);
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

        const fallbackResult = runNpmRuntimeInstall(spawnSyncImpl, fallbackCacheDir, fallbackSpec, deadline);
        let fallbackOutput = collectSpawnOutput(fallbackResult);
        if (fallbackResult.status !== 0) return null;

        fallbackOutput = collectOutputParts(
          fallbackOutput,
          await ensureRequiredEmbeddedPostgresPlatformPackage(spawnSyncImpl, fallbackCacheDir, deadline),
        );
        const postgresPayload = await stageRuntimePostgresPayload(
          fallbackCacheDir,
          homeDir,
          fallbackVersion,
          preparePostgresPayload,
          postgresVersionProbe,
          deadline,
          options.cleanupPostgresDownloadWorkDir,
        );
        const fallbackMetadata: RuntimeInstallMetadata = {
          version: 1,
          packageName,
          packageVersion: fallbackVersion,
          installedAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          ...(postgresPayload.metadata ? { postgresRuntime: postgresPayload.metadata } : {}),
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
      },
      { deadline, cacheDir: fallbackCacheDir, command: "acquire fallback runtime install lock" },
    );
    if (fallbackInstallResult) return fallbackInstallResult;
  }

  if (result.status !== 0) {
    throw new RuntimeInstallError(
      `Rudder runtime installation failed. Re-run manually: ${command}`,
      { cacheDir, command, output },
    );
  }

  output = collectOutputParts(
    output,
    await ensureRequiredEmbeddedPostgresPlatformPackage(spawnSyncImpl, cacheDir, deadline),
  );
  const postgresPayload = await stageRuntimePostgresPayload(
    cacheDir,
    homeDir,
    packageVersion,
    preparePostgresPayload,
    postgresVersionProbe,
    deadline,
    options.cleanupPostgresDownloadWorkDir,
  );

  const metadata: RuntimeInstallMetadata = {
    version: 1,
    packageName,
    packageVersion,
    installedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    ...(postgresPayload.metadata ? { postgresRuntime: postgresPayload.metadata } : {}),
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

export function resolveSharedRuntimePostgresPayloadBinDir(
  homeDir: string = resolveRudderHomeDir(),
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  return path.join(
    homeDir,
    "runtime-payloads",
    RUNTIME_POSTGRES_PAYLOAD_DIR,
    runtimePostgresPlatformSegment(platform, arch),
    "bin",
  );
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
  deadline?: RuntimeInstallDeadline,
): SpawnSyncResultLike {
  const timeout = remainingRuntimeInstallMs(deadline, cacheDir, `npm install ${packageSpec}`);
  const npm = resolveNpmCommandInvocation();
  return spawnSyncImpl(
    npm.command,
    [...npm.args, "install", "--prefix", cacheDir, ...RUNTIME_NPM_INSTALL_FLAGS, packageSpec],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(timeout === undefined ? {} : { timeout }),
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
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
  metadata?: RuntimeInstallMetadata["postgresRuntime"];
};

function withPostgresPayload<T extends Omit<RuntimeInstallResult, "postgresPayloadBinDir" | "postgresRuntime">>(
  result: T,
  postgresPayload: RuntimePostgresPayloadStageResult,
): T & Pick<RuntimeInstallResult, "postgresPayloadBinDir" | "postgresRuntime"> {
  return {
    ...result,
    output: collectOutputParts(result.output, postgresPayload.output),
    ...(postgresPayload.binDir ? { postgresPayloadBinDir: postgresPayload.binDir } : {}),
    ...(postgresPayload.metadata ? { postgresRuntime: postgresPayload.metadata } : {}),
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
  deadline?: RuntimeInstallDeadline;
}): Promise<string | null> {
  const runtimePackage = await readRuntimePackageJson(options.cacheDir, options.packageName);
  if (!runtimePackage) return null;
  if (options.packageVersion !== "latest" && runtimePackage.version !== options.packageVersion) return null;

  const output = await ensureRequiredEmbeddedPostgresPlatformPackage(
    options.spawnSyncImpl,
    options.cacheDir,
    options.deadline,
  );
  if (!await canResolveRuntimePackage(options.cacheDir, EMBEDDED_POSTGRES_PACKAGE_NAME)) return output;
  const platformPackage = resolveEmbeddedPostgresPlatformPackage();
  return !platformPackage || await canResolveRuntimePackage(options.cacheDir, platformPackage)
    ? output
    : null;
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
  deadline?: RuntimeInstallDeadline,
): Promise<string> {
  const packageSpec = await resolveEmbeddedPostgresPlatformPackageSpec(cacheDir);
  if (!packageSpec) return "";

  const packageName = packageNameFromSpec(packageSpec);
  if (packageName && await canResolveRuntimePackage(cacheDir, packageName)) return "";

  await removeRuntimeInstallLocks(cacheDir);
  const result = await installRuntimePackageInStaging(
    spawnSyncImpl,
    cacheDir,
    packageSpec,
    packageName,
    deadline,
  );
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
  deadline?: RuntimeInstallDeadline,
): Promise<SpawnSyncResultLike> {
  const stagingDir = path.join(cacheDir, `.platform-repair-${process.pid}-${Date.now()}`);
  await mkdir(stagingDir, { recursive: true });

  try {
    const packResult = runNpmPack(spawnSyncImpl, packageSpec, stagingDir, cacheDir, deadline);
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

    const extractResult = runTarExtract(spawnSyncImpl, archivePath, targetDir, cacheDir, deadline);
    return combineSpawnResults(packResult, extractResult);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

function runNpmPack(
  spawnSyncImpl: typeof spawnSync,
  packageSpec: string,
  destinationDir: string,
  cacheDir: string,
  deadline?: RuntimeInstallDeadline,
): SpawnSyncResultLike {
  const timeout = remainingRuntimeInstallMs(deadline, cacheDir, `npm pack ${packageSpec}`);
  const npm = resolveNpmCommandInvocation();
  return spawnSyncImpl(
    npm.command,
    [...npm.args, "pack", packageSpec, "--pack-destination", destinationDir, ...RUNTIME_NPM_PACK_FLAGS],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...NPM_PLATFORM_REPAIR_ENV },
      ...(timeout === undefined ? {} : { timeout }),
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    },
  );
}

function runTarExtract(
  spawnSyncImpl: typeof spawnSync,
  archivePath: string,
  targetDir: string,
  cacheDir: string,
  deadline?: RuntimeInstallDeadline,
): SpawnSyncResultLike {
  const timeout = remainingRuntimeInstallMs(deadline, cacheDir, "extract runtime platform package");
  return spawnSyncImpl(
    "tar",
    ["-xzf", archivePath, "-C", targetDir, "--strip-components", "1"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(timeout === undefined ? {} : { timeout }),
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

function debianSharedirCandidate(binDir: string): string | null {
  const normalized = path.resolve(binDir);
  const parts = normalized.split(path.sep);
  const libIndex = parts.lastIndexOf("lib");
  if (libIndex < 0) return null;
  if (parts[libIndex + 1] !== "postgresql") return null;
  const version = parts[libIndex + 2];
  if (!version || parts[libIndex + 3] !== "bin") return null;
  const prefix = parts.slice(0, libIndex).join(path.sep) || path.sep;
  return path.join(prefix, "share", "postgresql", version);
}

async function resolveRuntimePostgresTemplateDir(
  binDir: string,
  cacheDir: string = binDir,
  deadline?: RuntimeInstallDeadline,
): Promise<string | null> {
  for (const candidatePath of [
    path.join(binDir, "..", "share", "postgresql", "postgres.bki"),
    path.join(binDir, "..", "share", "postgres.bki"),
  ]) {
    remainingRuntimeInstallMs(deadline, cacheDir, "discover PostgreSQL runtime templates");
    try {
      await stat(candidatePath);
      return path.dirname(candidatePath);
    } catch {
      // Try the next supported PostgreSQL archive layout.
    }
  }

  const debianSharedir = debianSharedirCandidate(binDir);
  if (debianSharedir) {
    remainingRuntimeInstallMs(deadline, cacheDir, "discover PostgreSQL runtime templates");
    try {
      await stat(path.join(debianSharedir, "postgres.bki"));
      return debianSharedir;
    } catch {
      // Fall through to pg_config.
    }
  }

  const pgConfigPath = path.join(binDir, process.platform === "win32" ? "pg_config.exe" : "pg_config");
  try {
    remainingRuntimeInstallMs(deadline, cacheDir, "discover PostgreSQL runtime templates");
    await stat(pgConfigPath);
    const timeout = remainingRuntimeInstallMs(deadline, cacheDir, `${pgConfigPath} --sharedir`);
    let sharedir: string;
    try {
      sharedir = execFileSync(pgConfigPath, ["--sharedir"], {
        encoding: "utf8",
        ...(timeout === undefined ? {} : { timeout }),
      }).trim();
    } catch (error) {
      if (isChildProcessTimeoutError(error)) {
        throw runtimeInstallDeadlineError(cacheDir, `${pgConfigPath} --sharedir`);
      }
      throw error;
    }
    if (!sharedir) return null;
    remainingRuntimeInstallMs(deadline, cacheDir, "validate PostgreSQL runtime templates");
    const candidatePath = path.join(sharedir, "postgres.bki");
    await stat(candidatePath);
    return sharedir;
  } catch (error) {
    if (isRuntimeInstallDeadlineError(error)) throw error;
    return null;
  }
}

function resolveRuntimePostgresShareDir(binDir: string, templateDir: string): string {
  const adjacentShareDir = path.resolve(binDir, "..", "share");
  return pathIsInside(templateDir, adjacentShareDir)
    ? adjacentShareDir
    : templateDir;
}

async function assertRuntimePostgresBinDirComplete(
  cacheDir: string,
  binDir: string,
  deadline?: RuntimeInstallDeadline,
): Promise<void> {
  const requiredBinaries = ["initdb", "pg_ctl", "postgres"] as const;
  const missing: string[] = [];
  for (const binary of requiredBinaries) {
    remainingRuntimeInstallMs(deadline, cacheDir, "validate PostgreSQL runtime binaries");
    const binaryPath = path.join(binDir, runtimePostgresExecutableName(binary));
    try {
      await stat(binaryPath);
    } catch {
      missing.push(binaryPath);
    }
  }
  const templateDir = await resolveRuntimePostgresTemplateDir(binDir, cacheDir, deadline);
  if (!templateDir) {
    missing.push(path.join(binDir, "..", "share", "postgresql", "postgres.bki"));
  } else {
    try {
      await stat(path.join(templateDir, "postgresql.conf.sample"));
    } catch {
      missing.push(path.join(templateDir, "postgresql.conf.sample"));
    }
    const shareDir = resolveRuntimePostgresShareDir(binDir, templateDir);
    const hasTimezoneDir = (await Promise.all([
      path.join(templateDir, "timezone"),
      path.join(shareDir, "timezone"),
    ].map((candidate) => stat(candidate).catch(() => null))))
      .some((candidate) => candidate?.isDirectory());
    if (!hasTimezoneDir) missing.push(path.join(shareDir, "timezone"));
  }
  if (missing.length > 0) {
    throw new RuntimeInstallError(
      `${RUDDER_POSTGRES_BIN_DIR_ENV} must contain PostgreSQL 18.4 initdb, pg_ctl, postgres binaries, initdb templates, and runtime support files; missing ${missing.join(", ")}`,
      { cacheDir, command: "validate PostgreSQL 18.4 runtime payload", output: "" },
    );
  }
}

function readPostgresVersion(postgresBinary: string, timeout?: number): string {
  return execFileSync(postgresBinary, ["--version"], {
    encoding: "utf8",
    ...(timeout === undefined ? {} : { timeout }),
  });
}

async function isRuntimePostgresPayloadUsable(
  cacheDir: string,
  binDir: string,
  postgresVersionProbe: RuntimePostgresVersionProbe,
  deadline?: RuntimeInstallDeadline,
): Promise<boolean> {
  try {
    await validateRuntimePostgresVersion(cacheDir, binDir, postgresVersionProbe, deadline);
    return true;
  } catch (error) {
    if (isRuntimeInstallDeadlineError(error)) throw error;
    return false;
  }
}

function pathIsInside(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function copyRuntimePayloadEntry(
  sourcePath: string,
  targetPath: string,
  cacheDir: string,
  deadline: RuntimeInstallDeadline | undefined,
  signal: AbortSignal,
  command: string,
): Promise<void> {
  if (signal.aborted) throw runtimeInstallDeadlineError(cacheDir, command);
  remainingRuntimeInstallMs(deadline, cacheDir, command);
  const sourceStats = await stat(sourcePath);
  if (signal.aborted) throw runtimeInstallDeadlineError(cacheDir, command);
  remainingRuntimeInstallMs(deadline, cacheDir, command);

  if (sourceStats.isDirectory()) {
    await mkdir(targetPath, { recursive: true });
    const entries = await readdir(sourcePath);
    for (const entry of entries) {
      await copyRuntimePayloadEntry(
        path.join(sourcePath, entry),
        path.join(targetPath, entry),
        cacheDir,
        deadline,
        signal,
        command,
      );
    }
    return;
  }
  if (!sourceStats.isFile()) return;

  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await pipeline(
      createReadStream(sourcePath),
      createWriteStream(targetPath, { flags: "w", mode: sourceStats.mode }),
      { signal },
    );
    await chmod(targetPath, sourceStats.mode);
    remainingRuntimeInstallMs(deadline, cacheDir, command);
  } catch (error) {
    await rm(targetPath, { force: true });
    if (signal.aborted || isRuntimeInstallDeadlineError(error)) {
      throw runtimeInstallDeadlineError(cacheDir, command);
    }
    throw error;
  }
}

async function copyRuntimePostgresPayloadWithinDeadline(
  sourceRuntimeDir: string,
  targetRuntimeDir: string,
  sourceShareDir: string,
  cacheDir: string,
  deadline?: RuntimeInstallDeadline,
  externalSignal?: AbortSignal,
): Promise<void> {
  const command = "copy PostgreSQL runtime payload";
  const timeoutMs = remainingRuntimeInstallMs(deadline, cacheDir, command);
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = timeoutMs === undefined
    ? null
    : new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(runtimeInstallDeadlineError(cacheDir, command));
        }, timeoutMs);
      });
  const copyPromise = (async () => {
    await mkdir(targetRuntimeDir, { recursive: true });
    for (const directoryName of ["bin", "lib"] as const) {
      const sourceDirectory = path.join(sourceRuntimeDir, directoryName);
      if (!await stat(sourceDirectory).catch(() => null)) continue;
      await copyRuntimePayloadEntry(
        sourceDirectory,
        path.join(targetRuntimeDir, directoryName),
        cacheDir,
        deadline,
        controller.signal,
        command,
      );
    }
    await copyRuntimePayloadEntry(
      sourceShareDir,
      path.join(targetRuntimeDir, "share"),
      cacheDir,
      deadline,
      controller.signal,
      command,
    );
  })();
  try {
    if (timeoutPromise) await Promise.race([copyPromise, timeoutPromise]);
    else await copyPromise;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

async function withRuntimeFilesystemLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    deadline?: RuntimeInstallDeadline;
    cacheDir?: string;
    command?: string;
  } = {},
): Promise<T> {
  const deadlineTimeout = remainingRuntimeInstallMs(
    options.deadline,
    options.cacheDir ?? path.dirname(lockPath),
    options.command ?? `wait for runtime lock ${lockPath}`,
  );
  const timeoutMs = Math.min(options.timeoutMs ?? 30_000, deadlineTimeout ?? Number.POSITIVE_INFINITY);
  const pollMs = options.pollMs ?? 50;
  const startedAt = Date.now();
  const lockId = `${process.pid}-${startedAt}-${Math.random().toString(16).slice(2)}`;
  const ownerPath = path.join(lockPath, "owner.json");
  await mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(
        ownerPath,
        `${JSON.stringify({ pid: process.pid, lockId, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const existing = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown };
        if (typeof existing.pid !== "number" || !isPidRunning(existing.pid)) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        const lockStats = await stat(lockPath).catch(() => null);
        if (lockStats && Date.now() - lockStats.mtimeMs > 5_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new RuntimeInstallError(
          `Timed out waiting for PostgreSQL runtime install lock ${lockPath}`,
          { cacheDir: path.dirname(lockPath), command: "prepare shared PostgreSQL runtime", output: "" },
        );
      }
      remainingRuntimeInstallMs(
        options.deadline,
        options.cacheDir ?? path.dirname(lockPath),
        options.command ?? `wait for runtime lock ${lockPath}`,
      );
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  try {
    return await task();
  } finally {
    try {
      const existing = JSON.parse(await readFile(ownerPath, "utf8")) as { lockId?: unknown };
      if (existing.lockId === lockId) {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch {
      // A replaced or already-removed lock does not belong to this caller.
    }
  }
}

function isManagedRuntimePostgresBinDir(binDir: string, homeDir: string): boolean {
  const managedBinDir = process.env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV]?.trim();
  if (managedBinDir && path.resolve(managedBinDir) === path.resolve(binDir)) return true;

  const runtimesRelative = path.relative(
    path.join(homeDir, "runtimes"),
    path.resolve(binDir),
  );
  const runtimeSegments = runtimesRelative.split(path.sep);
  if (
    runtimesRelative !== ""
    && runtimesRelative !== ".."
    && !runtimesRelative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(runtimesRelative)
    && runtimeSegments.length === 4
    && runtimeSegments[0]?.length > 0
    && runtimeSegments[1] === RUNTIME_POSTGRES_PAYLOAD_DIR
    && runtimeSegments[2] === `${process.platform}-${process.arch}`
    && runtimeSegments[3] === "bin"
  ) {
    return true;
  }

  const payloadsRelative = path.relative(
    path.join(homeDir, "runtime-payloads"),
    path.resolve(binDir),
  );
  const payloadSegments = payloadsRelative.split(path.sep);
  return (
    payloadsRelative !== ""
    && payloadsRelative !== ".."
    && !payloadsRelative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(payloadsRelative)
    && payloadSegments.length === 3
    && payloadSegments[0] === RUNTIME_POSTGRES_PAYLOAD_DIR
    && payloadSegments[1] === `${process.platform}-${process.arch}`
    && payloadSegments[2] === "bin"
  );
}

async function findLegacyRuntimePostgresBinDir(
  cacheDir: string,
  homeDir: string,
  postgresVersionProbe: RuntimePostgresVersionProbe,
  deadline?: RuntimeInstallDeadline,
): Promise<string | null> {
  const runtimesRoot = path.join(homeDir, "runtimes");
  const entries = await readdir(runtimesRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidateCacheDir = path.join(runtimesRoot, entry.name);
    if (path.resolve(candidateCacheDir) === path.resolve(cacheDir)) continue;
    const candidateBinDir = resolveRuntimePostgresPayloadBinDir(candidateCacheDir);
    remainingRuntimeInstallMs(deadline, cacheDir, "find cached PostgreSQL runtime payload");
    if (await isRuntimePostgresPayloadUsable(cacheDir, candidateBinDir, postgresVersionProbe, deadline)) {
      return candidateBinDir;
    }
  }
  return null;
}

async function readLiveRuntimeDescriptors(homeDir: string): Promise<Array<{
  version: string;
  postgresBinDir?: string;
}>> {
  const instancesRoot = path.join(homeDir, "instances");
  const entries = await readdir(instancesRoot, { withFileTypes: true }).catch(() => []);
  const descriptors: Array<{ version: string; postgresBinDir?: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(instancesRoot, entry.name, "runtime", "server.json"), "utf8")) as Record<string, unknown>;
      if (
        typeof raw.pid !== "number"
        || !Number.isInteger(raw.pid)
        || !isPidRunning(raw.pid)
        || typeof raw.version !== "string"
      ) {
        continue;
      }
      descriptors.push({
        version: raw.version,
        ...(typeof raw.postgresBinDir === "string" ? { postgresBinDir: raw.postgresBinDir } : {}),
      });
    } catch {
      // Missing and malformed descriptors do not describe a live instance.
    }
  }
  return descriptors;
}

async function assertSharedPostgresPayloadNotLive(
  cacheDir: string,
  homeDir: string,
  sharedBinDir: string,
): Promise<void> {
  const liveDescriptors = await readLiveRuntimeDescriptors(homeDir);
  const sharedPhysicalBinDir = await realpath(sharedBinDir).catch(() => null);
  const mayReferenceSharedPayload = await Promise.all(liveDescriptors.map(async (descriptor) => {
    if (descriptor.postgresBinDir === undefined) return true;
    if (path.resolve(descriptor.postgresBinDir) === path.resolve(sharedBinDir)) return true;
    const descriptorPhysicalBinDir = await realpath(descriptor.postgresBinDir).catch(() => null);
    if (
      descriptorPhysicalBinDir
      && sharedPhysicalBinDir
      && path.resolve(descriptorPhysicalBinDir) === path.resolve(sharedPhysicalBinDir)
    ) {
      return true;
    }
    if (!descriptorPhysicalBinDir) {
      return (
        pathIsInside(descriptor.postgresBinDir, path.join(homeDir, "runtimes"))
        || pathIsInside(descriptor.postgresBinDir, path.join(homeDir, "runtime-payloads"))
      );
    }
    return false;
  }));
  if (mayReferenceSharedPayload.some(Boolean)) {
    throw new RuntimeInstallError(
      "Refusing to replace a damaged shared PostgreSQL payload while a live Rudder runtime may be using it",
      { cacheDir, command: "repair shared PostgreSQL runtime", output: sharedBinDir },
    );
  }
}

async function validateRuntimePostgresVersion(
  cacheDir: string,
  binDir: string,
  postgresVersionProbe: RuntimePostgresVersionProbe,
  deadline?: RuntimeInstallDeadline,
): Promise<void> {
  await assertRuntimePostgresBinDirComplete(cacheDir, binDir, deadline);
  for (const binary of ["initdb", "pg_ctl", "postgres"] as const) {
    remainingRuntimeInstallMs(deadline, cacheDir, "validate PostgreSQL runtime version");
    const binaryPath = path.join(binDir, runtimePostgresExecutableName(binary));
    const result = postgresVersionProbe(binaryPath);
    if (!/\bPostgreSQL\)?\s+18\.4\b/i.test(result)) {
      throw new RuntimeInstallError(
        `${RUDDER_POSTGRES_BIN_DIR_ENV} must contain PostgreSQL 18.4 production binaries; got ${result.trim() || "unknown version"}`,
        { cacheDir, command: `${binaryPath} --version`, output: result },
      );
    }
  }
}

function extractRuntimePostgresArchive(
  archivePath: string,
  extractDir: string,
  cacheDir: string,
  deadline?: RuntimeInstallDeadline,
): void {
  const timeout = remainingRuntimeInstallMs(deadline, cacheDir, "extract PostgreSQL runtime archive");
  const result = process.platform === "win32"
    ? spawnSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:PG_ARCHIVE_PATH -DestinationPath $env:PG_EXTRACT_DIR -Force",
      ], {
        encoding: "utf8",
        env: { ...process.env, PG_ARCHIVE_PATH: archivePath, PG_EXTRACT_DIR: extractDir },
        windowsHide: true,
        ...(timeout === undefined ? {} : { timeout }),
      })
    : spawnSync("tar", ["-xf", archivePath, "-C", extractDir], {
        encoding: "utf8",
        ...(timeout === undefined ? {} : { timeout }),
      });
  if (result.status !== 0) {
    throw new Error(`failed to extract PostgreSQL archive: ${result.stderr || result.stdout}`);
  }
}

async function findRuntimePostgresBinDir(
  rootDir: string,
  cacheDir: string,
  postgresVersionProbe: RuntimePostgresVersionProbe,
  deadline?: RuntimeInstallDeadline,
): Promise<string | null> {
  const queue = [rootDir];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    remainingRuntimeInstallMs(deadline, cacheDir, "find PostgreSQL runtime payload");
    if (await isRuntimePostgresPayloadUsable(cacheDir, current, postgresVersionProbe, deadline)) return current;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
    }
  }
  return null;
}

async function reconcileSharedPostgresPayloadGenerations(
  cacheDir: string,
  sharedPlatformRoot: string,
  postgresVersionProbe: RuntimePostgresVersionProbe,
  cleanupDownloads = false,
  deadline?: RuntimeInstallDeadline,
): Promise<void> {
  remainingRuntimeInstallMs(deadline, cacheDir, "reconcile shared PostgreSQL payload");
  const parentDir = path.dirname(sharedPlatformRoot);
  const baseName = path.basename(sharedPlatformRoot);
  const entries = await readdir(parentDir, { withFileTypes: true }).catch(() => []);
  const temporaryRoots = entries
    .filter((entry) => entry.name.startsWith(`${baseName}.tmp-`))
    .map((entry) => path.join(parentDir, entry.name));
  const previousRoots = entries
    .filter((entry) => entry.name.startsWith(`${baseName}.previous-`))
    .map((entry) => path.join(parentDir, entry.name))
    .sort()
    .reverse();
  const downloadsRoot = path.join(
    path.dirname(path.dirname(sharedPlatformRoot)),
    ".downloads",
  );
  const staleDownloadRoots = cleanupDownloads
    ? (
        await readdir(downloadsRoot, { withFileTypes: true }).catch(() => [])
      )
      .filter((entry) => entry.name.startsWith("postgres-18.4-"))
      .map((entry) => path.join(downloadsRoot, entry.name))
    : [];
  const canonicalBinDir = path.join(sharedPlatformRoot, "bin");

  if (!await isRuntimePostgresPayloadUsable(
    cacheDir,
    canonicalBinDir,
    postgresVersionProbe,
    deadline,
  )) {
    for (const previousRoot of previousRoots) {
      if (!await isRuntimePostgresPayloadUsable(
        cacheDir,
        path.join(previousRoot, "bin"),
        postgresVersionProbe,
        deadline,
      )) {
        continue;
      }
      await rm(sharedPlatformRoot, { recursive: true, force: true });
      await rename(previousRoot, sharedPlatformRoot);
      break;
    }
  }

  await Promise.all([
    ...temporaryRoots.map((candidate) => rm(candidate, { recursive: true, force: true })),
    ...previousRoots.map((candidate) => rm(candidate, { recursive: true, force: true })),
    ...staleDownloadRoots.map((candidate) => rm(candidate, { recursive: true, force: true })),
  ]);
}

async function installSharedRuntimePostgresPayload(
  cacheDir: string,
  homeDir: string,
  sourceBinDir: string,
  postgresVersionProbe: RuntimePostgresVersionProbe,
  deadline?: RuntimeInstallDeadline,
): Promise<string> {
  const sharedBinDir = resolveSharedRuntimePostgresPayloadBinDir(homeDir);
  const sharedRuntimeDir = path.dirname(sharedBinDir);
  const sharedPlatformRoot = sharedRuntimeDir;
  const sourceRuntimeDir = path.dirname(sourceBinDir);
  const sourceTemplateDir = await resolveRuntimePostgresTemplateDir(sourceBinDir, cacheDir, deadline);
  if (!sourceTemplateDir) {
    throw new RuntimeInstallError(
      `${RUDDER_POSTGRES_BIN_DIR_ENV} must contain PostgreSQL 18.4 initdb template files`,
      { cacheDir, command: "validate PostgreSQL 18.4 runtime payload", output: "" },
    );
  }

  const lockPath = `${sharedPlatformRoot}.install.lock`;
  return withRuntimeFilesystemLock(lockPath, async () => {
    await reconcileSharedPostgresPayloadGenerations(
      cacheDir,
      sharedPlatformRoot,
      postgresVersionProbe,
      false,
      deadline,
    );
    if (await isRuntimePostgresPayloadUsable(cacheDir, sharedBinDir, postgresVersionProbe, deadline)) {
      return sharedBinDir;
    }
    await assertSharedPostgresPayloadNotLive(cacheDir, homeDir, sharedBinDir);
    await mkdir(path.dirname(sharedPlatformRoot), { recursive: true });
    const temporaryPlatformRoot = `${sharedPlatformRoot}.tmp-${process.pid}-${Date.now()}`;
    const previousPlatformRoot = `${sharedPlatformRoot}.previous-${process.pid}-${Date.now()}`;
    let previousMoved = false;
    let published = false;
    await rm(temporaryPlatformRoot, { recursive: true, force: true });
    await rm(previousPlatformRoot, { recursive: true, force: true });
    try {
      const temporaryRuntimeDir = temporaryPlatformRoot;
      const sourceShareDir = resolveRuntimePostgresShareDir(sourceBinDir, sourceTemplateDir);
      await copyRuntimePostgresPayloadWithinDeadline(
        sourceRuntimeDir,
        temporaryRuntimeDir,
        sourceShareDir,
        cacheDir,
        deadline,
      );
      const temporaryBinDir = path.join(temporaryRuntimeDir, "bin");
      await validateRuntimePostgresVersion(cacheDir, temporaryBinDir, postgresVersionProbe, deadline);
      try {
        await rename(sharedPlatformRoot, previousPlatformRoot);
        previousMoved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(temporaryPlatformRoot, sharedPlatformRoot);
        published = true;
      } catch (error) {
        if (previousMoved) {
          await rename(previousPlatformRoot, sharedPlatformRoot);
          previousMoved = false;
        }
        throw error;
      }
      if (previousMoved) {
        await rm(previousPlatformRoot, { recursive: true, force: true });
        previousMoved = false;
      }
    } finally {
      await rm(temporaryPlatformRoot, { recursive: true, force: true });
      if (published || !previousMoved) {
        await rm(previousPlatformRoot, { recursive: true, force: true });
      }
    }
    return sharedBinDir;
  }, { deadline, cacheDir, command: "acquire shared PostgreSQL install lock" });
}

async function downloadSharedRuntimePostgresPayload(
  cacheDir: string,
  homeDir: string,
  postgresVersionProbe: RuntimePostgresVersionProbe,
  deadline?: RuntimeInstallDeadline,
  cleanupWorkDir?: (workDir: string) => Promise<void>,
): Promise<string | null> {
  const archiveSource = resolvePostgresRuntimeArchiveSource();
  const archiveUrl = archiveSource?.url ?? null;
  if (!archiveUrl) return null;
  const sharedBinDir = resolveSharedRuntimePostgresPayloadBinDir(homeDir);
  const sharedPlatformRoot = path.dirname(sharedBinDir);
  const downloadLockPath = `${sharedPlatformRoot}.download.lock`;
  return withRuntimeFilesystemLock(downloadLockPath, async () => {
    if (await isRuntimePostgresPayloadUsable(cacheDir, sharedBinDir, postgresVersionProbe, deadline)) {
      return sharedBinDir;
    }
    const workRoot = path.join(homeDir, "runtime-payloads", ".downloads");
    await mkdir(workRoot, { recursive: true });
    const workDir = await mkdtemp(path.join(workRoot, "postgres-18.4-"));
    const archivePath = path.join(workDir, "postgresql-18.4.zip");
    const extractDir = path.join(workDir, "extract");
    try {
      await downloadRuntimePostgresArchive(
        archiveUrl,
        archivePath,
        archiveSource?.expectedSha256,
        { timeoutMs: remainingRuntimeInstallMs(deadline, cacheDir, "download PostgreSQL runtime archive") },
      );

      const configuredMaxBytes = Number.parseInt(process.env[RUDDER_POSTGRES_RUNTIME_ARCHIVE_MAX_BYTES_ENV] ?? "", 10);
      const maxArchiveBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0
        ? configuredMaxBytes
        : DEFAULT_RUNTIME_POSTGRES_ARCHIVE_MAX_BYTES;
      const nativePublishStaging = `${sharedPlatformRoot}.tmp-native-${process.pid}-${Date.now()}`;
      await mkdir(path.dirname(sharedPlatformRoot), { recursive: true });
      const nativeInstall = await tryInstallNativePayload({
        archivePath,
        extractPath: extractDir,
        publishStagingPath: nativePublishStaging,
        destinationPath: sharedPlatformRoot,
        maxArchiveBytes,
        expectedSha256: archiveSource?.expectedSha256,
        timeoutMs: remainingRuntimeInstallMs(deadline, cacheDir, "prepare native PostgreSQL runtime payload"),
        now: deadline?.now,
        preparePublish: async (nativeExtractPath, publishStagingPath, context) => {
          const extractedBinDir = await findRuntimePostgresBinDir(
            nativeExtractPath,
            cacheDir,
            postgresVersionProbe,
            deadline,
          );
          if (!extractedBinDir) {
            throw new RuntimeInstallError(
              "PostgreSQL 18.4 archive did not contain a complete verified runtime",
              { cacheDir, command: "prepare native PostgreSQL runtime payload", output: "" },
            );
          }
          await validateRuntimePostgresVersion(cacheDir, extractedBinDir, postgresVersionProbe, deadline);
          const templateDir = await resolveRuntimePostgresTemplateDir(extractedBinDir, cacheDir, deadline);
          if (!templateDir) {
            throw new RuntimeInstallError(
              "PostgreSQL 18.4 archive did not contain initdb template files",
              { cacheDir, command: "prepare native PostgreSQL runtime payload", output: "" },
            );
          }
          await copyRuntimePostgresPayloadWithinDeadline(
            path.dirname(extractedBinDir),
            publishStagingPath,
            resolveRuntimePostgresShareDir(extractedBinDir, templateDir),
            cacheDir,
            deadline,
            context.signal,
          );
          return path.relative(
            publishStagingPath,
            path.join(publishStagingPath, "bin", runtimePostgresExecutableName("postgres")),
          );
        },
        validatePublished: async (destinationPath) => {
          await validateRuntimePostgresVersion(
            cacheDir,
            path.join(destinationPath, "bin"),
            postgresVersionProbe,
            deadline,
          );
        },
      });
      if (nativeInstall.installed) {
        return sharedBinDir;
      }

      // The native path may safely decline before staging/acceptance (for
      // example when a trusted archive digest is unavailable in auto mode).
      // Only then use the existing Node extractor and publication path.
      await mkdir(extractDir, { recursive: true });
      extractRuntimePostgresArchive(archivePath, extractDir, cacheDir, deadline);
      const extractedBinDir = await findRuntimePostgresBinDir(
        extractDir,
        cacheDir,
        postgresVersionProbe,
        deadline,
      );
      if (!extractedBinDir) {
        throw new RuntimeInstallError(
          "PostgreSQL 18.4 archive did not contain a complete verified runtime",
          { cacheDir, command: `download ${archiveUrl}`, output: "" },
        );
      }
      return await installSharedRuntimePostgresPayload(
        cacheDir,
        homeDir,
        extractedBinDir,
        postgresVersionProbe,
        deadline,
      );
    } finally {
      const cleanup = cleanupWorkDir
        ?? ((candidate: string) => rm(candidate, { recursive: true, force: true }));
      // This directory is unique to the current download and is never
      // published or reused. Its deletion must not extend the 90-second
      // Desktop runtime budget or delay full-asset fallback.
      void cleanup(workDir).catch(() => {});
    }
  }, { deadline, cacheDir, command: "acquire shared PostgreSQL download lock" });
}

async function ensureRuntimePostgresCompatibilityLink(
  cacheDir: string,
  homeDir: string,
  packageVersion: string,
): Promise<void> {
  const compatibilityRoot = path.join(cacheDir, RUNTIME_POSTGRES_PAYLOAD_DIR);
  const sharedPayloadRoot = path.join(homeDir, "runtime-payloads", RUNTIME_POSTGRES_PAYLOAD_DIR);
  const runtimeMetadata = await readRuntimeInstallMetadata(cacheDir);
  const liveDescriptors = await readLiveRuntimeDescriptors(homeDir);
  const compatibilityBinDir = resolveRuntimePostgresPayloadBinDir(cacheDir);
  const isProtected = liveDescriptors.some((descriptor) => (
    (descriptor.postgresBinDir
      && pathIsInside(descriptor.postgresBinDir, compatibilityRoot))
    || (
      !descriptor.postgresBinDir
      && descriptor.version === (runtimeMetadata?.packageVersion ?? packageVersion)
    )
  ));
  if (isProtected) return;
  await mkdir(path.dirname(compatibilityRoot), { recursive: true });
  const temporaryRoot = `${compatibilityRoot}.next-${process.pid}-${Date.now()}`;
  const previousRoot = `${compatibilityRoot}.previous-${process.pid}-${Date.now()}`;
  await rm(temporaryRoot, { recursive: true, force: true });
  await rm(previousRoot, { recursive: true, force: true });
  await symlink(
    process.platform === "win32"
      ? sharedPayloadRoot
      : path.relative(path.dirname(compatibilityRoot), sharedPayloadRoot),
    temporaryRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
  let previousMoved = false;
  try {
    try {
      await rename(compatibilityRoot, previousRoot);
      previousMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(temporaryRoot, compatibilityRoot);
    } catch (error) {
      if (previousMoved) {
        await rename(previousRoot, compatibilityRoot);
        previousMoved = false;
      }
      throw error;
    }
    if (previousMoved) {
      await rm(previousRoot, { recursive: true, force: true });
      previousMoved = false;
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    if (!previousMoved) await rm(previousRoot, { recursive: true, force: true });
  }
}

async function stageRuntimePostgresPayload(
  cacheDir: string,
  homeDir: string,
  packageVersion: string,
  enabled: boolean,
  postgresVersionProbe: RuntimePostgresVersionProbe,
  deadline?: RuntimeInstallDeadline,
  cleanupDownloadWorkDir?: (workDir: string) => Promise<void>,
): Promise<RuntimePostgresPayloadStageResult> {
  if (!enabled) return { output: "" };
  const explicitSourceBinDir = process.env[RUDDER_POSTGRES_BIN_DIR_ENV]?.trim();
  const resolvedExplicitSourceBinDir = explicitSourceBinDir
    ? path.resolve(explicitSourceBinDir)
    : null;
  if (
    resolvedExplicitSourceBinDir
    && !isManagedRuntimePostgresBinDir(resolvedExplicitSourceBinDir, homeDir)
  ) {
    await validateRuntimePostgresVersion(
      cacheDir,
      resolvedExplicitSourceBinDir,
      postgresVersionProbe,
      deadline,
    );
    return {
      output: "",
      binDir: resolvedExplicitSourceBinDir,
      metadata: {
        version: "18.4",
        platform: process.platform,
        arch: process.arch,
        binDir: resolvedExplicitSourceBinDir,
        scope: "external",
      },
    };
  }

  const sharedBinDir = resolveSharedRuntimePostgresPayloadBinDir(homeDir);
  const sharedPlatformRoot = path.dirname(sharedBinDir);
  await withRuntimeFilesystemLock(
    `${sharedPlatformRoot}.install.lock`,
    async () => reconcileSharedPostgresPayloadGenerations(
      cacheDir,
      sharedPlatformRoot,
      postgresVersionProbe,
      true,
      deadline,
    ),
    { deadline, cacheDir, command: "reconcile shared PostgreSQL payload" },
  );
  let output = "";
  if (!await isRuntimePostgresPayloadUsable(cacheDir, sharedBinDir, postgresVersionProbe, deadline)) {
    const sourceBinDir = resolvedExplicitSourceBinDir
      ?? await findLegacyRuntimePostgresBinDir(cacheDir, homeDir, postgresVersionProbe, deadline);
    if (sourceBinDir) {
      await validateRuntimePostgresVersion(
        cacheDir,
        sourceBinDir,
        postgresVersionProbe,
        deadline,
      );
      await installSharedRuntimePostgresPayload(
        cacheDir,
        homeDir,
        sourceBinDir,
        postgresVersionProbe,
        deadline,
      );
    } else if (!await downloadSharedRuntimePostgresPayload(
      cacheDir,
      homeDir,
      postgresVersionProbe,
      deadline,
      cleanupDownloadWorkDir,
    )) {
      return { output: "" };
    }
    output = `prepared shared PostgreSQL 18.4 runtime payload at ${sharedBinDir}`;
  }

  await ensureRuntimePostgresCompatibilityLink(cacheDir, homeDir, packageVersion);
  const metadata: RuntimeInstallMetadata["postgresRuntime"] = {
    version: "18.4",
    platform: process.platform,
    arch: process.arch,
    binDir: sharedBinDir,
    scope: "shared",
  };
  return {
    output,
    binDir: sharedBinDir,
    metadata,
  };
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
