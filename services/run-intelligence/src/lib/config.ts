import os from "node:os";
import path from "node:path";

export interface RunIntelligenceConfig {
  port: number;
  rudderApiUrl: string;
  cacheDir: string;
  syncIntervalMs: number;
}

export function getConfig(): RunIntelligenceConfig {
  const localEnv = process.env.RUDDER_LOCAL_ENV ?? "dev";
  return {
    port: Number(process.env.RUN_INTELLIGENCE_PORT ?? 3406),
    rudderApiUrl: process.env.RUDDER_API_URL ?? "http://localhost:3100/api",
    cacheDir: process.env.RUN_INTELLIGENCE_CACHE_DIR
      ?? path.join(os.homedir(), `.rudder/instances/${localEnv}/run-intelligence`),
    syncIntervalMs: Number(process.env.RUN_INTELLIGENCE_SYNC_INTERVAL_MS ?? 15000),
  };
}
