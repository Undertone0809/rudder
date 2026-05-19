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
import { LatestRunCard, AgentOverview, CostsSection, AgentConfigurePage, ConfigurationTab } from "./AgentDetail.overview";
import { DEFAULT_INSTRUCTIONS_ENTRY_FILE, PromptsTab, PromptsTabSkeleton, PromptEditorSkeleton } from "./AgentDetail.prompts";
import { AgentSkillsTab } from "./AgentDetail.skills";
import { RunListItem, RunsTab, RunDetail } from "./AgentDetail.runs";
import { KeysTab } from "./AgentDetail.keys";


export function AgentDetail() {
  const { orgPrefix, agentId, tab: urlTab, runId: urlRunId } = useParams<{
    orgPrefix?: string;
    agentId: string;
    tab?: string;
    runId?: string;
  }>();
  const { organizations, selectedOrganizationId, setSelectedOrganizationId } = useOrganization();
  const { closePanel } = usePanel();
  const { openNewIssue } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [terminateConfirmOpen, setTerminateConfirmOpen] = useState(false);
  const activeView = urlRunId ? "runs" as AgentDetailView : parseAgentDetailView(urlTab ?? null);
  const needsDashboardData = activeView === "dashboard";
  const needsRunData = activeView === "runs" || Boolean(urlRunId);
  const shouldLoadHeartbeats = needsDashboardData || needsRunData;
  const [datePreset, setDatePreset] = useState<DashboardDatePreset>("7d");
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const saveConfigActionRef = useRef<(() => void) | null>(null);
  const cancelConfigActionRef = useRef<(() => void) | null>(null);
  const { isMobile } = useSidebar();
  const routeAgentRef = agentId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!orgPrefix) return null;
    return findOrganizationByPrefix({
      organizations,
      organizationPrefix: orgPrefix,
    })?.id ?? null;
  }, [organizations, orgPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedOrganizationId ?? undefined;
  const canFetchAgent = routeAgentRef.length > 0 && (isUuidLike(routeAgentRef) || Boolean(lookupCompanyId));
  const setSaveConfigAction = useCallback((fn: (() => void) | null) => { saveConfigActionRef.current = fn; }, []);
  const setCancelConfigAction = useCallback((fn: (() => void) | null) => { cancelConfigActionRef.current = fn; }, []);

  const { data: agent, isLoading, error } = useQuery<AgentDetailRecord>({
    queryKey: [...queryKeys.agents.detail(routeAgentRef), lookupCompanyId ?? null],
    queryFn: () => agentsApi.get(routeAgentRef, lookupCompanyId),
    enabled: canFetchAgent,
  });
  const resolvedCompanyId = agent?.orgId ?? selectedOrganizationId;
  const canonicalAgentRef = agent ? agentRouteRef(agent) : routeAgentRef;
  const agentLookupRef = agent?.id ?? routeAgentRef;
  const resolvedAgentId = agent?.id ?? null;

  const { data: runtimeState } = useQuery({
    queryKey: queryKeys.agents.runtimeState(resolvedAgentId ?? routeAgentRef),
    queryFn: () => agentsApi.runtimeState(resolvedAgentId!, resolvedCompanyId ?? undefined),
    enabled: Boolean(resolvedAgentId) && needsDashboardData,
  });

  const { from, to, customReady } = useMemo(() => {
    const now = new Date();

    if (datePreset === "custom") {
      const fromDate = customFrom ? new Date(`${customFrom}T00:00:00`) : null;
      const toDate = customTo ? new Date(`${customTo}T23:59:59.999`) : null;
      return {
        from: fromDate ? fromDate.toISOString() : "",
        to: toDate ? toDate.toISOString() : "",
        customReady: !!customFrom && !!customTo,
      };
    }

    const days = datePreset === "7d" ? 7 : datePreset === "15d" ? 15 : 30;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0);
    return {
      from: start.toISOString(),
      to: now.toISOString(),
      customReady: true,
    };
  }, [customFrom, customTo, datePreset]);

  const chartDays = useMemo(() => {
    if (datePreset === "7d") return getRecentDayKeys(7);
    if (datePreset === "15d") return getRecentDayKeys(15);
    if (datePreset === "30d") return getRecentDayKeys(30);
    return getDayKeysBetween(customFrom, customTo);
  }, [customFrom, customTo, datePreset]);

  const rangeLabel = useMemo(
    () => formatRangeLabel(datePreset, customFrom, customTo),
    [customFrom, customTo, datePreset],
  );

  const { data: skillAnalytics } = useQuery({
    queryKey: [
      ...queryKeys.agents.skillsAnalytics(resolvedAgentId ?? routeAgentRef),
      datePreset,
      customFrom,
      customTo,
    ],
    queryFn: () => agentsApi.skillsAnalytics(resolvedAgentId!, {
      orgId: resolvedCompanyId ?? undefined,
      ...(datePreset === "custom" && customReady
        ? { startDate: customFrom, endDate: customTo }
        : { windowDays: datePreset === "7d" ? 7 : datePreset === "15d" ? 15 : 30 }),
    }),
    enabled: Boolean(resolvedAgentId) && needsDashboardData && (datePreset !== "custom" || customReady),
  });

  const { data: heartbeats } = useQuery({
    queryKey: queryKeys.heartbeats(resolvedCompanyId!, agent?.id ?? undefined),
    queryFn: () => heartbeatsApi.list(resolvedCompanyId!, agent?.id ?? undefined),
    enabled: !!resolvedCompanyId && !!agent?.id && shouldLoadHeartbeats,
  });

  const { data: allIssues } = useQuery({
    queryKey: [...queryKeys.issues.list(resolvedCompanyId!), "participant-agent", resolvedAgentId ?? "__none__"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { participantAgentId: resolvedAgentId! }),
    enabled: !!resolvedCompanyId && !!resolvedAgentId && needsDashboardData,
  });

  const { data: allAgents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId && needsDashboardData,
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(resolvedCompanyId ?? "__none__"),
    queryFn: () => budgetsApi.overview(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const assignedIssues = (allIssues ?? [])
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const filteredRuns = useMemo(
    () => (heartbeats ?? []).filter((run) => isWithinRange(run.createdAt, from, to)),
    [from, heartbeats, to],
  );
  const filteredAssignedIssues = useMemo(
    () => assignedIssues.filter((issue) => isWithinRange(issue.createdAt, from, to)),
    [assignedIssues, from, to],
  );
  const handleDashboardPresetSelect = useCallback((nextPreset: DashboardDatePreset) => {
    if (nextPreset === "custom") {
      if (!customFrom || !customTo) {
        const today = new Date();
        const lastWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
        setCustomFrom(formatDateInputValue(lastWeek));
        setCustomTo(formatDateInputValue(today));
      }
      setDatePreset("custom");
      setCustomRangeOpen(true);
      return;
    }

    setCustomRangeOpen(false);
    setDatePreset(nextPreset);
  }, [customFrom, customTo]);
  const reportsToAgent = (allAgents ?? []).find((a) => a.id === agent?.reportsTo);
  const directReports = (allAgents ?? []).filter((a) => a.reportsTo === agent?.id && a.status !== "terminated");
  const agentBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "agent" && policy.scopeId === (agent?.id ?? routeAgentRef),
    );
    if (matched) return matched;
    const budgetMonthlyCents = agent?.budgetMonthlyCents ?? 0;
    const spentMonthlyCents = agent?.spentMonthlyCents ?? 0;
    return {
      policyId: "",
      orgId: resolvedCompanyId ?? "",
      scopeType: "agent",
      scopeId: agent?.id ?? routeAgentRef,
      scopeName: agent?.name ?? "Agent",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: budgetMonthlyCents,
      observedAmount: spentMonthlyCents,
      remainingAmount: Math.max(0, budgetMonthlyCents - spentMonthlyCents),
      utilizationPercent:
        budgetMonthlyCents > 0 ? Number(((spentMonthlyCents / budgetMonthlyCents) * 100).toFixed(2)) : 0,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: budgetMonthlyCents > 0,
      status: budgetMonthlyCents > 0 && spentMonthlyCents >= budgetMonthlyCents ? "hard_stop" : "ok",
      paused: agent?.status === "paused",
      pauseReason: agent?.pauseReason ?? null,
      windowStart: new Date(),
      windowEnd: new Date(),
    } satisfies BudgetPolicySummary;
  }, [agent, budgetOverview?.policies, resolvedCompanyId, routeAgentRef]);
  const mobileLiveRun = useMemo(
    () => (heartbeats ?? []).find((r) => r.status === "running" || r.status === "queued") ?? null,
    [heartbeats],
  );

  useEffect(() => {
    if (!agent) return;
    if (urlRunId) {
      if (routeAgentRef !== canonicalAgentRef) {
        navigate(`/agents/${canonicalAgentRef}/runs/${urlRunId}`, { replace: true });
      }
      return;
    }
    const canonicalTab =
      activeView === "instructions"
        ? "instructions"
        : activeView === "configuration"
          ? "configuration"
          : activeView === "skills"
            ? "skills"
            : activeView === "runs"
              ? "runs"
              : activeView === "budget"
                ? "budget"
              : "dashboard";
    if (routeAgentRef !== canonicalAgentRef || urlTab !== canonicalTab) {
      navigate(`/agents/${canonicalAgentRef}/${canonicalTab}`, { replace: true });
      return;
    }
  }, [agent, routeAgentRef, canonicalAgentRef, urlRunId, urlTab, activeView, navigate]);

  useEffect(() => {
    if (!agent?.orgId || agent.orgId === selectedOrganizationId) return;
    setSelectedOrganizationId(agent.orgId, { source: "route_sync" });
  }, [agent?.orgId, selectedOrganizationId, setSelectedOrganizationId]);

  const agentAction = useMutation({
    mutationFn: async (action: "invoke" | "pause" | "resume" | "terminate") => {
      if (!agentLookupRef) return Promise.reject(new Error("No agent reference"));
      switch (action) {
        case "invoke": return agentsApi.invoke(agentLookupRef, resolvedCompanyId ?? undefined);
        case "pause": return agentsApi.pause(agentLookupRef, resolvedCompanyId ?? undefined);
        case "resume": return agentsApi.resume(agentLookupRef, resolvedCompanyId ?? undefined);
        case "terminate": return agentsApi.terminate(agentLookupRef, resolvedCompanyId ?? undefined);
      }
    },
    onSuccess: (data, action) => {
      setActionError(null);
      if (action === "terminate") {
        setTerminateConfirmOpen(false);
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
        if (agent?.id) {
          queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(resolvedCompanyId, agent.id) });
        }
      }
      if (action === "invoke" && data && typeof data === "object" && "id" in data) {
        navigate(`/agents/${canonicalAgentRef}/runs/${(data as HeartbeatRun).id}`);
      }
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Action failed");
    },
  });

  const budgetMutation = useMutation({
    mutationFn: (amount: number) =>
      budgetsApi.upsertPolicy(resolvedCompanyId!, {
        scopeType: "agent",
        scopeId: agent?.id ?? routeAgentRef,
        amount,
        windowKind: "calendar_month_utc",
      }),
    onSuccess: () => {
      if (!resolvedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(resolvedCompanyId) });
    },
  });

  const updateIcon = useMutation({
    mutationFn: (icon: string | null) => agentsApi.update(agentLookupRef, { icon }, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to update avatar");
    },
  });

  const uploadAvatar = useMutation({
    mutationFn: (file: File) => agentsApi.uploadAvatar(agentLookupRef, file, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to upload avatar");
    },
  });

  const resetTaskSession = useMutation({
    mutationFn: (taskKey: string | null) =>
      agentsApi.resetSession(agentLookupRef, taskKey, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agentLookupRef) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reset session");
    },
  });

  const updatePermissions = useMutation({
    mutationFn: (permissions: AgentPermissionUpdate) =>
      agentsApi.updatePermissions(agentLookupRef, permissions, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to update permissions");
    },
  });

  useEffect(() => {
    const crumbs: { label: string; href?: string }[] = [
      { label: "Agents", href: "/agents" },
    ];
    const agentName = agent?.name ?? routeAgentRef ?? "Agent";
    if (activeView === "dashboard" && !urlRunId) {
      crumbs.push({ label: agentName });
    } else {
      crumbs.push({ label: agentName, href: `/agents/${canonicalAgentRef}/dashboard` });
      if (urlRunId) {
        crumbs.push({ label: "Runs", href: `/agents/${canonicalAgentRef}/runs` });
        crumbs.push({ label: `Run ${urlRunId.slice(0, 8)}` });
      } else if (activeView === "instructions") {
        crumbs.push({ label: "Instructions" });
      } else if (activeView === "configuration") {
        crumbs.push({ label: "Configuration" });
      // } else if (activeView === "skills") { // TODO: bring back later
      //   crumbs.push({ label: "Skills" });
      } else if (activeView === "runs") {
        crumbs.push({ label: "Runs" });
      } else if (activeView === "budget") {
        crumbs.push({ label: "Budget" });
      } else {
        crumbs.push({ label: "Dashboard" });
      }
    }
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, agent, routeAgentRef, canonicalAgentRef, activeView, urlRunId]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useBeforeUnload(
    useCallback((event) => {
      if (!configDirty) return;
      event.preventDefault();
      event.returnValue = "";
    }, [configDirty]),
  );

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!agent) return null;
  if (!urlRunId && !urlTab) {
    return <Navigate to={`/agents/${canonicalAgentRef}/dashboard`} replace />;
  }
  const isPendingApproval = agent.status === "pending_approval";
  const showConfigActionBar = (activeView === "configuration" || activeView === "instructions") && (configDirty || configSaving);
  const agentAvatarImageSrc = getAgentAvatarImageSrc(agent.icon);

  return (
    <>
      <Dialog open={terminateConfirmOpen} onOpenChange={setTerminateConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Terminate agent</DialogTitle>
            <DialogDescription>
              Stop this agent permanently. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">{agent.name}</span> will be marked as terminated and can no longer run or resume.
            </p>
            <p>
              Future heartbeats will stay disabled until you create or replace it.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setTerminateConfirmOpen(false)}
              disabled={agentAction.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => agentAction.mutate("terminate")}
              disabled={agentAction.isPending}
            >
              {agentAction.isPending ? "Terminating..." : "Terminate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className={cn("space-y-6", isMobile && showConfigActionBar && "pb-24")}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <AgentIconPicker
            value={agent.icon}
            onChange={(icon) => updateIcon.mutate(icon)}
            onUpload={(file) => uploadAvatar.mutate(file)}
            uploadPending={uploadAvatar.isPending}
            uploadError={uploadAvatar.error instanceof Error ? uploadAvatar.error.message : null}
          >
            <button
              className={cn(
                "shrink-0 flex h-12 w-12 items-center justify-center transition-colors",
                agentAvatarImageSrc
                  ? "overflow-hidden rounded-full hover:opacity-85"
                  : "rounded-lg bg-accent hover:bg-accent/80",
              )}
              aria-label="Change agent avatar"
            >
              <AgentIcon icon={agent.icon} role={agent.role} className={agentAvatarImageSrc ? "h-full w-full" : "h-7 w-7"} />
            </button>
          </AgentIconPicker>
          <div className="min-w-0">
            <h2 className="text-2xl font-bold truncate">{agent.name}</h2>
            <p className="text-sm text-muted-foreground truncate">
              {roleLabels[agent.role] ?? agent.role}
              {agent.title ? ` - ${agent.title}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openNewIssue({ assigneeAgentId: agent.id })}
          >
            <Plus className="h-3.5 w-3.5 sm:mr-1" />
            <span className="hidden sm:inline">Assign Task</span>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link
              to={{
                pathname: "/messenger/chat",
                search: `?agentId=${encodeURIComponent(agent.id)}`,
              }}
            >
              <MessageSquare className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">Chat</span>
            </Link>
          </Button>
          <RunButton
            onClick={() => agentAction.mutate("invoke")}
            disabled={agentAction.isPending || isPendingApproval}
            label="Run Heartbeat"
          />
          <PauseResumeButton
            isPaused={agent.status === "paused"}
            onPause={() => agentAction.mutate("pause")}
            onResume={() => agentAction.mutate("resume")}
            disabled={agentAction.isPending || isPendingApproval}
          />
          <span className="hidden sm:inline"><StatusBadge status={agent.status} /></span>
          {mobileLiveRun && (
            <Link
              to={`/agents/${canonicalAgentRef}/runs/${mobileLiveRun.id}`}
              className="sm:hidden flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">Live</span>
            </Link>
          )}

          {/* Overflow menu */}
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Agent actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                onClick={() => {
                  navigator.clipboard.writeText(agent.id);
                  setMoreOpen(false);
                }}
              >
                <Copy className="h-3 w-3" />
                Copy Agent ID
              </button>
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                onClick={() => {
                  resetTaskSession.mutate(null);
                  setMoreOpen(false);
                }}
              >
                <RotateCcw className="h-3 w-3" />
                Reset Sessions
              </button>
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                onClick={() => {
                  setMoreOpen(false);
                  setTerminateConfirmOpen(true);
                }}
              >
                <Trash2 className="h-3 w-3" />
                Terminate
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {!urlRunId && (
        <Tabs
          value={activeView}
          onValueChange={(value) => navigate(`/agents/${canonicalAgentRef}/${value}`)}
        >
          <div className="flex items-start justify-between gap-4">
            <PageTabBar
              items={[
                { value: "dashboard", label: "Dashboard" },
                { value: "instructions", label: "Instructions" },
                { value: "skills", label: "Skills" },
                { value: "configuration", label: "Configuration" },
                { value: "runs", label: "Runs" },
                { value: "budget", label: "Budget" },
              ]}
              value={activeView}
              onValueChange={(value) => navigate(`/agents/${canonicalAgentRef}/${value}`)}
            />
            {activeView === "dashboard" ? (
              <div className="hidden lg:block shrink-0">
                <DashboardDateRangeControl
                  preset={datePreset}
                  customFrom={customFrom}
                  customTo={customTo}
                  customOpen={customRangeOpen}
                  onCustomOpenChange={setCustomRangeOpen}
                  onPresetSelect={handleDashboardPresetSelect}
                  onCustomFromChange={setCustomFrom}
                  onCustomToChange={setCustomTo}
                />
              </div>
            ) : null}
          </div>
        </Tabs>
      )}

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {isPendingApproval && (
        <p className="text-sm text-amber-500">
          This agent is pending board approval and cannot be invoked yet.
        </p>
      )}

      {/* Floating Save/Cancel (desktop) */}
      {!isMobile && (
        <div
          className={cn(
            "sticky top-6 z-10 float-right transition-opacity duration-150",
            showConfigActionBar
              ? "opacity-100"
              : "opacity-0 pointer-events-none"
          )}
        >
          <div className="flex items-center gap-2 bg-background/90 backdrop-blur-sm border border-border rounded-lg px-3 py-1.5 shadow-lg">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelConfigActionRef.current?.()}
              disabled={configSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => saveConfigActionRef.current?.()}
              disabled={configSaving}
            >
              {configSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* Mobile bottom Save/Cancel bar */}
      {isMobile && showConfigActionBar && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur-sm">
          <div
            className="flex items-center justify-end gap-2 px-3 py-2"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelConfigActionRef.current?.()}
              disabled={configSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => saveConfigActionRef.current?.()}
              disabled={configSaving}
            >
              {configSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* View content */}
      {activeView === "dashboard" && (
        <AgentOverview
          agent={agent}
          runs={heartbeats ?? []}
          chartRuns={filteredRuns}
          assignedIssues={assignedIssues}
          chartIssues={filteredAssignedIssues}
          runtimeState={runtimeState}
          skillAnalytics={skillAnalytics}
          agentId={agent.id}
          agentRouteId={canonicalAgentRef}
          rangeLabel={rangeLabel}
          chartDays={chartDays}
          showDashboardFilters={datePreset !== "custom" || customReady}
          dateFilterControl={(
            <div className="lg:hidden">
              <DashboardDateRangeControl
                preset={datePreset}
                customFrom={customFrom}
                customTo={customTo}
                customOpen={customRangeOpen}
                onCustomOpenChange={setCustomRangeOpen}
                onPresetSelect={handleDashboardPresetSelect}
                onCustomFromChange={setCustomFrom}
                onCustomToChange={setCustomTo}
              />
            </div>
          )}
        />
      )}

      {activeView === "instructions" && (
        <PromptsTab
          agent={agent}
          orgId={resolvedCompanyId ?? undefined}
          onDirtyChange={setConfigDirty}
          onSaveActionChange={setSaveConfigAction}
          onCancelActionChange={setCancelConfigAction}
          onSavingChange={setConfigSaving}
        />
      )}

      {activeView === "configuration" && (
        <AgentConfigurePage
          agent={agent}
          agentId={agent.id}
          orgId={resolvedCompanyId ?? undefined}
          onDirtyChange={setConfigDirty}
          onSaveActionChange={setSaveConfigAction}
          onCancelActionChange={setCancelConfigAction}
          onSavingChange={setConfigSaving}
          updatePermissions={updatePermissions}
        />
      )}

      {activeView === "skills" && (
        <AgentSkillsTab
          agent={agent}
          orgId={resolvedCompanyId ?? undefined}
        />
      )}

      {activeView === "runs" && (
        <RunsTab
          runs={heartbeats ?? []}
          orgId={resolvedCompanyId!}
          agentId={agent.id}
          agentRouteId={canonicalAgentRef}
          selectedRunId={urlRunId ?? null}
          agentRuntimeType={agent.agentRuntimeType}
        />
      )}

      {activeView === "budget" && resolvedCompanyId ? (
        <div className="max-w-3xl">
          <BudgetPolicyCard
            summary={agentBudgetSummary}
            isSaving={budgetMutation.isPending}
            onSave={(amount) => budgetMutation.mutate(amount)}
            variant="plain"
          />
        </div>
      ) : null}
      </div>
    </>
  );
}

/* ---- Helper components ---- */
