import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadRudderEnvFile } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { loadServerRuntimeModule } from "../runtime/server-entry.js";
import { resolveCliVersion } from "../version.js";

type BootstrapCeoInviteRuntimeModule = {
  createBootstrapCeoInvite?: (options: {
    dbUrl: string;
    force?: boolean;
    expiresHours?: number;
  }) => Promise<{
    token: string;
    expiresAt: Date | string;
  } | null>;
};

function resolveDbUrl(configPath?: string, explicitDbUrl?: string) {
  if (explicitDbUrl) return explicitDbUrl;
  const config = readConfig(configPath);
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (config?.database.mode === "postgres" && config.database.connectionString) {
    return config.database.connectionString;
  }
  if (config?.database.mode === "embedded-postgres") {
    const port = config.database.embeddedPostgresPort ?? 54329;
    return `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  }
  return null;
}

function resolveBaseUrl(configPath?: string, explicitBaseUrl?: string) {
  if (explicitBaseUrl) return explicitBaseUrl.replace(/\/+$/, "");
  const fromEnv =
    process.env.RUDDER_PUBLIC_URL ??
    process.env.RUDDER_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL;
  if (fromEnv?.trim()) return fromEnv.trim().replace(/\/+$/, "");
  const config = readConfig(configPath);
  if (config?.auth.baseUrlMode === "explicit" && config.auth.publicBaseUrl) {
    return config.auth.publicBaseUrl.replace(/\/+$/, "");
  }
  const host = config?.server.host ?? "localhost";
  const port = config?.server.port ?? 3100;
  const publicHost = host === "0.0.0.0" ? "localhost" : host;
  return `http://${publicHost}:${port}`;
}

export async function bootstrapCeoInvite(opts: {
  config?: string;
  force?: boolean;
  expiresHours?: number;
  baseUrl?: string;
  dbUrl?: string;
}) {
  const configPath = resolveConfigPath(opts.config);
  loadRudderEnvFile(configPath);
  const config = readConfig(configPath);
  if (!config) {
    p.log.error(`No config found at ${configPath}. Run ${pc.cyan("rudder onboard")} first.`);
    return;
  }

  if (config.server.deploymentMode !== "authenticated") {
    p.log.info("Deployment mode is local_trusted. Bootstrap CEO invite is only required for authenticated mode.");
    return;
  }

  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error(
      "Could not resolve database connection for bootstrap.",
    );
    return;
  }

  try {
    const runtimeModule = await loadBootstrapRuntimeModule();
    const createBootstrapCeoInvite = runtimeModule.createBootstrapCeoInvite;
    if (typeof createBootstrapCeoInvite !== "function") {
      throw new Error("Rudder server runtime did not export createBootstrapCeoInvite().");
    }

    const created = await createBootstrapCeoInvite({
      dbUrl,
      force: opts.force,
      expiresHours: opts.expiresHours,
    });

    if (!created) {
      p.log.info("Instance already has an admin user. Use --force to generate a new bootstrap invite.");
      return;
    }

    const baseUrl = resolveBaseUrl(configPath, opts.baseUrl);
    const inviteUrl = `${baseUrl}/invite/${created.token}`;
    const expiresAt = created.expiresAt instanceof Date
      ? created.expiresAt
      : new Date(created.expiresAt);
    p.log.success("Created bootstrap CEO invite.");
    p.log.message(`Invite URL: ${pc.cyan(inviteUrl)}`);
    p.log.message(`Expires: ${pc.dim(expiresAt.toISOString())}`);
  } catch (err) {
    p.log.error(`Could not create bootstrap invite: ${err instanceof Error ? err.message : String(err)}`);
    p.log.info("If using embedded-postgres, start the Rudder server and run this command again.");
  }
}

async function loadBootstrapRuntimeModule(): Promise<BootstrapCeoInviteRuntimeModule> {
  const version = resolveCliVersion(import.meta.url);
  return await loadServerRuntimeModule({ version: version === "0.0.0" ? "latest" : version }) as BootstrapCeoInviteRuntimeModule;
}
