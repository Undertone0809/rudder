import { models as codexFallbackModels } from "@rudderhq/agent-runtime-codex-local";
import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { createHash } from "node:crypto";
import type { AgentRuntimeModel } from "./types.js";

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;

type DiscoveryCacheEntry = { expiresAt: number; models: AgentRuntimeModel[] };
const discoveryCache = new Map<string, DiscoveryCacheEntry>();

function resolveCodexCommand(input: unknown): string {
  const envOverride =
    typeof process.env.RUDDER_CODEX_COMMAND === "string" &&
    process.env.RUDDER_CODEX_COMMAND.trim().length > 0
      ? process.env.RUDDER_CODEX_COMMAND.trim()
      : "codex";
  return asString(input, envOverride);
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

function dedupeModels(models: AgentRuntimeModel[]): AgentRuntimeModel[] {
  const seen = new Set<string>();
  const deduped: AgentRuntimeModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const variants = Array.isArray(model.variants)
      ? [...new Set(model.variants.filter((variant): variant is string => typeof variant === "string" && variant.trim().length > 0))]
      : undefined;
    deduped.push({
      id,
      label: model.label.trim() || id,
      ...(variants ? { variants } : {}),
    });
  }
  return deduped;
}

export function parseCodexModelsOutput(stdout: string): AgentRuntimeModel[] {
  const parsed = parseJsonOutput(stdout);
  const entries = isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
  const models: AgentRuntimeModel[] = [];

  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.slug !== "string") continue;
    const id = entry.slug.trim();
    if (!id) continue;
    if (typeof entry.visibility === "string" && entry.visibility !== "list") continue;

    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
        .filter(isRecord)
        .map((level) => typeof level.effort === "string" ? level.effort.trim().toLowerCase() : "")
        .filter(Boolean)
      : undefined;
    const label = typeof entry.display_name === "string" && entry.display_name.trim()
      ? entry.display_name.trim()
      : id;
    models.push({
      id,
      label,
      ...(levels ? { variants: [...new Set(levels)] } : {}),
    });
  }

  return dedupeModels(models);
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = isRecord(input) ? input : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>): string {
  const envKey = Object.entries(env)
    .filter(([key]) => !key.startsWith("RUDDER_") && key !== "PWD" && key !== "OLDPWD" && key !== "_")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

export async function discoverCodexModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AgentRuntimeModel[]> {
  const command = resolveCodexCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env }));
  const result = await runChildProcess(
    `codex-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["debug", "models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(`\`codex debug models\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`codex debug models\` failed: ${detail}` : "`codex debug models` failed.");
  }

  return parseCodexModelsOutput(result.stdout);
}

export async function discoverCodexModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AgentRuntimeModel[]> {
  const command = resolveCodexCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverCodexModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function listCodexModels(): Promise<AgentRuntimeModel[]> {
  try {
    const discovered = await discoverCodexModelsCached();
    return discovered.length > 0 ? discovered : codexFallbackModels;
  } catch {
    return codexFallbackModels;
  }
}

export function resetCodexModelsCacheForTests() {
  discoveryCache.clear();
}
