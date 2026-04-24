import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type { HeartbeatRun, HeartbeatRunEvent } from "@rudderhq/shared";
import { buildObservedRunTrace, type ObservedRunDetail, type RunDiagnosis, type RunExportRow } from "@rudderhq/run-intelligence-core";
import { describe, expect, it, vi } from "vitest";
import { createRunIntelligenceApp, type CachedRunDetail, type CachedRunSummary } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeRun(): HeartbeatRun {
  return {
    id: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "succeeded",
    startedAt: new Date("2026-04-08T10:00:00.000Z"),
    finishedAt: new Date("2026-04-08T10:01:00.000Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: { inputTokens: 10, outputTokens: 20, costUsd: 0.12 },
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: "local_file",
    logRef: "org-1/agent-1/run-1.ndjson",
    logBytes: 20,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: { issueId: "issue-1" },
    createdAt: new Date("2026-04-08T10:00:00.000Z"),
    updatedAt: new Date("2026-04-08T10:01:00.000Z"),
  };
}

function makeRow(): RunExportRow {
  return {
    run: makeRun(),
    agentName: "Debug Agent",
    orgName: "Acme",
    issue: { id: "issue-1", identifier: "RUD-1", title: "Investigate run" },
    bundle: {
      agentRuntimeType: "codex_local",
      agentConfigRevisionId: "rev-1",
      agentConfigRevisionCreatedAt: "2026-04-08T09:55:00.000Z",
      agentConfigFingerprint: "agent-fp",
      runtimeConfigFingerprint: "runtime-fp",
    },
  };
}

function makeDetail(): ObservedRunDetail {
  const row = makeRow();
  const events: HeartbeatRunEvent[] = [{
    id: 1,
    orgId: "org-1",
    runId: "run-1",
    agentId: "agent-1",
    seq: 1,
    eventType: "run.started",
    stream: "system",
    level: "info",
    color: null,
    message: "started",
    payload: null,
    createdAt: new Date("2026-04-08T10:00:00.000Z"),
  }];

  return {
    ...row,
    events,
    logContent: "{\"stream\":\"stdout\",\"chunk\":\"hello\"}",
    logChunks: [{ ts: "2026-04-08T10:00:01.000Z", stream: "stdout", chunk: "hello" }],
    transcript: [{ kind: "stdout", ts: "2026-04-08T10:00:01.000Z", text: "hello" }],
  };
}

function makeDiagnosis(): RunDiagnosis {
  return {
    mode: "full",
    status: "succeeded",
    summary: "Healthy run",
    failureTaxonomy: "healthy_or_unknown",
    findings: [],
    nextSteps: ["Review transcript if needed."],
    metrics: {
      durationMs: 60_000,
      inputTokens: 10,
      outputTokens: 20,
      cachedTokens: 0,
      costUsd: 0.12,
      assistantTurns: 1,
      toolCalls: 0,
      toolResults: 0,
      stderrLines: 0,
      firstToolCallLatencyMs: null,
      firstAssistantOutputLatencyMs: 1000,
      topTools: [],
    },
  };
}

function makeCachedDetail(): CachedRunDetail {
  const detail = makeDetail();
  return {
    detail,
    diagnosis: makeDiagnosis(),
    trace: buildObservedRunTrace(detail),
    lastSyncedAt: "2026-04-08T10:01:30.000Z",
  };
}

describe("createRunIntelligenceApp", () => {
  it("serves runs, detail, and the landing page", async () => {
    const cachedSummary: CachedRunSummary = {
      row: makeRow(),
      findingSummary: "Healthy",
      lastSyncedAt: "2026-04-08T10:01:30.000Z",
    };
    const cachedDetail = makeCachedDetail();
    const cache = {
      getOrganizations: () => [{ id: "org-1", name: "Acme" }],
      listRuns: () => [cachedSummary],
      readRunDetail: vi.fn(async () => cachedDetail),
    };
    const sync = {
      synchronizeAll: vi.fn(async () => undefined),
      refreshRunDetail: vi.fn(async () => ({
        detail: makeDetail(),
        diagnosis: makeDiagnosis(),
        trace: buildObservedRunTrace(makeDetail()),
      })),
    };

    const app = createRunIntelligenceApp({
      cache,
      sync,
      publicDir: path.join(__dirname, "public"),
    });

    const runsRes = await request(app).get("/api/runs");
    expect(runsRes.status).toBe(200);
    expect(runsRes.body[0].row.run.id).toBe("run-1");

    const detailRes = await request(app).get("/api/runs/run-1");
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.detail?.run?.id ?? detailRes.body.run?.id).toBe("run-1");
    expect(detailRes.body.trace?.turnCount).toBe(0);
    expect(sync.refreshRunDetail).not.toHaveBeenCalled();

    const refreshRes = await request(app).post("/api/refresh");
    expect(refreshRes.status).toBe(200);
    expect(sync.synchronizeAll).toHaveBeenCalledTimes(1);

    const pageRes = await request(app).get("/");
    expect(pageRes.status).toBe(200);
    expect(pageRes.text).toContain("Run Intelligence");
  });

  it("refreshes a run detail when cache is cold", async () => {
    const cache = {
      getOrganizations: () => [],
      listRuns: () => [],
      readRunDetail: vi.fn(async () => null),
    };
    const sync = {
      synchronizeAll: vi.fn(async () => undefined),
      refreshRunDetail: vi.fn(async () => ({
        detail: makeDetail(),
        diagnosis: makeDiagnosis(),
        trace: buildObservedRunTrace(makeDetail()),
      })),
    };

    const app = createRunIntelligenceApp({
      cache,
      sync,
      publicDir: path.join(__dirname, "public"),
    });

    const detailRes = await request(app).get("/api/runs/run-1");
    expect(detailRes.status).toBe(200);
    expect(sync.refreshRunDetail).toHaveBeenCalledWith("run-1");

    const forcedRes = await request(app).post("/api/runs/run-1/refresh");
    expect(forcedRes.status).toBe(200);
    expect(sync.refreshRunDetail).toHaveBeenCalledTimes(2);
  });
});
