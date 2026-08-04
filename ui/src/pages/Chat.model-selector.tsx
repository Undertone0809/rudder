import type { AgentRuntimeModel } from "@/api/agents";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import {
  shouldShowThinkingEffort,
  thinkingEffortKeyForRuntime,
  thinkingEffortLabelForRuntime,
  thinkingEffortOptionsForRuntime,
} from "@/components/AgentConfigForm.helpers";
import { AgentIcon } from "@/components/AgentIconPicker";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { formatChatAgentLabel } from "@/lib/agent-labels";
import { queryKeys } from "@/lib/queryKeys";
import { resolveRuntimeModels } from "@/lib/runtime-models";
import { cn } from "@/lib/utils";
import type { Agent, ChatConversation, ChatRuntimeDescriptor } from "@rudderhq/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, Check, ChevronLeft, ChevronRight, Loader2, Lock } from "lucide-react";
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

export type PendingChatRuntimeOverrides = { chatId: string } & ChatRuntimeOverrides;

export function useChatRuntimeSelection(input: {
  selectedOrganizationId: string | null | undefined;
  selectedConversation: ChatConversation | null;
  activeAgentId: string | null;
  activeAgent: Agent | null;
}) {
  const [draftRuntimeOverrides, setDraftRuntimeOverrides] = useState<ChatRuntimeOverrides>({
    modelOverride: null,
    effortOverride: null,
  });
  const [
    pendingConversationRuntimeOverrides,
    setPendingConversationRuntimeOverrides,
  ] = useState<PendingChatRuntimeOverrides | null>(null);
  const draftRuntimeAgentScopeRef = useRef<string | null>(null);
  const runtimeSelectorRef = useRef<HTMLButtonElement>(null);
  const runtimeModelSelectRef = useRef<HTMLButtonElement>(null);
  const activeRuntimeOverrides: ChatRuntimeOverrides = input.selectedConversation
    ? pendingConversationRuntimeOverrides?.chatId === input.selectedConversation.id
      ? pendingConversationRuntimeOverrides
      : {
          modelOverride: input.selectedConversation.modelOverride ?? null,
          effortOverride: input.selectedConversation.effortOverride ?? null,
        }
    : draftRuntimeOverrides;
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
    if (input.selectedConversation) {
      draftRuntimeAgentScopeRef.current = null;
      return;
    }
    const nextScope =
      `${input.selectedOrganizationId ?? "__none__"}:${input.activeAgentId ?? "__none__"}`;
    if (
      draftRuntimeAgentScopeRef.current !== null
      && draftRuntimeAgentScopeRef.current !== nextScope
    ) {
      setDraftRuntimeOverrides({ modelOverride: null, effortOverride: null });
    }
    draftRuntimeAgentScopeRef.current = nextScope;
  }, [input.activeAgentId, input.selectedConversation, input.selectedOrganizationId]);

  return {
    activeRuntimeOverrides,
    adapterModelsQuery,
    draftRuntimeOverrides,
    runtimeModelSelectRef,
    runtimeSelectorRef,
    setDraftRuntimeOverrides,
    setPendingConversationRuntimeOverrides,
  };
}

export function useChatRuntimeMutation(input: {
  activeAgent: Agent | null;
  selectedConversation: ChatConversation | null;
  setDraftRuntimeOverrides: Dispatch<SetStateAction<ChatRuntimeOverrides>>;
  setPendingConversationRuntimeOverrides:
    Dispatch<SetStateAction<PendingChatRuntimeOverrides | null>>;
  upsertConversation: (conversation: ChatConversation) => void;
  upsertMessengerThreadSummary: (conversation: ChatConversation) => void;
  refreshActiveChatActions: (chatId: string) => Promise<unknown>;
  reportError: (title: string, body: string) => void;
}) {
  const mutation = useMutation({
    mutationFn: ({
      chatId,
      modelOverride,
      effortOverride,
    }: PendingChatRuntimeOverrides) =>
      chatsApi.update(chatId, { modelOverride, effortOverride }),
    onMutate: input.setPendingConversationRuntimeOverrides,
    onSuccess: async (conversation) => {
      input.setPendingConversationRuntimeOverrides((current) => (
        current?.chatId === conversation.id ? null : current
      ));
      input.upsertConversation(conversation);
      input.upsertMessengerThreadSummary(conversation);
      await input.refreshActiveChatActions(conversation.id);
    },
    onError: (error, variables) => {
      input.setPendingConversationRuntimeOverrides((current) => (
        current?.chatId === variables.chatId ? null : current
      ));
      input.reportError(
        "Failed to update conversation runtime",
        error instanceof Error ? error.message : "Try again.",
      );
    },
  });
  const applyRuntimeOverrides = (overrides: ChatRuntimeOverrides) => {
    if (!input.activeAgent || mutation.isPending) return;
    if (!input.selectedConversation) {
      input.setDraftRuntimeOverrides(overrides);
      return;
    }
    if (input.selectedConversation.mutability === "external_bound_chat") return;
    mutation.mutate({ chatId: input.selectedConversation.id, ...overrides });
  };
  return {
    applyRuntimeOverrides,
    runtimeSelectionPending: mutation.isPending,
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
    ?? input.runtime?.model
    ?? configuredAgentModel(input.agent);
  const modelMetadata = input.adapterModels?.find((candidate) => candidate.id === model);
  if (!shouldShowThinkingEffort(input.agent.agentRuntimeType, model, modelMetadata)) return model;
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
  modelSelectRef?: Ref<HTMLButtonElement>;
  onChange: (overrides: ChatRuntimeOverrides) => void;
}) {
  const [activeSubmenu, setActiveSubmenu] = useState<"model" | "effort" | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<CSSProperties | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const effortTriggerRef = useRef<HTMLButtonElement | null>(null);
  const firstModelOptionRef = useRef<HTMLButtonElement | null>(null);
  const firstEffortOptionRef = useRef<HTMLButtonElement | null>(null);
  const modelSubmenuScrollRef = useScrollbarActivityRef();
  const effortSubmenuScrollRef = useScrollbarActivityRef();
  const options = chatConversationModelOptions(
    props.agent,
    props.adapterModels,
    props.overrides.modelOverride,
  );
  const configuredModel = configuredAgentModel(props.agent);
  const configuredEffort = configuredAgentEffort(props.agent);
  const effortControlLabel = thinkingEffortLabelForRuntime(props.agent.agentRuntimeType);
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
  const disabled = props.disabled || props.pending;
  const effectiveEffort = currentEffortOverride ?? configuredEffort;
  const setModelTriggerRefs = (node: HTMLButtonElement | null) => {
    modelTriggerRef.current = node;
    if (typeof props.modelSelectRef === "function") props.modelSelectRef(node);
    else if (props.modelSelectRef) props.modelSelectRef.current = node;
  };
  const openSubmenu = (
    kind: "model" | "effort",
    trigger: HTMLButtonElement | null,
    focusFirstOption = false,
  ) => {
    if (disabled || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 256;
    const viewportPadding = 12;
    const availableRight = window.innerWidth - rect.right;
    const left = availableRight >= width + viewportPadding
      ? rect.right + 8
      : Math.max(viewportPadding, rect.left - width - 8);
    setSubmenuPosition({
      left,
      top: Math.max(
        viewportPadding,
        Math.min(rect.top, window.innerHeight - viewportPadding - 320),
      ),
    });
    setActiveSubmenu(kind);
    if (focusFirstOption) {
      requestAnimationFrame(() => {
        (kind === "model" ? firstModelOptionRef : firstEffortOptionRef).current?.focus();
      });
    }
  };
  const closeSubmenu = (kind: "model" | "effort") => {
    setActiveSubmenu(null);
    requestAnimationFrame(() => {
      (kind === "model" ? modelTriggerRef : effortTriggerRef).current?.focus();
    });
  };
  const handleSubmenuKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    kind: "model" | "effort",
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeSubmenu(kind);
  };
  const submenuClassName = cn(
    "surface-overlay scrollbar-auto-hide scrollbar-menu-inset fixed z-[70] max-h-80 w-64 overflow-y-auto rounded-[var(--radius-lg)] border p-1.5 shadow-lg",
  );
  const triggerClassName = cn(
    "chat-composer-menu-row grid min-h-10 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2",
    disabled && "cursor-not-allowed opacity-60",
  );

  return (
    <div className="relative min-w-0">
      <div className="relative">
        <button
          ref={setModelTriggerRefs}
          type="button"
          data-testid="chat-model-selector"
          aria-label={`Model for this conversation (${props.agent.name} runtime)`}
          aria-haspopup="listbox"
          aria-expanded={activeSubmenu === "model"}
          className={triggerClassName}
          disabled={disabled}
          title={errorMessage ?? "Only this conversation will use the selected model."}
          data-value={props.overrides.modelOverride ?? ""}
          onPointerEnter={() => openSubmenu("model", modelTriggerRef.current)}
          onClick={() => openSubmenu("model", modelTriggerRef.current, true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              openSubmenu("model", modelTriggerRef.current, true);
            }
          }}
        >
          <span className="font-medium text-foreground">Model</span>
          <span className="min-w-0 truncate text-right text-muted-foreground">
            {effectiveModel}
          </span>
          {props.isLoading || props.pending ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}
        </button>
        {activeSubmenu === "model" && submenuPosition && typeof document !== "undefined" ? createPortal(
          <div
            ref={modelSubmenuScrollRef}
            data-chat-runtime-submenu
            data-testid="chat-model-options"
            role="listbox"
            aria-label="Conversation model"
            className={submenuClassName}
            style={submenuPosition}
            onKeyDown={(event) => handleSubmenuKeyDown(event, "model")}
          >
            <button
              ref={firstModelOptionRef}
              type="button"
              role="option"
              aria-selected={props.overrides.modelOverride == null}
              data-testid="chat-model-option-default"
              className="chat-composer-menu-row"
              onClick={() => {
                props.onChange(normalizedChatRuntimeOverridesForModel(
                  props.agent,
                  props.overrides,
                  null,
                  options.find((candidate) => candidate.id === configuredModel),
                ));
                setActiveSubmenu(null);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{`Agent default · ${configuredModel}`}</span>
              {props.overrides.modelOverride == null ? (
                <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : null}
            </button>
            {options.map((model) => {
              const selected = props.overrides.modelOverride === model.id;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-testid={`chat-model-option-${model.id}`}
                  className="chat-composer-menu-row"
                  onClick={() => {
                    props.onChange(normalizedChatRuntimeOverridesForModel(
                      props.agent,
                      props.overrides,
                      model.id,
                      model,
                    ));
                    setActiveSubmenu(null);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{model.label}</span>
                  {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                </button>
              );
            })}
            {errorMessage && options.length === 0 ? (
              <div className="px-2.5 py-2 text-xs text-muted-foreground">
                Models unavailable
              </div>
            ) : null}
          </div>,
          document.body,
        ) : null}
      </div>
      {showThinkingEffort ? (
        <div className="relative">
          <button
            ref={effortTriggerRef}
            type="button"
            data-testid="chat-effort-selector"
            aria-label={`${effortControlLabel} for this conversation (${props.agent.name} runtime)`}
            aria-haspopup="listbox"
            aria-expanded={activeSubmenu === "effort"}
            className={triggerClassName}
            disabled={disabled}
            data-value={currentEffortOverride ?? ""}
            onPointerEnter={() => openSubmenu("effort", effortTriggerRef.current)}
            onClick={() => openSubmenu("effort", effortTriggerRef.current, true)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                openSubmenu("effort", effortTriggerRef.current, true);
              }
            }}
          >
            <span className="font-medium text-foreground">
              Thinking
            </span>
            <span className="min-w-0 truncate text-right text-muted-foreground">
              {effortLabel(effectiveEffort)}
            </span>
            {props.pending ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            )}
          </button>
          {activeSubmenu === "effort" && submenuPosition && typeof document !== "undefined" ? createPortal(
            <div
              ref={effortSubmenuScrollRef}
              data-chat-runtime-submenu
              data-testid="chat-effort-options"
              role="listbox"
              aria-label={`Conversation ${effortControlLabel.toLowerCase()}`}
              className={submenuClassName}
              style={submenuPosition}
              onKeyDown={(event) => handleSubmenuKeyDown(event, "effort")}
            >
              <button
                ref={firstEffortOptionRef}
                type="button"
                role="option"
                aria-selected={currentEffortOverride == null}
                data-testid="chat-effort-option-default"
                className="chat-composer-menu-row"
                onClick={() => {
                  props.onChange({ ...props.overrides, effortOverride: null });
                  setActiveSubmenu(null);
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {`Agent default · ${effortLabel(configuredEffort)}`}
                </span>
                {currentEffortOverride == null ? (
                  <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : null}
              </button>
              {effortOptions.map((option) => {
                const selected = currentEffortOverride === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-testid={`chat-effort-option-${option.id}`}
                    className="chat-composer-menu-row"
                    onClick={() => {
                      props.onChange({ ...props.overrides, effortOverride: option.id });
                      setActiveSubmenu(null);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          ) : null}
        </div>
      ) : null}
      {props.pending || errorMessage ? (
        <div className="mt-1 flex min-h-7 items-center gap-1.5 border-t border-[color:var(--border-soft)] px-2.5 pt-1.5 text-[11px] text-muted-foreground">
          {props.pending ? (
            <Loader2
              aria-label="Saving runtime selection"
              className="h-3.5 w-3.5 shrink-0 animate-spin"
            />
          ) : null}
          <span>{props.pending ? "Saving for this conversation…" : errorMessage}</span>
        </div>
      ) : null}
      {errorMessage ? (
        <span className="sr-only" role="status">{errorMessage}</span>
      ) : null}
    </div>
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
          data-testid="chat-agent-runtime-panel"
          role="dialog"
          aria-label={`Model and thinking for ${props.agent.name}`}
          className="surface-overlay fixed z-[65] w-[19rem] max-w-[calc(100vw-1.5rem)] rounded-[var(--radius-lg)] border p-1.5 shadow-lg"
          style={position}
          onKeyDown={(event) => {
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
            {selected ? (
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
