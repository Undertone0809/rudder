export const LOCAL_ENV_NAMES = ["dev", "prod_local", "e2e"] as const;

export type LocalEnvName = (typeof LOCAL_ENV_NAMES)[number];

export type LocalEnvProfile = {
  name: LocalEnvName;
  instanceId: string;
  port: number;
  embeddedPostgresPort: number;
  resettable: boolean;
  description: string;
};

const LOCAL_ENV_PROFILES: Record<LocalEnvName, LocalEnvProfile> = {
  dev: {
    name: "dev",
    instanceId: "dev",
    port: 3100,
    embeddedPostgresPort: 54329,
    resettable: true,
    description: "Disposable local development instance",
  },
  prod_local: {
    name: "prod_local",
    instanceId: "default",
    port: 3200,
    embeddedPostgresPort: 54339,
    resettable: false,
    description: "Persistent local instance",
  },
  e2e: {
    name: "e2e",
    instanceId: "e2e",
    port: 3300,
    embeddedPostgresPort: 54349,
    resettable: true,
    description: "Isolated end-to-end test instance",
  },
};

export function parseLocalEnvName(value: string | null | undefined): LocalEnvName | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return (LOCAL_ENV_NAMES as readonly string[]).includes(normalized)
    ? (normalized as LocalEnvName)
    : null;
}

export function resolveLocalEnvProfile(value: string | null | undefined): LocalEnvProfile | null {
  const name = parseLocalEnvName(value);
  return name ? LOCAL_ENV_PROFILES[name] : null;
}

export function resolveActiveLocalEnvProfile(): LocalEnvProfile | null {
  return resolveLocalEnvProfile(process.env.RUDDER_LOCAL_ENV);
}

export function applyLocalEnvProfile(input: {
  localEnv?: string | null;
  instance?: string | null;
}): LocalEnvProfile | null {
  const profile = resolveLocalEnvProfile(input.localEnv ?? process.env.RUDDER_LOCAL_ENV);
  if (!profile) return null;

  process.env.RUDDER_LOCAL_ENV = profile.name;
  if (!input.instance?.trim()) {
    process.env.RUDDER_INSTANCE_ID = profile.instanceId;
  }
  if (!process.env.PORT?.trim()) {
    process.env.PORT = String(profile.port);
  }
  if (!process.env.RUDDER_EMBEDDED_POSTGRES_PORT?.trim()) {
    process.env.RUDDER_EMBEDDED_POSTGRES_PORT = String(profile.embeddedPostgresPort);
  }
  return profile;
}

export function getDisposableLocalEnvProfiles(): LocalEnvProfile[] {
  return Object.values(LOCAL_ENV_PROFILES).filter((profile) => profile.resettable);
}
