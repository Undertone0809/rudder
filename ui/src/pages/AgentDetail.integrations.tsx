import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  AgentDetail,
  AgentIntegrationProviderRegion,
  AgentIntegrationSetupSession,
  AgentIntegrationSummary,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Plug, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { agentsApi } from "../api/agents";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime } from "../lib/utils";

type IntegrationState = "not_configured" | "active" | "revoked" | "error";

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
  const integrationsQuery = useQuery({
    queryKey: queryKeys.agents.integrations(agent.id),
    queryFn: () => agentsApi.listIntegrations(agent.id, orgId),
    initialData: agent.integrations ?? [],
  });
  const integrations = integrationsQuery.data ?? [];
  const feishuIntegration = integrations.find((integration) => integration.provider === "feishu") ?? null;
  const state = getFeishuIntegrationState(feishuIntegration);
  const stateCopy = integrationStateCopy(state);
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

  return (
    <div className="max-w-4xl space-y-4">
      <div className="rounded-lg border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">Integrations</h2>
            <p className="text-sm text-muted-foreground">External messaging surfaces linked to this agent.</p>
          </div>
          <span
            className={cn(
              "inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
              stateCopy.tone,
            )}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {stateCopy.label}
          </span>
        </div>

        <div className="divide-y divide-border">
          <div className="grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                <Plug className="h-4 w-4 text-muted-foreground" />
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
        </div>
      </div>
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
      <div className="font-medium text-foreground">Quick Command menu</div>
      <p className="mt-1">
        In the {providerName} bot developer console, add a Quick Command custom menu with send-text items /new and
        /stop. Do not use event-key menu items. Publish a new app version for the menu to appear in {providerName}.
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
