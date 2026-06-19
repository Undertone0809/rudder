import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentDetail, AgentIntegrationSummary, ConnectAgentIntegration } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Link2, Plug, ShieldCheck, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
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

interface AgentIntegrationsTabProps {
  agent: AgentDetail;
  orgId?: string;
}

export function AgentIntegrationsTab({ agent, orgId }: AgentIntegrationsTabProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [connectOpen, setConnectOpen] = useState(false);
  const [form, setForm] = useState({
    appCredentialSecretId: "",
    externalAppId: "",
    externalBotOpenId: "",
    externalTenantKey: "",
    installerUserId: "",
    manageUrl: "",
    providerRegion: "feishu_cn" as ConnectAgentIntegration["providerRegion"],
  });
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
  const canSubmit = useMemo(
    () => form.appCredentialSecretId.trim().length > 0 && form.externalAppId.trim().length > 0,
    [form.appCredentialSecretId, form.externalAppId],
  );
  const connectIntegration = useMutation({
    mutationFn: () => agentsApi.connectIntegration(agent.id, {
      provider: "feishu",
      transport: "long_connection",
      providerRegion: form.providerRegion,
      appCredentialSecretId: form.appCredentialSecretId.trim(),
      externalAppId: form.externalAppId.trim(),
      externalBotOpenId: form.externalBotOpenId.trim() || null,
      externalTenantKey: form.externalTenantKey.trim() || null,
      installerUserId: form.installerUserId.trim() || null,
      manageUrl: form.manageUrl.trim() || null,
    }, orgId),
    onSuccess: async () => {
      pushToast({ title: "Integration connected", tone: "success" });
      setConnectOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.integrations(agent.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to connect integration",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
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
                ) : feishuIntegration ? (
                  <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                    <IntegrationMeta label="Provider" value={providerLabel(feishuIntegration.provider)} />
                    <IntegrationMeta label="Region" value={regionLabel(feishuIntegration.providerRegion)} />
                    <IntegrationMeta label="App ID" value={feishuIntegration.externalAppId} />
                    <IntegrationMeta label="Bot" value={feishuIntegration.externalBotOpenId ?? "Any bot"} />
                    <IntegrationMeta label="Installed" value={formatDateTime(feishuIntegration.installedAt)} />
                    <IntegrationMeta
                      label="Credentials"
                      value={feishuIntegration.hasCredentialSecret ? "Credential stored" : "Missing credential"}
                    />
                  </dl>
                ) : connectOpen ? (
                  <FeishuConnectForm
                    form={form}
                    setForm={setForm}
                    canSubmit={canSubmit}
                    isPending={connectIntegration.isPending}
                    onCancel={() => setConnectOpen(false)}
                    onSubmit={() => connectIntegration.mutate()}
                  />
                ) : (
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Feishu is not configured for this agent. Connect an app credential secret and bot identity here.
                  </p>
                )}
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
                <Button variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
                  <Link2 className="h-3.5 w-3.5" />
                  Connect
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface FeishuConnectFormProps {
  form: {
    appCredentialSecretId: string;
    externalAppId: string;
    externalBotOpenId: string;
    externalTenantKey: string;
    installerUserId: string;
    manageUrl: string;
    providerRegion: ConnectAgentIntegration["providerRegion"];
  };
  setForm: React.Dispatch<React.SetStateAction<FeishuConnectFormProps["form"]>>;
  canSubmit: boolean;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}

function FeishuConnectForm({ form, setForm, canSubmit, isPending, onCancel, onSubmit }: FeishuConnectFormProps) {
  return (
    <form
      className="grid max-w-3xl gap-3 rounded-md border border-border bg-muted/30 p-3 text-xs sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !isPending) onSubmit();
      }}
    >
      <label className="grid gap-1">
        <span className="font-medium text-muted-foreground">Credential secret ID</span>
        <input
          className="h-8 rounded-md border border-input bg-background px-2 text-foreground outline-none focus:border-ring"
          value={form.appCredentialSecretId}
          onChange={(event) => setForm((current) => ({ ...current, appCredentialSecretId: event.target.value }))}
          placeholder="organization secret UUID"
          required
        />
      </label>
      <label className="grid gap-1">
        <span className="font-medium text-muted-foreground">App ID</span>
        <input
          className="h-8 rounded-md border border-input bg-background px-2 text-foreground outline-none focus:border-ring"
          value={form.externalAppId}
          onChange={(event) => setForm((current) => ({ ...current, externalAppId: event.target.value }))}
          placeholder="cli_a..."
          required
        />
      </label>
      <label className="grid gap-1">
        <span className="font-medium text-muted-foreground">Region</span>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-foreground outline-none focus:border-ring"
          value={form.providerRegion}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              providerRegion: event.target.value as ConnectAgentIntegration["providerRegion"],
            }))}
        >
          <option value="feishu_cn">Feishu CN</option>
          <option value="lark_global">Lark Global</option>
        </select>
      </label>
      <label className="grid gap-1">
        <span className="font-medium text-muted-foreground">Bot open ID</span>
        <input
          className="h-8 rounded-md border border-input bg-background px-2 text-foreground outline-none focus:border-ring"
          value={form.externalBotOpenId}
          onChange={(event) => setForm((current) => ({ ...current, externalBotOpenId: event.target.value }))}
          placeholder="optional"
        />
      </label>
      <label className="grid gap-1">
        <span className="font-medium text-muted-foreground">Tenant key</span>
        <input
          className="h-8 rounded-md border border-input bg-background px-2 text-foreground outline-none focus:border-ring"
          value={form.externalTenantKey}
          onChange={(event) => setForm((current) => ({ ...current, externalTenantKey: event.target.value }))}
          placeholder="optional"
        />
      </label>
      <label className="grid gap-1">
        <span className="font-medium text-muted-foreground">Installer user</span>
        <input
          className="h-8 rounded-md border border-input bg-background px-2 text-foreground outline-none focus:border-ring"
          value={form.installerUserId}
          onChange={(event) => setForm((current) => ({ ...current, installerUserId: event.target.value }))}
          placeholder="optional"
        />
      </label>
      <label className="grid gap-1 sm:col-span-2">
        <span className="font-medium text-muted-foreground">Manage URL</span>
        <input
          className="h-8 rounded-md border border-input bg-background px-2 text-foreground outline-none focus:border-ring"
          value={form.manageUrl}
          onChange={(event) => setForm((current) => ({ ...current, manageUrl: event.target.value }))}
          placeholder="optional"
          type="url"
        />
      </label>
      <div className="flex items-center gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={!canSubmit || isPending}>
          <Link2 className="h-3.5 w-3.5" />
          {isPending ? "Connecting" : "Connect"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          <X className="h-3.5 w-3.5" />
          Cancel
        </Button>
      </div>
    </form>
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

function IntegrationRowSkeleton() {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-8 w-full" />
      ))}
    </div>
  );
}
