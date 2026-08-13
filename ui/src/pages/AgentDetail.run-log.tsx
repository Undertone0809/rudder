import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Tabs } from "@/components/ui/tabs";
import {
  type HeartbeatRun,
  type HeartbeatRunEvent,
  type LiveEvent
} from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import {
  Copy,
  Maximize2
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { buildTranscript, getUIAdapter } from "../agent-runtimes";
import { agentRunsApi, type LiveRunForIssue } from "../api/agent-runs";
import { instanceSettingsApi } from "../api/instanceSettings";
import { CopyText } from "../components/CopyText";
import { PageTabBar } from "../components/PageTabBar";
import { RunTranscriptView, type TranscriptMode, type TranscriptRunAnnotationInput, type TranscriptSkillTarget } from "../components/transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "../components/transcript/useLiveRunTranscripts";
import { useActivityCoordinator } from "../context/ActivityCoordinatorContext";
import { useSidePanel } from "../context/SidePanelContext";
import { queryKeys } from "../lib/queryKeys";
import { heartbeatRunEventsToTranscriptEntries, mergeTranscriptEntries } from "../lib/run-detail-events";
import type { SidePanelTarget } from "../lib/side-panel-targets";
import { cn } from "../lib/utils";
import { asNonEmptyString, asRecord, findScrollContainer, formatEnvForDisplay, formatInvocationValueForDisplay, InvocationMcpEvidence, InvocationSkillEvidence, LIVE_SCROLL_BOTTOM_TOLERANCE_PX, readInvocationAgentInstructionStack, readScrollMetrics, redactPathText, redactPathValue, RunEventsList, RunLogChunk, runLogChunkDedupeKey, ScrollContainer, scrollToContainerBottom, utf8ByteLength, WorkspaceOperationsSection } from "./AgentDetail.helpers";

export function mergeRunEvents(
  currentEvents: HeartbeatRunEvent[],
  incomingEvents: HeartbeatRunEvent[],
): HeartbeatRunEvent[] {
  const eventsBySeq = new Map(
    [...currentEvents, ...incomingEvents].map((event) => [event.seq, event]),
  );
  return [...eventsBySeq.values()].sort((left, right) => left.seq - right.seq);
}

export function advancePersistedRunEventCursor(
  currentCursor: number,
  persistedEvents: HeartbeatRunEvent[],
): number {
  return persistedEvents.reduce(
    (maxSeq, event) => Math.max(maxSeq, event.seq),
    currentCursor,
  );
}

export function runDateToIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

export function openRunTranscriptLocalFile(
  openTarget: (target: SidePanelTarget) => unknown,
  closeTranscriptDialog: () => void,
  targetPath: string,
  label: string,
) {
  closeTranscriptDialog();
  const fileName = (label.trim() || targetPath).split(/[\\/]/u).filter(Boolean).at(-1) ?? targetPath;
  openTarget({
    kind: "local_file",
    filePath: targetPath,
    label: fileName,
  });
}

export function LogViewer({
  run,
  agentRuntimeType,
  onAnnotate,
}: {
  run: HeartbeatRun;
  agentRuntimeType: string;
  onAnnotate?: (input: TranscriptRunAnnotationInput) => void;
}) {
  type RunDetailTab = "transcript" | "invocation";
  const [events, setEvents] = useState<HeartbeatRunEvent[]>([]);
  const [logLines, setLogLines] = useState<RunLogChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [logLoading, setLogLoading] = useState(!!run.logRef);
  const [logError, setLogError] = useState<string | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("nice");
  const [activeDetailTab, setActiveDetailTab] = useState<RunDetailTab>("transcript");
  const [transcriptModalOpen, setTranscriptModalOpen] = useState(false);
  const { openTarget: openSidePanelTarget } = useSidePanel();
  const [transcriptDialogMotion, setTranscriptDialogMotion] = useState({
    fromX: "0px",
    fromY: "-16px",
    settleX: "0px",
    settleY: "0px",
    fromScaleX: "0.96",
    fromScaleY: "0.96",
  });
  const transcriptVisible = activeDetailTab === "transcript";
  const openTranscriptFile = useCallback((targetPath: string, label: string) => {
    openRunTranscriptLocalFile(
      openSidePanelTarget,
      () => setTranscriptModalOpen(false),
      targetPath,
      label,
    );
  }, [openSidePanelTarget]);
  const openTranscriptSkill = useCallback((target: TranscriptSkillTarget) => {
    if (!target.path) return;
    openTranscriptFile(target.path, target.name);
  }, [openTranscriptFile]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const transcriptExpandButtonRef = useRef<HTMLButtonElement>(null);
  const persistedEventCursorRef = useRef(0);
  const pendingLogLineRef = useRef("");
  const seenLogChunkKeysRef = useRef<Set<string>>(new Set());
  const scrollContainerRef = useRef<ScrollContainer | null>(null);
  const isFollowingRef = useRef(false);
  const lastMetricsRef = useRef<{ scrollHeight: number; distanceFromBottom: number }>({
    scrollHeight: 0,
    distanceFromBottom: Number.POSITIVE_INFINITY,
  });
  const isLive = run.status === "running" || run.status === "queued";
  const activityCoordinator = useActivityCoordinator();
  const handleAnnotate = useCallback((input: TranscriptRunAnnotationInput) => {
    setTranscriptModalOpen(false);
    onAnnotate?.(input);
  }, [onAnnotate]);
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
  const liveTranscriptSize = liveTranscriptByRun.get(run.id)?.length ?? 0;
  const { data: workspaceOperations = [] } = useQuery({
    queryKey: queryKeys.runWorkspaceOperations(run.id),
    queryFn: () => agentRunsApi.workspaceOperations(run.id),
    refetchInterval: isLive ? 2000 : false,
  });

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
    queryKey: queryKeys.runEvents(run.id),
    queryFn: () => agentRunsApi.allEvents(run.id),
  });

  useEffect(() => {
    persistedEventCursorRef.current = 0;
    setEvents([]);
    setLoading(true);
  }, [run.id]);

  useEffect(() => {
    if (initialEvents) {
      persistedEventCursorRef.current = advancePersistedRunEventCursor(
        persistedEventCursorRef.current,
        initialEvents,
      );
      setEvents((currentEvents) => {
        if (currentEvents.length === 0) return initialEvents;
        return mergeRunEvents(currentEvents, initialEvents);
      });
      setLoading(false);
    }
  }, [initialEvents]);

  // The opened Run keeps a cursor-based event backfill so reconnect gaps and
  // terminal races cannot lose structured invocation evidence. Background Runs
  // do not mount LogViewer and therefore do not create this request loop.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let terminalStableReads = 0;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        void backfill();
      }, 2_000);
    };

    const backfill = async () => {
      try {
        const newEvents = await agentRunsApi.events(run.id, persistedEventCursorRef.current, 1_000);
        if (cancelled) return;
        if (newEvents.length > 0) {
          persistedEventCursorRef.current = advancePersistedRunEventCursor(
            persistedEventCursorRef.current,
            newEvents,
          );
          terminalStableReads = 0;
          setEvents((currentEvents) => mergeRunEvents(currentEvents, newEvents));
        } else if (!isLive) {
          terminalStableReads += 1;
        }

        if (isLive || terminalStableReads < 2) schedule();
      } catch {
        // A transient read failure must not turn a reconnect gap into permanent
        // data loss while this Run remains visible.
        if (isLive || terminalStableReads < 2) schedule();
      }
    };

    void backfill();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [isLive, run.id]);

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
  }, [events.length, getScrollContainer, isLive, liveTranscriptSize, logLines.length, transcriptVisible]);

  // Fetch persisted shell log
  useEffect(() => {
    let cancelled = false;
    pendingLogLineRef.current = "";
    seenLogChunkKeysRef.current.clear();
    setLogLines([]);
    setLogError(null);

    // Live Runs use the shared ActivityCoordinator-backed transcript source.
    // Only terminal detail views hydrate the persisted log directly.
    if (isLive || !run.logRef) {
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
          const result = await agentRunsApi.log(run.id, offset, first ? firstLimit : 256_000);
          if (cancelled) break;
          appendLogContent(result.content, result.nextOffset === undefined);
          const next = result.nextOffset ?? result.endOffset ?? offset + utf8ByteLength(result.content);
          offset = next;
          first = false;
          if (result.nextOffset === undefined || isLive) break;
        }
      } catch (err) {
        if (!cancelled) {
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

  // Reuse the single organization event stream owned by LiveUpdatesProvider.
  useEffect(() => {
    if (!isLive) return undefined;
    return activityCoordinator.subscribeLiveEvents((event: LiveEvent) => {
      if (event.orgId !== run.orgId || event.type !== "heartbeat.run.event") return;
      const payload = asRecord(event.payload);
      if (!payload || asNonEmptyString(payload.runId) !== run.id) return;

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
      // Socket delivery updates presentation only. The persisted REST cursor
      // advances exclusively from REST results so a reconnect cannot skip a
      // missing lower sequence.
      setEvents((prev) => mergeRunEvents(prev, [liveEvent]));
    });
  }, [activityCoordinator, isLive, run.agentId, run.id, run.orgId]);

  const censorUsernameInLogs = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  }).data?.censorUsernameInLogs === true;
  const adapterInvokePayloads = useMemo(() => events
    .filter((event) => event.eventType === "adapter.invoke")
    .map((event) => redactPathValue(asRecord(event.payload ?? null), censorUsernameInLogs))
    .filter((payload): payload is Record<string, unknown> => payload !== null), [censorUsernameInLogs, events]);
  const adapterInvokePayload = adapterInvokePayloads[0] ?? null;
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
    const eventTranscript = heartbeatRunEventsToTranscriptEntries(events, {
      redactText: (value) => redactPathText(value, censorUsernameInLogs),
      redactValue: (value) => redactPathValue(value, censorUsernameInLogs),
    });
    return mergeTranscriptEntries(effectiveLogTranscript, eventTranscript);
  }, [adapter, censorUsernameInLogs, events, liveTranscriptByRun, logLines, run.id]);
  const hasInvocationTab = Boolean(adapterInvokePayload);
  const invocationAgentInstructionStack = readInvocationAgentInstructionStack(adapterInvokePayload);
  const invocationPromptText =
    invocationAgentInstructionStack !== undefined
      ? formatInvocationValueForDisplay(invocationAgentInstructionStack, censorUsernameInLogs)
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

  if (loading || logLoading) {
    return <p className="text-xs text-muted-foreground">Loading run logs...</p>;
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
                    tooltip: "Exact adapter invocation and Agent Instruction stack",
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
              runAnnotationContext={onAnnotate ? {
                sourceRunId: run.id,
                sourceAgentId: run.agentId,
                onAnnotate: handleAnnotate,
              } : undefined}
              onOpenFile={openTranscriptFile}
              onOpenSkill={openTranscriptSkill}
              canOpenSkill={(target) => Boolean(target.path)}
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
              <InvocationMcpEvidence invocationPayloads={adapterInvokePayloads} />
              {invocationPromptText !== null && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Agent Instruction Stack</div>
                  <div className="relative">
                    <CopyText
                      text={invocationPromptText}
                      ariaLabel="Copy agent instruction stack"
                      title="Copy agent instruction stack"
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
              runAnnotationContext={onAnnotate ? {
                sourceRunId: run.id,
                sourceAgentId: run.agentId,
                onAnnotate: handleAnnotate,
              } : undefined}
              onOpenFile={openTranscriptFile}
              onOpenSkill={openTranscriptSkill}
              canOpenSkill={(target) => Boolean(target.path)}
            />
            {logError && (
              <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {logError}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}

/* ---- Keys Tab ---- */
