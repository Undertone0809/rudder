import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { heartbeatRuns, nativeSegments, runRuntimeSpans, type Db } from "@rudderhq/db";
import {
  buildObservedRunTrace,
  type ObservedRunDetail,
  type ObservedRunStep,
} from "@rudderhq/run-intelligence-core";
import { shortRefFor, toAgentRunOrigin, type RunInspectionHeader } from "@rudderhq/shared";
import { and, eq, sql } from "drizzle-orm";
import { Router, type Request } from "express";
import { badRequest, conflict, notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { formatShortRunId } from "../services/heartbeat-run-reference.js";
import {
  getObservedRun,
  getObservedRunDiagnosticDetail,
  getObservedRunDetail,
  getObservedRunEvents,
  getObservedRunLog,
  getObservedRunTranscript,
  getRunSummary,
  listObservedRuns,
  listRunSummaries,
} from "../services/run-intelligence.js";
import type { RunDiagnosticReaderPosition } from "../services/run-intelligence-diagnostic-reader.js";
import {
  listNativeForkIntents,
  NativeForkIntentError,
  nativeForkIntentKey,
  readNativeForkIntent,
  reconcileNativeForkIntentById,
  type NativeForkIntentChild,
  type NativeForkIntentRecord,
  type NativeForkIntentRunFence,
  type NativeForkIntentStatus,
} from "../services/runtime-kernel/native-fork-intent.js";
import type { TranscriptItem } from "../services/runtime-kernel/transcript-reader.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo, getAuthorizedOrgScope } from "./authz.js";

function runIntelligenceScope(req: Request) {
  return {
    orgIds: getAuthorizedOrgScope(req),
    sideChatOwnerId: req.actor.type === "board" ? (req.actor.userId ?? "local-board") : null,
  };
}

function asDateOrNull(value: unknown) {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asBoolean(value: unknown) {
  return value === "true" || value === "1" || value === true;
}

function asPositiveInteger(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function asNonNegativeInteger(value: unknown, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function clipText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return { text: value, clipped: false, originalLength: value.length };
  }
  return {
    text: `${value.slice(0, Math.max(0, maxChars - 1))}…`,
    clipped: true,
    originalLength: value.length,
  };
}

function stepStableId(step: ObservedRunStep) {
  return `step-${step.index}`;
}

function parseStepStableId(value: string | null) {
  if (!value) return null;
  const match = /^step-(\d+)$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

type TranscriptProjectionCursor = {
  version: 1;
  kind: "run_transcript_projection";
  runId: string;
  orgId: string;
  sourceCursor: string | null;
  source: string;
  revision: string;
  order: "oldest" | "newest";
  errorsOnly: boolean;
  aroundError: string | null;
  contextTurns: number;
  turnLimit: number;
  offset: number;
};

const MAX_TRANSCRIPT_PROJECTION_ITEMS = 50_000;
const MAX_TRANSCRIPT_PROJECTION_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_PROJECTION_READ_MS = 10_000;

function encodeTranscriptProjectionCursor(input: TranscriptProjectionCursor): string {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

function decodeTranscriptProjectionCursor(value: string | null): TranscriptProjectionCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<TranscriptProjectionCursor>;
    if (parsed.version !== 1 || parsed.kind !== "run_transcript_projection"
      || typeof parsed.runId !== "string" || typeof parsed.orgId !== "string"
      || (parsed.sourceCursor !== null && typeof parsed.sourceCursor !== "string")
      || typeof parsed.source !== "string" || typeof parsed.revision !== "string"
      || (parsed.order !== "oldest" && parsed.order !== "newest")
      || typeof parsed.errorsOnly !== "boolean"
      || (parsed.aroundError !== null && typeof parsed.aroundError !== "string")
      || !Number.isSafeInteger(parsed.contextTurns) || (parsed.contextTurns ?? 0) < 1
      || !Number.isSafeInteger(parsed.turnLimit) || (parsed.turnLimit ?? 0) < 1
      || !Number.isSafeInteger(parsed.offset) || (parsed.offset ?? -1) < 0) {
      return null;
    }
    return parsed as TranscriptProjectionCursor;
  } catch {
    return null;
  }
}

type RunErrorsCursor = {
  version: 1;
  kind: "run_errors";
  runId: string;
  orgId: string;
  source: string;
  revision: string;
  position: RunDiagnosticReaderPosition;
  includeRunError: boolean;
};

function encodeRunErrorsCursor(cursor: RunErrorsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeRunErrorsCursor(value: string | null): RunErrorsCursor | null {
  if (!value || value.length > 65_536) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<RunErrorsCursor>;
    const position = parsed.position as Partial<RunDiagnosticReaderPosition> | undefined;
    const traceState = position?.traceState as RunDiagnosticReaderPosition["traceState"] | undefined;
    const sourceCursor = position?.sourceCursor;
    if (parsed.version !== 1 || parsed.kind !== "run_errors"
      || typeof parsed.runId !== "string" || typeof parsed.orgId !== "string"
      || typeof parsed.source !== "string" || typeof parsed.revision !== "string"
      || parsed.includeRunError !== false
      || !position || (sourceCursor !== null && typeof sourceCursor !== "string")
      || (typeof sourceCursor === "string" && sourceCursor.length > 32_768)
      || !Number.isSafeInteger(position.itemOffset) || (position.itemOffset ?? -1) < 0
      || !Number.isSafeInteger(position.stepOffset) || (position.stepOffset ?? -1) < 0
      || !traceState || !Number.isSafeInteger(traceState.nextTurnIndex) || traceState.nextTurnIndex < 0
      || (traceState.activeTurnIndex !== null
        && (!Number.isSafeInteger(traceState.activeTurnIndex) || traceState.activeTurnIndex < 0))) {
      return null;
    }
    return parsed as RunErrorsCursor;
  } catch {
    return null;
  }
}

function fullText(value: string) {
  return { text: value, clipped: false, originalLength: value.length };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredBodyString(value: unknown, label: string, maxLength = 4_096): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    throw badRequest(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function parseNativeForkChild(value: unknown): NativeForkIntentChild {
  const body = asRecord(value);
  const session = asRecord(body?.session);
  const sessionParams = asRecord(session?.sessionParams);
  if (!body || !session || !sessionParams) {
    throw badRequest("Native fork reconciliation requires a session and sessionParams object");
  }
  if (body.continuity !== "native") {
    throw badRequest("Native fork reconciliation child continuity must be native");
  }
  const sessionId = requiredBodyString(session.sessionId, "child.session.sessionId", 512);
  const boundary = requiredBodyString(body.boundary, "child.boundary", 2_048);
  if (JSON.stringify(sessionParams).length > 256_000) {
    throw badRequest("child.session.sessionParams is too large");
  }
  const identityMap = body.identityMap === undefined || body.identityMap === null
    ? undefined
    : asRecord(body.identityMap);
  if (body.identityMap !== undefined && body.identityMap !== null && !identityMap) {
    throw badRequest("child.identityMap must be an object");
  }
  if (identityMap && !Object.entries(identityMap).every(([key, entry]) => (
    key.length <= 512 && typeof entry === "string" && entry.trim().length > 0 && entry.length <= 2_048
  ))) {
    throw badRequest("child.identityMap must contain bounded string mappings");
  }
  return {
    continuity: "native",
    boundary,
    sourceBoundary: body.sourceBoundary === undefined || body.sourceBoundary === null
      ? null
      : requiredBodyString(body.sourceBoundary, "child.sourceBoundary", 2_048),
    identityMap: identityMap as Record<string, string> | undefined,
    session: {
      sessionId,
      sessionDisplayId: typeof session.sessionDisplayId === "string" && session.sessionDisplayId.trim()
        ? session.sessionDisplayId.trim()
        : sessionId,
      sessionParams: { ...sessionParams, sessionId },
    },
  };
}

async function currentNativeForkIntentRunFence(db: Db, orgId: string, intentId: string) {
  const target = await db
    .select({
      segmentId: nativeSegments.id,
      bindingId: nativeSegments.bindingId,
      providerStateJson: nativeSegments.providerStateJson,
    })
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.orgId, orgId),
      sql`${nativeSegments.providerStateJson} -> ${nativeForkIntentKey()} ->> 'intentId' = ${intentId}`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!target) return undefined;

  let intent: NativeForkIntentRecord | null;
  try {
    intent = readNativeForkIntent(target.providerStateJson);
  } catch (error) {
    if (error instanceof NativeForkIntentError) {
      throw badRequest(error.message, { code: error.code });
    }
    throw error;
  }
  if (!intent) return undefined;
  const storedFence = intent.runFence;
  if (!storedFence) return undefined;
  if (intent.intentId !== intentId
    || intent.target.orgId !== orgId
    || intent.target.bindingId !== target.bindingId
    || intent.target.segmentId !== target.segmentId) {
    throw conflict("Native fork intent target identity is inconsistent", { code: "run_fence_stale" });
  }

  const active = await db
    .select({
      runId: heartbeatRuns.id,
      runStatus: heartbeatRuns.status,
      ownerToken: heartbeatRuns.executionOwnerToken,
      leaseExpiresAt: heartbeatRuns.executionLeaseExpiresAt,
      spanId: runRuntimeSpans.id,
      spanOwnerToken: runRuntimeSpans.ownerToken,
      attemptEpoch: runRuntimeSpans.attemptEpoch,
      spanState: runRuntimeSpans.state,
    })
    .from(runRuntimeSpans)
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, runRuntimeSpans.runId),
      eq(heartbeatRuns.orgId, runRuntimeSpans.orgId),
    ))
    .where(and(
      eq(heartbeatRuns.id, storedFence.runId),
      eq(heartbeatRuns.orgId, orgId),
      eq(heartbeatRuns.status, "running"),
      eq(runRuntimeSpans.id, storedFence.spanId),
      eq(runRuntimeSpans.orgId, orgId),
      eq(runRuntimeSpans.runId, storedFence.runId),
      eq(runRuntimeSpans.bindingId, target.bindingId),
      eq(runRuntimeSpans.segmentId, target.segmentId),
      eq(runRuntimeSpans.state, "open"),
      eq(heartbeatRuns.executionOwnerToken, runRuntimeSpans.ownerToken),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!active
    || active.runId !== storedFence.runId
    || active.runStatus !== "running"
    || active.spanId !== storedFence.spanId
    || active.spanState !== "open"
    || !active.ownerToken
    || active.ownerToken !== active.spanOwnerToken
    || (active.leaseExpiresAt && active.leaseExpiresAt.getTime() <= Date.now())) {
    throw conflict("Native fork intent has no current active Run owner fence", { code: "run_fence_stale" });
  }

  const runFence: NativeForkIntentRunFence = {
    runId: active.runId,
    spanId: active.spanId,
    ownerToken: active.ownerToken,
    attemptEpoch: active.attemptEpoch,
  };
  return runFence;
}

function compactTranscriptRow(step: ObservedRunStep, maxChars: number, includeOutput: boolean) {
  return {
    id: stepStableId(step),
    index: step.index,
    turnIndex: step.turnIndex,
    kind: step.kind,
    ts: step.ts,
    label: step.label,
    preview: step.preview,
    detailPreview: step.detailPreview,
    isError: step.isError,
    isPayloadEntry: step.isPayloadEntry,
    isModelEntry: step.isModelEntry,
    output: includeOutput ? clipText(step.detailText, maxChars) : null,
  };
}

function transcriptEntryFromReaderItem(item: TranscriptItem): TranscriptEntry | null {
  const payload = item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
    ? item.payload as Record<string, unknown>
    : {};
  const candidate = item.entry
    ?? (typeof payload.kind === "string" && typeof payload.ts === "string"
      ? payload
      : { ...payload, kind: item.kind, ts: item.ts });
  const candidateRecord = candidate as Record<string, unknown>;
  const sourceKind = typeof candidateRecord.kind === "string" ? candidateRecord.kind : item.kind;
  const kind = sourceKind === "hermes:db:assistant"
    ? "assistant"
    : sourceKind === "hermes:db:user" ? "user" : sourceKind;
  const ts = typeof candidateRecord.ts === "string" ? candidateRecord.ts : item.ts;
  const text = typeof candidateRecord.text === "string" ? candidateRecord.text : item.text;
  if (typeof kind !== "string" || typeof ts !== "string") return null;
  return {
    ...candidateRecord,
    kind,
    ts,
    ...(typeof text === "string" ? { text } : {}),
    ...(item.sourceEntryId && typeof candidateRecord.sourceEntryId !== "string"
      ? { sourceEntryId: item.sourceEntryId }
      : {}),
  } as TranscriptEntry;
}

function compactRunHeader(run: ObservedRunDetail["run"]): RunInspectionHeader {
  return {
    id: run.id,
    shortRef: (() => {
      try {
        return shortRefFor("run", run.id);
      } catch {
        return undefined;
      }
    })(),
    orgId: run.orgId,
    agentId: run.agentId,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error ? clipText(run.error, 2_000).text : null,
    errorCode: run.errorCode,
    exitCode: run.exitCode,
    signal: run.signal,
    chatConversationId: run.chatConversationId ?? null,
    sourceRunId: run.sourceRunId ?? null,
    scene: toAgentRunOrigin({
      id: run.id,
      invocationSource: run.invocationSource,
      triggerDetail: run.triggerDetail,
      wakeupRequestId: run.wakeupRequestId ?? null,
      sourceRunId: run.sourceRunId ?? null,
      chatConversationId: run.chatConversationId ?? null,
      contextSnapshot: run.contextSnapshot,
    }).scene,
    logBytes: run.logBytes,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function limitRowsByJsonBytes<Row>(rows: Row[], maxBytes: number) {
  const included: Row[] = [];
  let bytes = 2;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + (included.length > 0 ? 1 : 0);
    if (included.length > 0 && bytes + rowBytes > maxBytes) break;
    included.push(row);
    bytes += rowBytes;
  }
  return included;
}

function filterTranscriptSteps(
  steps: ObservedRunStep[],
  input: { errorsOnly: boolean; aroundError: string | null; contextTurns: number },
) {
  let rows = steps;
  if (input.errorsOnly) rows = rows.filter((step) => step.isError);

  const targetIndex = parseStepStableId(input.aroundError);
  if (!targetIndex) return rows;

  const target = steps.find((step) => step.index === targetIndex);
  if (!target) return [];

  if (target.turnIndex !== null) {
    const minTurn = target.turnIndex - input.contextTurns;
    const maxTurn = target.turnIndex + input.contextTurns;
    return rows.filter((step) =>
      step.turnIndex !== null
        ? step.turnIndex >= minTurn && step.turnIndex <= maxTurn
        : Math.abs(step.index - target.index) <= input.contextTurns,
    );
  }

  return rows.filter((step) => Math.abs(step.index - target.index) <= input.contextTurns);
}

function paginateTranscriptEntries(
  orderedEntries: Array<{ item: TranscriptItem; entry: TranscriptEntry; step: ObservedRunStep }>,
  input: { offset: number; turnLimit: number },
) {
  const available = orderedEntries.slice(input.offset);
  const rows: ObservedRunStep[] = [];
  const entries: Array<{ item: TranscriptItem; entry: TranscriptEntry; step: ObservedRunStep }> = [];
  const seenTurnKeys = new Set<string>();
  for (const entry of available) {
    const turnKey = entry.step.turnIndex === null ? `step-${entry.step.index}` : `turn-${entry.step.turnIndex}`;
    if (!seenTurnKeys.has(turnKey) && seenTurnKeys.size >= input.turnLimit) break;
    seenTurnKeys.add(turnKey);
    rows.push(entry.step);
    entries.push(entry);
  }
  const hasMore = rows.length < available.length;
  return {
    rows: entries,
    page: {
      offset: input.offset,
      nextOffset: hasMore ? input.offset + entries.length : null,
      hasMore,
      turnLimit: input.turnLimit,
      returnedSteps: entries.length,
      totalFilteredSteps: orderedEntries.length,
    },
  };
}

async function readTranscriptPages(
  db: Db,
  runId: string,
  scope: ReturnType<typeof runIntelligenceScope>,
  input: { cursor: string | null },
) {
  let readerCursor = input.cursor;
  let result: Awaited<ReturnType<typeof getObservedRunTranscript>> | null = null;
  const entries: Array<{ item: TranscriptItem; entry: TranscriptEntry; sourceIndex: number }> = [];
  let sourceIndex = 0;
  let sourceBytes = 0;
  const startedAt = Date.now();

  for (let pageCount = 0; pageCount < 2_000; pageCount += 1) {
    if (Date.now() - startedAt > MAX_TRANSCRIPT_PROJECTION_READ_MS) {
      throw badRequest("Transcript projection exceeded its bounded read time");
    }
    const pageResult = await getObservedRunTranscript(db, runId, scope, {
      cursor: readerCursor,
      limit: 200,
    });
    result = pageResult;
    for (const item of pageResult.page.items) {
      const entry = transcriptEntryFromReaderItem(item);
      if (!entry) continue;
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (entries.length >= MAX_TRANSCRIPT_PROJECTION_ITEMS
        || sourceBytes + itemBytes > MAX_TRANSCRIPT_PROJECTION_BYTES) {
        throw badRequest("Transcript projection exceeded its bounded source size");
      }
      sourceBytes += itemBytes;
      entries.push({ item, entry, sourceIndex: sourceIndex++ });
    }
    const nextCursor = pageResult.page.nextCursor;
    if (!nextCursor) {
      return { result, entries };
    }
    if (nextCursor === readerCursor) throw new Error("Transcript reader cursor made no progress");
    readerCursor = nextCursor;
  }

  throw new Error("Transcript reader exceeded the route page limit");
}

function buildRunErrors(
  detail: ObservedRunDetail,
  maxChars: number,
  entryPositions?: Array<{ stepIndex: number; turnIndex: number | null }>,
) {
  const trace = buildObservedRunTrace(detail);
  const transcriptErrors = trace.steps
    .filter((step) => step.isError)
    .map((step) => {
      const output = clipText(step.detailText, maxChars);
      const entryPosition = entryPositions?.[step.index - 1];
      const index = entryPosition?.stepIndex ?? step.index;
      const id = `step-${index}`;
      const sourceLengths = asRecord(
        (detail.transcript[step.index - 1] as (TranscriptEntry & { __rudderOriginalLengths?: Record<string, number> }) | undefined)
          ?.__rudderOriginalLengths,
      );
      const sourceLength = sourceLengths?.detailText ?? sourceLengths?.content ?? sourceLengths?.text;
      if (typeof sourceLength === "number") {
        output.clipped = true;
        output.originalLength = sourceLength;
      }
      return {
        id,
        type: step.kind,
        index,
        turnIndex: entryPosition?.turnIndex ?? step.turnIndex,
        ts: step.ts,
        summary: step.preview || step.detailPreview || step.kind,
        output,
        transcriptContext: {
          id,
          command: `rudder runs transcript ${formatShortRunId(detail.run.id)} --around-error ${id}`,
        },
      };
    });

  if (!detail.run.error && !detail.run.errorCode) return transcriptErrors;

  return [
    (() => {
      const output = clipText(detail.run.error ?? detail.run.errorCode ?? "Run failed", maxChars);
      const sourceLength = (detail.run as typeof detail.run & {
        __rudderOriginalLengths?: Record<string, number>;
      }).__rudderOriginalLengths?.error;
      if (typeof sourceLength === "number") {
        output.clipped = true;
        output.originalLength = sourceLength;
      }
      return {
        id: "run-error",
        type: "runtime",
        index: null,
        turnIndex: null,
        ts: detail.run.finishedAt?.toISOString?.() ?? detail.run.updatedAt?.toISOString?.() ?? null,
        summary: detail.run.errorCode ?? "runtime_error",
        output,
        transcriptContext: transcriptErrors[0]?.transcriptContext ?? null,
      };
    })(),
    ...transcriptErrors,
  ];
}

export function runIntelligenceRoutes(db: Db) {
  const router = Router();

  router.get("/run-intelligence/orgs/:orgId/runs", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const scope = runIntelligenceScope(req);
    const usedSkill = asString(req.query.usedSkill);
    const loadedSkill = asString(req.query.loadedSkill);
    if (usedSkill && loadedSkill) {
      throw badRequest("Use either usedSkill or loadedSkill, not both.");
    }

    const projection = asString(req.query.projection);
    if (projection && projection !== "summary" && projection !== "full") {
      throw badRequest("projection must be either summary or full.");
    }

    const commonInput = {
      orgId,
      sideChatOwnerId: scope.sideChatOwnerId,
      updatedAfter: asDateOrNull(req.query.updatedAfter),
      runIdPrefix: asString(req.query.runIdPrefix),
      agentId: asString(req.query.agentId),
      status: asString(req.query.status),
      runtime: asString(req.query.runtime),
      issueId: asString(req.query.issueId),
      goalId: asString(req.query.goalId),
      usedSkill,
      loadedSkill,
      createdBefore: asDateOrNull(req.query.createdBefore),
    };

    if (projection !== "full") {
      const page = await listRunSummaries(db, {
        ...commonInput,
        cursor: asString(req.query.cursor),
        limit: asPositiveInteger(req.query.limit, 50, 100),
      });
      res.json(page);
      return;
    }

    const rows = await listObservedRuns(db, {
      ...commonInput,
      limit: Math.max(1, Math.min(1000, Number(req.query.limit ?? 200) || 200)),
    });

    res.json(rows);
  });

  router.get("/run-intelligence/orgs/:orgId/native-fork-intents", async (req, res) => {
    assertInstanceAdmin(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const statusValue = asString(req.query.status);
    const statuses: NativeForkIntentStatus[] = ["reserved", "accepted", "unknown", "rejected"];
    if (statusValue && !statuses.includes(statusValue as NativeForkIntentStatus)) {
      throw badRequest("status must be reserved, accepted, unknown, or rejected");
    }
    const items = await listNativeForkIntents(db, {
      orgId,
      status: statusValue as NativeForkIntentStatus | undefined,
      limit: asPositiveInteger(req.query.limit, 50, 200),
    });
    res.json({ items, count: items.length });
  });

  router.post("/run-intelligence/orgs/:orgId/native-fork-intents/:intentId/reconcile", async (req, res) => {
    assertInstanceAdmin(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const intentId = requiredBodyString(req.params.intentId, "intentId", 128);
    const body = asRecord(req.body);
    const note = body?.note === undefined || body.note === null
      ? null
      : requiredBodyString(body.note, "note", 2_000);
    const child = parseNativeForkChild(body?.child);
    const runFence = await currentNativeForkIntentRunFence(db, orgId, intentId);
    let result: Awaited<ReturnType<typeof reconcileNativeForkIntentById>>;
    try {
      result = await reconcileNativeForkIntentById(db, {
        orgId,
        intentId,
        child,
        note,
        ...(runFence ? { runFence } : {}),
      });
    } catch (error) {
      if (error instanceof NativeForkIntentError) {
        if (error.code === "run_fence_stale") {
          throw conflict(error.message, { code: error.code });
        }
        throw badRequest(error.message, { code: error.code });
      }
      throw error;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "runtime.native_fork_reconciled",
      entityType: "native_fork_intent",
      entityId: intentId,
      idempotencyKey: `runtime.native-fork-reconcile:${intentId}:${result.summary.updatedAt}`,
      details: {
        bindingId: result.summary.target.bindingId,
        segmentId: result.summary.target.segmentId,
        runtimeType: result.summary.target.runtimeType,
        reconciliation: result.summary.reconciliation,
      },
    });
    res.json({ status: result.outcome.status, intent: result.summary });
  });

  router.get("/run-intelligence/runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const scope = runIntelligenceScope(req);
    if (req.query.projection === "full") {
      const row = await getObservedRun(db, runId, scope);
      if (!row) throw notFound("Agent run not found");
      assertCompanyAccess(req, row.run.orgId);
      res.json(row);
      return;
    }
    const summary = await getRunSummary(db, runId, scope);
    if (!summary) throw notFound("Agent run not found");
    assertCompanyAccess(req, summary.orgId);
    res.json(summary);
  });

  router.get("/run-intelligence/runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const scope = runIntelligenceScope(req);
    const result = await getObservedRunEvents(db, runId, scope, {
      cursor: asString(req.query.cursor),
      afterSeq: asNonNegativeInteger(req.query.afterSeq, 0),
      limit: asPositiveInteger(req.query.limit, 200, 200),
      includePayload: req.query.projection === "full",
      maxPayloadChars: asPositiveInteger(req.query.maxChars, 1_200, 4_000),
    });
    assertCompanyAccess(req, result.orgId);
    res.json(result.response);
  });

  router.get("/run-intelligence/runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const scope = runIntelligenceScope(req);
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    const result = await getObservedRunLog(db, runId, scope, {
      offset: asNonNegativeInteger(req.query.offset, 0),
      limitBytes: Math.max(4, asPositiveInteger(req.query.limitBytes, 256_000, 500_000)),
      signal: cancellation.signal,
    }).finally(() => {
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    });
    assertCompanyAccess(req, result.orgId);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json(result.response);
  });

  router.get("/run-intelligence/runs/:runId/transcript", async (req, res) => {
    const runId = req.params.runId as string;
    const scope = runIntelligenceScope(req);
    const maxChars = asPositiveInteger(req.query.maxChars ?? req.query.maxOutputChars, 1200, 20000);
    const contextTurns = asPositiveInteger(req.query.contextTurns, 1, 20);
    const turnLimit = asPositiveInteger(req.query.turnLimit ?? req.query.limit, 50, 200);
    const cursor = asString(req.query.cursor);
    const outputMode = req.query.output === "full" ? "full" : "compact";
    const includeOutputQuery = req.query.includeOutputs ?? req.query.includeOutput;
    const includeOutputs = outputMode === "full" || asBoolean(includeOutputQuery);
    const order = req.query.order === "oldest" || req.query.order === "chronological"
      ? "oldest"
      : "newest";
    const aroundError = asString(req.query.aroundError);
    const errorsOnly = asBoolean(req.query.errorsOnly);
    const projectionCursor = decodeTranscriptProjectionCursor(cursor);
    const legacyCursorIndex = projectionCursor ? null : parseStepStableId(cursor);
    if (projectionCursor) {
      if (projectionCursor.runId !== runId
        || projectionCursor.order !== order
        || projectionCursor.errorsOnly !== errorsOnly
        || projectionCursor.aroundError !== aroundError
        || projectionCursor.contextTurns !== contextTurns
        || projectionCursor.turnLimit !== turnLimit) {
        throw badRequest("Transcript cursor does not belong to this projection");
      }
    }

    // Always read through the shared Transcript Reader. The route cursor is a
    // bounded projection cursor that retains the reader's opaque source cursor
    // instead of replacing it with a synthetic step-N position.
    const scanned = await readTranscriptPages(db, runId, scope, {
      cursor: projectionCursor?.sourceCursor ?? (legacyCursorIndex === null ? cursor : null),
    });
    const pageResult = scanned.result;
    if (!pageResult) throw notFound("Agent run transcript not found");
    let chronologicalReaderEntries = scanned.entries;
    assertCompanyAccess(req, pageResult.orgId);
    if (projectionCursor
      && (projectionCursor.orgId !== pageResult.orgId
        || projectionCursor.source !== pageResult.page.source
        || projectionCursor.revision !== pageResult.page.revision)) {
      throw badRequest("Transcript cursor source or revision is no longer current");
    }

    const chronologicalTrace = buildObservedRunTrace(chronologicalReaderEntries.map((value) => value.entry));
    const stableTraceSteps = chronologicalTrace.steps.map((step, index) => ({
      ...step,
      index: (chronologicalReaderEntries[index]?.sourceIndex ?? index) + 1,
    }));
    const indexedReaderEntries = chronologicalReaderEntries.map((value, index) => ({
      ...value,
      step: stableTraceSteps[index]!,
    }));
    const targetIndex = parseStepStableId(aroundError);
    const targetTurn = targetIndex === null
      ? null
      : stableTraceSteps.find((step) => step.index === targetIndex)?.turnIndex ?? null;
    let filteredReaderEntries = indexedReaderEntries.filter(({ entry, item, step }) => {
      if (errorsOnly) {
        const isError = entry.kind === "stderr"
          || (entry.kind === "tool_result" && entry.isError)
          || (entry.kind === "result" && entry.isError);
        if (!isError) return false;
      }
      if (!aroundError) return true;
      if (targetIndex === null) return item.id === aroundError;
      if (targetTurn !== null && step.turnIndex === targetTurn) return true;
      return Math.abs(step.index - targetIndex) <= contextTurns;
    });

    // `step-N` is retained as a legacy input only. In chronological order it
    // means "after N"; in newest order it means "older than N".
    if (legacyCursorIndex !== null) {
      filteredReaderEntries = filteredReaderEntries.filter(({ step }) => order === "newest"
        ? step.index < legacyCursorIndex
        : step.index > legacyCursorIndex);
    }

    const filteredTrace = buildObservedRunTrace(filteredReaderEntries.map((value) => value.entry));
    const displayReaderEntries = order === "newest" ? [...filteredReaderEntries].reverse() : filteredReaderEntries;
    const projectionOffset = projectionCursor?.offset ?? 0;
    const paged = paginateTranscriptEntries(displayReaderEntries, {
      offset: projectionOffset,
      turnLimit,
    });
    const allRows = paged.rows.map(({ item, step }) => ({
      ...compactTranscriptRow(step, maxChars, includeOutputs),
      id: stepStableId(step),
      index: step.index,
      sourceEntryId: item.sourceEntryId ?? item.id,
    }));
    const rows = outputMode === "full" ? allRows : limitRowsByJsonBytes(allRows, 400_000);
    const responseItems = paged.rows.slice(0, rows.length);
    const responseHasMore = paged.page.hasMore || rows.length < allRows.length;
    const nextProjectionOffset = projectionOffset + responseItems.length;
    const nextCursor = responseHasMore
      ? encodeTranscriptProjectionCursor({
        version: 1,
        kind: "run_transcript_projection",
        runId,
        orgId: pageResult.orgId,
        sourceCursor: projectionCursor?.sourceCursor ?? (legacyCursorIndex === null ? cursor : null),
        source: pageResult.page.source,
        revision: pageResult.page.revision,
        order,
        errorsOnly,
        aroundError,
        contextTurns,
        turnLimit,
        offset: nextProjectionOffset,
      })
      : null;

    res.json({
      run: outputMode === "full" ? pageResult.run.run : compactRunHeader(pageResult.run.run),
      agentName: pageResult.run.agentName,
      orgName: pageResult.run.orgName,
      issue: pageResult.run.issue,
      order,
      output: outputMode,
      page: {
        cursor,
        hasMore: responseHasMore,
        nextCursor,
        turnLimit,
        returnedSteps: rows.length,
        totalFilteredSteps: filteredReaderEntries.length,
        order,
      },
      rows,
      ...(outputMode === "full"
        ? {
          entries: responseItems.map(({ item, entry, step }) => ({
            id: stepStableId(step),
            index: step.index,
            turnIndex: step.turnIndex,
            entry,
            sourceEntryId: item.sourceEntryId ?? item.id,
            output: fullText(step.detailText),
          })),
        }
        : {}),
      trace: {
        turnCount: filteredTrace.turnCount,
        stepCount: filteredTrace.steps.length,
        payloadStepCount: filteredTrace.payloadStepCount,
        filteredStepCount: filteredTrace.steps.length,
        bounded: true,
      },
      source: pageResult.page.source,
      revision: pageResult.page.revision,
      availability: pageResult.page.availability,
      completeness: pageResult.page.completeness,
    });
  });

  router.get("/run-intelligence/runs/:runId/errors", async (req, res) => {
    const runId = req.params.runId as string;
    const scope = runIntelligenceScope(req);
    const cursor = asString(req.query.cursor);
    const continuation = decodeRunErrorsCursor(cursor);
    const legacyCursorIndex = continuation ? null : parseStepStableId(cursor);
    if (cursor && !continuation && legacyCursorIndex === null) throw badRequest("Invalid errors cursor");
    if (continuation && continuation.runId !== runId) throw badRequest("Errors cursor does not belong to this run");
    const diagnostic = await getObservedRunDiagnosticDetail(db, runId, scope, {
      position: continuation?.position,
    });
    if (!diagnostic) throw notFound("Agent run not found");
    const { detail } = diagnostic;
    assertCompanyAccess(req, detail.run.orgId);
    if (continuation && (continuation.orgId !== detail.run.orgId
      || continuation.source !== diagnostic.projection.source
      || continuation.revision !== diagnostic.revision)) {
      throw badRequest("Errors cursor source or revision is no longer current");
    }
    const maxChars = asPositiveInteger(req.query.maxChars, 1200, 20000);
    const includeRunError = continuation?.includeRunError ?? legacyCursorIndex === null;
    const allErrors = buildRunErrors(detail, maxChars, diagnostic.entryPositions)
      .filter((error) => error.id !== "run-error"
        ? legacyCursorIndex === null || (error.index !== null && error.index > legacyCursorIndex)
        : includeRunError);
    const errors = limitRowsByJsonBytes(allErrors.slice(0, 200), 400_000);
    const hasMoreInChunk = errors.length < allErrors.length;
    const hasMore = hasMoreInChunk || diagnostic.nextPosition !== null;
    let nextPosition = diagnostic.nextPosition;
    if (hasMoreInChunk) {
      const lastError = errors.at(-1);
      if (lastError?.index !== null && lastError?.index !== undefined) {
        const lastPosition = diagnostic.entryPositions.find((position) => position.stepIndex === lastError.index)?.after;
        if (!lastPosition) throw new Error("Errors continuation position is unavailable");
        nextPosition = lastPosition;
      } else {
        nextPosition = continuation?.position ?? {
          sourceCursor: null,
          itemOffset: 0,
          stepOffset: 0,
          traceState: { nextTurnIndex: 0, activeTurnIndex: null },
        };
      }
    }
    if (hasMore && !diagnostic.revision) throw badRequest("Errors source revision is unavailable for continuation");
    const nextCursor = hasMore && nextPosition && diagnostic.revision
      ? encodeRunErrorsCursor({
        version: 1,
        kind: "run_errors",
        runId,
        orgId: detail.run.orgId,
        source: diagnostic.projection.source,
        revision: diagnostic.revision,
        position: nextPosition,
        includeRunError: false,
      })
      : null;
    const projection = hasMore
      ? { ...diagnostic.projection, completeness: "partial" as const }
      : diagnostic.projection;
    res.json({
      run: compactRunHeader(detail.run),
      agentName: detail.agentName,
      orgName: detail.orgName,
      issue: detail.issue,
      errors,
      page: {
        cursor,
        hasMore: nextCursor !== null,
        nextCursor,
      },
      projection,
    });
  });

  return router;
}
