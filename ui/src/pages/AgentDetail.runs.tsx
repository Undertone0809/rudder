import { Button } from "@/components/ui/button";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import {
  toAgentRun,
  type AgentRunScene,
  type AgentRunTargetType,
  type HeartbeatRun
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  Clock,
  RotateCcw
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { activityApi } from "../api/activity";
import {
  agentsApi,
  type ClaudeLoginResult
} from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { CopyText } from "../components/CopyText";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusBadge } from "../components/StatusBadge";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { useToast } from "../context/ToastContext";
import { retryHeartbeatRun } from "../lib/heartbeat-retry";
import { queryKeys } from "../lib/queryKeys";
import {
  GENERIC_RUN_FAILURE_BODY,
  getRunFailureDisplay,
  getRunStderrExcerptDisplayText,
  shouldShowRunStderrExcerpt,
} from "../lib/run-detail-display";
import { formatRunDurationLabel, formatRunOccurrenceLabel, formatRunTimingTitle } from "../lib/run-duration-label";
import { describeRunReason, runReasonBadgeClassName } from "../lib/run-reason";
import { cn, formatTokens, relativeTime } from "../lib/utils";
import { RunChatContextCard } from "./AgentDetail.chat-context";
import { asNonEmptyString, asRecord, formatCompactTokenLabel, runMetrics, runStatusIcons, useRunDurationNow } from "./AgentDetail.helpers";
import {
  appendRunSearchParams,
  applyRunFilters,
  applyRunSort,
  hasRunFilters,
  parseRunFilterState,
  runFilterChips,
  RunFiltersToolbar,
  writeRunFilterState,
} from "./AgentDetail.run-filters";
import { LogViewer } from "./AgentDetail.run-log";

export function getRunListSummary(run: HeartbeatRun): string {
  const failureDisplay = getRunFailureDisplay(run);
  if (run.status === "failed" || run.status === "timed_out") {
    return failureDisplay?.body ?? GENERIC_RUN_FAILURE_BODY;
  }
  if (run.resultJson) {
    return String((run.resultJson as Record<string, unknown>).summary ?? (run.resultJson as Record<string, unknown>).result ?? "");
  }
  return failureDisplay?.body ?? "";
}

const runSceneLabels: Record<AgentRunScene, string> = {
  issue: "Issue",
  chat: "Chat",
  automation: "Automation",
  review: "Review",
  manual: "Manual",
  heartbeat: "Heartbeat",
};

const runTargetLabels: Record<AgentRunTargetType, string> = {
  issue: "Issue",
  chat_conversation: "Chat conversation",
  chat_message: "Chat message",
  automation_run: "Automation run",
  wakeup_request: "Wakeup request",
  manual: "Manual",
};

export function runDetailFacts(run: HeartbeatRun) {
  const agentRun = toAgentRun(run);
  const facts: Array<{ label: string; value: string; href?: string }> = [
    { label: "Scene", value: runSceneLabels[agentRun.scene] },
    { label: "Target", value: runTargetLabels[agentRun.targetType] },
  ];
  if (agentRun.targetId) {
    facts.push({
      label: "Target ID",
      value: agentRun.targetId,
      href: agentRun.targetType === "issue" ? `/issues/${agentRun.targetId}` : undefined,
    });
  }
  if (agentRun.automationId) {
    facts.push({ label: "Automation", value: agentRun.automationId, href: `/automations/${agentRun.automationId}` });
  }
  if (agentRun.conversationId) {
    facts.push({ label: "Conversation", value: agentRun.conversationId, href: `/messenger/chat/${agentRun.conversationId}` });
  }
  if (agentRun.messageId) facts.push({ label: "Message", value: agentRun.messageId });
  return facts;
}

export function RunListItem({ run, isSelected, agentId }: { run: HeartbeatRun; isSelected: boolean; agentId: string }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { pushToast } = useToast();
  const statusInfo = runStatusIcons[run.status] ?? { icon: Clock, color: "text-neutral-400" };
  const StatusIcon = statusInfo.icon;
  const metrics = runMetrics(run);
  const summary = getRunListSummary(run);
  const runLabel = run.id.slice(0, 8);
  const runReason = describeRunReason(run);
  const destination = appendRunSearchParams(
    isSelected ? `/agents/${agentId}/runs` : `/agents/${agentId}/runs/${run.id}`,
    searchParams,
  );
  const isActive = run.status === "running" || run.status === "queued";
  const now = useRunDurationNow(isActive);
  const durationLabel = formatRunDurationLabel(run, now) ?? relativeTime(run.createdAt);
  const occurrenceLabel = formatRunOccurrenceLabel(run, now);
  const timingTitle = formatRunTimingTitle(run);

  const openRun = () => {
    navigate(destination);
  };

  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openRun();
  };

  const handleCopyRunId = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(run.id);
      pushToast({
        title: "Run ID copied",
        body: "The full agent run ID is now in your clipboard.",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "Could not copy run ID",
        body: error instanceof Error ? error.message : "Clipboard access was denied.",
        tone: "error",
      });
    }
  };

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Open run ${runLabel}${occurrenceLabel ? ` from ${occurrenceLabel}` : ""}${durationLabel ? `, ${durationLabel}` : ""}`}
      className={cn(
        "flex flex-col gap-1 w-full px-3 py-2.5 text-left border-b border-border last:border-b-0 transition-colors no-underline text-inherit",
        isSelected ? "bg-accent/40" : "hover:bg-accent/20",
      )}
      onClick={openRun}
      onKeyDown={handleRowKeyDown}
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", statusInfo.color, run.status === "running" && "animate-spin")} />
          <button
            type="button"
            className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-foreground transition-colors cursor-copy"
            aria-label={`Copy run ID ${runLabel}`}
            title="Copy run ID"
            onClick={handleCopyRunId}
          >
            {runLabel}
          </button>
          <span className={cn(
            "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0",
            runReasonBadgeClassName(runReason.tone)
          )} title={runReason.description}>
            {runReason.label}
          </span>
        </span>
        <span
          className="flex shrink-0 flex-col items-end gap-0.5 text-right tabular-nums"
          title={timingTitle || undefined}
          data-testid="run-list-timing"
        >
          {occurrenceLabel && (
            <span className="whitespace-nowrap text-[11px] font-semibold leading-none text-foreground">
              {occurrenceLabel}
            </span>
          )}
          {durationLabel && (
            <span className="whitespace-nowrap text-[10px] font-medium leading-none text-muted-foreground">
              {durationLabel}
            </span>
          )}
        </span>
      </div>
      {summary && (
        <span className="text-xs text-muted-foreground truncate pl-5.5">
          {summary.slice(0, 60)}
        </span>
      )}
      {(metrics.totalTokens > 0 || metrics.cost > 0) && (
        <div className="flex items-center gap-2 pl-5.5 text-[11px] text-muted-foreground tabular-nums">
          {metrics.totalTokens > 0 && <span>{formatCompactTokenLabel(metrics.totalTokens)}</span>}
          {metrics.cost > 0 && <span>${metrics.cost.toFixed(3)}</span>}
        </div>
      )}
    </div>
  );
}

export function RunsTab({
  runs,
  orgId,
  agentId,
  agentRouteId,
  selectedRunId,
  agentRuntimeType,
}: {
  runs: HeartbeatRun[];
  orgId: string;
  agentId: string;
  agentRouteId: string;
  selectedRunId: string | null;
  agentRuntimeType: string;
}) {
  const { isMobile } = useSidebar();
  const [searchParams, setSearchParams] = useSearchParams();
  const filterState = useMemo(() => parseRunFilterState(searchParams), [searchParams]);

  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  // Sort by created descending
  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const filtered = applyRunSort(applyRunFilters(sorted, filterState), filterState.sort);
  const activeFilterChips = runFilterChips(filterState);
  const filtersActive = hasRunFilters(filterState);
  const updateRunFilters = (patch: Parameters<typeof writeRunFilterState>[1]) => {
    setSearchParams((current) => writeRunFilterState(current, patch), { replace: true });
  };
  const clearRunFilters = () => {
    setSearchParams((current) => writeRunFilterState(current, {
      view: "all",
      q: "",
      statuses: [],
      sources: [],
      scenes: [],
      targets: [],
      contexts: [],
      skills: [],
      date: "all",
      cost: [],
    }), { replace: true });
  };

  // On mobile, don't auto-select so the list shows first; on desktop, auto-select latest
  const effectiveRunId = isMobile ? selectedRunId : (selectedRunId ?? filtered[0]?.id ?? sorted[0]?.id ?? null);
  const selectedRun = sorted.find((r) => r.id === effectiveRunId) ?? null;
  const selectedRunOutsideFilters = Boolean(selectedRun && filtersActive && !filtered.some((run) => run.id === selectedRun.id));
  const listRuns = selectedRunOutsideFilters && selectedRun
    ? [selectedRun, ...filtered.filter((run) => run.id !== selectedRun.id)]
    : filtered;
  const listEmptyMessage = filtersActive
    ? "No runs match the current filters."
    : "No runs yet.";
  const toolbar = (
    <RunFiltersToolbar
      runs={sorted}
      filteredCount={filtered.length}
      state={filterState}
      onChange={updateRunFilters}
      onClear={clearRunFilters}
    />
  );

  // Mobile: show either run list OR run detail with back button
  if (isMobile) {
    if (selectedRun) {
      return (
        <div className="space-y-3 min-w-0 overflow-x-hidden">
          {toolbar}
          <Link
            to={appendRunSearchParams(`/agents/${agentRouteId}/runs`, searchParams)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to runs
          </Link>
          <RunDetail key={selectedRun.id} run={selectedRun} agentRouteId={agentRouteId} agentRuntimeType={agentRuntimeType} />
        </div>
      );
    }
    return (
      <div className="space-y-3">
        {toolbar}
        {activeFilterChips.length > 0 && (
          <RunFilterChipRow chips={activeFilterChips} onClear={clearRunFilters} />
        )}
        <div className="border border-border rounded-lg overflow-x-hidden" data-testid="agent-runs-list-pane">
          {listRuns.length > 0 ? listRuns.map((run) => (
            <RunListItem key={run.id} run={run} isSelected={false} agentId={agentRouteId} />
          )) : (
            <RunListEmptyState message={listEmptyMessage} />
          )}
        </div>
      </div>
    );
  }

  if (!selectedRun) {
    return (
      <div className="space-y-3">
        {toolbar}
        {activeFilterChips.length > 0 && (
          <RunFilterChipRow chips={activeFilterChips} onClear={clearRunFilters} />
        )}
        <div className="border border-border rounded-lg overflow-x-hidden" data-testid="agent-runs-list-pane">
          {listRuns.length > 0 ? listRuns.map((run) => (
            <RunListItem key={run.id} run={run} isSelected={false} agentId={agentRouteId} />
          )) : (
            <RunListEmptyState message={listEmptyMessage} />
          )}
        </div>
      </div>
    );
  }

  // Desktop: detail pane first, compact navigation rail on the right.
  return (
    <div className="min-w-0">
      {toolbar}
      {activeFilterChips.length > 0 && (
        <RunFilterChipRow chips={activeFilterChips} onClear={clearRunFilters} className="mb-3 justify-end" />
      )}
      <div className="flex min-w-0 items-start gap-4">
        <div className="min-w-0 flex-1 basis-0" data-testid="agent-runs-detail-pane">
          <RunDetail key={selectedRun.id} run={selectedRun} agentRouteId={agentRouteId} agentRuntimeType={agentRuntimeType} />
        </div>

        <div
          className="w-[clamp(18rem,24vw,24rem)] shrink-0 border border-border rounded-lg"
          data-testid="agent-runs-list-pane"
        >
          <div className="sticky top-4 overflow-y-auto" style={{ maxHeight: "calc(100vh - 2rem)" }}>
            {selectedRunOutsideFilters && (
              <div className="border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Selected run is outside the current filters.
              </div>
            )}
            {listRuns.length > 0 ? listRuns.map((run) => (
              <RunListItem key={run.id} run={run} isSelected={run.id === effectiveRunId} agentId={agentRouteId} />
            )) : (
              <RunListEmptyState message={listEmptyMessage} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunFilterChipRow({ chips, onClear, className }: { chips: string[]; onClear: () => void; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {chips.map((chip) => (
        <span key={chip} className="inline-flex h-6 items-center rounded-md border border-border bg-muted/30 px-2 text-xs text-muted-foreground">
          {chip}
        </span>
      ))}
      <button type="button" className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}

function RunListEmptyState({ message }: { message: string }) {
  return (
    <div className="px-3 py-6 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

/* ---- Run Detail (expanded) ---- */

export function RunDetail({ run: initialRun, agentRouteId, agentRuntimeType }: { run: HeartbeatRun; agentRouteId: string; agentRuntimeType: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { confirm } = useDialog();
  const { data: hydratedRun } = useQuery({
    queryKey: queryKeys.runDetail(initialRun.id),
    queryFn: () => heartbeatsApi.get(initialRun.id),
    enabled: Boolean(initialRun.id),
  });
  const run = hydratedRun ?? initialRun;
  const metrics = runMetrics(run);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [claudeLoginResult, setClaudeLoginResult] = useState<ClaudeLoginResult | null>(null);

  useEffect(() => {
    setClaudeLoginResult(null);
  }, [run.id]);

  const cancelRun = useMutation({
    mutationFn: () => heartbeatsApi.cancel(run.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.orgId, run.agentId) });
    },
  });
  const canResumeLostRun = run.errorCode === "process_lost" && run.status === "failed";
  const canRetryRun = run.status === "failed" || run.status === "timed_out" || run.status === "cancelled";
  const recoverRun = useMutation({
    mutationFn: async () => retryHeartbeatRun(run),
    onSuccess: (newRun) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.orgId, run.agentId) });
      navigate(appendRunSearchParams(`/agents/${agentRouteId}/runs/${newRun.id}`, searchParams));
    },
  });

  const { data: touchedIssues } = useQuery({
    queryKey: queryKeys.runIssues(run.id),
    queryFn: () => activityApi.issuesForRun(run.id),
  });
  const touchedIssueIds = useMemo(
    () => Array.from(new Set((touchedIssues ?? []).map((issue) => issue.issueId))),
    [touchedIssues],
  );
  const stderrExcerptDisplayText = getRunStderrExcerptDisplayText(run);
  const failureDisplay = getRunFailureDisplay(run);

  const clearSessionsForTouchedIssues = useMutation({
    mutationFn: async () => {
      if (touchedIssueIds.length === 0) return 0;
      await Promise.all(touchedIssueIds.map((issueId) => agentsApi.resetSession(run.agentId, issueId, run.orgId)));
      return touchedIssueIds.length;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(run.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(run.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.runIssues(run.id) });
    },
  });

  const runClaudeLogin = useMutation({
    mutationFn: () => agentsApi.loginWithClaude(run.agentId, run.orgId),
    onSuccess: (data) => {
      setClaudeLoginResult(data);
    },
  });

  const isRunActive = run.status === "queued" || (run.status === "running" && !run.finishedAt);
  const durationNow = useRunDurationNow(isRunActive);
  const durationLabel = formatRunDurationLabel(run, durationNow);
  const timingTitle = formatRunTimingTitle(run);
  const timeFormat: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
  const startTime = run.startedAt ? new Date(run.startedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const endTime = run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const hasMetrics = metrics.input > 0 || metrics.output > 0 || metrics.cached > 0 || metrics.cost > 0;
  const facts = runDetailFacts(run);
  const hasSession = !!(run.sessionIdBefore || run.sessionIdAfter);
  const sessionChanged = run.sessionIdBefore && run.sessionIdAfter && run.sessionIdBefore !== run.sessionIdAfter;
  const hasNonZeroExit = run.exitCode !== null && run.exitCode !== 0;
  const recoveryContext = asRecord(asRecord(run.contextSnapshot)?.recovery);
  const recoveryOriginalRunId =
    asNonEmptyString(recoveryContext?.originalRunId) ?? run.retryOfRunId;
  const recoveryFailureKind = asNonEmptyString(recoveryContext?.failureKind);
  const recoveryFailureSummary = asNonEmptyString(recoveryContext?.failureSummary);
  const recoveryTrigger = asNonEmptyString(recoveryContext?.recoveryTrigger);
  const recoveryMode = asNonEmptyString(recoveryContext?.recoveryMode);
  const passiveFollowupContext = asRecord(asRecord(run.contextSnapshot)?.passiveFollowup);
  const passiveFollowupOriginRunId = asNonEmptyString(passiveFollowupContext?.originRunId);
  const passiveFollowupPreviousRunId = asNonEmptyString(passiveFollowupContext?.previousRunId);
  const passiveFollowupReason = asNonEmptyString(passiveFollowupContext?.reason);
  const passiveFollowupAttempt = typeof passiveFollowupContext?.attempt === "number" ? passiveFollowupContext.attempt : null;
  const passiveFollowupMaxAttempts =
    typeof passiveFollowupContext?.maxAttempts === "number" ? passiveFollowupContext.maxAttempts : null;
  const runActionButton = (() => {
    if (run.status === "running" || run.status === "queued") {
      return (
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs text-destructive hover:text-destructive"
          onClick={() => cancelRun.mutate()}
          disabled={cancelRun.isPending}
        >
          {cancelRun.isPending ? "Cancelling..." : "Cancel"}
        </Button>
      );
    }
    if (canResumeLostRun) {
      return (
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs"
          onClick={() => recoverRun.mutate()}
          disabled={recoverRun.isPending}
          data-testid="run-detail-retry"
        >
          <RotateCcw className="h-3.5 w-3.5 mr-1" />
          {recoverRun.isPending ? "Resuming..." : "Resume"}
        </Button>
      );
    }
    if (canRetryRun) {
      return (
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs"
          onClick={() => recoverRun.mutate()}
          disabled={recoverRun.isPending}
          data-testid="run-detail-retry"
        >
          <RotateCcw className="h-3.5 w-3.5 mr-1" />
          {recoverRun.isPending ? "Retrying..." : "Retry"}
        </Button>
      );
    }
    return null;
  })();

  return (
    <div className="space-y-4 min-w-0">
      {/* Run summary card */}
      <div className="border border-border rounded-lg overflow-hidden" data-testid="run-summary-card">
        <div className="flex flex-col sm:flex-row">
          {/* Left column: status + timing */}
          <div className="min-w-0 flex-1 p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <StatusBadge status={run.status} />
              </div>
              {runActionButton && (
                <div className="shrink-0">
                  {runActionButton}
                </div>
              )}
            </div>
            {recoverRun.isError && (
              <div className="text-xs text-destructive">
                {recoverRun.error instanceof Error ? recoverRun.error.message : "Failed to recover run"}
              </div>
            )}
            {(durationLabel || startTime) && (
              <div className="space-y-0.5">
                {durationLabel && (
                  <div className="text-sm font-medium tabular-nums">
                    {durationLabel}
                  </div>
                )}
                {startTime && (
                  <div className="text-[11px] text-muted-foreground" title={timingTitle || undefined}>
                    <span className="font-mono">{startTime}</span>
                    {endTime && (
                      <>
                        <span> &rarr; </span>
                        <span className="font-mono">{endTime}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {failureDisplay && (
              <div className="text-xs">
                <div className={cn(
                  "font-medium",
                  failureDisplay.tone === "neutral"
                    ? "text-muted-foreground"
                    : "text-red-600 dark:text-red-400",
                )}>
                  {failureDisplay.title}
                </div>
                <span className={failureDisplay.tone === "neutral" ? "text-muted-foreground" : "text-red-600 dark:text-red-400"}>
                  {failureDisplay.body}
                </span>
                {failureDisplay.code && <span className="text-muted-foreground ml-1">({failureDisplay.code})</span>}
                {failureDisplay.actionPath && failureDisplay.actionLabel && (
                  <div className="mt-1">
                    <Link to={failureDisplay.actionPath} className="text-xs font-medium text-red-700 underline dark:text-red-300">
                      {failureDisplay.actionLabel}
                    </Link>
                  </div>
                )}
              </div>
            )}
            {run.errorCode === "claude_auth_required" && agentRuntimeType === "claude_local" && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => runClaudeLogin.mutate()}
                  disabled={runClaudeLogin.isPending}
                >
                  {runClaudeLogin.isPending ? "Running Claude auth login..." : "Login to Claude Code"}
                </Button>
                {runClaudeLogin.isError && (
                  <p className="text-xs text-destructive">
                    {runClaudeLogin.error instanceof Error
                      ? runClaudeLogin.error.message
                      : "Failed to run Claude login"}
                  </p>
                )}
                {claudeLoginResult?.loginUrl && (
                  <p className="text-xs">
                    Login URL:
                    <a
                      href={claudeLoginResult.loginUrl}
                      className="text-blue-600 underline underline-offset-2 ml-1 break-all dark:text-blue-400"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {claudeLoginResult.loginUrl}
                    </a>
                  </p>
                )}
                {claudeLoginResult && (
                  <>
                    {!!claudeLoginResult.stdout && (
                      <pre className="min-w-0 max-w-full bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap break-words">
                        {claudeLoginResult.stdout}
                      </pre>
                    )}
                    {!!claudeLoginResult.stderr && (
                      <pre className="min-w-0 max-w-full bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap break-words">
                        {claudeLoginResult.stderr}
                      </pre>
                    )}
                  </>
                )}
              </div>
            )}
            {hasNonZeroExit && (
              <div className="text-xs text-red-600 dark:text-red-400">
                Exit code {run.exitCode}
                {run.signal && <span className="text-muted-foreground ml-1">(signal: {run.signal})</span>}
              </div>
            )}
            {facts.length > 0 && (
              <div className="grid gap-1.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs sm:grid-cols-2" data-testid="run-agent-run-facts">
                {facts.map((fact) => (
                  <div key={`${fact.label}:${fact.value}`} className="min-w-0">
                    <div className="text-[11px] text-muted-foreground">{fact.label}</div>
                    {fact.href ? (
                      <Link className="block truncate font-medium text-foreground underline-offset-2 hover:underline" title={fact.value} to={fact.href}>
                        {fact.value}
                      </Link>
                    ) : (
                      <div className="truncate font-medium text-foreground" title={fact.value}>{fact.value}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {recoveryOriginalRunId && (
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs space-y-1">
                <div className="font-medium text-foreground">Recovery</div>
                <div className="text-muted-foreground">
                  From run{" "}
                  <Link className="underline underline-offset-2" to={appendRunSearchParams(`/agents/${run.agentId}/runs/${recoveryOriginalRunId}`, searchParams)}>
                    {recoveryOriginalRunId}
                  </Link>
                </div>
                {(recoveryTrigger || recoveryMode) && (
                  <div className="text-muted-foreground">
                    {[recoveryTrigger, recoveryMode].filter(Boolean).join(" · ")}
                  </div>
                )}
                {(recoveryFailureKind || recoveryFailureSummary) && (
                  <div className="text-muted-foreground">
                    {[recoveryFailureKind, recoveryFailureSummary].filter(Boolean).join(": ")}
                  </div>
                )}
              </div>
            )}
            {passiveFollowupOriginRunId && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs space-y-1">
                <div className="font-medium text-foreground">Passive follow-up</div>
                <div className="text-muted-foreground">
                  Origin run{" "}
                  <Link className="underline underline-offset-2" to={appendRunSearchParams(`/agents/${run.agentId}/runs/${passiveFollowupOriginRunId}`, searchParams)}>
                    {passiveFollowupOriginRunId}
                  </Link>
                </div>
                {passiveFollowupPreviousRunId && (
                  <div className="text-muted-foreground">
                    Previous run{" "}
                    <Link className="underline underline-offset-2" to={appendRunSearchParams(`/agents/${run.agentId}/runs/${passiveFollowupPreviousRunId}`, searchParams)}>
                      {passiveFollowupPreviousRunId}
                    </Link>
                  </div>
                )}
                {(passiveFollowupAttempt || passiveFollowupReason) && (
                  <div className="text-muted-foreground">
                    {[
                      passiveFollowupAttempt && passiveFollowupMaxAttempts
                        ? `attempt ${passiveFollowupAttempt}/${passiveFollowupMaxAttempts}`
                        : null,
                      passiveFollowupReason,
                    ].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right column: metrics */}
          {hasMetrics && (
            <div className="border-t sm:border-t-0 sm:border-l border-border p-4 grid grid-cols-2 gap-x-4 sm:gap-x-8 gap-y-3 content-center tabular-nums">
              <div>
                <div className="text-xs text-muted-foreground">Prompt input</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.promptTokens)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Output</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.output)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cached input</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.cached)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cost</div>
                <div className="text-sm font-medium font-mono">{metrics.cost > 0 ? `$${metrics.cost.toFixed(4)}` : "-"}</div>
              </div>
            </div>
          )}
        </div>

        {/* Collapsible session row */}
        {hasSession && (
          <div className="border-t border-border">
            <button
              className="flex items-center gap-1.5 w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setSessionOpen((v) => !v)}
            >
              <ChevronRight className={cn("h-3 w-3 transition-transform", sessionOpen && "rotate-90")} />
              Session
              {sessionChanged && <span className="text-yellow-400 ml-1">(changed)</span>}
            </button>
            {sessionOpen && (
              <div className="px-4 pb-3 space-y-1 text-xs">
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground w-12 shrink-0">Run ID</span>
                  <CopyText
                    text={run.id}
                    ariaLabel={`Copy run ID ${run.id.slice(0, 8)}`}
                    title="Copy run ID"
                    containerClassName="min-w-0 max-w-full"
                    className="block min-w-0 break-all text-left font-mono"
                  />
                </div>
                {run.sessionIdBefore && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-12">{sessionChanged ? "Before" : "ID"}</span>
                    <CopyText text={run.sessionIdBefore} className="font-mono" />
                  </div>
                )}
                {sessionChanged && run.sessionIdAfter && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-12">After</span>
                    <CopyText text={run.sessionIdAfter} className="font-mono" />
                  </div>
                )}
                {touchedIssueIds.length > 0 && (
                  <div className="pt-1">
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-60"
                      disabled={clearSessionsForTouchedIssues.isPending}
                      onClick={async () => {
                        const issueCount = touchedIssueIds.length;
                        const confirmed = await confirm({
                          title: `Clear session for ${issueCount} issue${issueCount === 1 ? "" : "s"} touched by this run?`,
                          confirmLabel: "Clear session",
                          tone: "destructive",
                        });
                        if (!confirmed) return;
                        clearSessionsForTouchedIssues.mutate();
                      }}
                    >
                      {clearSessionsForTouchedIssues.isPending
                        ? "clearing session..."
                        : "clear session for these issues"}
                    </button>
                    {clearSessionsForTouchedIssues.isError && (
                      <p className="text-[11px] text-destructive mt-1">
                        {clearSessionsForTouchedIssues.error instanceof Error
                          ? clearSessionsForTouchedIssues.error.message
                          : "Failed to clear sessions"}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <RunChatContextCard run={run} agentRouteId={agentRouteId} />

      {/* Issues touched by this run */}
      {touchedIssues && touchedIssues.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Issues Touched ({touchedIssues.length})</span>
          <div className="border border-border rounded-lg divide-y divide-border">
            {touchedIssues.map((issue) => (
              <Link
                key={issue.issueId}
                to={`/issues/${issue.identifier ?? issue.issueId}`}
                className="flex items-center justify-between w-full px-3 py-2 text-xs hover:bg-accent/20 transition-colors text-left no-underline text-inherit"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <StatusBadge status={issue.status} />
                  <span className="truncate">{issue.title}</span>
                </div>
                <span className="font-mono text-muted-foreground shrink-0 ml-2">{issue.identifier ?? issue.issueId.slice(0, 8)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* stderr excerpt for failed runs */}
      {shouldShowRunStderrExcerpt(run) && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-red-600 dark:text-red-400">stderr</span>
          <pre data-testid="run-stderr-excerpt" className="min-w-0 max-w-full bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap break-words">{stderrExcerptDisplayText}</pre>
        </div>
      )}

      {/* stdout excerpt when no log is available */}
      {run.stdoutExcerpt && !run.logRef && run.status !== "failed" && run.status !== "timed_out" && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">stdout</span>
          <pre data-testid="run-stdout-excerpt" className="min-w-0 max-w-full bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap break-words">{run.stdoutExcerpt}</pre>
        </div>
      )}

      {/* Log viewer */}
      <LogViewer run={run} agentRuntimeType={agentRuntimeType} />
      <ScrollToBottom />
    </div>
  );
}

/* ---- Log Viewer ---- */
