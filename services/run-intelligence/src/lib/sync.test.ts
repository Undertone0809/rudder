import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HeartbeatRun } from "@rudder/shared";
import type { ObservedRunDetail, RunDiagnosis, RunExportRow } from "@rudder/run-intelligence-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunIntelligenceCache } from "./cache.js";
import { RunIntelligenceSync } from "./sync.js";
import { diagnoseRun, listObservedRuns, loadObservedRunDetail } from "@rudder/run-intelligence-core";

vi.mock("@rudder/run-intelligence-core", () => ({
  listOrganizations: vi.fn(),
  listObservedRuns: vi.fn(),
  loadObservedRunDetail: vi.fn(),
  diagnoseRun: vi.fn(),
}));

function makeRun(index: number): HeartbeatRun {
  const createdAt = new Date(Date.UTC(2026, 3, 8, 12, 0, 0, 0) - index * 1000);
  return {
    id: `run-${index}`,
    orgId: "org-1",
    agentId: `agent-${index % 3}`,
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "succeeded",
    startedAt: createdAt,
    finishedAt: createdAt,
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: "local_file",
    logRef: `org-1/agent-${index % 3}/run-${index}.ndjson`,
    logBytes: 12,
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
    contextSnapshot: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeRow(index: number): RunExportRow {
  return {
    run: makeRun(index),
    agentName: `Agent ${index}`,
    orgName: "Acme",
    issue: null,
    bundle: {
      agentRuntimeType: "codex_local",
      agentConfigRevisionId: null,
      agentConfigRevisionCreatedAt: null,
      agentConfigFingerprint: null,
      runtimeConfigFingerprint: null,
    },
  };
}

function makeDiagnosis(): RunDiagnosis {
  return {
    mode: "full",
    status: "succeeded",
    summary: "Healthy run",
    failureTaxonomy: "healthy_or_unknown",
    findings: [],
    nextSteps: [],
    metrics: {
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      assistantTurns: 0,
      toolCalls: 0,
      toolResults: 0,
      stderrLines: 0,
      firstToolCallLatencyMs: null,
      firstAssistantOutputLatencyMs: null,
      topTools: [],
    },
  };
}

describe("RunIntelligenceSync", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-intelligence-sync-"));
    vi.mocked(diagnoseRun).mockReturnValue(makeDiagnosis());
    vi.mocked(loadObservedRunDetail).mockResolvedValue({
      ...makeRow(0),
      events: [],
      logContent: "",
      logChunks: [],
      transcript: [],
    } satisfies ObservedRunDetail);
  });

  afterEach(async () => {
    vi.resetAllMocks();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("backfills all historical runs with createdBefore pagination", async () => {
    const firstPage = Array.from({ length: 400 }, (_, index) => makeRow(index + 1));
    const secondPage = [makeRow(401), makeRow(402), makeRow(403)];

    vi.mocked(listObservedRuns).mockImplementation(async (_apiBaseUrl, _orgId, params) => {
      const createdBefore = params?.get("createdBefore");
      if (!createdBefore) return firstPage;
      return secondPage;
    });

    const cache = new RunIntelligenceCache(cacheDir);
    await cache.init();
    const sync = new RunIntelligenceSync(cache, "http://localhost:3100/api", 15_000);

    await sync.synchronizeOrganization("org-1");

    expect(cache.listRuns()).toHaveLength(403);
    expect(vi.mocked(listObservedRuns)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listObservedRuns).mock.calls[1]?.[2]?.get("createdBefore")).toBe(
      firstPage[firstPage.length - 1]?.run.createdAt.toISOString(),
    );
  });
});
