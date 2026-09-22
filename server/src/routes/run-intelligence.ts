import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  buildObservedRunTrace,
  type ObservedRunDetail,
  type ObservedRunStep,
} from "@rudderhq/run-intelligence-core";
import { shortRefFor, toAgentRunOrigin, type RunInspectionHeader } from "@rudderhq/shared";
import { Router, type Request } from "express";
import { badRequest, notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { formatShortRunId } from "../services/heartbeat-run-reference.js";
import {
  getObservedRun,
  getObservedRunDetail,
  getObservedRunEvents,
  getObservedRunLog,
  getObservedRunTranscript,
  getRunSummary,
  listObservedRuns,
  listRunSummaries,
} from "../services/run-intelligence.js";
import {
  listNativeForkIntents,
  NativeForkIntentError,
  reconcileNativeForkIntentById,
  type NativeForkIntentChild,
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
  if (typeof candidate.kind !== "string" || typeof candidate.ts !== "string") return null;
  return {
    ...(candidate as TranscriptEntry),
    ...(item.sourceEntryId && typeof (candidate as Record<string, unknown>).sourceEntryId !== "string"
      ? { sourceEntryId: item.sourceEntryId }
      : {}),
  };
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

function buildRunErrors(detail: ObservedRunDetail, maxChars: number) {
  const trace = buildObservedRunTrace(detail);
  const transcriptErrors = trace.steps
    .filter((step) => step.isError)
    .map((step) => ({
      id: stepStableId(step),
      type: step.kind,
      index: step.index,
      turnIndex: step.turnIndex,
      ts: step.ts,
      summary: step.preview || step.detailPreview || step.kind,
      output: clipText(step.detailText, maxChars),
      transcriptContext: {
        id: stepStableId(step),
        command: `rudder runs transcript ${formatShortRunId(detail.run.id)} --around-error ${stepStableId(step)}`,
      },
    }));

  if (!detail.run.error && !detail.run.errorCode) return transcriptErrors;

  return [
    {
      id: "run-error",
      type: "runtime",
      index: null,
      turnIndex: null,
      ts: detail.run.finishedAt?.toISOString?.() ?? detail.run.updatedAt?.toISOString?.() ?? null,
      summary: detail.run.errorCode ?? "runtime_error",
      output: clipText(detail.run.error ?? detail.run.errorCode ?? "Run failed", maxChars),
      transcriptContext: transcriptErrors[0]?.transcriptContext ?? null,
    },
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
    let result: Awaited<ReturnType<typeof reconcileNativeForkIntentById>>;
    try {
      result = await reconcileNativeForkIntentById(db, { orgId, intentId, child, note });
    } catch (error) {
      if (error instanceof NativeForkIntentError) {
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
    const legacyCursorIndex = parseStepStableId(cursor);
    const pageResult = await getObservedRunTranscript(db, runId, scope, {
      cursor: legacyCursorIndex === null ? cursor : null,
      limit: turnLimit,
      // Legacy step ids are one-based while Reader numeric ranges are
      // zero-based source positions.
      range: legacyCursorIndex === null ? null : { fromExclusive: Math.max(0, legacyCursorIndex - 1) },
    });
    assertCompanyAccess(req, pageResult.orgId);

    const chronologicalReaderEntries = pageResult.page.items
      .map((item) => ({ item, entry: transcriptEntryFromReaderItem(item) }))
      .filter((value): value is { item: TranscriptItem; entry: TranscriptEntry } => Boolean(value.entry));
    const chronologicalTrace = buildObservedRunTrace(chronologicalReaderEntries.map((value) => value.entry));
    const stableTraceSteps = chronologicalTrace.steps.map((step, index) => ({
      ...step,
      index: (chronologicalReaderEntries[index]?.item.sequence ?? (step.index - 1)) + 1,
    }));
    const aroundError = asString(req.query.aroundError);
    const targetIndex = parseStepStableId(aroundError);
    const targetTurn = targetIndex === null
      ? null
      : stableTraceSteps.find((step) => step.index === targetIndex)?.turnIndex ?? null;
    const filteredReaderEntries = chronologicalReaderEntries.filter(({ entry, item }, index) => {
      if (asBoolean(req.query.errorsOnly)) {
        const isError = entry.kind === "stderr"
          || (entry.kind === "tool_result" && entry.isError)
          || (entry.kind === "result" && entry.isError);
        if (!isError) return false;
      }
      if (!aroundError) return true;
      if (targetIndex === null) return item.id === aroundError;
      if (targetTurn !== null && stableTraceSteps[index]?.turnIndex === targetTurn) return true;
      return Math.abs((stableTraceSteps[index]?.index ?? index + 1) - targetIndex) <= contextTurns;
    });
    const filteredTrace = buildObservedRunTrace(filteredReaderEntries.map((value) => value.entry));
    const displayReaderEntries = order === "newest" ? [...filteredReaderEntries].reverse() : filteredReaderEntries;
    const displayTraceSteps = order === "newest" ? [...filteredTrace.steps].reverse() : filteredTrace.steps;
    const allRows = displayReaderEntries.map(({ item, entry }, index) => {
      const step = displayTraceSteps[index];
      if (!step) return {
        id: item.id,
        index: item.sequence ?? index + 1,
        turnIndex: null,
        kind: item.kind,
        ts: item.ts,
        label: item.kind,
        preview: "text" in entry ? entry.text : "",
        detailPreview: "text" in entry ? entry.text : "",
        isError: false,
        isPayloadEntry: false,
        isModelEntry: false,
        output: includeOutputs ? fullText("text" in entry ? entry.text : "") : null,
      };
      return {
        ...compactTranscriptRow(step, maxChars, includeOutputs),
        id: item.id,
        index: item.sequence ?? step.index,
      };
    });
    const rows = outputMode === "full" ? allRows : limitRowsByJsonBytes(allRows, 400_000);
    const responseHasMore = Boolean(pageResult.page.nextCursor) || rows.length < allRows.length;
    const responseItems = displayReaderEntries.slice(0, rows.length);

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
        nextCursor: pageResult.page.nextCursor,
        turnLimit,
        returnedSteps: rows.length,
        totalFilteredSteps: rows.length,
        order,
      },
      rows,
      ...(outputMode === "full"
        ? {
          entries: responseItems.map(({ item, entry }, index) => ({
            id: item.id,
            index: item.sequence ?? index + 1,
            turnIndex: displayTraceSteps[index]?.turnIndex ?? null,
            entry,
            output: fullText(displayTraceSteps[index]?.detailText ?? ""),
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
    const detail = await getObservedRunDetail(db, runId, scope);
    if (!detail) throw notFound("Agent run not found");
    assertCompanyAccess(req, detail.run.orgId);
    const maxChars = asPositiveInteger(req.query.maxChars, 1200, 20000);
    const cursorIndex = parseStepStableId(asString(req.query.cursor));
    const allErrors = buildRunErrors(detail, maxChars)
      .filter((error) => cursorIndex === null || (error.index !== null && error.index > cursorIndex));
    const errors = limitRowsByJsonBytes(allErrors.slice(0, 200), 400_000);
    const hasMore = errors.length < allErrors.length;
    const lastIndexedError = [...errors].reverse().find((error) => error.index !== null);
    res.json({
      run: compactRunHeader(detail.run),
      agentName: detail.agentName,
      orgName: detail.orgName,
      issue: detail.issue,
      errors,
      page: {
        cursor: asString(req.query.cursor),
        hasMore,
        nextCursor: hasMore && lastIndexedError ? `step-${lastIndexedError.index}` : null,
      },
    });
  });

  return router;
}
