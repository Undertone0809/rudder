import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { useOrganization } from "../context/OrganizationContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { organizationSkillsApi } from "../api/organizationSkills";
import { queryKeys } from "../lib/queryKeys";
import { AGENT_ROLES } from "@rudderhq/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Loader2, Shield } from "lucide-react";
import { cn, agentUrl } from "../lib/utils";
import { roleLabels } from "../components/agent-config-primitives";
import { AgentConfigForm, type CreateConfigValues } from "../components/AgentConfigForm";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { getUIAdapter } from "../agent-runtimes";
import { ReportsToPicker } from "../components/ReportsToPicker";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_SEARCH,
} from "@rudderhq/agent-runtime-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@rudderhq/agent-runtime-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@rudderhq/agent-runtime-gemini-local";
import {
  buildOrganizationSkillPickerItems,
  filterSelectableNewAgentOrganizationSkillItems,
  filterOrganizationSkillPickerItems,
} from "@/lib/organization-skill-picker";

const SUPPORTED_ADVANCED_ADAPTER_TYPES = new Set<CreateConfigValues["agentRuntimeType"]>([
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
  "openclaw_gateway",
]);

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
  } else if (agentRuntimeType === "opencode_local") {
    nextValues.model = "";
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
  const [role, setRole] = useState("general");
  const [reportsTo, setReportsTo] = useState<string | null>(null);
  const [configValues, setConfigValues] = useState<CreateConfigValues>(defaultCreateValues);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [skillSearchQuery, setSkillSearchQuery] = useState("");
  const [roleOpen, setRoleOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [autoSuggestedName, setAutoSuggestedName] = useState<string | null>(null);
  const previousEffectiveRoleRef = useRef<string | null>(null);
  const hasAppliedInitialGeneralNameRef = useRef(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const {
    data: adapterModels,
    error: adapterModelsError,
    isLoading: adapterModelsLoading,
    isFetching: adapterModelsFetching,
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

  // The four Rudder bundled skills are part of every new agent's baseline and should
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
  const effectiveRole = isFirstAgent ? "ceo" : role;
  const { data: nameSuggestion } = useQuery({
    queryKey: queryKeys.agents.nameSuggestion(selectedOrganizationId!),
    queryFn: () => agentsApi.suggestName(selectedOrganizationId!),
    enabled: Boolean(
      selectedOrganizationId
        && hasLoadedAgents
        && (isFirstAgent || effectiveRole === "general"),
    ),
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
      if (!title) setTitle("CEO");
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
    const shouldAutofillName = isFirstAgent || effectiveRole === "general";
    const wasGeneralRole = previousEffectiveRoleRef.current === "general";
    const shouldApplyInitialSuggestion =
      shouldAutofillName && !hasAppliedInitialGeneralNameRef.current;
    const justSelectedGeneralRole =
      !isFirstAgent && effectiveRole === "general" && !wasGeneralRole;

    if (!shouldAutofillName || !suggestedName) {
      previousEffectiveRoleRef.current = effectiveRole;
      return;
    }

    if (shouldApplyInitialSuggestion || justSelectedGeneralRole) {
      if (name.trim().length === 0 || name === autoSuggestedName) {
        setName(suggestedName);
        setAutoSuggestedName(suggestedName);
      }
      hasAppliedInitialGeneralNameRef.current = true;
    }

    previousEffectiveRoleRef.current = effectiveRole;
  }, [autoSuggestedName, effectiveRole, isFirstAgent, name, suggestedName]);

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
    if (configValues.agentRuntimeType === "opencode_local") {
      const selectedModel = configValues.model.trim();
      if (!selectedModel) {
        setFormError("OpenCode requires an explicit model in provider/model format.");
        return;
      }
      if (adapterModelsError) {
        setFormError(
          adapterModelsError instanceof Error
            ? adapterModelsError.message
            : "Failed to load OpenCode models.",
        );
        return;
      }
      if (adapterModelsLoading || adapterModelsFetching) {
        setFormError("OpenCode models are still loading. Please wait and try again.");
        return;
      }
      const discovered = adapterModels ?? [];
      if (!discovered.some((entry) => entry.id === selectedModel)) {
        setFormError(
          discovered.length === 0
            ? "No OpenCode models discovered. Run `opencode models` and authenticate providers."
            : `Configured OpenCode model is unavailable: ${selectedModel}`,
        );
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
      ...(reportsTo ? { reportsTo } : {}),
      ...(desiredSkills.length > 0 ? { desiredSkills } : {}),
      agentRuntimeType: configValues.agentRuntimeType,
      agentRuntimeConfig: buildAdapterConfig(),
      runtimeConfig: {
        heartbeat: {
          enabled: configValues.heartbeatEnabled,
          intervalSec: configValues.intervalSec,
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

      <div className="border border-border">
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

        {/* Property chips: Role + Reports To */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
          <Popover open={roleOpen} onOpenChange={setRoleOpen}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
                  (isFirstAgent || !hasLoadedAgents) && "opacity-60 cursor-not-allowed"
                )}
                disabled={isFirstAgent || !hasLoadedAgents}
              >
                <Shield className="h-3 w-3 text-muted-foreground" />
                {roleLabels[effectiveRole] ?? effectiveRole}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {AGENT_ROLES.map((r) => (
                <button
                  key={r}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    r === role && "bg-accent"
                  )}
                  onClick={() => { setRole(r); setRoleOpen(false); }}
                >
                  {roleLabels[r] ?? r}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <ReportsToPicker
            agents={agents ?? []}
            value={reportsTo}
            onChange={setReportsTo}
            disabled={isFirstAgent || !hasLoadedAgents}
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
                <h2 className="text-sm font-medium">Organization skills</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Optional skills from the organization library. Search by name, slug, source label, or public ref.
                </p>
              </div>
              {organizationSkillsPending ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Loading skills...</span>
                </div>
              ) : filteredOrganizationSkillPickerItems.length === 0 ? (
                // Once bundled defaults are excluded, an empty filtered list means
                // only the current search produced no matches. If there were no
                // optional skills at all, we would have hidden this section above.
                <p className="text-xs text-muted-foreground">No skills match your search.</p>
              ) : (
                <div className="space-y-3">
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring"
                    placeholder="Search skills..."
                    value={skillSearchQuery}
                    onChange={(event) => setSkillSearchQuery(event.target.value)}
                  />
                  {filteredOrganizationSkillPickerItems.map((skill) => {
                    const inputId = `skill-${skill.id}`;
                    const checked = selectedSkillIds.includes(skill.id);
                    return (
                      <label key={skill.id} htmlFor={inputId} className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2 transition-colors hover:bg-accent/30">
                        <Checkbox
                          id={inputId}
                          checked={checked}
                          onCheckedChange={(next) => toggleSkill(skill.id, next === true)}
                        />
                        <span className="grid min-w-0 gap-1 leading-none">
                          <span className="truncate text-sm font-medium">{skill.publicRef}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {skill.name}
                          </span>
                          <span className="truncate text-[11px] text-muted-foreground/80">
                            {skill.sourceBadge} · {skill.sourceLabel ?? "Unknown source"}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* Footer */}
        <div className="border-t border-border px-4 py-3">
          {isFirstAgent && (
            <p className="text-xs text-muted-foreground mb-2">This will be the CEO</p>
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
