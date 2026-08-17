import type { AgentRuntimeModel } from "@/api/agents";
import { agentsApi } from "@/api/agents";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { queryKeys } from "@/lib/queryKeys";
import { resolveRuntimeModels } from "@/lib/runtime-models";
import {
  claudeLocalThinkingEffortOptionsForModel,
  codexLocalReasoningEffortOptionsForModel,
  cursorLocalThinkingEffortOptionsForModel,
  openCodeLocalVariantOptionsForModel,
  piLocalThinkingEffortOptionsForModel,
} from "@/lib/runtime-thinking-effort";
import { cn } from "@/lib/utils";
import type { Agent, IssueAssigneeAgentRuntimeOverrides } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

const ISSUE_OVERRIDE_RUNTIME_TYPES = new Set(["claude_local", "codex_local", "opencode_local", "pi_local", "cursor"]);

export function supportsIssueRuntimeOverrides(agent: Agent | null | undefined): boolean {
  return Boolean(agent && ISSUE_OVERRIDE_RUNTIME_TYPES.has(agent.agentRuntimeType));
}

type SelectorVariant = "compact" | "icon" | "menu";

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
  if (runtimeType === "pi_local") return "thinking";
  if (runtimeType === "cursor") return "effort";
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

function effortOptions(agent: Agent, model: string, metadata?: AgentRuntimeModel): EffortOption[] {
  const options = agent.agentRuntimeType === "claude_local"
    ? claudeLocalThinkingEffortOptionsForModel(model, metadata)
    : agent.agentRuntimeType === "codex_local"
      ? codexLocalReasoningEffortOptionsForModel(model, metadata)
      : agent.agentRuntimeType === "opencode_local"
        ? openCodeLocalVariantOptionsForModel(model, metadata)
          : agent.agentRuntimeType === "pi_local"
            ? piLocalThinkingEffortOptionsForModel(model, metadata)
            : agent.agentRuntimeType === "cursor"
              ? cursorLocalThinkingEffortOptionsForModel(model, metadata)
            : [];
  return [
    { id: null, label: "Agent default" },
    ...options
      .filter((option) => option.value.length > 0)
      .map((option) => ({ id: option.value, label: option.label })),
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
    ? "Custom profile"
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<"model" | "effort" | null>(null);
  const [menuPosition, setMenuPosition] = useState<CSSProperties | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<CSSProperties | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const [draftInitialized, setDraftInitialized] = useState(false);
  const menuRootRef = useRef<HTMLDivElement | null>(null);
  const submenuRootRef = useRef<HTMLDivElement | null>(null);
  const submenuScrollRef = useScrollbarActivityRef();
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const effortTriggerRef = useRef<HTMLButtonElement | null>(null);
  const firstModelOptionRef = useRef<HTMLButtonElement | null>(null);
  const firstEffortOptionRef = useRef<HTMLButtonElement | null>(null);
  const effortKey = runtimeEffortKey(agent.agentRuntimeType)!;
  const adapterModelsQuery = useQuery({
    queryKey: queryKeys.agents.adapterModels(orgId, agent.agentRuntimeType),
    queryFn: () => agentsApi.adapterModels(orgId, agent.agentRuntimeType),
    enabled: (open || menuOpen) && supported,
    retry: false,
  });
  const currentModel = overrideValue(overrides, "model");
  const currentEffort = configuredOverrideEffort(overrides, effortKey);
  const selectedModel = draftInitialized ? draftModel : currentModel;
  const selectedEffort = draftInitialized ? draftEffort : currentEffort;
  const effectiveModel = selectedModel ?? configuredModel(agent);
  const options = modelOptions(agent, adapterModelsQuery.data, selectedModel);
  const effectiveModelMetadata = options.find((candidate) => candidate.id === effectiveModel);
  const thinkingOptions = effortOptions(agent, effectiveModel, effectiveModelMetadata);
  const hasThinkingOptions = thinkingOptions.length > 1;
  const effectiveEffort = selectedEffort;
  const summary = issueRuntimeSelectorSummary(agent, overrides);

  const closeMenu = () => {
    setMenuOpen(false);
    setActiveSubmenu(null);
    setDraftInitialized(false);
  };

  const positionFor = (rect: DOMRect, width: number, height: number): CSSProperties => {
    const viewportPadding = 12;
    const right = window.innerWidth - rect.right;
    const left = right >= width + viewportPadding
      ? rect.right + 8
      : Math.max(viewportPadding, rect.left - width - 8);
    return {
      left,
      top: Math.max(
        viewportPadding,
        Math.min(rect.top, window.innerHeight - viewportPadding - height),
      ),
    };
  };

  const positionSubmenuFor = (rect: DOMRect, width: number, height: number): CSSProperties => {
    const viewportPadding = 12;
    const gap = 8;
    const right = window.innerWidth - rect.right;
    const left = right >= width + gap + viewportPadding
      ? rect.right + gap
      : Math.max(viewportPadding, rect.left - width - gap);
    const availableBelow = Math.max(0, window.innerHeight - viewportPadding - rect.top);
    const availableAbove = Math.max(0, rect.bottom - viewportPadding);
    const keepTriggerAligned = availableBelow >= 120;
    const maxHeight = Math.min(
      height,
      keepTriggerAligned ? availableBelow : Math.max(availableAbove, availableBelow),
    );
    const top = keepTriggerAligned
      ? Math.max(viewportPadding, rect.top)
      : Math.max(
        viewportPadding,
        Math.min(rect.top, window.innerHeight - viewportPadding - maxHeight),
      );
    return {
      left,
      top,
      maxHeight: `${maxHeight}px`,
    };
  };

  const openMenu = () => {
    if (disabled || !menuTriggerRef.current) return;
    setDraftModel(currentModel);
    setDraftEffort(currentEffort);
    setDraftInitialized(true);
    setMenuPosition(positionFor(menuTriggerRef.current.getBoundingClientRect(), 304, 176));
    setActiveSubmenu(null);
    setMenuOpen(true);
  };

  const openSubmenu = (kind: "model" | "effort", trigger: HTMLButtonElement | null) => {
    if (!trigger) return;
    setSubmenuPosition(positionSubmenuFor(trigger.getBoundingClientRect(), 256, 320));
    setActiveSubmenu(kind);
  };

  const closeSubmenu = (kind: "model" | "effort") => {
    setActiveSubmenu(null);
    requestAnimationFrame(() => {
      (kind === "model" ? modelTriggerRef : effortTriggerRef).current?.focus();
    });
  };

  const finishMenuSelection = () => {
    closeMenu();
    requestAnimationFrame(() => menuTriggerRef.current?.focus());
  };

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        menuRootRef.current?.contains(event.target)
        || submenuRootRef.current?.contains(event.target)
        || menuTriggerRef.current?.contains(event.target)
      ) return;
      closeMenu();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const updatePosition = () => {
      if (menuTriggerRef.current) {
        setMenuPosition(positionFor(menuTriggerRef.current.getBoundingClientRect(), 304, 176));
      }
      if (activeSubmenu) {
        const trigger = activeSubmenu === "model"
          ? modelTriggerRef.current
          : effortTriggerRef.current;
        if (trigger) {
          setSubmenuPosition(positionSubmenuFor(trigger.getBoundingClientRect(), 256, 320));
        }
      }
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [activeSubmenu, menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    requestAnimationFrame(() => modelTriggerRef.current?.focus());
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen || !activeSubmenu) return;
    requestAnimationFrame(() => {
      (activeSubmenu === "model" ? firstModelOptionRef : firstEffortOptionRef).current?.focus();
    });
  }, [activeSubmenu, menuOpen]);

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
    const nextEfforts = effortOptions(
      agent,
      nextEffectiveModel,
      options.find((candidate) => candidate.id === nextEffectiveModel),
    );
    if (draftEffort && !nextEfforts.some((option) => option.id === draftEffort)) {
      setDraftEffort(null);
    }
  };

  const selectMenuModel = (nextModel: string | null) => {
    const nextEffectiveModel = nextModel ?? configuredModel(agent);
    const nextEfforts = effortOptions(
      agent,
      nextEffectiveModel,
      options.find((candidate) => candidate.id === nextEffectiveModel),
    );
    const nextEffort = draftEffort && nextEfforts.some((option) => option.id === draftEffort)
      ? draftEffort
      : null;
    setDraftModel(nextModel);
    setDraftEffort(nextEffort);
    onApply(buildOverrides(overrides, nextModel, nextEffort, effortKey));
    finishMenuSelection();
  };

  const selectMenuEffort = (nextEffort: string | null) => {
    setDraftEffort(nextEffort);
    onApply(buildOverrides(overrides, selectedModel, nextEffort, effortKey));
    finishMenuSelection();
  };

  if (variant === "menu") {
    const menuPanel = menuOpen && menuPosition && typeof document !== "undefined" ? createPortal(
      <div
        ref={menuRootRef}
        data-issue-runtime-portal
        data-testid="issue-runtime-profile-panel"
        role="dialog"
        aria-label={`Model and thinking for ${agent.name}`}
        className="pointer-events-auto surface-overlay fixed z-[65] w-[19rem] max-w-[calc(100vw-1.5rem)] rounded-[var(--radius-lg)] border p-1.5 shadow-lg"
        style={menuPosition}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
            requestAnimationFrame(() => menuTriggerRef.current?.focus());
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            event.stopPropagation();
            if (activeSubmenu) {
              closeSubmenu(activeSubmenu);
            } else {
              closeMenu();
              requestAnimationFrame(() => menuTriggerRef.current?.focus());
            }
          }
        }}
      >
        <button
          type="button"
          className="chat-composer-menu-row mb-1"
          onClick={() => {
            closeMenu();
            requestAnimationFrame(() => menuTriggerRef.current?.focus());
          }}
        >
          <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
        </button>
        <div className="border-t border-[color:var(--border-soft)] pt-1">
          <button
            ref={modelTriggerRef}
            type="button"
            data-testid="issue-runtime-model-trigger"
            aria-haspopup="listbox"
            aria-expanded={activeSubmenu === "model"}
            className="chat-composer-menu-row grid min-h-10 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
            onClick={() => openSubmenu("model", modelTriggerRef.current)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                openSubmenu("model", modelTriggerRef.current);
              }
            }}
          >
            <span className="font-medium text-foreground">Model</span>
            <span className="min-w-0 truncate text-right text-muted-foreground">{effectiveModel}</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </button>
          {hasThinkingOptions ? (
            <button
              ref={effortTriggerRef}
              type="button"
              data-testid="issue-runtime-effort-trigger"
              aria-haspopup="listbox"
              aria-expanded={activeSubmenu === "effort"}
              className="chat-composer-menu-row grid min-h-10 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
              onClick={() => openSubmenu("effort", effortTriggerRef.current)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  openSubmenu("effort", effortTriggerRef.current);
                }
              }}
            >
              <span className="font-medium text-foreground">Thinking</span>
              <span className="min-w-0 truncate text-right text-muted-foreground">{effortLabel(effectiveEffort)}</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>,
      document.body,
    ) : null;

    const submenuOptions = activeSubmenu === "model" ? (
      <>
        <button
          ref={firstModelOptionRef}
          type="button"
          role="option"
          aria-selected={selectedModel == null}
          data-testid="issue-runtime-option-default-model"
          className="chat-composer-menu-row"
          onClick={() => selectMenuModel(null)}
        >
          <span className="min-w-0 flex-1 truncate">{`Agent default · ${configuredModel(agent)}`}</span>
          {selectedModel == null ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
        </button>
        {adapterModelsQuery.error && options.length > 0 ? (
          <div
            data-testid="issue-runtime-model-discovery-error"
            role="status"
            className="px-2.5 py-2 text-xs text-muted-foreground"
          >
            Models unavailable; showing built-in defaults.
          </div>
        ) : null}
        {adapterModelsQuery.isPending ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Loading models...
          </div>
        ) : options.length > 0 ? options.map((model) => (
          <button
            key={model.id}
            type="button"
            role="option"
            aria-selected={selectedModel === model.id}
            data-testid={`issue-runtime-option-model-${model.id}`}
            className="chat-composer-menu-row"
            onClick={() => selectMenuModel(model.id)}
          >
            <span className="min-w-0 flex-1 truncate">{model.label}</span>
            {selectedModel === model.id ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
          </button>
        )) : (
          <div className="px-2.5 py-2 text-xs text-muted-foreground">
            {adapterModelsQuery.error ? "Models unavailable" : "No models found."}
          </div>
        )}
      </>
    ) : hasThinkingOptions ? thinkingOptions.map((option) => (
      <button
        key={option.id ?? "default"}
        ref={option.id == null ? firstEffortOptionRef : undefined}
        type="button"
        role="option"
        aria-selected={effectiveEffort === option.id}
        data-testid={`issue-runtime-option-effort-${option.id ?? "default"}`}
        className="chat-composer-menu-row"
        onClick={() => selectMenuEffort(option.id)}
      >
        <span className="min-w-0 flex-1 truncate">{option.label}{option.id == null ? ` · ${effortLabel(configuredEffort(agent))}` : ""}</span>
        {effectiveEffort === option.id ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
      </button>
    )) : null;

    const submenu = menuOpen && activeSubmenu && submenuPosition && typeof document !== "undefined" ? createPortal(
      <div
        ref={(node) => {
          submenuRootRef.current = node;
          submenuScrollRef(node);
        }}
        data-issue-runtime-portal
        data-testid={`issue-runtime-${activeSubmenu}-options`}
        role="listbox"
        aria-label={activeSubmenu === "model" ? "Model options" : "Thinking options"}
        className="pointer-events-auto surface-overlay scrollbar-auto-hide scrollbar-menu-inset fixed z-[70] max-h-80 w-64 overflow-y-auto rounded-[var(--radius-lg)] border p-1.5 shadow-lg"
        style={submenuPosition}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "ArrowLeft") {
            event.preventDefault();
            event.stopPropagation();
            closeSubmenu(activeSubmenu);
          }
        }}
      >
        {submenuOptions}
      </div>,
      document.body,
    ) : null;

    return (
      <>
        <button
          ref={menuTriggerRef}
          type="button"
          data-testid="issue-runtime-selector"
          aria-label={`Configure model and thinking for ${agent.name}`}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          className={cn(
            "chat-composer-menu-row min-w-0",
            disabled && "cursor-not-allowed opacity-60",
          )}
          disabled={disabled}
          title={summary}
          onClick={() => (menuOpen ? closeMenu() : openMenu())}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openMenu();
            }
          }}
        >
          <SlidersHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">Model</span>
          <span className="min-w-0 max-w-[14rem] truncate text-right text-muted-foreground">{summary}</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
        {menuPanel}
        {submenu}
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={openSelector}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="issue-runtime-selector"
          aria-label={`Run profile for ${agent.name}`}
          className={cn(
            variant === "icon"
              ? "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-100 transition-[color,background-color,opacity] hover:bg-accent/70 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 md:pointer-events-none md:opacity-0 md:group-hover/issue-property:pointer-events-auto md:group-hover/issue-property:opacity-100 md:group-focus-within/issue-property:pointer-events-auto md:group-focus-within/issue-property:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100"
              : "inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground",
            disabled && "cursor-not-allowed opacity-60",
          )}
          disabled={disabled}
          title={summary}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {variant === "compact" ? (
            <>
              <span className="min-w-0 truncate">{summary}</span>
              <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
            </>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        className="max-h-[min(32rem,var(--radix-popover-content-available-height))] w-72 overflow-y-auto p-2"
      >
        <div className="mb-2 border-b border-border pb-2">
          <p className="text-xs font-medium text-foreground">Run profile</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Applies to runs that have not started.
          </p>
        </div>
        <div className="space-y-1" role="listbox" aria-label="Model">
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
          ) : adapterModelsQuery.error && options.length > 0 ? (
            <p
              data-testid="issue-runtime-model-discovery-error"
              role="status"
              className="px-2 py-2 text-xs text-muted-foreground"
            >
              Models unavailable; showing built-in defaults.
            </p>
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
        {hasThinkingOptions ? (
          <div className="mt-2 border-t border-border pt-2" role="listbox" aria-label="Thinking">
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
        ) : null}
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
