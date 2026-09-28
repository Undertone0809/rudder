import { app } from "electron";

export type LocalEnvProfile = {
  name: "dev" | "prod_local" | "e2e";
  instanceId: string;
  port: string;
  embeddedPostgresPort: string;
};

const DEV_RUNTIME_OVERRIDE_ENV = "RUDDER_DESKTOP_DEV_RUNTIME_OVERRIDE";

function canUseDevRuntimeOverrides(
  profile: LocalEnvProfile,
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
): boolean {
  return !isPackaged
    && profile.name === "dev"
    && env[DEV_RUNTIME_OVERRIDE_ENV] === "1";
}

export function resolveDesktopOwnedPorts(
  profile: LocalEnvProfile,
  env: NodeJS.ProcessEnv = process.env,
  isPackaged = app?.isPackaged ?? false,
): Pick<LocalEnvProfile, "port" | "embeddedPostgresPort"> {
  const smokeRun = env.RUDDER_DESKTOP_APP_NAME?.startsWith("Rudder-smoke-") === true;
  const devRuntimeOverride = canUseDevRuntimeOverrides(profile, env, isPackaged);
  return {
    port: smokeRun || devRuntimeOverride ? (env.PORT?.trim() || profile.port) : profile.port,
    embeddedPostgresPort: smokeRun || devRuntimeOverride
      ? (env.RUDDER_EMBEDDED_POSTGRES_PORT?.trim() || profile.embeddedPostgresPort)
      : profile.embeddedPostgresPort,
  };
}

const LOCAL_ENV_PROFILES: Record<LocalEnvProfile["name"], LocalEnvProfile> = {
  dev: { name: "dev", instanceId: "dev", port: "3100", embeddedPostgresPort: "54329" },
  prod_local: { name: "prod_local", instanceId: "default", port: "3200", embeddedPostgresPort: "54339" },
  e2e: { name: "e2e", instanceId: "e2e", port: "3300", embeddedPostgresPort: "54349" },
};

function normalizeLocalEnvName(value: string | null | undefined): LocalEnvProfile["name"] | null {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_") ?? "";
  return Object.hasOwn(LOCAL_ENV_PROFILES, normalized) ? (normalized as LocalEnvProfile["name"]) : null;
}

export function resolveDesktopLocalEnvProfile(
  env: NodeJS.ProcessEnv = process.env,
  isPackaged = app?.isPackaged ?? false,
): LocalEnvProfile {
  const explicit = normalizeLocalEnvName(env.RUDDER_LOCAL_ENV);
  const profile = explicit
    ? LOCAL_ENV_PROFILES[explicit]
    : isPackaged ? LOCAL_ENV_PROFILES.prod_local : LOCAL_ENV_PROFILES.dev;
  if (!canUseDevRuntimeOverrides(profile, env, isPackaged)) return profile;

  const instanceId = env.RUDDER_INSTANCE_ID?.trim();
  if (!instanceId) return profile;
  if (!/^[a-zA-Z0-9_-]+$/.test(instanceId)) {
    throw new Error(`Invalid RUDDER_INSTANCE_ID '${instanceId}'.`);
  }
  return { ...profile, instanceId };
}
