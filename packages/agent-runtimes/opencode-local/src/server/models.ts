import type { AgentRuntimeModel } from "@rudderhq/agent-runtime-utils";
import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { createHash } from "node:crypto";
import os from "node:os";

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;

function resolveOpenCodeCommand(input: unknown): string {
  const envOverride =
    typeof process.env.RUDDER_OPENCODE_COMMAND === "string" &&
    process.env.RUDDER_OPENCODE_COMMAND.trim().length > 0
      ? process.env.RUDDER_OPENCODE_COMMAND.trim()
      : "opencode";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AgentRuntimeModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["RUDDER_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "HOME"]);

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
    const reasoning = model.capabilities?.reasoning;
    deduped.push({
      id,
      label: model.label.trim() || id,
      ...(variants ? { variants } : {}),
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

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseJsonObjectAfterModelLine(lines: string[], modelLineIndex: number): Record<string, unknown> | null {
  let started = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const jsonLines: string[] = [];

  for (let index = modelLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const start = !started ? line.indexOf("{") : 0;
    if (!started && start < 0) continue;
    started = true;
    const chunk = !jsonLines.length && start > 0 ? line.slice(start) : line;
    jsonLines.push(chunk);

    for (const character of chunk) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
    }

    if (depth !== 0) continue;
    try {
      const parsed = JSON.parse(jsonLines.join("\n")) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseModelsOutput(stdout: string): AgentRuntimeModel[] {
  const parsed: AgentRuntimeModel[] = [];
  const lines = stdout.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex] ?? "";
    const line = raw.trim();
    if (!line) continue;
    const firstToken = line.split(/\s+/)[0]?.trim() ?? "";
    if (!firstToken.includes("/")) continue;
    const provider = firstToken.slice(0, firstToken.indexOf("/")).trim();
    const model = firstToken.slice(firstToken.indexOf("/") + 1).trim();
    if (!provider || !model) continue;
    const id = `${provider}/${model}`;
    const metadata = parseJsonObjectAfterModelLine(lines, lineIndex);
    const variantsValue = metadata?.variants;
    const variants = typeof variantsValue === "object"
      && variantsValue !== null
      && !Array.isArray(variantsValue)
      ? Object.keys(variantsValue)
      : undefined;
    const capabilitiesValue = metadata?.capabilities;
    const reasoning = typeof capabilitiesValue === "object"
      && capabilitiesValue !== null
      && !Array.isArray(capabilitiesValue)
      && typeof (capabilitiesValue as Record<string, unknown>).reasoning === "boolean"
      ? (capabilitiesValue as Record<string, unknown>).reasoning as boolean
      : undefined;
    const label = typeof metadata?.name === "string" && metadata.name.trim()
      ? metadata.name.trim()
      : id;
    parsed.push({
      id,
      label,
      ...(variants ? { variants } : {}),
      ...(typeof reasoning === "boolean" ? { capabilities: { reasoning } } : {}),
    });
  }
  return dedupeModels(parsed);
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

export async function discoverOpenCodeModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AgentRuntimeModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  // Ensure HOME points to the actual running user's home directory.
  // When the server is started via `runuser -u <user>`, HOME may still
  // reflect the parent process (e.g. /root), causing OpenCode to miss
  // provider auth credentials stored under the target user's home.
  let resolvedHome: string | undefined;
  try {
    resolvedHome = os.userInfo().homedir || undefined;
  } catch {
    // os.userInfo() throws a SystemError when the current UID has no
    // /etc/passwd entry (e.g. `docker run --user 1234` with a minimal
    // image). Fall back to process.env.HOME.
  }
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env, ...(resolvedHome ? { HOME: resolvedHome } : {}) }));

  const result = await runChildProcess(
    `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["models", "--verbose"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(`\`opencode models\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`opencode models\` failed: ${detail}` : "`opencode models` failed.");
  }

  return sortModels(parseModelsOutput(result.stdout));
}

export async function discoverOpenCodeModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AgentRuntimeModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOpenCodeModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AgentRuntimeModel[]> {
  validateOpenCodeModelConfig(input);

  try {
    return await discoverOpenCodeModelsCached({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    });
  } catch {
    // Model discovery is diagnostic only. Custom providers may still work when
    // passed directly to the OpenCode CLI, so execution should let the CLI be
    // the source of truth after the provider/model contract is satisfied.
    return [];
  }
}

export function validateOpenCodeModelConfig(input: { model?: unknown }): string {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("OpenCode requires `agentRuntimeConfig.model` in provider/model format.");
  }
  const [provider, modelId] = model.split("/", 2).map((part) => part.trim());
  if (!provider || !modelId) {
    throw new Error("OpenCode requires `agentRuntimeConfig.model` in provider/model format.");
  }
  return model;
}

export async function listOpenCodeModels(): Promise<AgentRuntimeModel[]> {
  try {
    return await discoverOpenCodeModelsCached();
  } catch {
    return [];
  }
}

export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
}
