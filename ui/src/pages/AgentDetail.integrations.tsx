import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type {
  AgentBrowserToolSummary,
  AgentDetail,
  AgentIntegrationProviderRegion,
  AgentIntegrationSetupSession,
  AgentIntegrationSummary,
  AgentRudderToolSummary,
  CreateCustomIntegration,
  CustomIntegrationKind,
  CustomIntegrationScope,
  CustomIntegrationSummary,
  McpAgentAccessMode,
  McpConnectionProvider,
  McpConnectionScope,
  McpProviderAvailability,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Braces,
  CalendarDays,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  Inbox,
  KeyRound,
  Loader2,
  PlugZap,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { managedMcpApi } from "../api/managedMcp";
import { FeishuLogoIcon } from "../components/FeishuLogoIcon";
import { McpProviderIcon } from "../components/McpProviderIcon";
import { useToast } from "../context/ToastContext";
import {
  applyOrganizationPrefix,
  extractOrganizationPrefixFromPath,
} from "../lib/organization-routes";
import { queryKeys } from "../lib/queryKeys";
import { buildSettingsOverlayState } from "../lib/settings-overlay-state";
import { cn, formatDateTime } from "../lib/utils";
import { AgentManagedMcpConnections } from "./AgentManagedMcpConnections";
import { AgentProviderAccessDialog } from "./AgentProviderAccessDialog";
import { reserveAuthorizationLauncher } from "./OrganizationMcpSettings";

type IntegrationState = "not_configured" | "active" | "revoked" | "error";

type UpcomingIntegrationId =
  | "gmail"
  | "google_calendar"
  | "google_drive";

type IntegrationCategory = "message" | "productivity" | "developer";
type IntegrationsView = "discover" | "manage";
type RudderRuntimeIntegrationSummary = AgentRudderToolSummary | AgentBrowserToolSummary;

interface UpcomingIntegrationDefinition {
  id: UpcomingIntegrationId;
  name: string;
  description: string;
  connectionScope: "Personal" | "Workspace" | "Developer";
  actionLabel: string;
  category: IntegrationCategory;
  logoSrc: string;
  Icon: LucideIcon | typeof FeishuLogoIcon;
}

const UPCOMING_INTEGRATIONS: UpcomingIntegrationDefinition[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Read, search, draft, and send email from agent work.",
    connectionScope: "Personal",
    actionLabel: "Coming soon",
    category: "message",
    logoSrc: "/brands/gmail-logo.svg",
    Icon: Inbox,
  },
  {
    id: "google_calendar",
    name: "Google Calendar",
    description: "View and edit calendar events for scheduling work.",
    connectionScope: "Personal",
    actionLabel: "Coming soon",
    category: "productivity",
    logoSrc: "/brands/google-calendar-logo.svg",
    Icon: CalendarDays,
  },
  {
    id: "google_drive",
    name: "Google Drive",
    description: "Browse Drive files and attach workspace context.",
    connectionScope: "Workspace",
    actionLabel: "Coming soon",
    category: "productivity",
    logoSrc: "/brands/google-drive-logo.svg",
    Icon: FolderOpen,
  },
];

type ManagedMcpProviderDefinition = {
  id: "supabase" | "notion" | "linear" | "github";
  name: string;
  description: string;
  category: Extract<IntegrationCategory, "productivity" | "developer">;
};

const MANAGED_MCP_PROVIDER_INTEGRATIONS: ManagedMcpProviderDefinition[] = [
  {
    id: "notion",
    name: "Notion",
    description: "Search pages, databases, and operating notes through organization-managed MCP tools.",
    category: "productivity",
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Use the organization’s Supabase account and choose the project needed for each task.",
    category: "developer",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Work with the organization’s Linear workspace through managed MCP tools.",
    category: "developer",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Search and inspect GitHub repositories through the official OAuth flow.",
    category: "developer",
  },
];

const INTEGRATION_CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  message: "Message",
  productivity: "Productivity",
  developer: "Developer",
};

function integrationStateCopy(state: IntegrationState) {
  switch (state) {
    case "active":
      return {
        label: "Connected",
        tone: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      };
    case "revoked":
      return {
        label: "Disconnected",
        tone: "border-border bg-muted text-muted-foreground",
      };
    case "error":
      return {
        label: "Needs attention",
        tone: "border-destructive/25 bg-destructive/10 text-destructive",
      };
    default:
      return {
        label: "Not configured",
        tone: "border-border bg-muted text-muted-foreground",
      };
  }
}

export function getFeishuIntegrationState(integration: AgentIntegrationSummary | null): IntegrationState {
  if (!integration) return "not_configured";
  if (integration.status === "active") return "active";
  if (integration.status === "revoked") return "revoked";
  return "error";
}

function providerLabel(provider: AgentIntegrationSummary["provider"]) {
  if (provider === "feishu") return "Feishu";
  return provider;
}

function regionLabel(region: AgentIntegrationSummary["providerRegion"]) {
  if (region === "feishu_cn") return "Feishu CN";
  if (region === "lark_global") return "Lark Global";
  return region;
}

function setupProviderName(providerRegion: AgentIntegrationProviderRegion) {
  return providerRegion === "lark_global" ? "Lark" : "Feishu";
}

const FEISHU_SUGGESTED_BOT_NAME_MAX_LENGTH = 32;
const FEISHU_SUGGESTED_BOT_NAME_SUFFIX = " - Rudder";

type CustomIntegrationFormState = {
  kind: CustomIntegrationKind;
  displayName: string;
  description: string;
  scope: CustomIntegrationScope;
  endpointUrl: string;
  authHeaderName: string;
  credentialValue: string;
  toolName: string;
  toolDescription: string;
};

function defaultCustomIntegrationForm(kind: CustomIntegrationKind): CustomIntegrationFormState {
  return {
    kind,
    displayName: kind === "mcp_server" ? "MCP Server" : "Custom API",
    description: "",
    scope: "agent",
    endpointUrl: "",
    authHeaderName: "Authorization",
    credentialValue: "",
    toolName: kind === "mcp_server" ? "call_tool" : "request",
    toolDescription: kind === "mcp_server"
      ? "Call an exposed MCP tool through Rudder."
      : "Call the configured API through Rudder.",
  };
}

function suggestedFeishuBotName(agentName: string) {
  const trimmed = agentName.trim();
  const base = trimmed || "Rudder Agent";
  const maxBaseLength = FEISHU_SUGGESTED_BOT_NAME_MAX_LENGTH - FEISHU_SUGGESTED_BOT_NAME_SUFFIX.length;
  return `${base.slice(0, maxBaseLength).trimEnd()}${FEISHU_SUGGESTED_BOT_NAME_SUFFIX}`;
}

interface AgentIntegrationsTabProps {
  agent: AgentDetail;
  orgId?: string;
}

export function AgentIntegrationsTab({ agent, orgId }: AgentIntegrationsTabProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [providerRegion, setProviderRegion] = useState<AgentIntegrationProviderRegion>("feishu_cn");
  const [setupSession, setSetupSession] = useState<AgentIntegrationSetupSession | null>(null);
  const [customForm, setCustomForm] = useState<CustomIntegrationFormState | null>(null);
  const [integrationsView, setIntegrationsView] = useState<IntegrationsView>("discover");
  const [feishuDialogOpen, setFeishuDialogOpen] = useState(false);
  const [managedProvider, setManagedProvider] = useState<McpProviderAvailability | null>(null);
  const [managedProviderAccess, setManagedProviderAccess] = useState<McpAgentAccessMode>("none");
  const [managedProviderConflict, setManagedProviderConflict] = useState("");
  const [connectionTargetProvider, setConnectionTargetProvider] = useState<McpProviderAvailability | null>(null);
  const [connectionTarget, setConnectionTarget] = useState<{
    scope: McpConnectionScope;
    ownerAgentId: string | null;
  }>({ scope: "agent", ownerAgentId: agent.id });
  const managedProviderTriggerRef = useRef<HTMLElement | null>(null);
  const integrationsQuery = useQuery({
    queryKey: queryKeys.agents.integrations(agent.id),
    queryFn: () => agentsApi.listIntegrations(agent.id, orgId),
    initialData: agent.integrations ?? [],
  });
  const customIntegrationsQuery = useQuery({
    queryKey: queryKeys.agents.customIntegrations(agent.id),
    queryFn: () => agentsApi.listCustomIntegrations(agent.id, orgId),
    initialData: [] as CustomIntegrationSummary[],
  });
  const managedMcpConnectionsQuery = useQuery({
    queryKey: queryKeys.agents.mcpConnections(agent.id),
    queryFn: () => agentsApi.listMcpConnections(agent.id, orgId),
  });
  const managedMcpProviderStatusQuery = useQuery({
    queryKey: queryKeys.agents.mcpProviderStatus(agent.id),
    queryFn: () => agentsApi.listMcpProviderStatus(agent.id, orgId),
    refetchInterval: (query) => (query.state.data ?? []).some(
      (status) => status.organization.state === "connecting"
        || status.agent?.connection?.state === "connecting",
    ) ? 2_000 : false,
  });
  const integrations = integrationsQuery.data ?? [];
  const customIntegrations = customIntegrationsQuery.data ?? [];
  const managedMcpConnections = managedMcpConnectionsQuery.data ?? [];
  const managedMcpProviderStatuses = managedMcpProviderStatusQuery.data ?? [];
  const rudderTools = agent.rudderTools ?? [];
  const feishuIntegration = integrations.find((integration) => integration.provider === "feishu") ?? null;
  const state = getFeishuIntegrationState(feishuIntegration);
  const isActive = state === "active";
  const shouldShowSetupPrompt = !feishuIntegration || state !== "active";
  const openManagedProvider = (status: McpProviderAvailability) => {
    managedProviderTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setManagedProvider(status);
    setManagedProviderAccess(status.agent?.access ?? "none");
    setManagedProviderConflict("");
  };
  const updateManagedProviderAccess = useMutation({
    mutationFn: async () => {
      const effectiveConnectionId = managedProvider?.agent?.effectiveConnectionId;
      if (!effectiveConnectionId) {
        throw new Error("No effective connection is available");
      }
      const row = managedMcpConnections.find(
        (candidate) => candidate.connection.id === effectiveConnectionId,
      );
      return agentsApi.updateMcpConnectionBinding(
        agent.id,
        effectiveConnectionId,
        {
          accessMode: managedProviderAccess,
          status: managedProviderAccess === "none" ? "disabled" : "active",
          ...(row?.binding ? { expectedRevision: row.binding.policyRevision } : {}),
        },
        orgId,
      );
    },
    onSuccess: async () => {
      setManagedProvider(null);
      pushToast({ title: "Agent access updated", tone: "success" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.mcpConnections(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.mcpProviderStatus(agent.id) }),
      ]);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setManagedProviderConflict("Settings changed elsewhere. Review the latest access and try again.");
        const [statusResult] = await Promise.all([
          managedMcpProviderStatusQuery.refetch(),
          managedMcpConnectionsQuery.refetch(),
        ]);
        const latest = statusResult?.data?.find(
          (candidate) => candidate.provider === managedProvider?.provider,
        );
        if (latest) {
          setManagedProvider(latest);
          setManagedProviderAccess(latest.agent?.access ?? "none");
        }
        return;
      }
      pushToast({
        title: "Could not update agent access",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const connectManagedProvider = useMutation({
    mutationFn: async () => {
      if (!orgId || !connectionTargetProvider) throw new Error("Connection target is unavailable");
      const launcher = reserveAuthorizationLauncher();
      try {
        const result = await managedMcpApi.ensureOfficialConnection(
          orgId,
          connectionTargetProvider.provider as Exclude<McpConnectionProvider, "custom">,
          connectionTarget,
        );
        if ("authorizationUrl" in result) {
          await launcher.navigate(result.authorizationUrl);
        } else {
          const started = await managedMcpApi.startOAuth(orgId, result.id);
          await launcher.navigate(started.authorizationUrl);
        }
        return result;
      } catch (error) {
        launcher.close();
        throw error;
      }
    },
    onSuccess: async () => {
      setConnectionTargetProvider(null);
      setManagedProvider(null);
      pushToast({
        title: "Authorization opened",
        body: "Finish provider authorization in the browser.",
        tone: "info",
      });
      await Promise.all([
        managedMcpConnectionsQuery.refetch(),
        managedMcpProviderStatusQuery.refetch(),
      ]);
    },
    onError: (error) => pushToast({
      title: connectionTargetProvider?.provider === "github"
        ? "Could not connect GitHub"
        : "Could not start authorization",
      body: error instanceof Error ? error.message : undefined,
      tone: "error",
    }),
  });
  const openSetup = useMutation({
    mutationFn: () => agentsApi.startFeishuSetupSession(agent.id, {
      providerRegion,
    }, orgId),
    onSuccess: async (result) => {
      setSetupSession(result);
      const opened = window.open(result.setupUrl, "_blank", "noopener,noreferrer");
      if (!opened) {
        pushToast({
          title: "Browser blocked the setup window",
          body: "Allow pop-ups for Rudder, then try Connect again.",
          tone: "error",
        });
        return;
      }
      pushToast({ title: `Opened setup for ${result.suggestedBotName}`, tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to open integration setup",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!setupSession || setupSession.status !== "waiting_for_authorization") return undefined;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const next = await agentsApi.getFeishuSetupSession(agent.id, setupSession.id, orgId);
        if (cancelled) return;
        setSetupSession(next);
        if (next.status === "completed") {
          pushToast({ title: "Feishu integration connected", tone: "success" });
          await queryClient.invalidateQueries({ queryKey: queryKeys.agents.integrations(agent.id) });
          await queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
          return;
        }
        if (next.status === "failed" || next.status === "expired") {
          pushToast({
            title: next.status === "expired" ? "Feishu setup expired" : "Feishu setup failed",
            body: next.statusDetail ?? undefined,
            tone: "error",
          });
          return;
        }
        timeoutId = setTimeout(poll, 2500);
      } catch (error) {
        if (cancelled) return;
        pushToast({
          title: "Failed to check Feishu setup",
          body: error instanceof Error ? error.message : undefined,
          tone: "error",
        });
        timeoutId = setTimeout(poll, 5000);
      }
    };

    timeoutId = setTimeout(poll, 2500);
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [agent.id, orgId, pushToast, queryClient, setupSession]);
  const revokeIntegration = useMutation({
    mutationFn: (integrationId: string) => agentsApi.revokeIntegration(agent.id, integrationId, orgId),
    onSuccess: async () => {
      pushToast({ title: "Integration disconnected", tone: "success" });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.integrations(agent.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to disconnect integration",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const updateIntegrationSettings = useMutation({
    mutationFn: (input: { integrationId: string; notifyFeishu: boolean }) =>
      agentsApi.updateIntegrationSettings(agent.id, input.integrationId, {
        settings: {
          feishu: {
            dailySessionRolloverEnabled: true,
            dailySessionRolloverHours: 24,
            dailySessionRolloverNotifyFeishu: input.notifyFeishu,
          },
        },
      }, orgId),
    onSuccess: async () => {
      pushToast({ title: "Feishu settings updated", tone: "success" });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.integrations(agent.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update Feishu settings",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const createCustomIntegration = useMutation({
    mutationFn: (form: CustomIntegrationFormState) => {
      const credentialValue = form.credentialValue.trim();
      const configKey = form.kind === "mcp_server" ? "serverUrl" : "baseUrl";
      const payload: CreateCustomIntegration = {
        scope: form.scope,
        kind: form.kind,
        displayName: form.displayName.trim(),
        description: form.description.trim() || null,
        config: {
          [configKey]: form.endpointUrl.trim(),
          ...(form.authHeaderName.trim() ? { authHeaderName: form.authHeaderName.trim() } : {}),
        },
        ...(credentialValue
          ? { credential: { value: credentialValue } }
          : {}),
        tools: [
          {
            externalToolName: form.toolName.trim(),
            description: form.toolDescription.trim() || null,
          },
        ],
      };
      return agentsApi.createCustomIntegration(agent.id, payload, orgId);
    },
    onSuccess: async () => {
      pushToast({ title: "Custom integration connected", tone: "success" });
      setCustomForm(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.customIntegrations(agent.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to connect custom integration",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const revokeCustomIntegration = useMutation({
    mutationFn: (integrationId: string) => agentsApi.revokeCustomIntegration(agent.id, integrationId, orgId),
    onSuccess: async () => {
      pushToast({ title: "Custom integration disconnected", tone: "success" });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.customIntegrations(agent.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to disconnect custom integration",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const canSubmitCustomForm = customForm
    ? customForm.displayName.trim().length > 0
      && customForm.endpointUrl.trim().length > 0
      && customForm.toolName.trim().length > 0
      && !createCustomIntegration.isPending
    : false;
  const managedFeishuIntegration = feishuIntegration?.status === "active" ? feishuIntegration : null;
  const managedCustomIntegrations = customIntegrations.filter((integration) => (
    integration.status === "active" && integration.binding?.status === "active"
  ));
  const hasManagedIntegrations = rudderTools.length > 0 || Boolean(managedFeishuIntegration) || managedCustomIntegrations.length > 0;
  const closeManagedProvider = () => {
    setManagedProvider(null);
    requestAnimationFrame(() => managedProviderTriggerRef.current?.focus());
  };

  return (
    <Tabs
      value={integrationsView}
      onValueChange={(next) => setIntegrationsView(next as IntegrationsView)}
      className="max-w-5xl gap-5"
    >
      <TabsList aria-label="Agent tools">
        <TabsTrigger value="discover" onClick={() => setIntegrationsView("discover")}>
          Discover
        </TabsTrigger>
        <TabsTrigger value="manage" onClick={() => setIntegrationsView("manage")}>
          Manage
        </TabsTrigger>
      </TabsList>

      <TabsContent value="discover">
          <div className="space-y-6">
            <IntegrationCategorySection title="Agent-scoped custom API">
              <CustomIntegrationSetupCard
                kind="custom_api"
                active={customForm?.kind === "custom_api"}
                onConfigure={() => setCustomForm(defaultCustomIntegrationForm("custom_api"))}
              />
            </IntegrationCategorySection>
            <AgentManagedMcpConnections
              agentId={agent.id}
              orgId={orgId}
              providers={["custom"]}
              sectionTitle="Organization MCPs"
              hideWhenEmpty
            />
            <IntegrationCategorySection title="Message">
              <FeishuIntegrationCard
                state={state}
                disabled={openSetup.isPending || integrationsQuery.isLoading}
                onConfigure={() => setFeishuDialogOpen(true)}
              />
              {UPCOMING_INTEGRATIONS
                .filter((integration) => integration.category === "message")
                .map((integration) => (
                  <UpcomingIntegrationCard
                    key={integration.id}
                    integration={integration}
                  />
                ))}
            </IntegrationCategorySection>
            <IntegrationCategorySection title="Productivity">
              {MANAGED_MCP_PROVIDER_INTEGRATIONS
                .filter((integration) => integration.category === "productivity")
                .map((integration) => (
                  <ManagedMcpProviderCard
                    key={integration.id}
                    integration={integration}
                    status={managedMcpProviderStatuses.find((status) => status.provider === integration.id)}
                    loading={managedMcpProviderStatusQuery.isLoading}
                    loadFailed={managedMcpProviderStatusQuery.isError}
                    onManage={openManagedProvider}
                    onRetry={() => void managedMcpProviderStatusQuery.refetch()}
                  />
                ))}
              {UPCOMING_INTEGRATIONS
                .filter((integration) => integration.category === "productivity")
                .map((integration) => (
                  <UpcomingIntegrationCard
                    key={integration.id}
                    integration={integration}
                  />
                ))}
            </IntegrationCategorySection>
            <IntegrationCategorySection title="Developer">
              {MANAGED_MCP_PROVIDER_INTEGRATIONS
                .filter((integration) => integration.category === "developer")
                .map((integration) => (
                  <ManagedMcpProviderCard
                    key={integration.id}
                    integration={integration}
                    status={managedMcpProviderStatuses.find((status) => status.provider === integration.id)}
                    loading={managedMcpProviderStatusQuery.isLoading}
                    loadFailed={managedMcpProviderStatusQuery.isError}
                    onManage={openManagedProvider}
                    onRetry={() => void managedMcpProviderStatusQuery.refetch()}
                  />
                ))}
              {UPCOMING_INTEGRATIONS
                .filter((integration) => integration.category === "developer")
                .map((integration) => (
                  <UpcomingIntegrationCard
                    key={integration.id}
                    integration={integration}
                  />
                ))}
            </IntegrationCategorySection>
          </div>
      </TabsContent>
      <TabsContent value="manage">
          <div className="space-y-4">
            <IntegrationManageGroup title="External MCPs">
              <AgentManagedMcpConnections
                agentId={agent.id}
                orgId={orgId}
                providerStatuses={managedMcpProviderStatuses}
                showOnlyEnabled
              />
            </IntegrationManageGroup>
            {integrationsQuery.isLoading || customIntegrationsQuery.isLoading ? (
              <IntegrationRowSkeleton />
            ) : hasManagedIntegrations ? (
              <div className="space-y-5">
                {rudderTools.length > 0 ? (
                  <IntegrationManageGroup
                    title="Built-in"
                    count={rudderTools.length}
                  >
                    {rudderTools.map((integration) => (
                      <RudderRuntimeManageRow key={integration.id} integration={integration} />
                    ))}
                  </IntegrationManageGroup>
                ) : null}
                {managedFeishuIntegration ? (
                  <IntegrationManageGroup
                    title="Message"
                    count={1}
                  >
                    <FeishuManageRow
                      integration={managedFeishuIntegration}
                      disabled={revokeIntegration.isPending || openSetup.isPending}
                      onConfigure={() => setFeishuDialogOpen(true)}
                      onDisconnect={() => revokeIntegration.mutate(managedFeishuIntegration.id)}
                    />
                  </IntegrationManageGroup>
                ) : null}
                {managedCustomIntegrations.length > 0 ? (
                  <IntegrationManageGroup title="Custom tools" count={managedCustomIntegrations.length}>
                    {managedCustomIntegrations.map((integration) => (
                      <CustomIntegrationRow
                        key={integration.id}
                        integration={integration}
                        disabled={revokeCustomIntegration.isPending}
                        onDisconnect={() => revokeCustomIntegration.mutate(integration.id)}
                      />
                    ))}
                  </IntegrationManageGroup>
                ) : null}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border bg-background/30 px-4 py-8 text-center">
                <p className="text-sm font-medium text-foreground">No connected tools</p>
                <p className="mt-1 text-sm text-muted-foreground">Use Discover to connect messaging, MCP, or custom tools.</p>
              </div>
            )}
          </div>
      </TabsContent>
      <Dialog
        open={Boolean(customForm)}
        onOpenChange={(open) => {
          if (!open && !createCustomIntegration.isPending) setCustomForm(null);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          {customForm ? (
            <>
              <DialogHeader>
                <DialogTitle>Connect {customIntegrationKindLabel(customForm.kind)}</DialogTitle>
                <DialogDescription>
                  Choose whether this integration is limited to this agent or shared across the organization.
                  Credentials are stored as organization secrets and never shown again.
                </DialogDescription>
              </DialogHeader>
              <CustomIntegrationForm
                form={customForm}
                disabled={createCustomIntegration.isPending}
                canSubmit={canSubmitCustomForm}
                onChange={setCustomForm}
                onCancel={() => setCustomForm(null)}
                onSubmit={() => {
                  if (canSubmitCustomForm && customForm) createCustomIntegration.mutate(customForm);
                }}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={feishuDialogOpen}
        onOpenChange={(open) => {
          if (!open && !openSetup.isPending && !revokeIntegration.isPending) setFeishuDialogOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{isActive ? "Manage Feishu / Lark" : "Connect Feishu / Lark"}</DialogTitle>
            <DialogDescription>
              Connect a Feishu or Lark bot for this agent's chat workflow.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {shouldShowSetupPrompt ? (
              <>
                <FeishuSetupPrompt
                  suggestedBotName={suggestedFeishuBotName(agent.name)}
                  providerRegion={providerRegion}
                  onProviderRegionChange={setProviderRegion}
                  disabled={openSetup.isPending}
                  setupSession={setupSession}
                  existingIntegration={feishuIntegration}
                />
                {feishuIntegration ? <IntegrationMetadata integration={feishuIntegration} /> : null}
              </>
            ) : feishuIntegration ? (
              <IntegrationMetadata
                integration={feishuIntegration}
                settingsPending={updateIntegrationSettings.isPending}
                onDailySessionNotifyChange={(notifyFeishu) => {
                  updateIntegrationSettings.mutate({
                    integrationId: feishuIntegration.id,
                    notifyFeishu,
                  });
                }}
              />
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setFeishuDialogOpen(false)}
                disabled={openSetup.isPending || revokeIntegration.isPending}
              >
                Cancel
              </Button>
              {feishuIntegration?.manageUrl ? (
                <Button variant="outline" size="sm" asChild>
                  <a href={feishuIntegration.manageUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Provider settings
                  </a>
                </Button>
              ) : null}
              {isActive && feishuIntegration ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => revokeIntegration.mutate(feishuIntegration.id)}
                  disabled={revokeIntegration.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {revokeIntegration.isPending ? "Disconnecting" : "Disconnect"}
                </Button>
              ) : (
                <Button type="button" size="sm" onClick={() => openSetup.mutate()} disabled={openSetup.isPending}>
                  {openSetup.isPending ? "Opening" : "Connect"}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <AgentProviderAccessDialog
        provider={managedProvider}
        access={managedProviderAccess}
        conflictMessage={managedProviderConflict}
        pending={updateManagedProviderAccess.isPending}
        onAccessChange={setManagedProviderAccess}
        onClose={closeManagedProvider}
        onSave={() => updateManagedProviderAccess.mutate()}
        onAddConnection={() => {
          if (!managedProvider) return;
          setConnectionTarget({ scope: "agent", ownerAgentId: agent.id });
          setConnectionTargetProvider(managedProvider);
          setManagedProvider(null);
        }}
        onOpenOrganizationSettings={() => {
          const prefix = extractOrganizationPrefixFromPath(location.pathname);
          setManagedProvider(null);
          void navigate(
            applyOrganizationPrefix("/organization/settings?view=integrations", prefix),
            { state: buildSettingsOverlayState(location) },
          );
        }}
      />
      <AgentConnectionTargetDialog
        provider={connectionTargetProvider}
        agent={agent}
        target={connectionTarget}
        pending={connectManagedProvider.isPending}
        connections={managedMcpConnections.map((row) => row.connection)}
        onTargetChange={setConnectionTarget}
        onClose={() => {
          setConnectionTargetProvider(null);
        }}
        onManageExisting={() => {
          setConnectionTargetProvider(null);
          setManagedProvider(connectionTargetProvider);
        }}
        onConfirm={() => connectManagedProvider.mutate()}
      />
    </Tabs>
  );
}

interface UpcomingIntegrationCardProps {
  integration: UpcomingIntegrationDefinition;
}

function IntegrationCategorySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="grid gap-3 lg:grid-cols-2">{children}</div>
    </section>
  );
}

function IntegrationManageGroup({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {count !== undefined ? (
          <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {count}
          </span>
        ) : null}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function IntegrationBrandIcon({
  src,
  name,
  Icon,
}: {
  src?: string;
  name: string;
  Icon?: LucideIcon | typeof FeishuLogoIcon;
}) {
  const imageClassName = cn(
    "h-5 w-5 shrink-0",
    name === "GitHub" || name === "Notion" ? "dark:invert" : undefined,
  );
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
      {src ? (
        <img src={src} alt="" className={imageClassName} />
      ) : Icon ? (
        <Icon className="h-5 w-5" />
      ) : null}
    </div>
  );
}

function IntegrationActionButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn("rounded-[var(--radius-md)]", className)}
      {...props}
    />
  );
}

function FeishuIntegrationCard({
  state,
  disabled,
  onConfigure,
}: {
  state: IntegrationState;
  disabled: boolean;
  onConfigure: () => void;
}) {
  const stateCopy = integrationStateCopy(state);

  return (
    <div className="grid gap-3 rounded-md border border-border bg-background/40 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <IntegrationBrandIcon src="/brands/feishu-logo.svg" name="Feishu / Lark" />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">Feishu / Lark</p>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              Personal
            </span>
            <span className={cn("rounded-md border px-1.5 py-0.5 text-xs", stateCopy.tone)}>
              {stateCopy.label}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">Chat with this agent through a Feishu or Lark bot.</p>
        </div>
      </div>
      <IntegrationActionButton variant="outline" size="sm" onClick={onConfigure} disabled={disabled}>
        {state === "active" ? "Manage" : "Set up"}
      </IntegrationActionButton>
    </div>
  );
}

function UpcomingIntegrationCard({ integration }: UpcomingIntegrationCardProps) {
  const { Icon } = integration;

  return (
    <div className="grid gap-3 rounded-md border border-border bg-background/40 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <IntegrationBrandIcon src={integration.logoSrc} name={integration.name} Icon={Icon} />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{integration.name}</p>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              {integration.connectionScope}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{integration.description}</p>
        </div>
      </div>
      <IntegrationActionButton variant="outline" size="sm" disabled aria-label={`${integration.name} coming soon`}>
        {integration.actionLabel}
      </IntegrationActionButton>
    </div>
  );
}

function ManagedMcpProviderCard({
  integration,
  status,
  loading,
  loadFailed,
  onManage,
  onRetry,
}: {
  integration: ManagedMcpProviderDefinition;
  status?: McpProviderAvailability;
  loading: boolean;
  loadFailed: boolean;
  onManage: (status: McpProviderAvailability) => void;
  onRetry: () => void;
}) {
  if (loading) {
    return <Skeleton className="h-24 w-full" aria-label={`Loading ${integration.name} status`} />;
  }
  const organizationState = status?.organization.state ?? "not_connected";
  const agentConnectionState = status?.agent?.connection?.state ?? "not_connected";
  const agentAccess = status?.agent?.access ?? "none";
  const connected = Boolean(status?.agent && status.agent.effectiveSource !== "none");
  const explicitlyDisabled = status?.agent?.explicitlyDisabled ?? false;
  const enabled = connected && agentAccess !== "none" && !explicitlyDisabled;
  const displayStatus = loadFailed
    ? "Unavailable"
    : explicitlyDisabled
      ? "Disabled for this agent"
    : enabled
      ? agentAccess === "read_only"
        ? "Read only"
        : agentAccess === "read_write"
          ? "Read & write"
          : "Provider-granted access"
    : connected
      ? "Available"
      : agentConnectionState === "connecting" || organizationState === "connecting"
        ? "Connecting"
        : agentConnectionState === "needs_attention" || organizationState === "needs_attention"
          ? "Needs attention"
      : "Not connected";
  const statusTone = loadFailed
    ? "border-destructive/25 bg-destructive/10 text-destructive"
    : enabled
    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : connected
      ? "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300"
      : "border-border bg-muted text-muted-foreground";
  const details = loadFailed
    ? "Managed MCP status could not be loaded."
    : explicitlyDisabled
      ? "This agent explicitly blocks the organization connection."
    : enabled
      ? "Available during this agent’s next run."
      : connected
        ? "A connection is ready for this agent."
        : null;

  return (
    <div
      data-testid={`managed-mcp-provider-${integration.id}`}
      className="grid gap-3 rounded-md border border-border bg-background/40 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="flex min-w-0 items-start gap-3">
        <McpProviderIcon provider={integration.id} />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{integration.name}</p>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              Organization MCP
            </span>
            <span className={cn("rounded-md border px-1.5 py-0.5 text-xs", statusTone)}>
              {displayStatus}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{integration.description}</p>
          {details ? <p className="text-xs text-muted-foreground">{details}</p> : null}
        </div>
      </div>
      {loadFailed ? (
        <IntegrationActionButton variant="outline" size="sm" onClick={onRetry}>
          Retry
        </IntegrationActionButton>
      ) : status ? (
        <IntegrationActionButton
          variant="outline"
          size="sm"
          onClick={() => onManage(status)}
          aria-label={`Manage ${integration.name}`}
        >
          Manage
        </IntegrationActionButton>
      ) : (
        <IntegrationActionButton variant="outline" size="sm" disabled>
          Manage
        </IntegrationActionButton>
      )}
    </div>
  );
}

function AgentConnectionTargetDialog({
  provider,
  agent,
  target,
  pending,
  connections,
  onTargetChange,
  onClose,
  onManageExisting,
  onConfirm,
}: {
  provider: McpProviderAvailability | null;
  agent: AgentDetail;
  target: { scope: McpConnectionScope; ownerAgentId: string | null };
  pending: boolean;
  connections: Array<{
    provider: McpConnectionProvider;
    scope: McpConnectionScope;
    ownerAgentId: string | null;
    status: string;
  }>;
  onTargetChange: (target: { scope: McpConnectionScope; ownerAgentId: string | null }) => void;
  onClose: () => void;
  onManageExisting: () => void;
  onConfirm: () => void;
}) {
  if (!provider) return null;
  const name = provider.provider[0]!.toUpperCase() + provider.provider.slice(1);
  const existing = connections.some((connection) => (
    connection.provider === provider.provider
    && connection.scope === target.scope
    && connection.ownerAgentId === target.ownerAgentId
    && connection.status !== "revoked"
  ));
  const isGitHub = provider.provider === "github";
  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !pending) onClose();
    }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <McpProviderIcon provider={provider.provider} />
            <DialogTitle>{name}</DialogTitle>
          </div>
          <DialogDescription>
            {isGitHub
              ? "Connect GitHub through the official OAuth flow for this target."
              : "Connect a separate credential for this agent or share one with the organization."}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-dashed border-border p-4">
          <label className="space-y-2 text-sm font-medium text-foreground">
            <span>Enable for</span>
            <span className="relative block">
              <select
                aria-label="Enable for"
                className="h-10 w-full appearance-none rounded-md border border-input bg-background py-0 pr-10 pl-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={target.scope}
                onChange={(event) => onTargetChange(event.target.value === "organization"
                  ? { scope: "organization", ownerAgentId: null }
                  : { scope: "agent", ownerAgentId: agent.id })}
              >
                <option value="agent">{agent.name}</option>
                <option value="organization">Organization</option>
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
                data-testid="connection-target-chevron"
              />
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button
            disabled={pending}
            onClick={existing ? onManageExisting : onConfirm}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {existing ? "Manage" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RudderRuntimeManageRow({ integration }: { integration: RudderRuntimeIntegrationSummary }) {
  const available = integration.status === "available";
  return (
    <div
      className="grid gap-3 rounded-md border border-border bg-background/40 p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      aria-label={`${integration.displayName} integration`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <IntegrationBrandIcon src="/rudder-logo.png" name="Rudder" />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{integration.displayName}</p>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              Built-in
            </span>
            <span className={cn(
              "rounded-md border px-1.5 py-0.5 text-xs",
              available
                ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-border bg-muted text-muted-foreground",
            )}>
              {available ? "Available" : "Disabled"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Managed automatically by the Rudder runtime.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 text-xs font-medium text-muted-foreground">
          <KeyRound className="h-3.5 w-3.5" />
          No user credential
        </span>
      </div>
    </div>
  );
}

function FeishuManageRow({
  integration,
  disabled,
  onConfigure,
  onDisconnect,
}: {
  integration: AgentIntegrationSummary;
  disabled: boolean;
  onConfigure: () => void;
  onDisconnect: () => void;
}) {
  const stateCopy = integrationStateCopy(getFeishuIntegrationState(integration));

  return (
    <div className="grid gap-3 rounded-md border border-border bg-background/40 p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <IntegrationBrandIcon src="/brands/feishu-logo.svg" name="Feishu / Lark" />
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">Feishu / Lark</p>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              {regionLabel(integration.providerRegion)}
            </span>
            <span className={cn("rounded-md border px-1.5 py-0.5 text-xs", stateCopy.tone)}>
              {stateCopy.label}
            </span>
          </div>
          <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <IntegrationMeta label="App ID" value={integration.externalAppId} />
            <IntegrationMeta label="Bot" value={integration.externalBotOpenId ?? "Any bot"} />
            <IntegrationMeta label="Installed" value={formatDateTime(integration.installedAt)} />
          </dl>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <IntegrationActionButton variant="outline" size="sm" onClick={onConfigure} disabled={disabled}>
          Manage
        </IntegrationActionButton>
        <IntegrationActionButton variant="outline" size="sm" onClick={onDisconnect} disabled={disabled || integration.status !== "active"}>
          <Trash2 className="h-3.5 w-3.5" />
          Disconnect
        </IntegrationActionButton>
      </div>
    </div>
  );
}

interface CustomIntegrationSetupCardProps {
  kind: CustomIntegrationKind;
  active: boolean;
  onConfigure: () => void;
}

function customIntegrationKindLabel(kind: CustomIntegrationKind) {
  return kind === "mcp_server" ? "MCP Server" : "Custom API";
}

function customIntegrationScopeLabel(scope: CustomIntegrationScope) {
  return scope === "organization" ? "Organization shared" : "This agent only";
}

function CustomIntegrationSetupCard({ kind, active, onConfigure }: CustomIntegrationSetupCardProps) {
  const Icon = kind === "mcp_server" ? PlugZap : Braces;
  return (
    <div className={cn(
      "grid gap-3 rounded-md border border-dashed bg-background/30 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
      active ? "border-primary/55 bg-primary/5" : "border-border",
    )}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{customIntegrationKindLabel(kind)}</p>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              Agent tools
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {kind === "mcp_server"
              ? "Expose a remote MCP server to this agent or the organization."
              : "Register an internal or external HTTP API as a Rudder-mediated tool."}
          </p>
        </div>
      </div>
      <IntegrationActionButton variant="outline" size="sm" onClick={onConfigure}>
        Configure
      </IntegrationActionButton>
    </div>
  );
}

interface CustomIntegrationFormProps {
  form: CustomIntegrationFormState;
  disabled: boolean;
  canSubmit: boolean;
  onChange: (form: CustomIntegrationFormState) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function CustomIntegrationForm({
  form,
  disabled,
  canSubmit,
  onChange,
  onCancel,
  onSubmit,
}: CustomIntegrationFormProps) {
  const endpointLabel = form.kind === "mcp_server" ? "Server URL" : "Base URL";
  const fieldPrefix = `custom-integration-${form.kind}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Scope</p>
        <div className="inline-flex rounded-[calc(var(--radius-sm)-1px)] border border-border bg-background p-0.5">
          {(["agent", "organization"] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              className={cn(
                "h-7 rounded-[2px] px-2.5 text-xs font-medium transition-colors first:rounded-l-[calc(var(--radius-sm)-2px)] last:rounded-r-[calc(var(--radius-sm)-2px)]",
                form.scope === scope
                  ? "bg-muted text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              disabled={disabled}
              onClick={() => onChange({ ...form, scope })}
            >
              {scope === "agent" ? "This agent" : "Organization"}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <div className="space-y-1 text-xs font-medium text-muted-foreground">
          <label htmlFor={`${fieldPrefix}-display-name`}>Display name</label>
          <Input
            id={`${fieldPrefix}-display-name`}
            value={form.displayName}
            disabled={disabled}
            onChange={(event) => onChange({ ...form, displayName: event.target.value })}
          />
        </div>
        <div className="space-y-1 text-xs font-medium text-muted-foreground">
          <label htmlFor={`${fieldPrefix}-endpoint`}>{endpointLabel}</label>
          <Input
            id={`${fieldPrefix}-endpoint`}
            value={form.endpointUrl}
            disabled={disabled}
            placeholder={form.kind === "mcp_server" ? "https://mcp.example.com" : "https://api.example.com"}
            onChange={(event) => onChange({ ...form, endpointUrl: event.target.value })}
          />
        </div>
        <div className="space-y-1 text-xs font-medium text-muted-foreground">
          <label htmlFor={`${fieldPrefix}-auth-header`}>Auth header</label>
          <Input
            id={`${fieldPrefix}-auth-header`}
            value={form.authHeaderName}
            disabled={disabled}
            onChange={(event) => onChange({ ...form, authHeaderName: event.target.value })}
          />
        </div>
        <div className="space-y-1 text-xs font-medium text-muted-foreground">
          <label htmlFor={`${fieldPrefix}-credential`}>Credential value</label>
          <Input
            id={`${fieldPrefix}-credential`}
            type="password"
            value={form.credentialValue}
            disabled={disabled}
            placeholder="Optional token or API key"
            onChange={(event) => onChange({ ...form, credentialValue: event.target.value })}
          />
        </div>
        <div className="space-y-1 text-xs font-medium text-muted-foreground">
          <label htmlFor={`${fieldPrefix}-tool-name`}>Tool name</label>
          <Input
            id={`${fieldPrefix}-tool-name`}
            value={form.toolName}
            disabled={disabled}
            onChange={(event) => onChange({ ...form, toolName: event.target.value })}
          />
        </div>
        <div className="space-y-1 text-xs font-medium text-muted-foreground">
          <label htmlFor={`${fieldPrefix}-tool-description`}>Tool description</label>
          <Input
            id={`${fieldPrefix}-tool-description`}
            value={form.toolDescription}
            disabled={disabled}
            onChange={(event) => onChange({ ...form, toolDescription: event.target.value })}
          />
        </div>
        <div className="space-y-1 text-xs font-medium text-muted-foreground">
          <label htmlFor={`${fieldPrefix}-description`}>Notes</label>
          <Textarea
            id={`${fieldPrefix}-description`}
            value={form.description}
            disabled={disabled}
            rows={2}
            onChange={(event) => onChange({ ...form, description: event.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={!canSubmit}
          aria-label={`Connect ${customIntegrationKindLabel(form.kind)}`}
        >
          {disabled ? "Connecting" : "Connect"}
        </Button>
      </div>
    </div>
  );
}

interface CustomIntegrationRowProps {
  integration: CustomIntegrationSummary;
  disabled: boolean;
  onDisconnect: () => void;
}

function CustomIntegrationRow({ integration, disabled, onDisconnect }: CustomIntegrationRowProps) {
  const Icon = integration.kind === "mcp_server" ? PlugZap : Braces;
  return (
    <div className="grid gap-3 rounded-md border border-border bg-background/40 p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{integration.displayName}</p>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              {customIntegrationKindLabel(integration.kind)}
            </span>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              {customIntegrationScopeLabel(integration.scope)}
            </span>
            <span className={cn(
              "rounded-md border px-1.5 py-0.5 text-xs",
              integration.binding?.status === "active" && integration.status === "active"
                ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-border bg-muted text-muted-foreground",
            )}>
              {integration.binding?.status === "active" && integration.status === "active" ? "Connected" : "Disconnected"}
            </span>
          </div>
          <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <IntegrationMeta label="Credentials" value={integration.hasCredentialSecret ? "Credential stored" : "No credential"} />
            <IntegrationMeta label="Updated" value={formatDateTime(integration.updatedAt)} />
          </dl>
        </div>
      </div>
      <IntegrationActionButton
        variant="outline"
        size="sm"
        onClick={onDisconnect}
        disabled={disabled || integration.binding?.status !== "active"}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Disconnect
      </IntegrationActionButton>
    </div>
  );
}

interface FeishuSetupPromptProps {
  suggestedBotName: string;
  providerRegion: AgentIntegrationProviderRegion;
  onProviderRegionChange: (value: AgentIntegrationProviderRegion) => void;
  disabled: boolean;
  setupSession: AgentIntegrationSetupSession | null;
  existingIntegration: AgentIntegrationSummary | null;
}

function FeishuSetupPrompt({
  suggestedBotName,
  providerRegion,
  onProviderRegionChange,
  disabled,
  setupSession,
  existingIntegration,
}: FeishuSetupPromptProps) {
  const providerName = setupProviderName(providerRegion);
  const isReconnect = existingIntegration && existingIntegration.status !== "active";

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-sm text-muted-foreground">
        {isReconnect ? "Reconnect" : "Create"} a {providerName} bot named{" "}
        <span className="font-medium text-foreground">{suggestedBotName}</span>. Connect opens {providerName} with the
        bot name prefilled; after you confirm, Rudder stores the app credential and starts the chat connection.
      </p>
      <FeishuQuickCommandSetupNote providerName={providerName} />
      <div
        className="inline-flex rounded-[calc(var(--control-radius)+2px)] border border-border bg-muted/30 p-0.5"
        role="group"
        aria-label="Feishu or Lark region"
      >
        <button
          type="button"
          aria-pressed={providerRegion === "feishu_cn"}
          className={cn(
            "h-7 rounded-[var(--control-radius)] px-2.5 text-xs font-medium transition-colors",
            providerRegion === "feishu_cn"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          disabled={disabled}
          onClick={() => onProviderRegionChange("feishu_cn")}
        >
          Feishu CN
        </button>
        <button
          type="button"
          aria-pressed={providerRegion === "lark_global"}
          className={cn(
            "h-7 rounded-[var(--control-radius)] px-2.5 text-xs font-medium transition-colors",
            providerRegion === "lark_global"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          disabled={disabled}
          onClick={() => onProviderRegionChange("lark_global")}
        >
          Lark Global
        </button>
      </div>
      {setupSession && setupSession.status !== "completed" ? (
        <div className="rounded-md border border-border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {setupSession.status === "waiting_for_authorization"
                ? "Waiting for Feishu authorization"
                : setupSession.status === "expired"
                  ? "Setup expired"
                  : "Setup failed"}
            </span>
            {setupSession.status === "waiting_for_authorization" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            <a
              className="font-medium text-foreground underline-offset-2 hover:underline"
              href={setupSession.setupUrl}
              target="_blank"
              rel="noreferrer"
            >
              Finish setup
            </a>
          </div>
          {setupSession.statusDetail ? <p className="mt-1">{setupSession.statusDetail}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function FeishuQuickCommandSetupNote({ providerName }: { providerName: string }) {
  return (
    <div className="max-w-2xl rounded-md border border-border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
      <div className="font-medium text-foreground">Quick Commands</div>
      <p className="mt-1">
        Rudder requests {providerName} bot menu and Slash Command permissions, and handles /new and /stop messages from
        {providerName}. Automatic creation of the {providerName} Quick Command menu is not enabled until a supported
        app-level menu configuration API is available.
      </p>
    </div>
  );
}

function IntegrationMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium text-foreground" title={value}>{value}</dd>
    </div>
  );
}

function IntegrationMetadata({
  integration,
  settingsPending = false,
  onDailySessionNotifyChange,
}: {
  integration: AgentIntegrationSummary;
  settingsPending?: boolean;
  onDailySessionNotifyChange?: (notifyFeishu: boolean) => void;
}) {
  const feishuSettings = integration.settings.feishu ?? {
    dailySessionRolloverEnabled: true,
    dailySessionRolloverHours: 24,
    dailySessionRolloverNotifyFeishu: true,
  };
  return (
    <div className="space-y-3">
      <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
        <IntegrationMeta label="Provider" value={providerLabel(integration.provider)} />
        <IntegrationMeta label="Region" value={regionLabel(integration.providerRegion)} />
        <IntegrationMeta label="App ID" value={integration.externalAppId} />
        <IntegrationMeta label="Bot" value={integration.externalBotOpenId ?? "Any bot"} />
        <IntegrationMeta label="Installed" value={formatDateTime(integration.installedAt)} />
        <IntegrationMeta
          label="Credentials"
          value={integration.hasCredentialSecret ? "Credential stored" : "Missing credential"}
        />
      </dl>
      {integration.provider === "feishu" && onDailySessionNotifyChange ? (
        <div className="rounded-md border border-border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
          <label className="flex items-start gap-2">
            <Checkbox
              className="mt-0.5"
              checked={feishuSettings.dailySessionRolloverNotifyFeishu}
              disabled={settingsPending}
              onCheckedChange={(checked) => onDailySessionNotifyChange(checked === true)}
            />
            <span>
              <span className="block font-medium text-foreground">Notify Feishu when a daily session starts</span>
              <span className="mt-1 block">
                Send "New daily session started." when Rudder opens the next 24-hour Feishu session.
              </span>
            </span>
          </label>
        </div>
      ) : null}
      <FeishuQuickCommandSetupNote providerName={setupProviderName(integration.providerRegion)} />
    </div>
  );
}

function IntegrationRowSkeleton() {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-8 w-full" />
      ))}
    </div>
  );
}
