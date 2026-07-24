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
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type {
  CreateMcpConnection,
  McpConnectionAccessMode,
  McpConnectionProvider,
  McpConnectionSummary,
  McpConnectionTransport,
  McpProviderCatalogEntry,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { managedMcpApi } from "../api/managedMcp";
import { McpProviderIcon } from "../components/McpProviderIcon";
import { SettingsGroup, SettingsSection } from "../components/settings/SettingsScaffold";
import { useToast } from "../context/ToastContext";
import { readDesktopShell, type DesktopShellApi } from "../lib/desktop-shell";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

type KeyValueRow = { id: string; key: string; value: string };
type ValueRow = { id: string; value: string };

export interface CustomMcpFormState {
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
  toolAllowlistText: string;
  toolDenylistText: string;
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
    toolAllowlistText: "",
    toolDenylistText: "",
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
    accessMode: form.accessMode,
    enabled: form.enabled,
    required: form.required,
    startupTimeoutMs,
    toolTimeoutMs,
  };
  const toolAllowlist = splitList(form.toolAllowlistText);
  const toolDenylist = splitList(form.toolDenylistText);
  const toolFilters = {
    ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
    ...(toolDenylist.length > 0 ? { toolDenylist } : {}),
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
        ...toolFilters,
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
      ...toolFilters,
    },
    ...(headers.length > 0
      ? { secrets: { headers: Object.fromEntries(headers) } }
      : {}),
  };
}

function providerDescription(provider: McpProviderCatalogEntry): string {
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
      return ["Choose scope", "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300"];
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
  const customConnectionCreated = useRef(false);
  const catalogQuery = useQuery({
    queryKey: queryKeys.organizations.mcpProviders(orgId),
    queryFn: () => managedMcpApi.catalog(orgId),
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
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.mcpConnections(orgId),
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
      authorizationLauncher: AuthorizationLauncher;
    }) => {
      const { provider, authorizationLauncher } = input;
      const definition = catalogQuery.data?.find((entry) => entry.id === provider);
      if (!definition) throw new Error(`${provider} is not available`);
      try {
        const connection = await managedMcpApi.createConnection(orgId, {
          name: `${provider}-${Date.now().toString(36)}`,
          displayName: definition.label,
          provider,
          transport: "streamable_http",
          safeConfig: {},
          accessMode: input.accessMode ?? definition.defaultAccessMode,
          enabled: true,
          required: false,
          startupTimeoutMs: 10_000,
          toolTimeoutMs: 60_000,
        });
        const started = await managedMcpApi.startOAuth(orgId, connection.id);
        await authorizationLauncher.navigate(started.authorizationUrl);
        return connection;
      } catch (error) {
        authorizationLauncher.close();
        throw error;
      }
    },
    onSuccess: async () => {
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
  const beginOfficialAuthorization = (
    provider: Exclude<McpConnectionProvider, "custom">,
    accessMode?: McpConnectionAccessMode,
  ) => {
    try {
      createOfficial.mutate({
        provider,
        accessMode,
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

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="organization-mcp-settings">
      <SettingsSection
        title="Connect an MCP"
        description="Connections belong to this organization. Agents only receive the tools you explicitly bind."
      >
        {catalogQuery.isError ? (
          <div className="rounded-md border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Could not load the MCP provider catalog. {catalogQuery.error instanceof Error
              ? catalogQuery.error.message
              : ""}
          </div>
        ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {curated.map((provider) => {
            return (
              <ProviderCard
                key={provider.id}
                testId={`mcp-provider-${provider.id}`}
                provider={provider.id}
                title={provider.label}
                description={providerDescription(provider)}
                actionLabel="Connect"
                disabled={createOfficial.isPending}
                onAction={() => beginOfficialAuthorization(provider.id)}
                secondaryAction={provider.defaultAccessMode !== "read_only"
                  && provider.accessModes.includes("read_only")
                  ? {
                      label: "Read-only",
                      onClick: () => beginOfficialAuthorization(provider.id, "read_only"),
                    }
                  : undefined}
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

      <SettingsSection
        title="Managed connections"
        description="Credentials stay encrypted on the Rudder server and are never exposed to agent configuration."
      >
        <SettingsGroup>
          {connectionsQuery.isLoading ? (
            <div className="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading connections
            </div>
          ) : connectionsQuery.isError ? (
            <div className="px-4 py-5 text-sm text-destructive">
              Could not load managed MCP connections. {connectionsQuery.error instanceof Error
                ? connectionsQuery.error.message
                : ""}
            </div>
          ) : connections.length === 0 ? (
            <div className="px-4 py-7 text-center text-sm text-muted-foreground">
              No managed MCP connections yet.
            </div>
          ) : connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              orgId={orgId}
              connection={connection}
              provider={catalogQuery.data?.find((entry) => entry.id === connection.provider)}
              onChanged={invalidate}
            />
          ))}
        </SettingsGroup>
      </SettingsSection>

      <CustomMcpDialog
        form={customForm}
        pending={createCustom.isPending}
        onChange={setCustomForm}
        onClose={() => setCustomForm(null)}
        onSubmit={() => {
          if (customForm) createCustom.mutate(customForm);
        }}
      />
    </div>
  );
}

function ProviderCard({
  testId,
  provider,
  title,
  description,
  actionLabel,
  secondaryAction,
  disabled,
  onAction,
}: {
  testId?: string;
  provider: McpConnectionProvider;
  title: string;
  description: string;
  actionLabel: string;
  secondaryAction?: { label: string; onClick: () => void };
  disabled?: boolean;
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
        <Button size="sm" variant="outline" disabled={disabled} onClick={onAction}>
          {disabled ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

function ConnectionRow({
  orgId,
  connection,
  provider,
  onChanged,
}: {
  orgId: string;
  connection: McpConnectionSummary;
  provider?: McpProviderCatalogEntry;
  onChanged: () => Promise<void>;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [showTools, setShowTools] = useState(false);
  const toolsQuery = useQuery({
    queryKey: queryKeys.organizations.mcpConnectionTools(orgId, connection.id),
    queryFn: () => managedMcpApi.listTools(orgId, connection.id),
    enabled: showTools,
  });
  const scopesQuery = useQuery({
    queryKey: queryKeys.organizations.mcpConnectionScopes(orgId, connection.id),
    queryFn: () => managedMcpApi.listScopes(orgId, connection.id),
    enabled: connection.status === "selecting_scope",
  });
  const [selectedScope, setSelectedScope] = useState("");
  useEffect(() => {
    if (!selectedScope && scopesQuery.data?.[0]) setSelectedScope(scopesQuery.data[0].id);
  }, [scopesQuery.data, selectedScope]);
  const invalidateConnectionDetails = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.mcpConnectionTools(orgId, connection.id),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.mcpConnectionScopes(orgId, connection.id),
      }),
    ]);
  };

  const runAction = useMutation({
    mutationFn: async (input: {
      action: "reconnect" | "refresh" | "disconnect" | "scope";
      authorizationLauncher?: AuthorizationLauncher;
    }) => {
      const { action, authorizationLauncher } = input;
      if (action === "refresh") return managedMcpApi.refreshTools(orgId, connection.id);
      if (action === "disconnect") return managedMcpApi.disconnect(orgId, connection.id);
      if (action === "scope") {
        if (!selectedScope) throw new Error(`Choose a ${provider?.scopeLabel.toLowerCase() ?? "scope"}`);
        return managedMcpApi.selectScope(orgId, connection.id, {
          externalScope: selectedScope,
          accessMode: connection.accessMode,
        });
      }
      try {
        const result = await managedMcpApi.reconnect(orgId, connection.id);
        if ("authorizationUrl" in result) {
          if (!authorizationLauncher) throw new Error("Authorization launcher was not reserved");
          await authorizationLauncher.navigate(result.authorizationUrl);
        }
        if (connection.provider === "custom") {
          await managedMcpApi.refreshTools(orgId, connection.id);
          return managedMcpApi.getConnection(orgId, connection.id);
        }
        return result;
      } catch (error) {
        authorizationLauncher?.close();
        throw error;
      }
    },
    onSuccess: async (_result, input) => {
      await Promise.all([onChanged(), invalidateConnectionDetails()]);
      if (input.action === "refresh") await toolsQuery.refetch();
      pushToast({
        title: input.action === "disconnect" ? "Connection disconnected" : "Connection updated",
        tone: "success",
      });
    },
    onError: async (error) => {
      await Promise.all([onChanged(), invalidateConnectionDetails()]);
      pushToast({
        title: "Connection action failed",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const updateAccess = useMutation({
    mutationFn: async (input: {
      accessMode: McpConnectionAccessMode;
      authorizationLauncher?: AuthorizationLauncher;
    }) => {
      const { accessMode, authorizationLauncher } = input;
      const needsLinearReauthorization = connection.provider === "linear"
        && connection.status === "active"
        && connection.accessMode === "read_only"
        && accessMode === "read_write";
      try {
        if (needsLinearReauthorization) {
          if (!authorizationLauncher) throw new Error("Authorization launcher was not reserved");
          await managedMcpApi.disconnect(orgId, connection.id);
          await managedMcpApi.updateAccessMode(orgId, connection.id, accessMode);
          const started = await managedMcpApi.reconnect(orgId, connection.id);
          if (!("authorizationUrl" in started)) {
            throw new Error("Linear reauthorization did not return an authorization URL");
          }
          await authorizationLauncher.navigate(started.authorizationUrl);
          return started;
        }
        return managedMcpApi.updateAccessMode(orgId, connection.id, accessMode);
      } catch (error) {
        authorizationLauncher?.close();
        throw error;
      }
    },
    onSuccess: async () => {
      await Promise.all([onChanged(), invalidateConnectionDetails()]);
    },
    onError: async (error) => {
      await Promise.all([onChanged(), invalidateConnectionDetails()]);
      pushToast({
        title: "Permission update failed",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const [statusLabel, statusTone] = statusCopy(connection.status);
  const canReconnect = canReconnectManagedMcp(connection.status);
  const reconnect = () => {
    try {
      runAction.mutate({
        action: "reconnect",
        ...(connection.provider === "custom"
          ? {}
          : { authorizationLauncher: reserveAuthorizationLauncher() }),
      });
    } catch (error) {
      pushToast({
        title: "Could not open authorization",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    }
  };
  const changeAccessMode = (accessMode: McpConnectionAccessMode) => {
    const requiresAuthorization = connection.provider === "linear"
      && connection.status === "active"
      && connection.accessMode === "read_only"
      && accessMode === "read_write";
    try {
      updateAccess.mutate({
        accessMode,
        ...(requiresAuthorization
          ? { authorizationLauncher: reserveAuthorizationLauncher() }
          : {}),
      });
    } catch (error) {
      pushToast({
        title: "Could not open authorization",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    }
  };

  return (
    <div
      data-slot="settings-item"
      data-testid={`mcp-connection-${connection.id}`}
      className="flex flex-col gap-3 px-4 py-3.5"
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">{connection.displayName}</p>
            <span className={cn("rounded-md border px-1.5 py-0.5 text-xs", statusTone)}>
              {statusLabel}
            </span>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              {connection.provider === "custom" ? connection.transport.replace("_", " ") : connection.provider}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {connection.externalScope
              ? `${connection.externalScope} · ${connection.accessMode.replace("_", " ")}`
              : connection.accessMode.replace("_", " ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {provider?.curated && provider.accessModes.length > 1 ? (
            <select
              aria-label={`Access mode for ${connection.displayName}`}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              value={connection.accessMode}
              disabled={updateAccess.isPending || connection.status !== "active"}
              onChange={(event) =>
                changeAccessMode(event.target.value as McpConnectionAccessMode)}
            >
              {provider.accessModes.map((accessMode) => (
                <option key={accessMode} value={accessMode}>
                  {accessMode === "read_only"
                    ? "Read only"
                    : accessMode === "read_write"
                      ? "Read/write"
                      : "Provider default"}
                </option>
              ))}
            </select>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setShowTools((value) => !value)}>
            <Wrench className="size-3.5" /> Tools
          </Button>
          {connection.status === "active" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={runAction.isPending}
              onClick={() => runAction.mutate({ action: "refresh" })}
            >
              <RefreshCw className="size-3.5" /> Refresh
            </Button>
          ) : null}
          {canReconnect ? (
            <Button
              size="sm"
              variant="outline"
              disabled={runAction.isPending}
              onClick={reconnect}
            >
              <ExternalLink className="size-3.5" /> Reconnect
            </Button>
          ) : null}
          {!["revoked", "disabled"].includes(connection.status) ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={runAction.isPending}
              onClick={() => runAction.mutate({ action: "disconnect" })}
            >
              <Trash2 className="size-3.5" /> Disconnect
            </Button>
          ) : null}
        </div>
      </div>
      {connection.status === "selecting_scope" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 p-3">
          {scopesQuery.isError ? (
            <p className="text-xs text-destructive">
              Could not load available scopes. {scopesQuery.error instanceof Error
                ? scopesQuery.error.message
                : ""}
            </p>
          ) : (
            <>
              <select
                aria-label={provider?.scopeLabel ?? "External scope"}
                className="h-9 min-w-56 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                value={selectedScope}
                disabled={scopesQuery.isLoading}
                onChange={(event) => setSelectedScope(event.target.value)}
              >
                {(scopesQuery.data ?? []).map((scope) => (
                  <option key={scope.id} value={scope.id}>{scope.displayName}</option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!selectedScope || runAction.isPending || scopesQuery.isLoading}
                onClick={() => runAction.mutate({ action: "scope" })}
              >
                Use {provider?.scopeLabel.toLowerCase() ?? "scope"}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {showTools ? (
        <div className="rounded-md border border-border bg-muted/25 p-3">
          {toolsQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading tools…</p>
          ) : toolsQuery.isError ? (
            <p className="text-xs text-destructive">
              Could not load discovered tools. {toolsQuery.error instanceof Error
                ? toolsQuery.error.message
                : ""}
            </p>
          ) : (toolsQuery.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No tools discovered.</p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {(toolsQuery.data ?? []).map((tool) => (
                <div key={tool.id} className="min-w-0">
                  <p className="truncate font-mono text-xs text-foreground">{tool.rudderToolName}</p>
                  {tool.description ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
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
  pending,
  onChange,
  onClose,
  onSubmit,
}: {
  form: CustomMcpFormState | null;
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
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="Tool allowlist"
                hint="Optional exact upstream tool names, comma-separated. Blank allows all."
              >
                <Input
                  placeholder="search, list_projects"
                  value={form.toolAllowlistText}
                  onChange={(event) => update("toolAllowlistText", event.target.value)}
                />
              </FormField>
              <FormField
                label="Tool denylist"
                hint="Exact upstream tool names removed after the allowlist."
              >
                <Input
                  placeholder="delete_project, execute_sql"
                  value={form.toolDenylistText}
                  onChange={(event) => update("toolDenylistText", event.target.value)}
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
