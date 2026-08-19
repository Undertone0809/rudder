import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Keep E2E defaults away from the local desktop instance defaults (3200 / 54339)
// so isolated Playwright runs do not collide with an already-running Rudder app.
const DEFAULT_APP_PORT = 3290;
const DEFAULT_DB_PORT = 55429;

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

function assertSafeInstanceId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
    throw new Error(
      `RUDDER_E2E_INSTANCE_ID must be a simple directory name containing only letters, numbers, dots, underscores, and hyphens: ${value}`,
    );
  }
  return value;
}

function hashPortOffset(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % 1000;
}

// Chromium refuses to navigate to these ports even when a local server is
// healthy. Keep generated app ports outside the browser's restricted list;
// explicitly configured ports still fail loudly so CI cannot hide a typo.
const BROWSER_RESTRICTED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 67, 68, 69, 70,
  79, 80, 81, 88, 110, 111, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 443,
  444, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587,
  601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 10080,
]);

function resolvePort(name: string, fallback: number, options?: { browserSafe?: boolean }): number {
  const raw = nonEmpty(process.env[name]);
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  if (!options?.browserSafe || !BROWSER_RESTRICTED_PORTS.has(value)) return value;
  if (raw) throw new Error(`${name} must not use a browser-restricted TCP port: ${value}.`);
  let candidate = value;
  while (candidate <= 65_535 && BROWSER_RESTRICTED_PORTS.has(candidate)) candidate += 1;
  if (candidate > 65_535) throw new Error(`${name} could not find a browser-safe TCP port.`);
  return candidate;
}

const rawRunId =
  nonEmpty(process.env.RUDDER_E2E_RUN_ID)
  ?? nonEmpty(process.env.CODEX_THREAD_ID)
  ?? `local-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const runId = rawRunId ? sanitizeRunId(rawRunId) : null;
const instanceRunId = rawRunId ? sanitizeInstanceRunId(rawRunId) : null;
const portOffset = rawRunId ? hashPortOffset(rawRunId) : 0;

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function assertSafeE2EHome(home: string): string {
  const resolvedHome = path.resolve(home);
  const allowedRoots = [
    path.join(E2E_ROOT, ".tmp"),
    os.tmpdir(),
    "/tmp",
    "/private/tmp",
  ];
  const hasSafeRoot = allowedRoots.some((root) => isWithin(root, resolvedHome));
  const isNamedTempHome = /^rudder(?:-|$)/.test(path.basename(resolvedHome));
  if (!hasSafeRoot || !isNamedTempHome || allowedRoots.some((root) => path.resolve(root) === resolvedHome)) {
    throw new Error(
      `RUDDER_E2E_HOME must be a named Rudder temporary directory under tests/e2e/.tmp or the system temp directory: ${resolvedHome}`,
    );
  }
  return resolvedHome;
}

export const E2E_PORT = resolvePort("RUDDER_E2E_PORT", DEFAULT_APP_PORT + portOffset, { browserSafe: true });
export const E2E_DB_PORT = resolvePort("RUDDER_E2E_DB_PORT", DEFAULT_DB_PORT + portOffset);
export const E2E_BASE_URL = nonEmpty(process.env.RUDDER_E2E_BASE_URL) ?? `http://127.0.0.1:${E2E_PORT}`;
export const E2E_HOME = path.resolve(
  assertSafeE2EHome(
    nonEmpty(process.env.RUDDER_E2E_HOME)
      ?? path.join(E2E_ROOT, ".tmp", `rudder-e2e-home-${runId}`),
  ),
);
export const E2E_INSTANCE_ID = assertSafeInstanceId(
  nonEmpty(process.env.RUDDER_E2E_INSTANCE_ID)
    ?? (instanceRunId ? `playwright-${instanceRunId}` : "playwright"),
);
export const E2E_INSTANCE_ROOT = path.join(E2E_HOME, "instances", E2E_INSTANCE_ID);
export const E2E_LOCK_PATH = path.join(E2E_ROOT, ".tmp", ".locks", E2E_INSTANCE_ID);
export const E2E_CONFIG_PATH = path.join(E2E_INSTANCE_ROOT, "config.json");
export const E2E_SERVER_PID_PATH = path.join(E2E_INSTANCE_ROOT, "server.pid");
export const E2E_RUNTIME_DESCRIPTOR_PATH = path.join(E2E_INSTANCE_ROOT, "runtime", "server.json");
export const E2E_BIN_DIR = path.join(E2E_HOME, "bin");
export const E2E_CODEX_STUB = path.join(E2E_BIN_DIR, "codex");
export const E2E_CODEX_APP_SERVER_STUB = path.join(E2E_ROOT, "fixtures", "codex-app-server");
export const E2E_AGENT_ISSUE_CREATION_STUB = path.join(E2E_ROOT, "fixtures", "agent-issue-creation.mjs");
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
