import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useParams, useNavigate, Link, Navigate, useBeforeUnload } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  agentsApi,
  type AgentKey,
  type ClaudeLoginResult,
  type AgentPermissionUpdate,
} from "../api/agents";
import { organizationSkillsApi } from "../api/organizationSkills";
import { budgetsApi } from "../api/budgets";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { ApiError } from "../api/client";
import {
  ChartCard,
  RunActivityChart,
  PriorityChart,
  IssueStatusChart,
  SuccessRateChart,
  SkillsUsageChart,
} from "../components/ActivityCharts";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useOrganization } from "../context/OrganizationContext";
import { useToast } from "../context/ToastContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { retryHeartbeatRun } from "../lib/heartbeat-retry";
import { queryKeys } from "../lib/queryKeys";
import { findOrganizationByPrefix } from "../lib/organization-routes";
import { describeRunReason, runReasonBadgeClassName } from "../lib/run-reason";
import { getRunFailureDisplay, getRunStderrExcerptDisplayText, shouldShowRunStderrExcerpt } from "../lib/run-detail-display";
import { AgentConfigForm } from "../components/AgentConfigForm";
import { DashboardDateRangeControl, type DashboardDatePreset } from "../components/DashboardDateRangeControl";
import { PageTabBar } from "../components/PageTabBar";
import { roleLabels, help } from "../components/agent-config-primitives";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { assetsApi } from "../api/assets";
import { getUIAdapter, buildTranscript } from "../agent-runtimes";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { MarkdownBody } from "../components/MarkdownBody";
import { CopyText } from "../components/CopyText";
import { EntityRow } from "../components/EntityRow";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { RunButton, PauseResumeButton } from "../components/AgentActionButtons";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { PackageFileTree, buildFileTree } from "../components/PackageFileTree";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { formatCents, formatDate, formatDateTime, relativeTime, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { cn } from "../lib/utils";
import { formatRunDurationLabel, formatRunTimingTitle } from "../lib/run-duration-label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs } from "@/components/ui/tabs";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MoreHorizontal,
  CheckCircle2,
  XCircle,
  Clock,
  Timer,
  Loader2,
  Slash,
  RotateCcw,
  Trash2,
  Plus,
  Key,
  Eye,
  EyeOff,
  Copy,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  HelpCircle,
  FolderOpen,
  Search,
  MessageSquare,
  Maximize2,
} from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  semanticBadgeToneClasses,
  semanticNoticeToneClasses,
} from "@/components/ui/semanticTones";
import { AgentIcon, AgentIconPicker, getAgentAvatarImageSrc } from "../components/AgentIconPicker";
import { RunTranscriptView, type TranscriptMode } from "../components/transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "../components/transcript/useLiveRunTranscripts";
import {
  getBundledRudderSkillSlug,
  isUuidLike,
  summarizeTokenUsage,
  tokenUsageCacheRatio,
  type Agent,
  type AgentSkillAnalytics,
  type AgentSkillEntry,
  type AgentSkillSnapshot,
  type AgentDetail as AgentDetailRecord,
  type BudgetPolicySummary,
  type HeartbeatRun,
  type HeartbeatRunEvent,
  type AgentRuntimeState,
  type LiveEvent,
  type OrganizationSkillCreateRequest,
  type WorkspaceOperation,
} from "@rudderhq/shared";
import { redactHomePathUserSegments, redactHomePathUserSegmentsInValue } from "@rudderhq/agent-runtime-utils";
import { agentRouteRef } from "../lib/utils";
import { heartbeatRunEventText, heartbeatRunEventToTranscriptEntry, mergeTranscriptEntries } from "../lib/run-detail-events";
import { shouldPollLiveRunBackfill } from "../lib/live-run-backfill";
import {
  arraysEqual,
  canManageSkillEntry,
  isExternalSkillEntry,
  sortSkillRowsByPinnedSelectionKey,
  sortUnique,
  toggleSkillSelection,
} from "../lib/agent-skills-state";
import { runStatusIcons, REDACTED_ENV_VALUE, SECRET_ENV_KEY_RE, JWT_VALUE_RE, formatDateInputValue, parseDateInputValue, getRecentDayKeys, getDayKeysBetween, formatRangeLabel, isWithinRange, compactSkillText, resolveSkillSummaryText, isGenericSkillRuntimeDetail, isGenericSkillLocationLabel, SkillSwitch, CreateAgentSkillDialog, shouldHideExternalSkillEntry, redactPathText, redactPathValue, formatInvocationValueForDisplay, shouldRedactSecretValue, redactEnvValue, isMarkdown, formatEnvForDisplay, LIVE_SCROLL_BOTTOM_TOLERANCE_PX, ScrollContainer, isWindowContainer, isElementScrollContainer, findScrollContainer, readScrollMetrics, scrollToContainerBottom, AgentDetailView, parseAgentDetailView, usageNumber, usageString, setsEqual, runMetrics, formatExactTokens, formatExactTokenLabel, formatCompactTokenLabel, formatCacheRatio, formatRunCostUsd, shouldShowInlineTokenLabel, RunLogChunk, utf8ByteLength, runLogChunkDedupeKey, asRecord, asNonEmptyString, readInvocationSkillList, InvocationSkillEvidence, parseStoredLogContent, RunEventsList, workspaceOperationPhaseLabel, workspaceOperationStatusTone, WorkspaceOperationStatusBadge, WorkspaceOperationLogViewer, WorkspaceOperationsSection, SummaryRow, useRunDurationNow } from "./AgentDetail.helpers";
import { KeysTab } from "./AgentDetail.keys";

export function LatestRunCard({ runs, agentId }: { runs: HeartbeatRun[]; agentId: string }) {
  const now = useRunDurationNow(runs.some((r) => r.status === "running" || r.status === "queued"));

  if (runs.length === 0) return null;

  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const liveRun = sorted.find((r) => r.status === "running" || r.status === "queued");
  const run = liveRun ?? sorted[0];
  const isLive = run.status === "running" || run.status === "queued";
  const statusInfo = runStatusIcons[run.status] ?? { icon: Clock, color: "text-neutral-400" };
  const StatusIcon = statusInfo.icon;
  const runReason = describeRunReason(run);
  const durationLabel = formatRunDurationLabel(run, now) ?? relativeTime(run.createdAt);
  const timingTitle = formatRunTimingTitle(run);
  const failureDisplay = getRunFailureDisplay(run);
  const summary = run.resultJson
    ? String((run.resultJson as Record<string, unknown>).summary ?? (run.resultJson as Record<string, unknown>).result ?? "")
    : failureDisplay
      ? `${failureDisplay.title}: ${failureDisplay.body}`
      : "";

  return (
    <div className="space-y-3">
      <div className="flex w-full items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {isLive && (
            <span className="relative flex h-2 w-2">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
            </span>
          )}
          {isLive ? "Live Run" : "Latest Run"}
        </h3>
        <Link
          to={`/agents/${agentId}/runs/${run.id}`}
          className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors no-underline"
        >
          View details &rarr;
        </Link>
      </div>

      <Link
        to={`/agents/${agentId}/runs/${run.id}`}
        className={cn(
          "block border rounded-lg p-4 space-y-2 w-full no-underline transition-colors hover:bg-muted/50 cursor-pointer",
          isLive ? "border-cyan-500/30 shadow-[0_0_12px_rgba(6,182,212,0.08)]" : "border-border"
        )}
      >
        <div className="flex items-center gap-2">
          <StatusIcon className={cn("h-3.5 w-3.5", statusInfo.color, run.status === "running" && "animate-spin")} />
          <StatusBadge status={run.status} />
          <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
          <span className={cn(
            "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            runReasonBadgeClassName(runReason.tone)
          )} title={runReason.description}>
            {runReason.label}
          </span>
          <span className="ml-auto shrink-0 text-xs font-medium tabular-nums text-foreground" title={timingTitle || undefined}>
            {durationLabel}
          </span>
        </div>

        {summary && (
          <div className="overflow-hidden max-h-16">
            <MarkdownBody className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{summary}</MarkdownBody>
          </div>
        )}
      </Link>
    </div>
  );
}

/* ---- Agent Overview (main single-page view) ---- */

export function AgentOverview({
  agent,
  runs,
  chartRuns,
  assignedIssues,
  chartIssues,
  runtimeState,
  skillAnalytics,
  agentId,
  agentRouteId,
  rangeLabel,
  chartDays,
  showDashboardFilters,
  dateFilterControl,
}: {
  agent: AgentDetailRecord;
  runs: HeartbeatRun[];
  chartRuns: HeartbeatRun[];
  assignedIssues: { id: string; title: string; status: string; priority: string; identifier?: string | null; createdAt: Date }[];
  chartIssues: { id: string; title: string; status: string; priority: string; identifier?: string | null; createdAt: Date }[];
  runtimeState?: AgentRuntimeState;
  skillAnalytics?: AgentSkillAnalytics;
  agentId: string;
  agentRouteId: string;
  rangeLabel: string;
  chartDays: string[];
  showDashboardFilters: boolean;
  dateFilterControl?: React.ReactNode;
}) {
  const visibleSkillAnalytics = skillAnalytics && skillAnalytics.totalRunsWithSkills > 0
    ? skillAnalytics
    : null;
  const shouldShowSkills = visibleSkillAnalytics !== null;

  return (
    <div className="space-y-8">
      {dateFilterControl}

      {/* Latest Run */}
      <LatestRunCard runs={runs} agentId={agentRouteId} />

      {/* Charts */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <ChartCard title="Run Activity" subtitle={`${rangeLabel} · relative daily run volume · hover for details`}>
          <RunActivityChart runs={chartRuns} days={chartDays} />
        </ChartCard>
        <ChartCard title="Issues by Priority" subtitle={`${rangeLabel} · relative daily issue volume · hover for details`}>
          <PriorityChart issues={chartIssues} days={chartDays} />
        </ChartCard>
        <ChartCard title="Issues by Status" subtitle={`${rangeLabel} · relative daily issue volume · hover for details`}>
          <IssueStatusChart issues={chartIssues} days={chartDays} />
        </ChartCard>
        <ChartCard title="Success Rate" subtitle={`${rangeLabel} · daily success rate · hover for details`}>
          <SuccessRateChart runs={chartRuns} days={chartDays} />
        </ChartCard>
      </div>

      {showDashboardFilters && shouldShowSkills ? (
        <div className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Skills</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Skill usage per run for {rangeLabel}. Hover a day to inspect the breakdown.
              </p>
            </div>
            <div className="text-right text-[11px] text-muted-foreground tabular-nums">
              <div>{visibleSkillAnalytics.totalCount} skill uses</div>
              <div>{visibleSkillAnalytics.totalRunsWithSkills} runs with skill usage</div>
            </div>
          </div>
          <SkillsUsageChart analytics={visibleSkillAnalytics} />
        </div>
      ) : null}

      {/* Recent Issues */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent Issues</h3>
          <Link
            to={`/issues?participantAgentId=${agentId}`}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            See All &rarr;
          </Link>
        </div>
        {assignedIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent issues.</p>
        ) : (
          <div className="border border-border rounded-lg">
            {assignedIssues.slice(0, 10).map((issue) => (
              <EntityRow
                key={issue.id}
                identifier={issue.identifier ?? issue.id.slice(0, 8)}
                title={issue.title}
                to={`/issues/${issue.identifier ?? issue.id}`}
                trailing={<StatusBadge status={issue.status} />}
              />
            ))}
            {assignedIssues.length > 10 && (
              <div className="px-3 py-2 text-xs text-muted-foreground text-center border-t border-border">
                +{assignedIssues.length - 10} more issues
              </div>
            )}
          </div>
        )}
      </div>

      {/* Costs */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Costs</h3>
        <CostsSection runtimeState={runtimeState} runs={runs} agentRouteId={agentRouteId} />
      </div>
    </div>
  );
}

/* ---- Costs Section (inline) ---- */

export function CostsSection({
  runtimeState,
  runs,
  agentRouteId,
}: {
  runtimeState?: AgentRuntimeState;
  runs: HeartbeatRun[];
  agentRouteId: string;
}) {
  const visibleRuns = runs
    .map((run) => ({ run, metrics: runMetrics(run) }))
    .filter(({ metrics }) => {
      return metrics.cost > 0 || metrics.input > 0 || metrics.output > 0 || metrics.cached > 0;
    })
    .sort((a, b) => new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime())
    .slice(0, 10);
  const maxTokens = Math.max(1, ...visibleRuns.map(({ metrics }) => metrics.totalTokens));
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const axisMidpoint = Math.round(maxTokens / 2);
  const runtimeTokenSummary = runtimeState
    ? summarizeTokenUsage({
        inputTokens: runtimeState.totalInputTokens,
        cachedInputTokens: runtimeState.totalCachedInputTokens,
        outputTokens: runtimeState.totalOutputTokens,
      })
    : null;
  const cacheRatio = runtimeState
    ? formatCacheRatio(runtimeState.totalCachedInputTokens, runtimeState.totalInputTokens)
    : "—";

  return (
    <div className="space-y-4">
      {runtimeState && (
        <div className="border border-border rounded-lg p-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 tabular-nums">
            <div>
              <span className="text-xs text-muted-foreground block">Prompt input</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeTokenSummary?.promptTokens ?? runtimeState.totalInputTokens)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Output tokens</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeState.totalOutputTokens)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Cached input</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeState.totalCachedInputTokens)}</span>
            </div>
            <div title="Cached input tokens divided by total prompt input tokens.">
              <span className="text-xs text-muted-foreground block">Cache ratio</span>
              <span className="text-lg font-semibold">{cacheRatio}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Total cost</span>
              <span className="text-lg font-semibold">{formatCents(runtimeState.totalCostCents)}</span>
            </div>
          </div>
        </div>
      )}
      {visibleRuns.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border" data-testid="agent-run-cost-chart">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-accent/20 px-3 py-2 text-xs text-muted-foreground">
            <span>Recent run token mix</span>
            <div className="flex items-center gap-3" data-testid="agent-run-cost-legend">
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-sky-500" />Uncached input</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-violet-500" />Cached input</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-emerald-500" />Output</span>
            </div>
          </div>
          <div className="divide-y divide-border">
            {visibleRuns.map(({ run, metrics }) => {
              const totalTokens = metrics.totalTokens;
              const barWidth = totalTokens > 0 ? Math.max(7, (totalTokens / maxTokens) * 100) : 0;
              const inputWidth = totalTokens > 0 ? (metrics.uncachedInput / totalTokens) * 100 : 0;
              const cachedWidth = totalTokens > 0 ? (metrics.cached / totalTokens) * 100 : 0;
              const outputWidth = totalTokens > 0 ? (metrics.output / totalTokens) * 100 : 0;
              const showInputLabel = shouldShowInlineTokenLabel(metrics.uncachedInput, maxTokens);
              const showCachedLabel = shouldShowInlineTokenLabel(metrics.cached, maxTokens);
              const showOutputLabel = shouldShowInlineTokenLabel(metrics.output, maxTokens);
              const runLabel = run.id.slice(0, 8);
              const costLabel = formatRunCostUsd(metrics.cost);
              const accessibleLabel = `Run ${runLabel} cost and token usage: ${formatExactTokenLabel(totalTokens)} total, ${formatExactTokenLabel(metrics.promptTokens)} prompt input, ${formatExactTokenLabel(metrics.uncachedInput)} uncached input, ${formatExactTokenLabel(metrics.cached)} cached input, ${formatExactTokenLabel(metrics.output)} output, ${costLabel} cost`;

              return (
                <TooltipProvider key={run.id} delayDuration={120}>
                  <Tooltip open={openRunId === run.id}>
                    <TooltipTrigger asChild>
                      <Link
                        to={`/agents/${agentRouteId}/runs/${run.id}`}
                        aria-label={accessibleLabel}
                        data-testid="agent-run-cost-row"
                        onFocus={() => setOpenRunId(run.id)}
                        onBlur={() => setOpenRunId((current) => current === run.id ? null : current)}
                        onMouseEnter={() => setOpenRunId(run.id)}
                        onMouseLeave={(event) => {
                          if (event.currentTarget !== document.activeElement) {
                            setOpenRunId((current) => current === run.id ? null : current);
                          }
                        }}
                        className="group grid grid-cols-[minmax(5.5rem,7rem)_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 text-xs no-underline text-inherit outline-none transition-colors hover:bg-accent/25 focus-visible:bg-accent/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      >
                        <span className="min-w-0 space-y-0.5">
                          <span className="block truncate text-muted-foreground">{formatDate(run.createdAt)}</span>
                          <span className="block font-mono tabular-nums text-foreground">{runLabel}</span>
                        </span>
                        <span
                          className="relative h-9 rounded-sm bg-muted/45"
                          style={{
                            backgroundImage:
                              "linear-gradient(to right, hsl(var(--border) / 0.75) 1px, transparent 1px)",
                            backgroundSize: "25% 100%",
                          }}
                        >
                          <span
                            className="relative z-10 flex h-full overflow-hidden rounded-sm border border-background/50 shadow-sm transition-opacity group-hover:opacity-95 group-focus-visible:opacity-95"
                            style={{ width: `${barWidth}%` }}
                          >
                            {metrics.uncachedInput > 0 ? (
                              <span
                                className="flex h-full min-w-0 items-center justify-center bg-sky-500/80 px-1 font-mono text-[11px] font-semibold tabular-nums text-white"
                                style={{ width: `${inputWidth}%` }}
                              >
                                {showInputLabel ? formatTokens(metrics.uncachedInput) : null}
                              </span>
                            ) : null}
                            {metrics.cached > 0 ? (
                              <span
                                className="flex h-full min-w-0 items-center justify-center bg-violet-500/80 px-1 font-mono text-[11px] font-semibold tabular-nums text-white"
                                style={{ width: `${cachedWidth}%` }}
                              >
                                {showCachedLabel ? formatTokens(metrics.cached) : null}
                              </span>
                            ) : null}
                            {metrics.output > 0 ? (
                              <span
                                className="flex h-full min-w-0 items-center justify-center bg-emerald-500/80 px-1 font-mono text-[11px] font-semibold tabular-nums text-white"
                                style={{ width: `${outputWidth}%` }}
                              >
                                {showOutputLabel ? formatTokens(metrics.output) : null}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <span className="min-w-[8.75rem] text-right tabular-nums">
                          <span className="block font-medium text-foreground">{formatCompactTokenLabel(totalTokens)}</span>
                          <span className="block font-mono text-[10px] text-muted-foreground">
                            in {formatTokens(metrics.promptTokens)} · cache {formatTokens(metrics.cached)} · out {formatTokens(metrics.output)}
                          </span>
                          {metrics.cost > 0 ? (
                            <span className="block font-mono text-[11px] text-muted-foreground">{costLabel}</span>
                          ) : null}
                        </span>
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="end" sideOffset={8} className="w-72 p-3 text-xs">
                      <div className="space-y-2">
                        <div>
                          <div className="font-medium text-background">Run {runLabel}</div>
                          <div className="font-mono text-[11px] text-background/70">{run.id}</div>
                          <div className="text-background/70">{formatDateTime(run.createdAt)}</div>
                        </div>
                        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
                          <dt className="text-background/70">Total tokens</dt>
                          <dd className="font-mono tabular-nums">{formatExactTokenLabel(totalTokens)}</dd>
                          <dt className="text-background/70">Prompt input</dt>
                          <dd className="font-mono tabular-nums">{formatExactTokenLabel(metrics.promptTokens)}</dd>
                          <dt className="text-background/70">Uncached input</dt>
                          <dd className="font-mono tabular-nums">{formatExactTokenLabel(metrics.uncachedInput)}</dd>
                          <dt className="text-background/70">Cached input</dt>
                          <dd className="font-mono tabular-nums">{formatExactTokenLabel(metrics.cached)}</dd>
                          <dt className="text-background/70">Output</dt>
                          <dd className="font-mono tabular-nums">{formatExactTokenLabel(metrics.output)}</dd>
                          <dt className="text-background/70">Cost</dt>
                          <dd className="font-mono tabular-nums">{costLabel}</dd>
                        </dl>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            })}
          </div>
          <div className="grid grid-cols-[minmax(5.5rem,7rem)_minmax(0,1fr)_minmax(7rem,auto)] gap-3 border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
            <span />
            <div className="flex justify-between tabular-nums">
              <span>0</span>
              <span>{formatTokens(axisMidpoint)}</span>
              <span>{formatTokens(maxTokens)}</span>
            </div>
            <span className="text-right">Token scale</span>
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          No run cost or token data yet.
        </p>
      )}
    </div>
  );
}

/* ---- Agent Configure Page ---- */

export function AgentConfigurePage({
  agent,
  agentId,
  orgId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
  updatePermissions,
}: {
  agent: AgentDetailRecord;
  agentId: string;
  orgId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
  updatePermissions: { mutate: (permissions: AgentPermissionUpdate) => void; isPending: boolean };
}) {
  const queryClient = useQueryClient();
  const [revisionsOpen, setRevisionsOpen] = useState(false);

  const { data: configRevisions } = useQuery({
    queryKey: queryKeys.agents.configRevisions(agent.id),
    queryFn: () => agentsApi.listConfigRevisions(agent.id, orgId),
  });

  const rollbackConfig = useMutation({
    mutationFn: (revisionId: string) => agentsApi.rollbackConfigRevision(agent.id, revisionId, orgId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
    },
  });

  return (
    <div className="max-w-3xl space-y-6">
      <ConfigurationTab
        agent={agent}
        onDirtyChange={onDirtyChange}
        onSaveActionChange={onSaveActionChange}
        onCancelActionChange={onCancelActionChange}
        onSavingChange={onSavingChange}
        updatePermissions={updatePermissions}
        orgId={orgId}
        hidePromptTemplate
        hideInstructionsFile
      />
      <div>
        <h3 className="text-sm font-medium mb-3">API Keys</h3>
        <KeysTab agentId={agentId} orgId={orgId} />
      </div>

      {/* Configuration Revisions — collapsible at the bottom */}
      <div>
        <button
          className="flex items-center gap-2 text-sm font-medium hover:text-foreground transition-colors"
          onClick={() => setRevisionsOpen((v) => !v)}
        >
          {revisionsOpen
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          }
          Configuration Revisions
          <span className="text-xs font-normal text-muted-foreground">{configRevisions?.length ?? 0}</span>
        </button>
        {revisionsOpen && (
          <div className="mt-3">
            {(configRevisions ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No configuration revisions yet.</p>
            ) : (
              <div className="space-y-2">
                {(configRevisions ?? []).slice(0, 10).map((revision) => (
                  <div key={revision.id} className="border border-border/70 rounded-md p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs text-muted-foreground">
                        <span className="font-mono">{revision.id.slice(0, 8)}</span>
                        <span className="mx-1">·</span>
                        <span>{formatDate(revision.createdAt)}</span>
                        <span className="mx-1">·</span>
                        <span>{revision.source}</span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        onClick={() => rollbackConfig.mutate(revision.id)}
                        disabled={rollbackConfig.isPending}
                      >
                        Restore
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Changed:{" "}
                      {revision.changedKeys.length > 0 ? revision.changedKeys.join(", ") : "no tracked changes"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Configuration Tab ---- */

export function ConfigurationTab({
  agent,
  orgId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
  updatePermissions,
  hidePromptTemplate,
  hideInstructionsFile,
}: {
  agent: AgentDetailRecord;
  orgId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
  updatePermissions: { mutate: (permissions: AgentPermissionUpdate) => void; isPending: boolean };
  hidePromptTemplate?: boolean;
  hideInstructionsFile?: boolean;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [awaitingRefreshAfterSave, setAwaitingRefreshAfterSave] = useState(false);
  const lastAgentRef = useRef(agent);

  const { data: adapterModels } = useQuery({
    queryKey:
      orgId
        ? queryKeys.agents.adapterModels(orgId, agent.agentRuntimeType)
        : ["agents", "none", "adapter-models", agent.agentRuntimeType],
    queryFn: () => agentsApi.adapterModels(orgId!, agent.agentRuntimeType),
    enabled: Boolean(orgId),
  });

  const updateAgent = useMutation({
    mutationFn: (data: Record<string, unknown>) => agentsApi.update(agent.id, data, orgId),
    onMutate: () => {
      setAwaitingRefreshAfterSave(true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agent.orgId) });
    },
    onError: (err) => {
      setAwaitingRefreshAfterSave(false);
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not save agent";
      pushToast({ title: "Save failed", body: message, tone: "error" });
    },
  });

  useEffect(() => {
    if (awaitingRefreshAfterSave && agent !== lastAgentRef.current) {
      setAwaitingRefreshAfterSave(false);
    }
    lastAgentRef.current = agent;
  }, [agent, awaitingRefreshAfterSave]);
  const isConfigSaving = updateAgent.isPending || awaitingRefreshAfterSave;

  useEffect(() => {
    onSavingChange(isConfigSaving);
  }, [onSavingChange, isConfigSaving]);

  const canCreateAgents = Boolean(agent.permissions?.canCreateAgents);
  const canAssignTasks = Boolean(agent.access?.canAssignTasks);
  const taskAssignSource = agent.access?.taskAssignSource ?? "none";
  const taskAssignLocked = agent.role === "ceo" || canCreateAgents;
  const taskAssignHint =
    taskAssignSource === "ceo_role"
      ? "Enabled automatically for CEO agents."
      : taskAssignSource === "agent_creator"
        ? "Enabled automatically while this agent can create new agents."
        : taskAssignSource === "explicit_grant"
          ? "Enabled via explicit organization permission grant."
          : "Disabled unless explicitly granted.";

  return (
    <div className="space-y-6">
      <AgentConfigForm
        mode="edit"
        agent={agent}
        onSave={(patch) => updateAgent.mutate(patch)}
        isSaving={isConfigSaving}
        adapterModels={adapterModels}
        onDirtyChange={onDirtyChange}
        onSaveActionChange={onSaveActionChange}
        onCancelActionChange={onCancelActionChange}
        hideInlineSave
        hidePromptTemplate={hidePromptTemplate}
        hideInstructionsFile={hideInstructionsFile}
        sectionLayout="cards"
      />

      <div>
        <h3 className="text-sm font-medium mb-3">Permissions</h3>
        <div className="border border-border rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between gap-4 text-sm">
            <div className="space-y-1">
              <div>Can create new agents</div>
              <p className="text-xs text-muted-foreground">
                Lets this agent create or hire agents and implicitly assign tasks.
              </p>
            </div>
            <ToggleSwitch
              checked={canCreateAgents}
              size="sm"
              tone="success"
              aria-label="Can create new agents"
              className="shrink-0"
              onClick={() =>
                updatePermissions.mutate({
                  canCreateAgents: !canCreateAgents,
                  canAssignTasks: !canCreateAgents ? true : canAssignTasks,
                })
              }
              disabled={updatePermissions.isPending}
            />
          </div>
          <div className="flex items-center justify-between gap-4 text-sm">
            <div className="space-y-1">
              <div>Can assign tasks</div>
              <p className="text-xs text-muted-foreground">
                {taskAssignHint}
              </p>
            </div>
            <ToggleSwitch
              checked={canAssignTasks}
              size="sm"
              tone="success"
              aria-label="Can assign tasks"
              className="shrink-0"
              onClick={() =>
                updatePermissions.mutate({
                  canCreateAgents,
                  canAssignTasks: !canAssignTasks,
                })
              }
              disabled={updatePermissions.isPending || taskAssignLocked}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Prompts Tab ---- */
