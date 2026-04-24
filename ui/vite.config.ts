import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const uiRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(uiRoot, "..");
const repoLocalEnvPath = path.join(repoRoot, ".rudder", ".env");
const repoLocalConfigPath = path.join(repoRoot, ".rudder", "config.json");

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const parsed: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (!key) continue;
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function expandHomePrefix(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) return path.resolve(process.env.HOME ?? "", value.slice(2));
  return value;
}

function resolvePort(rawValue: string | null, fallback: number): number {
  const value = rawValue ? Number(rawValue) : fallback;
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : fallback;
}

function normalizeApiTarget(rawValue: string | null): string | null {
  if (!rawValue) return null;
  const withoutApiSuffix = rawValue.replace(/\/api\/?$/u, "");
  try {
    const url = new URL(withoutApiSuffix);
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    return withoutApiSuffix.replace(/\/+$/u, "");
  }
}

function isPidRunning(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

const repoLocalEnv = parseEnvFile(repoLocalEnvPath);
const rudderConfigPath =
  nonEmpty(process.env.RUDDER_CONFIG)
  ?? nonEmpty(repoLocalEnv.RUDDER_CONFIG)
  ?? repoLocalConfigPath;
const rudderConfig = readJsonFile(rudderConfigPath);
const rudderConfigServer =
  rudderConfig?.server && typeof rudderConfig.server === "object"
    ? (rudderConfig.server as Record<string, unknown>)
    : null;
const apiPort = resolvePort(
  nonEmpty(process.env.PORT)
  ?? nonEmpty(repoLocalEnv.PORT)
  ?? (typeof rudderConfigServer?.port === "number" ? String(rudderConfigServer.port) : null),
  3100,
);
const instanceId =
  nonEmpty(process.env.RUDDER_INSTANCE_ID)
  ?? nonEmpty(repoLocalEnv.RUDDER_INSTANCE_ID)
  ?? "dev";
const rudderHome = path.resolve(
  expandHomePrefix(
    nonEmpty(process.env.RUDDER_HOME)
    ?? nonEmpty(repoLocalEnv.RUDDER_HOME)
    ?? "~/.rudder",
  ),
);
const runtimeDescriptor = readJsonFile(
  path.join(rudderHome, "instances", instanceId, "runtime", "server.json"),
);
const runtimeApiTarget =
  runtimeDescriptor?.instanceId === instanceId && isPidRunning(runtimeDescriptor.pid)
    ? normalizeApiTarget(typeof runtimeDescriptor.apiUrl === "string" ? runtimeDescriptor.apiUrl : null)
    : null;
const apiTarget =
  normalizeApiTarget(nonEmpty(process.env.RUDDER_UI_PROXY_TARGET) ?? nonEmpty(process.env.RUDDER_API_URL))
  ?? runtimeApiTarget
  ?? `http://127.0.0.1:${apiPort}`;
const defaultUiPort = 5173 + Math.max(0, apiPort - 3100);
const uiPort = resolvePort(nonEmpty(process.env.RUDDER_UI_PORT), defaultUiPort);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(uiRoot, "./src"),
      lexical: path.resolve(uiRoot, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  server: {
    port: uiPort,
    proxy: {
      "/api": {
        target: apiTarget,
        ws: true,
      },
    },
  },
});
