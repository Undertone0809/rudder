import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSharedRudderHomeDir } from "./runtime-cache.js";

export const DESKTOP_POSTGRES_RUNTIME_DIR = "postgres-18.4";
export const RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV = "RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR";
export const RUDDER_POSTGRES_BIN_DIR_ENV = "RUDDER_POSTGRES_BIN_DIR";

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

function isCompletePostgresBinDir(binDir: string, options: {
  platform?: NodeJS.Platform;
  validateVersion?: boolean;
} = {}): boolean {
  const platform = options.platform ?? process.platform;
  for (const binary of ["initdb", "pg_ctl", "postgres"] as const) {
    if (!fs.existsSync(path.join(binDir, postgresExecutableName(binary, platform)))) return false;
  }
  if (!postgresTemplateCandidates(binDir).some((candidatePath) => fs.existsSync(candidatePath))) return false;
  if (options.validateVersion === false) return true;
  try {
    const postgresBinary = path.join(binDir, postgresExecutableName("postgres", platform));
    const output = execFileSync(postgresBinary, ["--version"], { encoding: "utf8" });
    return /\bPostgreSQL\)?\s+18\.4\b/i.test(output);
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
