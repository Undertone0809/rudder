import { models as CLAUDE_LOCAL_MODELS } from "@rudderhq/agent-runtime-claude-local";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_SEARCH,
} from "@rudderhq/agent-runtime-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@rudderhq/agent-runtime-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@rudderhq/agent-runtime-gemini-local";
import type { CreateConfigValues, ModelFallbackConfig } from "@rudderhq/agent-runtime-utils";
import { normalizeModelFallbacks } from "@rudderhq/agent-runtime-utils";
import type {
  Agent,
  AgentRuntimeEnvironmentTestResult,
  EnvBinding
} from "@rudderhq/shared";
import { getUIAdapter } from "../agent-runtimes";
import type { AgentRuntimeModel } from "../api/agents";
import { CODEX_LOCAL_REASONING_EFFORT_OPTIONS, withDefaultThinkingEffortOption } from "../lib/runtime-thinking-effort";
import { defaultCreateValues } from "./agent-config-defaults";
import {
  adapterLabels
} from "./agent-config-primitives";

/* ---- Create mode values ---- */

// Canonical type lives in @rudderhq/agent-runtime-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";

export type AgentConfigFormProps = {
  adapterModels?: AgentRuntimeModel[];
  onDirtyChange?: (dirty: boolean) => void;
  onSaveActionChange?: (save: (() => void) | null) => void;
  onCancelActionChange?: (cancel: (() => void) | null) => void;
  hideInlineSave?: boolean;
  showAdapterTypeField?: boolean;
  showAdapterTestEnvironmentButton?: boolean;
  showCreateRunPolicySection?: boolean;
  hideInstructionsFile?: boolean;
  /** Hide the prompt template field from the Identity section (used when it's shown in a separate Prompts tab). */
  hidePromptTemplate?: boolean;
  /** "cards" renders each section as heading + bordered card (for settings pages). Default: "inline" (border-b dividers). */
  sectionLayout?: "inline" | "cards";
} & (
  | {
      mode: "create";
      values: CreateConfigValues;
      onChange: (patch: Partial<CreateConfigValues>) => void;
    }
  | {
      mode: "edit";
      agent: Agent;
      onSave: (patch: Record<string, unknown>) => void;
      isSaving?: boolean;
    }
);

/* ---- Edit mode overlay (dirty tracking) ---- */

export interface Overlay {
  identity: Record<string, unknown>;
  agentRuntimeType?: string;
  agentRuntimeConfig: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  runtime: Record<string, unknown>;
}

export const emptyOverlay: Overlay = {
  identity: {},
  agentRuntimeConfig: {},
  heartbeat: {},
  runtime: {},
};

/** Stable empty object used as fallback for missing env config to avoid new-object-per-render. */
export const EMPTY_ENV: Record<string, EnvBinding> = {};

export function isOverlayDirty(o: Overlay): boolean {
  return (
    Object.keys(o.identity).length > 0 ||
    o.agentRuntimeType !== undefined ||
    Object.keys(o.agentRuntimeConfig).length > 0 ||
    Object.keys(o.heartbeat).length > 0 ||
    Object.keys(o.runtime).length > 0
  );
}

/* ---- Shared input class ---- */
export const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatArgList(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .join(", ");
  }
  return typeof value === "string" ? value : "";
}

export const codexThinkingEffortOptions = [
  ...withDefaultThinkingEffortOption("Auto", CODEX_LOCAL_REASONING_EFFORT_OPTIONS).map((option) => ({
    id: option.value,
    label: option.label,
  })),
] as const;

export const openCodeThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
] as const;

export const cursorModeOptions = [
  { id: "", label: "Auto" },
  { id: "plan", label: "Plan" },
  { id: "ask", label: "Ask" },
] as const;

export const claudeThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
] as const;

export const LOCAL_MODEL_RUNTIME_TYPES = [
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
] as const;

export function defaultModelForRuntime(agentRuntimeType: string) {
  if (agentRuntimeType === "claude_local") {
    return CLAUDE_LOCAL_MODELS.find((model) => model.id.includes("sonnet"))?.id
      ?? CLAUDE_LOCAL_MODELS[0]?.id
      ?? "";
  }
  if (agentRuntimeType === "codex_local") return DEFAULT_CODEX_LOCAL_MODEL;
  if (agentRuntimeType === "gemini_local") return DEFAULT_GEMINI_LOCAL_MODEL;
  if (agentRuntimeType === "cursor") return DEFAULT_CURSOR_LOCAL_MODEL;
  if (agentRuntimeType === "opencode_local") return "opencode/deepseek-v4-flash-free";
  if (agentRuntimeType === "pi_local") return "kimi-coding/kimi-for-coding";
  return "";
}

export function defaultCommandForRuntime(agentRuntimeType: string) {
  if (agentRuntimeType === "codex_local") return "codex";
  if (agentRuntimeType === "gemini_local") return "gemini";
  if (agentRuntimeType === "pi_local") return "pi";
  if (agentRuntimeType === "cursor") return "cursor-agent";
  if (agentRuntimeType === "opencode_local") return "opencode";
  return "claude";
}

export function createValuesForRuntime(agentRuntimeType: string): CreateConfigValues {
  const values: CreateConfigValues = {
    ...defaultCreateValues,
    agentRuntimeType,
    model: defaultModelForRuntime(agentRuntimeType),
    modelFallbacks: [],
    command: defaultCommandForRuntime(agentRuntimeType),
  };
  if (agentRuntimeType === "codex_local") {
    values.search = DEFAULT_CODEX_LOCAL_SEARCH;
    values.dangerouslyBypassSandbox = DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
  }
  return values;
}

export function defaultConfigForRuntime(agentRuntimeType: string): Record<string, unknown> {
  return getUIAdapter(agentRuntimeType).buildAdapterConfig(createValuesForRuntime(agentRuntimeType));
}

export function defaultFallbackRuntime(primaryRuntimeType: string) {
  return primaryRuntimeType === "claude_local" ? "codex_local" : "claude_local";
}

export function defaultFallbackItem(primaryRuntimeType: string): ModelFallbackConfig {
  const agentRuntimeType = defaultFallbackRuntime(primaryRuntimeType);
  const config = defaultConfigForRuntime(agentRuntimeType);
  const model = typeof config.model === "string" ? config.model : defaultModelForRuntime(agentRuntimeType);
  return {
    agentRuntimeType,
    model,
    config,
  };
}

export function thinkingEffortKeyForRuntime(agentRuntimeType: string) {
  if (agentRuntimeType === "codex_local") return "modelReasoningEffort";
  if (agentRuntimeType === "cursor") return "mode";
  if (agentRuntimeType === "opencode_local") return "variant";
  if (agentRuntimeType === "pi_local") return "thinking";
  return "effort";
}

export function thinkingEffortOptionsForRuntime(agentRuntimeType: string) {
  if (agentRuntimeType === "codex_local") return codexThinkingEffortOptions;
  if (agentRuntimeType === "cursor") return cursorModeOptions;
  if (agentRuntimeType === "opencode_local" || agentRuntimeType === "pi_local") {
    return openCodeThinkingEffortOptions;
  }
  return claudeThinkingEffortOptions;
}

export function shouldShowThinkingEffort(agentRuntimeType: string) {
  return agentRuntimeType !== "gemini_local";
}

export function hasClearedConfigValue(configPatch: Record<string, unknown>) {
  return Object.values(configPatch).some((value) => value === undefined);
}

export function omitClearedConfigValues(config: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

export function primaryModelFallbackKey(agentRuntimeType: string, model: string) {
  return { agentRuntimeType, model };
}

export function normalizeModelFallbacksForEditor(
  rawFallbacks: unknown,
  primary: { agentRuntimeType: string; model: string },
) {
  return normalizeModelFallbacks(rawFallbacks, {
    agentRuntimeType: primary.agentRuntimeType,
    model: "",
  });
}

export const runtimeProviderRailClassName =
  "flex gap-3 overflow-x-auto overscroll-x-contain pb-2 pr-2 [-webkit-overflow-scrolling:touch]";
export const runtimeProviderItemClassName =
  "basis-[60%] min-w-[420px] shrink-0 grow-0";

export type RuntimeEnvironmentTestTarget = {
  key: string;
  title: string;
  runtimeType: string;
  model: string;
  config: Record<string, unknown>;
};

export type RuntimeEnvironmentTestItemResult = RuntimeEnvironmentTestTarget & {
  result?: AgentRuntimeEnvironmentTestResult;
  error?: Error;
};

export type RuntimeEnvironmentStatus = AgentRuntimeEnvironmentTestResult["status"] | "testing" | "error";
export type RuntimeEnvironmentDisplayStatus = Exclude<RuntimeEnvironmentStatus, "warn">;

export function formatRuntimeEnvironmentLabel(target: Pick<RuntimeEnvironmentTestTarget, "title" | "runtimeType" | "model">) {
  const runtimeLabel = adapterLabels[target.runtimeType] ?? target.runtimeType;
  return target.model
    ? `${target.title} · ${runtimeLabel} · ${target.model}`
    : `${target.title} · ${runtimeLabel}`;
}

export function normalizeRuntimeEnvironmentDisplayStatus(
  status?: RuntimeEnvironmentStatus,
): RuntimeEnvironmentDisplayStatus | undefined {
  if (status === "warn") return "pass";
  return status;
}

export function filterRuntimeEnvironmentDisplayChecks(
  result: Pick<AgentRuntimeEnvironmentTestResult, "checks">,
) {
  return result.checks.filter((check) => check.level === "error");
}

/* ---- Form ---- */
