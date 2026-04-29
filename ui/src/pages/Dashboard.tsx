import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { goalsApi } from "../api/goals";
import { accessApi } from "../api/access";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { useOrganization } from "../context/OrganizationContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { StatusBadge } from "../components/StatusBadge";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { AgentIdentity } from "../components/AgentAvatar";
import { useLiveRunTranscripts } from "../components/transcript/useLiveRunTranscripts";
import type { TranscriptEntry } from "../agent-runtimes";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents } from "../lib/utils";
import { Bot, CalendarDays, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart, SkillsUsageChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, AgentSkillAnalytics, Issue } from "@rudderhq/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type DashboardDatePreset = "7d" | "15d" | "30d" | "custom";

const DASHBOARD_DATE_PRESETS: Array<{ key: DashboardDatePreset; label: string }> = [
  { key: "7d", label: "7D" },
  { key: "15d", label: "15D" },
  { key: "30d", label: "1M" },
  { key: "custom", label: "Custom" },
];

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function formatDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInputValue(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function getRecentDayKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const now = new Date();
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1 - index), 12, 0, 0, 0);
    return formatDateInputValue(date);
  });
}

function getDayKeysBetween(from: string, to: string): string[] {
  if (!from || !to) return [];
  const days: string[] = [];
  const cursor = parseDateInputValue(from);
  const end = parseDateInputValue(to);
  while (cursor.getTime() <= end.getTime()) {
    days.push(formatDateInputValue(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function isWithinRange(value: string | Date | null | undefined, from: string, to: string): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return false;
  if (from && timestamp < new Date(from).getTime()) return false;
  if (to && timestamp > new Date(to).getTime()) return false;
  return true;
}

function formatRangeLabel(preset: DashboardDatePreset, customFrom: string, customTo: string): string {
  if (preset === "7d") return "Last 7 days";
  if (preset === "15d") return "Last 15 days";
  if (preset === "30d") return "Last 30 days";
  if (!customFrom || !customTo) return "Custom range";

  const fromLabel = parseDateInputValue(customFrom).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const toLabel = parseDateInputValue(customTo).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return fromLabel === toLabel ? fromLabel : `${fromLabel} - ${toLabel}`;
}

function DashboardDateRangeControl({
  preset,
  customFrom,
  customTo,
  customOpen,
  onCustomOpenChange,
  onPresetSelect,
  onCustomFromChange,
  onCustomToChange,
}: {
  preset: DashboardDatePreset;
  customFrom: string;
  customTo: string;
  customOpen: boolean;
  onCustomOpenChange: (open: boolean) => void;
  onPresetSelect: (preset: DashboardDatePreset) => void;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
}) {
  return (
    <div className="flex justify-end">
      <div className="flex items-center gap-1 rounded-full border border-[color:var(--border-soft)] bg-background/90 p-1 shadow-sm">
        {DASHBOARD_DATE_PRESETS.filter((option) => option.key !== "custom").map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => onPresetSelect(option.key)}
            className={cn(
              "h-8 rounded-full px-3 text-xs font-medium transition-colors",
              preset === option.key
                ? "bg-background text-foreground shadow-sm ring-1 ring-[color:var(--border-soft)]"
                : "text-muted-foreground hover:bg-[color:var(--surface-hover)] hover:text-foreground",
            )}
            aria-pressed={preset === option.key}
          >
            {option.label}
          </button>
        ))}
        <Popover open={customOpen} onOpenChange={onCustomOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={() => onPresetSelect("custom")}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors",
                preset === "custom"
                  ? "bg-background text-foreground shadow-sm ring-1 ring-[color:var(--border-soft)]"
                  : "text-muted-foreground hover:bg-[color:var(--surface-hover)] hover:text-foreground",
              )}
              aria-pressed={preset === "custom"}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Custom
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[24rem] p-3">
            <div className="space-y-3">
              <div>
                <div className="text-sm font-medium text-foreground">Custom range</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Filter charts, skills analytics, and recent lists by a specific date window.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
                  <span>From</span>
                  <input
                    aria-label="From"
                    type="date"
                    value={customFrom}
                    onChange={(event) => onCustomFromChange(event.target.value)}
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  />
                </label>
                <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
                  <span>To</span>
                  <input
                    aria-label="To"
                    type="date"
                    value={customTo}
                    onChange={(event) => onCustomToChange(event.target.value)}
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  />
                </label>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function latestTranscriptSnippet(entries: TranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.kind === "assistant" ||
      entry.kind === "thinking" ||
      entry.kind === "stdout" ||
      entry.kind === "stderr" ||
      entry.kind === "system"
    ) {
      const text = entry.text.trim();
      if (text) return text.replace(/\s+/g, " ").slice(0, 160);
    }
    if (entry.kind === "tool_result") {
      const text = entry.content.trim();
      if (text) return text.replace(/\s+/g, " ").slice(0, 160);
    }
    if (entry.kind === "result") {
      const text = entry.text.trim();
      if (text) return text.replace(/\s+/g, " ").slice(0, 160);
    }
  }
  return null;
}

export function Dashboard() {
  const { selectedOrganizationId, organizations } = useOrganization();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const [preset, setPreset] = useState<DashboardDatePreset>("7d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const minuteTickIntervalRef = useRef<number | null>(null);
  const [minuteTick, setMinuteTick] = useState(() => new Date().toISOString().slice(0, 16));

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: currentBoardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: !!selectedOrganizationId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedOrganizationId!),
    queryFn: () => dashboardApi.summary(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedOrganizationId!),
    queryFn: () => activityApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedOrganizationId!),
    queryFn: () => issuesApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId!),
    queryFn: () => projectsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedOrganizationId!),
    queryFn: () => goalsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.heartbeats(selectedOrganizationId!),
    queryFn: () => heartbeatsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: companyLiveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedOrganizationId!), "dashboard-recent-tasks"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedOrganizationId!, 8),
    enabled: !!selectedOrganizationId,
  });

  useEffect(() => {
    const now = new Date();
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    const timeout = window.setTimeout(() => {
      setMinuteTick(new Date().toISOString().slice(0, 16));
      minuteTickIntervalRef.current = window.setInterval(
        () => setMinuteTick(new Date().toISOString().slice(0, 16)),
        60_000,
      );
    }, msToNextMinute);

    return () => {
      window.clearTimeout(timeout);
      if (minuteTickIntervalRef.current != null) window.clearInterval(minuteTickIntervalRef.current);
    };
  }, []);

  const { from, to, customReady } = useMemo(() => {
    const now = new Date();

    if (preset === "custom") {
      const fromDate = customFrom ? new Date(`${customFrom}T00:00:00`) : null;
      const toDate = customTo ? new Date(`${customTo}T23:59:59.999`) : null;
      return {
        from: fromDate ? fromDate.toISOString() : "",
        to: toDate ? toDate.toISOString() : "",
        customReady: !!customFrom && !!customTo,
      };
    }

    const days = preset === "7d" ? 7 : preset === "15d" ? 15 : 30;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0);
    return {
      from: start.toISOString(),
      to: now.toISOString(),
      customReady: true,
    };
  }, [customFrom, customTo, minuteTick, preset]);

  const chartDays = useMemo(() => {
    if (preset === "7d") return getRecentDayKeys(7);
    if (preset === "15d") return getRecentDayKeys(15);
    if (preset === "30d") return getRecentDayKeys(30);
    return getDayKeysBetween(customFrom, customTo);
  }, [customFrom, customTo, preset]);

  const rangeLabel = useMemo(
    () => formatRangeLabel(preset as DashboardDatePreset, customFrom, customTo),
    [customFrom, customTo, preset],
  );

  const showFilteredSections = preset !== "custom" || customReady;

  const { data: skillAnalytics } = useQuery({
    queryKey: [
      ...queryKeys.dashboardSkillsAnalytics(selectedOrganizationId ?? "__none__"),
      preset,
      customFrom,
      customTo,
    ],
    queryFn: () => dashboardApi.skillsAnalytics(selectedOrganizationId!, {
      ...(preset === "custom" && customReady
        ? { startDate: customFrom, endDate: customTo }
        : { windowDays: preset === "7d" ? 7 : preset === "15d" ? 15 : 30 }),
    }),
    enabled: Boolean(selectedOrganizationId) && showFilteredSections,
  });

  const visibleSkillAnalytics: AgentSkillAnalytics | null = skillAnalytics && skillAnalytics.totalRunsWithSkills > 0
    ? skillAnalytics
    : null;

  const filteredRuns = useMemo(
    () => (runs ?? []).filter((run) => isWithinRange(run.createdAt, from, to)),
    [from, runs, to],
  );
  const filteredIssuesForCharts = useMemo(
    () => (issues ?? []).filter((issue) => isWithinRange(issue.createdAt, from, to)),
    [from, issues, to],
  );
  const recentIssues = useMemo(
    () =>
      getRecentIssues(issues ?? [])
        .filter((issue) => isWithinRange(issue.updatedAt, from, to))
        .slice(0, 10),
    [from, issues, to],
  );
  const recentActivity = useMemo(
    () =>
      (activity ?? [])
        .filter((event) => isWithinRange(event.createdAt, from, to))
        .slice(0, 10),
    [activity, from, to],
  );

  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) {
      window.clearTimeout(timer);
    }
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedOrganizationId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;

    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((event) => event.id);

    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }

    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      for (const id of currentIds) seen.add(id);
      return;
    }

    setAnimatedActivityIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });

    for (const id of newIds) seen.add(id);

    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => {
    return () => {
      for (const timer of activityAnimationTimersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const liveRunByIssueId = useMemo(() => {
    const map = new Map<string, LiveRunForIssue>();
    for (const run of companyLiveRuns ?? []) {
      if (!run.issueId) continue;
      if (!map.has(run.issueId)) {
        map.set(run.issueId, run);
      }
    }
    return map;
  }, [companyLiveRuns]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: companyLiveRuns ?? [],
    orgId: selectedOrganizationId,
    maxChunksPerRun: 80,
  });

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    for (const g of goals ?? []) map.set(`goal:${g.id}`, g.title);
    return map;
  }, [issues, agents, projects, goals]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const handlePresetSelect = (nextPreset: DashboardDatePreset) => {
    if (nextPreset === "custom") {
      if (!customFrom || !customTo) {
        const today = new Date();
        const lastWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
        setCustomFrom(formatDateInputValue(lastWeek));
        setCustomTo(formatDateInputValue(today));
      }
      setPreset("custom");
      setCustomRangeOpen(true);
      return;
    }

    setCustomRangeOpen(false);
    setPreset(nextPreset);
  };

  if (!selectedOrganizationId) {
    if (organizations.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Rudder. Set up your first organization and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a organization to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      <DashboardDateRangeControl
        preset={preset as DashboardDatePreset}
        customFrom={customFrom}
        customTo={customTo}
        customOpen={customRangeOpen}
        onCustomOpenChange={setCustomRangeOpen}
        onPresetSelect={handlePresetSelect}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
      />

      {hasNoAgents && (
        <div className="surface-proposal flex items-center justify-between gap-3 rounded-[var(--radius-lg)] px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 shrink-0 text-[color:var(--accent-strong)]" />
            <p className="text-sm text-foreground">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, orgId: selectedOrganizationId! })}
            className="shrink-0 text-sm font-medium text-[color:var(--accent-strong)] underline underline-offset-2"
          >
            Create one here
          </button>
        </div>
      )}

      <ActiveAgentsPanel orgId={selectedOrganizationId!} />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-[var(--radius-lg)] border border-red-500/20 bg-[linear-gradient(180deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))] px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-800 dark:text-red-50">
                    {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-red-700/80 dark:text-red-100/70">
                    {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-700 dark:text-red-100">
                Open budgets
              </Link>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard
              icon={Bot}
              value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
              label="Agents Enabled"
              to="/agents"
              description={
                <span>
                  {data.agents.running} running{", "}
                  {data.agents.paused} paused{", "}
                  {data.agents.error} errors
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label="Tasks In Progress"
              to="/issues"
              description={
                <span>
                  {data.tasks.open} open{", "}
                  {data.tasks.blocked} blocked
                </span>
              }
            />
            <MetricCard
              icon={DollarSign}
              value={formatCents(data.costs.monthSpendCents)}
              label="Month Spend"
              to="/costs"
              description={
                <span>
                  {data.costs.monthBudgetCents > 0
                    ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                    : "Unlimited budget"}
                </span>
              }
            />
            <MetricCard
              icon={ShieldCheck}
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label="Pending Approvals"
              to="/messenger/approvals"
              description={
                <span>
                  {data.budgets.pendingApprovals > 0
                    ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
                    : "Awaiting board review"}
                </span>
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <ChartCard title="Run Activity" subtitle={`${rangeLabel} · relative daily run volume · hover for details`}>
              {showFilteredSections ? (
                <RunActivityChart runs={filteredRuns} days={chartDays} />
              ) : (
                <p className="text-xs text-muted-foreground">Select a start and end date to filter dashboard activity.</p>
              )}
            </ChartCard>
            <ChartCard title="Issues by Priority" subtitle={`${rangeLabel} · relative daily issue volume · hover for details`}>
              {showFilteredSections ? (
                <PriorityChart issues={filteredIssuesForCharts} days={chartDays} />
              ) : (
                <p className="text-xs text-muted-foreground">Select a start and end date to filter dashboard activity.</p>
              )}
            </ChartCard>
            <ChartCard title="Issues by Status" subtitle={`${rangeLabel} · relative daily issue volume · hover for details`}>
              {showFilteredSections ? (
                <IssueStatusChart issues={filteredIssuesForCharts} days={chartDays} />
              ) : (
                <p className="text-xs text-muted-foreground">Select a start and end date to filter dashboard activity.</p>
              )}
            </ChartCard>
            <ChartCard title="Success Rate" subtitle={`${rangeLabel} · daily success rate · hover for details`}>
              {showFilteredSections ? (
                <SuccessRateChart runs={filteredRuns} days={chartDays} />
              ) : (
                <p className="text-xs text-muted-foreground">Select a start and end date to filter dashboard activity.</p>
              )}
            </ChartCard>
          </div>

          {showFilteredSections && visibleSkillAnalytics ? (
            <div className="space-y-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium">Skills</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Loaded skills per run for {rangeLabel} across all agents. Hover a day to inspect the breakdown.
                  </p>
                </div>
                <div className="text-right text-[11px] text-muted-foreground tabular-nums">
                  <div>{visibleSkillAnalytics.totalCount} skill loads</div>
                  <div>{visibleSkillAnalytics.totalRunsWithSkills} runs with skill metadata</div>
                </div>
              </div>
              <SkillsUsageChart analytics={visibleSkillAnalytics} />
            </div>
          ) : null}

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ orgId: selectedOrganizationId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="surface-panel rounded-[var(--radius-lg)] p-4"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {showFilteredSections && (
              <div className="min-w-0">
                <h3 className="mb-3 text-sm font-semibold tracking-[0.04em] text-muted-foreground">
                  Recent Activity
                </h3>
                {recentActivity.length === 0 ? (
                  <div className="surface-panel rounded-[var(--radius-lg)] p-4">
                    <p className="text-sm text-muted-foreground">No activity in this range.</p>
                  </div>
                ) : (
                  <div className="surface-panel overflow-hidden rounded-[var(--radius-lg)] divide-y divide-[color:var(--border-soft)]">
                    {recentActivity.map((event) => (
                      <ActivityRow
                        key={event.id}
                        event={event}
                        agentMap={agentMap}
                        entityNameMap={entityNameMap}
                        entityTitleMap={entityTitleMap}
                        currentBoardUserId={currentBoardAccess?.user?.id ?? currentBoardAccess?.userId}
                        className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Recent Tasks */}
            <div className="min-w-0">
              <h3 className="mb-3 text-sm font-semibold tracking-[0.04em] text-muted-foreground">
                Recent Tasks
              </h3>
              {!showFilteredSections ? (
                <div className="surface-panel rounded-[var(--radius-lg)] p-4">
                  <p className="text-sm text-muted-foreground">Select a start and end date to filter recent tasks.</p>
                </div>
              ) : recentIssues.length === 0 ? (
                <div className="surface-panel rounded-[var(--radius-lg)] p-4">
                  <p className="text-sm text-muted-foreground">No tasks in this range.</p>
                </div>
              ) : (
                <div className="surface-panel overflow-hidden rounded-[var(--radius-lg)] divide-y divide-[color:var(--border-soft)]">
                  {recentIssues.map((issue) => (
                    (() => {
                      const liveRun = liveRunByIssueId.get(issue.id);
                      const effectiveStatus = liveRun?.status ?? issue.status;
                      const transcript = liveRun ? (transcriptByRun.get(liveRun.id) ?? []) : [];
                      const snippet = liveRun ? latestTranscriptSnippet(transcript) : null;
                      const waitingCopy = liveRun
                        ? hasOutputForRun(liveRun.id)
                          ? "Waiting for transcript parsing..."
                          : liveRun.status === "queued"
                            ? "Queued. Waiting for output..."
                            : "Running. Waiting for output..."
                        : null;
                      const displayAgentId = liveRun?.agentId ?? issue.assigneeAgentId;
                      const displayAgentName = displayAgentId ? agentName(displayAgentId) : null;
                      const displayAgent = displayAgentId ? agentMap.get(displayAgentId) ?? null : null;

                      return (
                        <Link
                          key={issue.id}
                          to={`/issues/${issue.identifier ?? issue.id}`}
                          className={cn(
                            "block cursor-pointer px-4 py-3 text-sm text-inherit no-underline transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-active)_56%,transparent)]",
                            liveRun && "bg-[color:color-mix(in_oklab,var(--surface-proposal)_68%,transparent)]",
                          )}
                        >
                          <div className="flex flex-col gap-1.5">
                            <div className="flex items-start gap-2">
                              <span className="shrink-0 sm:hidden">
                                <StatusIcon status={issue.status} />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="line-clamp-2 text-sm sm:line-clamp-1">{issue.title}</div>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                  <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} /></span>
                                  <span className="font-mono">
                                    {issue.identifier ?? issue.id.slice(0, 8)}
                                  </span>
                                  <StatusBadge status={effectiveStatus} />
                                  {displayAgentName ? (
                                    displayAgent ? (
                                      <AgentIdentity name={displayAgentName} icon={displayAgent.icon} size="sm" />
                                    ) : (
                                      <Identity name={displayAgentName} size="sm" />
                                    )
                                  ) : null}
                                  <span className="shrink-0">{timeAgo(issue.updatedAt)}</span>
                                </div>
                              </div>
                            </div>
                            {liveRun ? (
                              <div className="surface-inset ml-6 rounded-[var(--radius-md)] px-2.5 py-2 text-xs text-muted-foreground sm:ml-0">
                                <span className="font-medium text-[color:var(--accent-strong)]">
                                  {liveRun.status === "queued" ? "Queued" : "Running"}
                                </span>
                                {" · "}
                                {snippet ?? waitingCopy}
                              </div>
                            ) : null}
                          </div>
                        </Link>
                      );
                    })()
                  ))}
                </div>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );
}
