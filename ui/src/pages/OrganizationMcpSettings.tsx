import { Button } from "@/components/ui/button";
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
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type {
  Agent,
  CreateMcpConnection,
  McpConnectionAccessMode,
  McpConnectionProvider,
  McpConnectionScope,
  McpConnectionSummary,
  McpConnectionTransport,
  McpProviderAvailability,
  McpProviderCatalogEntry,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Loader2,
  Plus,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentsApi } from "../api/agents";
import { managedMcpApi } from "../api/managedMcp";
import { McpProviderIcon } from "../components/McpProviderIcon";
import { SettingsGroup, SettingsSection } from "../components/settings/SettingsScaffold";
import { useToast } from "../context/ToastContext";
import { type DesktopShellApi, readDesktopShell } from "../lib/desktop-shell";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

type KeyValueRow = { id: string; key: string; value: string };
type ValueRow = { id: string; value: string };
type ConnectionTarget = { scope: McpConnectionScope; ownerAgentId: string | null };

export interface CustomMcpFormState {
  scope: McpConnectionScope;
  ownerAgentId: string | null;
  displayName: string;
  transport: Extract<McpConnectionTransport, "stdio" | "streamable_http">;
  command: string;
  arguments: ValueRow[];
  cwd: string;
  environment: KeyValueRow[];
  forwardedEnvText: string;
  url: string;
  bearerTokenEnvVar: string;
  headers: KeyValueRow[];
  headersFromEnvironment: KeyValueRow[];
  accessMode: McpConnectionAccessMode;
  enabled: boolean;
  required: boolean;
  startupTimeoutSeconds: string;
  toolTimeoutSeconds: string;
}

function row(): KeyValueRow {
  return { id: crypto.randomUUID(), key: "", value: "" };
}

function valueRow(): ValueRow {
  return { id: crypto.randomUUID(), value: "" };
}

export function defaultCustomMcpForm(): CustomMcpFormState {
  return {
    scope: "organization",
    ownerAgentId: null,
    displayName: "",
    transport: "streamable_http",
    command: "",
    arguments: [valueRow()],
    cwd: "",
    environment: [row()],
    forwardedEnvText: "",
    url: "",
    bearerTokenEnvVar: "",
    headers: [row()],
    headersFromEnvironment: [row()],
    accessMode: "provider_default",
    enabled: true,
    required: false,
    startupTimeoutSeconds: "10",
    toolTimeoutSeconds: "60",
  };
}

function compactRows(rows: KeyValueRow[]): Array<[string, string]> {
  return rows
    .map(({ key, value }) => [key.trim(), value] as [string, string])
    .filter(([key]) => key.length > 0);
}

function splitList(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function connectionSlug(displayName: string) {
  const base = displayName.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "custom-mcp";
  return `${base}-${Date.now().toString(36)}`.slice(0, 80).replace(/[-_]+$/g, "");
}

export function buildCustomMcpPayload(form: CustomMcpFormState): CreateMcpConnection {
  const displayName = form.displayName.trim();
  if (!displayName) throw new Error("Name is required");
  const startupTimeoutMs = Number(form.startupTimeoutSeconds) * 1_000;
  const toolTimeoutMs = Number(form.toolTimeoutSeconds) * 1_000;
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 100) {
    throw new Error("Startup timeout must be at least 0.1 seconds");
  }
  if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 100) {
    throw new Error("Tool timeout must be at least 0.1 seconds");
  }

  const common = {
    name: connectionSlug(displayName),
    displayName,
    provider: "custom" as const,
    scope: form.scope,
    ownerAgentId: form.scope === "agent" ? form.ownerAgentId : null,
    accessMode: form.accessMode,
    enabled: form.enabled,
    required: form.required,
    startupTimeoutMs,
    toolTimeoutMs,
  };
  if (form.transport === "stdio") {
    const command = form.command.trim();
    if (!command) throw new Error("Command is required");
    const environment = compactRows(form.environment);
    return {
      ...common,
      transport: "stdio",
      safeConfig: {
        command,
        args: form.arguments.map(({ value }) => value).filter((value) => value.length > 0),
        ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
        forwardedEnv: splitList(form.forwardedEnvText),
        secretEnvNames: environment.map(([name]) => name),
      },
      ...(environment.length > 0
        ? { secrets: { env: Object.fromEntries(environment) } }
        : {}),
    };
  }

  const url = form.url.trim();
  if (!url) throw new Error("URL is required");
  const headers = compactRows(form.headers);
  const headersFromEnv = compactRows(form.headersFromEnvironment);
  const bearerTokenEnvVar = form.bearerTokenEnvVar.trim();
  const authorizationSources = [
    bearerTokenEnvVar.length > 0,
    headers.some(([name]) => name.toLowerCase() === "authorization"),
    headersFromEnv.some(([name]) => name.toLowerCase() === "authorization"),
  ].filter(Boolean).length;
  if (authorizationSources > 1) {
    throw new Error("Configure only one Authorization or Bearer source");
  }

  return {
    ...common,
    transport: "streamable_http",
    safeConfig: {
      url,
      ...(headersFromEnv.length > 0
        ? { headersFromEnv: Object.fromEntries(headersFromEnv) }
        : {}),
      ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
      ...(headers.length > 0
        ? { secretHeaderNames: headers.map(([name]) => name) }
        : {}),
    },
    ...(headers.length > 0
      ? { secrets: { headers: Object.fromEntries(headers) } }
      : {}),
  };
}

function providerDescription(provider: McpProviderCatalogEntry): string {
  if (provider.id === "supabase") {
    return "Connect account access. Agents choose the project for each task. Starts with read & write.";
  }
  const permission = provider.defaultAccessMode === "read_only"
    ? " Starts read-only."
    : provider.accessModes.includes("read_only")
      ? " Read-only access is also available."
      : "";
  return `Connect ${provider.scopeLabel.toLowerCase()} access through the official OAuth flow.${permission}`;
}

function statusCopy(status: McpConnectionSummary["status"]) {
  switch (status) {
    case "active":
      return ["Connected", "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"];
    case "authorizing":
      return ["Authorizing", "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"];
    case "selecting_scope":
      return ["Connecting", "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300"];
    case "needs_reauth":
      return ["Reconnect required", "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"];
    case "error":
      return ["Needs attention", "border-destructive/25 bg-destructive/10 text-destructive"];
    case "revoked":
      return ["Disconnected", "border-border bg-muted text-muted-foreground"];
    case "disabled":
      return ["Disabled", "border-border bg-muted text-muted-foreground"];
    case "draft":
      return ["Draft", "border-border bg-muted text-muted-foreground"];
  }
}

export interface AuthorizationLauncher {
  navigate(target: string): Promise<void>;
  close(): void;
}

export function canReconnectManagedMcp(status: McpConnectionSummary["status"]): boolean {
  return [
    "draft",
    "authorizing",
    "needs_reauth",
    "revoked",
    "error",
    "disabled",
  ].includes(status);
}

export function officialProviderAction(
  state: McpProviderAvailability["organization"]["state"],
  scopeMode: McpProviderAvailability["organization"]["scopeMode"],
) {
  if (scopeMode === "legacy_project") return "Upgrade to account access";
  if (state === "connected") return "Manage";
  if (state === "connecting") return "Continue setup";
  if (state === "needs_attention") return "Reconnect";
  return "Connect";
}

export function officialAccessChangeRequiresAuthorization(
  provider: McpConnectionProvider,
  currentAccess: McpConnectionAccessMode,
  nextAccess: McpConnectionAccessMode,
) {
  return currentAccess !== nextAccess
    && (provider === "supabase" || provider === "linear")
    && (nextAccess === "read_only" || nextAccess === "read_write");
}

export function reserveAuthorizationLauncher(input: {
  desktopShell?: Pick<DesktopShellApi, "openExternal" | "forceOpenExternal"> | null;
  openWindow?: typeof window.open;
} = {}): AuthorizationLauncher {
  const desktopShell = input.desktopShell === undefined
    ? readDesktopShell()
    : input.desktopShell;
  if (desktopShell) {
    return {
      navigate: async (target) => {
        if (desktopShell.forceOpenExternal) {
          await desktopShell.forceOpenExternal(target);
          return;
        }
        await desktopShell.openExternal(target);
      },
      close: () => undefined,
    };
  }

  const opened = (input.openWindow ?? window.open)("about:blank", "_blank");
  if (!opened) throw new Error("Allow pop-ups for Rudder, then try again");
  try {
    opened.opener = null;
  } catch {
    // The reserved same-origin window remains usable even when opener mutation
    // is unavailable in a constrained browser shell.
  }
  return {
    navigate: async (target) => {
      opened.location.replace(target);
    },
    close: () => opened.close(),
  };
}

export function OrganizationMcpSettings({ orgId }: { orgId: string }) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [customForm, setCustomForm] = useState<CustomMcpFormState | null>(null);
  const [view, setView] = useState<"discover" | "manage">("discover");
  const [managedConnection, setManagedConnection] = useState<McpConnectionSummary | null>(null);
  const [managedScopeMode, setManagedScopeMode] = useState<McpProviderAvailability["organization"]["scopeMode"]>(null);
  const [pendingProvider, setPendingProvider] = useState<Exclude<McpConnectionProvider, "custom"> | null>(null);
  const [connectionTarget, setConnectionTarget] = useState<ConnectionTarget>({
    scope: "organization",
    ownerAgentId: null,
  });
  const managedConnectionTriggerRef = useRef<HTMLElement | null>(null);
  const customConnectionCreated = useRef(false);
  const catalogQuery = useQuery({
    queryKey: queryKeys.organizations.mcpProviders(orgId),
    queryFn: () => managedMcpApi.catalog(orgId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(orgId),
    queryFn: () => agentsApi.list(orgId),
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.organizations.mcpConnections(orgId),
    queryFn: () => managedMcpApi.listConnections(orgId),
    refetchInterval: (query) => {
      const rows = query.state.data ?? [];
      return rows.some((connection) =>
        connection.status === "authorizing" || connection.status === "selecting_scope")
        ? 2_000
        : false;
    },
  });
  const providerStatusQuery = useQuery({
    queryKey: queryKeys.organizations.mcpProviderStatus(orgId),
    queryFn: () => managedMcpApi.listProviderStatus(orgId),
    refetchInterval: (query) => (query.state.data ?? []).some(
      (status) => status.organization.state === "connecting",
    ) ? 2_000 : false,
  });
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.mcpConnections(orgId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.mcpProviderStatus(orgId),
      }),
      queryClient.invalidateQueries({
        queryKey: ["agents", "mcp-provider-status"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["agents", "mcp-connections"],
      }),
    ]);
  };
  const createOfficial = useMutation({
    mutationFn: async (input: {
      provider: Exclude<McpConnectionProvider, "custom">;
      accessMode?: McpConnectionAccessMode;
      target: ConnectionTarget;
      authorizationLauncher: AuthorizationLauncher;
    }) => {
      const { provider, authorizationLauncher } = input;
      try {
        const connection = await managedMcpApi.ensureOfficialConnection(
          orgId,
          provider,
          {
            ...input.target,
            accessMode: input.accessMode,
          },
        );
        const started = await managedMcpApi.startOAuth(orgId, connection.id);
        await authorizationLauncher.navigate(started.authorizationUrl);
        return connection;
      } catch (error) {
        authorizationLauncher.close();
        throw error;
      }
    },
    onSuccess: async () => {
      setPendingProvider(null);
      await invalidate();
      pushToast({
        title: "Authorization opened",
        body: "Finish provider authorization in the browser. Rudder will update this page automatically.",
        tone: "info",
      });
    },
    onError: async (error) => {
      await invalidate();
      pushToast({
        title: "Could not start authorization",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const createCustom = useMutation({
    mutationFn: async (form: CustomMcpFormState) => {
      customConnectionCreated.current = false;
      const connection = await managedMcpApi.createConnection(
        orgId,
        buildCustomMcpPayload(form),
      );
      customConnectionCreated.current = true;
      if (!form.enabled) return connection;
      await managedMcpApi.refreshTools(orgId, connection.id);
      return managedMcpApi.getConnection(orgId, connection.id);
    },
    onSuccess: async (_connection, form) => {
      setCustomForm(null);
      await invalidate();
      pushToast({
        title: form.enabled ? "Custom MCP connected" : "Custom MCP saved disabled",
        tone: "success",
      });
    },
    onError: async (error) => {
      const wasSaved = customConnectionCreated.current;
      if (wasSaved) setCustomForm(null);
      await invalidate();
      pushToast({
        title: wasSaved
          ? "Custom MCP saved, but discovery failed"
          : "Could not connect custom MCP",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const curated = useMemo(
    () => (catalogQuery.data ?? []).filter(
      (entry): entry is McpProviderCatalogEntry & {
        id: Exclude<McpConnectionProvider, "custom">;
      } => entry.id !== "custom",
    ),
    [catalogQuery.data],
  );
  const connections = connectionsQuery.data ?? [];
  const providerStatuses = providerStatusQuery.data ?? [];
  const canonicalOfficialConnectionIds = new Set(
    providerStatuses
      .map((status) => status.organization.connectionId)
      .filter((id): id is string => Boolean(id)),
  );
  const visibleConnections = connections.filter((connection) => (
    (
      connection.provider === "custom"
      || connection.scope === "agent"
      || canonicalOfficialConnectionIds.has(connection.id)
    )
    && connection.status !== "revoked"
  ));
  const eligibleAgents = (agentsQuery.data ?? []).filter((agent) => agent.status !== "terminated");
  const managedProviderStatus = providerStatusQuery.data?.find(
    (status) => status.organization.connectionId === managedConnection?.id,
  );
  const beginOfficialAuthorization = (
    provider: Exclude<McpConnectionProvider, "custom">,
    target: ConnectionTarget,
    accessMode?: McpConnectionAccessMode,
  ) => {
    try {
      createOfficial.mutate({
        provider,
        accessMode,
        target,
        authorizationLauncher: reserveAuthorizationLauncher(),
      });
    } catch (error) {
      pushToast({
        title: "Could not open authorization",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    }
  };
  const openConnectedProvider = (status: McpProviderAvailability) => {
    managedConnectionTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const connection = connections.find(
      (candidate) => candidate.id === status.organization.connectionId,
    );
    if (connection) {
      setManagedConnection(connection);
      setManagedScopeMode(status.organization.scopeMode);
      return;
    }
    pushToast({
      title: "Connection details are still loading",
      body: "Try again in a moment.",
      tone: "info",
    });
  };
  const closeManagedConnection = () => {
    setManagedConnection(null);
    setManagedScopeMode(null);
    requestAnimationFrame(() => managedConnectionTriggerRef.current?.focus());
  };
  const resumeOfficialAuthorization = (
    provider: Exclude<McpConnectionProvider, "custom">,
    connectionId: string | null,
  ) => {
    if (!connectionId) {
      setPendingProvider(provider);
      return;
    }
    let launcher: AuthorizationLauncher;
    try {
      launcher = reserveAuthorizationLauncher();
    } catch (error) {
      pushToast({
        title: "Could not open authorization",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
      return;
    }
    void managedMcpApi.reconnect(orgId, connectionId).then(async (result) => {
      if ("authorizationUrl" in result) await launcher.navigate(result.authorizationUrl);
      await invalidate();
    }).catch(async (error) => {
      launcher.close();
      await invalidate();
      pushToast({
        title: "Could not restart authorization",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    });
  };

  return (
    <Tabs
      value={view}
      onValueChange={(next) => setView(next as "discover" | "manage")}
      className="min-w-0 gap-5"
      data-testid="organization-mcp-settings"
    >
      <TabsList aria-label="MCP integrations">
        <TabsTrigger value="discover" onClick={() => setView("discover")}>Discover</TabsTrigger>
        <TabsTrigger value="manage" onClick={() => setView("manage")}>Manage</TabsTrigger>
      </TabsList>
      <TabsContent value="discover">
        <SettingsSection
          title="Connect an MCP"
          description="Connections belong to this organization. Agent access is managed separately."
        >
          {catalogQuery.isLoading || providerStatusQuery.isLoading ? (
            <div className="grid gap-3 md:grid-cols-2" aria-label="Loading MCP providers">
              {[0, 1, 2, 3].map((item) => (
                <Skeleton key={item} className="h-36 w-full" />
              ))}
            </div>
          ) : catalogQuery.isError || providerStatusQuery.isError ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/25 bg-destructive/5 px-4 py-3">
              <p className="text-sm text-destructive">Could not load MCP providers.</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void catalogQuery.refetch();
                  void providerStatusQuery.refetch();
                }}
              >
                Retry
              </Button>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {curated.map((provider) => {
                const status = providerStatuses.find((item) => item.provider === provider.id);
                const state = status?.organization.state ?? "not_connected";
                const actionLabel = (status?.organization.agentConnectionCount ?? 0) > 0
                  && state === "not_connected"
                  ? "Manage"
                  : officialProviderAction(
                  state,
                  status?.organization.scopeMode ?? null,
                  );
                const actionPending = createOfficial.isPending
                  && createOfficial.variables?.provider === provider.id;
                return (
                  <ProviderCard
                    key={provider.id}
                    testId={`mcp-provider-${provider.id}`}
                    provider={provider.id}
                    title={provider.label}
                    description={providerDescription(provider)}
                    statusLabel={providerStateLabel(state)}
                    actionLabel={actionLabel}
                    disabled={createOfficial.isPending || (state === "connected" && connectionsQuery.isLoading)}
                    loading={actionPending}
                    onAction={() => {
                      if (state === "connected") {
                        if (status) openConnectedProvider(status);
                        return;
                      }
                      if (actionLabel === "Manage") {
                        setView("manage");
                        return;
                      }
                      if (state === "not_connected") {
                        setConnectionTarget({ scope: "organization", ownerAgentId: null });
                        setPendingProvider(provider.id);
                      }
                      else resumeOfficialAuthorization(provider.id, status?.organization.connectionId ?? null);
                    }}
                  />
                );
              })}
              <ProviderCard
                testId="mcp-provider-custom"
                provider="custom"
                title="Custom MCP"
                description="Connect a Codex-compatible STDIO or Streamable HTTP MCP server."
                actionLabel="Configure"
                onAction={() => setCustomForm(defaultCustomMcpForm())}
              />
            </div>
          )}
        </SettingsSection>
      </TabsContent>
      <TabsContent value="manage">
        <SettingsSection
          title="Managed connections"
          description="Credentials remain encrypted and are never exposed to agents."
        >
          <div className="mb-3 flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setView("discover")}
            >
              <Plus className="size-3.5" /> Add connection
            </Button>
          </div>
          <SettingsGroup>
            {connectionsQuery.isLoading || providerStatusQuery.isLoading ? (
              <div className="space-y-2 p-3" aria-label="Loading managed MCP connections">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : connectionsQuery.isError || providerStatusQuery.isError ? (
              <div className="flex items-center justify-between gap-3 px-4 py-5">
                <p className="text-sm text-destructive">Could not load managed MCP connections.</p>
                <Button size="sm" variant="outline" onClick={() => {
                  void connectionsQuery.refetch();
                  void providerStatusQuery.refetch();
                }}>
                  Retry
                </Button>
              </div>
            ) : visibleConnections.length === 0 ? (
              <div className="px-4 py-7 text-center text-sm text-muted-foreground">
                No managed MCP connections yet.
              </div>
            ) : visibleConnections.map((connection) => (
              <CompactConnectionRow
                key={connection.id}
                connection={connection}
                ownerName={connection.ownerAgentId
                  ? eligibleAgents.find((agent) => agent.id === connection.ownerAgentId)?.name ?? "Agent"
                  : null}
                onManage={() => {
                  managedConnectionTriggerRef.current = document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
                  setManagedConnection(connection);
                }}
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      </TabsContent>

      <CustomMcpDialog
        form={customForm}
        agents={eligibleAgents}
        pending={createCustom.isPending}
        onChange={setCustomForm}
        onClose={() => setCustomForm(null)}
        onSubmit={() => {
          if (customForm) createCustom.mutate(customForm);
        }}
      />
      <ConnectionTargetDialog
        provider={pendingProvider}
        target={connectionTarget}
        agents={eligibleAgents}
        pending={createOfficial.isPending}
        connections={connections}
        onTargetChange={setConnectionTarget}
        onClose={() => setPendingProvider(null)}
        onConfirm={() => {
          if (!pendingProvider) return;
          const existing = connections.find((connection) => (
            connection.provider === pendingProvider
            && connection.scope === connectionTarget.scope
            && connection.ownerAgentId === connectionTarget.ownerAgentId
            && connection.status !== "revoked"
          ));
          if (existing) {
            setPendingProvider(null);
            setManagedConnection(existing);
            setManagedScopeMode(null);
            return;
          }
          beginOfficialAuthorization(pendingProvider, connectionTarget);
        }}
      />
      <OrganizationConnectionDialog
        orgId={orgId}
        connection={managedConnection}
        provider={managedConnection
          ? catalogQuery.data?.find((entry) => entry.id === managedConnection.provider)
          : undefined}
        scopeMode={managedProviderStatus?.organization.scopeMode ?? managedScopeMode}
        affectedAgentCount={managedProviderStatus?.organization.affectedAgentCount ?? null}
        historicalGrantConnectionIds={
          managedProviderStatus?.organization.historicalGrantConnectionIds ?? []
        }
        onClose={closeManagedConnection}
        onChanged={async () => {
          setManagedConnection(null);
          setManagedScopeMode(null);
          await invalidate();
        }}
      />
    </Tabs>
  );
}

function providerStateLabel(state: McpProviderAvailability["organization"]["state"]) {
  switch (state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "needs_attention":
      return "Needs attention";
    case "disconnected":
      return "Not connected";
    default:
      return "Not connected";
  }
}

function ProviderCard({
  testId,
  provider,
  title,
  description,
  actionLabel,
  statusLabel,
  secondaryAction,
  disabled,
  loading,
  onAction,
}: {
  testId?: string;
  provider: McpConnectionProvider;
  title: string;
  description: string;
  actionLabel: string;
  statusLabel?: string;
  secondaryAction?: { label: string; onClick: () => void };
  disabled?: boolean;
  loading?: boolean;
  onAction: () => void;
}) {
  return (
    <div
      data-testid={testId}
      className="flex min-h-36 flex-col justify-between gap-3 rounded-md border border-border bg-background/40 p-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        <McpProviderIcon provider={provider} />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {statusLabel ? (
            <p className="text-xs font-medium text-muted-foreground">{statusLabel}</p>
          ) : null}
          <p className="text-[13px] leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {secondaryAction ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={secondaryAction.onClick}
          >
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-busy={loading || undefined}
          onClick={onAction}
        >
          {loading
            ? <Loader2 className="size-3.5 animate-spin" />
            : actionLabel === "Manage"
              ? <Settings2 className="size-3.5" />
              : <Plus className="size-3.5" />}
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

function ConnectionTargetSelect({
  target,
  agents,
  onChange,
}: {
  target: ConnectionTarget;
  agents: Agent[];
  onChange: (target: ConnectionTarget) => void;
}) {
  const value = target.scope === "organization"
    ? "organization"
    : `agent:${target.ownerAgentId ?? ""}`;
  return (
    <select
      aria-label="Enable for"
      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      value={value}
      onChange={(event) => {
        if (event.target.value === "organization") {
          onChange({ scope: "organization", ownerAgentId: null });
          return;
        }
        onChange({
          scope: "agent",
          ownerAgentId: event.target.value.replace(/^agent:/, ""),
        });
      }}
    >
      <option value="organization">Organization</option>
      {agents.map((agent) => (
        <option key={agent.id} value={`agent:${agent.id}`}>
          {agent.name}
        </option>
      ))}
    </select>
  );
}

function ConnectionTargetDialog({
  provider,
  target,
  agents,
  pending,
  connections,
  onTargetChange,
  onClose,
  onConfirm,
}: {
  provider: Exclude<McpConnectionProvider, "custom"> | null;
  target: ConnectionTarget;
  agents: Agent[];
  pending: boolean;
  connections: McpConnectionSummary[];
  onTargetChange: (target: ConnectionTarget) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!provider) return null;
  const name = provider[0]!.toUpperCase() + provider.slice(1);
  const existing = connections.some((connection) => (
    connection.provider === provider
    && connection.scope === target.scope
    && connection.ownerAgentId === target.ownerAgentId
    && connection.status !== "revoked"
  ));
  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !pending) onClose();
    }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <McpProviderIcon provider={provider} />
            <DialogTitle>{name}</DialogTitle>
          </div>
          <DialogDescription>
            Connect an independent {name} credential for the organization or one agent.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-dashed border-border p-4">
          <p className="mb-2 text-sm font-medium text-foreground">Enable for</p>
          <ConnectionTargetSelect target={target} agents={agents} onChange={onTargetChange} />
          <p className="mt-2 text-xs text-muted-foreground">
            The target cannot be changed after connection. Disconnect and reconnect to use a different target.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button disabled={pending} onClick={onConfirm}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {existing ? "Manage" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompactConnectionRow({
  connection,
  ownerName,
  onManage,
}: {
  connection: McpConnectionSummary;
  ownerName: string | null;
  onManage: () => void;
}) {
  const [statusLabel, statusTone] = statusCopy(connection.status);
  return (
    <div
      data-slot="settings-item"
      data-testid={`mcp-connection-${connection.id}`}
      className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="flex min-w-0 items-center gap-3">
        <McpProviderIcon provider={connection.provider} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{connection.displayName}</p>
            <span className={cn("rounded-md border px-1.5 py-0.5 text-xs", statusTone)}>
              {statusLabel}
            </span>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              {connection.scope === "organization" ? "Organization" : ownerName ?? "Agent"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {connection.externalScope ?? (connection.provider === "supabase"
              ? "Account access"
              : "Organization connection")}
            {" · "}
            {connection.accessMode === "read_only"
              ? "Read only"
              : connection.accessMode === "read_write"
                ? "Read & write"
                : "Provider-granted access"}
          </p>
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onManage}>
        Manage
      </Button>
    </div>
  );
}

function OrganizationConnectionDialog({
  orgId,
  connection,
  provider,
  scopeMode,
  affectedAgentCount,
  historicalGrantConnectionIds,
  onClose,
  onChanged,
}: {
  orgId: string;
  connection: McpConnectionSummary | null;
  provider?: McpProviderCatalogEntry;
  scopeMode: McpProviderAvailability["organization"]["scopeMode"];
  affectedAgentCount: number | null;
  historicalGrantConnectionIds: string[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { pushToast } = useToast();
  const [accessMode, setAccessMode] = useState<McpConnectionAccessMode>("provider_default");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmHistoricalDisconnect, setConfirmHistoricalDisconnect] = useState(false);
  useEffect(() => {
    if (connection) setAccessMode(connection.accessMode);
    setConfirmDisconnect(false);
    setConfirmHistoricalDisconnect(false);
  }, [connection]);
  const requiresReauthorization = Boolean(connection && officialAccessChangeRequiresAuthorization(
    connection.provider,
    connection.accessMode,
    accessMode,
  ));
  const saveAccess = useMutation({
    mutationFn: async (authorizationLauncher?: AuthorizationLauncher) => {
      if (!connection) throw new Error("Connection is unavailable");
      try {
        if (requiresReauthorization) {
          if (!authorizationLauncher) throw new Error("Authorization launcher was not reserved");
          if (accessMode !== "read_only" && accessMode !== "read_write") {
            throw new Error("Official provider access mode is invalid");
          }
          const result = await managedMcpApi.reauthorizeAccess(
            orgId,
            connection.id,
            accessMode,
          );
          await authorizationLauncher.navigate(result.authorizationUrl);
          return result;
        }
        return managedMcpApi.updateAccessMode(orgId, connection.id, accessMode);
      } catch (error) {
        authorizationLauncher?.close();
        throw error;
      }
    },
    onSuccess: async () => {
      pushToast({
        title: requiresReauthorization ? "Authorization opened" : "Maximum access updated",
        tone: requiresReauthorization ? "info" : "success",
      });
      await onChanged();
    },
    onError: (error) => pushToast({
      title: "Could not update maximum access",
      body: error instanceof Error ? error.message : undefined,
      tone: "error",
    }),
  });
  const reconnect = useMutation({
    mutationFn: async () => {
      if (!connection) throw new Error("Connection is unavailable");
      if (connection.provider === "custom") {
        return managedMcpApi.reconnect(orgId, connection.id);
      }
      const launcher = reserveAuthorizationLauncher();
      try {
        const result = await managedMcpApi.reconnect(orgId, connection.id);
        if ("authorizationUrl" in result) await launcher.navigate(result.authorizationUrl);
        return result;
      } catch (error) {
        launcher.close();
        throw error;
      }
    },
    onSuccess: async () => {
      pushToast({ title: "Authorization opened", tone: "info" });
      await onChanged();
    },
    onError: (error) => pushToast({
      title: "Could not reconnect",
      body: error instanceof Error ? error.message : undefined,
      tone: "error",
    }),
  });
  const disconnect = useMutation({
    mutationFn: () => {
      if (!connection) throw new Error("Connection is unavailable");
      return managedMcpApi.disconnect(orgId, connection.id);
    },
    onSuccess: async () => {
      pushToast({ title: "Connection disconnected", tone: "success" });
      await onChanged();
    },
    onError: (error) => pushToast({
      title: "Could not disconnect",
      body: error instanceof Error ? error.message : undefined,
      tone: "error",
    }),
  });
  const disconnectHistorical = useMutation({
    mutationFn: async () => {
      for (const connectionId of historicalGrantConnectionIds) {
        await managedMcpApi.disconnect(orgId, connectionId);
      }
    },
    onSuccess: async () => {
      pushToast({ title: "Historical access disconnected", tone: "success" });
      await onChanged();
    },
    onError: (error) => pushToast({
      title: "Could not disconnect historical access",
      body: error instanceof Error ? error.message : undefined,
      tone: "error",
    }),
  });
  const upgradeAccountAccess = useMutation({
    mutationFn: async (authorizationLauncher: AuthorizationLauncher) => {
      if (!connection) throw new Error("Connection is unavailable");
      try {
        const result = await managedMcpApi.upgradeSupabaseAccountAccess(orgId, connection.id);
        await authorizationLauncher.navigate(result.authorizationUrl);
        return result;
      } catch (error) {
        authorizationLauncher.close();
        throw error;
      }
    },
    onSuccess: async () => {
      pushToast({
        title: "Account authorization opened",
        body: "The current project connection stays active until the upgrade succeeds.",
        tone: "info",
      });
      await onChanged();
    },
    onError: (error) => pushToast({
      title: "Could not start account upgrade",
      body: error instanceof Error ? error.message : undefined,
      tone: "error",
    }),
  });
  const pending = saveAccess.isPending
    || reconnect.isPending
    || disconnect.isPending
    || disconnectHistorical.isPending
    || upgradeAccountAccess.isPending;
  const isLegacySupabase = connection?.provider === "supabase" && scopeMode === "legacy_project";
  const [statusLabel] = connection ? statusCopy(connection.status) : ["", ""];

  return (
    <Dialog open={Boolean(connection)} onOpenChange={(open) => {
      if (!open && !pending) onClose();
    }}>
      <DialogContent className="sm:max-w-lg">
        {connection ? (
          <>
            <DialogHeader>
              <DialogTitle>Manage {connection.displayName}</DialogTitle>
              <DialogDescription>
                Connection settings and the maximum access its agents may receive.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-3 rounded-md border border-border p-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Status</dt>
                  <dd className="mt-1 font-medium">{statusLabel}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Scope</dt>
                  <dd className="mt-1 font-medium">
                    {connection.externalScope ?? (connection.provider === "supabase"
                      ? "All authorized projects"
                      : "Organization workspace")}
                  </dd>
                </div>
              </dl>
              {historicalGrantConnectionIds.length > 0 ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                  <p className="text-sm font-medium text-foreground">
                    {historicalGrantConnectionIds.length} historical{" "}
                    {historicalGrantConnectionIds.length === 1 ? "authorization" : "authorizations"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Older duplicate connections are disabled, but their encrypted provider access
                    remains stored until you disconnect it.
                  </p>
                  {confirmHistoricalDisconnect ? (
                    <div className="mt-3 flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => setConfirmHistoricalDisconnect(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => disconnectHistorical.mutate()}
                      >
                        Disconnect historical access
                      </Button>
                    </div>
                  ) : (
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => setConfirmHistoricalDisconnect(true)}
                    >
                      Disconnect historical access
                    </Button>
                  )}
                </div>
              ) : null}
              {isLegacySupabase ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                  <p className="text-sm font-medium text-foreground">Upgrade to account access</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    This expands authorization from one project to all authorized projects.
                    Existing agent access will reset to No access after a successful upgrade.
                  </p>
                  <Button
                    className="mt-3"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      try {
                        upgradeAccountAccess.mutate(reserveAuthorizationLauncher());
                      } catch (error) {
                        pushToast({
                          title: "Could not open authorization",
                          body: error instanceof Error ? error.message : undefined,
                          tone: "error",
                        });
                      }
                    }}
                  >
                    Upgrade to account access
                  </Button>
                </div>
              ) : null}
              {!isLegacySupabase && provider && provider.accessModes.length > 1 ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Maximum access</legend>
                  {provider.accessModes.map((mode) => (
                    <label key={mode} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                      <input
                        type="radio"
                        name={`organization-access-${connection.id}`}
                        value={mode}
                        checked={accessMode === mode}
                        onChange={() => setAccessMode(mode)}
                      />
                      {mode === "read_only"
                        ? "Read only"
                        : mode === "read_write"
                          ? "Read & write"
                          : "Provider-granted access"}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {confirmDisconnect ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <p className="text-sm font-medium text-foreground">
                    {connection.scope === "agent"
                      ? "Disconnect this agent connection?"
                      : "Disconnect this organization connection?"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {connection.scope === "agent"
                      ? "This agent will stop using its dedicated credentials. An available organization connection may take effect instead."
                      : affectedAgentCount === null
                        ? "Agents using it will lose access immediately."
                        : `${affectedAgentCount} ${affectedAgentCount === 1 ? "agent" : "agents"} currently have access and will lose it immediately.`}
                  </p>
                  <div className="mt-3 flex justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirmDisconnect(false)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="destructive" disabled={pending} onClick={() => disconnect.mutate()}>
                      Disconnect
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            <DialogFooter className="sm:justify-between">
              {isLegacySupabase ? <span /> : (
                <Button variant="outline" disabled={pending} onClick={() => reconnect.mutate()}>
                  <ExternalLink className="size-3.5" /> Reconnect
                </Button>
              )}
              <div className="flex justify-end gap-2">
                {!confirmDisconnect ? (
                  <Button variant="ghost" disabled={pending} onClick={() => setConfirmDisconnect(true)}>
                    <Trash2 className="size-3.5" /> Disconnect
                  </Button>
                ) : null}
                {!isLegacySupabase && provider && provider.accessModes.length > 1 ? (
                  <Button
                    disabled={pending || accessMode === connection.accessMode}
                    onClick={() => {
                      if (!requiresReauthorization) {
                        saveAccess.mutate(undefined);
                        return;
                      }
                      try {
                        saveAccess.mutate(reserveAuthorizationLauncher());
                      } catch (error) {
                        pushToast({
                          title: "Could not open authorization",
                          body: error instanceof Error ? error.message : undefined,
                          tone: "error",
                        });
                      }
                    }}
                  >
                    Save
                  </Button>
                ) : null}
              </div>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function KeyValueRows({
  rows,
  keyPlaceholder,
  valuePlaceholder,
  valueType = "text",
  onChange,
}: {
  rows: KeyValueRow[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  valueType?: "text" | "password";
  onChange: (rows: KeyValueRow[]) => void;
}) {
  return (
    <div className="space-y-2">
      {rows.map((item, index) => (
        <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
          <Input
            aria-label={`${keyPlaceholder} ${index + 1}`}
            placeholder={keyPlaceholder}
            value={item.key}
            onChange={(event) => onChange(rows.map((candidate) =>
              candidate.id === item.id ? { ...candidate, key: event.target.value } : candidate))}
          />
          <Input
            aria-label={`${valuePlaceholder} ${index + 1}`}
            type={valueType}
            placeholder={valuePlaceholder}
            value={item.value}
            onChange={(event) => onChange(rows.map((candidate) =>
              candidate.id === item.id ? { ...candidate, value: event.target.value } : candidate))}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Remove row"
            onClick={() => onChange(rows.length === 1 ? [{ ...row() }] : rows.filter((candidate) => candidate.id !== item.id))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={() => onChange([...rows, row()])}>
        <Plus className="size-3.5" /> Add row
      </Button>
    </div>
  );
}

function ValueRows({
  rows,
  placeholder,
  onChange,
}: {
  rows: ValueRow[];
  placeholder: string;
  onChange: (rows: ValueRow[]) => void;
}) {
  return (
    <div className="space-y-2">
      {rows.map((item, index) => (
        <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <Input
            aria-label={`Argument ${index + 1}`}
            placeholder={placeholder}
            value={item.value}
            onChange={(event) => onChange(rows.map((candidate) =>
              candidate.id === item.id ? { ...candidate, value: event.target.value } : candidate))}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Remove argument ${index + 1}`}
            onClick={() => onChange(
              rows.length === 1
                ? [valueRow()]
                : rows.filter((candidate) => candidate.id !== item.id),
            )}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...rows, valueRow()])}
      >
        <Plus className="size-3.5" /> Add argument
      </Button>
    </div>
  );
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1.5 text-sm font-medium text-foreground">
      <span>{label}</span>
      {hint ? <span className="block text-xs font-normal text-muted-foreground">{hint}</span> : null}
      {children}
    </label>
  );
}

function CustomMcpDialog({
  form,
  agents,
  pending,
  onChange,
  onClose,
  onSubmit,
}: {
  form: CustomMcpFormState | null;
  agents: Agent[];
  pending: boolean;
  onChange: (form: CustomMcpFormState | null) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  if (!form) return null;
  const update = <K extends keyof CustomMcpFormState>(key: K, value: CustomMcpFormState[K]) =>
    onChange({ ...form, [key]: value });
  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !pending) onClose();
    }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect a custom MCP</DialogTitle>
          <DialogDescription>
            Values marked as credentials are encrypted and will not be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <FormField
            label="Enable for"
            hint="Organization connections are inherited by eligible agents. Agent connections keep separate credentials."
          >
            <ConnectionTargetSelect
              target={{ scope: form.scope, ownerAgentId: form.ownerAgentId }}
              agents={agents}
              onChange={(target) => onChange({ ...form, ...target })}
            />
          </FormField>
          <FormField label="Name">
            <Input
              autoFocus
              placeholder="MCP server name"
              value={form.displayName}
              onChange={(event) => update("displayName", event.target.value)}
            />
          </FormField>
          <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
            <p className="text-sm font-medium">Type</p>
            <div className="flex gap-1 rounded-md bg-muted p-1">
              {(["stdio", "streamable_http"] as const).map((transport) => (
                <Button
                  key={transport}
                  type="button"
                  size="sm"
                  variant={form.transport === transport ? "secondary" : "ghost"}
                  onClick={() => update("transport", transport)}
                >
                  {transport === "stdio" ? "STDIO" : "Streamable HTTP"}
                </Button>
              ))}
            </div>
          </div>
          {form.transport === "stdio" ? (
            <>
              <FormField label="Command to launch">
                <Input
                  placeholder="npx"
                  value={form.command}
                  onChange={(event) => update("command", event.target.value)}
                />
              </FormField>
              <FormField label="Arguments" hint="Each row is one exact argv entry. No shell is used.">
                <ValueRows
                  rows={form.arguments}
                  placeholder="-y"
                  onChange={(arguments_) => update("arguments", arguments_)}
                />
              </FormField>
              <FormField label="Environment variables" hint="Values are encrypted and never echoed after save.">
                <KeyValueRows
                  rows={form.environment}
                  keyPlaceholder="Variable"
                  valuePlaceholder="Secret value"
                  valueType="password"
                  onChange={(rows) => update("environment", rows)}
                />
              </FormField>
              <FormField label="Environment-variable passthrough">
                <Input
                  placeholder="PATH, NODE_EXTRA_CA_CERTS"
                  value={form.forwardedEnvText}
                  onChange={(event) => update("forwardedEnvText", event.target.value)}
                />
              </FormField>
              <FormField label="Working directory">
                <Input
                  placeholder="/absolute/allowed/path"
                  value={form.cwd}
                  onChange={(event) => update("cwd", event.target.value)}
                />
              </FormField>
            </>
          ) : (
            <>
              <FormField label="URL">
                <Input
                  placeholder="https://mcp.example.com/mcp"
                  value={form.url}
                  onChange={(event) => update("url", event.target.value)}
                />
              </FormField>
              <FormField label="Bearer token env var">
                <Input
                  placeholder="MCP_BEARER_TOKEN"
                  value={form.bearerTokenEnvVar}
                  onChange={(event) => update("bearerTokenEnvVar", event.target.value)}
                />
              </FormField>
              <FormField label="Headers" hint="All literal header values are encrypted and never shown again.">
                <KeyValueRows
                  rows={form.headers}
                  keyPlaceholder="Static header"
                  valuePlaceholder="Value"
                  valueType="password"
                  onChange={(rows) => update("headers", rows)}
                />
              </FormField>
              <FormField label="Headers from environment variables">
                <KeyValueRows
                  rows={form.headersFromEnvironment}
                  keyPlaceholder="Header from environment"
                  valuePlaceholder="Environment variable"
                  onChange={(rows) => update("headersFromEnvironment", rows)}
                />
              </FormField>
            </>
          )}
          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="text-sm font-medium">Advanced</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Startup timeout (seconds)">
                <Input
                  inputMode="decimal"
                  value={form.startupTimeoutSeconds}
                  onChange={(event) => update("startupTimeoutSeconds", event.target.value)}
                />
              </FormField>
              <FormField label="Tool timeout (seconds)">
                <Input
                  inputMode="decimal"
                  value={form.toolTimeoutSeconds}
                  onChange={(event) => update("toolTimeoutSeconds", event.target.value)}
                />
              </FormField>
            </div>
            <div className="flex flex-wrap gap-5">
              <label className="flex items-center gap-2 text-sm">
                <ToggleSwitch
                  size="sm"
                  checked={form.enabled}
                  onClick={() => update("enabled", !form.enabled)}
                />
                Enabled
              </label>
              <label className="flex items-center gap-2 text-sm">
                <ToggleSwitch
                  size="sm"
                  checked={form.required}
                  onClick={() => update("required", !form.required)}
                />
                Required for runs
              </label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={pending} onClick={onSubmit}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save connection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
