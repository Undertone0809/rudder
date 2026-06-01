import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  DEFAULT_CURSOR_LOCAL_COMMAND,
  models as cursorFallbackModels,
} from "@rudderhq/agent-runtime-cursor-local";
import { prepareManagedCursorHome } from "@rudderhq/agent-runtime-cursor-local/server";
import type { AgentRuntimeModelListContext } from "@rudderhq/agent-runtime-utils";
import {
  asString,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  parseObject,
} from "@rudderhq/agent-runtime-utils/server-utils";
import type { AgentRuntimeModel } from "./types.js";

const CURSOR_MODELS_TIMEOUT_MS = 5_000;
const CURSOR_MODELS_CACHE_TTL_MS = 60_000;
const MAX_BUFFER_BYTES = 512 * 1024;
const modelCache = new Map<string, { expiresAt: number; models: AgentRuntimeModel[] }>();

type CursorModelsCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  hasError: boolean;
};

type CursorModelsCommandInput = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

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

function sanitizeModelId(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\(.*\)\s*$/g, "")
    .trim();
}

function isLikelyModelId(raw: string): boolean {
  const value = sanitizeModelId(raw);
  if (!value) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

function pushModelId(target: AgentRuntimeModel[], raw: string) {
  const id = sanitizeModelId(raw);
  if (!isLikelyModelId(id)) return;
  target.push({ id, label: id });
}

function collectFromJsonValue(value: unknown, target: AgentRuntimeModel[]) {
  if (typeof value === "string") {
    pushModelId(target, value);
    return;
  }
  if (!Array.isArray(value)) return;

  for (const item of value) {
    if (typeof item === "string") {
      pushModelId(target, item);
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string") {
      pushModelId(target, id);
    }
  }
}

export function parseCursorModelsOutput(stdout: string, stderr: string): AgentRuntimeModel[] {
  const models: AgentRuntimeModel[] = [];
  const combined = `${stdout}\n${stderr}`;

  const trimmedStdout = stdout.trim();
  if (trimmedStdout.startsWith("{") || trimmedStdout.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmedStdout) as unknown;
      if (Array.isArray(parsed)) {
        collectFromJsonValue(parsed, models);
      } else if (typeof parsed === "object" && parsed !== null) {
        const rec = parsed as Record<string, unknown>;
        collectFromJsonValue(rec.models, models);
        collectFromJsonValue(rec.data, models);
      }
    } catch {
      // Ignore malformed JSON and continue parsing plain text formats.
    }
  }

  for (const match of combined.matchAll(/available models?:\s*([^\n]+)/gi)) {
    const list = match[1] ?? "";
    for (const token of list.split(",")) {
      pushModelId(models, token);
    }
  }

  for (const lineRaw of combined.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const bullet = line.replace(/^[-*]\s+/, "").trim();
    if (!bullet || bullet.includes(" ")) continue;
    pushModelId(models, bullet);
  }

  return dedupeModels(models);
}

function mergedWithFallback(models: AgentRuntimeModel[]): AgentRuntimeModel[] {
  return dedupeModels([...models, ...cursorFallbackModels]);
}

function defaultCursorModelsRunner(input: CursorModelsCommandInput): CursorModelsCommandResult {
  const result = spawnSync(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    encoding: "utf8",
    timeout: CURSOR_MODELS_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    hasError: Boolean(result.error),
  };
}

let cursorModelsRunner: (input: CursorModelsCommandInput) => CursorModelsCommandResult = defaultCursorModelsRunner;

function fetchCursorModelsFromCli(input: CursorModelsCommandInput): AgentRuntimeModel[] {
  const result = cursorModelsRunner(input);
  const { stdout, stderr } = result;
  if (result.hasError && stdout.trim().length === 0 && stderr.trim().length === 0) {
    return [];
  }
  if ((result.status ?? 1) !== 0 && !/available models?:/i.test(`${stdout}\n${stderr}`)) {
    return [];
  }

  return parseCursorModelsOutput(stdout, stderr);
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function cacheKeyFor(input: CursorModelsCommandInput, orgId: string | undefined): string {
  const envEntries = Object.entries(input.env)
    .filter(([, value]) => typeof value === "string")
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    orgId: orgId ?? null,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: envEntries,
  });
}

async function resolveCursorModelsCommandInput(ctx?: AgentRuntimeModelListContext): Promise<CursorModelsCommandInput> {
  const config = parseObject(ctx?.config);
  const command = asString(config.command, DEFAULT_CURSOR_LOCAL_COMMAND);
  const cwd = asString(config.cwd, process.cwd());
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const configEnv = normalizeEnv(envConfig);
  const baseEnv = normalizeEnv({ ...process.env, ...configEnv });
  const managedHome = ctx?.orgId
    ? (await prepareManagedCursorHome({
        env: baseEnv,
        orgId: ctx.orgId,
        agentId: "model-list",
      })).homeDir
    : (baseEnv.HOME ?? process.env.HOME ?? "");
  const runtimeEnv = ensurePathInEnv({
    ...baseEnv,
    ...(managedHome ? { HOME: managedHome } : {}),
  });
  return {
    command,
    args: ["models"],
    cwd,
    env: runtimeEnv,
  };
}

export async function listCursorModels(ctx?: AgentRuntimeModelListContext): Promise<AgentRuntimeModel[]> {
  const commandInput = await resolveCursorModelsCommandInput(ctx);
  const cacheKey = cacheKeyFor(commandInput, ctx?.orgId);
  const now = Date.now();
  const cached = modelCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.models;
  }

  const discovered = fetchCursorModelsFromCli(commandInput);
  if (discovered.length > 0) {
    const merged = mergedWithFallback(discovered);
    modelCache.set(cacheKey, {
      expiresAt: now + CURSOR_MODELS_CACHE_TTL_MS,
      models: merged,
    });
    return merged;
  }

  if (cached && cached.models.length > 0) {
    return cached.models;
  }

  return dedupeModels(cursorFallbackModels);
}

export function resetCursorModelsCacheForTests() {
  modelCache.clear();
}

export function setCursorModelsRunnerForTests(
  runner: ((input: CursorModelsCommandInput) => CursorModelsCommandResult) | null,
) {
  cursorModelsRunner = runner ?? defaultCursorModelsRunner;
}
