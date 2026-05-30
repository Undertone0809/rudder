import { createHash } from "node:crypto";
import os from "node:os";
import type { AgentRuntimeModel, AgentRuntimeModelListContext } from "@rudderhq/agent-runtime-utils";
import {
  asString,
  asStringArray,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { applyManagedOpenCodeEnv, prepareManagedOpenCodeHome } from "./home.js";

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;
const MODELS_DISCOVERY_RETRY_DELAY_MS = 1_500;

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
    deduped.push({ id, label: model.label.trim() || id });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOpenCodeMigrationRace(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return text.includes("database migration") || text.includes("sqlite-migration");
}

function parseModelsOutput(stdout: string): AgentRuntimeModel[] {
  const parsed: AgentRuntimeModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const firstToken = line.split(/\s+/)[0]?.trim() ?? "";
    if (!firstToken.includes("/")) continue;
    const provider = firstToken.slice(0, firstToken.indexOf("/")).trim();
    const model = firstToken.slice(firstToken.indexOf("/") + 1).trim();
    if (!provider || !model) continue;
    parsed.push({ id: `${provider}/${model}`, label: `${provider}/${model}` });
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
  provider?: unknown;
  pure?: unknown;
} = {}): Promise<AgentRuntimeModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const provider = asString(input.provider, "").trim();
  const usePure = input.pure !== false;
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  let resolvedHome: string | undefined;
  if (typeof env.HOME !== "string" || env.HOME.trim().length === 0) {
    try {
      resolvedHome = os.userInfo().homedir || undefined;
    } catch {
      // os.userInfo() throws a SystemError when the current UID has no
      // /etc/passwd entry (e.g. `docker run --user 1234` with a minimal
      // image). Fall back to process.env.HOME.
    }
  }
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env, ...(resolvedHome ? { HOME: resolvedHome } : {}) }));

  const args = [...(usePure ? ["--pure"] : []), "models", ...(provider ? [provider] : [])];
  const runDiscovery = () => runChildProcess(
    `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    args,
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  let result = await runDiscovery();
  if (!result.timedOut && (result.exitCode ?? 1) !== 0 && isOpenCodeMigrationRace(result.stdout, result.stderr)) {
    await sleep(MODELS_DISCOVERY_RETRY_DELAY_MS);
    result = await runDiscovery();
  }

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
  provider?: unknown;
  pure?: unknown;
} = {}): Promise<AgentRuntimeModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const provider = asString(input.provider, "").trim();
  const pure = input.pure !== false;
  const key = `${discoveryCacheKey(command, cwd, env)}\nprovider=${provider}\npure=${pure ? "1" : "0"}`;
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOpenCodeModels({ command, cwd, env, provider, pure });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  pure?: unknown;
}): Promise<AgentRuntimeModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("OpenCode requires `agentRuntimeConfig.model` in provider/model format.");
  }
  const models = await discoverOpenCodeModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    provider: "",
    pure: input.pure,
  });

  if (models.length === 0) {
    throw new Error("OpenCode returned no models. Run `opencode models` and verify provider auth.");
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listOpenCodeModels(
  ctx: AgentRuntimeModelListContext = {},
): Promise<AgentRuntimeModel[]> {
  try {
    const config = parseObject(ctx.config);
    const command =
      typeof config.command === "string" && config.command.trim().length > 0
        ? config.command.trim()
        : undefined;
    const cwd = asString(config.cwd, process.cwd());
    const envConfig = parseObject(config.env);
    const env = normalizeEnv(envConfig);
    const baseEnv = normalizeEnv({ ...process.env, ...env });
    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    const usePure = !extraArgs.includes("--no-pure");
    const runtimeEnv = ctx.orgId
      ? normalizeEnv(ensurePathInEnv(applyManagedOpenCodeEnv(
          baseEnv,
          await prepareManagedOpenCodeHome({
            env: baseEnv,
            orgId: ctx.orgId,
            agentId: "model-list",
          }),
        )))
      : undefined;

    return await discoverOpenCodeModelsCached({
      command,
      cwd,
      env: runtimeEnv,
      pure: usePure,
    });
  } catch {
    return [];
  }
}

export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
}
