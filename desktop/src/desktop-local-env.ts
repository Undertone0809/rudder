import { app } from "electron";

export type LocalEnvProfile = {
  name: "dev" | "prod_local" | "e2e";
  instanceId: string;
  port: string;
  embeddedPostgresPort: string;
};

const LOCAL_ENV_PROFILES: Record<LocalEnvProfile["name"], LocalEnvProfile> = {
  dev: { name: "dev", instanceId: "dev", port: "3100", embeddedPostgresPort: "54329" },
  prod_local: { name: "prod_local", instanceId: "default", port: "3200", embeddedPostgresPort: "54339" },
  e2e: { name: "e2e", instanceId: "e2e", port: "3300", embeddedPostgresPort: "54349" },
};

function normalizeLocalEnvName(value: string | null | undefined): LocalEnvProfile["name"] | null {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_") ?? "";
  return Object.hasOwn(LOCAL_ENV_PROFILES, normalized) ? (normalized as LocalEnvProfile["name"]) : null;
}

export function resolveDesktopLocalEnvProfile(): LocalEnvProfile {
  const explicit = normalizeLocalEnvName(process.env.RUDDER_LOCAL_ENV);
  if (explicit) return LOCAL_ENV_PROFILES[explicit];
  return app.isPackaged ? LOCAL_ENV_PROFILES.prod_local : LOCAL_ENV_PROFILES.dev;
}
