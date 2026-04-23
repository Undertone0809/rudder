import * as p from "@clack/prompts";
import path from "node:path";
import pc from "picocolors";
import {
  AUTH_BASE_URL_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  type AuthBaseUrlMode,
  type DeploymentExposure,
  type DeploymentMode,
  type SecretProvider,
  type StorageProvider,
} from "@rudder/shared";
import { configExists, readConfig, resolveConfigPath, writeConfig } from "../config/store.js";
import type { RudderConfig } from "../config/schema.js";
import { ensureAgentJwtSecret, resolveAgentJwtEnvFile } from "../config/env.js";
import { ensureLocalSecretsKeyFile } from "../config/secrets-key.js";
import { promptDatabase } from "../prompts/database.js";
import { promptLlm } from "../prompts/llm.js";
import { promptLogging } from "../prompts/logging.js";
import { defaultSecretsConfig } from "../prompts/secrets.js";
import { defaultStorageConfig, promptStorage } from "../prompts/storage.js";
import { promptServer } from "../prompts/server.js";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir,
  resolveRudderInstanceId,
} from "../config/home.js";
import { bootstrapCeoInvite } from "./auth-bootstrap-ceo.js";
import { detectPersistentCliState, installPersistentCli } from "../install.js";
import { printRudderCliBanner } from "../utils/banner.js";

type SetupMode = "quickstart" | "advanced";

type OnboardOptions = {
  config?: string;
  run?: boolean;
  yes?: boolean;
  invokedByRun?: boolean;
};

type OnboardDefaults = Pick<RudderConfig, "database" | "logging" | "server" | "auth" | "storage" | "secrets">;

const ONBOARD_ENV_KEYS = [
  "RUDDER_PUBLIC_URL",
  "DATABASE_URL",
  "RUDDER_DB_BACKUP_ENABLED",
  "RUDDER_DB_BACKUP_INTERVAL_MINUTES",
  "RUDDER_DB_BACKUP_RETENTION_DAYS",
  "RUDDER_DB_BACKUP_DIR",
  "RUDDER_DEPLOYMENT_MODE",
  "RUDDER_DEPLOYMENT_EXPOSURE",
  "HOST",
  "PORT",
  "RUDDER_EMBEDDED_POSTGRES_PORT",
  "SERVE_UI",
  "RUDDER_ALLOWED_HOSTNAMES",
  "RUDDER_AUTH_BASE_URL_MODE",
  "RUDDER_AUTH_PUBLIC_BASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
  "RUDDER_STORAGE_PROVIDER",
  "RUDDER_STORAGE_LOCAL_DIR",
  "RUDDER_STORAGE_S3_BUCKET",
  "RUDDER_STORAGE_S3_REGION",
  "RUDDER_STORAGE_S3_ENDPOINT",
  "RUDDER_STORAGE_S3_PREFIX",
  "RUDDER_STORAGE_S3_FORCE_PATH_STYLE",
  "RUDDER_SECRETS_PROVIDER",
  "RUDDER_SECRETS_STRICT_MODE",
  "RUDDER_SECRETS_MASTER_KEY_FILE",
] as const;

function parseBooleanFromEnv(rawValue: string | undefined): boolean | null {
  if (rawValue === undefined) return null;
  const lower = rawValue.trim().toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  return null;
}

function parseNumberFromEnv(rawValue: string | undefined): number | null {
  if (!rawValue) return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseEnumFromEnv<T extends string>(rawValue: string | undefined, allowedValues: readonly T[]): T | null {
  if (!rawValue) return null;
  return allowedValues.includes(rawValue as T) ? (rawValue as T) : null;
}

function resolvePathFromEnv(rawValue: string | undefined): string | null {
  if (!rawValue || rawValue.trim().length === 0) return null;
  return path.resolve(expandHomePrefix(rawValue.trim()));
}

function quickstartDefaultsFromEnv(): {
  defaults: OnboardDefaults;
  usedEnvKeys: string[];
  ignoredEnvKeys: Array<{ key: string; reason: string }>;
} {
  const instanceId = resolveRudderInstanceId();
  const defaultStorage = defaultStorageConfig();
  const defaultSecrets = defaultSecretsConfig();
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  const publicUrl =
    process.env.RUDDER_PUBLIC_URL?.trim() ||
    process.env.RUDDER_AUTH_PUBLIC_BASE_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.BETTER_AUTH_BASE_URL?.trim() ||
    undefined;
  const deploymentMode =
    parseEnumFromEnv<DeploymentMode>(process.env.RUDDER_DEPLOYMENT_MODE, DEPLOYMENT_MODES) ?? "local_trusted";
  const deploymentExposureFromEnv = parseEnumFromEnv<DeploymentExposure>(
    process.env.RUDDER_DEPLOYMENT_EXPOSURE,
    DEPLOYMENT_EXPOSURES,
  );
  const deploymentExposure =
    deploymentMode === "local_trusted" ? "private" : (deploymentExposureFromEnv ?? "private");
  const authPublicBaseUrl = publicUrl;
  const authBaseUrlModeFromEnv = parseEnumFromEnv<AuthBaseUrlMode>(
    process.env.RUDDER_AUTH_BASE_URL_MODE,
    AUTH_BASE_URL_MODES,
  );
  const authBaseUrlMode = authBaseUrlModeFromEnv ?? (authPublicBaseUrl ? "explicit" : "auto");
  const allowedHostnamesFromEnv = process.env.RUDDER_ALLOWED_HOSTNAMES
    ? process.env.RUDDER_ALLOWED_HOSTNAMES
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : [];
  const hostnameFromPublicUrl = publicUrl
    ? (() => {
      try {
        return new URL(publicUrl).hostname.trim().toLowerCase();
      } catch {
        return null;
      }
    })()
    : null;
  const storageProvider =
    parseEnumFromEnv<StorageProvider>(process.env.RUDDER_STORAGE_PROVIDER, STORAGE_PROVIDERS) ??
    defaultStorage.provider;
  const secretsProvider =
    parseEnumFromEnv<SecretProvider>(process.env.RUDDER_SECRETS_PROVIDER, SECRET_PROVIDERS) ??
    defaultSecrets.provider;
  const databaseBackupEnabled = parseBooleanFromEnv(process.env.RUDDER_DB_BACKUP_ENABLED) ?? true;
  const databaseBackupIntervalMinutes = Math.max(
    1,
    parseNumberFromEnv(process.env.RUDDER_DB_BACKUP_INTERVAL_MINUTES) ?? 60,
  );
  const databaseBackupRetentionDays = Math.max(
    1,
    parseNumberFromEnv(process.env.RUDDER_DB_BACKUP_RETENTION_DAYS) ?? 30,
  );
  const defaults: OnboardDefaults = {
    database: {
      mode: databaseUrl ? "postgres" : "embedded-postgres",
      ...(databaseUrl ? { connectionString: databaseUrl } : {}),
      embeddedPostgresDataDir: resolveDefaultEmbeddedPostgresDir(instanceId),
      embeddedPostgresPort: Math.max(
        1,
        parseNumberFromEnv(process.env.RUDDER_EMBEDDED_POSTGRES_PORT) ?? 54329,
      ),
      backup: {
        enabled: databaseBackupEnabled,
        intervalMinutes: databaseBackupIntervalMinutes,
        retentionDays: databaseBackupRetentionDays,
        dir: resolvePathFromEnv(process.env.RUDDER_DB_BACKUP_DIR) ?? resolveDefaultBackupDir(instanceId),
      },
    },
    logging: {
      mode: "file",
      logDir: resolveDefaultLogsDir(instanceId),
    },
    server: {
      deploymentMode,
      exposure: deploymentExposure,
      host: process.env.HOST ?? "127.0.0.1",
      port: Number(process.env.PORT) || 3100,
      allowedHostnames: Array.from(new Set([...allowedHostnamesFromEnv, ...(hostnameFromPublicUrl ? [hostnameFromPublicUrl] : [])])),
      serveUi: parseBooleanFromEnv(process.env.SERVE_UI) ?? true,
    },
    auth: {
      baseUrlMode: authBaseUrlMode,
      disableSignUp: false,
      ...(authPublicBaseUrl ? { publicBaseUrl: authPublicBaseUrl } : {}),
    },
    storage: {
      provider: storageProvider,
      localDisk: {
        baseDir:
          resolvePathFromEnv(process.env.RUDDER_STORAGE_LOCAL_DIR) ?? defaultStorage.localDisk.baseDir,
      },
      s3: {
        bucket: process.env.RUDDER_STORAGE_S3_BUCKET ?? defaultStorage.s3.bucket,
        region: process.env.RUDDER_STORAGE_S3_REGION ?? defaultStorage.s3.region,
        endpoint: process.env.RUDDER_STORAGE_S3_ENDPOINT ?? defaultStorage.s3.endpoint,
        prefix: process.env.RUDDER_STORAGE_S3_PREFIX ?? defaultStorage.s3.prefix,
        forcePathStyle:
          parseBooleanFromEnv(process.env.RUDDER_STORAGE_S3_FORCE_PATH_STYLE) ??
          defaultStorage.s3.forcePathStyle,
      },
    },
    secrets: {
      provider: secretsProvider,
      strictMode: parseBooleanFromEnv(process.env.RUDDER_SECRETS_STRICT_MODE) ?? defaultSecrets.strictMode,
      localEncrypted: {
        keyFilePath:
          resolvePathFromEnv(process.env.RUDDER_SECRETS_MASTER_KEY_FILE) ??
          defaultSecrets.localEncrypted.keyFilePath,
      },
    },
  };
  const ignoredEnvKeys: Array<{ key: string; reason: string }> = [];
  if (deploymentMode === "local_trusted" && process.env.RUDDER_DEPLOYMENT_EXPOSURE !== undefined) {
    ignoredEnvKeys.push({
      key: "RUDDER_DEPLOYMENT_EXPOSURE",
      reason: "Ignored because deployment mode local_trusted always forces private exposure",
    });
  }

  const ignoredKeySet = new Set(ignoredEnvKeys.map((entry) => entry.key));
  const usedEnvKeys = ONBOARD_ENV_KEYS.filter(
    (key) => process.env[key] !== undefined && !ignoredKeySet.has(key),
  );
  return { defaults, usedEnvKeys, ignoredEnvKeys };
}

function canCreateBootstrapInviteImmediately(config: Pick<RudderConfig, "database" | "server">): boolean {
  return config.server.deploymentMode === "authenticated" && config.database.mode !== "embedded-postgres";
}

export async function onboard(opts: OnboardOptions): Promise<void> {
  printRudderCliBanner();
  p.intro(pc.bgCyan(pc.black(" rudder onboard ")));
  const configPath = resolveConfigPath(opts.config);
  const instance = describeLocalInstancePaths(resolveRudderInstanceId());
  p.log.message(
    pc.dim(
      `Local home: ${instance.homeDir} | instance: ${instance.instanceId} | config: ${configPath}`,
    ),
  );

  if (configExists(opts.config)) {
    p.log.message(pc.dim(`${configPath} exists, updating config`));

    try {
      readConfig(opts.config);
    } catch (err) {
      p.log.message(
        pc.yellow(
          `Existing config appears invalid and will be updated.\n${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  let setupMode: SetupMode = "quickstart";
  if (opts.yes) {
    p.log.message(pc.dim("`--yes` enabled: using Quickstart defaults."));
  } else {
    const setupModeChoice = await p.select({
      message: "Choose setup path",
      options: [
        {
          value: "quickstart" as const,
          label: "Quickstart",
          hint: "Recommended: local defaults + ready to run",
        },
        {
          value: "advanced" as const,
          label: "Advanced setup",
          hint: "Customize database, server, storage, and more",
        },
      ],
      initialValue: "quickstart",
    });
    if (p.isCancel(setupModeChoice)) {
      p.cancel("Setup cancelled.");
      return;
    }
    setupMode = setupModeChoice as SetupMode;
  }

  let llm: RudderConfig["llm"] | undefined;
  const { defaults: derivedDefaults, usedEnvKeys, ignoredEnvKeys } = quickstartDefaultsFromEnv();
  let {
    database,
    logging,
    server,
    auth,
    storage,
    secrets,
  } = derivedDefaults;

  if (setupMode === "advanced") {
    p.log.step(pc.bold("Database"));
    database = await promptDatabase(database);

    if (database.mode === "postgres" && database.connectionString) {
      const s = p.spinner();
      s.start("Testing database connection...");
      try {
        const { createDb } = await import("@rudder/db");
        const db = createDb(database.connectionString);
        await db.execute("SELECT 1");
        s.stop("Database connection successful");
      } catch {
        s.stop(pc.yellow("Could not connect to database — you can fix this later with `rudder doctor`"));
      }
    }

    p.log.step(pc.bold("LLM Provider"));
    llm = await promptLlm();

    if (llm?.apiKey) {
      const s = p.spinner();
      s.start("Validating API key...");
      try {
        if (llm.provider === "claude") {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": llm.apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-5-20250929",
              max_tokens: 1,
              messages: [{ role: "user", content: "hi" }],
            }),
          });
          if (res.ok || res.status === 400) {
            s.stop("API key is valid");
          } else if (res.status === 401) {
            s.stop(pc.yellow("API key appears invalid — you can update it later"));
          } else {
            s.stop(pc.yellow("Could not validate API key — continuing anyway"));
          }
        } else {
          const res = await fetch("https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${llm.apiKey}` },
          });
          if (res.ok) {
            s.stop("API key is valid");
          } else if (res.status === 401) {
            s.stop(pc.yellow("API key appears invalid — you can update it later"));
          } else {
            s.stop(pc.yellow("Could not validate API key — continuing anyway"));
          }
        }
      } catch {
        s.stop(pc.yellow("Could not reach API — continuing anyway"));
      }
    }

    p.log.step(pc.bold("Logging"));
    logging = await promptLogging();

    p.log.step(pc.bold("Server"));
    ({ server, auth } = await promptServer({ currentServer: server, currentAuth: auth }));

    p.log.step(pc.bold("Storage"));
    storage = await promptStorage(storage);

    p.log.step(pc.bold("Secrets"));
    const secretsDefaults = defaultSecretsConfig();
    secrets = {
      provider: secrets.provider ?? secretsDefaults.provider,
      strictMode: secrets.strictMode ?? secretsDefaults.strictMode,
      localEncrypted: {
        keyFilePath: secrets.localEncrypted?.keyFilePath ?? secretsDefaults.localEncrypted.keyFilePath,
      },
    };
    p.log.message(
      pc.dim(
        `Using defaults: provider=${secrets.provider}, strictMode=${secrets.strictMode}, keyFile=${secrets.localEncrypted.keyFilePath}`,
      ),
    );
  } else {
    p.log.step(pc.bold("Quickstart"));
    p.log.message(pc.dim("Using quickstart defaults."));
    if (usedEnvKeys.length > 0) {
      p.log.message(pc.dim(`Environment-aware defaults active (${usedEnvKeys.length} env var(s) detected).`));
    } else {
      p.log.message(
        pc.dim("No environment overrides detected: embedded database, file storage, local encrypted secrets."),
      );
    }
    for (const ignored of ignoredEnvKeys) {
      p.log.message(pc.dim(`Ignored ${ignored.key}: ${ignored.reason}`));
    }
  }

  const jwtSecret = ensureAgentJwtSecret(configPath);
  const envFilePath = resolveAgentJwtEnvFile(configPath);
  if (jwtSecret.created) {
    p.log.success(`Created ${pc.cyan("RUDDER_AGENT_JWT_SECRET")} in ${pc.dim(envFilePath)}`);
  } else if (process.env.RUDDER_AGENT_JWT_SECRET?.trim()) {
    p.log.info(`Using existing ${pc.cyan("RUDDER_AGENT_JWT_SECRET")} from environment`);
  } else {
    p.log.info(`Using existing ${pc.cyan("RUDDER_AGENT_JWT_SECRET")} in ${pc.dim(envFilePath)}`);
  }

  const config: RudderConfig = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "onboard",
    },
    ...(llm && { llm }),
    database,
    logging,
    server,
    auth,
    storage,
    secrets,
  };

  const keyResult = ensureLocalSecretsKeyFile(config, configPath);
  if (keyResult.status === "created") {
    p.log.success(`Created local secrets key file at ${pc.dim(keyResult.path)}`);
  } else if (keyResult.status === "existing") {
    p.log.message(pc.dim(`Using existing local secrets key file at ${keyResult.path}`));
  }

  writeConfig(config, opts.config);

  const persistentCliState = detectPersistentCliState();
  let persistentCliAvailable = !persistentCliState.usingNpx || persistentCliState.alreadyInstalled;

  p.note(
    [
      `Database: ${database.mode}`,
      llm ? `LLM: ${llm.provider}` : "LLM: not configured",
      `Logging: ${logging.mode} -> ${logging.logDir}`,
      `Server: ${server.deploymentMode}/${server.exposure} @ ${server.host}:${server.port}`,
      `Allowed hosts: ${server.allowedHostnames.length > 0 ? server.allowedHostnames.join(", ") : "(loopback only)"}`,
      `Auth URL mode: ${auth.baseUrlMode}${auth.publicBaseUrl ? ` (${auth.publicBaseUrl})` : ""}`,
      `Storage: ${storage.provider}`,
      `Secrets: ${secrets.provider} (strict mode ${secrets.strictMode ? "on" : "off"})`,
      "Agent auth: RUDDER_AGENT_JWT_SECRET configured",
    ].join("\n"),
    "Configuration saved",
  );

  if (persistentCliState.usingNpx && !persistentCliState.alreadyInstalled) {
    p.log.step("Persistent CLI install");

    let shouldInstallPersistentCli = Boolean(opts.yes);

    if (opts.yes) {
      p.log.message(pc.dim("`--yes` enabled: installing the persistent Rudder CLI."));
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      const answer = await p.confirm({
        message: `Install ${pc.cyan("rudder")} globally now so you can use ${pc.cyan("rudder ...")} next time?`,
        initialValue: true,
      });
      if (!p.isCancel(answer)) {
        shouldInstallPersistentCli = answer;
      }
    }

    if (shouldInstallPersistentCli) {
      p.log.message(pc.dim(`Running: ${persistentCliState.installCommand}`));
      const installResult = installPersistentCli({ installSpec: persistentCliState.installSpec });
      if (installResult.ok) {
        persistentCliAvailable = true;
        p.log.success(
          `${pc.cyan("rudder")} is now installed. Open a new shell if the command is not visible immediately.`,
        );
      } else {
        p.log.error("Global CLI installation failed.");
        if (installResult.output) {
          p.log.message(pc.dim(installResult.output));
        }
        p.log.message(`Install later with: ${pc.cyan(installResult.command)}`);
      }
    } else {
      p.log.message(`Install later with: ${pc.cyan(persistentCliState.installCommand)}`);
    }
  }

  p.note(
    [
      `Run: ${pc.cyan(persistentCliAvailable ? "rudder run" : "npx @rudder/cli run")}`,
      persistentCliAvailable
        ? `Fallback without install context: ${pc.cyan("npx @rudder/cli run")}`
        : `Install later for direct use: ${pc.cyan(persistentCliState.installCommand)}`,
      `Reconfigure later: ${pc.cyan(persistentCliAvailable ? "rudder configure" : "npx @rudder/cli configure")}`,
      `Diagnose setup: ${pc.cyan(persistentCliAvailable ? "rudder doctor" : "npx @rudder/cli doctor")}`,
    ].join("\n"),
    "Next commands",
  );

  if (canCreateBootstrapInviteImmediately({ database, server })) {
    p.log.step("Generating bootstrap CEO invite");
    await bootstrapCeoInvite({ config: configPath });
  }

  let shouldRunNow = opts.run === true || opts.yes === true;
  if (!shouldRunNow && !opts.invokedByRun && process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await p.confirm({
      message: "Start Rudder now?",
      initialValue: true,
    });
    if (!p.isCancel(answer)) {
      shouldRunNow = answer;
    }
  }

  if (shouldRunNow && !opts.invokedByRun) {
    process.env.RUDDER_OPEN_ON_LISTEN = "true";
    const { runCommand } = await import("./run.js");
    await runCommand({ config: configPath, repair: true, yes: true });
    return;
  }

  if (server.deploymentMode === "authenticated" && database.mode === "embedded-postgres") {
    p.log.info(
      [
        "Bootstrap CEO invite will be created after the server starts.",
        `Next: ${pc.cyan("rudder run")}`,
        `Then: ${pc.cyan("rudder auth bootstrap-ceo")}`,
      ].join("\n"),
    );
  }

  p.outro("You're all set!");
}
