import { models as claudeModels } from "@rudderhq/agent-runtime-claude-local";
import {
  CODEX_LOCAL_REASONING_EFFORTS_BY_MODEL,
} from "@rudderhq/agent-runtime-codex-local";
import { models as cursorModels } from "@rudderhq/agent-runtime-cursor-local";
import {
  PI_LOCAL_THINKING_LEVELS,
  models as piModels,
} from "@rudderhq/agent-runtime-pi-local";
import type { AgentRuntimeModel } from "@rudderhq/agent-runtime-utils";
import type { AgentRuntimeType } from "@rudderhq/shared";

const CODEX_LOCAL_REASONING_EFFORT_SET_BY_MODEL = new Map(
  Object.entries(CODEX_LOCAL_REASONING_EFFORTS_BY_MODEL)
    .map(([model, efforts]) => [model, new Set(efforts)] as const),
);
const PI_LOCAL_THINKING_LEVEL_SET = new Set(PI_LOCAL_THINKING_LEVELS);

function supportedEffortsForRuntime(
  agentRuntimeType: AgentRuntimeType,
  model: string,
  catalog?: readonly AgentRuntimeModel[],
): Set<string> | null | undefined {
  const normalizedModel = model.toLowerCase();
  if (catalog) {
    const catalogModel = catalog.find((candidate) => candidate.id.toLowerCase() === normalizedModel);
    if (!catalogModel) return new Set();
    if (catalogModel.variants !== undefined) return new Set(catalogModel.variants);
    return new Set();
  }
  if (agentRuntimeType === "codex_local") {
    return CODEX_LOCAL_REASONING_EFFORT_SET_BY_MODEL.get(normalizedModel) ?? new Set();
  }
  if (agentRuntimeType === "claude_local") {
    const catalogModel = claudeModels.find((candidate) => candidate.id.toLowerCase() === normalizedModel);
    return catalogModel ? new Set(catalogModel.variants ?? []) : new Set();
  }
  if (agentRuntimeType === "cursor") {
    const catalogModel = cursorModels.find((candidate) => candidate.id.toLowerCase() === normalizedModel);
    return catalogModel?.variants ? new Set(catalogModel.variants) : new Set();
  }
  if (agentRuntimeType === "pi_local") {
    if (!catalog) return PI_LOCAL_THINKING_LEVEL_SET;
    const catalogModel = piModels.find((candidate) => candidate.id.toLowerCase() === normalizedModel);
    if (!catalogModel) return new Set();
    return catalogModel.variants ? new Set(catalogModel.variants) : new Set();
  }
  if (agentRuntimeType === "opencode_local") return undefined;
  return null;
}

function safeTrim(value: string | null | undefined) {
  return value?.trim() || null;
}

export function applyChatPrimaryModel(
  agentRuntimeType: AgentRuntimeType,
  agentRuntimeConfig: Record<string, unknown>,
  model: string | null | undefined,
) {
  return applyChatRuntimeOverrides(agentRuntimeType, agentRuntimeConfig, model, undefined);
}

export function chatEffortKeyForRuntime(agentRuntimeType: AgentRuntimeType): string | null {
  if (agentRuntimeType === "gemini_local") return null;
  if (agentRuntimeType === "codex_local") return "modelReasoningEffort";
  if (agentRuntimeType === "cursor") return "effort";
  if (agentRuntimeType === "opencode_local") return "variant";
  if (agentRuntimeType === "pi_local") return "thinking";
  return "effort";
}

export function chatEffortFromConfig(
  agentRuntimeType: AgentRuntimeType,
  agentRuntimeConfig: Record<string, unknown>,
): string | null {
  const key = chatEffortKeyForRuntime(agentRuntimeType);
  if (!key) return null;
  const value = agentRuntimeConfig[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (agentRuntimeType === "codex_local") {
    const legacy = agentRuntimeConfig.reasoningEffort;
    if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  }
  return null;
}

function clearChatEffort(
  agentRuntimeType: AgentRuntimeType,
  agentRuntimeConfig: Record<string, unknown>,
) {
  const nextConfig = { ...agentRuntimeConfig };
  const key = chatEffortKeyForRuntime(agentRuntimeType);
  if (key) delete nextConfig[key];
  if (agentRuntimeType === "codex_local") delete nextConfig.reasoningEffort;
  return nextConfig;
}

export function applyChatRuntimeOverrides(
  agentRuntimeType: AgentRuntimeType,
  agentRuntimeConfig: Record<string, unknown>,
  model: string | null | undefined,
  effort: string | null | undefined,
  catalog?: readonly AgentRuntimeModel[],
) {
  const selectedModel = safeTrim(model);
  let nextConfig: Record<string, unknown> = selectedModel
    ? { ...agentRuntimeConfig, model: selectedModel }
    : agentRuntimeConfig;

  if (effort !== undefined) {
    nextConfig = clearChatEffort(agentRuntimeType, nextConfig);
    const selectedEffort = safeTrim(effort);
    const effortKey = chatEffortKeyForRuntime(agentRuntimeType);
    if (effortKey && selectedEffort && selectedEffort.toLowerCase() !== "auto") {
      nextConfig[effortKey] = selectedEffort;
    }
  }

  const effectiveModel = selectedModel
    ?? safeTrim(typeof nextConfig.model === "string" ? nextConfig.model : null);
  const effectiveEffort = chatEffortFromConfig(agentRuntimeType, nextConfig);
  if (!effectiveModel || !effectiveEffort) return nextConfig;
  const supportedEfforts = supportedEffortsForRuntime(agentRuntimeType, effectiveModel, catalog);
  if (supportedEfforts === undefined) return nextConfig;
  if (supportedEfforts === null) return clearChatEffort(agentRuntimeType, nextConfig);
  return supportedEfforts.has(effectiveEffort.toLowerCase())
    ? nextConfig
    : clearChatEffort(agentRuntimeType, nextConfig);
}
