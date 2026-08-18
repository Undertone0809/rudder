import type { AgentRuntimeModel } from "@/api/agents";
import { agentsApi } from "@/api/agents";
import { RuntimeProfileControls } from "@/components/RuntimeProfileControls";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { ChevronDown, ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
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
  const [menuPosition, setMenuPosition] = useState<CSSProperties | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const [draftInitialized, setDraftInitialized] = useState(false);
  const menuRootRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
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
    setDraftInitialized(false);
  };

  const positionFor = (rect: DOMRect, width: number, height: number): CSSProperties => {
    const viewportPadding = 12;
    const mobileNavigation = document.querySelector<HTMLElement>("[data-mobile-bottom-navigation]");
    const viewportBottom = mobileNavigation && mobileNavigation.getClientRects().length > 0
      ? Math.min(
        window.innerHeight - viewportPadding,
        mobileNavigation.getBoundingClientRect().top - viewportPadding,
      )
      : window.innerHeight - viewportPadding;
    const right = window.innerWidth - rect.right;
    const left = right >= width + viewportPadding
      ? rect.right + 8
      : Math.max(viewportPadding, rect.left - width - 8);
    return {
      left,
      top: Math.max(
        viewportPadding,
        Math.min(rect.top, viewportBottom - height),
      ),
    };
  };

  const openMenu = () => {
    if (disabled || !menuTriggerRef.current) return;
    setDraftModel(currentModel);
    setDraftEffort(currentEffort);
    setDraftInitialized(true);
    setMenuPosition(positionFor(menuTriggerRef.current.getBoundingClientRect(), 304, 176));
    setMenuOpen(true);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        menuRootRef.current?.contains(event.target)
        || (event.target instanceof Element && event.target.closest("[data-runtime-profile-submenu]"))
        || menuTriggerRef.current?.contains(event.target)
      ) return;
      closeMenu();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "ArrowLeft") return;
      if (document.querySelector("[data-runtime-profile-submenu]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeMenu();
      requestAnimationFrame(() => menuTriggerRef.current?.focus());
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const updatePosition = () => {
      if (menuTriggerRef.current) {
        setMenuPosition(positionFor(menuTriggerRef.current.getBoundingClientRect(), 304, 176));
      }
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [menuOpen]);

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

  const finishMenuSelection = () => {
    closeMenu();
    requestAnimationFrame(() => menuTriggerRef.current?.focus());
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

  const runtimeControls = (mode: "menu" | "staged") => (
    <RuntimeProfileControls
      ariaContext={`${agent.name} runtime`}
      disabled={disabled}
      errorMessage={adapterModelsQuery.error ? "Models unavailable; showing built-in defaults." : null}
      testIds={{
        modelTrigger: "issue-runtime-model-trigger",
        modelOptions: "issue-runtime-model-options",
        modelOption: (id) => id == null
          ? "issue-runtime-option-default-model"
          : `issue-runtime-option-model-${id}`,
        effortTrigger: "issue-runtime-effort-trigger",
        effortOptions: "issue-runtime-effort-options",
        effortOption: (id) => `issue-runtime-option-effort-${id ?? "default"}`,
      }}
      model={{
        valueLabel: effectiveModel,
        selectedId: selectedModel,
        defaultOption: { id: null, label: `Agent default · ${configuredModel(agent)}` },
        options,
        loading: adapterModelsQuery.isPending,
        emptyLabel: adapterModelsQuery.error ? "Models unavailable" : "No models found.",
        onSelect: mode === "menu" ? selectMenuModel : selectModel,
      }}
      effort={hasThinkingOptions ? {
        valueLabel: effortLabel(effectiveEffort),
        selectedId: effectiveEffort,
        defaultOption: {
          id: null,
          label: `Agent default · ${effortLabel(configuredEffort(agent))}`,
        },
        options: thinkingOptions.filter((option) => option.id != null),
        onSelect: mode === "menu" ? selectMenuEffort : setDraftEffort,
      } : undefined}
    />
  );

  if (variant === "menu") {
    const menuPanel = menuOpen && menuPosition && typeof document !== "undefined" ? createPortal(
      <div
        ref={menuRootRef}
        data-issue-runtime-portal
        data-runtime-profile-panel
        data-testid="issue-runtime-profile-panel"
        role="dialog"
        aria-label={`Model and thinking for ${agent.name}`}
        className="pointer-events-auto surface-overlay fixed z-[75] w-[19rem] max-w-[calc(100vw-1.5rem)] rounded-[var(--radius-lg)] border p-1.5 shadow-lg"
        style={menuPosition}
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
            requestAnimationFrame(() => menuTriggerRef.current?.focus());
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
            requestAnimationFrame(() => menuTriggerRef.current?.focus());
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
          {runtimeControls("menu")}
        </div>
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
            "chat-composer-menu-row !w-auto min-w-0 max-w-full",
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
        data-testid="issue-runtime-profile-panel"
        data-runtime-profile-panel
        align="end"
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        className="surface-overlay w-[19rem] max-w-[calc(100vw-1.5rem)] p-1.5"
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Element && target.closest("[data-runtime-profile-submenu]")) {
            event.preventDefault();
          }
        }}
      >
        <button
          type="button"
          className="chat-composer-menu-row mb-1"
          onClick={() => setOpen(false)}
        >
          <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
        </button>
        <div className="border-t border-[color:var(--border-soft)] pt-1">
          {runtimeControls("staged")}
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
