import type { AgentRuntimeModel } from "@/api/agents";
import { agentsApi } from "@/api/agents";
import {
  shouldShowThinkingEffort,
  thinkingEffortKeyForRuntime,
  thinkingEffortOptionsForRuntime,
} from "@/components/AgentConfigForm.helpers";
import { AgentIcon } from "@/components/AgentIconPicker";
import { RuntimeProfileControls } from "@/components/RuntimeProfileControls";
import { formatChatAgentLabel } from "@/lib/agent-labels";
import { queryKeys } from "@/lib/queryKeys";
import { resolveRuntimeModels } from "@/lib/runtime-models";
import { cn } from "@/lib/utils";
import type { Agent, ChatConversation, ChatRuntimeDescriptor } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronLeft, ChevronRight, Loader2, Lock } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent,
  type Ref,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";

export type ChatRuntimeOverrides = {
  modelOverride: string | null;
  effortOverride: string | null;
};

export function useChatRuntimeSelection(input: {
  selectedOrganizationId: string | null | undefined;
  selectedConversation: ChatConversation | null;
  activeAgentId: string | null;
  activeAgent: Agent | null;
  composerScopeKey?: string;
}) {
  const [draftRuntimeOverrides, setDraftRuntimeOverrides] = useState<ChatRuntimeOverrides>({
    modelOverride: null,
    effortOverride: null,
  });
  const draftRuntimeAgentScopeRef = useRef<string | null>(null);
  const runtimeSelectorRef = useRef<HTMLButtonElement>(null);
  const runtimeModelSelectRef = useRef<HTMLButtonElement>(null);
  const activeRuntimeOverrides = draftRuntimeOverrides;
  const adapterModelsQuery = useQuery({
    queryKey: input.activeAgent && input.selectedOrganizationId
      ? queryKeys.agents.adapterModels(
          input.selectedOrganizationId,
          input.activeAgent.agentRuntimeType,
        )
      : queryKeys.agents.adapterModels("__none__", "__none__"),
    queryFn: () => agentsApi.adapterModels(
      input.selectedOrganizationId!,
      input.activeAgent!.agentRuntimeType,
    ),
    enabled: Boolean(input.selectedOrganizationId) && Boolean(input.activeAgent),
    retry: false,
  });

  useEffect(() => {
    const nextScope =
      `${input.selectedOrganizationId ?? "__none__"}:${input.composerScopeKey ?? input.selectedConversation?.id ?? "new"}:${input.activeAgentId ?? "__none__"}`;
    if (
      draftRuntimeAgentScopeRef.current !== null
      && draftRuntimeAgentScopeRef.current !== nextScope
    ) {
      setDraftRuntimeOverrides({ modelOverride: null, effortOverride: null });
    }
    draftRuntimeAgentScopeRef.current = nextScope;
  }, [
    input.activeAgentId,
    input.composerScopeKey,
    input.selectedConversation?.id,
    input.selectedOrganizationId,
  ]);

  return {
    activeRuntimeOverrides,
    adapterModelsQuery,
    draftRuntimeOverrides,
    runtimeModelSelectRef,
    runtimeSelectorRef,
    setDraftRuntimeOverrides,
  };
}

export function useChatRuntimeMutation(input: {
  activeAgent: Agent | null;
  setDraftRuntimeOverrides: Dispatch<SetStateAction<ChatRuntimeOverrides>>;
}) {
  const applyRuntimeOverrides = (overrides: ChatRuntimeOverrides) => {
    if (!input.activeAgent) return;
    input.setDraftRuntimeOverrides(overrides);
  };
  return {
    applyRuntimeOverrides,
    runtimeSelectionPending: false,
  };
}

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
  modelMetadata?: AgentRuntimeModel,
): ChatRuntimeOverrides {
  const model = modelOverride ?? configuredAgentModel(agent);
  if (!shouldShowThinkingEffort(agent.agentRuntimeType, model, modelMetadata)) {
    return { modelOverride, effortOverride: null };
  }
  const supportedEfforts = thinkingEffortOptionsForRuntime(
    agent.agentRuntimeType,
    model,
    modelMetadata,
  );
  return {
    modelOverride,
    // A runtime model owns its available levels. Do not carry an override into
    // a model whose official catalog does not expose that level.
    effortOverride: current.effortOverride
      && supportedEfforts.some((option) => option.id === current.effortOverride)
      ? current.effortOverride
      : null,
  };
}

export function chatRuntimeSelectionLabel(input: {
  agent: Agent | null;
  runtime: ChatRuntimeDescriptor | null;
  overrides: ChatRuntimeOverrides;
  adapterModels?: readonly AgentRuntimeModel[] | null;
}) {
  if (!input.agent) return "Loading runtime";
  const model = input.overrides.modelOverride
    ?? configuredAgentModel(input.agent);
  const modelMetadata = input.adapterModels?.find((candidate) => candidate.id === model);
  if (!shouldShowThinkingEffort(input.agent.agentRuntimeType, model, modelMetadata)) return model;
  const effort = input.overrides.effortOverride == null
    ? configuredAgentEffort(input.agent)
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
  modelSelectRef?: Ref<HTMLButtonElement>;
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
  const effectiveModelMetadata = options.find((candidate) => candidate.id === effectiveModel);
  const showThinkingEffort = shouldShowThinkingEffort(
    props.agent.agentRuntimeType,
    effectiveModel,
    effectiveModelMetadata,
  );
  const effortOptions = thinkingEffortOptionsForRuntime(
    props.agent.agentRuntimeType,
    effectiveModel,
    effectiveModelMetadata,
  ).map((option) => ({
    id: option.id || "auto",
    label: option.label,
  }));
  const currentEffortOverride = props.overrides.effortOverride;
  const errorMessage = props.error instanceof Error
    ? props.error.message
    : props.error
      ? "Models are temporarily unavailable."
      : null;
  const effectiveEffort = currentEffortOverride ?? configuredEffort;

  return (
    <RuntimeProfileControls
      ariaContext={`this conversation (${props.agent.name} runtime)`}
      disabled={props.disabled}
      pending={props.pending}
      errorMessage={errorMessage}
      modelSelectRef={props.modelSelectRef}
      testIds={{
        modelTrigger: "chat-model-selector",
        modelOptions: "chat-model-options",
        modelOption: (id) => id == null ? "chat-model-option-default" : `chat-model-option-${id}`,
        effortTrigger: "chat-effort-selector",
        effortOptions: "chat-effort-options",
        effortOption: (id) => id == null ? "chat-effort-option-default" : `chat-effort-option-${id}`,
      }}
      model={{
        valueLabel: effectiveModel,
        dataValue: props.overrides.modelOverride ?? "",
        selectedId: props.overrides.modelOverride,
        defaultOption: { id: null, label: `Agent default · ${configuredModel}` },
        options,
        loading: props.isLoading,
        emptyLabel: errorMessage ? "Models unavailable" : "No models found.",
        onSelect: (modelOverride) => props.onChange(normalizedChatRuntimeOverridesForModel(
          props.agent,
          props.overrides,
          modelOverride,
          options.find((candidate) => candidate.id === (modelOverride ?? configuredModel)),
        )),
      }}
      effort={showThinkingEffort ? {
        valueLabel: effortLabel(effectiveEffort),
        dataValue: currentEffortOverride ?? "",
        selectedId: currentEffortOverride,
        defaultOption: { id: null, label: `Agent default · ${effortLabel(configuredEffort)}` },
        options: effortOptions,
        onSelect: (effortOverride) => props.onChange({ ...props.overrides, effortOverride }),
      } : undefined}
    />
  );
}

export function ChatAgentRuntimeSelector(props: {
  agent: Agent | null;
  adapterModels: readonly AgentRuntimeModel[] | null | undefined;
  overrides: ChatRuntimeOverrides;
  label: string;
  disabled?: boolean;
  isLoading?: boolean;
  error?: unknown;
  pending?: boolean;
  panelPlacement?: "side" | "above";
  modelSelectRef?: Ref<HTMLButtonElement>;
  onChange: (overrides: ChatRuntimeOverrides) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const openPanel = () => {
    if (!props.agent || props.disabled || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = 304;
    const viewportPadding = 12;
    if (props.panelPlacement === "above") {
      setPosition({
        left: Math.max(
          viewportPadding,
          Math.min(rect.right - width, window.innerWidth - width - viewportPadding),
        ),
        bottom: Math.max(viewportPadding, window.innerHeight - rect.top + 8),
      });
      setOpen(true);
      return;
    }
    const availableRight = window.innerWidth - rect.right;
    setPosition({
      left: availableRight >= width + viewportPadding
        ? rect.right + 8
        : Math.max(viewportPadding, rect.left - width - 8),
      top: Math.max(
        viewportPadding,
        Math.min(rect.top, window.innerHeight - viewportPadding - 360),
      ),
    });
    setOpen(true);
  };
  useEffect(() => {
    if (!open || !props.modelSelectRef || typeof props.modelSelectRef !== "object") return;
    const modelSelectRef = props.modelSelectRef;
    requestAnimationFrame(() => modelSelectRef.current?.focus());
  }, [open, props.modelSelectRef]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        data-chat-composer-menu-item
        data-testid="chat-agent-runtime-selector"
        aria-label={`Configure model and thinking for ${props.agent?.name ?? "selected agent"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!props.agent || props.disabled}
        className={cn(
          "inline-flex min-w-0 max-w-44 items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1",
          "text-[11px] text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-55",
        )}
        onClick={(event) => {
          event.stopPropagation();
          if (open) {
            setOpen(false);
            return;
          }
          openPanel();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            openPanel();
          }
        }}
      >
        <span className="min-w-0 truncate">{props.label}</span>
        {props.pending ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
      </button>
      {open && position && props.agent && typeof document !== "undefined" ? createPortal(
        <div
          data-chat-runtime-submenu
          data-runtime-profile-panel
          data-testid="chat-agent-runtime-panel"
          role="dialog"
          aria-label={`Model and thinking for ${props.agent.name}`}
          className="surface-overlay fixed z-[65] w-[19rem] max-w-[calc(100vw-1.5rem)] rounded-[var(--radius-lg)] border p-1.5 shadow-lg"
          style={position}
          onKeyDownCapture={(event) => {
            if (event.key !== "Escape" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            requestAnimationFrame(() => triggerRef.current?.focus());
          }}
        >
          <button
            type="button"
            className="chat-composer-menu-row mb-1"
            onClick={() => {
              setOpen(false);
              requestAnimationFrame(() => triggerRef.current?.focus());
            }}
          >
            <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium">{props.agent.name}</span>
          </button>
          <div className="border-t border-[color:var(--border-soft)] pt-1">
            <ChatConversationRuntimeControls
              agent={props.agent}
              adapterModels={props.adapterModels}
              overrides={props.overrides}
              disabled={props.disabled}
              isLoading={props.isLoading}
              error={props.error}
              pending={props.pending}
              modelSelectRef={props.modelSelectRef}
              onChange={props.onChange}
            />
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export function handleChatAgentMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  if (event.target instanceof Element && event.target.closest("[data-chat-runtime-submenu]")) return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-chat-composer-menu-item]:not(:disabled)"),
  );
  if (items.length === 0) return;
  event.preventDefault();
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? items.length - 1
      : event.key === "ArrowUp"
        ? (currentIndex <= 0 ? items.length - 1 : currentIndex - 1)
        : (currentIndex < 0 || currentIndex === items.length - 1 ? 0 : currentIndex + 1);
  items[nextIndex]?.focus();
}

export function ChatAgentMenuContent(props: {
  agents: readonly Agent[];
  activeAgentId: string;
  agentSelectionLocked: boolean;
  runtimeSelectionPending: boolean;
  newConversationSendInFlight: boolean;
  externalBound: boolean;
  adapterModels: readonly AgentRuntimeModel[] | null | undefined;
  overrides: ChatRuntimeOverrides;
  runtimeLabel: string;
  isLoading?: boolean;
  error?: unknown;
  runtimePanelPlacement?: "side" | "above";
  modelSelectRef?: Ref<HTMLButtonElement>;
  onSelectAgent: (agentId: string) => void;
  onChangeRuntime: (overrides: ChatRuntimeOverrides) => void;
  showRuntimeControls?: boolean;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <span>Agents</span>
        {props.agentSelectionLocked ? (
          <span className="inline-flex items-center gap-1" data-testid="chat-agent-lock-state">
            <Lock className="h-3 w-3" aria-hidden="true" />
            Bound to chat
          </span>
        ) : null}
      </div>
      {props.agents.length === 0 ? (
        <div className="flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm text-muted-foreground">
          <Bot className="h-4 w-4 shrink-0" />
          <span>Create or activate an agent before sending messages.</span>
        </div>
      ) : props.agents.map((agent) => {
        const selected = props.activeAgentId === agent.id;
        const choiceDisabled = props.runtimeSelectionPending
          || props.newConversationSendInFlight
          || (props.agentSelectionLocked && !selected)
          || props.externalBound;
        return (
          <div
            key={agent.id}
            data-testid={`chat-agent-option-${agent.id}`}
            data-selected={selected ? "true" : undefined}
            className={cn(
              "flex min-h-10 items-center gap-1 rounded-[var(--radius-md)]",
              selected && "bg-[color:var(--surface-active)]",
            )}
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              aria-disabled={choiceDisabled || selected}
              disabled={choiceDisabled && !selected}
              data-chat-composer-menu-item
              className="chat-composer-menu-row min-w-0 flex-1 disabled:cursor-default disabled:opacity-100"
              onClick={() => props.onSelectAgent(agent.id)}
            >
              <AgentIcon icon={agent.icon} role={agent.role} className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left font-medium">
                {formatChatAgentLabel(agent)}
              </span>
              {props.agentSelectionLocked && !selected ? (
                <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Unavailable after chat starts" />
              ) : null}
            </button>
            {selected && props.showRuntimeControls !== false ? (
              <ChatAgentRuntimeSelector
                agent={agent}
                adapterModels={props.adapterModels}
                overrides={props.overrides}
                label={props.runtimeLabel}
                disabled={props.externalBound || props.newConversationSendInFlight}
                isLoading={props.isLoading}
                error={props.error}
                pending={props.runtimeSelectionPending}
                panelPlacement={props.runtimePanelPlacement}
                modelSelectRef={props.modelSelectRef}
                onChange={props.onChangeRuntime}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function ChatAgentSelectorButton(props: {
  agent: Agent | null;
  label: string;
  expanded: boolean;
  disabled: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  onClick: () => void;
}) {
  return (
    <button
      ref={props.buttonRef}
      type="button"
      data-testid="chat-agent-selector"
      aria-label={`Chat agent: ${props.label}`}
      aria-expanded={props.expanded}
      disabled={props.disabled}
      className={cn(
        "chat-chip inline-flex max-w-[min(100%,16rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium",
        "transition-colors hover:bg-[color:var(--surface-active)] disabled:cursor-not-allowed disabled:opacity-60",
        props.expanded && "bg-[color:var(--surface-active)]",
      )}
      onClick={props.onClick}
    >
      {props.agent ? (
        <AgentIcon
          icon={props.agent.icon}
          role={props.agent.role}
          testId="chat-agent-selector-icon"
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
      ) : null}
      <span className="min-w-0 truncate">{props.label}</span>
    </button>
  );
}
