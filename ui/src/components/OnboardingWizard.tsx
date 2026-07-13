import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_SEARCH
} from "@rudderhq/agent-runtime-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@rudderhq/agent-runtime-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@rudderhq/agent-runtime-gemini-local";
import {
  AGENT_RUN_CONCURRENCY_DEFAULT,
  deriveOrganizationIssueKey,
  type AgentRuntimeEnvironmentTestResult,
  type Organization,
} from "@rudderhq/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Building2,
  ChevronDown,
  Code,
  Gem,
  Loader2,
  MousePointer2,
  Sparkles,
  Terminal,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getUIAdapter } from "../agent-runtimes";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { goalsApi } from "../api/goals";
import { onboardingApi } from "../api/onboarding";
import { organizationsApi } from "../api/orgs";
import { secretsApi } from "../api/secrets";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import { resolveRouteOnboardingOptions } from "../lib/onboarding-route";
import { DEFAULT_ORGANIZATION_HOME_PATH, getOrganizationRouteKey } from "../lib/organization-routes";
import { queryKeys } from "../lib/queryKeys";
import {
  blockingRuntimeEnvironmentMessage,
  explicitProviderModelError,
  isProviderModelFormat,
  requiresExplicitProviderModel,
  resolveRuntimeModels,
  runtimeAuthRecoveryHint,
  runtimeManualProbeCommand,
  runtimeModelEmptyLabel,
  runtimeModelEmptyMessage,
  runtimeModelSearchPlaceholder,
  runtimeProviderCredentialEnvKey,
  runtimeProviderCredentialLabel,
  runtimeProviderSetupHint,
} from "../lib/runtime-models";
import { cn } from "../lib/utils";
import { defaultCreateValues } from "./agent-config-defaults";
import { defaultModelForRuntime } from "./AgentConfigForm.helpers";
import { ModelDropdown } from "./AgentConfigForm.model-dropdown";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { AdapterEnvironmentResult } from "./OnboardingWizard.environment";
import {
  DEFAULT_FIRST_AGENT_TITLE,
  ONBOARDING_DRAFT_ORGANIZATION_STORAGE_KEY,
  upsertOrganization,
  type AdapterType,
  type Step,
} from "./OnboardingWizard.parts";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";
import { markProductTourPending } from "./ProductTourOverlay";
export function OnboardingWizard() {
  const { onboardingOpen, onboardingOptions, closeOnboarding } = useDialog();
  const { organizations, setSelectedOrganizationId, loading: organizationsLoading } = useOrganization();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { orgPrefix } = useParams<{ orgPrefix?: string }>();
  const [routeDismissed, setRouteDismissed] = useState(false);
  const routeOnboardingOptions =
    orgPrefix && organizationsLoading
      ? null
      : resolveRouteOnboardingOptions({
          pathname: location.pathname,
          orgPrefix,
          organizations,
        });
  const effectiveOnboardingOpen =
    onboardingOpen || (routeOnboardingOptions !== null && !routeDismissed);
  const effectiveOnboardingOptions = onboardingOpen
    ? onboardingOptions
    : routeOnboardingOptions ?? {};
  const existingCompanyId = effectiveOnboardingOptions.orgId;
  const initialStep = existingCompanyId ? 2 : 1;
  const minimumStep = existingCompanyId ? 2 : 1;
  const [step, setStep] = useState<Step>(initialStep);
  const [furthestStep, setFurthestStep] = useState<Step>(initialStep);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  // Step 1
  const [organizationName, setCompanyName] = useState("");
  const [organizationIssueKey, setOrganizationIssueKey] = useState("");
  const [organizationIssueKeyEdited, setOrganizationIssueKeyEdited] = useState(false);
  const [companyGoal, setCompanyGoal] = useState("");
  const [firstTimeUser, setFirstTimeUser] = useState(true);
  // Step 2
  const [agentName, setAgentName] = useState("");
  const [autoSuggestedAgentName, setAutoSuggestedAgentName] = useState<
    string | null
  >(null);
  const [agentRuntimeType, setAdapterType] = useState<AdapterType>("claude_local");
  const [model, setModel] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerSecretBinding, setProviderSecretBinding] = useState<{
    envKey: string;
    value: string;
    secretId: string;
  } | null>(null);
  const [url, setUrl] = useState("");
  const [adapterEnvResult, setAdapterEnvResult] =
    useState<AgentRuntimeEnvironmentTestResult | null>(null);
  const [adapterEnvError, setAdapterEnvError] = useState<string | null>(null);
  const [adapterEnvLoading, setAdapterEnvLoading] = useState(false);
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] =
    useState(false);
  const [unsetAnthropicLoading, setUnsetAnthropicLoading] = useState(false);
  const [showMoreAdapters, setShowMoreAdapters] = useState(false);
  const draftOrganizationIdRef = useRef<string | null>(null);
  const shouldCleanupDraftOrganizationRef = useRef(false);
  const hasAppliedInitialAgentNameRef = useRef(false);
  // Created entity IDs — pre-populate from existing organization when skipping step 1
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    existingCompanyId ?? null
  );
  const [createdGoalId, setCreatedGoalId] = useState<string | null>(null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [createdNewOrganizationInSession, setCreatedNewOrganizationInSession] =
    useState(false);
  const organizationReady = Boolean(createdCompanyId);
  const syncOrganizationSnapshot = useCallback((organization: Organization) => {
    queryClient.setQueryData<Organization[]>(
      queryKeys.organizations.all,
      (current) => upsertOrganization(current, organization),
    );
  }, [queryClient]);
  const canReturnToOrganizationStep = minimumStep === 1 && organizationReady;
  const isStepUnlocked = useCallback(
    (targetStep: Step) => targetStep >= minimumStep && targetStep <= furthestStep,
    [furthestStep, minimumStep]
  );
  const previousStep = useMemo<Step | null>(() => {
    if (step === 2 && canReturnToOrganizationStep) return 1;
    return null;
  }, [canReturnToOrganizationStep, step]);
  useEffect(() => {
    setRouteDismissed(false);
  }, [location.pathname]);
  // Sync step and organization when onboarding opens with options.
  // Keep this independent from organization-list refreshes so Step 1 completion
  // doesn't get reset after creating a organization.
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const cId = effectiveOnboardingOptions.orgId ?? null;
    setStep(cId ? 2 : 1);
    setFurthestStep(cId ? 2 : 1);
    setAgentName("");
    setAutoSuggestedAgentName(null);
    setFirstTimeUser(true);
    hasAppliedInitialAgentNameRef.current = false;
    setCreatedCompanyId(cId);
    setCreatedGoalId(null);
    setCreatedAgentId(null);
    setCreatedNewOrganizationInSession(false);
  }, [
    effectiveOnboardingOpen,
    effectiveOnboardingOptions.orgId,
  ]);
  useEffect(() => {
    const shouldCleanup =
      createdNewOrganizationInSession &&
      createdCompanyId !== null;
    draftOrganizationIdRef.current = shouldCleanup ? createdCompanyId : null;
    shouldCleanupDraftOrganizationRef.current = shouldCleanup;
    if (typeof window === "undefined") return;
    if (shouldCleanup && createdCompanyId) {
      window.sessionStorage.setItem(
        ONBOARDING_DRAFT_ORGANIZATION_STORAGE_KEY,
        createdCompanyId
      );
    }
  }, [createdCompanyId, createdNewOrganizationInSession]);
  const cleanupDraftOrganization = useCallback(
    async (options?: { keepalive?: boolean }) => {
      const draftOrganizationId = draftOrganizationIdRef.current;
      if (!draftOrganizationId || !shouldCleanupDraftOrganizationRef.current) {
        return false;
      }
      if (options?.keepalive) {
        void fetch(`/api/orgs/${encodeURIComponent(draftOrganizationId)}`, {
          method: "DELETE",
          credentials: "include",
          keepalive: true
        });
        return true;
      }
      shouldCleanupDraftOrganizationRef.current = false;
      draftOrganizationIdRef.current = null;
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(
          ONBOARDING_DRAFT_ORGANIZATION_STORAGE_KEY
        );
      }
      try {
        await organizationsApi.remove(draftOrganizationId);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) {
          throw err;
        }
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.all
      });
      return true;
    },
    [queryClient]
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (
      shouldCleanupDraftOrganizationRef.current &&
      draftOrganizationIdRef.current !== null
    ) {
      return;
    }
    const storedDraftOrganizationId = window.sessionStorage.getItem(
      ONBOARDING_DRAFT_ORGANIZATION_STORAGE_KEY
    );
    if (!storedDraftOrganizationId) return;
    let cancelled = false;
    void (async () => {
      try {
        try {
          await organizationsApi.remove(storedDraftOrganizationId);
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404) {
            throw err;
          }
        }
        if (!cancelled) {
          window.sessionStorage.removeItem(
            ONBOARDING_DRAFT_ORGANIZATION_STORAGE_KEY
          );
          await queryClient.invalidateQueries({
            queryKey: queryKeys.organizations.all
          });
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to rollback the unfinished onboarding draft."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveOnboardingOpen, queryClient]);
  const {
    data: adapterModels,
    isLoading: adapterModelsLoading,
    isFetching: adapterModelsFetching
  } = useQuery({
    queryKey: createdCompanyId
      ? queryKeys.agents.adapterModels(createdCompanyId, agentRuntimeType)
      : ["agents", "none", "adapter-models", agentRuntimeType],
    queryFn: () => agentsApi.adapterModels(createdCompanyId!, agentRuntimeType),
    enabled: Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 2
  });
  const { data: nameSuggestion } = useQuery({
    queryKey: createdCompanyId
      ? queryKeys.agents.nameSuggestion(createdCompanyId)
      : ["agents", "none", "name-suggestion"],
    queryFn: () => agentsApi.suggestName(createdCompanyId!),
    enabled: Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 2
  });
  useEffect(() => {
    if (step !== 2) return;
    const suggestedName = nameSuggestion?.name.trim() ?? "";
    if (!suggestedName || hasAppliedInitialAgentNameRef.current) return;
    if (agentName.trim().length > 0) return;
    setAgentName(suggestedName);
    setAutoSuggestedAgentName(suggestedName);
    hasAppliedInitialAgentNameRef.current = true;
  }, [agentName, nameSuggestion, step]);
  const isLocalAdapter =
    agentRuntimeType === "claude_local" ||
    agentRuntimeType === "codex_local" ||
    agentRuntimeType === "gemini_local" ||
    agentRuntimeType === "opencode_local" ||
    agentRuntimeType === "pi_local" ||
    agentRuntimeType === "cursor";
  const effectiveAdapterCommand =
    command.trim() ||
    (agentRuntimeType === "codex_local"
      ? "codex"
      : agentRuntimeType === "gemini_local"
        ? "gemini"
      : agentRuntimeType === "pi_local"
      ? "pi"
      : agentRuntimeType === "cursor"
      ? "cursor-agent"
      : agentRuntimeType === "opencode_local"
      ? "opencode"
      : "claude");
  useEffect(() => {
    if (step !== 2) return;
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
  }, [step, agentRuntimeType, model, command, args, providerApiKey, url]);
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const handlePageHide = () => {
      void cleanupDraftOrganization({ keepalive: true });
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [cleanupDraftOrganization, effectiveOnboardingOpen]);
  const availableAdapterModels = useMemo(
    () => resolveRuntimeModels(agentRuntimeType, adapterModels),
    [agentRuntimeType, adapterModels]
  );
  const requiresProviderModel = requiresExplicitProviderModel(agentRuntimeType);
  const providerSetupHint = runtimeProviderSetupHint(agentRuntimeType, model);
  const providerCredentialEnvKey = runtimeProviderCredentialEnvKey(agentRuntimeType, model);
  const providerCredentialLabel = runtimeProviderCredentialLabel(agentRuntimeType, model);
  const adapterEnvBlockingMessage = adapterEnvResult
    ? blockingRuntimeEnvironmentMessage(adapterEnvResult)
    : null;
  const hasAnthropicApiKeyOverrideCheck =
    adapterEnvResult?.checks.some(
      (check) =>
        check.code === "claude_anthropic_api_key_overrides_subscription"
    ) ?? false;
  const shouldSuggestUnsetAnthropicApiKey =
    agentRuntimeType === "claude_local" &&
    adapterEnvResult?.status === "fail" &&
    hasAnthropicApiKeyOverrideCheck;
  function selectRuntimeType(nextType: AdapterType) {
    setAdapterType(nextType);
    setModel(defaultModelForRuntime(nextType));
    setProviderApiKey("");
    setProviderSecretBinding(null);
  }
  function selectModel(nextModel: string) {
    const currentEnvKey = runtimeProviderCredentialEnvKey(agentRuntimeType, model);
    const nextEnvKey = runtimeProviderCredentialEnvKey(agentRuntimeType, nextModel);
    setModel(nextModel);
    if (currentEnvKey !== nextEnvKey) {
      setProviderApiKey("");
      setProviderSecretBinding(null);
    }
  }
  function reset() {
    setStep(1);
    setLoading(false);
    setError(null);
    setCompanyName("");
    setOrganizationIssueKey("");
    setOrganizationIssueKeyEdited(false);
    setCompanyGoal("");
    setFirstTimeUser(true);
    setAgentName("");
    setAutoSuggestedAgentName(null);
    hasAppliedInitialAgentNameRef.current = false;
    setAdapterType("claude_local");
    setModel("");
    setCommand("");
    setArgs("");
    setProviderApiKey("");
    setProviderSecretBinding(null);
    setUrl("");
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
    setAdapterEnvLoading(false);
    setForceUnsetAnthropicApiKey(false);
    setUnsetAnthropicLoading(false);
    setCreatedCompanyId(null);
    setCreatedGoalId(null);
    setCreatedAgentId(null);
    setCreatedNewOrganizationInSession(false);
  }
  async function handleClose() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      await cleanupDraftOrganization();
      reset();
      closeOnboarding();
    } catch (err) {
      setLoading(false);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to rollback the unfinished onboarding draft."
      );
    }
  }
  function buildAdapterConfig(
    providerCredential?: { envKey: string; binding: Record<string, unknown> } | null,
  ): Record<string, unknown> {
    const adapter = getUIAdapter(agentRuntimeType);
    const envBindings: Record<string, unknown> = {};
    if (providerCredential) {
      envBindings[providerCredential.envKey] = providerCredential.binding;
    }
    const config = adapter.buildAdapterConfig({
      ...defaultCreateValues,
      agentRuntimeType,
      model:
        agentRuntimeType === "codex_local"
          ? model || DEFAULT_CODEX_LOCAL_MODEL
          : agentRuntimeType === "gemini_local"
            ? model || DEFAULT_GEMINI_LOCAL_MODEL
          : agentRuntimeType === "cursor"
          ? model || DEFAULT_CURSOR_LOCAL_MODEL
          : model,
      command,
      args,
      url,
      search:
        agentRuntimeType === "codex_local"
          ? DEFAULT_CODEX_LOCAL_SEARCH
          : defaultCreateValues.search,
      dangerouslySkipPermissions: defaultCreateValues.dangerouslySkipPermissions,
      permissionMode:
        agentRuntimeType === "claude_local"
          ? defaultCreateValues.permissionMode
          : undefined,
      dangerouslyBypassSandbox:
        agentRuntimeType === "codex_local"
          ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
          : defaultCreateValues.dangerouslyBypassSandbox,
      envBindings,
    });
    if (agentRuntimeType === "claude_local" && forceUnsetAnthropicApiKey) {
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
    }
    return config;
  }
  async function ensureProviderCredentialBinding(): Promise<{
    envKey: string;
    binding: Record<string, unknown>;
  } | null> {
    const envKey = providerCredentialEnvKey;
    const value = providerApiKey.trim();
    if (!envKey || !value) return null;
    if (!createdCompanyId) {
      throw new Error("Complete organization setup before storing provider credentials.");
    }
    if (
      providerSecretBinding &&
      providerSecretBinding.envKey === envKey &&
      providerSecretBinding.value === value
    ) {
      return {
        envKey,
        binding: {
          type: "secret_ref",
          secretId: providerSecretBinding.secretId,
          version: "latest",
        },
      };
    }
    const secret = await secretsApi.create(createdCompanyId, {
      name: `onboarding-${envKey.toLowerCase().replace(/_/g, "-")}-${Date.now()}`,
      value,
      description: `Created from onboarding for ${model.trim() || envKey}.`,
    });
    setProviderSecretBinding({ envKey, value, secretId: secret.id });
    return {
      envKey,
      binding: {
        type: "secret_ref",
        secretId: secret.id,
        version: "latest",
      },
    };
  }
  async function buildAdapterConfigWithProviderSecret(): Promise<Record<string, unknown>> {
    return buildAdapterConfig(await ensureProviderCredentialBinding());
  }
  async function runAdapterEnvironmentTest(
    agentRuntimeConfigOverride?: Record<string, unknown>
  ): Promise<AgentRuntimeEnvironmentTestResult | null> {
    if (!createdCompanyId) {
      setStep(1);
      setAdapterEnvError("Complete organization setup before testing the runtime.");
      return null;
    }
    setAdapterEnvLoading(true);
    setAdapterEnvError(null);
    try {
      const result = await agentsApi.testEnvironment(
        createdCompanyId,
        agentRuntimeType,
        {
          agentRuntimeConfig: agentRuntimeConfigOverride ?? (await buildAdapterConfigWithProviderSecret())
        }
      );
      setAdapterEnvResult(result);
      return result;
    } catch (err) {
      setAdapterEnvError(
        err instanceof Error ? err.message : "Runtime environment test failed"
      );
      return null;
    } finally {
      setAdapterEnvLoading(false);
    }
  }
  async function handleStep1Next() {
    setLoading(true);
    setError(null);
    try {
      const isCreatingOrganization = !createdCompanyId;
      const organization = createdCompanyId
        ? await organizationsApi.update(createdCompanyId, {
            name: organizationName.trim(),
            issuePrefix: organizationIssueKey,
          })
        : await organizationsApi.create({
            name: organizationName.trim(),
            issuePrefix: organizationIssueKey,
          });
      if (isCreatingOrganization) {
        draftOrganizationIdRef.current = organization.id;
        shouldCleanupDraftOrganizationRef.current = true;
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(
            ONBOARDING_DRAFT_ORGANIZATION_STORAGE_KEY,
            organization.id
          );
        }
      }
      setCreatedCompanyId(organization.id);
      setCreatedNewOrganizationInSession(
        (current) => current || isCreatingOrganization
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      if (companyGoal.trim()) {
        const parsedGoal = parseOnboardingGoalInput(companyGoal);
        const goal = createdGoalId
          ? await goalsApi.update(createdGoalId, {
              title: parsedGoal.title,
              ...(parsedGoal.description
                ? { description: parsedGoal.description }
                : { description: "" }),
            })
          : await goalsApi.create(organization.id, {
              title: parsedGoal.title,
              ...(parsedGoal.description
                ? { description: parsedGoal.description }
                : {}),
              level: "organization",
              status: "active"
            });
        setCreatedGoalId(goal.id);
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(organization.id)
        });
      }
      setStep(2);
      setFurthestStep((current) => (current > 2 ? current : 2));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : createdCompanyId
            ? "Failed to update organization"
            : "Failed to create organization"
      );
    } finally {
      setLoading(false);
    }
  }
  async function seedGettingStartedOnboarding(organizationId: string, includeTutorial = true) {
    const result = await onboardingApi.seedGettingStarted(organizationId, {
      includeTutorial,
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.projects.list(organizationId)
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.issues.list(organizationId)
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.issues.follows(organizationId)
    });
    return result;
  }
  async function handleStep2Next() {
    if (!createdCompanyId) {
      setError("Complete organization setup before creating an agent.");
      setStep(1);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const trimmedAgentName = agentName.trim();
      if (!trimmedAgentName) {
        setError("Agent name is required.");
        return;
      }
      if (requiresProviderModel) {
        const selectedModelId = model.trim();
        if (!isProviderModelFormat(selectedModelId)) {
          setError(explicitProviderModelError(agentRuntimeType));
          return;
        }
      }
      const agentRuntimeConfig = await buildAdapterConfigWithProviderSecret();
      if (isLocalAdapter) {
        const result = adapterEnvResult ?? (await runAdapterEnvironmentTest(agentRuntimeConfig));
        if (!result) return;
        const blockingMessage = blockingRuntimeEnvironmentMessage(result);
        if (blockingMessage) {
          setError(blockingMessage);
          return;
        }
      }
      const agentPayload = {
        name: trimmedAgentName,
        role: "ceo",
        title: DEFAULT_FIRST_AGENT_TITLE,
        agentRuntimeType,
        agentRuntimeConfig,
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 3600,
            wakeOnDemand: true,
            cooldownSec: 10,
            preflightEnabled: true,
            maxConcurrentRuns: AGENT_RUN_CONCURRENCY_DEFAULT
          }
        },
        seedOrganizationIntelligenceDefaults: createdNewOrganizationInSession
      };
      const agent = createdAgentId
        ? await agentsApi.update(createdAgentId, agentPayload, createdCompanyId)
        : await agentsApi.create(createdCompanyId, agentPayload);
      setCreatedAgentId(agent.id);
      const organizationSnapshot = await organizationsApi.get(createdCompanyId);
      syncOrganizationSnapshot(organizationSnapshot);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(createdCompanyId)
      });
      if (createdNewOrganizationInSession) {
        await seedGettingStartedOnboarding(createdCompanyId, firstTimeUser);
      }
      shouldCleanupDraftOrganizationRef.current = false;
      draftOrganizationIdRef.current = null;
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(ONBOARDING_DRAFT_ORGANIZATION_STORAGE_KEY);
      }
      setSelectedOrganizationId(createdCompanyId);
      markProductTourPending();
      reset();
      closeOnboarding();
      navigate(
        organizationSnapshot.issuePrefix
          ? `/${getOrganizationRouteKey(organizationSnapshot)}${DEFAULT_ORGANIZATION_HOME_PATH}`
          : DEFAULT_ORGANIZATION_HOME_PATH
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : createdAgentId
            ? "Failed to update agent"
            : "Failed to create agent"
      );
    } finally {
      setLoading(false);
    }
  }
  async function handleUnsetAnthropicApiKey() {
    if (!createdCompanyId || unsetAnthropicLoading) return;
    setUnsetAnthropicLoading(true);
    setError(null);
    setAdapterEnvError(null);
    setForceUnsetAnthropicApiKey(true);
    const configWithUnset = (() => {
      const config = buildAdapterConfig();
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
      return config;
    })();
    try {
      if (createdAgentId) {
        await agentsApi.update(
          createdAgentId,
          { agentRuntimeConfig: configWithUnset },
          createdCompanyId
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
      }
      const result = await runAdapterEnvironmentTest(configWithUnset);
      if (result?.status === "fail") {
        setError(
          "Retried with ANTHROPIC_API_KEY unset in adapter config, but the environment test is still failing."
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to unset ANTHROPIC_API_KEY and retry."
      );
    } finally {
      setUnsetAnthropicLoading(false);
    }
  }
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (step === 1 && organizationName.trim()) handleStep1Next();
      else if (step === 2) handleStep2Next();
    }
  }
  if (!effectiveOnboardingOpen) return null;
  return (
    <Dialog
      open={effectiveOnboardingOpen} onOpenChange={(open) => {
        if (!open) {
          setRouteDismissed(true);
          void handleClose();
        }
      }} >
      <DialogPortal>
        <div className="fixed inset-0 z-50 bg-background" />
        <div className="fixed inset-0 z-50 flex" onKeyDown={handleKeyDown}>
          <button onClick={() => void handleClose()} className={cn(
              "absolute top-4 right-4 z-10 rounded-full border p-2 transition-colors",
              step === 1
                ? "border-white/15 bg-white/10 text-white/80 backdrop-blur-sm hover:bg-white/15 hover:text-white"
                : "border-border/70 bg-background/85 text-muted-foreground shadow-sm backdrop-blur-sm hover:text-foreground"
            )} >
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span> </button>
          <div className={cn(
              "w-full flex flex-col overflow-y-auto transition-[width] duration-500 ease-in-out",
              step === 1 ? "md:w-1/2" : "md:w-full"
            )} >
            <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
              <div
                className="grid grid-cols-2 mb-8 border-b border-border"
                data-testid="onboarding-step-tabs"
              >
                {(
                  [
                    { step: 1 as Step, label: "Organization", icon: Building2 },
                    { step: 2 as Step, label: "Agent", icon: Bot }
                  ] as const
                ).map(({ step: s, label, icon: Icon }) => {
                  const unlocked = isStepUnlocked(s);
                  return (
                  <button key={s} type="button" data-testid={`onboarding-step-tab-${s}`} aria-current={s === step ? "step" : undefined} aria-disabled={!unlocked} disabled={!unlocked} onClick={() => {
                      if (!unlocked || s === step) return;
                      setError(null);
                      setStep(s);
                    }} className={cn(
                      "flex w-full items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors",
                      s === step
                        ? "border-foreground text-foreground"
                        : unlocked
                          ? "border-transparent text-muted-foreground hover:text-foreground/70 hover:border-border cursor-pointer"
                          : "border-transparent text-muted-foreground/45 cursor-not-allowed"
                    )} >
                    <Icon className="h-3.5 w-3.5" />
                    {label} </button>
                )})} </div>
              {step === 1 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" /> </div>
                    <div>
                      <h3 className="font-medium">Name your organization</h3>
                      <p className="text-xs text-muted-foreground">
                        This is the organization your agents will work for.
                      </p> </div> </div>
                  <div className="mt-3 group">
                    <label className={cn(
                        "text-xs mb-1 block transition-colors",
                        organizationName.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )} >
                      Organization name
                    </label>
                    <input className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50" placeholder="Acme Corp" value={organizationName} onChange={(e) => {
                      const nextName = e.target.value;
                      setCompanyName(nextName);
                      if (!organizationIssueKeyEdited) setOrganizationIssueKey(deriveOrganizationIssueKey(nextName));
                    }}
                      autoFocus /> </div>
                  <div className="group">
                    <label className="text-xs mb-1 block text-muted-foreground group-focus-within:text-foreground">
                      Issue key
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-sm uppercase outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      aria-label="Issue key"
                      value={organizationIssueKey}
                      onChange={(e) => {
                        setOrganizationIssueKeyEdited(true);
                        setOrganizationIssueKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12));
                      }}
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Used in issue IDs, for example {organizationIssueKey || "ORG"}-1. It must be unique.
                    </p>
                  </div>
                  <div className="group">
                    <label className={cn(
                        "text-xs mb-1 block transition-colors",
                        companyGoal.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )} >
                      Mission / goal (optional)
                    </label>
                    <textarea className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[60px]" placeholder="What is this organization trying to achieve?" value={companyGoal} onChange={(e) => setCompanyGoal(e.target.value)} /> </div>
                  <label className="flex items-start gap-2 rounded-md border border-border/70 px-3 py-2 text-xs">
                    <Checkbox checked={firstTimeUser} onCheckedChange={(checked) => setFirstTimeUser(checked === true)} className="mt-0.5" />
                    <span>
                      <span className="block font-medium text-foreground">I’m new to Rudder</span>
                      <span className="block text-muted-foreground">
                        Create guided Getting Started issues. Turn this off to seed only the welcome issue. </span> </span>
                  </label> </div>
              )}
              {step === 2 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Bot className="h-5 w-5 text-muted-foreground" /> </div>
                    <div>
                      <h3 className="font-medium">Create your first agent</h3>
                      <p className="text-xs text-muted-foreground">
                        Choose how this agent will run tasks.
                      </p> </div> </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Agent name
                    </label>
                    <input className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50" placeholder="Agent name" value={agentName} onChange={(e) => {
                        setAgentName(e.target.value);
                        if (
                          autoSuggestedAgentName &&
                          e.target.value !== autoSuggestedAgentName
                        ) {
                          setAutoSuggestedAgentName(null);
                        }
                      }}
                      autoFocus /> </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">
                      Runtime type
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        {
                          value: "claude_local" as const,
                          label: "Claude Code",
                          icon: Sparkles,
                          desc: "Local Claude agent",
                          recommended: true
                        },
                        {
                          value: "codex_local" as const,
                          label: "Codex",
                          icon: Code,
                          desc: "Local Codex agent",
                          recommended: true
                        }
                      ].map((opt) => (
                        <button key={opt.value} className={cn(
                            "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                            agentRuntimeType === opt.value
                              ? "border-foreground bg-accent"
                              : "border-border hover:bg-accent/50"
                          )} onClick={() => {
                            const nextType = opt.value as AdapterType;
                            selectRuntimeType(nextType);
                          }} >
                          {opt.recommended && (
                            <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                              Recommended </span>
                          )}
                          <opt.icon className="h-4 w-4" />
                          <span className="font-medium">{opt.label}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {opt.desc} </span> </button>
                      ))} </div>
                    <button className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors" onClick={() => setShowMoreAdapters((v) => !v)} >
                      <ChevronDown className={cn(
                          "h-3 w-3 transition-transform",
                          showMoreAdapters ? "rotate-0" : "-rotate-90"
                        )} />
                      More Agent Runtime Types </button>
                    {showMoreAdapters && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        {[
                          {
                            value: "gemini_local" as const,
                            label: "Gemini CLI",
                            icon: Gem,
                            desc: "Local Gemini agent"
                          },
                          {
                            value: "opencode_local" as const,
                            label: "OpenCode",
                            icon: OpenCodeLogoIcon,
                            desc: "Local multi-provider agent"
                          },
                          {
                            value: "pi_local" as const,
                            label: "Pi",
                            icon: Terminal,
                            desc: "Local Pi agent"
                          },
                          {
                            value: "cursor" as const,
                            label: "Cursor",
                            icon: MousePointer2,
                            desc: "Local Cursor agent"
                          },
                          {
                            value: "openclaw_gateway" as const,
                            label: "OpenClaw Gateway",
                            icon: Bot,
                            desc: "Invoke OpenClaw via gateway protocol",
                            comingSoon: true,
                            disabledLabel: "Configure OpenClaw within the App"
                          }
                        ].map((opt) => (
                          <button key={opt.value} disabled={!!opt.comingSoon} className={cn(
                              "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                              opt.comingSoon
                                ? "border-border opacity-40 cursor-not-allowed"
                                : agentRuntimeType === opt.value
                                ? "border-foreground bg-accent"
                                : "border-border hover:bg-accent/50"
                            )} onClick={() => {
                              if (opt.comingSoon) return;
                              const nextType = opt.value as AdapterType;
                              selectRuntimeType(nextType);
                            }} >
                            <opt.icon className="h-4 w-4" />
                            <span className="font-medium">{opt.label}</span>
                            <span className="text-muted-foreground text-[10px]">
                              {opt.comingSoon
                                ? (opt as { disabledLabel?: string })
                                    .disabledLabel ?? "Coming soon"
                                : opt.desc} </span> </button>
                        ))} </div>
                    )} </div>
                  {(agentRuntimeType === "claude_local" ||
                    agentRuntimeType === "codex_local" ||
                    agentRuntimeType === "gemini_local" ||
                    agentRuntimeType === "opencode_local" ||
                    agentRuntimeType === "pi_local" ||
                    agentRuntimeType === "cursor") && (
                    <div className="space-y-3">
                      <ModelDropdown
                        label="Model"
                        models={availableAdapterModels}
                        value={model}
                        onChange={selectModel}
                        open={modelOpen}
                        onOpenChange={setModelOpen}
                        allowDefault={!requiresProviderModel}
                        required={requiresProviderModel}
                        groupByProvider={requiresProviderModel}
                        preserveModelOrder={agentRuntimeType === "codex_local"}
                        emptyLabel={runtimeModelEmptyLabel(agentRuntimeType, requiresProviderModel)}
                        searchPlaceholder={runtimeModelSearchPlaceholder(agentRuntimeType)}
                        emptyMessage={runtimeModelEmptyMessage(
                          agentRuntimeType,
                          adapterModelsLoading || adapterModelsFetching,
                        )}
                        allowCustom
                      />
                      {providerSetupHint ? (
                        <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                          {providerSetupHint}
                        </div>
                      ) : null}
                      {providerCredentialEnvKey ? (
                        <div className="space-y-1.5">
                          <label className="text-xs text-muted-foreground block">
                            {providerCredentialLabel}
                          </label>
                          <input
                            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                            type="password"
                            autoComplete="off"
                            placeholder={`Paste ${providerCredentialEnvKey}`}
                            value={providerApiKey}
                            onChange={(event) => setProviderApiKey(event.currentTarget.value)}
                          />
                          <p className="text-[11px] leading-relaxed text-muted-foreground">
                            Stored as a Rudder secret and referenced by this agent runtime for Test now and future runs.
                          </p>
                        </div>
                      ) : null}
                    </div>
                  )}
                  {isLocalAdapter && (
                    <div className="space-y-2 rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium">
                            Runtime environment check
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Runs a live probe that asks the runtime CLI to
                            respond with hello.
                          </p> </div>
                        <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={!organizationReady || adapterEnvLoading} onClick={() => void runAdapterEnvironmentTest()} >
                          {adapterEnvLoading ? "Testing..." : "Test now"}
                        </Button> </div>
                      {adapterEnvError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
                          {adapterEnvError} </div>
                      )}
                      {adapterEnvResult ? (
                        <AdapterEnvironmentResult result={adapterEnvResult} />
                      ) : null}
                      {shouldSuggestUnsetAnthropicApiKey && (
                        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-2.5 py-2 space-y-2">
                          <p className="text-[11px] text-amber-900/90 leading-relaxed">
                            Claude failed while{" "}
                            <span className="font-mono">ANTHROPIC_API_KEY</span>{" "}
                            is set. You can clear it in this agent adapter config
                            and retry the probe.
                          </p>
                          <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={
                              adapterEnvLoading || unsetAnthropicLoading
                            } onClick={() => void handleUnsetAnthropicApiKey()} >
                            {unsetAnthropicLoading
                              ? "Retrying..."
                              : "Unset ANTHROPIC_API_KEY"}
                          </Button> </div>
                      )}
                      {adapterEnvResult && adapterEnvBlockingMessage && (
                        <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px] space-y-1.5">
                          <p className="font-medium">Manual debug</p>
                          <p className="text-muted-foreground font-mono break-all">
                            {runtimeManualProbeCommand(agentRuntimeType, effectiveAdapterCommand, model)}
                          </p>
                          <p className="text-muted-foreground">
                            Prompt:{" "}
                            <span className="font-mono">Respond with hello.</span>
                          </p>
                          <p className="text-muted-foreground">
                            {runtimeAuthRecoveryHint(agentRuntimeType, model)}
                          </p>
                        </div>
                      )} </div>
                  )}
                  {(agentRuntimeType === "http" ||
                    agentRuntimeType === "openclaw_gateway") && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        {agentRuntimeType === "openclaw_gateway"
                          ? "Gateway URL"
                          : "Webhook URL"}
                      </label>
                      <input className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50" placeholder={
                          agentRuntimeType === "openclaw_gateway"
                            ? "ws://127.0.0.1:18789"
                            : "https://..."
                        } value={url} onChange={(e) => setUrl(e.target.value)} /> </div>
                  )} </div>
              )}
              {error && (
                <div className="mt-3">
                  <p className="text-xs text-destructive">{error}</p> </div>
              )}
              <div className="flex items-center justify-between mt-8">
                <div>
                  {previousStep !== null && (
                    <Button variant="ghost" size="sm" onClick={() => {
                        setError(null);
                        setStep(previousStep);
                      }} disabled={loading} >
                      <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                      Back
                    </Button>
                  )} </div>
                <div className="flex items-center gap-2">
                  {step === 1 && (
                    <Button size="sm" disabled={!organizationName.trim() || (!createdCompanyId && !organizationIssueKey) || loading} onClick={handleStep1Next} >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Next"}
                    </Button>
                  )}
                  {step === 2 && (
                    <Button size="sm" disabled={loading || adapterEnvLoading} onClick={handleStep2Next} >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Create"}
                    </Button>
                  )}
                </div> </div> </div> </div>
          <div className={cn(
              "hidden md:block overflow-hidden bg-[#1d1d1d] transition-[width,opacity] duration-500 ease-in-out",
              step === 1 ? "w-1/2 opacity-100" : "w-0 opacity-0"
            )} >
            <AsciiArtAnimation /> </div> </div>
      </DialogPortal>
    </Dialog>
  );
}
