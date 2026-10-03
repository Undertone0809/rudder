import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { resolveManagedCodexHomeDir } from "../../packages/agent-runtimes/codex-local/src/server/codex-home.ts";
import { asc, eq, inArray } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  chatMessageTranscriptEntries,
  chatMessages,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
} from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL, E2E_HOME, E2E_INSTANCE_ID, E2E_PORT, E2E_ROOT } from "./support/e2e-env";

const db = createDb(E2E_DATABASE_URL);
const TOOL_OUTPUT_BYTES = 256 * 1024;

test.afterAll(async () => { await db.$client.end(); });

type TranscriptProjection = {
  source: string;
  availability: string;
  completeness: string;
  revision: string;
  page: { hasMore: boolean; returnedSteps: number };
  entries: Array<{
    entry: Record<string, unknown>;
    output: { text: string; clipped: boolean; originalLength: number } | null;
  }>;
};

function selectedRowsJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function serverListenerRss() {
  try {
    const listenerPid = Number(execFileSync("lsof", [
      "-nP", "-t", `-iTCP:${E2E_PORT}`, "-sTCP:LISTEN",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/)[0]);
    if (!Number.isInteger(listenerPid) || listenerPid <= 0) return null;
    const rssKb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(listenerPid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim());
    return Number.isFinite(rssKb) && rssKb > 0 ? { pid: listenerPid, rssBytes: rssKb * 1024 } : null;
  } catch {
    return null;
  }
}

test("native Chat reads a large Codex tool result by exact Run span without SQL transcript duplication", async ({ page, request }) => {
  const orgResponse = await request.post("/api/orgs", { data: { name: `Native Storage ${randomUUID()}` } });
  expect(orgResponse.ok()).toBe(true);
  const org = await orgResponse.json() as { id: string; urlKey: string };
  const agent = await createE2EChatAgent(request, org.id, {
    name: "Native Storage Agent",
    command: path.join(E2E_ROOT, "fixtures/codex-native-session.mjs"),
  });
  const codexHome = resolveManagedCodexHomeDir({
    RUDDER_HOME: E2E_HOME,
    RUDDER_INSTANCE_ID: E2E_INSTANCE_ID,
  }, org.id, agent.id);

  await page.goto("/");
  await page.evaluate((orgId) => localStorage.setItem("rudder.selectedOrganizationId", orgId), org.id);
  await page.setViewportSize({ width: 1500, height: 940 });
  await page.goto(`/${org.urlKey}/messenger/chat?agentId=${agent.id}`);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const readBrowserHeap = async () => {
    const result = await cdp.send("Performance.getMetrics") as {
      metrics: Array<{ name: string; value: number }>;
    };
    return result.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? null;
  };
  const heapBefore = await readBrowserHeap();
  const serverRssBefore = serverListenerRss();
  const composer = page.locator(".rudder-mdxeditor-content").first();

  const sendTurn = async (prompt: string, expectedReply: string) => {
    await composer.fill(prompt);
    const stream = page.waitForResponse((response) => response.request().method() === "POST"
      && response.url().endsWith("/messages/stream"));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await (await stream).finished();
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(expectedReply, { timeout: 30_000 });
  };

  const firstPrompt = "First native storage turn";
  await sendTurn(firstPrompt, "Native reply 1");
  const conversationId = new URL(page.url()).pathname.split("/").at(-1)!;
  const nonce = randomUUID().replaceAll("-", "");
  const outputMarker = `NATIVE_TOOL_OUTPUT_${nonce}`;
  await sendTurn(`Native storage payload nonce: ${nonce}`, "Native reply 2");

  await expect.poll(async () => db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.chatConversationId, conversationId))
    .orderBy(asc(heartbeatRuns.createdAt)), { timeout: 15_000 }).toHaveLength(2);
  const runs = await db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.chatConversationId, conversationId))
    .orderBy(asc(heartbeatRuns.createdAt));
  const runIds = runs.map((run) => run.id);
  const spans = await db.select().from(runRuntimeSpans)
    .where(inArray(runRuntimeSpans.runId, runIds));
  expect(spans).toHaveLength(2);
  const spanByRun = new Map(spans.map((span) => [span.runId, span]));

  const historyRoot = path.join(codexHome, "e2e-native-history");
  const historyFiles = (await readdir(historyRoot)).filter((name) => name.endsWith(".json"));
  expect(historyFiles).toHaveLength(1);
  const nativeFile = path.join(historyRoot, historyFiles[0]!);
  const nativeBytes = await readFile(nativeFile);
  const nativeHistory = JSON.parse(nativeBytes.toString("utf8")) as {
    id: string;
    turns: Array<{ id: string; items: Array<Record<string, unknown>> }>;
  };
  expect(nativeHistory.turns).toHaveLength(2);
  expect(nativeBytes.toString("utf8").split(outputMarker)).toHaveLength(2);
  const toolItem = nativeHistory.turns[1]!.items.find((item) => item.type === "commandExecution");
  expect(toolItem?.aggregatedOutput).toBe(`${outputMarker}${"x".repeat(TOOL_OUTPUT_BYTES - outputMarker.length)}`);
  expect(Buffer.byteLength(String(toolItem?.aggregatedOutput))).toBe(TOOL_OUTPUT_BYTES);

  for (const [index, run] of runs.entries()) {
    const span = spanByRun.get(run.id)!;
    expect(span).toMatchObject({
      orgId: org.id,
      state: "sealed",
      completeness: "complete",
      selectorJson: {
        kind: "codex_turn",
        threadId: nativeHistory.id,
        turnId: nativeHistory.turns[index]!.id,
      },
      nativeExecutionRef: nativeHistory.turns[index]!.id,
    });
  }

  const readTranscript = async (runId: string) => {
    const startedAt = performance.now();
    const response = await page.request.get(
      `/api/run-intelligence/runs/${runId}/transcript?output=full&includeOutputs=true&order=oldest&maxChars=20000&turnLimit=200`,
    );
    const latencyMs = performance.now() - startedAt;
    expect(response.ok(), `Transcript API returned HTTP ${response.status()}`).toBe(true);
    const transcript = await response.json() as TranscriptProjection;
    expect(transcript).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    expect(transcript.page.hasMore).toBe(false);
    return { transcript, latencyMs };
  };

  const firstRead = await readTranscript(runs[0]!.id);
  const secondRead = await readTranscript(runs[1]!.id);
  const firstProjection = JSON.stringify(firstRead.transcript.entries);
  const secondProjection = JSON.stringify(secondRead.transcript.entries);
  expect(firstProjection).toContain(firstPrompt);
  expect(firstProjection).not.toContain(outputMarker);
  expect(firstProjection).not.toContain(nonce);
  expect(secondProjection).toContain(nonce);
  expect(secondProjection).toContain(outputMarker);
  const expectCompleteToolOutput = (transcript: TranscriptProjection) => {
    const result = transcript.entries.find((entry) => entry.entry.kind === "tool_result"
      && entry.output?.text.includes(outputMarker));
    expect(result, "Native tool result is present in the full API response").toBeDefined();
    const output = result!.output!;
    expect(output.clipped).toBe(false);
    expect(output.originalLength).toBe(output.text.length);
    const nativeOutput = String(toolItem!.aggregatedOutput);
    const returnedNativeOutput = output.text.slice(output.text.indexOf(outputMarker));
    expect(returnedNativeOutput).toBe(nativeOutput);
    expect(Buffer.byteLength(returnedNativeOutput)).toBe(TOOL_OUTPUT_BYTES);
  };
  expectCompleteToolOutput(secondRead.transcript);

  const events = await db.select().from(heartbeatRunEvents)
    .where(inArray(heartbeatRunEvents.runId, runIds));
  const segments = await db.select().from(nativeSegments)
    .where(inArray(nativeSegments.id, spans.map((span) => span.segmentId)));
  const messages = await db.select().from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(asc(chatMessages.createdAt));
  const transcriptRows = await db.select().from(chatMessageTranscriptEntries)
    .where(eq(chatMessageTranscriptEntries.orgId, org.id));

  expect(runs.every((run) => run.orgId === org.id
    && run.logRef === null
    && (run.logBytes ?? 0) === 0
    && run.stdoutExcerpt === null
    && run.stderrExcerpt === null)).toBe(true);
  const retentionSnapshots = runs.map((run) => {
    const context = run.contextSnapshot as Record<string, unknown> | null;
    const nativeRetention = context?.nativeTranscriptRetention as Record<string, unknown> | undefined;
    const resultRetention = run.resultJson?.retention as Record<string, unknown> | undefined;
    return {
      runId: run.id,
      status: nativeRetention?.status,
      reason: nativeRetention?.reason ?? null,
      recoveryCount: Array.isArray(nativeRetention?.recovery) ? nativeRetention.recovery.length : null,
      transcriptSource: resultRetention?.transcriptSource,
      rawResultPersisted: resultRetention?.rawResultPersisted,
    };
  });
  expect(retentionSnapshots).toEqual(runs.map((run) => ({
    runId: run.id,
    status: "reference_only",
    reason: null,
    recoveryCount: 0,
    transcriptSource: "native",
    rawResultPersisted: false,
  })));
  expect(JSON.stringify(runs.map((run) => [run.resultJson, run.contextSnapshot, run.stdoutExcerpt, run.stderrExcerpt])))
    .not.toContain(outputMarker);
  expect(JSON.stringify(events)).not.toContain(outputMarker);
  expect(JSON.stringify(segments.map((segment) => segment.providerStateJson))).not.toContain(outputMarker);
  expect(JSON.stringify(messages)).not.toContain(outputMarker);
  expect(transcriptRows).toHaveLength(0);

  await page.reload();
  await expect(page.getByTestId("chat-assistant-message")).toHaveCount(2);
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Native reply 2");
  const firstAfterReload = await readTranscript(runs[0]!.id);
  const secondAfterReload = await readTranscript(runs[1]!.id);
  expect(firstAfterReload.transcript.revision).toBe(firstRead.transcript.revision);
  expect(secondAfterReload.transcript.revision).toBe(secondRead.transcript.revision);
  expect(JSON.stringify(firstAfterReload.transcript.entries)).not.toContain(outputMarker);
  expect(JSON.stringify(secondAfterReload.transcript.entries)).toContain(outputMarker);
  expectCompleteToolOutput(secondAfterReload.transcript);

  const heapAfter = await readBrowserHeap();
  const serverRssAfter = serverListenerRss();
  const sqlRows = { runs, spans, segments, events, messages, transcriptRows };
  const metrics = {
    runCount: runs.length,
    toolOutputBytes: TOOL_OUTPUT_BYTES,
    nativeSessionFileCount: historyFiles.length,
    nativeSessionFileBytes: (await stat(nativeFile)).size,
    selectedSqlRowJsonBytes: selectedRowsJsonBytes(sqlRows),
    selectedSqlRowCounts: {
      runs: runs.length,
      spans: spans.length,
      segments: segments.length,
      events: events.length,
      chatMessages: messages.length,
      duplicatedChatTranscriptRows: transcriptRows.length,
    },
    agentRunLogBytes: runs.reduce((total, run) => total + (run.logBytes ?? 0), 0),
    readerLatencyMs: {
      beforeReload: [firstRead.latencyMs, secondRead.latencyMs],
      afterReload: [firstAfterReload.latencyMs, secondAfterReload.latencyMs],
    },
    browserJsHeapBytes: { before: heapBefore, after: heapAfter },
    serverListenerRssBytes: { before: serverRssBefore?.rssBytes ?? null, after: serverRssAfter?.rssBytes ?? null },
    runtimeHostRssBytes: null,
    runtimeHostRssNote: "The fixture process exits with each completed Run; no live host sample was available.",
  };
  console.info(`W12_NATIVE_STORAGE_METRICS ${JSON.stringify(metrics)}`);
  await cdp.detach();
});
