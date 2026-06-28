import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type {
  AgentDetail,
  AgentIntegrationProviderRegion,
  AgentIntegrationSetupSession,
  AgentIntegrationSummary,
  CreateCustomIntegration,
  CustomIntegrationKind,
  CustomIntegrationScope,
  CustomIntegrationSummary,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Braces,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderOpen,
  Github,
  Inbox,
  Loader2,
  MessageSquareText,
  PlugZap,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { agentsApi } from "../api/agents";
import { FeishuLogoIcon } from "../components/FeishuLogoIcon";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime } from "../lib/utils";

type IntegrationState = "not_configured" | "active" | "revoked" | "error";

type UpcomingIntegrationId =
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "notion"
  | "feishu_workspace"
  | "github"
  | "linear";

interface UpcomingIntegrationDefinition {
  id: UpcomingIntegrationId;
  name: string;
  description: string;
  connectionScope: "Personal" | "Workspace" | "Developer";
  actionLabel: string;
  Icon: LucideIcon | typeof FeishuLogoIcon;
}

const UPCOMING_INTEGRATIONS: UpcomingIntegrationDefinition[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Read, search, draft, and send email from agent work.",
    connectionScope: "Personal",
    actionLabel: "Set up",
    Icon: Inbox,
  },
  {
    id: "google_calendar",
    name: "Google Calendar",
    description: "View and edit calendar events for scheduling work.",
    connectionScope: "Personal",
    actionLabel: "Set up",
    Icon: CalendarDays,
  },
  {
    id: "google_drive",
    name: "Google Drive",
    description: "Browse Drive files and attach workspace context.",
    connectionScope: "Workspace",
    actionLabel: "Set up",
    Icon: FolderOpen,
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search pages, databases, and operating notes.",
    connectionScope: "Workspace",
    actionLabel: "Set up",
    Icon: FileText,
  },
  {
    id: "feishu_workspace",
    name: "Feishu Workspace",
    description: "Access Feishu docs, messages, and workspace data.",
    connectionScope: "Workspace",
    actionLabel: "Set up",
    Icon: FeishuLogoIcon,
  },
  {
    id: "github",
    name: "GitHub",
    description: "Clone and inspect repositories during agent runs.",
    connectionScope: "Developer",
    actionLabel: "Manage",
    Icon: Github,
  },
  {
    id: "linear",
    name: "Linear",
    description: "Link delivery issues and sync engineering work state.",
    connectionScope: "Developer",
    actionLabel: "Set up",
    Icon: MessageSquareText,
  },
];

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
  const [providerRegion, setProviderRegion] = useState<AgentIntegrationProviderRegion>("feishu_cn");
  const [setupSession, setSetupSession] = useState<AgentIntegrationSetupSession | null>(null);
  const [customForm, setCustomForm] = useState<CustomIntegrationFormState | null>(null);
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
  const integrations = integrationsQuery.data ?? [];
  const customIntegrations = customIntegrationsQuery.data ?? [];
  const feishuIntegration = integrations.find((integration) => integration.provider === "feishu") ?? null;
  const state = getFeishuIntegrationState(feishuIntegration);
  const stateCopy = integrationStateCopy(state);
  const availableCount = 3 + UPCOMING_INTEGRATIONS.length;
  const configuredCount = integrations.filter((integration) => integration.status === "active").length
    + customIntegrations.filter((integration) => integration.status === "active" && integration.binding?.status === "active").length;
  const isActive = state === "active";
  const shouldShowSetupPrompt = !feishuIntegration || state !== "active";
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

  return (
    <div className="max-w-5xl space-y-4">
      <div className="rounded-lg border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">Integrations</h2>
            <p className="text-sm text-muted-foreground">Connect the external tools this agent can use during work loops.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
              {configuredCount} of {availableCount} connected
            </span>
            <span
              className={cn(
                "inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
                stateCopy.tone,
              )}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Feishu / Lark {stateCopy.label}
            </span>
          </div>
        </div>

        <div className="divide-y divide-border">
          <div className="space-y-3 px-4 py-4">
            <div className="grid gap-3 lg:grid-cols-2">
              <CustomIntegrationSetupCard
                kind="custom_api"
                active={customForm?.kind === "custom_api"}
                onConfigure={() => setCustomForm(defaultCustomIntegrationForm("custom_api"))}
              />
              <CustomIntegrationSetupCard
                kind="mcp_server"
                active={customForm?.kind === "mcp_server"}
                onConfigure={() => setCustomForm(defaultCustomIntegrationForm("mcp_server"))}
              />
            </div>
            {customForm ? (
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
            ) : null}
            {customIntegrationsQuery.isLoading ? (
              <IntegrationRowSkeleton />
            ) : customIntegrations.length > 0 ? (
              <div className="space-y-2">
                {customIntegrations.map((integration) => (
                  <CustomIntegrationRow
                    key={integration.id}
                    integration={integration}
                    disabled={revokeCustomIntegration.isPending}
                    onDisconnect={() => revokeCustomIntegration.mutate(integration.id)}
                  />
                ))}
              </div>
            ) : null}
          </div>
          <div className="grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                <FeishuLogoIcon className="h-5 w-5" />
              </div>
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">Feishu / Lark</p>
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                    Long connection
                  </span>
                </div>
                {integrationsQuery.isLoading ? (
                  <IntegrationRowSkeleton />
                ) : shouldShowSetupPrompt ? (
                  <FeishuSetupPrompt
                    suggestedBotName={suggestedFeishuBotName(agent.name)}
                    providerRegion={providerRegion}
                    onProviderRegionChange={setProviderRegion}
                    disabled={openSetup.isPending}
                    setupSession={setupSession}
                    existingIntegration={feishuIntegration}
                  />
                ) : feishuIntegration ? (
                  <IntegrationMetadata integration={feishuIntegration} />
                ) : null}
                {feishuIntegration && shouldShowSetupPrompt ? (
                  <div className="pt-1">
                    <IntegrationMetadata integration={feishuIntegration} />
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              {feishuIntegration?.manageUrl ? (
                <Button variant="outline" size="sm" asChild>
                  <a href={feishuIntegration.manageUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Manage
                  </a>
                </Button>
              ) : null}
              {isActive && feishuIntegration ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => revokeIntegration.mutate(feishuIntegration.id)}
                  disabled={revokeIntegration.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {revokeIntegration.isPending ? "Disconnecting" : "Disconnect"}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => openSetup.mutate()} disabled={openSetup.isPending}>
                  {openSetup.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                  {openSetup.isPending ? "Opening" : "Connect"}
                </Button>
              )}
            </div>
          </div>
          <div className="grid gap-3 px-4 py-4 lg:grid-cols-2">
            {UPCOMING_INTEGRATIONS.map((integration) => (
              <UpcomingIntegrationCard key={integration.id} integration={integration} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

interface UpcomingIntegrationCardProps {
  integration: UpcomingIntegrationDefinition;
}

function UpcomingIntegrationCard({ integration }: UpcomingIntegrationCardProps) {
  const { Icon } = integration;

  return (
    <div className="grid gap-3 rounded-md border border-border bg-background/40 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{integration.name}</p>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              {integration.connectionScope}
            </span>
            <span className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground">
              Coming soon
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{integration.description}</p>
        </div>
      </div>
      <Button variant="outline" size="sm" disabled aria-label={`${integration.name} setup coming soon`}>
        {integration.actionLabel}
      </Button>
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
      "grid gap-3 rounded-md border bg-background/40 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
      active ? "border-primary/45 bg-primary/5" : "border-border",
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
      <Button variant="outline" size="sm" onClick={onConfigure}>
        <PlugZap className="h-3.5 w-3.5" />
        Configure
      </Button>
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
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">Connect {customIntegrationKindLabel(form.kind)}</p>
          <p className="text-xs text-muted-foreground">Credentials are stored as organization secrets and never shown again.</p>
        </div>
        <div className="inline-flex rounded-md border border-border bg-background p-0.5">
          {(["agent", "organization"] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              className={cn(
                "h-7 rounded px-2.5 text-xs font-medium transition-colors",
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
      <div className="grid gap-3 md:grid-cols-2">
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
        <div className="space-y-1 text-xs font-medium text-muted-foreground md:col-span-2">
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
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={!canSubmit}
          aria-label={`Connect ${customIntegrationKindLabel(form.kind)}`}
        >
          {disabled ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          Connect
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
  const enabledTools = integration.tools.filter((tool) => tool.enabled);
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
          <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <IntegrationMeta label="Tools" value={enabledTools.length > 0 ? enabledTools.map((tool) => tool.rudderToolName).join(", ") : "No tools enabled"} />
            <IntegrationMeta label="Credentials" value={integration.hasCredentialSecret ? "Credential stored" : "No credential"} />
            <IntegrationMeta label="Updated" value={formatDateTime(integration.updatedAt)} />
          </dl>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onDisconnect}
        disabled={disabled || integration.binding?.status !== "active"}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Disconnect
      </Button>
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
      <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
        <button
          type="button"
          className={cn(
            "h-7 rounded px-2.5 text-xs font-medium transition-colors",
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
          className={cn(
            "h-7 rounded px-2.5 text-xs font-medium transition-colors",
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

function IntegrationMetadata({ integration }: { integration: AgentIntegrationSummary }) {
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
