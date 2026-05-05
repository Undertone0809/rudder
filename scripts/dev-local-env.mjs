import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_WORKTREE_DISABLE_RE = /^(1|true|yes)$/i;

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

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sanitizePathSegment(value, fallback) {
  const sanitized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return sanitized || fallback;
}

function stableHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stablePort(seed, basePort, span) {
  return String(basePort + (stableHash(seed) % span));
}

function stableWorktreeColor(seed) {
  const hash = stableHash(seed);
  const r = 72 + (hash & 0x7f);
  const g = 72 + ((hash >>> 8) & 0x7f);
  const b = 72 + ((hash >>> 16) & 0x7f);
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function detectCodexWorktree(repoRoot) {
  const resolved = path.resolve(repoRoot);
  const parts = resolved.split(path.sep);
  const codexIndex = parts.lastIndexOf(".codex");
  if (codexIndex < 0 || parts[codexIndex + 1] !== "worktrees") return null;

  const worktreeId = parts[codexIndex + 2];
  if (!worktreeId) return null;

  const repoName = path.basename(resolved);
  const worktreeSlug = sanitizePathSegment(worktreeId, "worktree");
  const repoSlug = sanitizePathSegment(repoName, "repo");
  const instanceId = `codex-${worktreeSlug}-${repoSlug}`.slice(0, 64).replace(/[-_]+$/g, "");
  const name = `${repoName}-${worktreeId}`;

  return {
    worktreeId,
    repoName,
    instanceId,
    name,
  };
}

function resolveCodexWorktreeAutoEnv({ repoRoot, baseEnv, repoLocalEnvPath, repoLocalConfigPath }) {
  if (CODEX_WORKTREE_DISABLE_RE.test(baseEnv.RUDDER_DISABLE_CODEX_WORKTREE_AUTO_ENV ?? "")) {
    return {};
  }
  if (existsSync(repoLocalEnvPath) || existsSync(repoLocalConfigPath)) {
    return {};
  }
  if (
    nonEmpty(baseEnv.RUDDER_CONFIG)
    || nonEmpty(baseEnv.RUDDER_HOME)
    || nonEmpty(baseEnv.RUDDER_INSTANCE_ID)
  ) {
    return {};
  }

  const detected = detectCodexWorktree(repoRoot);
  if (!detected) return {};

  const seed = `${detected.worktreeId}:${detected.repoName}`;
  return {
    RUDDER_HOME: path.resolve(os.homedir(), ".rudder-worktrees"),
    RUDDER_INSTANCE_ID: detected.instanceId,
    RUDDER_IN_WORKTREE: "true",
    RUDDER_WORKTREE_NAME: detected.name,
    RUDDER_WORKTREE_COLOR: stableWorktreeColor(seed),
    PORT: stablePort(`server:${seed}`, 3310, 900),
    RUDDER_EMBEDDED_POSTGRES_PORT: stablePort(`postgres:${seed}`, 55310, 900),
  };
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
  const repoLocalEnvPath = resolveRepoLocalEnvFile(repoRoot);
  const repoLocalConfigPath = resolveRepoLocalConfigFile(repoRoot);
  const repoLocalEnv = parseEnvFile(repoLocalEnvPath);
  const codexWorktreeAutoEnv = resolveCodexWorktreeAutoEnv({
    repoRoot,
    baseEnv,
    repoLocalEnvPath,
    repoLocalConfigPath,
  });
  const mergedEnv = {
    ...codexWorktreeAutoEnv,
    ...baseEnv,
    ...repoLocalEnv,
    ...extraEnv,
  };

  const configPath = mergedEnv.RUDDER_CONFIG?.trim() || repoLocalConfigPath;
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
