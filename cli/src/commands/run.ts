import fs from "node:fs";
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
import { startManagedServerFromRuntime, type StartedServer } from "../runtime/server-entry.js";
import { resolveCliVersion } from "../version.js";

interface RunOptions {
  config?: string;
  instance?: string;
  repair?: boolean;
  yes?: boolean;
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
  const startedServer = await startManagedServerFromRuntime({ version: resolveRunRuntimeVersion() });
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

function shouldGenerateBootstrapInviteAfterStart(config: RudderConfig): boolean {
  return config.server.deploymentMode === "authenticated" && config.database.mode === "embedded-postgres";
}

function resolveRunRuntimeVersion(): string {
  const version = resolveCliVersion(import.meta.url);
  return version === "0.0.0" ? "latest" : version;
}
