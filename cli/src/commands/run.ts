import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrapCeoInvite } from "./auth-bootstrap-ceo.js";
import { onboard } from "./onboard.js";
import { doctor } from "./doctor.js";
import { loadRudderEnvFile } from "../config/env.js";
import { configExists, resolveConfigPath } from "../config/store.js";
import type { RudderConfig } from "../config/schema.js";
import { readConfig } from "../config/store.js";
import { applyLocalEnvProfile, resolveActiveLocalEnvProfile } from "../config/local-env.js";
import {
  describeLocalInstancePaths,
  resolveRudderHomeDir,
  resolveRudderInstanceId,
} from "../config/home.js";

interface RunOptions {
  config?: string;
  instance?: string;
  repair?: boolean;
  yes?: boolean;
}

interface StartedServer {
  apiUrl: string;
  databaseUrl: string | null;
  host: string;
  listenPort: number;
  runtime: {
    mode: "owned" | "attached";
    instanceId: string;
    localEnv: string | null;
    ownerKind: string | null;
    version: string;
  };
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export async function runCommand(opts: RunOptions): Promise<void> {
  let localEnvProfile = resolveActiveLocalEnvProfile();
  if (!localEnvProfile && !opts.instance?.trim() && !process.env.RUDDER_INSTANCE_ID?.trim()) {
    localEnvProfile = applyLocalEnvProfile({ localEnv: "prod_local" });
  }
  const instanceId = resolveRudderInstanceId(opts.instance);
  process.env.RUDDER_INSTANCE_ID = instanceId;

  const homeDir = resolveRudderHomeDir();
  fs.mkdirSync(homeDir, { recursive: true });

  const paths = describeLocalInstancePaths(instanceId);
  fs.mkdirSync(paths.instanceRoot, { recursive: true });

  const configPath = resolveConfigPath(opts.config);
  process.env.RUDDER_CONFIG = configPath;
  loadRudderEnvFile(configPath);

  p.intro(pc.bgCyan(pc.black(" rudder run ")));
  if (localEnvProfile) {
    p.log.message(pc.dim(`Local env: ${localEnvProfile.name} (${localEnvProfile.description})`));
  }
  p.log.message(pc.dim(`Home: ${paths.homeDir}`));
  p.log.message(pc.dim(`Instance: ${paths.instanceId}`));
  p.log.message(pc.dim(`Config: ${configPath}`));

  if (!configExists(configPath)) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      p.log.error("No config found and terminal is non-interactive.");
      p.log.message(`Run ${pc.cyan("rudder onboard")} once, then retry ${pc.cyan("rudder run")}.`);
      process.exit(1);
    }

    p.log.step("No config found. Starting onboarding...");
    await onboard({ config: configPath, invokedByRun: true });
  }

  p.log.step("Running doctor checks...");
  const summary = await doctor({
    config: configPath,
    repair: opts.repair ?? true,
    yes: opts.yes ?? true,
  });

  if (summary.failed > 0) {
    p.log.error("Doctor found blocking issues. Not starting server.");
    process.exit(1);
  }

  const config = readConfig(configPath);
  if (!config) {
    p.log.error(`No config found at ${configPath}.`);
    process.exit(1);
  }

  p.log.step("Starting Rudder server...");
  const startedServer = await importServerEntry();
  if (startedServer.runtime.mode === "attached") {
    p.log.message(
      pc.dim(
        `Attached to existing ${startedServer.runtime.localEnv ?? startedServer.runtime.instanceId} runtime ` +
          `(${startedServer.runtime.ownerKind ?? "unknown-owner"}, v${startedServer.runtime.version}) at ${startedServer.apiUrl.replace(/\/api$/, "")}`,
      ),
    );
    return;
  }

  if (startedServer.databaseUrl && shouldGenerateBootstrapInviteAfterStart(config)) {
    p.log.step("Generating bootstrap CEO invite");
    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: startedServer.databaseUrl,
      baseUrl: resolveBootstrapInviteBaseUrl(config, startedServer),
    });
  }

  // Keep running until the server is stopped
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      // Server will be stopped via SIGTERM/SIGINT which triggers dispose()
      // We keep this promise pending until explicitly resolved via signal handler
    }, 1000);

    const cleanup = () => {
      clearInterval(checkInterval);
      resolve();
    };

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });

  p.log.step("Shutting down...");
  await startedServer.dispose();
}

function resolveBootstrapInviteBaseUrl(
  config: RudderConfig,
  startedServer: StartedServer,
): string {
  const explicitBaseUrl =
    process.env.RUDDER_PUBLIC_URL ??
    process.env.RUDDER_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    (config.auth.baseUrlMode === "explicit" ? config.auth.publicBaseUrl : undefined);

  if (typeof explicitBaseUrl === "string" && explicitBaseUrl.trim().length > 0) {
    return explicitBaseUrl.trim().replace(/\/+$/, "");
  }

  return startedServer.apiUrl.replace(/\/api$/, "");
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message && err.message.trim().length > 0) return err.message;
    return err.name;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isModuleNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") return true;
  return err.message.includes("Cannot find module");
}

function getMissingModuleSpecifier(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const packageMatch = err.message.match(/Cannot find package '([^']+)' imported from/);
  if (packageMatch?.[1]) return packageMatch[1];
  const moduleMatch = err.message.match(/Cannot find module '([^']+)'/);
  if (moduleMatch?.[1]) return moduleMatch[1];
  return null;
}

function maybeEnableUiDevMiddleware(entrypoint: string): void {
  if (process.env.RUDDER_UI_DEV_MIDDLEWARE !== undefined) return;
  const normalized = entrypoint.replaceAll("\\", "/");
  if (normalized.endsWith("/server/src/index.ts") || normalized.endsWith("@rudderhq/server/src/index.ts")) {
    process.env.RUDDER_UI_DEV_MIDDLEWARE = "true";
  }
}

async function importServerEntry(): Promise<StartedServer> {
  // Dev mode: try local workspace path (monorepo with tsx)
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const devEntry = path.resolve(projectRoot, "server/src/index.ts");
  if (fs.existsSync(devEntry)) {
    maybeEnableUiDevMiddleware(devEntry);
    const mod = await import(pathToFileURL(devEntry).href);
    return await startServerFromModule(mod, devEntry);
  }

  // Production mode: import the published @rudderhq/server package
  try {
    const mod = await import("@rudderhq/server");
    return await startServerFromModule(mod, "@rudderhq/server");
  } catch (err) {
    const missingSpecifier = getMissingModuleSpecifier(err);
    const missingServerEntrypoint = !missingSpecifier || missingSpecifier === "@rudderhq/server";
    if (isModuleNotFoundError(err) && missingServerEntrypoint) {
      throw new Error(
        `Could not locate a Rudder server entrypoint.\n` +
          `Tried: ${devEntry}, @rudderhq/server\n` +
          `${formatError(err)}`,
      );
    }
    throw new Error(
      `Rudder server failed to start.\n` +
        `${formatError(err)}`,
    );
  }
}

function shouldGenerateBootstrapInviteAfterStart(config: RudderConfig): boolean {
  return config.server.deploymentMode === "authenticated" && config.database.mode === "embedded-postgres";
}

async function startServerFromModule(mod: unknown, label: string): Promise<StartedServer> {
  const startManagedLocalServer = (mod as {
    startManagedLocalServer?: (options: {
      ownerKind: "cli";
      takeoverOnVersionMismatch?: boolean;
    }) => Promise<StartedServer>;
  }).startManagedLocalServer;
  if (typeof startManagedLocalServer !== "function") {
    throw new Error(`Rudder server entrypoint did not export startManagedLocalServer(): ${label}`);
  }
  return await startManagedLocalServer({
    ownerKind: "cli",
    takeoverOnVersionMismatch: true,
  });
}
