import type { Db } from "@rudderhq/db";
import {
  buildObservedRunTrace,
  type ObservedRunDetail,
  type ObservedRunStep,
} from "@rudderhq/run-intelligence-core";
import { Router } from "express";
import { badRequest, notFound } from "../errors.js";
import { formatShortRunId } from "../services/heartbeat-run-reference.js";
import {
  getObservedRun,
  getObservedRunDetail,
  getObservedRunEvents,
  getObservedRunLog,
  listObservedRuns,
} from "../services/run-intelligence.js";
import { assertCompanyAccess, getAuthorizedOrgScope } from "./authz.js";

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

function asOptionalPositiveInteger(value: unknown, max: number) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(max, Math.floor(parsed));
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

function filterTranscriptSteps(
  steps: ObservedRunStep[],
  input: { errorsOnly: boolean; aroundError: string | null; contextTurns: number },
) {
  let rows = steps;
  if (input.errorsOnly) {
    rows = rows.filter((step) => step.isError);
  }

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

function paginateTranscriptSteps(
  orderedSteps: ObservedRunStep[],
  input: { cursor: string | null; turnLimit: number | null },
) {
  const cursorStepIndex = parseStepStableId(input.cursor);
  const startIndex = cursorStepIndex
    ? orderedSteps.findIndex((step) => step.index === cursorStepIndex) + 1
    : 0;
  const available = orderedSteps.slice(Math.max(0, startIndex));

  if (!input.turnLimit) {
    return {
      rows: available,
      page: {
        cursor: input.cursor,
        nextCursor: null,
        hasMore: false,
        turnLimit: null,
        returnedSteps: available.length,
        totalFilteredSteps: orderedSteps.length,
      },
    };
  }

  const rows: ObservedRunStep[] = [];
  const seenTurnKeys = new Set<string>();
  for (const step of available) {
    const turnKey = step.turnIndex === null ? `step-${step.index}` : `turn-${step.turnIndex}`;
    if (!seenTurnKeys.has(turnKey) && seenTurnKeys.size >= input.turnLimit) break;
    seenTurnKeys.add(turnKey);
    rows.push(step);
  }
  const hasMore = rows.length < available.length;
  return {
    rows,
    page: {
      cursor: input.cursor,
      nextCursor: hasMore && rows.length > 0 ? stepStableId(rows[rows.length - 1]) : null,
      hasMore,
      turnLimit: input.turnLimit,
      returnedSteps: rows.length,
      totalFilteredSteps: orderedSteps.length,
    },
  };
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
    const usedSkill = asString(req.query.usedSkill);
    const loadedSkill = asString(req.query.loadedSkill);
    if (usedSkill && loadedSkill) {
      throw badRequest("Use either usedSkill or loadedSkill, not both.");
    }

    const rows = await listObservedRuns(db, {
      orgId,
      updatedAfter: asDateOrNull(req.query.updatedAfter),
      runIdPrefix: asString(req.query.runIdPrefix),
      agentId: asString(req.query.agentId),
      status: asString(req.query.status),
      runtime: asString(req.query.runtime),
      issueId: asString(req.query.issueId),
      usedSkill,
      loadedSkill,
      createdBefore: asDateOrNull(req.query.createdBefore),
      limit: Math.max(1, Math.min(1000, Number(req.query.limit ?? 200) || 200)),
    });

    res.json(rows);
  });

  router.get("/run-intelligence/runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const scope = { orgIds: getAuthorizedOrgScope(req) };
    const row = await getObservedRun(db, runId, scope);
    if (!row) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, row.run.orgId);
    res.json(row);
  });

  router.get("/run-intelligence/runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const scope = { orgIds: getAuthorizedOrgScope(req) };
    const run = await getObservedRun(db, runId, scope);
    if (!run) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, run.run.orgId);
    res.json(await getObservedRunEvents(db, runId, scope));
  });

  router.get("/run-intelligence/runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const scope = { orgIds: getAuthorizedOrgScope(req) };
    const run = await getObservedRun(db, runId, scope);
    if (!run) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, run.run.orgId);
    res.json(await getObservedRunLog(db, runId, scope));
  });

  router.get("/run-intelligence/runs/:runId/transcript", async (req, res) => {
    const runId = req.params.runId as string;
    const scope = { orgIds: getAuthorizedOrgScope(req) };
    const detail = await getObservedRunDetail(db, runId, scope);
    if (!detail) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, detail.run.orgId);

    const maxChars = asPositiveInteger(req.query.maxChars ?? req.query.maxOutputChars, 1200, 20000);
    const contextTurns = asPositiveInteger(req.query.contextTurns, 1, 20);
    const turnLimit = asOptionalPositiveInteger(req.query.turnLimit ?? req.query.limit, 1000);
    const cursor = asString(req.query.cursor);
    const outputMode = req.query.output === "full" ? "full" : "compact";
    const includeOutputQuery = req.query.includeOutputs ?? req.query.includeOutput;
    const includeOutputs = outputMode === "full" || includeOutputQuery === undefined
      ? true
      : asBoolean(includeOutputQuery);
    const order = req.query.order === "oldest" || req.query.order === "chronological"
      ? "oldest"
      : "newest";
    const trace = buildObservedRunTrace(detail);
    const filtered = filterTranscriptSteps(trace.steps, {
      errorsOnly: asBoolean(req.query.errorsOnly),
      aroundError: asString(req.query.aroundError),
      contextTurns,
    });
    const orderedSteps = order === "newest" ? [...filtered].reverse() : filtered;
    const paged = paginateTranscriptSteps(orderedSteps, { cursor, turnLimit });
    const rows = paged.rows.map((step) => compactTranscriptRow(step, maxChars, includeOutputs));

    res.json({
      run: detail.run,
      agentName: detail.agentName,
      orgName: detail.orgName,
      issue: detail.issue,
      order,
      output: outputMode,
      page: {
        ...paged.page,
        order,
      },
      rows,
      ...(outputMode === "full"
        ? {
          entries: paged.rows.map((step) => ({
            id: stepStableId(step),
            index: step.index,
            turnIndex: step.turnIndex,
            entry: detail.transcript[step.index - 1] ?? null,
            output: fullText(step.detailText),
          })),
          transcript: detail.transcript,
        }
        : {}),
      trace: {
        turnCount: trace.turnCount,
        stepCount: trace.steps.length,
        payloadStepCount: trace.payloadStepCount,
        filteredStepCount: filtered.length,
      },
    });
  });

  router.get("/run-intelligence/runs/:runId/errors", async (req, res) => {
    const runId = req.params.runId as string;
    const scope = { orgIds: getAuthorizedOrgScope(req) };
    const detail = await getObservedRunDetail(db, runId, scope);
    if (!detail) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, detail.run.orgId);
    const maxChars = asPositiveInteger(req.query.maxChars, 1200, 20000);
    res.json({
      run: detail.run,
      agentName: detail.agentName,
      orgName: detail.orgName,
      issue: detail.issue,
      errors: buildRunErrors(detail, maxChars),
    });
  });

  return router;
}
