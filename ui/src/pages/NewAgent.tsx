import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  buildOrganizationSkillPickerItems,
  filterOrganizationSkillPickerItems,
  filterSelectableNewAgentOrganizationSkillItems,
} from "@/lib/organization-skill-picker";
import {
  formatOrganizationSkillSourceLabel,
  formatOrganizationSkillSourceTooltip,
} from "@/lib/organization-skill-source-label";
import { useNavigate, useSearchParams } from "@/lib/router";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_SEARCH,
} from "@rudderhq/agent-runtime-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@rudderhq/agent-runtime-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@rudderhq/agent-runtime-gemini-local";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getUIAdapter } from "../agent-runtimes";
import { agentsApi } from "../api/agents";
import { organizationSkillsApi } from "../api/organizationSkills";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { AgentConfigForm, type CreateConfigValues } from "../components/AgentConfigForm";
import { defaultModelForRuntime } from "../components/AgentConfigForm.helpers";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useOrganization } from "../context/OrganizationContext";
import { queryKeys } from "../lib/queryKeys";
import { explicitProviderModelError, isProviderModelFormat, requiresExplicitProviderModel } from "../lib/runtime-models";
import { agentUrl } from "../lib/utils";

const SUPPORTED_ADVANCED_ADAPTER_TYPES = new Set<CreateConfigValues["agentRuntimeType"]>([
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
  "openclaw_gateway",
  "hermes_gateway",
]);
const DEFAULT_FIRST_AGENT_TITLE = "Operator Assistant";

function organizationSkillSourceFallbackLabel(sourceBadge: string) {
  switch (sourceBadge) {
    case "community":
      return "Community preset";
    case "github":
      return "GitHub";
    case "local":
      return "Local";
    case "url":
      return "URL";
    case "skills_sh":
      return "skills.sh";
    case "rudder":
      return "Organization library";
    default:
      return "Catalog";
  }
}

function createValuesForAdapterType(
  agentRuntimeType: CreateConfigValues["agentRuntimeType"],
): CreateConfigValues {
  const { agentRuntimeType: _discard, ...defaults } = defaultCreateValues;
  const nextValues: CreateConfigValues = { ...defaults, agentRuntimeType };
  if (agentRuntimeType === "codex_local") {
    nextValues.model = DEFAULT_CODEX_LOCAL_MODEL;
    nextValues.search = DEFAULT_CODEX_LOCAL_SEARCH;
    nextValues.dangerouslyBypassSandbox =
      DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
  } else if (agentRuntimeType === "gemini_local") {
    nextValues.model = DEFAULT_GEMINI_LOCAL_MODEL;
  } else if (agentRuntimeType === "cursor") {
    nextValues.model = DEFAULT_CURSOR_LOCAL_MODEL;
  } else if (requiresExplicitProviderModel(agentRuntimeType)) {
    nextValues.model = defaultModelForRuntime(agentRuntimeType);
  }
  return nextValues;
}

export function NewAgent() {
  const { selectedOrganization, selectedOrganizationId } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const presetAdapterType = searchParams.get("agentRuntimeType");

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [configValues, setConfigValues] = useState<CreateConfigValues>(defaultCreateValues);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [skillSearchQuery, setSkillSearchQuery] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const hasAppliedInitialGeneralNameRef = useRef(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const {
    data: adapterModels,
  } = useQuery({
    queryKey: selectedOrganizationId
      ? queryKeys.agents.adapterModels(selectedOrganizationId, configValues.agentRuntimeType)
      : ["agents", "none", "adapter-models", configValues.agentRuntimeType],
    queryFn: () => agentsApi.adapterModels(selectedOrganizationId!, configValues.agentRuntimeType),
    enabled: Boolean(selectedOrganizationId),
  });

  const { data: organizationSkills, isPending: organizationSkillsPending } = useQuery({
    queryKey: queryKeys.organizationSkills.list(selectedOrganizationId ?? ""),
    queryFn: () => organizationSkillsApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId),
  });

  const organizationUrlKey = selectedOrganization?.urlKey ?? "organization";
  const organizationSkillPickerItems = useMemo(() => {
    if (!organizationSkills) return [];
    return buildOrganizationSkillPickerItems(organizationSkills, {
      orgUrlKey: organizationUrlKey,
      agentUrlKey: null,
      scope: "organization",
    });
  }, [organizationSkills, organizationUrlKey]);

  // Rudder bundled skills are part of every new agent's baseline and should
  // not appear as optional operator choices in the creation form.
  const selectableOrganizationSkillPickerItems = useMemo(
    // New-agent creation should only surface truly optional org-library skills.
    // The bundled Rudder defaults are always materialized separately at runtime,
    // so showing them here would incorrectly imply they are user choices.
    () => filterSelectableNewAgentOrganizationSkillItems(organizationSkillPickerItems),
    [organizationSkillPickerItems],
  );
  const filteredOrganizationSkillPickerItems = useMemo(
    () => filterOrganizationSkillPickerItems(selectableOrganizationSkillPickerItems, skillSearchQuery),
    [selectableOrganizationSkillPickerItems, skillSearchQuery],
  );
  const showOrganizationSkillPicker = selectableOrganizationSkillPickerItems.length > 0;
  const hasLoadedAgents = Array.isArray(agents);
  const isFirstAgent = hasLoadedAgents && agents.length === 0;
  const effectiveRole = isFirstAgent ? "ceo" : "general";
  const { data: nameSuggestion } = useQuery({
    queryKey: queryKeys.agents.nameSuggestion(selectedOrganizationId!),
    queryFn: () => agentsApi.suggestName(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId && hasLoadedAgents),
  });
  const suggestedName = nameSuggestion?.name.trim() ?? "";

  useEffect(() => {
    setBreadcrumbs([
      { label: "Agents", href: "/agents" },
      { label: "New Agent" },
    ]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (hasLoadedAgents && isFirstAgent) {
      if (!title) setTitle(DEFAULT_FIRST_AGENT_TITLE);
    }
  }, [hasLoadedAgents, isFirstAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const requested = presetAdapterType;
    if (!requested) return;
    if (!SUPPORTED_ADVANCED_ADAPTER_TYPES.has(requested as CreateConfigValues["agentRuntimeType"])) {
      return;
    }
    setConfigValues((prev) => {
      if (prev.agentRuntimeType === requested) return prev;
      return createValuesForAdapterType(requested as CreateConfigValues["agentRuntimeType"]);
    });
  }, [presetAdapterType]);

  useEffect(() => {
    const validSkillIds = new Set(selectableOrganizationSkillPickerItems.map((skill) => skill.id));
    setSelectedSkillIds((prev) => prev.filter((skillId) => validSkillIds.has(skillId)));
  }, [selectableOrganizationSkillPickerItems]);

  useEffect(() => {
    if (!suggestedName || hasAppliedInitialGeneralNameRef.current) return;
    if (name.trim().length === 0) {
      setName(suggestedName);
    }
    hasAppliedInitialGeneralNameRef.current = true;
  }, [name, suggestedName]);

  const createAgent = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      agentsApi.hire(selectedOrganizationId!, data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedOrganizationId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedOrganizationId!) });
      navigate(agentUrl(result.agent));
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "Failed to create agent");
    },
  });

  function buildAdapterConfig() {
    const adapter = getUIAdapter(configValues.agentRuntimeType);
    return adapter.buildAdapterConfig(configValues);
  }

  function handleSubmit() {
    if (!selectedOrganizationId || !hasLoadedAgents) return;
    setFormError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Agent name is required.");
      return;
    }
    if (requiresExplicitProviderModel(configValues.agentRuntimeType)) {
      const selectedModel = configValues.model.trim();
      if (!isProviderModelFormat(selectedModel)) {
        setFormError(explicitProviderModelError(configValues.agentRuntimeType));
        return;
      }
    }
    const desiredSkills = selectedSkillIds
      .map((skillId) => selectableOrganizationSkillPickerItems.find((skill) => skill.id === skillId)?.publicRef ?? null)
      .filter((value): value is string => Boolean(value));
    createAgent.mutate({
      name: trimmedName,
      role: effectiveRole,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(desiredSkills.length > 0 ? { desiredSkills } : {}),
      agentRuntimeType: configValues.agentRuntimeType,
      agentRuntimeConfig: buildAdapterConfig(),
      runtimeConfig: {
        heartbeat: {
          enabled: configValues.heartbeatEnabled,
          intervalSec: configValues.intervalSec,
          preflightEnabled: configValues.preflightEnabled,
          wakeOnDemand: true,
          cooldownSec: 10,
          maxConcurrentRuns: configValues.maxConcurrentRuns,
        },
      },
      budgetMonthlyCents: 0,
    });
  }

  function toggleSkill(skillId: string, checked: boolean) {
    setSelectedSkillIds((prev) => {
      if (checked) {
        return prev.includes(skillId) ? prev : [...prev, skillId];
      }
      return prev.filter((value) => value !== skillId);
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">New Agent</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Advanced agent configuration
        </p>
      </div>

      <div
        data-testid="new-agent-form"
        className="overflow-hidden rounded-xl border border-border bg-[color:var(--surface-elevated)]"
      >
        {/* Name */}
        <div className="px-4 pt-4 pb-2">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="Agent name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        {/* Title */}
        <div className="px-4 pb-2">
          <input
            className="w-full bg-transparent outline-none text-sm text-muted-foreground placeholder:text-muted-foreground/40"
            placeholder="Title (e.g. VP of Engineering)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Shared config form */}
        <AgentConfigForm
          mode="create"
          values={configValues}
          onChange={(patch) => setConfigValues((prev) => ({ ...prev, ...patch }))}
          adapterModels={adapterModels}
          hideInstructionsFile
        />

        {organizationSkillsPending || showOrganizationSkillPicker ? (
          <div className="border-t border-border px-4 py-4">
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Organization skills</h2>
                  {!organizationSkillsPending ? (
                    <span className="text-xs text-muted-foreground">
                      {selectableOrganizationSkillPickerItems.length}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
                  Choose optional skills from the organization library for this agent.
                </p>
              </div>
              {organizationSkillsPending ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Loading skills...</span>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-9 pl-9"
                      placeholder="Search skills"
                      aria-label="Search skills"
                      value={skillSearchQuery}
                      onChange={(event) => setSkillSearchQuery(event.target.value)}
                    />
                  </div>
                  {filteredOrganizationSkillPickerItems.length === 0 ? (
                    <p className="rounded-lg border border-border/70 px-3 py-4 text-xs text-muted-foreground">
                      No skills match your search.
                    </p>
                  ) : (
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      {filteredOrganizationSkillPickerItems.map((skill) => {
                        const checked = selectedSkillIds.includes(skill.id);
                        const sourceFallbackLabel = organizationSkillSourceFallbackLabel(skill.sourceBadge);
                        const sourceLabel = formatOrganizationSkillSourceLabel({
                          sourceBadge: skill.sourceBadge,
                          sourceLabel: skill.sourceLabel,
                          sourceLocator: skill.sourceLocator,
                          sourcePath: skill.sourcePath,
                          fallbackLabel: sourceFallbackLabel,
                        });
                        const sourceTooltip = formatOrganizationSkillSourceTooltip({
                          sourceBadge: skill.sourceBadge,
                          sourceLabel: skill.sourceLabel,
                          sourceLocator: skill.sourceLocator,
                          sourcePath: skill.sourcePath,
                          fallbackLabel: sourceFallbackLabel,
                        });
                        const sourceBadge = (
                          <span className="inline-flex max-w-[10.5rem] items-center truncate rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            {sourceLabel}
                          </span>
                        );
                        return (
                          <div
                            key={skill.id}
                            className={
                              checked
                                ? "flex min-w-0 items-start justify-between gap-3 rounded-lg border border-border bg-background p-3 transition-colors"
                                : "flex min-w-0 items-start justify-between gap-3 rounded-lg border border-border/70 bg-muted/35 p-3 text-muted-foreground transition-colors"
                            }
                          >
                            <div className="min-w-0 space-y-2">
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className={
                                  checked
                                    ? "truncate text-sm font-semibold text-foreground"
                                    : "truncate text-sm font-semibold text-foreground/80"
                                }>
                                  {skill.name}
                                </span>
                                {sourceTooltip ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>{sourceBadge}</TooltipTrigger>
                                    <TooltipContent
                                      side="top"
                                      className="max-w-[18rem] break-words text-left leading-5"
                                    >
                                      {sourceTooltip}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : sourceBadge}
                              </div>
                              <p
                                className="truncate font-mono text-[11px] text-muted-foreground/80"
                                title={skill.publicRef}
                              >
                                {skill.publicRef}
                              </p>
                              <p className="line-clamp-2 text-xs leading-[1.15rem] text-muted-foreground">
                                {skill.description ?? "No description provided."}
                              </p>
                            </div>
                            <ToggleSwitch
                              checked={checked}
                              size="sm"
                              tone="success"
                              aria-label={skill.publicRef}
                              className="cursor-pointer"
                              onClick={() => toggleSkill(skill.id, !checked)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* Footer */}
        <div className="border-t border-border px-4 py-3">
          {isFirstAgent && (
            <p className="text-xs text-muted-foreground mb-2">
              This will be the root agent for the organization.
            </p>
          )}
          {formError && (
            <p className="text-xs text-destructive mb-2">{formError}</p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/agents")}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={createAgent.isPending || !hasLoadedAgents}
              onClick={handleSubmit}
            >
              {createAgent.isPending ? "Creating…" : "Create agent"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
