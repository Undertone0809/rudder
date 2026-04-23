import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const localEnvProfiles = {
  dev: {
    instanceId: "dev",
    port: "3100",
    embeddedPostgresPort: "54329",
  },
  prod_local: {
    instanceId: "default",
    port: "3200",
    embeddedPostgresPort: "54339",
  },
  e2e: {
    instanceId: "e2e",
    port: "3300",
    embeddedPostgresPort: "54349",
  },
};

export function normalizeLocalEnvName(value) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return Object.hasOwn(localEnvProfiles, normalized) ? normalized : null;
}

export function resolveRepoLocalEnvFile(repoRoot) {
  return path.join(repoRoot, ".rudder", ".env");
}

export function resolveRepoLocalConfigFile(repoRoot) {
  return path.join(repoRoot, ".rudder", "config.json");
}

export function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const parsed = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (!key) continue;
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function readRepoLocalConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

export function resolveHomeDir(value) {
  const envHome = value?.trim();
  if (!envHome) return path.resolve(os.homedir(), ".rudder");
  if (envHome === "~") return os.homedir();
  if (envHome.startsWith("~/")) return path.resolve(os.homedir(), envHome.slice(2));
  return path.resolve(envHome);
}

export function resolveDevScriptEnvironment({ repoRoot, baseEnv, defaultLocalEnvName = "dev", extraEnv = {} }) {
  const repoLocalEnv = parseEnvFile(resolveRepoLocalEnvFile(repoRoot));
  const mergedEnv = {
    ...baseEnv,
    ...repoLocalEnv,
    ...extraEnv,
  };

  const configPath = mergedEnv.RUDDER_CONFIG?.trim() || resolveRepoLocalConfigFile(repoRoot);
  const repoLocalConfig = readRepoLocalConfig(configPath);
  const localEnvName = normalizeLocalEnvName(mergedEnv.RUDDER_LOCAL_ENV) ?? defaultLocalEnvName;
  const localEnvProfile = localEnvProfiles[localEnvName];

  const env = {
    ...mergedEnv,
    RUDDER_LOCAL_ENV: localEnvName,
    RUDDER_INSTANCE_ID: mergedEnv.RUDDER_INSTANCE_ID?.trim() || localEnvProfile.instanceId,
    PORT: mergedEnv.PORT?.trim() || String(repoLocalConfig?.server?.port ?? localEnvProfile.port),
    RUDDER_EMBEDDED_POSTGRES_PORT:
      mergedEnv.RUDDER_EMBEDDED_POSTGRES_PORT?.trim()
      || String(repoLocalConfig?.database?.embeddedPostgresPort ?? localEnvProfile.embeddedPostgresPort),
  };

  return {
    env,
    repoLocalEnv,
    repoLocalConfig,
    configPath,
    localEnvName,
    localEnvProfile,
  };
}
