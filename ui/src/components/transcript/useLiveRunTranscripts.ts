import { redactTranscriptEntryPaths } from "@rudderhq/agent-runtime-utils";
import type { LiveEvent } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { getUIAdapter, type StdoutLineParser, type TranscriptEntry } from "../../agent-runtimes";
import {
  appendRunLogChunkToTranscript,
  createTranscriptLogBuildState,
  flushTranscriptLogBuffer,
  type RunLogChunk,
  type TranscriptBuildOptions,
} from "../../agent-runtimes/transcript";
import {
  agentRunsApi,
  AGENT_RUN_TRANSCRIPT_TURN_LIMIT,
  type AgentRunTranscriptAvailability,
  type AgentRunTranscriptCompleteness,
  type AgentRunTranscriptResult,
  type AgentRunTranscriptSource,
  type LiveRunForIssue,
} from "../../api/agent-runs";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { useActivityCoordinator } from "../../context/ActivityCoordinatorContext";
import { queryKeys } from "../../lib/queryKeys";
import { heartbeatRunEventTranscriptEntry } from "../../lib/run-detail-events";

const TRANSCRIPT_POLL_INTERVAL_MS = 2000;
const TRANSCRIPT_ERROR_COOLDOWN_MS = 30_000;
const TERMINAL_TRANSCRIPT_STABLE_READS_REQUIRED = 2;
type LiveChunkSource = "live" | "event-fallback";
type LiveLogChunk = { type: "log"; chunk: RunLogChunk; source: LiveChunkSource };
type LiveEntryChunk = { type: "entry"; entry: TranscriptEntry; source: LiveChunkSource };
type LiveTranscriptChunk = LiveLogChunk | LiveEntryChunk;
type IncomingLiveTranscriptChunk = (LiveLogChunk | LiveEntryChunk) & { dedupeKey: string };

function runIdFromDedupeKey(key: string): string | null {
  for (const prefix of ["log:", "socket:event:", "socket:status:"]) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    const separatorIndex = suffix.indexOf(":");
    return separatorIndex === -1 ? suffix : suffix.slice(0, separatorIndex);
  }
  return null;
}

interface UseLiveRunTranscriptsOptions {
  runs: LiveRunForIssue[];
  orgId?: string | null;
  maxChunksPerRun?: number;
  includeRunEvents?: boolean;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readEventId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function transcriptEntryKey(entry: TranscriptEntry): string {
  if (typeof entry.sourceEntryId === "string" && entry.sourceEntryId.length > 0) {
    return `source:${entry.sourceEntryId}`;
  }
  const record = entry as unknown as Record<string, unknown>;
  for (const field of ["toolUseId", "todoListId", "sessionId"] as const) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return `semantic:${entry.kind}:${field}:${value}`;
  }
  const text = "text" in entry
    ? entry.text
    : "content" in entry
      ? entry.content
      : "name" in entry
        ? entry.name
        : "";
  return `${entry.kind}:${entry.ts}:${text}`;
}

function transcriptResultFromPage(page: Awaited<ReturnType<typeof agentRunsApi.transcript>>): AgentRunTranscriptResult {
  const entriesById = new Map<string, TranscriptEntry>();
  for (const [index, row] of (page.entries ?? []).entries()) {
    const directEntry = row as unknown as TranscriptEntry;
    const entry = row?.entry ?? (directEntry.kind && directEntry.ts ? directEntry : null);
    if (!entry || typeof entry !== "object" || typeof entry.kind !== "string" || typeof entry.ts !== "string") continue;
    const rowId = typeof row?.id === "string"
      ? row.id
      : (typeof entry.sourceEntryId === "string" ? entry.sourceEntryId : `reader:${index}`);
    entriesById.set(
      rowId,
      typeof entry.sourceEntryId === "string" ? entry : { ...entry, sourceEntryId: rowId },
    );
  }
  return {
    entries: [...entriesById.values()],
    source: page.source ?? null,
    revision: page.revision ?? null,
    availability: page.availability ?? null,
    completeness: page.completeness ?? null,
    page: page.page,
  };
}

function mergeTranscriptEntriesUnique(...groups: TranscriptEntry[][]): TranscriptEntry[] {
  const entriesByKey = new Map<string, TranscriptEntry>();
  for (const group of groups) {
    for (const entry of group) {
      entriesByKey.set(transcriptEntryKey(entry), entry);
    }
  }
  return [...entriesByKey.values()].sort((left, right) => {
    const leftTime = Date.parse(left.ts);
    const rightTime = Date.parse(right.ts);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return 0;
  });
}

function unavailableTranscriptError(availability: AgentRunTranscriptAvailability): Error | null {
  if (availability === "available") return null;
  return new Error(`Transcript ${availability}`);
}

export interface LiveRunTranscriptState {
  loading: boolean;
  source: AgentRunTranscriptSource | null;
  revision: string | null;
  availability: AgentRunTranscriptAvailability | null;
  completeness: AgentRunTranscriptCompleteness | null;
  error: Error | null;
}

function buildLiveTranscript(
  chunks: LiveTranscriptChunk[],
  parser: StdoutLineParser,
  opts: TranscriptBuildOptions,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const state = createTranscriptLogBuildState();

  for (const chunk of chunks) {
    if (chunk.type === "entry") {
      entries.push(chunk.entry);
      continue;
    }
    appendRunLogChunkToTranscript(entries, state, chunk.chunk, parser, opts);
  }
  flushTranscriptLogBuffer(entries, state, parser, opts);
  return entries;
}

function isTerminalStatus(status: string): boolean {
  return status === "failed" || status === "timed_out" || status === "cancelled" || status === "succeeded";
}

type SharedRunTranscriptSource = {
  run: LiveRunForIssue;
  result: AgentRunTranscriptResult | null;
  error: Error | null;
  cooldownUntil: number;
  stableReads: number;
  settled: boolean;
  reading: boolean;
  timer: ReturnType<typeof setInterval> | null;
  subscribers: Set<(result: AgentRunTranscriptResult | null, error: Error | null, loading: boolean) => void>;
};

const sharedRunTranscriptSources = new Map<string, SharedRunTranscriptSource>();

function transcriptResultSignature(result: AgentRunTranscriptResult | null): string {
  if (!result) return "pending";
  const last = result.entries.at(-1);
  return [
    result.revision ?? "",
    result.source ?? "",
    result.availability ?? "",
    result.completeness ?? "",
    result.entries.length,
    last ? transcriptEntryKey(last) : "",
  ].join("|");
}

function readSharedRunTranscriptSource(source: SharedRunTranscriptSource) {
  if (source.reading || source.settled || source.cooldownUntil > Date.now()) return;
  source.reading = true;
  const previousSignature = transcriptResultSignature(source.result);
  for (const subscriber of source.subscribers) subscriber(source.result, source.error, true);
  void agentRunsApi.transcript(source.run.id, {
    includeOutput: false,
    turnLimit: AGENT_RUN_TRANSCRIPT_TURN_LIMIT,
  }).then(transcriptResultFromPage).then((result) => {
    source.cooldownUntil = 0;
    source.error = unavailableTranscriptError(result.availability ?? "available");
    source.result = result;
    const stableRead = transcriptResultSignature(result) === previousSignature;
    source.stableReads = stableRead ? source.stableReads + 1 : 0;
    source.settled = isTerminalStatus(source.run.status)
      && source.stableReads >= TERMINAL_TRANSCRIPT_STABLE_READS_REQUIRED;
    for (const subscriber of source.subscribers) subscriber(result, source.error, false);
  }, (error) => {
    source.error = error instanceof Error ? error : new Error("Failed to read normalized transcript");
    source.cooldownUntil = Date.now() + TRANSCRIPT_ERROR_COOLDOWN_MS;
    for (const subscriber of source.subscribers) subscriber(source.result, source.error, false);
  }).finally(() => {
    source.reading = false;
  });
}

function subscribeSharedRunTranscript(
  run: LiveRunForIssue,
  subscriber: (result: AgentRunTranscriptResult | null, error: Error | null, loading: boolean) => void,
) {
  let source = sharedRunTranscriptSources.get(run.id);
  if (!source) {
    source = {
      run,
      result: null,
      error: null,
      cooldownUntil: 0,
      stableReads: 0,
      settled: false,
      reading: false,
      timer: null,
      subscribers: new Set(),
    };
    sharedRunTranscriptSources.set(run.id, source);
  } else {
    const wasTerminal = isTerminalStatus(source.run.status);
    source.run = run;
    if (wasTerminal && !isTerminalStatus(run.status)) {
      source.stableReads = 0;
      source.settled = false;
    }
  }
  source.subscribers.add(subscriber);
  subscriber(source.result, source.error, source.result === null && source.error === null);
  readSharedRunTranscriptSource(source);
  if (source.timer === null) {
    source.timer = setInterval(() => readSharedRunTranscriptSource(source!), TRANSCRIPT_POLL_INTERVAL_MS);
  }

  return () => {
    source!.subscribers.delete(subscriber);
    if (source!.subscribers.size > 0) return;
    if (source!.timer !== null) clearInterval(source!.timer);
    sharedRunTranscriptSources.delete(run.id);
  };
}

export function useLiveRunTranscripts({
  runs,
  orgId,
  maxChunksPerRun = 200,
  includeRunEvents = true,
}: UseLiveRunTranscriptsOptions) {
  const activityCoordinator = useActivityCoordinator();
  const [chunksByRun, setChunksByRun] = useState<Map<string, LiveTranscriptChunk[]>>(new Map());
  const [normalizedByRun, setNormalizedByRun] = useState<Map<string, AgentRunTranscriptResult>>(new Map());
  const [normalizedErrorsByRun, setNormalizedErrorsByRun] = useState<Map<string, Error>>(new Map());
  const [normalizedLoadingByRun, setNormalizedLoadingByRun] = useState<Set<string>>(new Set());
  const seenChunkKeysRef = useRef(new Set<string>());
  const { data: generalSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const activeRunIds = useMemo(
    () => new Set(runs.filter((run) => !isTerminalStatus(run.status)).map((run) => run.id)),
    [runs],
  );
  const runIdsKey = useMemo(
    () => runs.map((run) => run.id).sort((a, b) => a.localeCompare(b)).join(","),
    [runs],
  );
  const runSourcesKey = useMemo(
    () => runs
      .map((run) => `${run.id}:${run.status}`)
      .sort((a, b) => a.localeCompare(b))
      .join(","),
    [runs],
  );

  useEffect(() => {
    const leases = runs.map((run) => activityCoordinator.acquireDetail(`run:${run.id}`));
    return () => {
      for (const lease of leases) lease.release();
    };
  }, [activityCoordinator, runIdsKey]);

  const appendChunks = (runId: string, chunks: IncomingLiveTranscriptChunk[]) => {
    if (chunks.length === 0) return;
    setChunksByRun((prev) => {
      const next = new Map(prev);
      const existing = [...(next.get(runId) ?? [])];
      let changed = false;

      for (const chunk of chunks) {
        if (seenChunkKeysRef.current.has(chunk.dedupeKey)) continue;
        seenChunkKeysRef.current.add(chunk.dedupeKey);
        existing.push(chunk.type === "entry"
          ? { type: "entry", entry: chunk.entry, source: chunk.source }
          : { type: "log", chunk: chunk.chunk, source: chunk.source });
        changed = true;
      }

      if (!changed) return prev;
      if (seenChunkKeysRef.current.size > 12000) {
        seenChunkKeysRef.current.clear();
      }
      next.set(runId, existing.slice(-maxChunksPerRun));
      return next;
    });
  };

  useEffect(() => {
    const knownRunIds = new Set(runs.map((run) => run.id));
    setChunksByRun((prev) => {
      const next = new Map<string, LiveTranscriptChunk[]>();
      for (const [runId, chunks] of prev) {
        if (knownRunIds.has(runId)) {
          next.set(runId, chunks);
        }
      }
      return next.size === prev.size ? prev : next;
    });

    for (const key of seenChunkKeysRef.current) {
      const runId = runIdFromDedupeKey(key);
      if (runId && !knownRunIds.has(runId)) {
        seenChunkKeysRef.current.delete(key);
      }
    }
    setNormalizedByRun((prev) => {
      const next = new Map([...prev].filter(([runId]) => knownRunIds.has(runId)));
      return next.size === prev.size ? prev : next;
    });
    setNormalizedErrorsByRun((prev) => {
      const next = new Map([...prev].filter(([runId]) => knownRunIds.has(runId)));
      return next.size === prev.size ? prev : next;
    });
    setNormalizedLoadingByRun((prev) => {
      const next = new Set([...prev].filter((runId) => knownRunIds.has(runId)));
      return next.size === prev.size ? prev : next;
    });
  }, [runs]);

  useEffect(() => {
    if (runs.length === 0) return;
    const transcriptReleases = runs.map((run) => subscribeSharedRunTranscript(run, (result, error, loading) => {
      setNormalizedLoadingByRun((prev) => {
        const next = new Set(prev);
        if (loading) next.add(run.id);
        else next.delete(run.id);
        return next;
      });
      if (result) {
        setNormalizedByRun((prev) => new Map(prev).set(run.id, result));
      }
      setNormalizedErrorsByRun((prev) => {
        const next = new Map(prev);
        if (error) next.set(run.id, error);
        else next.delete(run.id);
        return next;
      });
    }));
    return () => {
      for (const release of transcriptReleases) release();
    };
  }, [runSourcesKey]);

  useEffect(() => {
    if (!orgId || activeRunIds.size === 0) return undefined;

    return activityCoordinator.subscribeLiveEvents((event: LiveEvent) => {
      if (event.orgId !== orgId) return;
      const payload = event.payload ?? {};
      const runId = readString(payload["runId"]);
      if (!runId || !activeRunIds.has(runId) || !runById.has(runId)) return;

      if (event.type === "heartbeat.run.log") {
        if (payload["truncated"] === true) return;
        const chunk = readString(payload["chunk"]);
        if (!chunk) return;
        const ts = readString(payload["ts"]) ?? event.createdAt;
        const stream =
          readString(payload["stream"]) === "stderr"
            ? "stderr"
            : readString(payload["stream"]) === "system"
              ? "system"
              : "stdout";
        appendChunks(runId, [{
          type: "log",
          chunk: { ts, stream, chunk },
          source: "live",
          dedupeKey: `log:${runId}:${ts}:${stream}:${chunk}`,
        }]);
        return;
      }

      if (includeRunEvents && event.type === "heartbeat.run.event") {
        const seq = typeof payload["seq"] === "number" ? payload["seq"] : null;
        const eventType = readString(payload["eventType"]) ?? "event";
        const messageText = readString(payload["message"]) ?? eventType;
        const eventId = readEventId(event.id);
        const eventPayload = readRecord(payload["payload"]);
        const nativeEntry = readRecord(eventPayload?.entry);
        const transcriptEntry = nativeEntry
          && typeof nativeEntry.kind === "string"
          && typeof nativeEntry.ts === "string"
          ? {
            ...nativeEntry as TranscriptEntry,
            ...(eventId ? { sourceEntryId: eventId } : {}),
          }
          : heartbeatRunEventTranscriptEntry({
          id: typeof event.id === "number" ? event.id : 0,
          orgId: event.orgId,
          runId,
          agentId: readString(payload["agentId"]) ?? runById.get(runId)?.agentId ?? "",
          seq: seq ?? 0,
          eventType,
          stream: payload["stream"] === "stdout" || payload["stream"] === "stderr" || payload["stream"] === "system"
            ? payload["stream"]
            : null,
          level: payload["level"] === "info" || payload["level"] === "warn" || payload["level"] === "error"
            ? payload["level"]
            : null,
          color: readString(payload["color"]),
          message: readString(payload["message"]),
          payload: eventPayload,
          createdAt: new Date(event.createdAt),
        });
        if (transcriptEntry) {
          appendChunks(runId, [{
            type: "entry",
            entry: transcriptEntry,
            source: "live",
            dedupeKey: `socket:event:${runId}:${seq !== null ? `seq:${seq}` : `id:${eventId ?? `${eventType}:${messageText}:${event.createdAt}`}`}`,
          }]);
          return;
        }
        appendChunks(runId, [{
          type: "log",
          chunk: {
            ts: event.createdAt,
            stream: eventType === "error" ? "stderr" : "system",
            chunk: messageText,
          },
          source: "event-fallback",
          dedupeKey: `socket:event:${runId}:${seq !== null ? `seq:${seq}` : `id:${eventId ?? `${eventType}:${messageText}:${event.createdAt}`}`}`,
        }]);
        return;
      }

      if (includeRunEvents && event.type === "heartbeat.run.status") {
        const status = readString(payload["status"]) ?? "updated";
        appendChunks(runId, [{
          type: "log",
          chunk: {
            ts: event.createdAt,
            stream: isTerminalStatus(status) && status !== "succeeded" ? "stderr" : "system",
            chunk: `run ${status}`,
          },
          source: "event-fallback",
          dedupeKey: `socket:status:${runId}:${status}:${readString(payload["finishedAt"]) ?? ""}`,
        }]);
      }
    });
  }, [activeRunIds, activityCoordinator, includeRunEvents, orgId, runById]);

  const transcriptByRun = useMemo(() => {
    const next = new Map<string, TranscriptEntry[]>();
    const censorUsernameInLogs = generalSettings?.censorUsernameInLogs === true;
    for (const run of runs) {
      const adapter = getUIAdapter(run.agentRuntimeType);
      const chunks = chunksByRun.get(run.id) ?? [];
      const normalized = normalizedByRun.get(run.id);
      const normalizedError = normalizedErrorsByRun.get(run.id);
      const liveEntries = buildLiveTranscript(
        chunks.filter((chunk) => chunk.source === "live"),
        adapter.parseStdoutLine,
        { censorUsernameInLogs },
      );
      const compatibilityEntries = buildLiveTranscript(
        chunks.filter((chunk) => chunk.source !== "live"),
        adapter.parseStdoutLine,
        { censorUsernameInLogs },
      );
      const canonicalEntries = normalized && !normalizedError ? normalized.entries : [];
      const entries = normalized && !normalizedError
        ? mergeTranscriptEntriesUnique(liveEntries, canonicalEntries)
        : normalizedError
          ? mergeTranscriptEntriesUnique(compatibilityEntries, liveEntries)
          : liveEntries;
      next.set(
        run.id,
        entries.map((entry) => redactTranscriptEntryPaths(entry, { enabled: censorUsernameInLogs })),
      );
    }
    return next;
  }, [chunksByRun, generalSettings?.censorUsernameInLogs, normalizedByRun, normalizedErrorsByRun, runs]);

  const transcriptStateByRun = useMemo(() => {
    const next = new Map<string, LiveRunTranscriptState>();
    for (const run of runs) {
      const result = normalizedByRun.get(run.id);
      next.set(run.id, {
        loading: (normalizedLoadingByRun.has(run.id) && !result),
        source: result?.source ?? null,
        revision: result?.revision ?? null,
        availability: result?.availability ?? null,
        completeness: result?.completeness ?? null,
        error: normalizedErrorsByRun.get(run.id) ?? null,
      });
    }
    return next;
  }, [normalizedByRun, normalizedErrorsByRun, normalizedLoadingByRun, runs]);

  return {
    transcriptByRun,
    transcriptStateByRun,
    hasOutputForRun(runId: string) {
      return (transcriptByRun.get(runId)?.length ?? 0) > 0;
    },
  };
}
