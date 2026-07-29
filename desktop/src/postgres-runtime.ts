import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSharedRudderHomeDir } from "./runtime-cache.js";

export const DESKTOP_POSTGRES_RUNTIME_DIR = "postgres-18.4";
export const RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV = "RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR";
export const RUDDER_POSTGRES_BIN_DIR_ENV = "RUDDER_POSTGRES_BIN_DIR";
export const DEFAULT_INCOMPLETE_RUNTIME_GRACE_MS = 60 * 60 * 1000;

export function desktopPostgresPlatformSegment(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  return `${platform}-${arch}`;
}

function postgresExecutableName(
  baseName: "initdb" | "pg_ctl" | "postgres",
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? `${baseName}.exe` : baseName;
}

function postgresTemplateCandidates(binDir: string): string[] {
  return [
    path.join(binDir, "..", "share", "postgresql", "postgres.bki"),
    path.join(binDir, "..", "share", "postgres.bki"),
  ];
}

function postgresConfigTemplateCandidates(binDir: string): string[] {
  return [
    path.join(binDir, "..", "share", "postgresql", "postgresql.conf.sample"),
    path.join(binDir, "..", "share", "postgresql.conf.sample"),
  ];
}

function postgresTimezoneCandidates(binDir: string): string[] {
  return [
    path.join(binDir, "..", "share", "postgresql", "timezone"),
    path.join(binDir, "..", "share", "timezone"),
  ];
}

function isCompletePostgresBinDir(binDir: string, options: {
  platform?: NodeJS.Platform;
  validateVersion?: boolean;
} = {}): boolean {
  const platform = options.platform ?? process.platform;
  for (const binary of ["initdb", "pg_ctl", "postgres"] as const) {
    if (!fs.existsSync(path.join(binDir, postgresExecutableName(binary, platform)))) return false;
  }
  if (!postgresTemplateCandidates(binDir).some((candidatePath) => fs.existsSync(candidatePath))) return false;
  if (!postgresConfigTemplateCandidates(binDir).some((candidatePath) => fs.existsSync(candidatePath))) return false;
  if (!postgresTimezoneCandidates(binDir).some(
    (candidatePath) => fs.statSync(candidatePath, { throwIfNoEntry: false })?.isDirectory(),
  )) return false;
  if (options.validateVersion === false) return true;
  try {
    for (const binary of ["initdb", "pg_ctl", "postgres"] as const) {
      const binaryPath = path.join(binDir, postgresExecutableName(binary, platform));
      const output = execFileSync(binaryPath, ["--version"], { encoding: "utf8" });
      if (!/\bPostgreSQL\)?\s+18\.4\b/i.test(output)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveDesktopPostgresBinDir(rootDir: string, options: {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  validateVersion?: boolean;
} = {}): string | null {
  const binDir = path.resolve(
    rootDir,
    DESKTOP_POSTGRES_RUNTIME_DIR,
    desktopPostgresPlatformSegment(options.platform, options.arch),
    "bin",
  );
  return isCompletePostgresBinDir(binDir, options) ? binDir : null;
}

type DesktopPostgresResolutionOptions = {
  isPackaged: boolean;
  resourcesPath: string;
  externalRuntimeCacheDir?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  validateVersion?: boolean;
};

function pathsMatch(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function pathIsInside(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isVersionedRudderRuntimePostgresBinDir(
  binDir: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const runtimesRoot = path.join(resolveSharedRudderHomeDir(env), "runtimes");
  const relative = path.relative(runtimesRoot, path.resolve(binDir));
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return false;
  }
  const segments = relative.split(path.sep);
  return (
    segments.length === 4
    && segments[0]?.length > 0
    && segments[1] === DESKTOP_POSTGRES_RUNTIME_DIR
    && segments[2]?.length > 0
    && segments[3] === "bin"
  );
}

function isSharedRudderRuntimePostgresBinDir(
  binDir: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const payloadsRoot = path.join(resolveSharedRudderHomeDir(env), "runtime-payloads");
  const relative = path.relative(payloadsRoot, path.resolve(binDir));
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return false;
  }
  const segments = relative.split(path.sep);
  return (
    segments.length === 3
    && segments[0] === DESKTOP_POSTGRES_RUNTIME_DIR
    && segments[1]?.length > 0
    && segments[2] === "bin"
  );
}

export function isDesktopManagedPostgresBinDir(options: {
  binDir: string;
  resourcesPath: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = options.env ?? process.env;
  const managedBinDir = env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV]?.trim();
  if (managedBinDir && pathsMatch(options.binDir, managedBinDir)) return true;
  return (
    pathIsInside(
      options.binDir,
      path.join(options.resourcesPath, DESKTOP_POSTGRES_RUNTIME_DIR),
    )
    || isSharedRudderRuntimePostgresBinDir(options.binDir, env)
    || isVersionedRudderRuntimePostgresBinDir(options.binDir, env)
  );
}

export function resolvePreferredDesktopPostgresBinDir(
  options: DesktopPostgresResolutionOptions,
): string | null {
  const env = options.env ?? process.env;
  const currentBinDir = env[RUDDER_POSTGRES_BIN_DIR_ENV]?.trim();
  if (
    currentBinDir
    && !isDesktopManagedPostgresBinDir({
      binDir: currentBinDir,
      resourcesPath: options.resourcesPath,
      env,
    })
  ) {
    return null;
  }
  if (!options.isPackaged) return null;

  const sharedPayloadRoot = path.join(resolveSharedRudderHomeDir(env), "runtime-payloads");
  const sharedBinDir = resolveDesktopPostgresBinDir(sharedPayloadRoot, options);
  if (sharedBinDir) return sharedBinDir;

  if (options.externalRuntimeCacheDir) {
    const cachedBinDir = resolveDesktopPostgresBinDir(options.externalRuntimeCacheDir, options);
    if (cachedBinDir) return cachedBinDir;
  }

  return resolveDesktopPostgresBinDir(options.resourcesPath, options);
}

export function reconcileDesktopPostgresBinDir(
  options: DesktopPostgresResolutionOptions,
): string | null {
  const env = options.env ?? process.env;
  const currentBinDir = env[RUDDER_POSTGRES_BIN_DIR_ENV]?.trim();
  const currentIsManaged = Boolean(
    currentBinDir
    && isDesktopManagedPostgresBinDir({
      binDir: currentBinDir,
      resourcesPath: options.resourcesPath,
      env,
    }),
  );
  const preferredBinDir = resolvePreferredDesktopPostgresBinDir(options);

  if (preferredBinDir) {
    env[RUDDER_POSTGRES_BIN_DIR_ENV] = preferredBinDir;
    env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV] = preferredBinDir;
    return preferredBinDir;
  }
  if (currentIsManaged) {
    delete env[RUDDER_POSTGRES_BIN_DIR_ENV];
    delete env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV];
    return null;
  }
  return currentBinDir || null;
}

export function reconcilePackagedDesktopPostgresBinDir(
  resourcesPath: string,
  externalRuntimeCacheDir?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return reconcileDesktopPostgresBinDir({
    isPackaged: true,
    resourcesPath,
    externalRuntimeCacheDir,
    env,
  });
}

type LivePostgresRuntimeDescriptor = {
  instanceId: string;
  version: string;
  postgresBinDir?: string;
  postgresRuntimeKey?: string;
};

function desktopPidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLivePostgresRuntimeDescriptors(
  homeDir: string,
): Promise<LivePostgresRuntimeDescriptor[]> {
  const instancesRoot = path.join(homeDir, "instances");
  const entries = await fs.promises.readdir(instancesRoot, { withFileTypes: true }).catch(() => []);
  const descriptors: LivePostgresRuntimeDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const parsed = JSON.parse(
        await fs.promises.readFile(
          path.join(instancesRoot, entry.name, "runtime", "server.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      if (
        typeof parsed.pid !== "number"
        || !Number.isInteger(parsed.pid)
        || !desktopPidIsRunning(parsed.pid)
        || typeof parsed.instanceId !== "string"
        || typeof parsed.version !== "string"
      ) {
        continue;
      }
      descriptors.push({
        instanceId: parsed.instanceId,
        version: parsed.version,
        ...(typeof parsed.postgresBinDir === "string"
          ? { postgresBinDir: parsed.postgresBinDir }
          : {}),
        ...(typeof parsed.postgresRuntimeKey === "string"
          ? { postgresRuntimeKey: parsed.postgresRuntimeKey }
          : {}),
      });
    } catch {
      // Missing or malformed descriptors cannot prove that a process is live.
    }
  }
  return descriptors;
}

function embeddedPostgresPlatformPackagePath(
  runtimeDir: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string | null {
  let packageName: string | null = null;
  if (platform === "darwin" && arch === "arm64") packageName = "darwin-arm64";
  else if (platform === "darwin" && arch === "x64") packageName = "darwin-x64";
  else if (platform === "linux" && arch === "arm64") packageName = "linux-arm64";
  else if (platform === "linux" && arch === "arm") packageName = "linux-arm";
  else if (platform === "linux" && arch === "ia32") packageName = "linux-ia32";
  else if (platform === "linux" && arch === "ppc64") packageName = "linux-ppc64";
  else if (platform === "linux" && arch === "x64") packageName = "linux-x64";
  else if (platform === "win32" && arch === "x64") packageName = "windows-x64";
  return packageName
    ? path.join(runtimeDir, "node_modules", "@embedded-postgres", packageName)
    : null;
}

export type SharedPostgresFinalizeResult = {
  sharedBinDir: string;
  linkedRuntimeVersions: string[];
  protectedRuntimeVersions: string[];
  removedEmbeddedPlatformPackages: string[];
  removedIncompleteRuntimeVersions: string[];
  removedSharedPayloadVersions: string[];
};

async function replaceRuntimePostgresCompatibilityPath(
  compatibilityRoot: string,
  sharedPayloadRoot: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const temporaryRoot = `${compatibilityRoot}.next-${process.pid}-${Date.now()}`;
  const previousRoot = `${compatibilityRoot}.previous-${process.pid}-${Date.now()}`;
  await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  await fs.promises.rm(previousRoot, { recursive: true, force: true });
  await fs.promises.symlink(
    platform === "win32"
      ? sharedPayloadRoot
      : path.relative(path.dirname(compatibilityRoot), sharedPayloadRoot),
    temporaryRoot,
    platform === "win32" ? "junction" : "dir",
  );
  let previousMoved = false;
  try {
    try {
      await fs.promises.rename(compatibilityRoot, previousRoot);
      previousMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.promises.rename(temporaryRoot, compatibilityRoot);
    } catch (error) {
      if (previousMoved) {
        await fs.promises.rename(previousRoot, compatibilityRoot);
        previousMoved = false;
      }
      throw error;
    }
    if (previousMoved) {
      await fs.promises.rm(previousRoot, { recursive: true, force: true });
      previousMoved = false;
    }
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
    if (!previousMoved) {
      await fs.promises.rm(previousRoot, { recursive: true, force: true });
    }
  }
}

async function acquireDesktopRuntimeInstallLock(
  lockPath: string,
): Promise<(() => Promise<void>) | null> {
  try {
    await fs.promises.mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerPath = path.join(lockPath, "owner.json");
  try {
    await fs.promises.writeFile(
      ownerPath,
      `${JSON.stringify({ pid: process.pid, lockId, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );
  } catch (error) {
    await fs.promises.rm(lockPath, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    try {
      const owner = JSON.parse(await fs.promises.readFile(ownerPath, "utf8")) as {
        lockId?: unknown;
      };
      if (owner.lockId === lockId) {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
      }
    } catch {
      // A replaced or already removed lock no longer belongs to this cleanup.
    }
  };
}

export async function acquireDesktopPostgresLifecycleLock(
  env: NodeJS.ProcessEnv = process.env,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<() => Promise<void>> {
  const homeDir = resolveSharedRudderHomeDir(env);
  const lockPath = path.join(
    homeDir,
    "runtime-payloads",
    ".postgres-runtime.lifecycle.lock",
  );
  const ownerPath = path.join(lockPath, "owner.json");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 50;
  const startedAt = Date.now();
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    const release = await acquireDesktopRuntimeInstallLock(lockPath);
    if (release) return release;

    try {
      const owner = JSON.parse(await fs.promises.readFile(ownerPath, "utf8")) as {
        pid?: unknown;
      };
      if (typeof owner.pid !== "number" || !desktopPidIsRunning(owner.pid)) {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch {
      const stats = await fs.promises.stat(lockPath).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > 5_000) {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
        continue;
      }
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for PostgreSQL runtime lifecycle lock ${lockPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function writeSharedPostgresRuntimeMetadata(options: {
  metadataPath: string;
  metadata: Record<string, unknown>;
  sharedBinDir: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  now: Date;
}): Promise<void> {
  const temporaryPath = `${options.metadataPath}.tmp-${process.pid}-${Date.now()}`;
  const nextMetadata = {
    ...options.metadata,
    lastUsedAt: options.now.toISOString(),
    postgresRuntime: {
      version: "18.4",
      platform: options.platform,
      arch: options.arch,
      binDir: options.sharedBinDir,
      scope: "shared",
    },
  };
  try {
    await fs.promises.writeFile(
      temporaryPath,
      `${JSON.stringify(nextMetadata, null, 2)}\n`,
      "utf8",
    );
    await fs.promises.rename(temporaryPath, options.metadataPath);
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
  }
}

async function finalizeSharedPostgresRuntimeUnlocked(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  validateVersion?: boolean;
  now?: Date;
  incompleteRuntimeGraceMs?: number;
  expectedInstanceId?: string;
  expectedVersion?: string;
} = {}): Promise<SharedPostgresFinalizeResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const homeDir = resolveSharedRudderHomeDir(env);
  const sharedPayloadsRoot = path.join(homeDir, "runtime-payloads");
  const sharedBinDir = resolveDesktopPostgresBinDir(sharedPayloadsRoot, {
    platform,
    arch,
    validateVersion: options.validateVersion,
  });
  if (!sharedBinDir) {
    throw new Error(`Shared PostgreSQL 18.4 payload is incomplete under ${sharedPayloadsRoot}`);
  }

  const runtimeKey = `${DESKTOP_POSTGRES_RUNTIME_DIR}/${desktopPostgresPlatformSegment(platform, arch)}`;
  const liveDescriptors = await readLivePostgresRuntimeDescriptors(homeDir);
  if (!liveDescriptors.some((descriptor) => (
    (options.expectedInstanceId === undefined || descriptor.instanceId === options.expectedInstanceId)
    && (options.expectedVersion === undefined || descriptor.version === options.expectedVersion)
    && descriptor.postgresRuntimeKey === runtimeKey
    && descriptor.postgresBinDir !== undefined
    && pathsMatch(descriptor.postgresBinDir, sharedBinDir)
  ))) {
    throw new Error("Shared PostgreSQL cleanup requires a live runtime descriptor using the verified payload");
  }

  const result: SharedPostgresFinalizeResult = {
    sharedBinDir,
    linkedRuntimeVersions: [],
    protectedRuntimeVersions: [],
    removedEmbeddedPlatformPackages: [],
    removedIncompleteRuntimeVersions: [],
    removedSharedPayloadVersions: [],
  };
  const runtimesRoot = path.join(homeDir, "runtimes");
  const entries = await fs.promises.readdir(runtimesRoot, { withFileTypes: true }).catch(() => []);
  const nowMs = (options.now ?? new Date()).getTime();
  const incompleteRuntimeGraceMs = options.incompleteRuntimeGraceMs
    ?? DEFAULT_INCOMPLETE_RUNTIME_GRACE_MS;
  const sharedPayloadRoot = path.join(sharedPayloadsRoot, DESKTOP_POSTGRES_RUNTIME_DIR);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runtimeDir = path.join(runtimesRoot, entry.name);
    const installLockPath = `${runtimeDir}.install.lock`;
    const releaseInstallLock = await acquireDesktopRuntimeInstallLock(installLockPath);
    if (!releaseInstallLock) {
      result.protectedRuntimeVersions.push(entry.name);
      continue;
    }
    try {
      const metadataPath = path.join(runtimeDir, "runtime.json");
      let metadata: Record<string, unknown> | null = null;
      try {
        metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8")) as Record<string, unknown>;
      } catch {
        metadata = null;
      }
      if (!metadata || typeof metadata.packageVersion !== "string") {
        const runtimeStats = await fs.promises.stat(runtimeDir).catch(() => null);
        const protectedByDescriptor = liveDescriptors.some((descriptor) => descriptor.version === entry.name);
        const fresh = runtimeStats !== null && nowMs - runtimeStats.mtimeMs < incompleteRuntimeGraceMs;
        if (!protectedByDescriptor && !fresh) {
          await fs.promises.rm(runtimeDir, { recursive: true, force: true });
          result.removedIncompleteRuntimeVersions.push(entry.name);
        } else if (protectedByDescriptor) {
          result.protectedRuntimeVersions.push(entry.name);
        }
        continue;
      }

      const packageVersion = metadata.packageVersion;
      const postgresRuntime = (
        metadata.postgresRuntime
        && typeof metadata.postgresRuntime === "object"
        && !Array.isArray(metadata.postgresRuntime)
      )
        ? metadata.postgresRuntime as Record<string, unknown>
        : null;
      if (postgresRuntime?.scope === "external") {
        result.protectedRuntimeVersions.push(packageVersion);
        continue;
      }
      const compatibilityRoot = path.join(runtimeDir, DESKTOP_POSTGRES_RUNTIME_DIR);
      const compatibilityBinDir = path.join(
        compatibilityRoot,
        desktopPostgresPlatformSegment(platform, arch),
        "bin",
      );
      const protectedByDescriptor = liveDescriptors.some((descriptor) => (
        (descriptor.postgresBinDir !== undefined
          && pathIsInside(descriptor.postgresBinDir, compatibilityRoot))
        || (descriptor.postgresBinDir === undefined && descriptor.version === packageVersion)
      ));
      if (protectedByDescriptor) {
        result.protectedRuntimeVersions.push(packageVersion);
        continue;
      }

      const compatibilityStats = await fs.promises.lstat(compatibilityRoot).catch(() => null);
      const compatibilityIsCanonical = compatibilityStats?.isSymbolicLink()
        ? await Promise.all([
            fs.promises.realpath(compatibilityRoot),
            fs.promises.realpath(sharedPayloadRoot),
          ]).then(([resolvedCompatibility, resolvedShared]) => (
            pathsMatch(resolvedCompatibility, resolvedShared)
          )).catch(() => false)
        : false;
      if (!compatibilityStats || !compatibilityIsCanonical) {
        await replaceRuntimePostgresCompatibilityPath(
          compatibilityRoot,
          sharedPayloadRoot,
          platform,
        );
        result.linkedRuntimeVersions.push(packageVersion);
      } else if (!isCompletePostgresBinDir(compatibilityBinDir, {
        platform,
        validateVersion: options.validateVersion,
      })) {
        throw new Error(`Runtime ${packageVersion} has a broken PostgreSQL compatibility link`);
      }

      await writeSharedPostgresRuntimeMetadata({
        metadataPath,
        metadata,
        sharedBinDir,
        platform,
        arch,
        now: new Date(nowMs),
      });

      const platformPackagePath = embeddedPostgresPlatformPackagePath(runtimeDir, platform, arch);
      if (platformPackagePath && fs.existsSync(platformPackagePath)) {
        await fs.promises.rm(platformPackagePath, { recursive: true, force: true });
        result.removedEmbeddedPlatformPackages.push(packageVersion);
      }
    } finally {
      await releaseInstallLock();
    }
  }

  const payloadEntries = await fs.promises.readdir(sharedPayloadsRoot, { withFileTypes: true }).catch(() => []);
  const postgresPayloadEntries = (
    await Promise.all(payloadEntries
      .filter((entry) => entry.isDirectory() && /^postgres-\d+\.\d+$/.test(entry.name))
      .map(async (entry) => ({
        name: entry.name,
        stats: await fs.promises.stat(path.join(sharedPayloadsRoot, entry.name)),
      })))
  ).sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
  const livePayloadVersions = new Set<string>();
  let hasUnknownLivePayload = false;
  for (const descriptor of liveDescriptors) {
    const runtimeKeyMatch = /^(postgres-\d+\.\d+)\/[^/]+$/.exec(
      descriptor.postgresRuntimeKey ?? "",
    );
    if (runtimeKeyMatch?.[1]) {
      livePayloadVersions.add(runtimeKeyMatch[1]);
    } else if (descriptor.postgresRuntimeKey !== undefined) {
      hasUnknownLivePayload = true;
    }

    if (descriptor.postgresBinDir === undefined) {
      if (descriptor.postgresRuntimeKey === undefined) hasUnknownLivePayload = true;
      continue;
    }
    const physicalBinDir = await fs.promises.realpath(descriptor.postgresBinDir).catch(() => null);
    const candidateBinDirs = [
      path.resolve(descriptor.postgresBinDir),
      physicalBinDir,
    ].filter((value): value is string => value !== null);
    let derivedManagedPayload = false;
    for (const candidateBinDir of candidateBinDirs) {
      const relative = path.relative(sharedPayloadsRoot, candidateBinDir);
      if (
        relative === ""
        || relative === ".."
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) {
        continue;
      }
      const payloadName = relative.split(path.sep)[0];
      if (/^postgres-\d+\.\d+$/.test(payloadName)) {
        livePayloadVersions.add(payloadName);
        derivedManagedPayload = true;
      }
    }
    if (
      !derivedManagedPayload
      && (
        pathIsInside(descriptor.postgresBinDir, sharedPayloadsRoot)
        || (
          physicalBinDir === null
          && pathIsInside(descriptor.postgresBinDir, runtimesRoot)
        )
      )
    ) {
      hasUnknownLivePayload = true;
    }
  }
  const previousPayload = postgresPayloadEntries.find((entry) => (
    entry.name !== DESKTOP_POSTGRES_RUNTIME_DIR
    && nowMs - entry.stats.mtimeMs <= 14 * 24 * 60 * 60 * 1000
  ));
  if (!hasUnknownLivePayload) {
    for (const entry of postgresPayloadEntries) {
      if (
        entry.name === DESKTOP_POSTGRES_RUNTIME_DIR
        || entry.name === previousPayload?.name
        || livePayloadVersions.has(entry.name)
      ) {
        continue;
      }
      await fs.promises.rm(path.join(sharedPayloadsRoot, entry.name), {
        recursive: true,
        force: true,
      });
      result.removedSharedPayloadVersions.push(entry.name);
    }
  }

  return result;
}

export async function finalizeSharedPostgresRuntime(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  validateVersion?: boolean;
  now?: Date;
  incompleteRuntimeGraceMs?: number;
  expectedInstanceId?: string;
  expectedVersion?: string;
} = {}): Promise<SharedPostgresFinalizeResult> {
  const releaseLifecycleLock = await acquireDesktopPostgresLifecycleLock(
    options.env ?? process.env,
  );
  try {
    return await finalizeSharedPostgresRuntimeUnlocked(options);
  } finally {
    await releaseLifecycleLock();
  }
}

export function captureDesktopPostgresEnvironment(env: NodeJS.ProcessEnv = process.env): {
  binDir?: string;
  managedBinDir?: string;
} {
  return {
    ...(env[RUDDER_POSTGRES_BIN_DIR_ENV] === undefined
      ? {}
      : { binDir: env[RUDDER_POSTGRES_BIN_DIR_ENV] }),
    ...(env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV] === undefined
      ? {}
      : { managedBinDir: env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV] }),
  };
}

export function restoreDesktopPostgresEnvironment(
  snapshot: ReturnType<typeof captureDesktopPostgresEnvironment>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (snapshot.binDir === undefined) delete env[RUDDER_POSTGRES_BIN_DIR_ENV];
  else env[RUDDER_POSTGRES_BIN_DIR_ENV] = snapshot.binDir;
  if (snapshot.managedBinDir === undefined) delete env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV];
  else env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV] = snapshot.managedBinDir;
}

export function createDesktopUpdateChildEnvironment(options: {
  resourcesPath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  validateVersion?: boolean;
}): NodeJS.ProcessEnv {
  const env = { ...(options.env ?? process.env) };
  const currentBinDir = env[RUDDER_POSTGRES_BIN_DIR_ENV]?.trim();
  if (
    currentBinDir
    && isDesktopManagedPostgresBinDir({
      binDir: currentBinDir,
      resourcesPath: options.resourcesPath,
      env,
    })
  ) {
    if (isCompletePostgresBinDir(currentBinDir, {
      platform: options.platform,
      validateVersion: options.validateVersion,
    })) {
      env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV] = currentBinDir;
    } else {
      delete env[RUDDER_POSTGRES_BIN_DIR_ENV];
      delete env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV];
    }
  }
  return env;
}
