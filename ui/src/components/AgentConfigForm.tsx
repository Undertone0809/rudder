import { Button } from "@/components/ui/button";
import type { CreateConfigValues, ModelFallbackConfig } from "@rudderhq/agent-runtime-utils";
import type {
  Agent
} from "@rudderhq/shared";
import {
  AGENT_RUN_CONCURRENCY_DEFAULT,
  AGENT_RUN_CONCURRENCY_MAX,
  AGENT_RUN_CONCURRENCY_MIN
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Heart, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getUIAdapter } from "../agent-runtimes";
import { agentsApi } from "../api/agents";
import { assetsApi } from "../api/assets";
import { secretsApi } from "../api/secrets";
import { useOrganization } from "../context/OrganizationContext";
import { queryKeys } from "../lib/queryKeys";
import { resolveRuntimeModels } from "../lib/runtime-models";
import { cn } from "../lib/utils";
import {
  CollapsibleSection,
  DraftInput,
  DraftNumberInput,
  Field,
  ToggleField,
  ToggleWithNumber,
  help
} from "./agent-config-primitives";
import { AdapterEnvironmentError, AdapterEnvironmentResult, RuntimeProviderCard } from "./AgentConfigForm.environment";
import { AgentConfigFormProps, LOCAL_MODEL_RUNTIME_TYPES, Overlay, RuntimeEnvironmentStatus, RuntimeEnvironmentTestItemResult, RuntimeEnvironmentTestTarget, createValuesForRuntime, defaultConfigForRuntime, defaultFallbackItem, defaultModelForRuntime, emptyOverlay, formatRuntimeEnvironmentLabel, hasClearedConfigValue, inputClass, isOverlayDirty, normalizeModelFallbacksForEditor, omitClearedConfigValues, primaryModelFallbackKey, runtimeProviderItemClassName, runtimeProviderRailClassName } from "./AgentConfigForm.helpers";
import { MarkdownEditor } from "./MarkdownEditor";
import { ReportsToPicker } from "./ReportsToPicker";

/* ---- Create mode values ---- */

// Canonical type lives in @rudderhq/agent-runtime-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";

export {
  filterRuntimeEnvironmentDisplayChecks,
  normalizeModelFallbacksForEditor,
  normalizeRuntimeEnvironmentDisplayStatus
} from "./AgentConfigForm.helpers";

/* ---- Props ---- */

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

  function markAgentRuntimeConfigPatch(patch: Record<string, unknown>) {
    setOverlay((prev) => ({
      ...prev,
      agentRuntimeConfig: { ...prev.agentRuntimeConfig, ...patch },
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
      patch.agentRuntimeConfig = omitClearedConfigValues(overlay.agentRuntimeConfig);
    } else if (Object.keys(overlay.agentRuntimeConfig).length > 0) {
      const existing = (agent.agentRuntimeConfig ?? {}) as Record<string, unknown>;
      const nextAgentRuntimeConfig = { ...existing, ...overlay.agentRuntimeConfig };
      patch.agentRuntimeConfig = omitClearedConfigValues(nextAgentRuntimeConfig);
      if (hasClearedConfigValue(overlay.agentRuntimeConfig)) {
        patch.replaceAgentRuntimeConfig = true;
      }
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
          preflightEnabled: val!.preflightEnabled,
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
                    placeholder="Use this only for compact per-run task framing..."
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
                  Prompt template is replayed on every heartbeat for existing runtime configs. Keep it compact and dynamic to avoid recurring token cost and cache churn.
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
              onConfigPatchChange={(patch) => {
                if (isCreate) {
                  set!(patch as Partial<CreateConfigValues>);
                } else {
                  markAgentRuntimeConfigPatch(patch);
                }
              }}
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
                onConfigPatchChange={(configPatch) => {
                  const next = [...currentFallbackModels];
                  next[index] = {
                    ...fallback,
                    config: {
                      ...(fallback.config ?? {}),
                      ...configPatch,
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
                <span>Add fallback model</span>
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
                  placeholder={"# SOUL.md\n\nYou are agent {{ agent.name }}. Your role is {{ agent.role }}..."}
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
                For new local agents, Rudder materializes this as SOUL.md in the managed instructions bundle. Define role, scope, responsibilities, boundaries, and voice; leave Rudder's shared operating contract out.
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
              description={help.heartbeatInterval}
              checked={val!.heartbeatEnabled}
              onCheckedChange={(v) => set!({ heartbeatEnabled: v })}
              number={val!.intervalSec}
              onNumberChange={(v) => set!({ intervalSec: v })}
              numberLabel="sec"
              numberPrefix="Run heartbeat every"
              showNumber={val!.heartbeatEnabled}
            />
            <Field label="Agent run concurrency" description={help.maxConcurrentRuns}>
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
            <ToggleField
              label="Preflight before timer run"
              description={help.heartbeatPreflight}
              checked={val!.preflightEnabled}
              onChange={(v) => set!({ preflightEnabled: v })}
            />
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
                description={help.heartbeatInterval}
                checked={eff("heartbeat", "enabled", heartbeat.enabled !== false)}
                onCheckedChange={(v) => mark("heartbeat", "enabled", v)}
                number={eff("heartbeat", "intervalSec", Number(heartbeat.intervalSec ?? 300))}
                onNumberChange={(v) => mark("heartbeat", "intervalSec", v)}
                numberLabel="sec"
                numberPrefix="Run heartbeat every"
                showNumber={eff("heartbeat", "enabled", heartbeat.enabled !== false)}
              />
              <Field label="Agent run concurrency" description={help.maxConcurrentRuns}>
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
              <ToggleField
                label="Preflight before timer run"
                description={help.heartbeatPreflight}
                checked={eff(
                  "heartbeat",
                  "preflightEnabled",
                  heartbeat.preflightEnabled !== false && heartbeat.timerPreflightEnabled !== false,
                )}
                onChange={(v) => mark("heartbeat", "preflightEnabled", v)}
              />
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
                description={help.wakeOnDemand}
                checked={eff(
                  "heartbeat",
                  "wakeOnDemand",
                  heartbeat.wakeOnDemand !== false,
                )}
                onChange={(v) => mark("heartbeat", "wakeOnDemand", v)}
              />
              <Field label="Cooldown (sec)" description={help.cooldownSec}>
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
