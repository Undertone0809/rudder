import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, HeartbeatRun } from "@rudderhq/shared";
import { Activity, ArrowUpRight, Bot, Clock3, Play } from "lucide-react";
import { Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi, type LiveRunForIssue } from "@/api/heartbeats";
import { HeartbeatEnabledButtons } from "@/components/HeartbeatEnabledButtons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { useViewedOrganization } from "@/hooks/useViewedOrganization";
import { buildAgentSchedulerState, humanizeUnderscore, isHeartbeatToggleOn } from "@/lib/heartbeat-scheduler";
import { queryKeys } from "@/lib/queryKeys";
import { agentRouteRef, agentUrl, cn, formatDateTime, relativeTime } from "@/lib/utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function latestRunSummary(run: HeartbeatRun | null) {
  if (!run) return null;
  if (run.error?.trim()) return run.error.trim();
  const result = asRecord(run.resultJson);
  const summary = typeof result?.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : typeof result?.result === "string" && result.result.trim()
      ? result.result.trim()
      : typeof result?.message === "string" && result.message.trim()
        ? result.message.trim()
      : null;
  return summary;
}

function schedulerStateMeta(input: {
  heartbeatEnabled: boolean;
  schedulerActive: boolean;
}) {
  if (input.schedulerActive) {
    return {
      label: "Scheduled",
      className: "text-emerald-700 dark:text-emerald-400",
    };
  }
  if (input.heartbeatEnabled) {
    return {
      label: "Configured, inactive",
      className: "text-amber-700 dark:text-amber-400",
    };
  }
  return {
    label: "Disabled",
    className: "text-muted-foreground",
  };
}

function latestRunMeta(run: HeartbeatRun | null, liveRun: LiveRunForIssue | null, liveCount: number) {
  if (liveRun) {
    return {
      label: liveCount > 1 ? `${liveCount} live runs` : "Live now",
      className: "text-blue-700 dark:text-blue-300",
    };
  }
  if (!run) {
    return {
      label: "No runs yet",
      className: "text-muted-foreground",
    };
  }
  if (run.status === "failed") {
    return {
      label: "Last run failed",
      className: "text-red-700 dark:text-red-300",
    };
  }
  if (run.status === "succeeded") {
    return {
      label: "Last run completed",
      className: "text-emerald-700 dark:text-emerald-400",
    };
  }
  if (run.status === "running") {
    return {
      label: "Running",
      className: "text-blue-700 dark:text-blue-300",
    };
  }
  if (run.status === "queued") {
    return {
      label: "Queued",
      className: "text-amber-700 dark:text-amber-400",
    };
  }
  return {
    label: humanizeUnderscore(run.status),
    className: "text-muted-foreground",
  };
}

function buildHeartbeatPatch(agent: Agent, enabled: boolean) {
  const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
  const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};
  return {
    runtimeConfig: {
      ...runtimeConfig,
      heartbeat: {
        ...heartbeat,
        enabled,
      },
    },
  };
}

export function OrganizationHeartbeats() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { viewedOrganization, viewedOrganizationId } = useViewedOrganization();

  useEffect(() => {
    setBreadcrumbs([{ label: "Heartbeats" }]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(viewedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.heartbeats(viewedOrganizationId ?? "__none__"),
    queryFn: () => heartbeatsApi.list(viewedOrganizationId!, undefined, 1000),
    enabled: !!viewedOrganizationId,
    refetchInterval: 15_000,
  });

  const liveRunsQuery = useQuery({
    queryKey: queryKeys.liveRuns(viewedOrganizationId ?? "__none__"),
    queryFn: () => heartbeatsApi.liveRunsForCompany(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
    refetchInterval: 10_000,
  });

  const setHeartbeatEnabledMutation = useMutation({
    mutationFn: async ({ agent, enabled }: { agent: Agent; enabled: boolean }) =>
      agentsApi.update(agent.id, buildHeartbeatPatch(agent, enabled), agent.orgId),
    onSuccess: async (_, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(variables.agent.orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(variables.agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(variables.agent.orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(variables.agent.orgId) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to update heartbeat",
        tone: "error",
      });
    },
  });

  const invokeHeartbeatMutation = useMutation({
    mutationFn: async (agent: Agent) => agentsApi.invoke(agent.id, agent.orgId),
    onSuccess: async (run, agent) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(agent.orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(agent.orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
      ]);
      pushToast({
        title: `Heartbeat started for ${agent.name}`,
        body: `Run ${run.id.slice(0, 8)} is now queued.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to start heartbeat",
        tone: "error",
      });
    },
  });

  const latestRunByAgent = useMemo(() => {
    const map = new Map<string, HeartbeatRun>();
    for (const run of runsQuery.data ?? []) {
      if (!map.has(run.agentId)) {
        map.set(run.agentId, run);
      }
    }
    return map;
  }, [runsQuery.data]);

  const liveRunsByAgent = useMemo(() => {
    const map = new Map<string, LiveRunForIssue[]>();
    for (const run of liveRunsQuery.data ?? []) {
      const rows = map.get(run.agentId);
      if (rows) {
        rows.push(run);
      } else {
        map.set(run.agentId, [run]);
      }
    }
    return map;
  }, [liveRunsQuery.data]);

  const rows = useMemo(() => {
    return (agentsQuery.data ?? [])
      .filter((agent) => agent.status !== "terminated")
      .map((agent) => {
        const scheduler = buildAgentSchedulerState(agent);
        const latestRun = latestRunByAgent.get(agent.id) ?? null;
        const liveRuns = liveRunsByAgent.get(agent.id) ?? [];
        return {
          agent,
          latestRun,
          liveRun: liveRuns[0] ?? null,
          liveCount: liveRuns.length,
          ...scheduler,
        };
      })
      .sort((left, right) => {
        if (left.liveCount !== right.liveCount) return right.liveCount - left.liveCount;
        if (left.schedulerActive !== right.schedulerActive) return left.schedulerActive ? -1 : 1;
        if (left.heartbeatEnabled !== right.heartbeatEnabled) return left.heartbeatEnabled ? -1 : 1;
        return left.agent.name.localeCompare(right.agent.name);
      });
  }, [agentsQuery.data, latestRunByAgent, liveRunsByAgent]);

  if (!viewedOrganizationId || !viewedOrganization) {
    return <EmptyState icon={Clock3} message="Select an organization to manage heartbeats." />;
  }

  if (agentsQuery.isLoading || runsQuery.isLoading || liveRunsQuery.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (agentsQuery.error) {
    return <p className="text-sm text-destructive">{agentsQuery.error.message}</p>;
  }

  if (runsQuery.error) {
    return <p className="text-sm text-destructive">{runsQuery.error.message}</p>;
  }

  if (liveRunsQuery.error) {
    return <p className="text-sm text-destructive">{liveRunsQuery.error.message}</p>;
  }

  return (
    <div className="flex min-h-full flex-col gap-4">
      <section className="rounded-[var(--radius-lg)] border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="text-sm font-medium text-foreground">Agents</div>
          <div className="mt-1 text-xs text-muted-foreground">
            One row per agent. Use this surface to control timer heartbeat policy and jump to the latest run when you
            need deeper inspection.
          </div>
        </div>

        <div className="px-5 py-4">
          {rows.length === 0 ? (
            <div className="rounded-[var(--radius-md)] border border-dashed border-border/80 bg-[color:color-mix(in_oklab,var(--surface-elevated)_84%,transparent)] px-5 py-9 text-sm text-muted-foreground">
              No active agents yet. Create an agent before managing org heartbeats.
            </div>
          ) : (
            <div className="divide-y divide-border/70 rounded-[var(--radius-md)] border border-border/80 bg-[color:color-mix(in_oklab,var(--surface-elevated)_88%,transparent)]">
              {rows.map((row) => {
                const schedulerState = schedulerStateMeta(row);
                const runState = latestRunMeta(row.latestRun, row.liveRun, row.liveCount);
                const latestSummary = latestRunSummary(row.latestRun);
                const saving =
                  setHeartbeatEnabledMutation.isPending
                  && setHeartbeatEnabledMutation.variables?.agent.id === row.agent.id;
                const starting =
                  invokeHeartbeatMutation.isPending
                  && invokeHeartbeatMutation.variables?.id === row.agent.id;
                const toggleOn = isHeartbeatToggleOn(row);
                const latestRunLink = row.liveRun
                  ? `/agents/${agentRouteRef(row.agent)}/runs/${row.liveRun.id}`
                  : row.latestRun
                    ? `/agents/${agentRouteRef(row.agent)}/runs/${row.latestRun.id}`
                    : null;

                return (
                  <div
                    key={row.agent.id}
                    data-testid="org-heartbeat-row"
                    className="grid gap-4 px-4 py-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,1fr)_auto] xl:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link to={agentUrl(row.agent)} className="truncate text-sm font-semibold text-foreground hover:underline">
                          {row.agent.name}
                        </Link>
                        {row.liveCount > 0 ? (
                          <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
                            Live
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {humanizeUnderscore(row.agent.title ?? row.agent.role)} · {humanizeUnderscore(row.agent.status)}
                      </div>
                    </div>

                    <div className="min-w-0">
                      <div className={cn("text-xs font-medium", schedulerState.className)}>{schedulerState.label}</div>
                      <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                        Every {row.intervalSec > 0 ? `${row.intervalSec}s` : "0s"}
                      </div>
                      <div
                        className="mt-1 text-xs text-muted-foreground"
                        title={row.agent.lastHeartbeatAt ? formatDateTime(row.agent.lastHeartbeatAt) : undefined}
                      >
                        Last heartbeat {row.agent.lastHeartbeatAt ? relativeTime(row.agent.lastHeartbeatAt) : "never"}
                      </div>
                    </div>

                    <div className="min-w-0">
                      <div className={cn("text-xs font-medium", runState.className)}>{runState.label}</div>
                      {latestSummary ? (
                        <div
                          className="mt-1 truncate text-xs text-muted-foreground"
                          title={latestSummary}
                        >
                          {latestSummary}
                        </div>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {row.latestRun?.createdAt ? <span title={formatDateTime(row.latestRun.createdAt)}>Run {relativeTime(row.latestRun.createdAt)}</span> : null}
                        <Link to={agentUrl(row.agent)} className="inline-flex items-center gap-1 hover:text-foreground">
                          Agent
                          <ArrowUpRight className="h-3 w-3" />
                        </Link>
                        {latestRunLink ? (
                          <Link to={latestRunLink} className="inline-flex items-center gap-1 hover:text-foreground">
                            Run
                            <ArrowUpRight className="h-3 w-3" />
                          </Link>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                      <HeartbeatEnabledButtons
                        onPressed={toggleOn}
                        disabled={saving}
                        ariaLabel={`Timer heartbeat state for ${row.agent.name}`}
                        onEnable={() => {
                          if (!row.heartbeatEnabled) {
                            setHeartbeatEnabledMutation.mutate({ agent: row.agent, enabled: true });
                          }
                        }}
                        onDisable={() => {
                          if (row.heartbeatEnabled) {
                            setHeartbeatEnabledMutation.mutate({ agent: row.agent, enabled: false });
                          }
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={starting}
                        onClick={() => invokeHeartbeatMutation.mutate(row.agent)}
                      >
                        <Play className="mr-1.5 h-3.5 w-3.5" />
                        {starting ? "Starting..." : "Run now"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="rounded-[var(--radius-lg)] border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Recent activity
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            This stays summary-first. Open the linked run for transcript, logs, and workspace operations.
          </div>
        </div>
        <div className="px-5 py-4">
          {(runsQuery.data ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground">No heartbeat runs yet.</div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {(runsQuery.data ?? []).slice(0, 6).map((run) => {
                const agent = (agentsQuery.data ?? []).find((item) => item.id === run.agentId) ?? null;
                const summary = latestRunSummary(run);
                return (
                  <Link
                    key={run.id}
                    to={agent ? `/agents/${agentRouteRef(agent)}/runs/${run.id}` : agentUrl({ id: run.agentId })}
                    className="rounded-[var(--radius-md)] border border-border/80 bg-[color:color-mix(in_oklab,var(--surface-elevated)_88%,transparent)] px-4 py-3 transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_68%,transparent)]"
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                        run.status === "failed"
                          ? "bg-red-500/10 text-red-700 dark:text-red-300"
                          : run.status === "succeeded"
                            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                            : "bg-blue-500/10 text-blue-700 dark:text-blue-300",
                      )}>
                        {humanizeUnderscore(run.status)}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {agent?.name ?? "Unknown agent"}
                      </span>
                    </div>
                    {summary ? (
                      <div className="mt-2 line-clamp-2 text-sm text-foreground">
                        {summary}
                      </div>
                    ) : null}
                    <div className="mt-2 text-xs text-muted-foreground">
                      {relativeTime(run.createdAt)}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
