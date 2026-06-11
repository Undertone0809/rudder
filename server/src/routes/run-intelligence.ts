import { Router } from "express";
import type { Db } from "@rudderhq/db";
import {
  buildObservedRunTrace,
  type ObservedRunDetail,
  type ObservedRunStep,
} from "@rudderhq/run-intelligence-core";
import { notFound } from "../errors.js";
import {
  getObservedRun,
  getObservedRunDetail,
  getObservedRunEvents,
  getObservedRunLog,
  listObservedRuns,
} from "../services/run-intelligence.js";
import { assertCompanyAccess } from "./authz.js";

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

function compactTranscriptRow(step: ObservedRunStep, maxChars: number) {
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
    output: clipText(step.detailText, maxChars),
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
        command: `rudder runs transcript ${detail.run.id} --around-error ${stepStableId(step)}`,
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

    const rows = await listObservedRuns(db, {
      orgId,
      updatedAfter: asDateOrNull(req.query.updatedAfter),
      runIdPrefix: asString(req.query.runIdPrefix),
      agentId: asString(req.query.agentId),
      status: asString(req.query.status),
      runtime: asString(req.query.runtime),
      issueId: asString(req.query.issueId),
      createdBefore: asDateOrNull(req.query.createdBefore),
      limit: Math.max(1, Math.min(1000, Number(req.query.limit ?? 200) || 200)),
    });

    res.json(rows);
  });

  router.get("/run-intelligence/runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const row = await getObservedRun(db, runId);
    if (!row) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, row.run.orgId);
    res.json(row);
  });

  router.get("/run-intelligence/runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await getObservedRun(db, runId);
    if (!run) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, run.run.orgId);
    res.json(await getObservedRunEvents(db, runId));
  });

  router.get("/run-intelligence/runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await getObservedRun(db, runId);
    if (!run) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, run.run.orgId);
    res.json(await getObservedRunLog(db, runId));
  });

  router.get("/run-intelligence/runs/:runId/transcript", async (req, res) => {
    const runId = req.params.runId as string;
    const detail = await getObservedRunDetail(db, runId);
    if (!detail) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, detail.run.orgId);

    const maxChars = asPositiveInteger(req.query.maxChars, 1200, 20000);
    const contextTurns = asPositiveInteger(req.query.contextTurns, 1, 20);
    const order = req.query.order === "oldest" || req.query.order === "chronological"
      ? "oldest"
      : "newest";
    const trace = buildObservedRunTrace(detail);
    const filtered = filterTranscriptSteps(trace.steps, {
      errorsOnly: asBoolean(req.query.errorsOnly),
      aroundError: asString(req.query.aroundError),
      contextTurns,
    });
    const rows = (order === "newest" ? [...filtered].reverse() : filtered)
      .map((step) => compactTranscriptRow(step, maxChars));

    res.json({
      run: detail.run,
      agentName: detail.agentName,
      orgName: detail.orgName,
      issue: detail.issue,
      order,
      rows,
      trace: {
        turnCount: trace.turnCount,
        stepCount: trace.steps.length,
        payloadStepCount: trace.payloadStepCount,
      },
    });
  });

  router.get("/run-intelligence/runs/:runId/errors", async (req, res) => {
    const runId = req.params.runId as string;
    const detail = await getObservedRunDetail(db, runId);
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
