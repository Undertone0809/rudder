import fs from "node:fs";
import path from "node:path";
import { rudderConfigSchema, type RudderConfig } from "@rudderhq/shared";
import { resolveRudderConfigPath } from "./paths.js";

function createDefaultConfigFile(): RudderConfig {
  return rudderConfigSchema.parse({
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "configure",
    },
    database: {},
    logging: {},
    server: {},
  });
}

export function readConfigFile(): RudderConfig | null {
  const configPath = resolveRudderConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return rudderConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

export function writeConfigFile(config: RudderConfig): RudderConfig {
  const configPath = resolveRudderConfigPath();
  const nextConfig = rudderConfigSchema.parse({
    ...config,
    $meta: {
      ...(config.$meta ?? {}),
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "configure",
    },
  });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2) + "\n", { mode: 0o600 });
  return nextConfig;
}

export function updateConfigFile(mutator: (current: RudderConfig) => RudderConfig): RudderConfig {
  const current = readConfigFile() ?? createDefaultConfigFile();
  return writeConfigFile(mutator(current));
}
