import type { AgentRuntimeModel } from "@/api/agents";
import { resolveRuntimeModels } from "@/lib/runtime-models";
import { cn } from "@/lib/utils";
import type { Agent } from "@rudderhq/shared";
import { Loader2 } from "lucide-react";

function configuredAgentModel(agent: Agent) {
  const configured = agent.agentRuntimeConfig.model ?? agent.runtimeConfig.model;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : "Default model";
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

export function ChatConversationModelSelect(props: {
  agent: Agent;
  adapterModels: readonly AgentRuntimeModel[] | null | undefined;
  modelOverride: string | null;
  disabled?: boolean;
  isLoading?: boolean;
  error?: unknown;
  pending?: boolean;
  onChange: (modelOverride: string | null) => void;
}) {
  const options = chatConversationModelOptions(
    props.agent,
    props.adapterModels,
    props.modelOverride,
  );
  const errorMessage = props.error instanceof Error
    ? props.error.message
    : props.error
      ? "Models are temporarily unavailable."
      : null;
  const disabled = props.disabled || props.pending;

  return (
    <span className="flex min-w-0 max-w-[min(48vw,15rem)] shrink items-center gap-1.5">
      <select
        data-testid="chat-model-selector"
        aria-label={`Model for ${props.agent.name}`}
        className={cn(
          "h-7 min-w-0 max-w-full rounded-[var(--radius-sm)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-2 text-[11px] text-foreground outline-hidden",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
          disabled && "cursor-not-allowed opacity-60",
        )}
        disabled={disabled}
        title={errorMessage ?? "Only this conversation will use the selected model."}
        value={props.modelOverride ?? ""}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => props.onChange(event.target.value || null)}
      >
        <option value="">{`Agent default · ${configuredAgentModel(props.agent)}`}</option>
        {options.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
        {errorMessage && options.length === 0 ? (
          <option value="__models_unavailable__" disabled>Models unavailable</option>
        ) : null}
      </select>
      {props.isLoading || props.pending ? (
        <Loader2
          aria-label={props.pending ? "Saving model" : "Loading models"}
          className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
        />
      ) : null}
      {errorMessage ? (
        <span className="sr-only" role="status">{errorMessage}</span>
      ) : null}
    </span>
  );
}
