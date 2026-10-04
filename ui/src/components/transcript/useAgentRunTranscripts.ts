import type { TranscriptEntry } from "@/agent-runtimes";
import { ApiError } from "@/api/client";
import {
  agentRunsApi,
  type AgentRunTranscriptPage,
  type AgentRunTranscriptResult,
} from "@/api/agent-runs";
import { chatsApi } from "@/api/chats";
import { useOptionalOrganization } from "@/context/OrganizationContext";
import type { ChatMessage } from "@rudderhq/shared";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { projectReaderTranscriptEntries } from "./native-presentation";

const TRANSCRIPT_POLL_INTERVAL_MS = 2_000;
const TRANSCRIPT_PAGE_LIMIT = 50;
const TRANSCRIPT_MAX_CURSOR_HISTORY = 8;
const LEGACY_TRANSCRIPT_MAX_MESSAGES = 50;
const TRANSCRIPT_QUERY_FILTER_KEY = JSON.stringify({
  output: "full",
  order: "oldest",
  includeOutput: false,
  turnLimit: TRANSCRIPT_PAGE_LIMIT,
  maxChars: 4_000,
});

function isTranscriptAccessFailure(error: unknown): boolean {
  // These responses mean the current actor cannot read this Run's transcript;
  // stale pages are not safe to present as a fallback, even during refresh.
  return error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404);
}

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
  organizationId: string | null = null,
) {
  const key = ["agent-run-transcript", runId, cursor, resetGeneration, TRANSCRIPT_QUERY_FILTER_KEY] as const;
  const withNonce = resetReadNonce === null ? key : [...key, resetReadNonce] as const;
  return organizationId === null ? withNonce : [...withNonce, "organization", organizationId] as const;
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

interface RetainedTranscriptPage {
  data: NormalizedTranscriptPage;
  navigation: CursorNavigationState;
}

interface DisplayTranscriptPage extends RetainedTranscriptPage {
  retained: boolean;
}

function transcriptRetentionScopeKey(organizationId: string | null, runId: string, raw: boolean) {
  return JSON.stringify([
    organizationId,
    runId,
    TRANSCRIPT_QUERY_FILTER_KEY,
    raw ? "raw" : "presentation",
  ]);
}

function transcriptRunScopeKey(organizationId: string | null, runId: string) {
  return JSON.stringify([organizationId, runId]);
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
  const organizationId = useOptionalOrganization()?.selectedOrganizationId ?? null;
  const raw = options.raw === true;
  const targetKey = targets
    .map((target) => `${target.runId}:${target.active ? "active" : "idle"}`)
    .sort()
    .join("|");
  const normalizedTargets = useMemo(
    () => normalizeTargets(targets),
    [targetKey],
  );
  const [navigationByRunState, setNavigationByRunState] = useState<Record<string, CursorNavigationState>>({});
  const [retainedPageByScope, setRetainedPageByScope] = useState(() => new Map<string, RetainedTranscriptPage>());
  const previousActiveByRun = useRef(new Map<string, boolean>());
  const manualResetGenerationByRun = useRef(new Map<string, number>());
  const readerInstanceId = useId();
  const manualReadSequence = useRef(0);
  const navigationForRun = useCallback(
    (runId: string) => navigationByRunState[transcriptRunScopeKey(organizationId, runId)] ?? INITIAL_CURSOR_NAVIGATION,
    [navigationByRunState, organizationId],
  );
  const queries = useQueries({
    queries: normalizedTargets.map((target) => ({
      queryKey: agentRunTranscriptQueryKey(
        target.runId,
        navigationForRun(target.runId).cursor,
        navigationForRun(target.runId).resetGeneration,
        navigationForRun(target.runId).resetReadNonce,
        organizationId,
      ),
      queryFn: async ({ signal }) => {
        const navigation = navigationForRun(target.runId);
        const runScopeKey = transcriptRunScopeKey(organizationId, target.runId);
        try {
          return await readAgentRunTranscriptPage(target.runId, navigation.cursor, signal);
        } finally {
          if (manualResetGenerationByRun.current.get(runScopeKey) === navigation.resetGeneration) {
            manualResetGenerationByRun.current.delete(runScopeKey);
          }
        }
      },
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
    const knownRunScopeKeys = new Set(normalizedTargets.map((target) =>
      transcriptRunScopeKey(organizationId, target.runId)));
    for (const runId of manualResetGenerationByRun.current.keys()) {
      if (!knownRunScopeKeys.has(runId)) manualResetGenerationByRun.current.delete(runId);
    }
    normalizedTargets.forEach((target, index) => {
      const runScopeKey = transcriptRunScopeKey(organizationId, target.runId);
      const generation = manualResetGenerationByRun.current.get(runScopeKey);
      const query = queries[index];
      if (generation !== undefined && navigationForRun(target.runId).resetGeneration >= generation
        && query && !query.isPending && !query.isFetching) {
        manualResetGenerationByRun.current.delete(runScopeKey);
      }
    });
  }, [navigationForRun, normalizedTargets, organizationId, queries]);

  useEffect(() => {
    const knownRunScopeKeys = new Set(normalizedTargets.map((target) =>
      transcriptRunScopeKey(organizationId, target.runId)));
    const terminalTransitions = new Set(normalizedTargets
      .filter((target) => !target.active
        && previousActiveByRun.current.get(transcriptRunScopeKey(organizationId, target.runId)) === true)
      .map((target) => transcriptRunScopeKey(organizationId, target.runId)));
    previousActiveByRun.current = new Map(normalizedTargets.map((target) => [
      transcriptRunScopeKey(organizationId, target.runId),
      Boolean(target.active),
    ]));
    setNavigationByRunState((current) => {
      let changed = false;
      const next: Record<string, CursorNavigationState> = {};
      for (const [runScopeKey, navigation] of Object.entries(current)) {
        if (knownRunScopeKeys.has(runScopeKey)) next[runScopeKey] = navigation;
        else changed = true;
      }
      normalizedTargets.forEach((target, index) => {
        const runScopeKey = transcriptRunScopeKey(organizationId, target.runId);
        const queryData = queries[index]?.data;
        const currentNavigation = current[runScopeKey] ?? INITIAL_CURSOR_NAVIGATION;
        if (terminalTransitions.has(runScopeKey)) {
          // Stopping the interval alone leaves the last live snapshot cached.
          // Start one fresh first-page query: terminal publication can invalidate
          // live cursors. If unused, the old query's Reader is aborted via its
          // consumed signal; another mounted consumer may still need it. Either
          // way, late live data cannot overwrite this fresh query key.
          next[runScopeKey] = {
            ...INITIAL_CURSOR_NAVIGATION,
            resetGeneration: currentNavigation.resetGeneration + 1,
            resetReadNonce: currentNavigation.resetReadNonce,
          };
          changed = true;
          return;
        }
        if (!queryData?.revision) {
          if (!(runScopeKey in current)) next[runScopeKey] = currentNavigation;
          return;
        }
        if (!currentNavigation.revision) {
          next[runScopeKey] = { ...currentNavigation, revision: queryData.revision };
          changed = true;
          return;
        }
        if (currentNavigation.revision === queryData.revision) {
          next[runScopeKey] = currentNavigation;
          return;
        }
        if (currentNavigation.cursor === null && currentNavigation.previousCursors.length === 0) {
          next[runScopeKey] = { ...currentNavigation, revision: queryData.revision };
        } else {
          next[runScopeKey] = {
            ...INITIAL_CURSOR_NAVIGATION,
            resetGeneration: currentNavigation.resetGeneration + 1,
            resetReadNonce: currentNavigation.resetReadNonce,
          };
        }
        changed = true;
      });
      return changed ? next : current;
    });
  }, [normalizedTargets, organizationId, queryRevisionKey, queries]);

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

  useEffect(() => {
    const activeScopeKeys = new Set(normalizedTargets.map((target) =>
      transcriptRetentionScopeKey(organizationId, target.runId, raw)));
    setRetainedPageByScope((current) => {
      const next = new Map<string, RetainedTranscriptPage>();
      for (const [scopeKey, retained] of current) {
        if (activeScopeKeys.has(scopeKey)) next.set(scopeKey, retained);
      }
      let changed = next.size !== current.size;
      normalizedTargets.forEach((target, index) => {
        const scopeKey = transcriptRetentionScopeKey(organizationId, target.runId, raw);
        if (revisionMismatchByRun.get(target.runId) || isTranscriptAccessFailure(queries[index]?.error)) {
          if (next.delete(scopeKey)) changed = true;
          return;
        }
        const data = queries[index]?.data;
        if (!data) return;
        const navigation = navigationForRun(target.runId);
        const existing = next.get(scopeKey);
        if (existing?.data === data && existing.navigation === navigation) return;
        next.set(scopeKey, { data, navigation });
        changed = true;
      });
      return changed ? next : current;
    });
  }, [navigationForRun, normalizedTargets, organizationId, queries, raw, revisionMismatchByRun]);

  const displayPageByRun = useMemo(() => {
    const result = new Map<string, DisplayTranscriptPage>();
    normalizedTargets.forEach((target, index) => {
      if (revisionMismatchByRun.get(target.runId) || isTranscriptAccessFailure(queries[index]?.error)) return;
      const data = queries[index]?.data;
      if (data) {
        result.set(target.runId, {
          data,
          navigation: navigationForRun(target.runId),
          retained: false,
        });
        return;
      }
      const retained = retainedPageByScope.get(
        transcriptRetentionScopeKey(organizationId, target.runId, raw),
      );
      if (retained) result.set(target.runId, { ...retained, retained: true });
    });
    return result;
  }, [navigationForRun, normalizedTargets, organizationId, queries, raw, retainedPageByScope, revisionMismatchByRun]);

  const transcriptByRun = useMemo(() => {
    const result = new Map<string, TranscriptEntry[]>();
    normalizedTargets.forEach((target) => {
      const data = displayPageByRun.get(target.runId)?.data;
      const transcript = raw ? data?.entries : data?.presentationEntries;
      if (transcript) result.set(target.runId, transcript);
    });
    return result;
  }, [displayPageByRun, normalizedTargets, raw]);

  const transcriptStateByRun = useMemo(() => {
    const result = new Map<string, AgentRunTranscriptState>();
    normalizedTargets.forEach((target, index) => {
      const query = queries[index];
      const error = query?.error
        ? query.error instanceof Error
          ? query.error
          : new Error("Could not load the Agent Run transcript.")
        : null;
      const data = displayPageByRun.get(target.runId)?.data;
      result.set(target.runId, {
        loading: Boolean(query?.isPending && !query.data),
        fetching: Boolean(query?.isFetching),
        hasData: data !== undefined,
        error,
        source: data?.source ?? null,
        revision: data?.revision ?? null,
        availability: data?.availability ?? null,
        completeness: data?.completeness ?? null,
      });
    });
    return result;
  }, [displayPageByRun, normalizedTargets, queries]);

  const goToPreviousPage = useCallback((runId: string, retainedNavigation?: CursorNavigationState) => {
    setNavigationByRunState((current) => {
      const currentNavigation = current[runId] ?? INITIAL_CURSOR_NAVIGATION;
      const navigation = retainedNavigation ?? currentNavigation;
      if (navigation.previousCursors.length === 0) return current;
      const previousCursors = navigation.previousCursors.slice();
      const cursor = previousCursors.pop() ?? null;
      return {
        ...current,
        [runId]: {
          ...currentNavigation,
          cursor,
          previousCursors,
          droppedPreviousPages: navigation.droppedPreviousPages,
          revision: navigation.revision,
        },
      };
    });
  }, []);

  const goToNextPage = useCallback((runId: string, nextCursor: string | null, retainedNavigation?: CursorNavigationState) => {
    if (!nextCursor) return;
    setNavigationByRunState((current) => {
      const currentNavigation = current[runId] ?? INITIAL_CURSOR_NAVIGATION;
      const navigation = retainedNavigation ?? currentNavigation;
      if (navigation.cursor === nextCursor) return current;
      const previousCursors = [...navigation.previousCursors, navigation.cursor];
      const droppedPreviousPages = navigation.droppedPreviousPages
        + Math.max(0, previousCursors.length - TRANSCRIPT_MAX_CURSOR_HISTORY);
      return {
        ...current,
        [runId]: {
          ...currentNavigation,
          cursor: nextCursor,
          previousCursors: previousCursors.slice(-TRANSCRIPT_MAX_CURSOR_HISTORY),
          droppedPreviousPages,
          revision: navigation.revision,
        },
      };
    });
  }, []);

  // A user-requested new read, not authorization of the discarded cursor.
  // Use a new key even at page one; never append old pages or retry an error.
  const resetRun = useCallback((runId: string) => {
    const runScopeKey = transcriptRunScopeKey(organizationId, runId);
    if (!normalizedTargets.some(target => target.runId === runId)
      || manualResetGenerationByRun.current.has(runScopeKey)) return;
    const resetGeneration = navigationForRun(runId).resetGeneration + 1;
    // Local generation numbers can collide with a fresh shared/remounted
    // consumer's cache. React's instance ID plus an action sequence makes this
    // user's read independent, without invalidating another consumer's query.
    const resetReadNonce = `${readerInstanceId}:${++manualReadSequence.current}`;
    manualResetGenerationByRun.current.set(runScopeKey, resetGeneration);
    setNavigationByRunState(current => ({
      ...current,
      [runScopeKey]: { ...INITIAL_CURSOR_NAVIGATION, resetGeneration, resetReadNonce },
    }));
  }, [navigationForRun, normalizedTargets, organizationId, readerInstanceId]);

  const transcriptNavigationByRun = useMemo(() => {
    const result = new Map<string, AgentRunTranscriptNavigation>();
    normalizedTargets.forEach((target, index) => {
      const runScopeKey = transcriptRunScopeKey(organizationId, target.runId);
      const accessFailure = isTranscriptAccessFailure(queries[index]?.error);
      const displayPage = accessFailure ? undefined : displayPageByRun.get(target.runId);
      const navigation = accessFailure
        ? INITIAL_CURSOR_NAVIGATION
        : displayPage?.retained ? displayPage.navigation : navigationForRun(target.runId);
      const page = displayPage?.data.page;
      const revisionMismatch = revisionMismatchByRun.get(target.runId) === true;
      const canNext = !accessFailure && !revisionMismatch && Boolean(page?.hasMore && page.nextCursor);
      const retainedNavigation = displayPage?.retained ? navigation : undefined;
      result.set(target.runId, {
        cursor: navigation.cursor,
        pageNumber: navigation.droppedPreviousPages + navigation.previousCursors.length + 1,
        previousPageCount: navigation.previousCursors.length,
        historyTruncated: navigation.droppedPreviousPages > 0,
        canPrevious: !accessFailure && navigation.previousCursors.length > 0,
        canNext,
        hasMore: !accessFailure && !revisionMismatch && Boolean(page?.hasMore),
        revision: accessFailure || revisionMismatch ? null : displayPage?.data.revision ?? navigation.revision,
        onPrevious: () => {
          if (!accessFailure) goToPreviousPage(runScopeKey, retainedNavigation);
        },
        onNext: () => {
          if (!accessFailure) goToNextPage(runScopeKey, page?.nextCursor ?? null, retainedNavigation);
        },
        onReset: () => resetRun(target.runId),
        resetting: manualResetGenerationByRun.current.has(runScopeKey)
          && Boolean(queries[index]?.isPending || queries[index]?.isFetching),
      });
    });
    return result;
  }, [displayPageByRun, goToNextPage, goToPreviousPage, navigationForRun, normalizedTargets, organizationId, queries, resetRun, revisionMismatchByRun]);

  const queryByRun = useMemo(
    () => new Map(normalizedTargets.map((target, index) => [target.runId, queries[index]])),
    [normalizedTargets, queries],
  );
  const refetchRun = useCallback(async (runId: string): Promise<AgentRunTranscriptResult | null> => {
    const query = queryByRun.get(runId);
    if (!query) return null;
    const result = await query.refetch();
    if (!result.data || isTranscriptAccessFailure(result.error)) return null;
    return { ...result.data, entries: raw ? result.data.entries : result.data.presentationEntries };
  }, [queryByRun, raw]);

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
