import { agentsApi } from "@/api/agents";
import { organizationsApi } from "@/api/orgs";
import { secretsApi } from "@/api/secrets";
import { AdapterEnvironmentError, AdapterEnvironmentResult, RuntimeProviderCard } from "@/components/AgentConfigForm.environment";
import {
  type RuntimeEnvironmentStatus,
  type RuntimeEnvironmentTestItemResult,
  type RuntimeEnvironmentTestTarget,
  defaultConfigForRuntime,
  defaultFallbackItem,
  defaultModelForRuntime,
  formatRuntimeEnvironmentLabel,
  normalizeModelFallbacksForEditor,
  primaryModelFallbackKey,
  runtimeProviderItemClassName,
  runtimeProviderRailClassName,
} from "@/components/AgentConfigForm.helpers";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { blockingRuntimeEnvironmentMessage } from "@/lib/runtime-models";
import { cn } from "@/lib/utils";
import type { ModelFallbackConfig } from "@rudderhq/agent-runtime-utils";
import type {
  OrganizationIntelligenceProfile,
  OrganizationIntelligenceProfilePurpose,
  OrganizationSecret,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, LoaderCircle, Plus } from "lucide-react";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";

type ProfileDraft = {
  purpose: OrganizationIntelligenceProfilePurpose;
  exists: boolean;
  agentRuntimeType: string;
  agentRuntimeConfig: Record<string, unknown>;
  status: "configured" | "disabled" | "invalid";
};

type ActivationState = {
  phase: "testing" | "enabling";
};

const profileCopy: Record<OrganizationIntelligenceProfilePurpose, {
  label: string;
  description: string;
  defaultModel: string;
  defaultReasoning: string;
}> = {
  lightweight: {
    label: "Fast",
    description: "Titles, short summaries, classification",
    defaultModel: "gpt-5.4-mini",
    defaultReasoning: "low",
  },
  reasoning: {
    label: "Smart",
    description: "Issue AI search, reranking, complex summaries",
    defaultModel: "gpt-5.4",
    defaultReasoning: "medium",
  },
};

const purposes: OrganizationIntelligenceProfilePurpose[] = ["lightweight", "reasoning"];
const providerHint = "Provider used by this organization intelligence profile.";

function defaultDraft(purpose: OrganizationIntelligenceProfilePurpose): ProfileDraft {
  const config = {
    ...defaultConfigForRuntime("codex_local"),
    model: profileCopy[purpose].defaultModel,
    modelReasoningEffort: profileCopy[purpose].defaultReasoning,
  };
  return {
    purpose,
    exists: false,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: config,
    status: "disabled",
  };
}

function draftFromProfile(profile: OrganizationIntelligenceProfile | null, purpose: OrganizationIntelligenceProfilePurpose) {
  if (!profile) return defaultDraft(purpose);
  return {
    purpose,
    exists: true,
    agentRuntimeType: profile.agentRuntimeType,
    agentRuntimeConfig: profile.agentRuntimeConfig ?? {},
    status: profile.status,
  };
}

function profileModel(draft: ProfileDraft) {
  return typeof draft.agentRuntimeConfig.model === "string"
    ? draft.agentRuntimeConfig.model
    : defaultModelForRuntime(draft.agentRuntimeType);
}

function fallbackModels(draft: ProfileDraft) {
  return normalizeModelFallbacksForEditor(
    draft.agentRuntimeConfig.modelFallbacks ?? [],
    primaryModelFallbackKey(draft.agentRuntimeType, profileModel(draft)),
  );
}

function updateFallbackModels(draft: ProfileDraft, nextFallbacks: ModelFallbackConfig[]): ProfileDraft {
  const normalized = normalizeModelFallbacksForEditor(
    nextFallbacks,
    primaryModelFallbackKey(draft.agentRuntimeType, profileModel(draft)),
  );
  return {
    ...draft,
    agentRuntimeConfig: {
      ...draft.agentRuntimeConfig,
      modelFallbacks: normalized,
    },
  };
}

function buildRuntimeEnvironmentTestTargets(
  draft: ProfileDraft,
  model: string,
  fallbacks: ModelFallbackConfig[],
): RuntimeEnvironmentTestTarget[] {
  const primaryConfig: Record<string, unknown> = { ...draft.agentRuntimeConfig, model };
  delete primaryConfig.modelFallbacks;
  return [
    {
      key: "primary",
      title: "Primary",
      runtimeType: draft.agentRuntimeType,
      model,
      config: primaryConfig,
    },
    ...fallbacks.map((fallback, index) => ({
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

function sameRuntimeTarget(left: RuntimeEnvironmentTestTarget, right: RuntimeEnvironmentTestTarget) {
  return left.key === right.key
    && left.runtimeType === right.runtimeType
    && left.model === right.model
    && JSON.stringify(left.config) === JSON.stringify(right.config);
}

function runtimeChainPassed(
  targets: RuntimeEnvironmentTestTarget[],
  results: RuntimeEnvironmentTestItemResult[],
) {
  if (targets.length === 0 || targets.length !== results.length) return false;
  return targets.every((target, index) => {
    const item = results[index];
    if (!item || !sameRuntimeTarget(target, item)) return false;
    if (item.error || !item.result) return false;
    return blockingRuntimeEnvironmentMessage(item.result) === null;
  });
}

function profileStatusLabel(draft: ProfileDraft) {
  if (!draft.exists) return "Not configured";
  if (draft.status === "configured") return "Enabled";
  if (draft.status === "disabled") return "Disabled";
  return "Invalid";
}

function sameDraft(left: ProfileDraft | null | undefined, right: ProfileDraft | null | undefined) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function OrganizationIntelligenceProfilesSettings({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const profilesQuery = useQuery({
    queryKey: queryKeys.organizations.intelligenceProfiles(orgId),
    queryFn: () => organizationsApi.listIntelligenceProfiles(orgId),
  });
  const { data: availableSecrets = [] } = useQuery({
    queryKey: queryKeys.secrets.list(orgId),
    queryFn: () => secretsApi.list(orgId),
  });
  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => secretsApi.create(orgId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(orgId) }),
  });
  async function runRuntimeChainTest(
    purpose: OrganizationIntelligenceProfilePurpose,
    targets: RuntimeEnvironmentTestTarget[],
  ) {
    const results: RuntimeEnvironmentTestItemResult[] = [];
    for (const target of targets) {
      try {
        const result = await agentsApi.testEnvironment(orgId, target.runtimeType, {
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
    return { purpose, results };
  }
  const [runtimeEnvironmentResults, setRuntimeEnvironmentResults] = useState<
    Partial<Record<OrganizationIntelligenceProfilePurpose, RuntimeEnvironmentTestItemResult[]>>
  >({});
  const [testingPurposes, setTestingPurposes] = useState<Set<OrganizationIntelligenceProfilePurpose>>(() => new Set());
  const [savingPurposes, setSavingPurposes] = useState<Set<OrganizationIntelligenceProfilePurpose>>(() => new Set());
  const [activationStates, setActivationStates] = useState<Partial<Record<OrganizationIntelligenceProfilePurpose, ActivationState>>>({});
  const [saveError, setSaveError] = useState<Error | null>(null);

  const serverDrafts = useMemo(() => {
    const byPurpose = new Map(
      (profilesQuery.data ?? []).filter(Boolean).map((profile) => [profile!.purpose, profile!]),
    );
    return Object.fromEntries(
      purposes.map((purpose) => [purpose, draftFromProfile(byPurpose.get(purpose) ?? null, purpose)]),
    ) as Record<OrganizationIntelligenceProfilePurpose, ProfileDraft>;
  }, [profilesQuery.data]);

  const [drafts, setDrafts] = useState<Record<OrganizationIntelligenceProfilePurpose, ProfileDraft> | null>(null);
  useEffect(() => {
    if (!profilesQuery.data) return;
    setDrafts(serverDrafts);
  }, [profilesQuery.data, serverDrafts]);

  const currentDrafts = drafts ?? serverDrafts;

  function setDraft(purpose: OrganizationIntelligenceProfilePurpose, updater: (draft: ProfileDraft) => ProfileDraft) {
    setRuntimeEnvironmentResults((current) => {
      if (!(purpose in current)) return current;
      const next = { ...current };
      delete next[purpose];
      return next;
    });
    setDrafts((current) => {
      const base = current ?? serverDrafts;
      return {
        ...base,
        [purpose]: updater(base[purpose]),
      };
    });
  }

  function setPurposePending(
    setter: Dispatch<SetStateAction<Set<OrganizationIntelligenceProfilePurpose>>>,
    purpose: OrganizationIntelligenceProfilePurpose,
    pending: boolean,
  ) {
    setter((current) => {
      const next = new Set(current);
      if (pending) {
        next.add(purpose);
      } else {
        next.delete(purpose);
      }
      return next;
    });
  }

  function setActivationForPurpose(
    purpose: OrganizationIntelligenceProfilePurpose,
    state: ActivationState | null,
  ) {
    setActivationStates((current) => {
      const next = { ...current };
      if (state) {
        next[purpose] = state;
      } else {
        delete next[purpose];
      }
      return next;
    });
  }

  async function saveProfileDraft(draft: ProfileDraft) {
    setPurposePending(setSavingPurposes, draft.purpose, true);
    setSaveError(null);
    try {
      await organizationsApi.updateIntelligenceProfile(orgId, draft.purpose, {
        agentRuntimeType: draft.agentRuntimeType as OrganizationIntelligenceProfile["agentRuntimeType"],
        agentRuntimeConfig: draft.agentRuntimeConfig,
        status: draft.status,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.intelligenceProfiles(orgId) });
    } catch (error) {
      setSaveError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setPurposePending(setSavingPurposes, draft.purpose, false);
    }
  }

  async function testRuntimeChainForPurpose(
    purpose: OrganizationIntelligenceProfilePurpose,
    targets: RuntimeEnvironmentTestTarget[],
  ) {
    setPurposePending(setTestingPurposes, purpose, true);
    try {
      const tested = await runRuntimeChainTest(purpose, targets);
      setRuntimeEnvironmentResults((current) => ({
        ...current,
        [purpose]: tested.results,
      }));
      return tested.results;
    } finally {
      setPurposePending(setTestingPurposes, purpose, false);
    }
  }

  async function enableProfile(
    draft: ProfileDraft,
    targets: RuntimeEnvironmentTestTarget[],
    existingResults: RuntimeEnvironmentTestItemResult[],
  ) {
    setActivationForPurpose(draft.purpose, {
      phase: runtimeChainPassed(targets, existingResults) ? "enabling" : "testing",
    });
    try {
      let results = existingResults;
      if (!runtimeChainPassed(targets, results)) {
        const tested = await runRuntimeChainTest(draft.purpose, targets);
        results = tested.results;
        setRuntimeEnvironmentResults((current) => ({
          ...current,
          [draft.purpose]: tested.results,
        }));
      }

      setActivationForPurpose(draft.purpose, {
        phase: "enabling",
      });
      await saveProfileDraft({
        ...draft,
        status: runtimeChainPassed(targets, results) ? "configured" : "invalid",
      });
    } finally {
      setActivationForPurpose(draft.purpose, null);
    }
  }

  if (profilesQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground">
        Loading intelligence profiles...
      </div>
    );
  }

  return (
    <div data-testid="organization-intelligence-profiles" className="space-y-5">
      <div className="space-y-5">
        {purposes.map((purpose) => {
          const draft = currentDrafts[purpose];
          const copy = profileCopy[purpose];
          const model = profileModel(draft);
          const fallbacks = fallbackModels(draft);
          const dirty = !draft.exists || !sameDraft(draft, serverDrafts[purpose]);
          const primaryConfig = { ...draft.agentRuntimeConfig, model };
          const testTargets = buildRuntimeEnvironmentTestTargets(draft, model, fallbacks);
          const testResults = runtimeEnvironmentResults[purpose] ?? [];
          const testResultsByKey = new Map(testResults.map((item) => [item.key, item]));
          const activationState = activationStates[purpose];
          const isTestingRuntimeChain = testingPurposes.has(purpose);
          const isSavingProfile = savingPurposes.has(purpose);
          const isActivatingProfile = activationState !== undefined;
          const isActivationTesting = activationState?.phase === "testing";
          const isProfileBusy = isSavingProfile || isTestingRuntimeChain || isActivatingProfile;
          const isEnabled = draft.exists && draft.status === "configured";
          const primaryActionPendingLabel = isActivationTesting
            ? "Testing..."
            : isActivatingProfile
              ? "Enabling..."
              : isSavingProfile && isEnabled
                ? "Saving..."
                : null;
          const runtimeEnvironmentStatusFor = (key: string): RuntimeEnvironmentStatus | undefined => {
            if (isTestingRuntimeChain || isActivationTesting) return "testing";
            const item = testResultsByKey.get(key);
            if (!item) return undefined;
            if (item.error) return "error";
            return item.result?.status;
          };
          return (
            <div
              key={purpose}
              data-testid={`intelligence-profile-${purpose}`}
              className="space-y-3 rounded-lg border border-border/70 bg-background/35 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{copy.label}</div>
                  <div className="text-xs text-muted-foreground">{copy.description}</div>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                    draft.exists && draft.status === "configured"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-muted-foreground/30 bg-muted text-muted-foreground",
                  )}>
                    {profileStatusLabel(draft)}
                  </span>
                  {!dirty ? (
                    <span className="text-xs text-muted-foreground">Saved</span>
                  ) : null}
                  {dirty ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      disabled={isProfileBusy}
                      onClick={() => void saveProfileDraft(draft)}
                    >
                      {isSavingProfile ? "Saving..." : !draft.exists ? "Create" : "Save"}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant={isEnabled ? "outline" : "default"}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    disabled={isSavingProfile || isTestingRuntimeChain || isActivatingProfile}
                    onClick={() => {
                      if (isEnabled) {
                        void saveProfileDraft({ ...draft, status: "disabled" });
                        return;
                      }
                      void enableProfile(draft, testTargets, testResults);
                    }}
                  >
                    {primaryActionPendingLabel ?? (isEnabled ? "Disable" : "Enable")}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-medium text-muted-foreground">Runtime chain environment</div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-6 px-2 text-xs"
                    aria-label="Test runtime chain"
                    title="Test runtime chain"
                    disabled={isProfileBusy}
                    onClick={() => void testRuntimeChainForPurpose(purpose, testTargets)}
                  >
                    {isTestingRuntimeChain ? <LoaderCircle className="size-3 animate-spin" /> : <FlaskConical className="size-3" />}
                    {isTestingRuntimeChain ? "Testing" : "Test"}
                  </Button>
                </div>
                {testResults.length > 0 ? (
                  testResults.map((item) =>
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
                  )
                ) : (
                  <div className="rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    Test before enabling to verify the selected runtime and fallbacks.
                  </div>
                )}
              </div>

              <div className={runtimeProviderRailClassName}>
                <RuntimeProviderCard
                  title="Primary"
                  className={runtimeProviderItemClassName}
                  runtimeType={draft.agentRuntimeType}
                  model={model}
                  config={primaryConfig}
                  selectedOrganizationId={orgId}
                  availableSecrets={availableSecrets as OrganizationSecret[]}
                  onCreateSecret={(name, value) => createSecret.mutateAsync({ name, value })}
                  hideInstructionsFile
                  runtimeTypeLabel="Provider"
                  runtimeTypeHint={providerHint}
                  onRuntimeTypeChange={(nextRuntimeType) => {
                    setDraft(purpose, () => ({
                      ...draft,
                      agentRuntimeType: nextRuntimeType,
                      agentRuntimeConfig: {
                        ...defaultConfigForRuntime(nextRuntimeType),
                        modelFallbacks: [],
                      },
                      status: "disabled",
                    }));
                  }}
                  onModelChange={(nextModel) => {
                    const nextFallbacks = normalizeModelFallbacksForEditor(
                      fallbacks,
                      primaryModelFallbackKey(draft.agentRuntimeType, nextModel),
                    );
                    setDraft(purpose, (current) => ({
                      ...current,
                      agentRuntimeConfig: {
                        ...current.agentRuntimeConfig,
                        model: nextModel,
                        modelFallbacks: nextFallbacks,
                      },
                      status: "disabled",
                    }));
                  }}
                  onConfigFieldChange={(field, value) => {
                    setDraft(purpose, (current) => ({
                      ...current,
                      agentRuntimeConfig: {
                        ...current.agentRuntimeConfig,
                        [field]: value,
                      },
                      status: "disabled",
                    }));
                  }}
                  onConfigPatchChange={(patch) => {
                    setDraft(purpose, (current) => ({
                      ...current,
                      agentRuntimeConfig: {
                        ...current.agentRuntimeConfig,
                        ...patch,
                      },
                      status: "disabled",
                    }));
                  }}
                  environmentStatus={runtimeEnvironmentStatusFor("primary")}
                  disabled={isProfileBusy}
                />

                {fallbacks.map((fallback, index) => (
                  <RuntimeProviderCard
                    key={`${fallback.agentRuntimeType}-${index}`}
                    title={`Fallback ${index + 1}`}
                    className={runtimeProviderItemClassName}
                    runtimeType={fallback.agentRuntimeType}
                    model={fallback.model}
                    config={{ ...(fallback.config ?? {}), model: fallback.model }}
                    selectedOrganizationId={orgId}
                    availableSecrets={availableSecrets as OrganizationSecret[]}
                    onCreateSecret={(name, value) => createSecret.mutateAsync({ name, value })}
                    hideInstructionsFile
                    runtimeTypeLabel="Provider"
                    runtimeTypeHint={providerHint}
                    onRemove={() => setDraft(purpose, (current) => ({
                      ...updateFallbackModels(current, fallbacks.filter((_, itemIndex) => itemIndex !== index)),
                      status: "disabled",
                    }))}
                    onRuntimeTypeChange={(nextRuntimeType) => {
                      const nextConfig = defaultConfigForRuntime(nextRuntimeType);
                      const next = [...fallbacks];
                      next[index] = {
                        agentRuntimeType: nextRuntimeType,
                        model: typeof nextConfig.model === "string" ? nextConfig.model : defaultModelForRuntime(nextRuntimeType),
                        config: nextConfig,
                      };
                      setDraft(purpose, (current) => ({
                        ...updateFallbackModels(current, next),
                        status: "disabled",
                      }));
                    }}
                    onModelChange={(nextModel) => {
                      const next = [...fallbacks];
                      next[index] = {
                        ...fallback,
                        model: nextModel,
                        config: {
                          ...(fallback.config ?? {}),
                          model: nextModel,
                        },
                      };
                      setDraft(purpose, (current) => ({
                        ...updateFallbackModels(current, next),
                        status: "disabled",
                      }));
                    }}
                    onConfigFieldChange={(field, value) => {
                      const next = [...fallbacks];
                      next[index] = {
                        ...fallback,
                        config: {
                          ...(fallback.config ?? {}),
                          [field]: value,
                        },
                      };
                      setDraft(purpose, (current) => ({
                        ...updateFallbackModels(current, next),
                        status: "disabled",
                      }));
                    }}
                    onConfigPatchChange={(patch) => {
                      const next = [...fallbacks];
                      next[index] = {
                        ...fallback,
                        config: {
                          ...(fallback.config ?? {}),
                          ...patch,
                        },
                      };
                      setDraft(purpose, (current) => ({
                        ...updateFallbackModels(current, next),
                        status: "disabled",
                      }));
                    }}
                    environmentStatus={runtimeEnvironmentStatusFor(`fallback-${index}`)}
                    disabled={isProfileBusy}
                  />
                ))}

                <button
                  type="button"
                  className={cn(
                    runtimeProviderItemClassName,
                    "min-h-[180px] rounded-lg border border-dashed border-border/80 px-4 py-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/30",
                    isProfileBusy && "cursor-not-allowed opacity-50 hover:border-border/80 hover:bg-transparent",
                  )}
                  disabled={isProfileBusy}
                  onClick={() => setDraft(purpose, (current) => ({
                    ...updateFallbackModels(current, [...fallbackModels(current), defaultFallbackItem(current.agentRuntimeType)]),
                    status: "disabled",
                  }))}
                >
                  <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                    <span className="rounded-full border border-border p-2">
                      <Plus className="h-4 w-4" />
                    </span>
                    <span>Add fallback model</span>
                  </div>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {profilesQuery.isError ? (
        <div className="text-xs text-destructive">
          {profilesQuery.error instanceof Error ? profilesQuery.error.message : "Failed to load intelligence profiles."}
        </div>
      ) : null}
      {saveError ? (
        <div className="text-xs text-destructive">
          {saveError.message || "Failed to save intelligence profile."}
        </div>
      ) : null}
    </div>
  );
}
