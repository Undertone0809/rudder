const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4318;
const DEFAULT_SCHEMA = "rudder_analytics";
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_PRIVACY_THRESHOLD = 10;
const DEFAULT_ROLLUP_INTERVAL_MS = 15 * 60 * 1000;

export type ProductAnalyticsCollectorConfig = {
  databaseUrl: string;
  maintenanceDatabaseUrl: string;
  databaseRole: string | null;
  expectedDatabaseRole: string | null;
  maintenanceDatabaseRole: string | null;
  schema: "rudder_analytics";
  host: string;
  port: number;
  identityPublicKey: string;
  identityIssuer: string;
  identityKeyId: string;
  reportSecret: string | null;
  revokeSecret: string | null;
  retentionDays: number;
  privacyThreshold: number;
  rollupIntervalMs: number;
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`missing_${key.toLowerCase()}`);
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, limits: { min: number; max: number }): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`invalid_${key.toLowerCase()}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < limits.min || value > limits.max) throw new Error(`invalid_${key.toLowerCase()}`);
  return value;
}

/** Parse the central deployment contract. Missing identity or DB settings fail closed. */
export function parseProductAnalyticsCollectorConfig(env: NodeJS.ProcessEnv = process.env): ProductAnalyticsCollectorConfig {
  const schema = env.RUDDER_TELEMETRY_COLLECTOR_SCHEMA?.trim() || DEFAULT_SCHEMA;
  if (schema !== DEFAULT_SCHEMA) throw new Error("invalid_rudder_telemetry_collector_schema");
  const port = positiveInteger(env, "RUDDER_TELEMETRY_COLLECTOR_PORT", DEFAULT_PORT, { min: 1, max: 65535 });
  const retentionDays = positiveInteger(env, "RUDDER_TELEMETRY_COLLECTOR_RETENTION_DAYS", DEFAULT_RETENTION_DAYS, { min: 1, max: 3650 });
  const privacyThreshold = positiveInteger(env, "RUDDER_TELEMETRY_COLLECTOR_PRIVACY_THRESHOLD", DEFAULT_PRIVACY_THRESHOLD, { min: 2, max: 100000 });
  const rollupIntervalMs = positiveInteger(env, "RUDDER_TELEMETRY_COLLECTOR_ROLLUP_INTERVAL_MS", DEFAULT_ROLLUP_INTERVAL_MS, { min: 1000, max: 24 * 60 * 60 * 1000 });
  const host = env.RUDDER_TELEMETRY_COLLECTOR_HOST?.trim() || DEFAULT_HOST;
  if (host.length > 255) throw new Error("invalid_rudder_telemetry_collector_host");
  return {
    databaseUrl: required(env, "RUDDER_TELEMETRY_COLLECTOR_DATABASE_URL"),
    maintenanceDatabaseUrl: required(env, "RUDDER_TELEMETRY_COLLECTOR_MAINTENANCE_DATABASE_URL"),
    databaseRole: env.RUDDER_TELEMETRY_COLLECTOR_DATABASE_ROLE?.trim() || null,
    expectedDatabaseRole: env.RUDDER_TELEMETRY_COLLECTOR_EXPECTED_DATABASE_ROLE?.trim() || env.RUDDER_TELEMETRY_COLLECTOR_DATABASE_ROLE?.trim() || null,
    maintenanceDatabaseRole: env.RUDDER_TELEMETRY_COLLECTOR_MAINTENANCE_DATABASE_ROLE?.trim() || null,
    schema,
    host,
    port,
    identityPublicKey: required(env, "RUDDER_TELEMETRY_COLLECTOR_IDENTITY_PUBLIC_KEY"),
    identityIssuer: required(env, "RUDDER_TELEMETRY_COLLECTOR_IDENTITY_ISSUER"),
    identityKeyId: required(env, "RUDDER_TELEMETRY_COLLECTOR_IDENTITY_KEY_ID"),
    reportSecret: env.RUDDER_TELEMETRY_COLLECTOR_REPORT_SECRET?.trim() || null,
    revokeSecret: env.RUDDER_TELEMETRY_COLLECTOR_REVOKE_SECRET?.trim() || null,
    retentionDays,
    privacyThreshold,
    rollupIntervalMs,
  };
}

export const PRODUCT_ANALYTICS_COLLECTOR_DEFAULTS = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  schema: DEFAULT_SCHEMA,
  retentionDays: DEFAULT_RETENTION_DAYS,
  privacyThreshold: DEFAULT_PRIVACY_THRESHOLD,
  rollupIntervalMs: DEFAULT_ROLLUP_INTERVAL_MS,
} as const;
