import type { AgentRuntimeModel } from "@rudderhq/agent-runtime-utils";
import { asString, runChildProcess } from "@rudderhq/agent-runtime-utils/server-utils";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MODELS_CACHE_TTL_MS = 60_000;
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type PiModelMetadata = Pick<AgentRuntimeModel, "variants" | "capabilities"> & { label?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function officialThinkingVariants(model: Record<string, unknown>): string[] {
  if (model.reasoning !== true) return ["off"];
  const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : null;
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (mapped !== undefined && typeof mapped !== "string") return false;
    if (level === "xhigh" && mapped === undefined) return false;
    return true;
  });
}

async function loadPiModelMetadata(env: Record<string, string>): Promise<Map<string, PiModelMetadata>> {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  try {
    const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.providers)) return new Map();

    const metadata = new Map<string, PiModelMetadata>();
    for (const [provider, providerValue] of Object.entries(parsed.providers)) {
      if (!isRecord(providerValue)) continue;
      // Pi applies modelOverrides to built-in models first. Custom models are
      // merged afterwards and replace an override with the same id.
      const overrides = isRecord(providerValue.modelOverrides) ? providerValue.modelOverrides : {};
      for (const [modelId, overrideValue] of Object.entries(overrides)) {
        if (!isRecord(overrideValue)) continue;
        const id = `${provider}/${modelId}`;
        const reasoning = typeof overrideValue.reasoning === "boolean" ? overrideValue.reasoning : undefined;
        metadata.set(id, {
          ...(typeof overrideValue.name === "string" && overrideValue.name.trim()
            ? { label: overrideValue.name.trim() }
            : {}),
          ...(reasoning !== undefined ? { variants: officialThinkingVariants({ reasoning }) } : {}),
          ...(reasoning !== undefined ? { capabilities: { reasoning } } : {}),
        });
      }

      const models = Array.isArray(providerValue.models) ? providerValue.models : [];
      for (const modelValue of models) {
        if (!isRecord(modelValue) || typeof modelValue.id !== "string" || !modelValue.id.trim()) continue;
        const variants = officialThinkingVariants(modelValue);
        metadata.set(`${provider}/${modelValue.id.trim()}`, {
          ...(typeof modelValue.name === "string" && modelValue.name.trim() ? { label: modelValue.name.trim() } : {}),
          variants,
          capabilities: { reasoning: modelValue.reasoning === true },
        });
      }
    }
    return metadata;
  } catch {
    return new Map();
  }
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelsOutput(stdout: string, metadata: Map<string, PiModelMetadata>): AgentRuntimeModel[] {
  const parsed: AgentRuntimeModel[] = [];
  const lines = stdout.split(/\r?\n/);

  // Skip header line if present
  let startIndex = 0;
  if (lines.length > 0 && (lines[0].includes("provider") || lines[0].includes("model"))) {
    startIndex = 1;
  }

  for (let i = startIndex; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;

    // Parse format: "provider   model   context  max-out  thinking  images"
    // Split by 2+ spaces to handle the columnar format
    const parts = line.split(/\s{2,}/);
    if (parts.length < 2) continue;

    const provider = parts[0].trim();
    const model = parts[1].trim();

    if (!provider || !model) continue;
    if (provider === "provider" && model === "model") continue; // Skip header

    const id = `${provider}/${model}`;
    const thinking = parts[4]?.trim().toLowerCase();
    const modelMetadata = metadata.get(id);
    parsed.push({
      id,
      label: modelMetadata?.label || id,
      ...(modelMetadata?.variants !== undefined
        ? { variants: modelMetadata.variants }
        : {}),
      ...(modelMetadata?.capabilities
        ? { capabilities: modelMetadata.capabilities }
        : thinking === "yes" || thinking === "no"
          ? { capabilities: { reasoning: thinking === "yes" } }
          : {}),
    });
  }

  return parsed;
}

function dedupeModels(models: AgentRuntimeModel[]): AgentRuntimeModel[] {
  const seen = new Set<string>();
  const deduped: AgentRuntimeModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const reasoning = model.capabilities?.reasoning;
    const variants = Array.isArray(model.variants)
      ? [...new Set(model.variants.filter((variant): variant is string => typeof variant === "string" && variant.trim().length > 0))]
      : undefined;
    deduped.push({
      id,
      label: model.label.trim() || id,
      ...(variants !== undefined ? { variants } : {}),
      ...(typeof reasoning === "boolean" ? { capabilities: { reasoning } } : {}),
    });
  }
  return deduped;
}

function sortModels(models: AgentRuntimeModel[]): AgentRuntimeModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function resolvePiCommand(input: unknown): string {
  const envOverride =
    typeof process.env.RUDDER_PI_COMMAND === "string" &&
    process.env.RUDDER_PI_COMMAND.trim().length > 0
      ? process.env.RUDDER_PI_COMMAND.trim()
      : "pi";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AgentRuntimeModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["RUDDER_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"]);

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
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

export async function discoverPiModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AgentRuntimeModel[]> {
  const command = resolvePiCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv({ ...process.env, ...env });

  const result = await runChildProcess(
    `pi-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["--list-models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: 20,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error("`pi --list-models` timed out.");
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`pi --list-models\` failed: ${detail}` : "`pi --list-models` failed.");
  }

  const metadata = await loadPiModelMetadata(runtimeEnv);
  return sortModels(dedupeModels(parseModelsOutput(`${result.stdout}\n${result.stderr}`, metadata)));
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function discoverPiModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AgentRuntimeModel[]> {
  const command = resolvePiCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverPiModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function ensurePiModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AgentRuntimeModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("Pi requires `agentRuntimeConfig.model` in provider/model format.");
  }
  const [provider, modelId] = model.split("/", 2).map((part) => part.trim());
  if (!provider || !modelId) {
    throw new Error("Pi requires `agentRuntimeConfig.model` in provider/model format.");
  }

  try {
    return await discoverPiModelsCached({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    });
  } catch {
    // Model discovery is diagnostic only. Custom providers may still work when
    // passed directly to the Pi CLI, so execution should let the CLI be the
    // source of truth after the provider/model contract is satisfied.
    return [];
  }
}

export async function listPiModels(): Promise<AgentRuntimeModel[]> {
  try {
    return await discoverPiModelsCached();
  } catch {
    return [];
  }
}

export function resetPiModelsCacheForTests() {
  discoveryCache.clear();
}
