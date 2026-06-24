import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DESKTOP_POSTGRES_RUNTIME_DIR = "postgres-18.4";
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

function isCompletePostgresBinDir(binDir: string, options: {
  platform?: NodeJS.Platform;
  validateVersion?: boolean;
} = {}): boolean {
  const platform = options.platform ?? process.platform;
  for (const binary of ["initdb", "pg_ctl", "postgres"] as const) {
    if (!fs.existsSync(path.join(binDir, postgresExecutableName(binary, platform)))) return false;
  }
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

export function resolvePreferredDesktopPostgresBinDir(options: {
  isPackaged: boolean;
  resourcesPath: string;
  externalRuntimeCacheDir?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  validateVersion?: boolean;
}): string | null {
  const env = options.env ?? process.env;
  if (env[RUDDER_POSTGRES_BIN_DIR_ENV]?.trim()) return null;
  if (!options.isPackaged) return null;

  if (options.externalRuntimeCacheDir) {
    const cachedBinDir = resolveDesktopPostgresBinDir(options.externalRuntimeCacheDir, options);
    if (cachedBinDir) return cachedBinDir;
  }

  return resolveDesktopPostgresBinDir(options.resourcesPath, options);
}
