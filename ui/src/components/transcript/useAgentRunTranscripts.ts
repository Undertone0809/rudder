import type { TranscriptEntry } from "@/agent-runtimes";
import {
  agentRunsApi,
  type AgentRunTranscriptPage,
  type AgentRunTranscriptResult,
} from "@/api/agent-runs";
import { chatsApi } from "@/api/chats";
import type { ChatMessage } from "@rudderhq/shared";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { projectReaderTranscriptEntries } from "./native-presentation";

const TRANSCRIPT_POLL_INTERVAL_MS = 2_000;
const TRANSCRIPT_PAGE_LIMIT = 50;
const TRANSCRIPT_MAX_CURSOR_HISTORY = 8;
const LEGACY_TRANSCRIPT_MAX_MESSAGES = 50;

export interface AgentRunTranscriptTarget {
  runId: string;
  active?: boolean;
}

export interface AgentRunTranscriptState {
  loading: boolean;
  fetching: boolean;
  hasData: boolean;
  error: Error | null;
  source: AgentRunTranscriptResult["source"];
  revision: AgentRunTranscriptResult["revision"];
  availability: AgentRunTranscriptResult["availability"];
  completeness: AgentRunTranscriptResult["completeness"];
}

export interface AgentRunTranscriptNavigation {
  cursor: string | null;
  pageNumber: number;
  previousPageCount: number;
  historyTruncated: boolean;
  canPrevious: boolean;
  canNext: boolean;
  hasMore: boolean;
  revision: string | null;
  onPrevious: () => void;
  onNext: () => void;
  onReset?: () => void;
  resetting?: boolean;
}

export function isAgentRunTranscriptActiveStatus(status: string | null | undefined): boolean {
  return status === "queued" || status === "running" || status === "starting"
    || status === "streaming" || status === "tool_busy" || status === "finalizing"
    || status === "stopping" || status === "stop_requested" || status === "closing";
}

export function chatTranscriptEntriesForMessage(
  message: Pick<ChatMessage, "id" | "runId" | "transcript">,
  loadedTranscriptsByMessageId: Readonly<Record<string, TranscriptEntry[]>>,
  transcriptByRun: ReadonlyMap<string, TranscriptEntry[]>,
): TranscriptEntry[] {
  if (message.runId) return transcriptByRun.get(message.runId) ?? [];
  return loadedTranscriptsByMessageId[message.id] ?? (message.transcript ?? []) as TranscriptEntry[];
}

export async function readLegacyChatTranscript(
  chatId: string,
  messageId: string,
  runId?: string | null,
): Promise<TranscriptEntry[]> {
  if (runId) {
    throw new Error("Native Agent Run transcripts must be loaded through the Transcript Reader.");
  }
  const response = await chatsApi.getMessageTranscript(chatId, messageId);
  return response.transcript as TranscriptEntry[];
}

function normalizeTargets(targets: readonly AgentRunTranscriptTarget[]) {
  const byRunId = new Map<string, AgentRunTranscriptTarget>();
  for (const target of targets) {
    const runId = target.runId.trim();
    if (!runId) continue;
    const existing = byRunId.get(runId);
    byRunId.set(runId, {
      runId,
      active: Boolean(existing?.active || target.active),
    });
  }
  return [...byRunId.values()].sort((left, right) => left.runId.localeCompare(right.runId));
}

export function agentRunTranscriptQueryKey(
  runId: string,
  cursor: string | null = null,
  resetGeneration = 0,
  resetReadNonce: string | null = null,
) {
  const key = ["agent-run-transcript", runId, cursor, resetGeneration] as const;
  return resetReadNonce === null ? key : [...key, resetReadNonce] as const;
}

interface CursorNavigationState {
  cursor: string | null;
  previousCursors: Array<string | null>;
  droppedPreviousPages: number;
  revision: string | null;
  resetGeneration: number;
  resetReadNonce: string | null;
}

const INITIAL_CURSOR_NAVIGATION: CursorNavigationState = {
  cursor: null,
  previousCursors: [],
  droppedPreviousPages: 0,
  revision: null,
  resetGeneration: 0,
  resetReadNonce: null,
};

interface NormalizedTranscriptPage extends AgentRunTranscriptResult {
  presentationEntries: TranscriptEntry[];
}

function normalizeTranscriptPage(page: AgentRunTranscriptPage): NormalizedTranscriptPage {
  const entries: TranscriptEntry[] = [];
  for (const [index, row] of (page.entries ?? []).entries()) {
    const directEntry = row as unknown as TranscriptEntry;
    const entry = row?.entry ?? (directEntry.kind && directEntry.ts ? directEntry : null);
    if (!entry || typeof entry !== "object" || typeof entry.kind !== "string" || typeof entry.ts !== "string") continue;
    const rowId = typeof row?.id === "string" && row.id.length > 0
      ? row.id
      : (typeof entry.sourceEntryId === "string" && entry.sourceEntryId.length > 0
        ? entry.sourceEntryId
        : `reader:${page.page.cursor ?? "first"}:${index}`);
    entries.push(
      typeof entry.sourceEntryId === "string" ? entry : { ...entry, sourceEntryId: rowId },
    );
  }
  return {
    entries,
    presentationEntries: projectReaderTranscriptEntries(entries, page.run),
    source: page.source ?? null,
    revision: page.revision ?? null,
    availability: page.availability ?? null,
    completeness: page.completeness ?? (page.page.hasMore ? "partial" : "complete"),
    page: page.page,
  };
}

async function readAgentRunTranscriptPage(
  runId: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<NormalizedTranscriptPage> {
  const page = await agentRunsApi.transcript(runId, {
    cursor,
    includeOutput: false,
    turnLimit: TRANSCRIPT_PAGE_LIMIT,
    maxChars: 4_000,
  }, { signal });
  if (!page.page || typeof page.page.hasMore !== "boolean") {
    throw new Error("Transcript API returned invalid page metadata");
  }
  if (page.page.hasMore && (!page.page.nextCursor || page.page.nextCursor === cursor)) {
    throw new Error("Transcript API returned a non-advancing cursor");
  }
  return normalizeTranscriptPage(page);
}

export function legacyChatTranscriptQueryKey(chatId: string, messageId: string) {
  return ["chat-message-transcript", chatId, messageId] as const;
}

export function useLegacyChatTranscripts(
  chatId: string | null | undefined,
  messages: readonly ChatMessage[],
) {
  const targetKey = messages
    .filter((message) => !message.runId && (message.transcriptSummary?.entryCount ?? 0) > 0)
    .slice(-LEGACY_TRANSCRIPT_MAX_MESSAGES)
    .map((message) => message.id)
    .join("|");
  const targets = useMemo(
    () => messages
      .filter((message) => !message.runId && (message.transcriptSummary?.entryCount ?? 0) > 0)
      .slice(-LEGACY_TRANSCRIPT_MAX_MESSAGES),
    [messages, targetKey],
  );
  const queries = useQueries({
    queries: targets.map((message) => ({
      queryKey: legacyChatTranscriptQueryKey(chatId ?? "__none__", message.id),
      queryFn: () => readLegacyChatTranscript(chatId!, message.id),
      enabled: Boolean(chatId),
      refetchOnWindowFocus: false,
      retry: false,
    })),
  });
  return useMemo(() => {
    const result = new Map<string, TranscriptEntry[]>();
    targets.forEach((message, index) => {
      const transcript = queries[index]?.data;
      if (transcript) result.set(message.id, transcript);
    });
    return result;
  }, [queries, targets]);
}

export function useAgentRunTranscripts(
  targets: readonly AgentRunTranscriptTarget[],
  options: { raw?: boolean } = {},
) {
  const targetKey = targets
    .map((target) => `${target.runId}:${target.active ? "active" : "idle"}`)
    .sort()
    .join("|");
  const normalizedTargets = useMemo(
    () => normalizeTargets(targets),
    [targetKey],
  );
  const [navigationByRunState, setNavigationByRunState] = useState<Record<string, CursorNavigationState>>({});
  const previousActiveByRun = useRef(new Map<string, boolean>());
  const manualResetGenerationByRun = useRef(new Map<string, number>());
  const readerInstanceId = useId();
  const manualReadSequence = useRef(0);
  const navigationForRun = useCallback(
    (runId: string) => navigationByRunState[runId] ?? INITIAL_CURSOR_NAVIGATION,
    [navigationByRunState],
  );
  const queries = useQueries({
    queries: normalizedTargets.map((target) => ({
      queryKey: agentRunTranscriptQueryKey(
        target.runId,
        navigationForRun(target.runId).cursor,
        navigationForRun(target.runId).resetGeneration,
        navigationForRun(target.runId).resetReadNonce,
      ),
      queryFn: ({ signal }) => readAgentRunTranscriptPage(
        target.runId,
        navigationForRun(target.runId).cursor,
        signal,
      ),
      refetchInterval: target.active ? TRANSCRIPT_POLL_INTERVAL_MS : false,
      refetchOnWindowFocus: false,
      retry: false,
      gcTime: 60_000,
    })),
  });

  const queryRevisionKey = normalizedTargets
    .map((target, index) => `${target.runId}:${queries[index]?.data?.revision ?? ""}:${queries[index]?.isPending ? "pending" : "ready"}`)
    .join("|");

  useEffect(() => {
    const knownRunIds = new Set(normalizedTargets.map(target => target.runId));
    for (const runId of manualResetGenerationByRun.current.keys()) {
      if (!knownRunIds.has(runId)) manualResetGenerationByRun.current.delete(runId);
    }
    normalizedTargets.forEach((target, index) => {
      const generation = manualResetGenerationByRun.current.get(target.runId);
      const query = queries[index];
      if (generation !== undefined && navigationForRun(target.runId).resetGeneration >= generation
        && query && !query.isPending && !query.isFetching) {
        manualResetGenerationByRun.current.delete(target.runId);
      }
    });
  }, [navigationForRun, normalizedTargets, queries]);

  useEffect(() => {
    const knownRunIds = new Set(normalizedTargets.map((target) => target.runId));
    const terminalTransitions = new Set(normalizedTargets
      .filter((target) => !target.active && previousActiveByRun.current.get(target.runId) === true)
      .map((target) => target.runId));
    previousActiveByRun.current = new Map(normalizedTargets.map((target) => [target.runId, Boolean(target.active)]));
    setNavigationByRunState((current) => {
      let changed = false;
      const next: Record<string, CursorNavigationState> = {};
      for (const [runId, navigation] of Object.entries(current)) {
        if (knownRunIds.has(runId)) next[runId] = navigation;
        else changed = true;
      }
      normalizedTargets.forEach((target, index) => {
        const queryData = queries[index]?.data;
        const currentNavigation = current[target.runId] ?? INITIAL_CURSOR_NAVIGATION;
        if (terminalTransitions.has(target.runId)) {
          // Stopping the interval alone leaves the last live snapshot cached.
          // Start one fresh first-page query: terminal publication can invalidate
          // live cursors. If unused, the old query's Reader is aborted via its
          // consumed signal; another mounted consumer may still need it. Either
          // way, late live data cannot overwrite this fresh query key.
          next[target.runId] = {
            ...INITIAL_CURSOR_NAVIGATION,
            resetGeneration: currentNavigation.resetGeneration + 1,
            resetReadNonce: currentNavigation.resetReadNonce,
          };
          changed = true;
          return;
        }
        if (!queryData?.revision) {
          if (!(target.runId in current)) next[target.runId] = currentNavigation;
          return;
        }
        if (!currentNavigation.revision) {
          next[target.runId] = { ...currentNavigation, revision: queryData.revision };
          changed = true;
          return;
        }
        if (currentNavigation.revision === queryData.revision) {
          next[target.runId] = currentNavigation;
          return;
        }
        if (currentNavigation.cursor === null && currentNavigation.previousCursors.length === 0) {
          next[target.runId] = { ...currentNavigation, revision: queryData.revision };
        } else {
          next[target.runId] = {
            ...INITIAL_CURSOR_NAVIGATION,
            resetGeneration: currentNavigation.resetGeneration + 1,
            resetReadNonce: currentNavigation.resetReadNonce,
          };
        }
        changed = true;
      });
      return changed ? next : current;
    });
  }, [normalizedTargets, queryRevisionKey, queries]);

  const revisionMismatchByRun = useMemo(() => {
    const result = new Map<string, boolean>();
    normalizedTargets.forEach((target, index) => {
      const expectedRevision = navigationForRun(target.runId).revision;
      const observedRevision = queries[index]?.data?.revision ?? null;
      result.set(
        target.runId,
        Boolean(expectedRevision && observedRevision && expectedRevision !== observedRevision),
      );
    });
    return result;
  }, [navigationForRun, normalizedTargets, queries]);

  const transcriptByRun = useMemo(() => {
    const result = new Map<string, TranscriptEntry[]>();
    normalizedTargets.forEach((target, index) => {
      const data = queries[index]?.data;
      const transcript = options.raw ? data?.entries : data?.presentationEntries;
      if (transcript && !revisionMismatchByRun.get(target.runId)) result.set(target.runId, transcript);
    });
    return result;
  }, [normalizedTargets, options.raw, queries, revisionMismatchByRun]);

  const transcriptStateByRun = useMemo(() => {
    const result = new Map<string, AgentRunTranscriptState>();
    normalizedTargets.forEach((target, index) => {
      const query = queries[index];
      const error = query?.error
        ? query.error instanceof Error
          ? query.error
          : new Error("Could not load the Agent Run transcript.")
        : null;
      result.set(target.runId, {
        loading: Boolean(query?.isPending && !query.data),
        fetching: Boolean(query?.isFetching),
        hasData: query?.data !== undefined && !revisionMismatchByRun.get(target.runId),
        error,
        source: revisionMismatchByRun.get(target.runId) ? null : query?.data?.source ?? null,
        revision: revisionMismatchByRun.get(target.runId) ? null : query?.data?.revision ?? null,
        availability: revisionMismatchByRun.get(target.runId) ? null : query?.data?.availability ?? null,
        completeness: revisionMismatchByRun.get(target.runId) ? null : query?.data?.completeness ?? null,
      });
    });
    return result;
  }, [normalizedTargets, queries, revisionMismatchByRun]);

  const goToPreviousPage = useCallback((runId: string) => {
    setNavigationByRunState((current) => {
      const navigation = current[runId] ?? INITIAL_CURSOR_NAVIGATION;
      if (navigation.previousCursors.length === 0) return current;
      const previousCursors = navigation.previousCursors.slice();
      const cursor = previousCursors.pop() ?? null;
      return {
        ...current,
        [runId]: {
          ...navigation,
          cursor,
          previousCursors,
        },
      };
    });
  }, []);

  const goToNextPage = useCallback((runId: string, nextCursor: string | null) => {
    if (!nextCursor) return;
    setNavigationByRunState((current) => {
      const navigation = current[runId] ?? INITIAL_CURSOR_NAVIGATION;
      if (navigation.cursor === nextCursor) return current;
      const previousCursors = [...navigation.previousCursors, navigation.cursor];
      const droppedPreviousPages = navigation.droppedPreviousPages
        + Math.max(0, previousCursors.length - TRANSCRIPT_MAX_CURSOR_HISTORY);
      return {
        ...current,
        [runId]: {
          ...navigation,
          cursor: nextCursor,
          previousCursors: previousCursors.slice(-TRANSCRIPT_MAX_CURSOR_HISTORY),
          droppedPreviousPages,
        },
      };
    });
  }, []);

  // A user-requested new read, not authorization of the discarded cursor.
  // Use a new key even at page one; never append old pages or retry an error.
  const resetRun = useCallback((runId: string) => {
    if (!normalizedTargets.some(target => target.runId === runId)
      || manualResetGenerationByRun.current.has(runId)) return;
    const resetGeneration = navigationForRun(runId).resetGeneration + 1;
    // Local generation numbers can collide with a fresh shared/remounted
    // consumer's cache. React's instance ID plus an action sequence makes this
    // user's read independent, without invalidating another consumer's query.
    const resetReadNonce = `${readerInstanceId}:${++manualReadSequence.current}`;
    manualResetGenerationByRun.current.set(runId, resetGeneration);
    setNavigationByRunState(current => ({
      ...current,
      [runId]: { ...INITIAL_CURSOR_NAVIGATION, resetGeneration, resetReadNonce },
    }));
  }, [navigationForRun, normalizedTargets, readerInstanceId]);

  const transcriptNavigationByRun = useMemo(() => {
    const result = new Map<string, AgentRunTranscriptNavigation>();
    normalizedTargets.forEach((target, index) => {
      const navigation = navigationForRun(target.runId);
      const page = queries[index]?.data?.page;
      const revisionMismatch = revisionMismatchByRun.get(target.runId) === true;
      const canNext = !revisionMismatch && Boolean(page?.hasMore && page.nextCursor);
      result.set(target.runId, {
        cursor: navigation.cursor,
        pageNumber: navigation.droppedPreviousPages + navigation.previousCursors.length + 1,
        previousPageCount: navigation.previousCursors.length,
        historyTruncated: navigation.droppedPreviousPages > 0,
        canPrevious: navigation.previousCursors.length > 0,
        canNext,
        hasMore: !revisionMismatch && Boolean(page?.hasMore),
        revision: revisionMismatch ? null : queries[index]?.data?.revision ?? navigation.revision,
        onPrevious: () => goToPreviousPage(target.runId),
        onNext: () => goToNextPage(target.runId, page?.nextCursor ?? null),
        onReset: () => resetRun(target.runId),
        resetting: manualResetGenerationByRun.current.has(target.runId)
          && Boolean(queries[index]?.isPending || queries[index]?.isFetching),
      });
    });
    return result;
  }, [goToNextPage, goToPreviousPage, navigationForRun, normalizedTargets, queries, resetRun, revisionMismatchByRun]);

  const queryByRun = useMemo(
    () => new Map(normalizedTargets.map((target, index) => [target.runId, queries[index]])),
    [normalizedTargets, queries],
  );
  const refetchRun = useCallback(async (runId: string): Promise<AgentRunTranscriptResult | null> => {
    const query = queryByRun.get(runId);
    if (!query) return null;
    const result = await query.refetch();
    if (!result.data) return null;
    return { ...result.data, entries: options.raw ? result.data.entries : result.data.presentationEntries };
  }, [options.raw, queryByRun]);

  return {
    transcriptByRun,
    transcriptStateByRun,
    transcriptNavigationByRun,
    refetchRun,
    resetRun,
    hasOutputForRun(runId: string) {
      return (transcriptByRun.get(runId)?.length ?? 0) > 0;
    },
  };
}
