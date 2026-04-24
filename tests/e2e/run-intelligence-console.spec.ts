import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { expect, test } from "@playwright/test";
import type { HeartbeatRun } from "@rudderhq/shared";
import { buildObservedRunTrace } from "../../packages/run-intelligence-core/src/trace.js";
import type { ObservedRunDetail, RunDiagnosis, RunExportRow } from "../../packages/run-intelligence-core/src/types.js";
import { createRunIntelligenceApp, type CachedRunDetail, type CachedRunSummary } from "../../services/run-intelligence/src/server.js";

function makeRun(id: string, status: HeartbeatRun["status"], agentId: string, startedAt: string, finishedAt: string): HeartbeatRun {
  return {
    id,
    orgId: "org-1",
    agentId,
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status,
    startedAt: new Date(startedAt),
    finishedAt: new Date(finishedAt),
    error: status === "failed" ? "tool loop detected" : null,
    wakeupRequestId: null,
    exitCode: status === "failed" ? 1 : 0,
    signal: null,
    usageJson: { inputTokens: 1250, outputTokens: 420, costUsd: status === "failed" ? 0.91 : 0.42 },
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: "local_file",
    logRef: `${id}.ndjson`,
    logBytes: 256,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: status === "failed" ? "tool loop detected" : null,
    errorCode: status === "failed" ? "loop" : null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: {},
    createdAt: new Date(startedAt),
    updatedAt: new Date(finishedAt),
  };
}

function makeRow(run: HeartbeatRun, agentName: string, issueId: string): RunExportRow {
  return {
    run,
    agentName,
    orgName: "Acme",
    issue: { id: issueId, identifier: issueId.toUpperCase(), title: "Investigate run behavior" },
    bundle: {
      agentRuntimeType: "codex_local",
      agentConfigRevisionId: `rev-${run.id}`,
      agentConfigRevisionCreatedAt: "2026-04-08T09:55:00.000Z",
      agentConfigFingerprint: `agent-fp-${run.id}`,
      runtimeConfigFingerprint: `runtime-fp-${run.id}`,
    },
  };
}

function makeDetail(row: RunExportRow, variant: "clean" | "payload-heavy"): CachedRunDetail {
  const transcript: ObservedRunDetail["transcript"] = variant === "payload-heavy"
    ? [
        { kind: "system", ts: "2026-04-08T10:00:00.000Z", text: "booted" },
        { kind: "assistant", ts: "2026-04-08T10:00:02.000Z", text: "I will inspect the run transcript before retrying." },
        { kind: "tool_call", ts: "2026-04-08T10:00:03.000Z", name: "Read", input: { filePath: "/tmp/huge.log" } },
        {
          kind: "tool_result",
          ts: "2026-04-08T10:00:04.000Z",
          toolUseId: "tool-1",
          toolName: "Read",
          content: "first line\nsecond line\nthird line",
          isError: false,
        },
        {
          kind: "result",
          ts: "2026-04-08T10:00:05.000Z",
          text: "The issue is a repeated read loop.",
          inputTokens: 900,
          outputTokens: 120,
          cachedTokens: 0,
          costUsd: 0.64,
          subtype: "completed",
          isError: false,
          errors: [],
        },
      ]
    : [
        { kind: "assistant", ts: "2026-04-08T10:02:02.000Z", text: "I found the issue quickly and completed the task." },
        {
          kind: "result",
          ts: "2026-04-08T10:02:03.000Z",
          text: "Completed without extra tool calls.",
          inputTokens: 350,
          outputTokens: 80,
          cachedTokens: 0,
          costUsd: 0.22,
          subtype: "completed",
          isError: false,
          errors: [],
        },
      ];

  const detail: ObservedRunDetail = {
    ...row,
    events: [{
      id: 1,
      orgId: "org-1",
      runId: row.run.id,
      agentId: row.run.agentId,
      seq: 1,
      eventType: "run.started",
      stream: "system",
      level: "info",
      color: null,
      message: "started",
      payload: null,
      createdAt: row.run.createdAt,
    }],
    logContent: "{\"stream\":\"stdout\",\"chunk\":\"hello\"}",
    logChunks: [{ ts: "2026-04-08T10:00:01.000Z", stream: "stdout", chunk: "hello" }],
    transcript,
  };
  const diagnosis: RunDiagnosis = {
    mode: "full",
    status: row.run.status,
    summary: variant === "payload-heavy" ? "Payload-heavy run with a suspicious read loop." : "Healthy run",
    failureTaxonomy: variant === "payload-heavy" ? "run_failed_unknown" : "healthy_or_unknown",
    findings: variant === "payload-heavy"
      ? [{ id: "loop", severity: "warn", category: "behavior", title: "Repeated read loop", detail: "The agent kept opening large payloads.", evidence: [] }]
      : [],
    nextSteps: ["Start with the trace outline, then inspect only the suspicious turn or step."],
    metrics: {
      durationMs: 60_000,
      inputTokens: 1250,
      outputTokens: 420,
      cachedTokens: 0,
      costUsd: variant === "payload-heavy" ? 0.91 : 0.42,
      assistantTurns: 1,
      toolCalls: variant === "payload-heavy" ? 1 : 0,
      toolResults: variant === "payload-heavy" ? 1 : 0,
      stderrLines: 0,
      firstToolCallLatencyMs: variant === "payload-heavy" ? 1000 : null,
      firstAssistantOutputLatencyMs: 500,
      topTools: variant === "payload-heavy" ? [{ name: "Read", count: 1 }] : [],
    },
  };

  return {
    detail,
    diagnosis,
    trace: buildObservedRunTrace(detail),
    lastSyncedAt: "2026-04-08T10:03:00.000Z",
  };
}

test.describe("Run Intelligence console", () => {
  let baseUrl = "";
  let server: Server;
  let refreshCount = 0;

  test.beforeAll(async () => {
    const failedRow = makeRow(
      makeRun("run-a1111111", "failed", "agent-a", "2026-04-08T10:00:00.000Z", "2026-04-08T10:01:00.000Z"),
      "Debug Agent",
      "rud-100",
    );
    const healthyRow = makeRow(
      makeRun("run-b2222222", "succeeded", "agent-b", "2026-04-08T10:02:00.000Z", "2026-04-08T10:03:00.000Z"),
      "Verifier Agent",
      "rud-101",
    );

    const summaries: CachedRunSummary[] = [
      { row: failedRow, findingSummary: "Payload-heavy run with a suspicious read loop.", lastSyncedAt: "2026-04-08T10:03:00.000Z" },
      { row: healthyRow, findingSummary: "Healthy", lastSyncedAt: "2026-04-08T10:03:00.000Z" },
    ];
    const details = {
      [failedRow.run.id]: makeDetail(failedRow, "payload-heavy"),
      [healthyRow.run.id]: makeDetail(healthyRow, "clean"),
    } satisfies Record<string, CachedRunDetail>;

    const cache = {
      getOrganizations: () => [{ id: "org-1", name: "Acme" }],
      listRuns: () => summaries,
      readRunDetail: async (runId: string) => details[runId] ?? null,
    };
    const sync = {
      synchronizeAll: async () => {
        refreshCount += 1;
      },
      refreshRunDetail: async (runId: string) => {
        const detail = details[runId];
        if (!detail) throw new Error(`Unknown run ${runId}`);
        return detail;
      },
    };

    const app = createRunIntelligenceApp({
      cache,
      sync,
      publicDir: path.join(process.cwd(), "services/run-intelligence/src/public"),
    });
    server = app.listen(0);
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  test("refreshes on entry and separates runs, detail, and compare modes", async ({ page }) => {
    await page.goto(baseUrl);

    await expect.poll(() => refreshCount).toBe(1);
    await expect(page.getByText("2 runs")).toBeVisible();
    await expect(page.locator("#runsTableBody tr")).toHaveCount(2);
    await expect(page.locator("#pageTitle")).toHaveText("Runs");

    const payloadRow = page.locator("#runsTableBody tr", { hasText: "Payload-heavy run with a suspicious read loop." });
    await payloadRow.click();
    await expect(page).toHaveURL(/\/runs\/run-a1111111$/);
    await expect(page.getByText("Transcript Turns")).toBeVisible();
    await expect(page.getByText("Single-run reading mode.")).toBeVisible();
    await expect(page.locator(".turn-group")).toHaveCount(2);
    await page.screenshot({
      path: "tests/e2e/test-results/run-intelligence-detail-page.png",
      fullPage: true,
    });

    await page.getByRole("button", { name: "Add To Compare" }).click();
    await expect(page.getByText("1 queued for compare")).toBeVisible();

    await page.getByRole("link", { name: /Back to runs/i }).click();
    await expect(page).toHaveURL(baseUrl + "/");

    const healthyRow = page.locator("#runsTableBody tr", { hasText: "Healthy" });
    await healthyRow.getByRole("button", { name: "Compare" }).click();
    await expect(page.getByText("2 queued for compare")).toBeVisible();
    await page.getByRole("link", { name: "Open Compare" }).click();
    await expect(page).toHaveURL(/\/compare\?/);
    await expect(page.getByRole("heading", { name: "2 runs in compare" })).toBeVisible();
    await expect(page.locator(".compare-panel")).toHaveCount(2);
    await expect(page.getByText("Run Facts").first()).toBeVisible();
    await expect(page.getByText("Created").first()).toBeVisible();
    await expect(page.getByText("Tokens / Cost").first()).toBeVisible();
    await expect(page.getByText("Debug Agent").first()).toBeVisible();
    await expect(page.getByText("Acme").first()).toBeVisible();
    await expect(page.getByText("run-a1111111").first()).toBeVisible();

    await page.locator("#refreshButton").click();
    await expect.poll(() => refreshCount).toBe(2);

    await page.locator(".trace-step summary", { hasText: "first line" }).click();
    await expect(page.getByText("second line")).toBeVisible();

    await page.screenshot({
      path: "tests/e2e/test-results/run-intelligence-compare-page.png",
      fullPage: true,
    });
  });
});
