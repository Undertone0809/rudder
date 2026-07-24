import type { AgentRuntimeModel } from "@/api/agents";
import {
  shouldShowThinkingEffort,
  thinkingEffortKeyForRuntime,
  thinkingEffortOptionsForRuntime,
} from "@/components/AgentConfigForm.helpers";
import { resolveRuntimeModels } from "@/lib/runtime-models";
import { cn } from "@/lib/utils";
import type { Agent, ChatRuntimeDescriptor } from "@rudderhq/shared";
import { Loader2 } from "lucide-react";
import type { Ref } from "react";

export type ChatRuntimeOverrides = {
  modelOverride: string | null;
  effortOverride: string | null;
};

function configuredAgentModel(agent: Agent) {
  const configured = agent.agentRuntimeConfig.model ?? agent.runtimeConfig.model;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : "Default model";
}

function configuredAgentEffort(agent: Agent) {
  const config = {
    ...agent.runtimeConfig,
    ...agent.agentRuntimeConfig,
  };
  const key = thinkingEffortKeyForRuntime(agent.agentRuntimeType);
  const configured = config[key] ?? (
    agent.agentRuntimeType === "codex_local" ? config.reasoningEffort : null
  );
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : null;
}

function effortLabel(value: string | null | undefined) {
  if (!value || value.toLowerCase() === "auto") return "Auto";
  const knownLabels: Record<string, string> = {
    minimal: "Minimal",
    light: "Light",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
  };
  const known = knownLabels[value.toLowerCase()];
  if (known) return known;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function chatConversationModelOptions(
  agent: Agent,
  adapterModels: readonly AgentRuntimeModel[] | null | undefined,
  modelOverride: string | null,
) {
  const models = resolveRuntimeModels(agent.agentRuntimeType, adapterModels);
  const currentOverride = modelOverride?.trim() ?? "";
  if (!currentOverride || models.some((model) => model.id === currentOverride)) return models;
  return [...models, { id: currentOverride, label: currentOverride }];
}

export function normalizedChatRuntimeOverridesForModel(
  agent: Agent,
  current: ChatRuntimeOverrides,
  modelOverride: string | null,
): ChatRuntimeOverrides {
  if (!shouldShowThinkingEffort(agent.agentRuntimeType)) {
    return { modelOverride, effortOverride: null };
  }
  return {
    modelOverride,
    // Preserve inheritance and explicit effort selection. Compatibility is a
    // derived runtime concern, so switching back to the original model can
    // recover the Agent's configured effort without another persisted change.
    effortOverride: current.effortOverride,
  };
}

export function chatRuntimeSelectionLabel(input: {
  agent: Agent | null;
  runtime: ChatRuntimeDescriptor | null;
  overrides: ChatRuntimeOverrides;
}) {
  if (!input.agent) return "Loading runtime";
  const model = input.overrides.modelOverride
    ?? input.runtime?.model
    ?? configuredAgentModel(input.agent);
  if (!shouldShowThinkingEffort(input.agent.agentRuntimeType)) return model;
  const effort = input.overrides.effortOverride == null
    ? input.runtime?.effort ?? configuredAgentEffort(input.agent)
    : input.overrides.effortOverride;
  return `${model} · ${effortLabel(effort)}`;
}

export function ChatConversationRuntimeControls(props: {
  agent: Agent;
  adapterModels: readonly AgentRuntimeModel[] | null | undefined;
  overrides: ChatRuntimeOverrides;
  disabled?: boolean;
  isLoading?: boolean;
  error?: unknown;
  pending?: boolean;
  modelSelectRef?: Ref<HTMLSelectElement>;
  onChange: (overrides: ChatRuntimeOverrides) => void;
}) {
  const options = chatConversationModelOptions(
    props.agent,
    props.adapterModels,
    props.overrides.modelOverride,
  );
  const configuredModel = configuredAgentModel(props.agent);
  const configuredEffort = configuredAgentEffort(props.agent);
  const effectiveModel = props.overrides.modelOverride ?? configuredModel;
  const effortOptions = thinkingEffortOptionsForRuntime(
    props.agent.agentRuntimeType,
    effectiveModel,
  ).map((option) => ({
    id: option.id || "auto",
    label: option.label,
  }));
  const currentEffortOverride = props.overrides.effortOverride;
  if (
    currentEffortOverride
    && !effortOptions.some((option) => option.id === currentEffortOverride)
  ) {
    effortOptions.push({
      id: currentEffortOverride,
      label: effortLabel(currentEffortOverride),
    });
  }
  const errorMessage = props.error instanceof Error
    ? props.error.message
    : props.error
      ? "Models are temporarily unavailable."
      : null;
  const disabled = props.disabled || props.pending;
  const selectClassName = cn(
    "h-8 min-w-0 w-full rounded-[var(--radius-sm)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-2 text-xs text-foreground outline-hidden",
    "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
    disabled && "cursor-not-allowed opacity-60",
  );

  return (
    <div className="min-w-0 space-y-2 px-1 py-1">
      <label className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Model</span>
        <select
          ref={props.modelSelectRef}
          data-testid="chat-model-selector"
          aria-label={`Model for this conversation (${props.agent.name} runtime)`}
          className={selectClassName}
          disabled={disabled}
          title={errorMessage ?? "Only this conversation will use the selected model."}
          value={props.overrides.modelOverride ?? ""}
          onChange={(event) => props.onChange(normalizedChatRuntimeOverridesForModel(
            props.agent,
            props.overrides,
            event.target.value || null,
          ))}
        >
          <option value="">{`Agent default · ${configuredModel}`}</option>
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
          {errorMessage && options.length === 0 ? (
            <option value="__models_unavailable__" disabled>Models unavailable</option>
          ) : null}
        </select>
      </label>
      {shouldShowThinkingEffort(props.agent.agentRuntimeType) ? (
        <label className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Thinking</span>
          <select
            data-testid="chat-effort-selector"
            aria-label={`Thinking effort for this conversation (${props.agent.name} runtime)`}
            className={selectClassName}
            disabled={disabled}
            value={currentEffortOverride ?? ""}
            onChange={(event) => props.onChange({
              ...props.overrides,
              effortOverride: event.target.value || null,
            })}
          >
            <option value="">
              {`Agent default · ${effortLabel(configuredEffort)}`}
            </option>
            {effortOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="flex min-h-4 items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
        {props.isLoading || props.pending ? (
          <Loader2
            aria-label={props.pending ? "Saving runtime selection" : "Loading models"}
            className="h-3.5 w-3.5 shrink-0 animate-spin"
          />
        ) : null}
        <span>
          {props.pending
            ? "Saving for this conversation…"
            : errorMessage ?? "Agent credentials, skills, fallbacks, and other runtime settings stay unchanged."}
        </span>
      </div>
      {errorMessage ? (
        <span className="sr-only" role="status">{errorMessage}</span>
      ) : null}
    </div>
  );
}
