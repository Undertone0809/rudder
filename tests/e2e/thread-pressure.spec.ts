import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  chatMessages,
  createDb,
  heartbeatRuns,
  issueComments,
} from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL, E2E_INSTANCE_ROOT } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const CHAT_MESSAGE_COUNT = 2_000;
const ISSUE_COMMENT_COUNT = 500;
const TERMINAL_RUN_COUNT = 250;
const ACTIVE_RUN_COUNT = 2;

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function insertGeneratedChunks<T>(
  count: number,
  createRow: (index: number) => T,
  insert: (rows: T[]) => Promise<unknown>,
) {
  for (let start = 0; start < count; start += 250) {
    const size = Math.min(250, count - start);
    await insert(Array.from({ length: size }, (_, offset) => createRow(start + offset)));
  }
}

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test("keeps whale Chat and Issue detail correct without terminal run-log fanout", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 });

  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Thread-Pressure-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };

  const agentResponse = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Thread Pressure Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        command: "codex",
        model: "gpt-5.4",
      },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = await agentResponse.json() as { id: string };

  const chatResponse = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Two thousand message pressure chat",
      preferredAgentId: agent.id,
    },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json() as { id: string };

  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Issue with five hundred comments and two hundred fifty runs",
      description: "Browser-shaped single-entity pressure fixture.",
      status: "todo",
      priority: "high",
    },
  });
  expect(issueResponse.ok()).toBe(true);
  const issue = await issueResponse.json() as { id: string; identifier: string | null };

  const anchor = Date.parse("2026-07-20T00:00:00.000Z");
  await insertGeneratedChunks(
    CHAT_MESSAGE_COUNT,
    (index) => {
      const createdAt = new Date(anchor + Math.floor(index / 4) * 1_000);
      return {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        kind: "message" as const,
        status: "completed" as const,
        body: `Pressure chat message ${index + 1}. ${index % 7 === 0 ? "中文 emoji 🧭 and **markdown**. " : ""}${"context ".repeat(index % 20)}`,
        structuredPayload: index % 31 === 0 ? { benchmarkEvidence: { index } } : null,
        replyingAgentId: index % 2 === 0 ? null : agent.id,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => e2eDb.insert(chatMessages).values(rows),
  );

  await insertGeneratedChunks(
    ISSUE_COMMENT_COUNT,
    (index) => {
      const createdAt = new Date(anchor + Math.floor(index / 4) * 1_000);
      return {
        id: randomUUID(),
        orgId: organization.id,
        issueId: issue.id,
        authorAgentId: index % 5 === 0 ? null : agent.id,
        authorUserId: index % 5 === 0 ? "local-board" : null,
        body: `Pressure issue comment ${index + 1}. ${"evidence ".repeat(index % 20)}`,
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => e2eDb.insert(issueComments).values(rows),
  );

  const terminalRunIds: string[] = [];
  const activeRunIds: string[] = [];
  const logRefByRunId = new Map<string, string>();
  await insertGeneratedChunks(
    TERMINAL_RUN_COUNT + ACTIVE_RUN_COUNT,
    (index) => {
      const id = randomUUID();
      const active = index >= TERMINAL_RUN_COUNT;
      const createdAt = active
        ? new Date(Date.now() + (index - TERMINAL_RUN_COUNT) * 1_000)
        : new Date(anchor + Math.floor(index / 4) * 1_000);
      (active ? activeRunIds : terminalRunIds).push(id);
      const hasPersistedLog = active || index === 0;
      const logRef = hasPersistedLog
        ? path.join(organization.id, agent.id, `${id}.ndjson`)
        : null;
      if (logRef) logRefByRunId.set(id, logRef);
      return {
        id,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "issue_assignment",
        triggerDetail: `pressure run ${index + 1}`,
        status: active ? "running" : "succeeded",
        startedAt: createdAt,
        finishedAt: active ? null : new Date(createdAt.getTime() + 30_000),
        stdoutExcerpt: `Pressure run ${index + 1} summary output.`,
        resultSummaryJson: active ? null : { summary: `Pressure result ${index + 1}` },
        logStore: logRef ? "local_file" : null,
        logRef,
        contextSnapshot: { issueId: issue.id, taskId: issue.id },
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => e2eDb.insert(heartbeatRuns).values(rows),
  );

  const terminalEvidence = `TERMINAL_RUN_EVIDENCE_${terminalRunIds[0]}`;
  for (const [runId, logRef] of logRefByRunId) {
    const absoluteLogPath = path.join(E2E_INSTANCE_ROOT, "data", "run-logs", logRef);
    await fs.mkdir(path.dirname(absoluteLogPath), { recursive: true });
    const evidence = runId === terminalRunIds[0]
      ? terminalEvidence
      : `ACTIVE_RUN_INITIAL_EVIDENCE_${runId}`;
    await fs.writeFile(absoluteLogPath, `${JSON.stringify({
      ts: new Date().toISOString(),
      stream: "stdout",
      chunk: `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: evidence },
      })}\n`,
    })}\n`, "utf8");
  }

  await selectOrganization(page, organization.id);

  const chatApiResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/chats/${chat.id}/messages`
  ));
  const chatStartedAt = Date.now();
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
  const chatApiResponse = await chatApiResponsePromise;
  expect(chatApiResponse.ok()).toBe(true);
  const chatPayload = await chatApiResponse.json() as unknown[];
  expect(chatPayload).toHaveLength(CHAT_MESSAGE_COUNT);
  await expect(page.getByText(`Pressure chat message ${CHAT_MESSAGE_COUNT}.`, { exact: false })).toBeVisible({ timeout: 30_000 });
  const chatDomMessages = await page.locator("[data-message-id]").count();
  const chatReadyMs = Date.now() - chatStartedAt;
  await page.screenshot({ path: "/tmp/rudder-thread-pressure-chat.png" });

  const requestedLogRunIds: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    const match = pathname.match(/^\/api\/agent-runs\/([^/]+)\/log$/u);
    if (request.method() === "GET" && match?.[1]) {
      requestedLogRunIds.push(match[1]);
    }
  });

  const commentsResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/issues/${issue.identifier ?? issue.id}/comments`
  ));
  const runsResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/issues/${issue.identifier ?? issue.id}/runs`
  ));
  const issueStartedAt = Date.now();
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  const [commentsApiResponse, runsApiResponse] = await Promise.all([
    commentsResponsePromise,
    runsResponsePromise,
  ]);
  expect(commentsApiResponse.ok()).toBe(true);
  expect(runsApiResponse.ok()).toBe(true);
  expect(await commentsApiResponse.json()).toHaveLength(ISSUE_COMMENT_COUNT);
  expect(await runsApiResponse.json()).toHaveLength(TERMINAL_RUN_COUNT + ACTIVE_RUN_COUNT);
  await expect(page.locator("[data-run-id]")).toHaveCount(TERMINAL_RUN_COUNT, { timeout: 30_000 });
  await expect(page.getByText(`Pressure issue comment ${ISSUE_COMMENT_COUNT}.`, { exact: false })).toBeVisible({ timeout: 30_000 });
  const issueReadyMs = Date.now() - issueStartedAt;
  await page.waitForTimeout(2_500);

  const terminalRunIdSet = new Set(terminalRunIds);
  expect(requestedLogRunIds.filter((runId) => terminalRunIdSet.has(runId))).toEqual([]);
  const activeRunIdSet = new Set(activeRunIds);
  expect(new Set(requestedLogRunIds)).toEqual(activeRunIdSet);

  const activeIncrementalEvidence = "ACTIVE_RUN_INCREMENTAL_EVIDENCE";
  const activeLogRef = logRefByRunId.get(activeRunIds[0]!);
  expect(activeLogRef).toBeTruthy();
  await fs.appendFile(
    path.join(E2E_INSTANCE_ROOT, "data", "run-logs", activeLogRef!),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      stream: "stdout",
      chunk: `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: activeIncrementalEvidence },
      })}\n`,
    })}\n`,
    "utf8",
  );
  await expect(page.getByText(activeIncrementalEvidence, { exact: false })).toBeVisible({ timeout: 10_000 });

  const expandedTerminalRunId = terminalRunIds[0]!;
  const terminalLogRequest = page.waitForRequest((request) => (
    request.method() === "GET"
    && new URL(request.url()).pathname === `/api/agent-runs/${expandedTerminalRunId}/log`
  ));
  const terminalRow = page.locator(`[data-run-id="${expandedTerminalRunId}"]`);
  await terminalRow.getByRole("button", { name: "Show details" }).click();
  await terminalLogRequest;
  await expect(terminalRow.getByText(terminalEvidence, { exact: false })).toBeVisible({ timeout: 10_000 });
  expect(new Set(
    requestedLogRunIds.filter((runId) => terminalRunIdSet.has(runId)),
  )).toEqual(new Set([expandedTerminalRunId]));

  await terminalRow.getByRole("button", { name: "Hide details" }).click();
  await expect(terminalRow.getByRole("button", { name: "Show details" })).toBeVisible();
  await page.waitForTimeout(100);
  const terminalLogRequestAfterReopen = page.waitForRequest((request) => (
    request.method() === "GET"
    && new URL(request.url()).pathname === `/api/agent-runs/${expandedTerminalRunId}/log`
  ));
  await terminalRow.getByRole("button", { name: "Show details" }).click();
  await terminalLogRequestAfterReopen;
  await expect(terminalRow.getByText(terminalEvidence, { exact: false })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "/tmp/rudder-thread-pressure-issue.png" });

  const browserMetrics = {
    chat: {
      apiRows: chatPayload.length,
      domMessages: chatDomMessages,
      readyMs: chatReadyMs,
    },
    issue: {
      comments: ISSUE_COMMENT_COUNT,
      terminalRuns: TERMINAL_RUN_COUNT,
      activeRuns: ACTIVE_RUN_COUNT,
      timelineRunRows: await page.locator("[data-run-id]").count(),
      readyMs: issueReadyMs,
      uniqueLogRequestsBeforeExpansion: [...new Set(requestedLogRunIds.filter((id) => id !== expandedTerminalRunId))].length,
      terminalLogRequestsAfterExpansion: requestedLogRunIds.filter((id) => terminalRunIdSet.has(id)),
    },
  };
  await testInfo.attach("thread-pressure-browser-metrics", {
    body: Buffer.from(JSON.stringify(browserMetrics, null, 2)),
    contentType: "application/json",
  });
  console.log(`THREAD_PRESSURE_METRICS ${JSON.stringify(browserMetrics)}`);
});
