import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  OrganizationIntelligenceProfile,
  OrganizationIntelligenceProfilePurpose,
  OrganizationSecret,
} from "@rudderhq/shared";
import type { ModelFallbackConfig } from "@rudderhq/agent-runtime-utils";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RuntimeProviderCard } from "@/components/AgentConfigForm.environment";
import {
  defaultConfigForRuntime,
  defaultFallbackItem,
  defaultModelForRuntime,
  normalizeModelFallbacksForEditor,
  primaryModelFallbackKey,
  runtimeProviderItemClassName,
  runtimeProviderRailClassName,
} from "@/components/AgentConfigForm.helpers";
import { organizationsApi } from "@/api/orgs";
import { secretsApi } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

type ProfileDraft = {
  purpose: OrganizationIntelligenceProfilePurpose;
  exists: boolean;
  agentRuntimeType: string;
  agentRuntimeConfig: Record<string, unknown>;
  status: "configured" | "disabled" | "invalid";
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
    status: "configured",
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
  const saveProfile = useMutation({
    mutationFn: (draft: ProfileDraft) =>
      organizationsApi.updateIntelligenceProfile(orgId, draft.purpose, {
        agentRuntimeType: draft.agentRuntimeType as OrganizationIntelligenceProfile["agentRuntimeType"],
        agentRuntimeConfig: draft.agentRuntimeConfig,
        status: draft.status,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.intelligenceProfiles(orgId) });
    },
  });

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
    setDrafts((current) => {
      const base = current ?? serverDrafts;
      return {
        ...base,
        [purpose]: updater(base[purpose]),
      };
    });
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
                <div className="flex items-center gap-2">
                  <span className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                    draft.exists && draft.status === "configured"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-muted-foreground/30 bg-muted text-muted-foreground",
                  )}>
                    {!draft.exists ? "Not configured" : draft.status === "configured" ? "Ready" : draft.status}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    disabled={!dirty || saveProfile.isPending}
                    onClick={() => saveProfile.mutate(draft)}
                  >
                    {saveProfile.isPending ? "Saving..." : !draft.exists ? "Create" : dirty ? "Save" : "Saved"}
                  </Button>
                </div>
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
                    }));
                  }}
                  onConfigFieldChange={(field, value) => {
                    setDraft(purpose, (current) => ({
                      ...current,
                      agentRuntimeConfig: {
                        ...current.agentRuntimeConfig,
                        [field]: value,
                      },
                    }));
                  }}
                  onConfigPatchChange={(patch) => {
                    setDraft(purpose, (current) => ({
                      ...current,
                      agentRuntimeConfig: {
                        ...current.agentRuntimeConfig,
                        ...patch,
                      },
                    }));
                  }}
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
                    onRemove={() => setDraft(purpose, (current) =>
                      updateFallbackModels(current, fallbacks.filter((_, itemIndex) => itemIndex !== index)),
                    )}
                    onRuntimeTypeChange={(nextRuntimeType) => {
                      const nextConfig = defaultConfigForRuntime(nextRuntimeType);
                      const next = [...fallbacks];
                      next[index] = {
                        agentRuntimeType: nextRuntimeType,
                        model: typeof nextConfig.model === "string" ? nextConfig.model : defaultModelForRuntime(nextRuntimeType),
                        config: nextConfig,
                      };
                      setDraft(purpose, (current) => updateFallbackModels(current, next));
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
                      setDraft(purpose, (current) => updateFallbackModels(current, next));
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
                      setDraft(purpose, (current) => updateFallbackModels(current, next));
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
                      setDraft(purpose, (current) => updateFallbackModels(current, next));
                    }}
                  />
                ))}

                <button
                  type="button"
                  className={cn(
                    runtimeProviderItemClassName,
                    "min-h-[180px] rounded-lg border border-dashed border-border/80 px-4 py-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/30",
                  )}
                  onClick={() => setDraft(purpose, (current) =>
                    updateFallbackModels(current, [...fallbackModels(current), defaultFallbackItem(current.agentRuntimeType)]),
                  )}
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
      {saveProfile.isError ? (
        <div className="text-xs text-destructive">
          {saveProfile.error instanceof Error ? saveProfile.error.message : "Failed to save intelligence profile."}
        </div>
      ) : null}
    </div>
  );
}
