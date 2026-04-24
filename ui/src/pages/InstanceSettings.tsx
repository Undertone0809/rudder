import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3 } from "lucide-react";
import type { InstanceSchedulerHeartbeatAgent } from "@rudderhq/shared";
import { Link } from "@/lib/router";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";
import { EmptyState } from "../components/EmptyState";
import {
  SettingsDivider,
  SettingsPageHeader,
  SettingsSection,
} from "@/components/settings/SettingsScaffold";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { HeartbeatEnabledButtons } from "@/components/HeartbeatEnabledButtons";
import { humanizeUnderscore, isHeartbeatToggleOn } from "@/lib/heartbeat-scheduler";
import { queryKeys } from "../lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import { cn, formatDateTime, relativeTime } from "../lib/utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function buildAgentHref(agent: InstanceSchedulerHeartbeatAgent) {
  return `/${agent.organizationIssuePrefix}/agents/${encodeURIComponent(agent.agentUrlKey)}`;
}

function buildOrganizationHeartbeatsHref(agent: Pick<InstanceSchedulerHeartbeatAgent, "organizationIssuePrefix">) {
  return `/${agent.organizationIssuePrefix}/heartbeats`;
}

function schedulerStateMeta(
  agent: InstanceSchedulerHeartbeatAgent,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (agent.schedulerActive) {
    return {
      label: t("heartbeats.scheduler.scheduled"),
      className: "text-emerald-700 dark:text-emerald-400",
    };
  }
  if (agent.heartbeatEnabled) {
    return {
      label: t("heartbeats.scheduler.configuredInactive"),
      className: "text-amber-700 dark:text-amber-400",
    };
  }
  return {
    label: t("heartbeats.scheduler.disabled"),
    className: "text-muted-foreground",
  };
}

export function InstanceSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("common.heartbeats") },
    ]);
  }, [setBreadcrumbs, t]);

  const heartbeatsQuery = useQuery({
    queryKey: queryKeys.instance.schedulerHeartbeats,
    queryFn: () => heartbeatsApi.listInstanceSchedulerAgents(),
    refetchInterval: 15_000,
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

  async function setHeartbeatEnabled(agentRow: InstanceSchedulerHeartbeatAgent, enabled: boolean) {
    const agent = await agentsApi.get(agentRow.id, agentRow.orgId);
    const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
    const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};

    return agentsApi.update(
      agentRow.id,
      {
        runtimeConfig: {
          ...runtimeConfig,
          heartbeat: {
            ...heartbeat,
            enabled,
          },
        },
      },
      agentRow.orgId,
    );
  }

  const setHeartbeatEnabledMutation = useMutation({
    mutationFn: async ({
      agentRow,
      enabled,
    }: {
      agentRow: InstanceSchedulerHeartbeatAgent;
      enabled: boolean;
    }) => setHeartbeatEnabled(agentRow, enabled),
    onSuccess: async (_, variables) => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(variables.agentRow.orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(variables.agentRow.id) }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("heartbeats.updateFailed"));
    },
  });

  const disableAllMutation = useMutation({
    mutationFn: async (agentRows: InstanceSchedulerHeartbeatAgent[]) => {
      const enabled = agentRows.filter((a) => a.heartbeatEnabled);
      if (enabled.length === 0) return enabled;

      const results = await Promise.allSettled(
        enabled.map(async (agentRow) => setHeartbeatEnabled(agentRow, false)),
      );

      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) {
        const firstError = failures[0]?.reason;
        const detail = firstError instanceof Error ? firstError.message : "Unknown error";
        throw new Error(
          failures.length === 1
            ? `Failed to disable 1 timer heartbeat: ${detail}`
            : `Failed to disable ${failures.length} of ${enabled.length} timer heartbeats. First error: ${detail}`,
        );
      }
      return enabled;
    },
    onSuccess: async (updatedRows) => {
      setActionError(null);
      const organizations = new Set(updatedRows.map((row) => row.orgId));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
        ...Array.from(organizations, (orgId) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(orgId) }),
        ),
        ...updatedRows.map((row) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(row.id) }),
        ),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("heartbeats.disableAllFailed"));
    },
  });

  const agents = heartbeatsQuery.data ?? [];
  const scheduledCount = agents.filter((agent) => agent.schedulerActive).length;
  const configuredInactiveCount = agents.filter((agent) => agent.heartbeatEnabled && !agent.schedulerActive).length;
  const disabledCount = agents.filter((agent) => !agent.heartbeatEnabled).length;
  const enabledCount = agents.filter((agent) => agent.heartbeatEnabled).length;
  const anyEnabled = enabledCount > 0;

  const grouped = useMemo(() => {
    const map = new Map<
      string,
      {
        organizationName: string;
        organizationIssuePrefix: string;
        agents: InstanceSchedulerHeartbeatAgent[];
      }
    >();
    for (const agent of agents) {
      let group = map.get(agent.orgId);
      if (!group) {
        group = {
          organizationName: agent.organizationName,
          organizationIssuePrefix: agent.organizationIssuePrefix,
          agents: [],
        };
        map.set(agent.orgId, group);
      }
      group.agents.push(agent);
    }
    return [...map.values()];
  }, [agents]);

  if (heartbeatsQuery.isLoading) {
    return <SettingsPageSkeleton dense />;
  }

  if (heartbeatsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {heartbeatsQuery.error instanceof Error
          ? heartbeatsQuery.error.message
          : t("heartbeats.loadFailed")}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-none space-y-5 px-0.5 pb-4">
      <SettingsPageHeader
        icon={Clock3}
        title={t("heartbeats.title")}
        description={t("heartbeats.description")}
      />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
        <span><span className="font-semibold text-foreground">{scheduledCount}</span> {t("heartbeats.summary.scheduled")}</span>
        <span><span className="font-semibold text-foreground">{configuredInactiveCount}</span> {t("heartbeats.summary.configuredInactive")}</span>
        <span><span className="font-semibold text-foreground">{disabledCount}</span> {t("heartbeats.summary.disabled")}</span>
        <span><span className="font-semibold text-foreground">{grouped.length}</span> {t(grouped.length === 1 ? "heartbeats.summary.organization" : "heartbeats.summary.organizations")}</span>
        {anyEnabled && (
          <Button
            variant="destructive"
            size="sm"
            className="h-8 text-xs sm:ml-auto"
            disabled={disableAllMutation.isPending}
            onClick={() => {
              const message = t(
                enabledCount === 1 ? "heartbeats.confirmDisableAll.one" : "heartbeats.confirmDisableAll.many",
                { count: enabledCount },
              );
              if (!window.confirm(message)) {
                return;
              }
              disableAllMutation.mutate(agents);
            }}
          >
            {disableAllMutation.isPending ? t("heartbeats.disabling") : t("heartbeats.disableAll")}
          </Button>
        )}
      </div>

      <SettingsDivider />

      {actionError && (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {agents.length === 0 ? (
        <EmptyState
          icon={Clock3}
          message={t("heartbeats.empty")}
        />
      ) : (
        <SettingsSection
          title={t("heartbeats.section.title")}
          description={t("heartbeats.section.description")}
        >
        <div className="space-y-3">
          {grouped.map((group) => (
            <Card key={group.organizationName} className="overflow-hidden">
              <CardContent className="p-0">
                <div className="border-b px-4">
                  <Link
                    to={buildOrganizationHeartbeatsHref(group)}
                    className="inline-block min-w-0 truncate text-sm font-semibold text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {group.organizationName}
                  </Link>
                </div>
                <div className="hidden border-b bg-[color:color-mix(in_oklab,var(--surface-inset)_88%,transparent)] px-4 py-2.5 text-[11px] font-medium text-muted-foreground md:grid md:grid-cols-[minmax(0,1.8fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_auto] md:gap-3">
                  <span>{t("heartbeats.table.agent")}</span>
                  <span>{t("heartbeats.table.scheduler")}</span>
                  <span>{t("heartbeats.table.lastHeartbeat")}</span>
                  <span className="text-right">{t("heartbeats.table.actions")}</span>
                </div>
                <div className="divide-y divide-border/70">
                  {group.agents.map((agent) => {
                    const saving =
                      setHeartbeatEnabledMutation.isPending &&
                      setHeartbeatEnabledMutation.variables?.agentRow.id === agent.id;
                    const schedulerState = schedulerStateMeta(agent, t);
                    const toggleOn = isHeartbeatToggleOn(agent);
                    return (
                      <div
                        key={agent.id}
                        data-testid="heartbeat-agent-row"
                        className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1.8fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_auto] md:items-center"
                      >
                        <div className="min-w-0">
                          <Link
                            to={buildAgentHref(agent)}
                            className="block truncate text-[13px] font-medium text-foreground hover:underline"
                          >
                            {agent.agentName}
                          </Link>
                          <div className="truncate text-xs text-muted-foreground">
                            {humanizeUnderscore(agent.title ?? agent.role)}
                          </div>
                        </div>
                        <div className="min-w-0 space-y-0.5">
                          <div
                            className={cn(
                              "truncate text-xs font-medium",
                              schedulerState.className,
                            )}
                          >
                            {schedulerState.label}
                          </div>
                          <div className="truncate text-xs text-muted-foreground tabular-nums">
                            {t("heartbeats.table.interval")} {agent.intervalSec}s
                          </div>
                        </div>
                        <div
                          className="text-xs text-muted-foreground tabular-nums"
                          title={agent.lastHeartbeatAt ? formatDateTime(agent.lastHeartbeatAt) : undefined}
                        >
                          {agent.lastHeartbeatAt
                            ? relativeTime(agent.lastHeartbeatAt)
                            : t("heartbeats.never")}
                        </div>
                        <div className="flex items-center justify-start md:justify-end">
                          <HeartbeatEnabledButtons
                            onPressed={toggleOn}
                            disabled={saving}
                            ariaLabel={t("heartbeats.timerState")}
                            onLabel={t("heartbeats.on")}
                            offLabel={t("heartbeats.off")}
                            onEnable={() => {
                              if (!agent.heartbeatEnabled) {
                                setHeartbeatEnabledMutation.mutate({ agentRow: agent, enabled: true });
                              }
                            }}
                            onDisable={() => {
                              if (agent.heartbeatEnabled) {
                                setHeartbeatEnabledMutation.mutate({ agentRow: agent, enabled: false });
                              }
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        </SettingsSection>
      )}
    </div>
  );
}
