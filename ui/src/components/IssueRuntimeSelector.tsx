import type { AgentRuntimeModel } from "@/api/agents";
import { agentsApi } from "@/api/agents";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  codexLocalReasoningEffortOptionsForModel,
  withDefaultThinkingEffortOption,
} from "@/lib/runtime-thinking-effort";
import { queryKeys } from "@/lib/queryKeys";
import { resolveRuntimeModels } from "@/lib/runtime-models";
import { cn } from "@/lib/utils";
import type { Agent, IssueAssigneeAgentRuntimeOverrides } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

const ISSUE_OVERRIDE_RUNTIME_TYPES = new Set(["claude_local", "codex_local", "opencode_local"]);

export function supportsIssueRuntimeOverrides(agent: Agent | null | undefined): boolean {
  return Boolean(agent && ISSUE_OVERRIDE_RUNTIME_TYPES.has(agent.agentRuntimeType));
}

type SelectorVariant = "compact" | "menu";

type EffortOption = {
  id: string | null;
  label: string;
};

export interface IssueRuntimeSelectorProps {
  agent: Agent;
  orgId: string;
  overrides: IssueAssigneeAgentRuntimeOverrides | null | undefined;
  onApply: (overrides: IssueAssigneeAgentRuntimeOverrides | null) => void;
  variant?: SelectorVariant;
  disabled?: boolean;
}

function runtimeEffortKey(runtimeType: string): string | null {
  if (runtimeType === "codex_local") return "modelReasoningEffort";
  if (runtimeType === "opencode_local") return "variant";
  if (runtimeType === "claude_local") return "effort";
  return null;
}

function configuredRuntimeConfig(agent: Agent): Record<string, unknown> {
  return { ...agent.runtimeConfig, ...agent.agentRuntimeConfig };
}

function configuredModel(agent: Agent): string {
  const value = configuredRuntimeConfig(agent).model;
  return typeof value === "string" && value.trim() ? value.trim() : "Default model";
}

function configuredEffort(agent: Agent): string | null {
  const config = configuredRuntimeConfig(agent);
  const key = runtimeEffortKey(agent.agentRuntimeType);
  const value = key ? config[key] ?? (key === "modelReasoningEffort" ? config.reasoningEffort : null) : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function overrideValue(
  overrides: IssueAssigneeAgentRuntimeOverrides | null | undefined,
  key: string,
): string | null {
  const value = overrides?.agentRuntimeConfig?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function configuredOverrideEffort(
  overrides: IssueAssigneeAgentRuntimeOverrides | null | undefined,
  key: string,
): string | null {
  return overrideValue(overrides, key)
    ?? (key === "modelReasoningEffort" ? overrideValue(overrides, "reasoningEffort") : null);
}

function effortLabel(value: string | null | undefined): string {
  if (!value || value.toLowerCase() === "auto") return "Auto";
  const known: Record<string, string> = {
    minimal: "Minimal",
    light: "Light",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
  };
  return known[value.toLowerCase()] ?? `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function modelOptions(
  agent: Agent,
  adapterModels: readonly AgentRuntimeModel[] | null | undefined,
  currentModel: string | null,
): AgentRuntimeModel[] {
  const models = resolveRuntimeModels(agent.agentRuntimeType, adapterModels);
  if (!currentModel || models.some((model) => model.id === currentModel)) return models;
  return [...models, { id: currentModel, label: currentModel }];
}

function effortOptions(agent: Agent, model: string): EffortOption[] {
  if (agent.agentRuntimeType === "codex_local") {
    return withDefaultThinkingEffortOption(
      "Agent default",
      codexLocalReasoningEffortOptionsForModel(model),
    ).map((option) => ({ id: option.value || null, label: option.label }));
  }
  if (agent.agentRuntimeType === "opencode_local") {
    return [
      { id: null, label: "Agent default" },
      { id: "minimal", label: "Minimal" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "max", label: "Max" },
    ];
  }
  return [
    { id: null, label: "Agent default" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ];
}

function buildOverrides(
  current: IssueAssigneeAgentRuntimeOverrides | null | undefined,
  model: string | null,
  effort: string | null,
  effortKey: string,
): IssueAssigneeAgentRuntimeOverrides | null {
  const agentRuntimeConfig = { ...(current?.agentRuntimeConfig ?? {}) };
  if (model) agentRuntimeConfig.model = model;
  else delete agentRuntimeConfig.model;
  if (effort) agentRuntimeConfig[effortKey] = effort;
  else delete agentRuntimeConfig[effortKey];
  if (effortKey === "modelReasoningEffort") delete agentRuntimeConfig.reasoningEffort;

  const next: IssueAssigneeAgentRuntimeOverrides = { ...(current ?? {}) };
  if (Object.keys(agentRuntimeConfig).length > 0) next.agentRuntimeConfig = agentRuntimeConfig;
  else delete next.agentRuntimeConfig;
  return next.agentRuntimeConfig || next.useProjectWorkspace !== undefined ? next : null;
}

export function issueRuntimeSelectorSummary(
  agent: Agent,
  overrides: IssueAssigneeAgentRuntimeOverrides | null | undefined,
): string {
  const model = overrideValue(overrides, "model") ?? configuredModel(agent);
  const key = runtimeEffortKey(agent.agentRuntimeType);
  const effort = key ? configuredOverrideEffort(overrides, key) ?? configuredEffort(agent) : null;
  const source = overrides?.agentRuntimeConfig?.model || (key && configuredOverrideEffort(overrides, key))
    ? "Issue override"
    : "Agent default";
  return key ? `${source} · ${model} · ${effortLabel(effort)}` : `${source} · ${model}`;
}

export function IssueRuntimeSelector({
  agent,
  orgId,
  overrides,
  onApply,
  variant = "compact",
  disabled = false,
}: IssueRuntimeSelectorProps) {
  const supported = supportsIssueRuntimeOverrides(agent);
  const [open, setOpen] = useState(false);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const [draftInitialized, setDraftInitialized] = useState(false);
  const effortKey = runtimeEffortKey(agent.agentRuntimeType)!;
  const adapterModelsQuery = useQuery({
    queryKey: queryKeys.agents.adapterModels(orgId, agent.agentRuntimeType),
    queryFn: () => agentsApi.adapterModels(orgId, agent.agentRuntimeType),
    enabled: open && supported,
    retry: false,
  });
  const currentModel = overrideValue(overrides, "model");
  const currentEffort = configuredOverrideEffort(overrides, effortKey);
  const selectedModel = draftInitialized ? draftModel : currentModel;
  const selectedEffort = draftInitialized ? draftEffort : currentEffort;
  const effectiveModel = selectedModel ?? configuredModel(agent);
  const options = modelOptions(agent, adapterModelsQuery.data, selectedModel);
  const thinkingOptions = effortOptions(agent, effectiveModel);
  const effectiveEffort = selectedEffort;
  const summary = issueRuntimeSelectorSummary(agent, overrides);

  if (!supported) return null;

  const openSelector = (nextOpen: boolean) => {
    if (nextOpen) {
      setDraftModel(currentModel);
      setDraftEffort(currentEffort);
      setDraftInitialized(true);
    } else {
      setDraftInitialized(false);
    }
    setOpen(nextOpen);
  };

  const apply = () => {
    onApply(buildOverrides(overrides, draftModel, draftEffort, effortKey));
    setOpen(false);
  };

  const selectModel = (nextModel: string | null) => {
    setDraftModel(nextModel);
    if (nextModel == null) {
      setDraftEffort(null);
      return;
    }
    const nextEffectiveModel = nextModel ?? configuredModel(agent);
    const nextEfforts = effortOptions(agent, nextEffectiveModel);
    if (draftEffort && !nextEfforts.some((option) => option.id === draftEffort)) {
      setDraftEffort(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={openSelector}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="issue-runtime-selector"
          aria-label={`Run profile for ${agent.name}`}
          className={cn(
            "inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground",
            variant === "menu" && "w-full justify-between px-2 py-1.5 text-xs",
            disabled && "cursor-not-allowed opacity-60",
          )}
          disabled={disabled}
          title={summary}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{variant === "menu" ? "Run profile" : summary}</span>
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={variant === "menu" ? "start" : "end"}
        side={variant === "menu" ? "right" : "bottom"}
        sideOffset={6}
        className="w-72 p-2"
      >
        <div className="mb-2 border-b border-border pb-2">
          <p className="text-xs font-medium text-foreground">Run profile</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Applies to runs that have not started.
          </p>
        </div>
        <div className="space-y-1" role="listbox" aria-label="Issue model">
          <p className="px-2 pt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Model</p>
          <button
            type="button"
            role="option"
            aria-selected={selectedModel == null}
            data-testid="issue-runtime-option-default-model"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/60"
            onClick={() => selectModel(null)}
          >
            <span className="min-w-0 flex-1 truncate">Agent default · {configuredModel(agent)}</span>
            {draftModel == null ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
          </button>
          {adapterModelsQuery.isPending ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading models...
            </div>
          ) : options.length > 0 ? options.map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={selectedModel === model.id}
              data-testid={`issue-runtime-option-model-${model.id}`}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/60"
              onClick={() => selectModel(model.id)}
            >
              <span className="min-w-0 flex-1 truncate">{model.label}</span>
              {selectedModel === model.id ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
            </button>
          )) : (
            <p className="px-2 py-2 text-xs text-muted-foreground">No models found.</p>
          )}
        </div>
        <div className="mt-2 border-t border-border pt-2" role="listbox" aria-label="Issue thinking effort">
          <p className="px-2 pt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Thinking</p>
          {thinkingOptions.map((option) => (
            <button
              key={option.id ?? "default"}
              type="button"
              role="option"
              aria-selected={effectiveEffort === option.id}
              data-testid={`issue-runtime-option-effort-${option.id ?? "default"}`}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/60"
              onClick={() => setDraftEffort(option.id)}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}{option.id == null ? ` · ${effortLabel(configuredEffort(agent))}` : ""}</span>
              {effectiveEffort === option.id ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
        <div className="mt-2 flex justify-end gap-2 border-t border-border pt-2">
          <button type="button" className="rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/60" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="button" data-testid="issue-runtime-apply" className="rounded bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90" onClick={apply}>
            Apply
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
