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
import { agentRunsApi, type LiveRunForIssue } from "../../api/agent-runs";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { useActivityCoordinator } from "../../context/ActivityCoordinatorContext";
import { queryKeys } from "../../lib/queryKeys";
import { heartbeatRunEventTranscriptEntry } from "../../lib/run-detail-events";

const LOG_POLL_INTERVAL_MS = 2000;
const LOG_READ_LIMIT_BYTES = 256_000;
const LOG_ERROR_COOLDOWN_MS = 30_000;
const TERMINAL_LOG_STABLE_READS_REQUIRED = 2;
type LiveLogChunk = { type: "log"; chunk: RunLogChunk };
type LiveEntryChunk = { type: "entry"; entry: TranscriptEntry };
type LiveTranscriptChunk = LiveLogChunk | LiveEntryChunk;
type IncomingLiveTranscriptChunk = (LiveLogChunk | LiveEntryChunk) & { dedupeKey: string };
type RunLogReadResult = Awaited<ReturnType<typeof agentRunsApi.log>>;
const sharedRunLogReads = new Map<string, Promise<RunLogReadResult>>();

function sharedRunLogRead(runId: string, offset: number): Promise<RunLogReadResult> {
  const key = `${runId}:${offset}`;
  const current = sharedRunLogReads.get(key);
  if (current) return current;
  const promise = agentRunsApi.log(runId, offset, LOG_READ_LIMIT_BYTES);
  sharedRunLogReads.set(key, promise);
  const cleanup = () => {
    if (sharedRunLogReads.get(key) === promise) sharedRunLogReads.delete(key);
  };
  void promise.then(cleanup, cleanup);
  return promise;
}

function runIdFromDedupeKey(key: string): string | null {
  for (const prefix of ["log:", "socket:event:", "socket:status:"]) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    const separatorIndex = suffix.indexOf(":");
    return separatorIndex === -1 ? suffix : suffix.slice(0, separatorIndex);
  }
  return null;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
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

function readResultSummary(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  return readString((value as { summary?: unknown }).summary);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function fallbackTranscriptForRun(run: LiveRunForIssue): TranscriptEntry[] {
  const text = readString(run.stdoutExcerpt) ?? readResultSummary(run.resultJson);
  if (!text) return [];
  return [{
    kind: "assistant",
    ts: run.finishedAt ?? run.startedAt ?? run.createdAt,
    text,
  }];
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

function parsePersistedLogContent(
  runId: string,
  content: string,
  pendingByRun: Map<string, string>,
): IncomingLiveTranscriptChunk[] {
  if (!content) return [];

  const pendingKey = `${runId}:records`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${content}`;
  const split = combined.split("\n");
  pendingByRun.set(pendingKey, split.pop() ?? "");

  const parsed: IncomingLiveTranscriptChunk[] = [];
  for (const line of split) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      const stream = raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      if (!chunk) continue;
      parsed.push({
        type: "log",
        chunk: { ts, stream, chunk },
        dedupeKey: `log:${runId}:${ts}:${stream}:${chunk}`,
      });
    } catch {
      // Ignore malformed log rows.
    }
  }

  return parsed;
}

type SharedRunLogSource = {
  run: LiveRunForIssue;
  chunks: IncomingLiveTranscriptChunk[];
  offset: number;
  pendingRows: Map<string, string>;
  cooldownUntil: number;
  stableReads: number;
  settled: boolean;
  reading: boolean;
  timer: ReturnType<typeof setInterval> | null;
  subscribers: Set<(chunks: IncomingLiveTranscriptChunk[]) => void>;
};

const sharedRunLogSources = new Map<string, SharedRunLogSource>();

function readSharedRunLogSource(source: SharedRunLogSource) {
  if (source.reading || source.settled || source.cooldownUntil > Date.now()) return;
  source.reading = true;
  const offset = source.offset;
  void sharedRunLogRead(source.run.id, offset).then((result) => {
    source.cooldownUntil = 0;
    const chunks = parsePersistedLogContent(source.run.id, result.content, source.pendingRows);
    if (chunks.length > 0) {
      source.chunks = [...source.chunks, ...chunks].slice(-2_000);
      for (const subscriber of source.subscribers) subscriber(chunks);
    }

    let nextOffset = offset;
    if (result.nextOffset !== undefined) {
      nextOffset = result.nextOffset;
    } else if (result.endOffset !== undefined) {
      nextOffset = result.endOffset;
    } else if (result.content.length > 0) {
      nextOffset = offset + utf8ByteLength(result.content);
    }
    source.offset = nextOffset;

    if (!isTerminalStatus(source.run.status)) {
      source.stableReads = 0;
      source.settled = false;
      return;
    }
    const stableRead = result.content.length === 0 && nextOffset === offset;
    source.stableReads = stableRead ? source.stableReads + 1 : 0;
    source.settled = source.stableReads >= TERMINAL_LOG_STABLE_READS_REQUIRED;
  }, () => {
    source.cooldownUntil = Date.now() + LOG_ERROR_COOLDOWN_MS;
  }).finally(() => {
    source.reading = false;
  });
}

function subscribeSharedRunLog(
  run: LiveRunForIssue,
  subscriber: (chunks: IncomingLiveTranscriptChunk[]) => void,
) {
  let source = sharedRunLogSources.get(run.id);
  if (!source) {
    source = {
      run,
      chunks: [],
      offset: 0,
      pendingRows: new Map(),
      cooldownUntil: 0,
      stableReads: 0,
      settled: false,
      reading: false,
      timer: null,
      subscribers: new Set(),
    };
    sharedRunLogSources.set(run.id, source);
  } else {
    const wasTerminal = isTerminalStatus(source.run.status);
    source.run = run;
    if (wasTerminal && !isTerminalStatus(run.status)) {
      source.stableReads = 0;
      source.settled = false;
    }
  }
  source.subscribers.add(subscriber);
  if (source.chunks.length > 0) subscriber(source.chunks);
  readSharedRunLogSource(source);
  if (source.timer === null) {
    source.timer = setInterval(() => readSharedRunLogSource(source!), LOG_POLL_INTERVAL_MS);
  }

  return () => {
    source!.subscribers.delete(subscriber);
    if (source!.subscribers.size > 0) return;
    if (source!.timer !== null) clearInterval(source!.timer);
    sharedRunLogSources.delete(run.id);
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
        existing.push(chunk.type === "entry" ? { type: "entry", entry: chunk.entry } : { type: "log", chunk: chunk.chunk });
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
  }, [runs]);

  useEffect(() => {
    if (runs.length === 0) return;
    const releases = runs.map((run) => subscribeSharedRunLog(run, (chunks) => {
      appendChunks(run.id, chunks);
    }));
    return () => {
      for (const release of releases) release();
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
          dedupeKey: `log:${runId}:${ts}:${stream}:${chunk}`,
        }]);
        return;
      }

      if (includeRunEvents && event.type === "heartbeat.run.event") {
        const seq = typeof payload["seq"] === "number" ? payload["seq"] : null;
        const eventType = readString(payload["eventType"]) ?? "event";
        const messageText = readString(payload["message"]) ?? eventType;
        const transcriptEntry = heartbeatRunEventTranscriptEntry({
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
          payload: readRecord(payload["payload"]),
          createdAt: new Date(event.createdAt),
        });
        if (transcriptEntry) {
          appendChunks(runId, [{
            type: "entry",
            entry: transcriptEntry,
            dedupeKey: `socket:event:${runId}:${seq ?? `${eventType}:${messageText}:${event.createdAt}`}`,
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
          dedupeKey: `socket:event:${runId}:${seq ?? `${eventType}:${messageText}:${event.createdAt}`}`,
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
      next.set(
        run.id,
        chunks.length > 0
          ? buildLiveTranscript(chunks, adapter.parseStdoutLine, { censorUsernameInLogs })
          : fallbackTranscriptForRun(run),
      );
    }
    return next;
  }, [chunksByRun, generalSettings?.censorUsernameInLogs, runs]);

  return {
    transcriptByRun,
    hasOutputForRun(runId: string) {
      const run = runById.get(runId);
      return (chunksByRun.get(runId)?.length ?? 0) > 0 || (run ? fallbackTranscriptForRun(run).length > 0 : false);
    },
  };
}
