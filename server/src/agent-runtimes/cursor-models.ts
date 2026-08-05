import { models as cursorFallbackModels, withCursorModelMetadata } from "@rudderhq/agent-runtime-cursor-local";
import { spawnSync } from "node:child_process";
import type { AgentRuntimeModel } from "./types.js";

const CURSOR_MODELS_TIMEOUT_MS = 5_000;
const CURSOR_MODELS_CACHE_TTL_MS = 60_000;
const MAX_BUFFER_BYTES = 512 * 1024;

let cached: { expiresAt: number; models: AgentRuntimeModel[] } | null = null;

type CursorModelsCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  hasError: boolean;
};

function dedupeModels(models: AgentRuntimeModel[]): AgentRuntimeModel[] {
  const deduped: AgentRuntimeModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    const existing = deduped.find((candidate) => candidate.id === id);
    if (existing) {
      existing.variants = [...new Set([...(existing.variants ?? []), ...(model.variants ?? [])])];
      if (model.capabilities?.reasoning === true) existing.capabilities = { reasoning: true };
      continue;
    }
    deduped.push({
      id,
      label: model.label.trim() || id,
      ...(model.variants ? { variants: [...model.variants] } : {}),
      ...(model.capabilities ? { capabilities: model.capabilities } : {}),
    });
  }
  return withCursorModelMetadata(deduped);
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
    const record = item as { id?: unknown; variants?: unknown; capabilities?: unknown };
    const id = record.id;
    if (typeof id === "string") {
      const variants = Array.isArray(record.variants)
        ? record.variants.filter((variant): variant is string => typeof variant === "string")
        : undefined;
      const reasoning = typeof record.capabilities === "object"
        && record.capabilities !== null
        && (record.capabilities as { reasoning?: unknown }).reasoning === true;
      target.push({
        id: sanitizeModelId(id),
        label: sanitizeModelId(id),
        ...(variants ? { variants } : {}),
        ...(reasoning ? { capabilities: { reasoning: true } } : {}),
      });
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

function defaultCursorModelsRunner(): CursorModelsCommandResult {
  const result = spawnSync("cursor-agent", ["models"], {
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

let cursorModelsRunner: () => CursorModelsCommandResult = defaultCursorModelsRunner;

function fetchCursorModelsFromCli(): AgentRuntimeModel[] {
  const result = cursorModelsRunner();
  const { stdout, stderr } = result;
  if (result.hasError && stdout.trim().length === 0 && stderr.trim().length === 0) {
    return [];
  }
  if ((result.status ?? 1) !== 0 && !/available models?:/i.test(`${stdout}\n${stderr}`)) {
    return [];
  }

  return parseCursorModelsOutput(stdout, stderr);
}

export async function listCursorModels(): Promise<AgentRuntimeModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.models;
  }

  const discovered = fetchCursorModelsFromCli();
  if (discovered.length > 0) {
    const merged = mergedWithFallback(discovered);
    cached = {
      expiresAt: now + CURSOR_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.models.length > 0) {
    return cached.models;
  }

  return dedupeModels(cursorFallbackModels);
}

export function resetCursorModelsCacheForTests() {
  cached = null;
}

export function setCursorModelsRunnerForTests(runner: (() => CursorModelsCommandResult) | null) {
  cursorModelsRunner = runner ?? defaultCursorModelsRunner;
}
