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
import { getRunFailureDisplay } from "../lib/run-detail-display";
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

export function runDateToIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

export function LogViewer({ run, agentRuntimeType }: { run: HeartbeatRun; agentRuntimeType: string }) {
  type RunDetailTab = "transcript" | "invocation";
  const [events, setEvents] = useState<HeartbeatRunEvent[]>([]);
  const [logLines, setLogLines] = useState<RunLogChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [logLoading, setLogLoading] = useState(!!run.logRef);
  const [logError, setLogError] = useState<string | null>(null);
  const [logOffset, setLogOffset] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [isStreamingConnected, setIsStreamingConnected] = useState(false);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("nice");
  const [activeDetailTab, setActiveDetailTab] = useState<RunDetailTab>("transcript");
  const failureDisplay = getRunFailureDisplay(run);
  const [transcriptModalOpen, setTranscriptModalOpen] = useState(false);
  const [transcriptDialogMotion, setTranscriptDialogMotion] = useState({
    fromX: "0px",
    fromY: "-16px",
    settleX: "0px",
    settleY: "0px",
    fromScaleX: "0.96",
    fromScaleY: "0.96",
  });
  const transcriptVisible = activeDetailTab === "transcript";
  const logEndRef = useRef<HTMLDivElement>(null);
  const transcriptExpandButtonRef = useRef<HTMLButtonElement>(null);
  const pendingLogLineRef = useRef("");
  const seenLogChunkKeysRef = useRef<Set<string>>(new Set());
  const scrollContainerRef = useRef<ScrollContainer | null>(null);
  const isFollowingRef = useRef(false);
  const lastMetricsRef = useRef<{ scrollHeight: number; distanceFromBottom: number }>({
    scrollHeight: 0,
    distanceFromBottom: Number.POSITIVE_INFINITY,
  });
  const isLive = run.status === "running" || run.status === "queued";
  const liveTranscriptRuns = useMemo<LiveRunForIssue[]>(() => {
    if (!isLive) return [];
    return [{
      id: run.id,
      status: run.status,
      invocationSource: run.invocationSource,
      triggerDetail: run.triggerDetail,
      startedAt: runDateToIso(run.startedAt),
      finishedAt: runDateToIso(run.finishedAt),
      createdAt: runDateToIso(run.createdAt) ?? new Date().toISOString(),
      agentId: run.agentId,
      agentName: "",
      agentRuntimeType,
      issueId: null,
    }];
  }, [
    agentRuntimeType,
    isLive,
    run.agentId,
    run.createdAt,
    run.finishedAt,
    run.id,
    run.invocationSource,
    run.startedAt,
    run.status,
    run.triggerDetail,
  ]);
  const { transcriptByRun: liveTranscriptByRun } = useLiveRunTranscripts({
    runs: liveTranscriptRuns,
    orgId: run.orgId,
    maxChunksPerRun: 500,
    includeRunEvents: false,
  });
  const { data: workspaceOperations = [] } = useQuery({
    queryKey: queryKeys.runWorkspaceOperations(run.id),
    queryFn: () => heartbeatsApi.workspaceOperations(run.id),
    refetchInterval: isLive ? 2000 : false,
  });

  function isRunLogUnavailable(err: unknown): boolean {
    return err instanceof ApiError && err.status === 404;
  }

  function appendLogContent(content: string, finalize = false) {
    if (!content && !finalize) return;
    const combined = `${pendingLogLineRef.current}${content}`;
    const split = combined.split("\n");
    pendingLogLineRef.current = split.pop() ?? "";
    if (finalize && pendingLogLineRef.current) {
      split.push(pendingLogLineRef.current);
      pendingLogLineRef.current = "";
    }

    const parsed: RunLogChunk[] = [];
    for (const line of split) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
        const stream =
          raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
        const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
        const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
        if (!chunk) continue;
        parsed.push({ ts, stream, chunk });
      } catch {
        // ignore malformed lines
      }
    }

    if (parsed.length > 0) {
      appendLogChunks(parsed);
    }
  }

  function appendLogChunks(chunks: RunLogChunk[]) {
    if (chunks.length === 0) return;
    setLogLines((prev) => {
      const nextChunks: RunLogChunk[] = [];
      for (const chunk of chunks) {
        const key = runLogChunkDedupeKey(chunk);
        if (seenLogChunkKeysRef.current.has(key)) continue;
        seenLogChunkKeysRef.current.add(key);
        nextChunks.push(chunk);
      }
      if (nextChunks.length === 0) return prev;
      if (seenLogChunkKeysRef.current.size > 12000) {
        seenLogChunkKeysRef.current = new Set(nextChunks.map(runLogChunkDedupeKey));
      }
      return [...prev, ...nextChunks];
    });
  }

  // Fetch events
  const { data: initialEvents } = useQuery({
    queryKey: ["run-events", run.id],
    queryFn: () => heartbeatsApi.events(run.id, 0, 200),
  });

  useEffect(() => {
    if (initialEvents) {
      setEvents(initialEvents);
      setLoading(false);
    }
  }, [initialEvents]);

  const getScrollContainer = useCallback((): ScrollContainer => {
    if (scrollContainerRef.current) return scrollContainerRef.current;
    const container = findScrollContainer(logEndRef.current);
    scrollContainerRef.current = container;
    return container;
  }, []);

  const updateFollowingState = useCallback(() => {
    const container = getScrollContainer();
    const metrics = readScrollMetrics(container);
    lastMetricsRef.current = metrics;
    const nearBottom = metrics.distanceFromBottom <= LIVE_SCROLL_BOTTOM_TOLERANCE_PX;
    isFollowingRef.current = nearBottom;
    setIsFollowing((prev) => (prev === nearBottom ? prev : nearBottom));
  }, [getScrollContainer]);

  useEffect(() => {
    scrollContainerRef.current = null;
    lastMetricsRef.current = {
      scrollHeight: 0,
      distanceFromBottom: Number.POSITIVE_INFINITY,
    };

    if (!isLive || !transcriptVisible) {
      isFollowingRef.current = false;
      setIsFollowing(false);
      return;
    }

    updateFollowingState();
  }, [isLive, run.id, transcriptVisible, updateFollowingState]);

  useEffect(() => {
    if (!isLive || !transcriptVisible) return;
    const container = getScrollContainer();
    updateFollowingState();

    if (container === window) {
      window.addEventListener("scroll", updateFollowingState, { passive: true });
    } else {
      container.addEventListener("scroll", updateFollowingState, { passive: true });
    }
    window.addEventListener("resize", updateFollowingState);
    return () => {
      if (container === window) {
        window.removeEventListener("scroll", updateFollowingState);
      } else {
        container.removeEventListener("scroll", updateFollowingState);
      }
      window.removeEventListener("resize", updateFollowingState);
    };
  }, [isLive, run.id, transcriptVisible, getScrollContainer, updateFollowingState]);

  // Auto-scroll only for live runs when following
  useEffect(() => {
    if (!isLive || !transcriptVisible || !isFollowingRef.current) return;

    const container = getScrollContainer();
    const previous = lastMetricsRef.current;
    const current = readScrollMetrics(container);
    const growth = Math.max(0, current.scrollHeight - previous.scrollHeight);
    const expectedDistance = previous.distanceFromBottom + growth;
    const movedAwayBy = current.distanceFromBottom - expectedDistance;

    // If user moved away from bottom between updates, release auto-follow immediately.
    if (movedAwayBy > LIVE_SCROLL_BOTTOM_TOLERANCE_PX) {
      isFollowingRef.current = false;
      setIsFollowing(false);
      lastMetricsRef.current = current;
      return;
    }

    scrollToContainerBottom(container, "auto");
    const after = readScrollMetrics(container);
    lastMetricsRef.current = after;
    if (!isFollowingRef.current) {
      isFollowingRef.current = true;
    }
    setIsFollowing((prev) => (prev ? prev : true));
  }, [events.length, logLines.length, isLive, transcriptVisible, getScrollContainer]);

  // Fetch persisted shell log
  useEffect(() => {
    let cancelled = false;
    pendingLogLineRef.current = "";
    seenLogChunkKeysRef.current.clear();
    setLogLines([]);
    setLogOffset(0);
    setLogError(null);

    if (!run.logRef && !isLive) {
      setLogLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLogLoading(true);
    const firstLimit =
      typeof run.logBytes === "number" && run.logBytes > 0
        ? Math.min(Math.max(run.logBytes + 1024, 256_000), 2_000_000)
        : 256_000;

    const load = async () => {
      try {
        let offset = 0;
        let first = true;
        while (!cancelled) {
          const result = await heartbeatsApi.log(run.id, offset, first ? firstLimit : 256_000);
          if (cancelled) break;
          appendLogContent(result.content, result.nextOffset === undefined);
          const next = result.nextOffset ?? result.endOffset ?? offset + utf8ByteLength(result.content);
          setLogOffset(next);
          offset = next;
          first = false;
          if (result.nextOffset === undefined || isLive) break;
        }
      } catch (err) {
        if (!cancelled) {
          if (isLive && isRunLogUnavailable(err)) {
            setLogLoading(false);
            return;
          }
          setLogError(err instanceof Error ? err.message : "Failed to load run log");
        }
      } finally {
        if (!cancelled) setLogLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [run.id, run.logRef, run.logBytes, isLive]);

  // Poll for live updates
  useEffect(() => {
    if (!shouldPollLiveRunBackfill({ isLive, isStreamingConnected })) return;
    const interval = setInterval(async () => {
      const maxSeq = events.length > 0 ? Math.max(...events.map((e) => e.seq)) : 0;
      try {
        const newEvents = await heartbeatsApi.events(run.id, maxSeq, 100);
        if (newEvents.length > 0) {
          setEvents((prev) => [...prev, ...newEvents]);
        }
      } catch {
        // ignore polling errors
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [run.id, isLive, isStreamingConnected, events]);

  // Poll shell log for running runs
  useEffect(() => {
    if (!shouldPollLiveRunBackfill({ isLive, isStreamingConnected })) return;
    const interval = setInterval(async () => {
      try {
        const result = await heartbeatsApi.log(run.id, logOffset, 256_000);
        if (result.content) {
          appendLogContent(result.content, result.nextOffset === undefined);
        }
        if (result.nextOffset !== undefined) {
          setLogOffset(result.nextOffset);
        } else if (result.endOffset !== undefined) {
          setLogOffset(result.endOffset);
        } else if (result.content.length > 0) {
          setLogOffset((prev) => prev + utf8ByteLength(result.content));
        }
      } catch (err) {
        if (isRunLogUnavailable(err)) return;
        // ignore polling errors
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [run.id, isLive, isStreamingConnected, logOffset]);

  // Stream live updates from websocket (primary path for running runs).
  useEffect(() => {
    if (!isLive) return;

    let closed = false;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectTimer = window.setTimeout(connect, 1500);
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/orgs/${encodeURIComponent(run.orgId)}/events/ws`;
      socket = new WebSocket(url);

      socket.onopen = () => {
        setIsStreamingConnected(true);
      };

      socket.onmessage = (message) => {
        const rawMessage = typeof message.data === "string" ? message.data : "";
        if (!rawMessage) return;

        let event: LiveEvent;
        try {
          event = JSON.parse(rawMessage) as LiveEvent;
        } catch {
          return;
        }

        if (event.orgId !== run.orgId) return;
        const payload = asRecord(event.payload);
        const eventRunId = asNonEmptyString(payload?.runId);
        if (!payload || eventRunId !== run.id) return;

        if (event.type === "heartbeat.run.log") {
          if (payload.truncated === true) return;
          const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
          if (!chunk) return;
          const streamRaw = asNonEmptyString(payload.stream);
          const stream = streamRaw === "stderr" || streamRaw === "system" ? streamRaw : "stdout";
          const ts = asNonEmptyString((payload as Record<string, unknown>).ts) ?? event.createdAt;
          appendLogChunks([{ ts, stream, chunk }]);
          return;
        }

        if (event.type !== "heartbeat.run.event") return;

        const seq = typeof payload.seq === "number" ? payload.seq : null;
        if (seq === null || !Number.isFinite(seq)) return;

        const streamRaw = asNonEmptyString(payload.stream);
        const stream =
          streamRaw === "stdout" || streamRaw === "stderr" || streamRaw === "system"
            ? streamRaw
            : null;
        const levelRaw = asNonEmptyString(payload.level);
        const level =
          levelRaw === "info" || levelRaw === "warn" || levelRaw === "error"
            ? levelRaw
            : null;

        const liveEvent: HeartbeatRunEvent = {
          id: seq,
          orgId: run.orgId,
          runId: run.id,
          agentId: run.agentId,
          seq,
          eventType: asNonEmptyString(payload.eventType) ?? "event",
          stream,
          level,
          color: asNonEmptyString(payload.color),
          message: asNonEmptyString(payload.message),
          payload: asRecord(payload.payload),
          createdAt: new Date(event.createdAt),
        };

        setEvents((prev) => {
          if (prev.some((existing) => existing.seq === seq)) return prev;
          return [...prev, liveEvent];
        });
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        setIsStreamingConnected(false);
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      closed = true;
      setIsStreamingConnected(false);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "run_detail_unmount");
      }
    };
  }, [isLive, run.orgId, run.id, run.agentId]);

  const censorUsernameInLogs = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  }).data?.censorUsernameInLogs === true;
  const adapterInvokePayload = useMemo(() => {
    const evt = events.find((e) => e.eventType === "adapter.invoke");
    return redactPathValue(asRecord(evt?.payload ?? null), censorUsernameInLogs);
  }, [censorUsernameInLogs, events]);
  const adapterSkillUsagePayload = useMemo(() => {
    const evt = events.find((e) => e.eventType === "adapter.skill_usage");
    return redactPathValue(asRecord(evt?.payload ?? null), censorUsernameInLogs);
  }, [censorUsernameInLogs, events]);

  const adapter = useMemo(() => getUIAdapter(agentRuntimeType), [agentRuntimeType]);
  const transcript = useMemo(() => {
    const logTranscript = buildTranscript(logLines, adapter.parseStdoutLine, { censorUsernameInLogs });
    const liveLogTranscript = liveTranscriptByRun.get(run.id) ?? [];
    const effectiveLogTranscript = liveLogTranscript.length > logTranscript.length
      ? liveLogTranscript
      : logTranscript;
    const eventTranscript = events.map((event) =>
      heartbeatRunEventToTranscriptEntry(event, {
        redactText: (value) => redactPathText(value, censorUsernameInLogs),
        redactValue: (value) => redactPathValue(value, censorUsernameInLogs),
      }),
    );
    return mergeTranscriptEntries(effectiveLogTranscript, eventTranscript);
  }, [adapter, censorUsernameInLogs, events, liveTranscriptByRun, logLines, run.id]);
  const hasInvocationTab = Boolean(adapterInvokePayload);
  const invocationPromptText =
    adapterInvokePayload?.prompt !== undefined
      ? formatInvocationValueForDisplay(adapterInvokePayload.prompt, censorUsernameInLogs)
      : null;
  const transcriptEntryLabel = `${transcript.length} ${transcript.length === 1 ? "entry" : "entries"}`;
  const openTranscriptModal = useCallback(() => {
    const rect = transcriptExpandButtonRef.current?.getBoundingClientRect();
    if (rect && window.innerWidth > 0 && window.innerHeight > 0) {
      const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      const finalWidth = Math.min(window.innerWidth - 24, window.innerWidth * 0.96, rootFontSize * 88);
      const finalHeight = Math.min(window.innerHeight * 0.92, rootFontSize * 54);
      const buttonCenterX = rect.left + rect.width / 2;
      const buttonCenterY = rect.top + rect.height / 2;
      const fromX = Math.round(buttonCenterX - window.innerWidth / 2);
      const fromY = Math.round(buttonCenterY - window.innerHeight / 2);
      setTranscriptDialogMotion({
        fromX: `${fromX}px`,
        fromY: `${fromY}px`,
        settleX: `${Math.round(fromX * -0.025)}px`,
        settleY: `${Math.round(fromY * -0.025)}px`,
        fromScaleX: `${Math.max(0.035, Math.min(0.18, rect.width / finalWidth)).toFixed(3)}`,
        fromScaleY: `${Math.max(0.045, Math.min(0.18, rect.height / finalHeight)).toFixed(3)}`,
      });
    }
    setTranscriptModalOpen(true);
  }, []);
  const transcriptDialogStyle = {
    "--transcript-dialog-from-x": transcriptDialogMotion.fromX,
    "--transcript-dialog-from-y": transcriptDialogMotion.fromY,
    "--transcript-dialog-settle-x": transcriptDialogMotion.settleX,
    "--transcript-dialog-settle-y": transcriptDialogMotion.settleY,
    "--transcript-dialog-from-scale-x": transcriptDialogMotion.fromScaleX,
    "--transcript-dialog-from-scale-y": transcriptDialogMotion.fromScaleY,
  } as CSSProperties;
  const renderTranscriptModeToggle = () => (
    <div className="inline-flex rounded-lg border border-border/70 bg-background/70 p-0.5">
      {(["nice", "raw"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className={cn(
            "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
            transcriptMode === mode
              ? "bg-accent text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setTranscriptMode(mode)}
        >
          {mode}
        </button>
      ))}
    </div>
  );

  useEffect(() => {
    setTranscriptMode("nice");
    setActiveDetailTab("transcript");
    setTranscriptModalOpen(false);
  }, [run.id]);

  useEffect(() => {
    if (!hasInvocationTab && activeDetailTab === "invocation") {
      setActiveDetailTab("transcript");
    }
  }, [activeDetailTab, hasInvocationTab]);

  if (loading && logLoading) {
    return <p className="text-xs text-muted-foreground">Loading run logs...</p>;
  }

  if (events.length === 0 && logLines.length === 0 && !logError) {
    return <p className="text-xs text-muted-foreground">No log events.</p>;
  }

  return (
    <div className="space-y-3">
      <WorkspaceOperationsSection
        operations={workspaceOperations}
        censorUsernameInLogs={censorUsernameInLogs}
      />
      <div className="rounded-2xl border border-border/70 bg-background/40">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-3 py-2 sm:px-4">
          {hasInvocationTab ? (
            <Tabs value={activeDetailTab} onValueChange={(value) => setActiveDetailTab(value as RunDetailTab)}>
              <PageTabBar
                items={[
                  { value: "transcript", label: "Transcript" },
                  {
                    value: "invocation",
                    label: "Invocation",
                    mobileLabel: "Invocation",
                    tooltip: "Exact adapter invoke payload",
                  },
                ]}
                value={activeDetailTab}
                onValueChange={(value) => setActiveDetailTab(value as RunDetailTab)}
                align="start"
                triggerClassName="px-2 py-1 text-xs"
              />
            </Tabs>
          ) : (
            <span className="text-xs font-medium text-muted-foreground">Transcript</span>
          )}
          {transcriptVisible ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {transcriptEntryLabel}
              </span>
              {renderTranscriptModeToggle()}
              <Button
                ref={transcriptExpandButtonRef}
                variant="ghost"
                size="icon-sm"
                className="group relative overflow-hidden text-muted-foreground transition-[background-color,border-color,color,box-shadow,transform] duration-200 hover:scale-[1.03] hover:shadow-sm active:scale-95"
                onClick={openTranscriptModal}
                aria-label="Expand transcript"
                title="Expand transcript"
              >
                <span className="absolute inset-0 rounded-[inherit] bg-accent/0 transition-colors duration-200 group-hover:bg-accent/70" aria-hidden />
                <Maximize2 className="relative h-4 w-4 transition-transform duration-200 ease-out group-hover:scale-110" />
              </Button>
              {isLive && !isFollowing && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    const container = getScrollContainer();
                    isFollowingRef.current = true;
                    setIsFollowing(true);
                    scrollToContainerBottom(container, "auto");
                    lastMetricsRef.current = readScrollMetrics(container);
                  }}
                >
                  Jump to live
                </Button>
              )}
              {isLive && (
                <span className="flex items-center gap-1 text-xs text-cyan-400">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
                  </span>
                  Live
                </span>
              )}
            </div>
          ) : null}
        </div>

        {transcriptVisible ? (
          <div className="max-h-[38rem] overflow-y-auto p-3 sm:p-4">
            <RunTranscriptView
              entries={transcript}
              mode={transcriptMode}
              streaming={isLive}
              collapseStdout
              emptyMessage={run.logRef ? "Waiting for transcript..." : "No persisted transcript for this run."}
              presentation="detail"
            />
            {logError && (
              <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {logError}
              </div>
            )}
            <div ref={logEndRef} />
          </div>
        ) : (
          <div className="max-h-[38rem] overflow-y-auto p-3 sm:p-4">
            <div className="space-y-3">
              {typeof adapterInvokePayload?.agentRuntimeType === "string" && (
                <div className="text-xs">
                  <span className="text-muted-foreground">Runtime: </span>
                  {adapterInvokePayload.agentRuntimeType}
                </div>
              )}
              {typeof adapterInvokePayload?.cwd === "string" && (
                <div className="text-xs break-all">
                  <span className="text-muted-foreground">Working dir: </span>
                  <span className="font-mono">{adapterInvokePayload.cwd}</span>
                </div>
              )}
              {typeof adapterInvokePayload?.command === "string" && (
                <div className="text-xs break-all">
                  <span className="text-muted-foreground">Command: </span>
                  <span className="font-mono">
                    {[
                      adapterInvokePayload.command,
                      ...(Array.isArray(adapterInvokePayload.commandArgs)
                        ? adapterInvokePayload.commandArgs.filter((v): v is string => typeof v === "string")
                        : []),
                    ].join(" ")}
                  </span>
                </div>
              )}
              {Array.isArray(adapterInvokePayload?.commandNotes) && adapterInvokePayload.commandNotes.length > 0 && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Command notes</div>
                  <ul className="list-disc space-y-1 pl-5">
                    {adapterInvokePayload.commandNotes
                      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
                      .map((note, idx) => (
                        <li key={`${idx}-${note}`} className="text-xs break-all font-mono">
                          {note}
                        </li>
                    ))}
                  </ul>
                </div>
              )}
              <InvocationSkillEvidence invocationPayload={adapterInvokePayload} usagePayload={adapterSkillUsagePayload} />
              {invocationPromptText !== null && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Prompt</div>
                  <div className="relative">
                    <CopyText
                      text={invocationPromptText}
                      ariaLabel="Copy invocation prompt"
                      title="Copy prompt"
                      containerClassName="absolute right-2 top-2"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/70 bg-background/80 text-muted-foreground shadow-sm hover:bg-muted/80 hover:text-foreground"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                    <pre
                      data-testid="invocation-prompt"
                      className="rounded-md bg-neutral-100 p-2 pr-11 text-xs whitespace-pre-wrap overflow-x-auto dark:bg-neutral-950"
                    >{invocationPromptText}</pre>
                  </div>
                </div>
              )}
              {adapterInvokePayload?.context !== undefined && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Context</div>
                  <pre className="rounded-md bg-neutral-100 p-2 text-xs whitespace-pre-wrap overflow-x-auto dark:bg-neutral-950">
                    {JSON.stringify(redactPathValue(adapterInvokePayload.context, censorUsernameInLogs), null, 2)}
                  </pre>
                </div>
              )}
              {adapterInvokePayload?.env !== undefined && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Environment</div>
                  <pre className="rounded-md bg-neutral-100 p-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto dark:bg-neutral-950">
                    {formatEnvForDisplay(adapterInvokePayload.env, censorUsernameInLogs)}
                  </pre>
                </div>
              )}
              {events.length > 0 && (
                <RunEventsList
                  events={events}
                  censorUsernameInLogs={censorUsernameInLogs}
                />
              )}
            </div>
          </div>
        )}
      </div>

      <Dialog open={transcriptModalOpen} onOpenChange={setTranscriptModalOpen}>
        <DialogContent
          overlayClassName="transcript-modal-overlay"
          style={transcriptDialogStyle}
          className="transcript-modal-content grid h-[min(92dvh,54rem)] max-w-[min(96vw,88rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[min(96vw,88rem)]"
        >
          <DialogHeader className="transcript-modal-header border-b border-border/70 px-4 py-3 pr-12 text-left">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <DialogTitle className="text-sm">Transcript</DialogTitle>
                <DialogDescription className="sr-only">
                  Expanded transcript for run {run.id}.
                </DialogDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{transcriptEntryLabel}</span>
                {renderTranscriptModeToggle()}
                {isLive && (
                  <span className="flex items-center gap-1 text-xs text-cyan-400">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-cyan-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
                    </span>
                    Live
                  </span>
                )}
              </div>
            </div>
          </DialogHeader>
          <div className="transcript-modal-body min-h-0 overflow-y-auto p-3 sm:p-4">
            <RunTranscriptView
              entries={transcript}
              mode={transcriptMode}
              streaming={isLive}
              collapseStdout
              emptyMessage={run.logRef ? "Waiting for transcript..." : "No persisted transcript for this run."}
              presentation="detail"
            />
            {logError && (
              <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {logError}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {(run.status === "failed" || run.status === "timed_out") && (
        <div className="rounded-lg border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-950/20 p-3 space-y-2">
          <div className="text-xs font-medium text-red-700 dark:text-red-300">Failure details</div>
          {failureDisplay && (
            <div className="text-xs text-red-600 dark:text-red-200">
              <span className="text-red-700 dark:text-red-300">{failureDisplay.title}: </span>
              {redactPathText(failureDisplay.body, censorUsernameInLogs)}
              {failureDisplay.actionPath && failureDisplay.actionLabel && (
                <div className="mt-1">
                  <Link to={failureDisplay.actionPath} className="text-xs font-medium text-red-700 underline dark:text-red-300">
                    {failureDisplay.actionLabel}
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

/* ---- Keys Tab ---- */
