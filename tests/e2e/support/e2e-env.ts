import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_APP_PORT = 3190;
const DEFAULT_DB_PORT = 54339;

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function sanitizeRunId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function sanitizeInstanceRunId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 48);
}

function hashPortOffset(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % 1000;
}

function resolvePort(name: string, fallback: number): number {
  const raw = nonEmpty(process.env[name]);
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return value;
}

const rawRunId =
  nonEmpty(process.env.RUDDER_E2E_RUN_ID)
  ?? nonEmpty(process.env.CODEX_THREAD_ID)
  ?? null;
const runId = rawRunId ? sanitizeRunId(rawRunId) : null;
const instanceRunId = rawRunId ? sanitizeInstanceRunId(rawRunId) : null;
const portOffset = rawRunId ? hashPortOffset(rawRunId) : 0;

export const E2E_PORT = resolvePort("RUDDER_E2E_PORT", DEFAULT_APP_PORT + portOffset);
export const E2E_DB_PORT = resolvePort("RUDDER_E2E_DB_PORT", DEFAULT_DB_PORT + portOffset);
export const E2E_BASE_URL = nonEmpty(process.env.RUDDER_E2E_BASE_URL) ?? `http://127.0.0.1:${E2E_PORT}`;
export const E2E_HOME = path.resolve(
  nonEmpty(process.env.RUDDER_E2E_HOME)
    ?? path.join(E2E_ROOT, ".tmp", runId ? `rudder-e2e-home-${runId}` : "rudder-e2e-home"),
);
export const E2E_INSTANCE_ID = nonEmpty(process.env.RUDDER_E2E_INSTANCE_ID)
  ?? (instanceRunId ? `playwright-${instanceRunId}` : "playwright");
export const E2E_INSTANCE_ROOT = path.join(E2E_HOME, "instances", E2E_INSTANCE_ID);
export const E2E_BIN_DIR = path.join(E2E_HOME, "bin");
export const E2E_CODEX_STUB = path.join(E2E_BIN_DIR, "codex");
export const E2E_CLAUDE_STUB = path.join(E2E_BIN_DIR, "claude");
export const E2E_CODEX_ERROR_STUB = path.join(E2E_BIN_DIR, "codex-error");
export const E2E_DATABASE_URL =
  nonEmpty(process.env.RUDDER_E2E_DATABASE_URL)
  ?? `postgres://rudder:rudder@127.0.0.1:${E2E_DB_PORT}/rudder`;

process.env.RUDDER_E2E_HOME = E2E_HOME;
process.env.RUDDER_E2E_INSTANCE_ID = E2E_INSTANCE_ID;
process.env.RUDDER_E2E_PORT = String(E2E_PORT);
process.env.RUDDER_E2E_DB_PORT = String(E2E_DB_PORT);
process.env.RUDDER_E2E_BASE_URL = E2E_BASE_URL;
