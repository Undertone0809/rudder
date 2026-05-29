import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export const RUDDER_SERVER_PACKAGE_NAME = "@rudderhq/server";
export const RUDDER_RUNTIME_METADATA_FILE = "runtime.json";

export type ExternalRuntimeServerEntrypoint = {
  cacheDir: string;
  entrypoint: string;
};

export function sanitizeRuntimeCacheSegment(value: string): string {
  return encodeURIComponent(value.trim() || "latest").replaceAll("%", "_");
}

export function resolveSharedRudderHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const envHome = env.RUDDER_HOME?.trim();
  if (envHome) {
    if (envHome === "~") return homeDir;
    if (envHome.startsWith("~/")) return path.resolve(homeDir, envHome.slice(2));
    return path.resolve(envHome);
  }
  return path.resolve(homeDir, ".rudder");
}

export function resolveExternalRuntimeServerEntrypoint(options: {
  version: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  packageName?: string;
  onWarning?: (message: string, error: unknown) => void;
}): ExternalRuntimeServerEntrypoint | null {
  const env = options.env ?? process.env;
  if (env.RUDDER_DESKTOP_DISABLE_EXTERNAL_RUNTIME === "1") return null;

  const runtimeVersion = options.version.trim();
  if (!runtimeVersion) return null;

  const packageName = options.packageName ?? RUDDER_SERVER_PACKAGE_NAME;
  const cacheDir = path.join(
    resolveSharedRudderHomeDir(env, options.homeDir),
    "runtimes",
    sanitizeRuntimeCacheSegment(runtimeVersion),
  );
  const runtimePackageJson = path.join(cacheDir, "package.json");
  const runtimeMetadataPath = path.join(cacheDir, RUDDER_RUNTIME_METADATA_FILE);
  if (!fs.existsSync(runtimePackageJson) || !fs.existsSync(runtimeMetadataPath)) return null;

  try {
    const metadata = JSON.parse(fs.readFileSync(runtimeMetadataPath, "utf8")) as {
      packageName?: unknown;
      packageVersion?: unknown;
    };
    if (metadata.packageName !== packageName || metadata.packageVersion !== runtimeVersion) return null;
    const serverPackageJsonPath = path.join(cacheDir, "node_modules", ...packageName.split("/"), "package.json");
    const serverPackageJson = JSON.parse(fs.readFileSync(serverPackageJsonPath, "utf8")) as {
      version?: unknown;
    };
    if (serverPackageJson.version !== runtimeVersion) return null;
    return {
      cacheDir,
      entrypoint: createRequire(runtimePackageJson).resolve(packageName),
    };
  } catch (error) {
    options.onWarning?.("failed to resolve shared server runtime cache", error);
    return null;
  }
}
