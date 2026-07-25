import { GPT_5_6_CODEX_LOCAL_MODEL_IDS } from "@rudderhq/agent-runtime-codex-local";
import type { AgentRuntimeType } from "@rudderhq/shared";

const GPT_5_6_CODEX_LOCAL_MODEL_ID_SET = new Set<string>(GPT_5_6_CODEX_LOCAL_MODEL_IDS);
const CODEX_LOCAL_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const GPT_5_6_CODEX_LOCAL_REASONING_EFFORTS = new Set([
  "light",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

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
  if (agentRuntimeType === "cursor") return "mode";
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

  if (agentRuntimeType !== "codex_local") return nextConfig;
  const effectiveModel = selectedModel
    ?? safeTrim(typeof nextConfig.model === "string" ? nextConfig.model : null);
  const effectiveEffort = chatEffortFromConfig(agentRuntimeType, nextConfig);
  if (!effectiveModel || !effectiveEffort) return nextConfig;

  const supportedEfforts = GPT_5_6_CODEX_LOCAL_MODEL_ID_SET.has(effectiveModel.toLowerCase())
    ? GPT_5_6_CODEX_LOCAL_REASONING_EFFORTS
    : CODEX_LOCAL_REASONING_EFFORTS;
  return supportedEfforts.has(effectiveEffort.toLowerCase())
    ? nextConfig
    : clearChatEffort(agentRuntimeType, nextConfig);
}
