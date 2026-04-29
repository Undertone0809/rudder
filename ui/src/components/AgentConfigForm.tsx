import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_RUNTIME_TYPES,
  AGENT_RUN_CONCURRENCY_DEFAULT,
  AGENT_RUN_CONCURRENCY_MAX,
  AGENT_RUN_CONCURRENCY_MIN,
} from "@rudderhq/shared";
import { normalizeModelFallbacks } from "@rudderhq/agent-runtime-utils";
import type { ModelFallbackConfig } from "@rudderhq/agent-runtime-utils";
import type {
  Agent,
  AgentRuntimeEnvironmentTestResult,
  OrganizationSecret,
  EnvBinding,
} from "@rudderhq/shared";
import type { AgentRuntimeModel } from "../api/agents";
import { agentsApi } from "../api/agents";
import { secretsApi } from "../api/secrets";
import { assetsApi } from "../api/assets";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_SEARCH,
} from "@rudderhq/agent-runtime-codex-local";
import { models as CLAUDE_LOCAL_MODELS } from "@rudderhq/agent-runtime-claude-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@rudderhq/agent-runtime-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@rudderhq/agent-runtime-gemini-local";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  semanticBadgeToneClasses,
} from "@/components/ui/semanticTones";
import { Heart, ChevronDown, Plus, Trash2, X } from "lucide-react";
import { cn } from "../lib/utils";
import { extractModelName, extractProviderId } from "../lib/model-utils";
import { CODEX_LOCAL_REASONING_EFFORT_OPTIONS, withDefaultThinkingEffortOption } from "../lib/runtime-thinking-effort";
import { resolveRuntimeModels } from "../lib/runtime-models";
import { queryKeys } from "../lib/queryKeys";
import { useOrganization } from "../context/OrganizationContext";
import {
  Field,
  ToggleField,
  ToggleWithNumber,
  CollapsibleSection,
  DraftInput,
  DraftNumberInput,
  help,
  adapterLabels,
} from "./agent-config-primitives";
import { defaultCreateValues } from "./agent-config-defaults";
import { getUIAdapter } from "../agent-runtimes";
import type { AgentRuntimeConfigFieldsProps } from "../agent-runtimes/types";
import { ClaudeLocalAdvancedFields } from "../agent-runtimes/claude-local/config-fields";
import { MarkdownEditor } from "./MarkdownEditor";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";
import { ReportsToPicker } from "./ReportsToPicker";

/* ---- Create mode values ---- */

// Canonical type lives in @rudderhq/agent-runtime-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";
import type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";

/* ---- Props ---- */

type AgentConfigFormProps = {
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

interface Overlay {
  identity: Record<string, unknown>;
  agentRuntimeType?: string;
  agentRuntimeConfig: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  runtime: Record<string, unknown>;
}

const emptyOverlay: Overlay = {
  identity: {},
  agentRuntimeConfig: {},
  heartbeat: {},
  runtime: {},
};

/** Stable empty object used as fallback for missing env config to avoid new-object-per-render. */
const EMPTY_ENV: Record<string, EnvBinding> = {};

function isOverlayDirty(o: Overlay): boolean {
  return (
    Object.keys(o.identity).length > 0 ||
    o.agentRuntimeType !== undefined ||
    Object.keys(o.agentRuntimeConfig).length > 0 ||
    Object.keys(o.heartbeat).length > 0 ||
    Object.keys(o.runtime).length > 0
  );
}

/* ---- Shared input class ---- */
const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatArgList(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .join(", ");
  }
  return typeof value === "string" ? value : "";
}

const codexThinkingEffortOptions = [
  ...withDefaultThinkingEffortOption("Auto", CODEX_LOCAL_REASONING_EFFORT_OPTIONS).map((option) => ({
    id: option.value,
    label: option.label,
  })),
] as const;

const openCodeThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
] as const;

const cursorModeOptions = [
  { id: "", label: "Auto" },
  { id: "plan", label: "Plan" },
  { id: "ask", label: "Ask" },
] as const;

const claudeThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
] as const;

const LOCAL_MODEL_RUNTIME_TYPES = [
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
] as const;

function defaultModelForRuntime(agentRuntimeType: string) {
  if (agentRuntimeType === "claude_local") {
    return CLAUDE_LOCAL_MODELS.find((model) => model.id.includes("sonnet"))?.id
      ?? CLAUDE_LOCAL_MODELS[0]?.id
      ?? "";
  }
  if (agentRuntimeType === "codex_local") return DEFAULT_CODEX_LOCAL_MODEL;
  if (agentRuntimeType === "gemini_local") return DEFAULT_GEMINI_LOCAL_MODEL;
  if (agentRuntimeType === "cursor") return DEFAULT_CURSOR_LOCAL_MODEL;
  if (agentRuntimeType === "opencode_local") return "anthropic/claude-sonnet-4-5";
  if (agentRuntimeType === "pi_local") return "xai/grok-4";
  return "";
}

function defaultCommandForRuntime(agentRuntimeType: string) {
  if (agentRuntimeType === "codex_local") return "codex";
  if (agentRuntimeType === "gemini_local") return "gemini";
  if (agentRuntimeType === "pi_local") return "pi";
  if (agentRuntimeType === "cursor") return "agent";
  if (agentRuntimeType === "opencode_local") return "opencode";
  return "claude";
}

function createValuesForRuntime(agentRuntimeType: string): CreateConfigValues {
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

function defaultFallbackRuntime(primaryRuntimeType: string) {
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

function thinkingEffortKeyForRuntime(agentRuntimeType: string) {
  if (agentRuntimeType === "codex_local") return "modelReasoningEffort";
  if (agentRuntimeType === "cursor") return "mode";
  if (agentRuntimeType === "opencode_local") return "variant";
  if (agentRuntimeType === "pi_local") return "thinking";
  return "effort";
}

function thinkingEffortOptionsForRuntime(agentRuntimeType: string) {
  if (agentRuntimeType === "codex_local") return codexThinkingEffortOptions;
  if (agentRuntimeType === "cursor") return cursorModeOptions;
  if (agentRuntimeType === "opencode_local" || agentRuntimeType === "pi_local") {
    return openCodeThinkingEffortOptions;
  }
  return claudeThinkingEffortOptions;
}

function shouldShowThinkingEffort(agentRuntimeType: string) {
  return agentRuntimeType !== "gemini_local";
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

type RuntimeEnvironmentTestTarget = {
  key: string;
  title: string;
  runtimeType: string;
  model: string;
  config: Record<string, unknown>;
};

type RuntimeEnvironmentTestItemResult = RuntimeEnvironmentTestTarget & {
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

export function AgentConfigForm(props: AgentConfigFormProps) {
  const { mode, adapterModels: externalModels } = props;
  const isCreate = mode === "create";
  const cards = props.sectionLayout === "cards";
  const showAdapterTypeField = props.showAdapterTypeField ?? true;
  const showAdapterTestEnvironmentButton = props.showAdapterTestEnvironmentButton ?? true;
  const showCreateRunPolicySection = props.showCreateRunPolicySection ?? true;
  const hideInstructionsFile = props.hideInstructionsFile ?? false;
  const { selectedOrganizationId } = useOrganization();
  const queryClient = useQueryClient();

  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedOrganizationId ? queryKeys.secrets.list(selectedOrganizationId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId),
  });

  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedOrganizationId) throw new Error("Select a organization to create secrets");
      return secretsApi.create(selectedOrganizationId, input);
    },
    onSuccess: () => {
      if (!selectedOrganizationId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedOrganizationId) });
    },
  });

  const uploadMarkdownImage = useMutation({
    mutationFn: async ({ file, namespace }: { file: File; namespace: string }) => {
      if (!selectedOrganizationId) throw new Error("Select a organization to upload images");
      return assetsApi.uploadImage(selectedOrganizationId, file, namespace);
    },
  });

  // ---- Edit mode: overlay for dirty tracking ----
  const [overlay, setOverlay] = useState<Overlay>(emptyOverlay);
  const agentRef = useRef<Agent | null>(null);

  // Clear overlay when agent data refreshes (after save)
  useEffect(() => {
    if (!isCreate) {
      if (agentRef.current !== null && props.agent !== agentRef.current) {
        setOverlay({ ...emptyOverlay });
      }
      agentRef.current = props.agent;
    }
  }, [isCreate, !isCreate ? props.agent : undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDirty = !isCreate && isOverlayDirty(overlay);

  /** Read effective value: overlay if dirty, else original */
  function eff<T>(group: keyof Omit<Overlay, "agentRuntimeType">, field: string, original: T): T {
    const o = overlay[group];
    if (field in o) return o[field] as T;
    return original;
  }

  /** Mark field dirty in overlay */
  function mark(group: keyof Omit<Overlay, "agentRuntimeType">, field: string, value: unknown) {
    setOverlay((prev) => ({
      ...prev,
      [group]: { ...prev[group], [field]: value },
    }));
  }

  /** Build accumulated patch and send to parent */
  const handleCancel = useCallback(() => {
    setOverlay({ ...emptyOverlay });
  }, []);

  const handleSave = useCallback(() => {
    if (isCreate || !isDirty) return;
    const agent = props.agent;
    const patch: Record<string, unknown> = {};

    if (Object.keys(overlay.identity).length > 0) {
      Object.assign(patch, overlay.identity);
    }
    if (overlay.agentRuntimeType !== undefined) {
      patch.agentRuntimeType = overlay.agentRuntimeType;
      // When adapter type changes, send only the new config — don't merge
      // with old config since old adapter fields are meaningless for the new type
      patch.agentRuntimeConfig = overlay.agentRuntimeConfig;
    } else if (Object.keys(overlay.agentRuntimeConfig).length > 0) {
      const existing = (agent.agentRuntimeConfig ?? {}) as Record<string, unknown>;
      patch.agentRuntimeConfig = { ...existing, ...overlay.agentRuntimeConfig };
    }
    if (Object.keys(overlay.heartbeat).length > 0) {
      const existingRc = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
      const existingHb = (existingRc.heartbeat ?? {}) as Record<string, unknown>;
      patch.runtimeConfig = { ...existingRc, heartbeat: { ...existingHb, ...overlay.heartbeat } };
    }
    if (Object.keys(overlay.runtime).length > 0) {
      Object.assign(patch, overlay.runtime);
    }

    props.onSave(patch);
  }, [isCreate, isDirty, overlay, props]);

  useEffect(() => {
    if (!isCreate) {
      props.onDirtyChange?.(isDirty);
      props.onSaveActionChange?.(handleSave);
      props.onCancelActionChange?.(handleCancel);
    }
  }, [isCreate, isDirty, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange, handleSave, handleCancel]);

  useEffect(() => {
    if (isCreate) return;
    return () => {
      props.onSaveActionChange?.(null);
      props.onCancelActionChange?.(null);
      props.onDirtyChange?.(false);
    };
  }, [isCreate, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange]);

  // ---- Resolve values ----
  const config = !isCreate ? ((props.agent.agentRuntimeConfig ?? {}) as Record<string, unknown>) : {};
  const runtimeConfig = !isCreate ? ((props.agent.runtimeConfig ?? {}) as Record<string, unknown>) : {};
  const heartbeat = !isCreate ? ((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>) : {};

  const agentRuntimeType = isCreate
    ? props.values.agentRuntimeType
    : overlay.agentRuntimeType ?? props.agent.agentRuntimeType;
  const isLocal = LOCAL_MODEL_RUNTIME_TYPES.includes(agentRuntimeType as (typeof LOCAL_MODEL_RUNTIME_TYPES)[number]);
  const uiAdapter = useMemo(() => getUIAdapter(agentRuntimeType), [agentRuntimeType]);

  // Fetch adapter models for the effective adapter type
  const {
    data: fetchedModels,
    error: fetchedModelsError,
  } = useQuery({
    queryKey: selectedOrganizationId
      ? queryKeys.agents.adapterModels(selectedOrganizationId, agentRuntimeType)
      : ["agents", "none", "adapter-models", agentRuntimeType],
    queryFn: () => agentsApi.adapterModels(selectedOrganizationId!, agentRuntimeType),
    enabled: Boolean(selectedOrganizationId),
  });
  const models = useMemo(
    () => resolveRuntimeModels(agentRuntimeType, fetchedModels, externalModels),
    [agentRuntimeType, fetchedModels, externalModels],
  );

  const { data: companyAgents = [] } = useQuery({
    queryKey: selectedOrganizationId ? queryKeys.agents.list(selectedOrganizationId) : ["agents", "none", "list"],
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: Boolean(!isCreate && selectedOrganizationId),
  });

  /** Props passed to adapter-specific config field components */
  const adapterFieldProps = {
    mode,
    isCreate,
    agentRuntimeType,
    values: isCreate ? props.values : null,
    set: isCreate ? (patch: Partial<CreateConfigValues>) => props.onChange(patch) : null,
    config,
    eff: eff as <T>(group: "agentRuntimeConfig", field: string, original: T) => T,
    mark: mark as (group: "agentRuntimeConfig", field: string, value: unknown) => void,
    models,
    hideInstructionsFile,
  };

  // Section toggle state — advanced always starts collapsed
  const [configurationAdvancedOpen, setConfigurationAdvancedOpen] = useState(false);
  const [runPolicyAdvancedOpen, setRunPolicyAdvancedOpen] = useState(false);
  // Popover state for top-level selectors that still live outside provider cards.

  // Create mode helpers
  const val = isCreate ? props.values : null;
  const set = isCreate
    ? (patch: Partial<CreateConfigValues>) => props.onChange(patch)
    : null;

  function buildAdapterConfigForTest(): Record<string, unknown> {
    if (isCreate) {
      return uiAdapter.buildAdapterConfig(val!);
    }
    const base = config as Record<string, unknown>;
    return { ...base, ...overlay.agentRuntimeConfig };
  }

  // Current model for display
  const currentModelId = isCreate
    ? val!.model
    : eff("agentRuntimeConfig", "model", String(config.model ?? ""));
  const currentFallbackModels = normalizeModelFallbacksForEditor(
    isCreate
      ? val!.modelFallbacks
      : eff("agentRuntimeConfig", "modelFallbacks", config.modelFallbacks ?? []),
    primaryModelFallbackKey(agentRuntimeType, currentModelId),
  );

  function buildRuntimeEnvironmentTestTargets(): RuntimeEnvironmentTestTarget[] {
    const primaryConfig = { ...buildAdapterConfigForTest() };
    delete primaryConfig.modelFallbacks;
    return [
      {
        key: "primary",
        title: "Primary",
        runtimeType: agentRuntimeType,
        model: currentModelId,
        config: {
          ...primaryConfig,
          ...(currentModelId ? { model: currentModelId } : {}),
        },
      },
      ...currentFallbackModels.map((fallback, index) => ({
        key: `fallback-${index}`,
        title: `Fallback ${index + 1}`,
        runtimeType: fallback.agentRuntimeType,
        model: fallback.model,
        config: {
          ...(fallback.config ?? {}),
          ...(fallback.model ? { model: fallback.model } : {}),
        },
      })),
    ];
  }

  const testRuntimeChain = useMutation({
    mutationFn: async (): Promise<RuntimeEnvironmentTestItemResult[]> => {
      if (!selectedOrganizationId) {
        throw new Error("Select a organization to test runtime environment");
      }
      const targets = buildRuntimeEnvironmentTestTargets();
      const results: RuntimeEnvironmentTestItemResult[] = [];
      for (const target of targets) {
        try {
          const result = await agentsApi.testEnvironment(selectedOrganizationId, target.runtimeType, {
            agentRuntimeConfig: target.config,
          });
          results.push({ ...target, result });
        } catch (error) {
          results.push({
            ...target,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
      return results;
    },
  });

  const runtimeEnvironmentResultsByKey = useMemo(() => {
    return new Map((testRuntimeChain.data ?? []).map((item) => [item.key, item]));
  }, [testRuntimeChain.data]);

  function runtimeEnvironmentStatusFor(key: string): RuntimeEnvironmentStatus | undefined {
    if (testRuntimeChain.isPending) return "testing";
    const item = runtimeEnvironmentResultsByKey.get(key);
    if (!item) return undefined;
    if (item.error) return "error";
    return item.result?.status;
  }

  function updateFallbackModels(next: ModelFallbackConfig[]) {
    const normalized = normalizeModelFallbacksForEditor(
      next,
      primaryModelFallbackKey(agentRuntimeType, currentModelId),
    );
    if (isCreate) {
      set!({ modelFallbacks: normalized });
    } else {
      mark("agentRuntimeConfig", "modelFallbacks", normalized);
    }
  }
  const codexSearchEnabled = agentRuntimeType === "codex_local"
    ? (isCreate ? Boolean(val!.search) : eff("agentRuntimeConfig", "search", Boolean(config.search)))
    : false;
  const effectiveRuntimeConfig = useMemo(() => {
    if (isCreate) {
      return {
        heartbeat: {
          enabled: val!.heartbeatEnabled,
          intervalSec: val!.intervalSec,
          maxConcurrentRuns: val!.maxConcurrentRuns,
        },
      };
    }
    const mergedHeartbeat = {
      ...(runtimeConfig.heartbeat && typeof runtimeConfig.heartbeat === "object"
        ? runtimeConfig.heartbeat as Record<string, unknown>
        : {}),
      ...overlay.heartbeat,
    };
    return {
      ...runtimeConfig,
      heartbeat: mergedHeartbeat,
    };
  }, [isCreate, overlay.heartbeat, runtimeConfig, val]);
  return (
    <div className={cn("relative", cards && "space-y-6")}>
      {/* ---- Floating Save button (edit mode, when dirty) ---- */}
      {isDirty && !props.hideInlineSave && (
        <div className="sticky top-0 z-10 flex items-center justify-end px-4 py-2 bg-background/90 backdrop-blur-sm border-b border-primary/20">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!isCreate && props.isSaving}
            >
              {!isCreate && props.isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* ---- Identity (edit only) ---- */}
      {!isCreate && (
        <div className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Identity</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Identity</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field label="Name" hint={help.name}>
              <DraftInput
                value={eff("identity", "name", props.agent.name)}
                onCommit={(v) => mark("identity", "name", v)}
                immediate
                className={inputClass}
                placeholder="Agent name"
              />
            </Field>
            <Field label="Title" hint={help.title}>
              <DraftInput
                value={eff("identity", "title", props.agent.title ?? "")}
                onCommit={(v) => mark("identity", "title", v || null)}
                immediate
                className={inputClass}
                placeholder="e.g. VP of Engineering"
              />
            </Field>
            <Field label="Reports to" hint={help.reportsTo}>
              <ReportsToPicker
                agents={companyAgents}
                value={eff("identity", "reportsTo", props.agent.reportsTo ?? null)}
                onChange={(id) => mark("identity", "reportsTo", id)}
                excludeAgentIds={[props.agent.id]}
                chooseLabel="Choose manager…"
              />
            </Field>
            <Field label="Capabilities" hint={help.capabilities}>
              <MarkdownEditor
                value={eff("identity", "capabilities", props.agent.capabilities ?? "")}
                onChange={(v) => mark("identity", "capabilities", v || null)}
                placeholder="Describe what this agent can do..."
                contentClassName="min-h-[44px] text-sm font-mono"
                imageUploadHandler={async (file) => {
                  const asset = await uploadMarkdownImage.mutateAsync({
                    file,
                    namespace: `agents/${props.agent.id}/capabilities`,
                  });
                  return asset.contentPath;
                }}
              />
            </Field>
            {isLocal && !props.hidePromptTemplate && (
              <>
                <Field label="Prompt Template" hint={help.promptTemplate}>
                  <MarkdownEditor
                    value={eff(
                      "agentRuntimeConfig",
                      "promptTemplate",
                      String(config.promptTemplate ?? ""),
                    )}
                    onChange={(v) => mark("agentRuntimeConfig", "promptTemplate", v ?? "")}
                    placeholder="You are agent {{ agent.name }}. Your role is {{ agent.role }}..."
                    contentClassName="min-h-[88px] text-sm font-mono"
                    imageUploadHandler={async (file) => {
                      const namespace = `agents/${props.agent.id}/prompt-template`;
                      const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                      return asset.contentPath;
                    }}
                  />
                </Field>
                <div
                  data-testid="prompt-template-helper"
                  className="rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                >
                  Prompt template is replayed on every heartbeat. Keep it compact and dynamic to avoid recurring token cost and cache churn.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- Agent runtime ---- */}
      <div className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
        <div className={cn(cards ? "flex items-center justify-between mb-3" : "px-4 py-2 flex items-center justify-between gap-2")}>
          {cards
            ? <h3 className="text-sm font-medium">Agent Runtime</h3>
            : <span className="text-xs font-medium text-muted-foreground">Agent Runtime</span>
          }
          {showAdapterTestEnvironmentButton && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => testRuntimeChain.mutate()}
              disabled={testRuntimeChain.isPending || !selectedOrganizationId}
            >
              {testRuntimeChain.isPending ? "Testing runtime chain..." : "Test runtime chain"}
            </Button>
          )}
        </div>
        <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
          {testRuntimeChain.error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {testRuntimeChain.error instanceof Error
                ? testRuntimeChain.error.message
                : "Runtime chain environment test failed"}
            </div>
          )}

          {testRuntimeChain.data && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Runtime chain environment</div>
              {testRuntimeChain.data.map((item) =>
                item.result ? (
                  <AdapterEnvironmentResult
                    key={item.key}
                    result={item.result}
                    label={formatRuntimeEnvironmentLabel(item)}
                  />
                ) : (
                  <AdapterEnvironmentError
                    key={item.key}
                    label={formatRuntimeEnvironmentLabel(item)}
                    message={item.error?.message ?? "Environment test failed"}
                  />
                ),
              )}
            </div>
          )}

          <div className={runtimeProviderRailClassName}>
            <RuntimeProviderCard
              title="Primary"
              className={runtimeProviderItemClassName}
              runtimeType={agentRuntimeType}
              model={currentModelId}
              config={isCreate ? uiAdapter.buildAdapterConfig(val!) : { ...config, ...overlay.agentRuntimeConfig }}
              selectedOrganizationId={selectedOrganizationId}
              externalModels={externalModels}
              availableSecrets={availableSecrets}
              onCreateSecret={(name, value) => createSecret.mutateAsync({ name, value })}
              hideRuntimeType={!showAdapterTypeField}
              hideInstructionsFile={hideInstructionsFile}
              createValues={isCreate ? val! : null}
              createSet={isCreate ? set : null}
              onRuntimeTypeChange={(nextRuntimeType) => {
                if (isCreate) {
                  set!(createValuesForRuntime(nextRuntimeType));
                  return;
                }
                setOverlay((prev) => ({
                  ...prev,
                  agentRuntimeType: nextRuntimeType,
                  agentRuntimeConfig: {
                    ...defaultConfigForRuntime(nextRuntimeType),
                    modelFallbacks: [],
                  },
                }));
              }}
              onModelChange={(model) => {
                const normalizedFallbacks = normalizeModelFallbacksForEditor(
                  currentFallbackModels,
                  primaryModelFallbackKey(agentRuntimeType, model),
                );
                if (isCreate) {
                  set!({ model, modelFallbacks: normalizedFallbacks });
                } else {
                  mark("agentRuntimeConfig", "model", model || undefined);
                  mark("agentRuntimeConfig", "modelFallbacks", normalizedFallbacks);
                }
              }}
              onConfigFieldChange={(field, value) =>
                isCreate
                  ? set!({ [field]: value } as Partial<CreateConfigValues>)
                  : mark("agentRuntimeConfig", field, value)
              }
              environmentStatus={runtimeEnvironmentStatusFor("primary")}
              triggerTestId="agent-primary-model"
            />

            {currentFallbackModels.map((fallback, index) => (
              <RuntimeProviderCard
                key={`${fallback.agentRuntimeType}-${index}`}
                title={`Fallback ${index + 1}`}
                className={runtimeProviderItemClassName}
                runtimeType={fallback.agentRuntimeType}
                model={fallback.model}
                config={{ ...(fallback.config ?? {}), model: fallback.model }}
                selectedOrganizationId={selectedOrganizationId}
                externalModels={undefined}
                availableSecrets={availableSecrets}
                onCreateSecret={(name, value) => createSecret.mutateAsync({ name, value })}
                hideInstructionsFile={hideInstructionsFile}
                onRemove={() =>
                  updateFallbackModels(currentFallbackModels.filter((_, itemIndex) => itemIndex !== index))
                }
                onRuntimeTypeChange={(nextRuntimeType) => {
                  const nextConfig = defaultConfigForRuntime(nextRuntimeType);
                  const next = [...currentFallbackModels];
                  next[index] = {
                    agentRuntimeType: nextRuntimeType,
                    model: typeof nextConfig.model === "string" ? nextConfig.model : defaultModelForRuntime(nextRuntimeType),
                    config: nextConfig,
                  };
                  updateFallbackModels(next);
                }}
                onModelChange={(model) => {
                  const next = [...currentFallbackModels];
                  next[index] = {
                    ...fallback,
                    model,
                    config: {
                      ...(fallback.config ?? {}),
                      model,
                    },
                  };
                  updateFallbackModels(next);
                }}
                onConfigFieldChange={(field, value) => {
                  const next = [...currentFallbackModels];
                  next[index] = {
                    ...fallback,
                    config: {
                      ...(fallback.config ?? {}),
                      [field]: value,
                    },
                  };
                  updateFallbackModels(next);
                }}
                environmentStatus={runtimeEnvironmentStatusFor(`fallback-${index}`)}
                triggerTestId={`agent-fallback-model-${index + 1}`}
              />
            ))}

            <button
              type="button"
              className={cn(
                runtimeProviderItemClassName,
                "min-h-[180px] rounded-lg border border-dashed border-border/80 px-4 py-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/30",
              )}
              onClick={() => updateFallbackModels([...currentFallbackModels, defaultFallbackItem(agentRuntimeType)])}
            >
              <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <span className="rounded-full border border-border p-2">
                  <Plus className="h-4 w-4" />
                </span>
                <span>Add fallback</span>
              </div>
            </button>
          </div>

          {fetchedModelsError && (
            <p className="text-xs text-destructive">
              {fetchedModelsError instanceof Error
                ? fetchedModelsError.message
                : "Failed to load runtime models."}
            </p>
          )}

          {/* Prompt template (create mode only — edit mode shows this in Identity) */}
          {isLocal && isCreate && (
            <>
              <Field label="Prompt Template" hint={help.promptTemplate}>
                <MarkdownEditor
                  value={val!.promptTemplate}
                  onChange={(v) => set!({ promptTemplate: v })}
                  placeholder="You are agent {{ agent.name }}. Your role is {{ agent.role }}..."
                  contentClassName="min-h-[88px] text-sm font-mono"
                  imageUploadHandler={async (file) => {
                    const namespace = "agents/drafts/prompt-template";
                    const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                    return asset.contentPath;
                  }}
                />
              </Field>
              <div
                data-testid="prompt-template-helper"
                className="rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
              >
                Prompt template is replayed on every heartbeat. Prefer small task framing and variables like <code>{"{{ context.* }}"}</code> or <code>{"{{ run.* }}"}</code>; avoid repeating stable instructions here.
              </div>
            </>
          )}
        </div>

      </div>

      {/* ---- Run Policy ---- */}
      {isCreate && showCreateRunPolicySection ? (
        <div className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium flex items-center gap-2 mb-3"><Heart className="h-3 w-3" /> Run Policy</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground flex items-center gap-2"><Heart className="h-3 w-3" /> Run Policy</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <ToggleWithNumber
              label="Heartbeat on interval"
              hint={help.heartbeatInterval}
              checked={val!.heartbeatEnabled}
              onCheckedChange={(v) => set!({ heartbeatEnabled: v })}
              number={val!.intervalSec}
              onNumberChange={(v) => set!({ intervalSec: v })}
              numberLabel="sec"
              numberPrefix="Run heartbeat every"
              numberHint={help.intervalSec}
              showNumber={val!.heartbeatEnabled}
            />
            <Field label="Agent run concurrency" hint={help.maxConcurrentRuns}>
              <DraftNumberInput
                value={val!.maxConcurrentRuns}
                onCommit={(v) => set!({ maxConcurrentRuns: v })}
                immediate
                min={AGENT_RUN_CONCURRENCY_MIN}
                max={AGENT_RUN_CONCURRENCY_MAX}
                step={1}
                aria-label="Agent run concurrency"
                className={inputClass}
              />
            </Field>
          </div>
        </div>
      ) : !isCreate ? (
        <div className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium flex items-center gap-2 mb-3"><Heart className="h-3 w-3" /> Run Policy</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground flex items-center gap-2"><Heart className="h-3 w-3" /> Run Policy</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg overflow-hidden" : "")}>
            <div className={cn(cards ? "p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
              <ToggleWithNumber
                label="Heartbeat on interval"
                hint={help.heartbeatInterval}
                checked={eff("heartbeat", "enabled", heartbeat.enabled !== false)}
                onCheckedChange={(v) => mark("heartbeat", "enabled", v)}
                number={eff("heartbeat", "intervalSec", Number(heartbeat.intervalSec ?? 300))}
                onNumberChange={(v) => mark("heartbeat", "intervalSec", v)}
                numberLabel="sec"
                numberPrefix="Run heartbeat every"
                numberHint={help.intervalSec}
                showNumber={eff("heartbeat", "enabled", heartbeat.enabled !== false)}
              />
              <Field label="Agent run concurrency" hint={help.maxConcurrentRuns}>
                <DraftNumberInput
                  value={eff(
                    "heartbeat",
                    "maxConcurrentRuns",
                    Number(heartbeat.maxConcurrentRuns ?? AGENT_RUN_CONCURRENCY_DEFAULT),
                  )}
                  onCommit={(v) => mark("heartbeat", "maxConcurrentRuns", v)}
                  immediate
                  min={AGENT_RUN_CONCURRENCY_MIN}
                  max={AGENT_RUN_CONCURRENCY_MAX}
                  step={1}
                  aria-label="Agent run concurrency"
                  className={inputClass}
                />
              </Field>
            </div>
            <CollapsibleSection
              title="Advanced Run Policy"
              bordered={cards}
              open={runPolicyAdvancedOpen}
              onToggle={() => setRunPolicyAdvancedOpen(!runPolicyAdvancedOpen)}
            >
            <div className="space-y-3">
              <ToggleField
                label="Wake on demand"
                hint={help.wakeOnDemand}
                checked={eff(
                  "heartbeat",
                  "wakeOnDemand",
                  heartbeat.wakeOnDemand !== false,
                )}
                onChange={(v) => mark("heartbeat", "wakeOnDemand", v)}
              />
              <Field label="Cooldown (sec)" hint={help.cooldownSec}>
                <DraftNumberInput
                  value={eff(
                    "heartbeat",
                    "cooldownSec",
                    Number(heartbeat.cooldownSec ?? 10),
                  )}
                  onCommit={(v) => mark("heartbeat", "cooldownSec", v)}
                  immediate
                  className={inputClass}
                />
              </Field>
            </div>
          </CollapsibleSection>
          </div>
        </div>
      ) : null}

    </div>
  );
}

export function AdapterEnvironmentResult({
  result,
  label,
}: {
  result: AgentRuntimeEnvironmentTestResult;
  label?: string;
}) {
  const displayStatus = normalizeRuntimeEnvironmentDisplayStatus(result.status) ?? "pass";
  const visibleChecks = filterRuntimeEnvironmentDisplayChecks(result);
  const statusLabel =
    displayStatus === "pass" ? "Passed" : "Failed";
  const statusClass =
    displayStatus === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label ? `${label}: ${statusLabel}` : statusLabel}</span>
        <span className="text-[11px] opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      {visibleChecks.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {visibleChecks.map((check, idx) => (
            <div key={`${check.code}-${idx}`} className="text-[11px] leading-relaxed break-words">
              <span className="font-medium uppercase tracking-wide opacity-80">
                {check.level}
              </span>
              <span className="mx-1 opacity-60">·</span>
              <span>{check.message}</span>
              {check.detail && <span className="block opacity-75 break-all">({check.detail})</span>}
              {check.hint && <span className="block opacity-90 break-words">Hint: {check.hint}</span>}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AdapterEnvironmentError({
  label,
  message,
}: {
  label: string;
  message: string;
}) {
  return (
    <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
      <div className="font-medium">{label}: Failed</div>
      <div className="mt-1 text-[11px] leading-relaxed break-words opacity-90">{message}</div>
    </div>
  );
}

function RuntimeEnvironmentStatusBadge({
  status,
}: {
  status?: RuntimeEnvironmentStatus;
}) {
  const displayStatus = normalizeRuntimeEnvironmentDisplayStatus(status);
  if (!displayStatus) return null;
  const label =
    displayStatus === "pass"
      ? "Env passed"
      : displayStatus === "testing"
        ? "Testing env"
        : "Env failed";
  const className =
    displayStatus === "pass"
      ? "border-green-300 bg-green-50 text-green-700 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-300"
      : displayStatus === "testing"
        ? "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300"
        : "border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300";
  return (
    <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", className)}>
      {label}
    </span>
  );
}

export function RuntimeProviderCard({
  title,
  className,
  runtimeType,
  model,
  config,
  selectedOrganizationId,
  externalModels,
  availableSecrets,
  onCreateSecret,
  onRuntimeTypeChange,
  onModelChange,
  onConfigFieldChange,
  onRemove,
  hideRuntimeType = false,
  hideInstructionsFile = false,
  createValues,
  createSet,
  environmentStatus,
  triggerTestId,
}: {
  title: string;
  className?: string;
  runtimeType: string;
  model: string;
  config: Record<string, unknown>;
  selectedOrganizationId: string | null | undefined;
  externalModels?: AgentRuntimeModel[];
  availableSecrets: OrganizationSecret[];
  onCreateSecret: (name: string, value: string) => Promise<OrganizationSecret>;
  onRuntimeTypeChange: (runtimeType: string) => void;
  onModelChange: (model: string) => void;
  onConfigFieldChange: (field: string, value: unknown) => void;
  onRemove?: () => void;
  hideRuntimeType?: boolean;
  hideInstructionsFile?: boolean;
  createValues?: CreateConfigValues | null;
  createSet?: ((patch: Partial<CreateConfigValues>) => void) | null;
  environmentStatus?: RuntimeEnvironmentStatus;
  triggerTestId?: string;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingEffortOpen, setThinkingEffortOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const adapter = useMemo(() => getUIAdapter(runtimeType), [runtimeType]);
  const { data: fetchedModels } = useQuery({
    queryKey: selectedOrganizationId
      ? queryKeys.agents.adapterModels(selectedOrganizationId, runtimeType)
      : ["agents", "none", "adapter-models", runtimeType],
    queryFn: () => agentsApi.adapterModels(selectedOrganizationId!, runtimeType),
    enabled: Boolean(selectedOrganizationId),
  });
  const models = useMemo(
    () => resolveRuntimeModels(runtimeType, fetchedModels, externalModels),
    [runtimeType, fetchedModels, externalModels],
  );
  const thinkingEffortKey = thinkingEffortKeyForRuntime(runtimeType);
  const currentThinkingEffort = createValues
    ? createValues.thinkingEffort
    : String(config[thinkingEffortKey] ?? config.reasoningEffort ?? "");
  const adapterFieldProps: AgentRuntimeConfigFieldsProps = {
    mode: createValues ? "create" : "edit",
    isCreate: Boolean(createValues),
    agentRuntimeType: runtimeType,
    values: createValues ?? null,
    set: createSet ?? null,
    config,
    eff: <T,>(_group: "agentRuntimeConfig", field: string, original: T): T =>
      Object.prototype.hasOwnProperty.call(config, field) ? config[field] as T : original,
    mark: (_group: "agentRuntimeConfig", field: string, value: unknown) => onConfigFieldChange(field, value),
    models,
    hideInstructionsFile,
  };

  return (
    <div className={cn("rounded-lg border border-border/80 bg-background/30 p-3", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium">{title}</div>
          <RuntimeEnvironmentStatusBadge status={environmentStatus} />
        </div>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            aria-label={`Remove ${title}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="space-y-3">
        {!hideRuntimeType && (
          <Field label="Runtime type" hint={help.agentRuntimeType}>
            <AdapterTypeDropdown value={runtimeType} onChange={onRuntimeTypeChange} />
          </Field>
        )}
        <ModelDropdown
          label="Model"
          hint={help.model}
          models={models}
          value={model}
          onChange={onModelChange}
          open={modelOpen}
          onOpenChange={setModelOpen}
          allowDefault={runtimeType !== "opencode_local" && !onRemove}
          required={runtimeType === "opencode_local" || Boolean(onRemove)}
          groupByProvider={runtimeType === "opencode_local"}
          emptyLabel={runtimeType === "opencode_local" || onRemove ? "Select model" : "Default"}
          allowCustom
          triggerTestId={triggerTestId}
        />
        {shouldShowThinkingEffort(runtimeType) && (
          <>
            <ThinkingEffortDropdown
              value={currentThinkingEffort}
              options={thinkingEffortOptionsForRuntime(runtimeType)}
              onChange={(value) => {
                if (createSet) {
                  createSet({ thinkingEffort: value });
                } else {
                  onConfigFieldChange(thinkingEffortKey, value || undefined);
                }
              }}
              open={thinkingEffortOpen}
              onOpenChange={setThinkingEffortOpen}
            />
          </>
        )}
        <CollapsibleSection
          title="Advanced options"
          bordered
          open={advancedOpen}
          onToggle={() => setAdvancedOpen(!advancedOpen)}
        >
          <RuntimeAdvancedOptions
            runtimeType={runtimeType}
            adapter={adapter}
            fieldProps={adapterFieldProps}
            availableSecrets={availableSecrets}
            onCreateSecret={onCreateSecret}
          />
        </CollapsibleSection>
      </div>
    </div>
  );
}

function RuntimeAdvancedOptions({
  runtimeType,
  adapter,
  fieldProps,
  availableSecrets,
  onCreateSecret,
}: {
  runtimeType: string;
  adapter: ReturnType<typeof getUIAdapter>;
  fieldProps: AgentRuntimeConfigFieldsProps;
  availableSecrets: OrganizationSecret[];
  onCreateSecret: (name: string, value: string) => Promise<OrganizationSecret>;
}) {
  const { isCreate, values, set, config, eff, mark } = fieldProps;
  const ConfigFields = adapter.ConfigFields;
  return (
    <div className="space-y-3">
      <ConfigFields {...fieldProps} />
      {runtimeType === "claude_local" && (
        <ClaudeLocalAdvancedFields {...fieldProps} />
      )}
      <Field label="Command" hint={help.localCommand}>
        <DraftInput
          value={
            isCreate
              ? values!.command
              : eff("agentRuntimeConfig", "command", String(config.command ?? ""))
          }
          onCommit={(value) =>
            isCreate
              ? set!({ command: value })
              : mark("agentRuntimeConfig", "command", value || undefined)
          }
          immediate
          className={inputClass}
          placeholder={defaultCommandForRuntime(runtimeType)}
        />
      </Field>
      <Field label="Extra args (comma-separated)" hint={help.extraArgs}>
        <DraftInput
          value={
            isCreate
              ? values!.extraArgs
              : eff("agentRuntimeConfig", "extraArgs", formatArgList(config.extraArgs))
          }
          onCommit={(value) =>
            isCreate
              ? set!({ extraArgs: value })
              : mark("agentRuntimeConfig", "extraArgs", value ? parseCommaArgs(value) : undefined)
          }
          immediate
          className={inputClass}
          placeholder="e.g. --verbose, --foo=bar"
        />
      </Field>
      <Field label="Environment variables" hint={help.envVars}>
        <EnvVarEditor
          value={
            isCreate
              ? ((values!.envBindings ?? EMPTY_ENV) as Record<string, EnvBinding>)
              : eff("agentRuntimeConfig", "env", (config.env ?? EMPTY_ENV) as Record<string, EnvBinding>)
          }
          secrets={availableSecrets}
          onCreateSecret={onCreateSecret}
          onChange={(env) =>
            isCreate
              ? set!({ envBindings: env ?? {}, envVars: "" })
              : mark("agentRuntimeConfig", "env", env)
          }
        />
      </Field>
      {!isCreate && (
        <>
          <Field label="Timeout (sec)" hint={help.timeoutSec}>
            <DraftNumberInput
              value={eff("agentRuntimeConfig", "timeoutSec", Number(config.timeoutSec ?? 0))}
              onCommit={(value) => mark("agentRuntimeConfig", "timeoutSec", value)}
              immediate
              className={inputClass}
            />
          </Field>
          <Field label="Interrupt grace period (sec)" hint={help.graceSec}>
            <DraftNumberInput
              value={eff("agentRuntimeConfig", "graceSec", Number(config.graceSec ?? 15))}
              onCommit={(value) => mark("agentRuntimeConfig", "graceSec", value)}
              immediate
              className={inputClass}
            />
          </Field>
        </>
      )}
    </div>
  );
}

/* ---- Internal sub-components ---- */

const ENABLED_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "gemini_local", "opencode_local", "pi_local", "cursor"]);

/** Display list includes all real adapter types plus UI-only coming-soon entries. */
const ADAPTER_DISPLAY_LIST: { value: string; label: string; comingSoon: boolean }[] = [
  ...AGENT_RUNTIME_TYPES.map((t) => ({
    value: t,
    label: adapterLabels[t] ?? t,
    comingSoon: !ENABLED_ADAPTER_TYPES.has(t),
  })),
];

function AdapterTypeDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (type: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
          <span className="inline-flex items-center gap-1.5">
            {value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5" /> : null}
            <span>{adapterLabels[value] ?? value}</span>
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
        {ADAPTER_DISPLAY_LIST.map((item) => (
          <button
            key={item.value}
            disabled={item.comingSoon}
            className={cn(
              "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded",
              item.comingSoon
                ? "opacity-40 cursor-not-allowed"
                : "hover:bg-accent/50",
              item.value === value && !item.comingSoon && "bg-accent",
            )}
            onClick={() => {
              if (!item.comingSoon) onChange(item.value);
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              {item.value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5" /> : null}
              <span>{item.label}</span>
            </span>
            {item.comingSoon && (
              <span className="text-[10px] text-muted-foreground">Coming soon</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function EnvVarEditor({
  value,
  secrets,
  onCreateSecret,
  onChange,
}: {
  value: Record<string, EnvBinding>;
  secrets: OrganizationSecret[];
  onCreateSecret: (name: string, value: string) => Promise<OrganizationSecret>;
  onChange: (env: Record<string, EnvBinding> | undefined) => void;
}) {
  type Row = {
    key: string;
    source: "plain" | "secret";
    plainValue: string;
    secretId: string;
  };

  function toRows(rec: Record<string, EnvBinding> | null | undefined): Row[] {
    if (!rec || typeof rec !== "object") {
      return [{ key: "", source: "plain", plainValue: "", secretId: "" }];
    }
    const entries = Object.entries(rec).map(([k, binding]) => {
      if (typeof binding === "string") {
        return {
          key: k,
          source: "plain" as const,
          plainValue: binding,
          secretId: "",
        };
      }
      if (
        typeof binding === "object" &&
        binding !== null &&
        "type" in binding &&
        (binding as { type?: unknown }).type === "secret_ref"
      ) {
        const recBinding = binding as { secretId?: unknown };
        return {
          key: k,
          source: "secret" as const,
          plainValue: "",
          secretId: typeof recBinding.secretId === "string" ? recBinding.secretId : "",
        };
      }
      if (
        typeof binding === "object" &&
        binding !== null &&
        "type" in binding &&
        (binding as { type?: unknown }).type === "plain"
      ) {
        const recBinding = binding as { value?: unknown };
        return {
          key: k,
          source: "plain" as const,
          plainValue: typeof recBinding.value === "string" ? recBinding.value : "",
          secretId: "",
        };
      }
      return {
        key: k,
        source: "plain" as const,
        plainValue: "",
        secretId: "",
      };
    });
    return [...entries, { key: "", source: "plain", plainValue: "", secretId: "" }];
  }

  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [sealError, setSealError] = useState<string | null>(null);
  const valueRef = useRef(value);

  // Sync when value identity changes (overlay reset after save)
  useEffect(() => {
    if (value !== valueRef.current) {
      valueRef.current = value;
      setRows(toRows(value));
    }
  }, [value]);

  function emit(nextRows: Row[]) {
    const rec: Record<string, EnvBinding> = {};
    for (const row of nextRows) {
      const k = row.key.trim();
      if (!k) continue;
      if (row.source === "secret") {
        if (!row.secretId) continue;
        rec[k] = { type: "secret_ref", secretId: row.secretId, version: "latest" };
      } else {
        rec[k] = { type: "plain", value: row.plainValue };
      }
    }
    onChange(Object.keys(rec).length > 0 ? rec : undefined);
  }

  function updateRow(i: number, patch: Partial<Row>) {
    const withPatch = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    if (
      withPatch[withPatch.length - 1].key ||
      withPatch[withPatch.length - 1].plainValue ||
      withPatch[withPatch.length - 1].secretId
    ) {
      withPatch.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(withPatch);
    emit(withPatch);
  }

  function removeRow(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    if (
      next.length === 0 ||
      next[next.length - 1].key ||
      next[next.length - 1].plainValue ||
      next[next.length - 1].secretId
    ) {
      next.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(next);
    emit(next);
  }

  function defaultSecretName(key: string): string {
    return key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
  }

  async function sealRow(i: number) {
    const row = rows[i];
    if (!row) return;
    const key = row.key.trim();
    const plain = row.plainValue;
    if (!key || plain.length === 0) return;

    const suggested = defaultSecretName(key) || "secret";
    const name = window.prompt("Secret name", suggested)?.trim();
    if (!name) return;

    try {
      setSealError(null);
      const created = await onCreateSecret(name, plain);
      updateRow(i, {
        source: "secret",
        secretId: created.id,
      });
    } catch (err) {
      setSealError(err instanceof Error ? err.message : "Failed to create secret");
    }
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => {
        const isTrailing =
          i === rows.length - 1 &&
          !row.key &&
          !row.plainValue &&
          !row.secretId;
        return (
          <div key={i} className="flex items-center gap-1.5">
            <input
              className={cn(inputClass, "flex-[2]")}
              placeholder="KEY"
              value={row.key}
              onChange={(e) => updateRow(i, { key: e.target.value })}
            />
            <select
              className={cn(inputClass, "flex-[1] bg-background")}
              value={row.source}
              onChange={(e) =>
                updateRow(i, {
                  source: e.target.value === "secret" ? "secret" : "plain",
                  ...(e.target.value === "plain" ? { secretId: "" } : {}),
                })
              }
            >
              <option value="plain">Plain</option>
              <option value="secret">Secret</option>
            </select>
            {row.source === "secret" ? (
              <>
                <select
                  className={cn(inputClass, "flex-[3] bg-background")}
                  value={row.secretId}
                  onChange={(e) => updateRow(i, { secretId: e.target.value })}
                >
                  <option value="">Select secret...</option>
                  {secrets.map((secret) => (
                    <option key={secret.id} value={secret.id}>
                      {secret.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(i)}
                  disabled={!row.key.trim() || !row.plainValue}
                  title="Create secret from current plain value"
                >
                  New
                </button>
              </>
            ) : (
              <>
                <input
                  className={cn(inputClass, "flex-[3]")}
                  placeholder="value"
                  value={row.plainValue}
                  onChange={(e) => updateRow(i, { plainValue: e.target.value })}
                />
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(i)}
                  disabled={!row.key.trim() || !row.plainValue}
                  title="Store value as secret and replace with reference"
                >
                  Seal
                </button>
              </>
            )}
            {!isTrailing ? (
              <button
                type="button"
                className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                onClick={() => removeRow(i)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="w-[26px] shrink-0" />
            )}
          </div>
        );
      })}
      {sealError && <p className="text-[11px] text-destructive">{sealError}</p>}
      <p className="text-[11px] text-muted-foreground/60">
        RUDDER_* variables are injected automatically at runtime.
      </p>
    </div>
  );
}

function ModelDropdown({
  label,
  hint,
  models,
  value,
  onChange,
  open,
  onOpenChange,
  allowDefault,
  allowClear = false,
  allowCustom = false,
  required,
  groupByProvider,
  emptyLabel,
  triggerTestId,
}: {
  label: string;
  hint?: string;
  models: AgentRuntimeModel[];
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allowDefault: boolean;
  allowClear?: boolean;
  allowCustom?: boolean;
  required: boolean;
  groupByProvider: boolean;
  emptyLabel: string;
  triggerTestId?: string;
}) {
  const [modelSearch, setModelSearch] = useState("");
  const selected = models.find((m) => m.id === value);
  const customModel = modelSearch.trim();
  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      if (!modelSearch.trim()) return true;
      const q = modelSearch.toLowerCase();
      const provider = extractProviderId(m.id) ?? "";
      return (
        m.id.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q) ||
        provider.toLowerCase().includes(q)
      );
    });
  }, [models, modelSearch]);
  const canUseCustomModel = allowCustom
    && customModel.length > 0
    && !models.some((m) => m.id === customModel);
  const groupedModels = useMemo(() => {
    if (!groupByProvider) {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id)),
        },
      ];
    }
    const map = new Map<string, AgentRuntimeModel[]>();
    for (const model of filteredModels) {
      const provider = extractProviderId(model.id) ?? "other";
      const group = map.get(provider) ?? [];
      group.push(model);
      map.set(provider, group);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)),
      }));
  }, [filteredModels, groupByProvider]);

  return (
    <Field label={label} hint={hint}>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
          if (!nextOpen) setModelSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between min-w-0"
            data-testid={triggerTestId}
          >
            <span className={cn("truncate text-left", !value && "text-muted-foreground")}>
              {selected
                ? selected.label
                : value || emptyLabel || (required ? "Select model (required)" : "Select model")}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
          <input
            className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
            placeholder="Search models..."
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            autoFocus
          />
          <div className="max-h-[240px] overflow-y-auto">
            {allowDefault && (
              <button
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  !value && "bg-accent",
                )}
                onClick={() => {
                  onChange("");
                  onOpenChange(false);
                }}
              >
                Default
              </button>
            )}
            {allowClear && (
              <button
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  !value && "bg-accent",
                )}
                onClick={() => {
                  onChange("");
                  onOpenChange(false);
                }}
              >
                No fallback model
              </button>
            )}
            {canUseCustomModel && (
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50"
                onClick={() => {
                  onChange(customModel);
                  onOpenChange(false);
                }}
              >
                <span className="block w-full text-left truncate" title={customModel}>
                  Use "{customModel}"
                </span>
              </button>
            )}
            {groupedModels.map((group) => (
              <div key={group.provider} className="mb-1 last:mb-0">
                {groupByProvider && (
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {group.provider} ({group.entries.length})
                  </div>
                )}
                {group.entries.map((m) => (
                  <button
                    key={m.id}
                    className={cn(
                      "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                      m.id === value && "bg-accent",
                    )}
                    onClick={() => {
                      onChange(m.id);
                      onOpenChange(false);
                    }}
                  >
                    <span className="block w-full text-left truncate" title={m.id}>
                      {groupByProvider ? extractModelName(m.id) : m.label}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {filteredModels.length === 0 && !canUseCustomModel && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No models found.</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function ThinkingEffortDropdown({
  value,
  options,
  onChange,
  open,
  onOpenChange,
}: {
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const selected = options.find((option) => option.id === value) ?? options[0];

  return (
    <Field label="Thinking effort" hint={help.thinkingEffort}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
            <span className={cn(!value && "text-muted-foreground")}>{selected?.label ?? "Auto"}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
          {options.map((option) => (
            <button
              key={option.id || "auto"}
              className={cn(
                "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                option.id === value && "bg-accent",
              )}
              onClick={() => {
                onChange(option.id);
                onOpenChange(false);
              }}
            >
              <span>{option.label}</span>
              {option.id ? <span className="text-xs text-muted-foreground font-mono">{option.id}</span> : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </Field>
  );
}
