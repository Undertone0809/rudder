import { readConfigFile } from "./config-file.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseEnvFileContents } from "dotenv";
import { resolveRudderEnvPath } from "./paths.js";
import {
  AUTH_BASE_URL_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  type LangfuseConfig,
  type AuthBaseUrlMode,
  type DeploymentExposure,
  type DeploymentMode,
  type SecretProvider,
  type StorageProvider,
} from "@rudderhq/shared";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveHomeAwarePath,
} from "./home-paths.js";
import { resolveEffectiveLocalEnvName, resolveLangfuseEnvironmentName } from "./local-runtime.js";

function loadEnvFileWithoutOverride(filePath: string, blockedKeys?: ReadonlySet<string>): void {
  if (!existsSync(filePath)) return;

  const entries = parseEnvFileContents(readFileSync(filePath, "utf-8"));
  for (const [key, value] of Object.entries(entries)) {
    if (blockedKeys?.has(key)) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function areSameFile(leftPath: string, rightPath: string) {
  if (!existsSync(leftPath) || !existsSync(rightPath)) {
    return leftPath === rightPath;
  }
  return realpathSync(leftPath) === realpathSync(rightPath);
}

function findWorkspaceRoot(startDir: string): string | null {
  let currentDir = resolve(startDir);

  while (true) {
    if (existsSync(resolve(currentDir, "pnpm-workspace.yaml")) || existsSync(resolve(currentDir, ".git"))) {
      return currentDir;
    }

    const nextDir = resolve(currentDir, "..");
    if (nextDir === currentDir) return null;
    currentDir = nextDir;
  }
}

function loadDistinctEnvFileWithoutOverride(
  filePath: string | null,
  loadedPaths: Set<string>,
  blockedKeys?: ReadonlySet<string>,
) {
  if (!filePath || !existsSync(filePath)) return;

  for (const loadedPath of loadedPaths) {
    if (areSameFile(loadedPath, filePath)) return;
  }

  loadEnvFileWithoutOverride(filePath, blockedKeys);
  loadedPaths.add(filePath);
}

const RUDDER_ENV_FILE_PATH = resolveRudderEnvPath();
const loadedEnvPaths = new Set<string>();
loadDistinctEnvFileWithoutOverride(RUDDER_ENV_FILE_PATH, loadedEnvPaths);

const blockedProjectEnvKeys = new Set<string>();
if (process.env.RUDDER_LOCAL_ENV?.trim()) {
  // Local env profiles must not inherit a shared cwd DATABASE_URL, or dev/prod_local/e2e
  // end up pointed at the same external database.
  blockedProjectEnvKeys.add("DATABASE_URL");
}

const CWD_ENV_PATH = resolve(process.cwd(), ".env");
loadDistinctEnvFileWithoutOverride(CWD_ENV_PATH, loadedEnvPaths, blockedProjectEnvKeys);

const WORKSPACE_ROOT = findWorkspaceRoot(process.cwd());
const WORKSPACE_ENV_PATH = WORKSPACE_ROOT ? resolve(WORKSPACE_ROOT, ".env") : null;
loadDistinctEnvFileWithoutOverride(WORKSPACE_ENV_PATH, loadedEnvPaths, blockedProjectEnvKeys);

type DatabaseMode = "embedded-postgres" | "postgres";

export interface Config {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  host: string;
  port: number;
  allowedHostnames: string[];
  authBaseUrlMode: AuthBaseUrlMode;
  authPublicBaseUrl: string | undefined;
  authDisableSignUp: boolean;
  databaseMode: DatabaseMode;
  databaseUrl: string | undefined;
  embeddedPostgresDataDir: string;
  embeddedPostgresPort: number;
  databaseBackupEnabled: boolean;
  databaseBackupIntervalMinutes: number;
  databaseBackupRetentionDays: number;
  databaseBackupDir: string;
  serveUi: boolean;
  uiDevMiddleware: boolean;
  secretsProvider: SecretProvider;
  secretsStrictMode: boolean;
  secretsMasterKeyFilePath: string;
  storageProvider: StorageProvider;
  storageLocalDiskBaseDir: string;
  storageS3Bucket: string;
  storageS3Region: string;
  storageS3Endpoint: string | undefined;
  storageS3Prefix: string;
  storageS3ForcePathStyle: boolean;
  heartbeatSchedulerEnabled: boolean;
  heartbeatSchedulerIntervalMs: number;
  companyDeletionEnabled: boolean;
  langfuse: {
    enabled: boolean;
    baseUrl: string;
    publicKey: string | undefined;
    secretKey: string | undefined;
    environment: string | undefined;
  };
}

function parsePositiveInt(rawValue: string | undefined): number | null {
  if (!rawValue) return null;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

export function loadConfig(): Config {
  const fileConfig = readConfigFile();
  const localEnv = resolveEffectiveLocalEnvName();
  const fileDatabaseMode =
    (fileConfig?.database.mode === "postgres" ? "postgres" : "embedded-postgres") as DatabaseMode;

  const fileDbUrl =
    fileDatabaseMode === "postgres"
      ? fileConfig?.database.connectionString
      : undefined;
  const fileDatabaseBackup = fileConfig?.database.backup;
  const fileSecrets = fileConfig?.secrets;
  const fileStorage = fileConfig?.storage;
  const strictModeFromEnv = process.env.RUDDER_SECRETS_STRICT_MODE;
  const secretsStrictMode =
    strictModeFromEnv !== undefined
      ? strictModeFromEnv === "true"
      : (fileSecrets?.strictMode ?? false);

  const providerFromEnvRaw = process.env.RUDDER_SECRETS_PROVIDER;
  const providerFromEnv =
    providerFromEnvRaw && SECRET_PROVIDERS.includes(providerFromEnvRaw as SecretProvider)
      ? (providerFromEnvRaw as SecretProvider)
      : null;
  const providerFromFile = fileSecrets?.provider;
  const secretsProvider: SecretProvider = providerFromEnv ?? providerFromFile ?? "local_encrypted";

  const storageProviderFromEnvRaw = process.env.RUDDER_STORAGE_PROVIDER;
  const storageProviderFromEnv =
    storageProviderFromEnvRaw && STORAGE_PROVIDERS.includes(storageProviderFromEnvRaw as StorageProvider)
      ? (storageProviderFromEnvRaw as StorageProvider)
      : null;
  const storageProvider: StorageProvider = storageProviderFromEnv ?? fileStorage?.provider ?? "local_disk";
  const storageLocalDiskBaseDir = resolveHomeAwarePath(
    process.env.RUDDER_STORAGE_LOCAL_DIR ??
      fileStorage?.localDisk?.baseDir ??
      resolveDefaultStorageDir(),
  );
  const storageS3Bucket = process.env.RUDDER_STORAGE_S3_BUCKET ?? fileStorage?.s3?.bucket ?? "rudder";
  const storageS3Region = process.env.RUDDER_STORAGE_S3_REGION ?? fileStorage?.s3?.region ?? "us-east-1";
  const storageS3Endpoint = process.env.RUDDER_STORAGE_S3_ENDPOINT ?? fileStorage?.s3?.endpoint ?? undefined;
  const storageS3Prefix = process.env.RUDDER_STORAGE_S3_PREFIX ?? fileStorage?.s3?.prefix ?? "";
  const storageS3ForcePathStyle =
    process.env.RUDDER_STORAGE_S3_FORCE_PATH_STYLE !== undefined
      ? process.env.RUDDER_STORAGE_S3_FORCE_PATH_STYLE === "true"
      : (fileStorage?.s3?.forcePathStyle ?? false);

  const deploymentModeFromEnvRaw = process.env.RUDDER_DEPLOYMENT_MODE;
  const deploymentModeFromEnv =
    deploymentModeFromEnvRaw && DEPLOYMENT_MODES.includes(deploymentModeFromEnvRaw as DeploymentMode)
      ? (deploymentModeFromEnvRaw as DeploymentMode)
      : null;
  const deploymentMode: DeploymentMode = deploymentModeFromEnv ?? fileConfig?.server.deploymentMode ?? "local_trusted";
  const deploymentExposureFromEnvRaw = process.env.RUDDER_DEPLOYMENT_EXPOSURE;
  const deploymentExposureFromEnv =
    deploymentExposureFromEnvRaw &&
    DEPLOYMENT_EXPOSURES.includes(deploymentExposureFromEnvRaw as DeploymentExposure)
      ? (deploymentExposureFromEnvRaw as DeploymentExposure)
      : null;
  const deploymentExposure: DeploymentExposure =
    deploymentMode === "local_trusted"
      ? "private"
      : (deploymentExposureFromEnv ?? fileConfig?.server.exposure ?? "private");
  const authBaseUrlModeFromEnvRaw = process.env.RUDDER_AUTH_BASE_URL_MODE;
  const authBaseUrlModeFromEnv =
    authBaseUrlModeFromEnvRaw &&
    AUTH_BASE_URL_MODES.includes(authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      ? (authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      : null;
  const publicUrlFromEnv = process.env.RUDDER_PUBLIC_URL;
  const authPublicBaseUrlRaw =
    process.env.RUDDER_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    publicUrlFromEnv ??
    fileConfig?.auth?.publicBaseUrl;
  const authPublicBaseUrl = authPublicBaseUrlRaw?.trim() || undefined;
  const authBaseUrlMode: AuthBaseUrlMode =
    authBaseUrlModeFromEnv ??
    fileConfig?.auth?.baseUrlMode ??
    (authPublicBaseUrl ? "explicit" : "auto");
  const disableSignUpFromEnv = process.env.RUDDER_AUTH_DISABLE_SIGN_UP;
  const authDisableSignUp: boolean =
    disableSignUpFromEnv !== undefined
      ? disableSignUpFromEnv === "true"
      : (fileConfig?.auth?.disableSignUp ?? false);
  const allowedHostnamesFromEnvRaw = process.env.RUDDER_ALLOWED_HOSTNAMES;
  const allowedHostnamesFromEnv = allowedHostnamesFromEnvRaw
    ? allowedHostnamesFromEnvRaw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : null;
  const publicUrlHostname = authPublicBaseUrl
    ? (() => {
      try {
        return new URL(authPublicBaseUrl).hostname.trim().toLowerCase();
      } catch {
        return null;
      }
    })()
    : null;
  const allowedHostnames = Array.from(
    new Set(
      [
        ...(allowedHostnamesFromEnv ?? fileConfig?.server.allowedHostnames ?? []),
        ...(publicUrlHostname ? [publicUrlHostname] : []),
      ]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const companyDeletionEnvRaw = process.env.RUDDER_ENABLE_COMPANY_DELETION;
  const companyDeletionEnabled =
    companyDeletionEnvRaw !== undefined
      ? companyDeletionEnvRaw === "true"
      : deploymentMode === "local_trusted";
  const databaseBackupEnabled =
    process.env.RUDDER_DB_BACKUP_ENABLED !== undefined
      ? process.env.RUDDER_DB_BACKUP_ENABLED === "true"
      : (fileDatabaseBackup?.enabled ?? true);
  const databaseBackupIntervalMinutes = Math.max(
    1,
    Number(process.env.RUDDER_DB_BACKUP_INTERVAL_MINUTES) ||
      fileDatabaseBackup?.intervalMinutes ||
      60,
  );
  const databaseBackupRetentionDays = Math.max(
    1,
    Number(process.env.RUDDER_DB_BACKUP_RETENTION_DAYS) ||
      fileDatabaseBackup?.retentionDays ||
      30,
  );
  const databaseBackupDir = resolveHomeAwarePath(
    process.env.RUDDER_DB_BACKUP_DIR ??
      fileDatabaseBackup?.dir ??
      resolveDefaultBackupDir(),
  );
  const embeddedPostgresPort = parsePositiveInt(process.env.RUDDER_EMBEDDED_POSTGRES_PORT)
    ?? fileConfig?.database.embeddedPostgresPort
    ?? 54329;
  const langfuseEnabled = process.env.LANGFUSE_ENABLED === "true";
  const fileLangfuse = fileConfig?.langfuse as LangfuseConfig | undefined;
  const langfuseBaseUrl = process.env.LANGFUSE_BASE_URL?.trim() || fileLangfuse?.baseUrl?.trim() || "http://localhost:3000";
  const langfusePublicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim() || fileLangfuse?.publicKey?.trim() || undefined;
  const langfuseSecretKey = process.env.LANGFUSE_SECRET_KEY?.trim() || fileLangfuse?.secretKey?.trim() || undefined;
  const langfuseEnvironment =
    resolveLangfuseEnvironmentName(
      process.env.LANGFUSE_ENVIRONMENT?.trim() || fileLangfuse?.environment?.trim(),
      localEnv,
    ) ?? undefined;

  return {
    deploymentMode,
    deploymentExposure,
    host: process.env.HOST ?? fileConfig?.server.host ?? "127.0.0.1",
    port: Number(process.env.PORT) || fileConfig?.server.port || 3100,
    allowedHostnames,
    authBaseUrlMode,
    authPublicBaseUrl,
    authDisableSignUp,
    databaseMode: fileDatabaseMode,
    databaseUrl: process.env.DATABASE_URL ?? fileDbUrl,
    embeddedPostgresDataDir: resolveHomeAwarePath(
      fileConfig?.database.embeddedPostgresDataDir ?? resolveDefaultEmbeddedPostgresDir(),
    ),
    embeddedPostgresPort,
    databaseBackupEnabled,
    databaseBackupIntervalMinutes,
    databaseBackupRetentionDays,
    databaseBackupDir,
    serveUi:
      process.env.SERVE_UI !== undefined
        ? process.env.SERVE_UI === "true"
        : fileConfig?.server.serveUi ?? true,
    uiDevMiddleware: process.env.RUDDER_UI_DEV_MIDDLEWARE === "true",
    secretsProvider,
    secretsStrictMode,
    secretsMasterKeyFilePath:
      resolveHomeAwarePath(
        process.env.RUDDER_SECRETS_MASTER_KEY_FILE ??
          fileSecrets?.localEncrypted.keyFilePath ??
          resolveDefaultSecretsKeyFilePath(),
      ),
    storageProvider,
    storageLocalDiskBaseDir,
    storageS3Bucket,
    storageS3Region,
    storageS3Endpoint,
    storageS3Prefix,
    storageS3ForcePathStyle,
    heartbeatSchedulerEnabled: process.env.HEARTBEAT_SCHEDULER_ENABLED !== "false",
    heartbeatSchedulerIntervalMs: Math.max(10000, Number(process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS) || 30000),
    companyDeletionEnabled,
    langfuse: {
      enabled: process.env.LANGFUSE_ENABLED !== undefined
        ? langfuseEnabled
        : (fileLangfuse?.enabled ?? false),
      baseUrl: langfuseBaseUrl,
      publicKey: langfusePublicKey,
      secretKey: langfuseSecretKey,
      environment: langfuseEnvironment,
    },
  };
}
