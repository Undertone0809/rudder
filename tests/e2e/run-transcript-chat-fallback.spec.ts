import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  chatConversations,
  chatMessageTranscriptEntries,
  chatMessages,
  createDb,
  heartbeatRuns,
} from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("loads a persisted chat transcript when the run has no events or log", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Run-Transcript-Chat-Fallback-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Chat Transcript Fallback Tester",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const conversationId = randomUUID();
  const runId = randomUUID();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const now = new Date("2026-08-17T10:00:00.000Z");
  const transcriptText = "Persisted chat transcript fallback loaded.";

  await e2eDb.insert(chatConversations).values({
    id: conversationId,
    orgId: organization.id,
    title: "Transcript fallback check",
    preferredAgentId: agent.id,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await e2eDb.insert(heartbeatRuns).values({
    id: runId,
    orgId: organization.id,
    agentId: agent.id,
    invocationSource: "chat",
    triggerDetail: "chat_assistant_reply",
    status: "succeeded",
    startedAt: now,
    finishedAt: new Date(now.getTime() + 1_000),
    chatConversationId: conversationId,
    contextSnapshot: {
      scene: "chat",
      conversationId,
      assistantMessageId,
      messageId: userMessageId,
      userMessageId,
    },
    resultJson: { summary: transcriptText },
    createdAt: now,
    updatedAt: new Date(now.getTime() + 1_000),
  });
  await e2eDb.insert(chatMessages).values({
    id: userMessageId,
    orgId: organization.id,
    conversationId,
    role: "user",
    kind: "message",
    status: "completed",
    body: "Load the transcript for this run.",
    createdAt: now,
    updatedAt: now,
  });
  await e2eDb.insert(chatMessages).values({
    id: assistantMessageId,
    orgId: organization.id,
    conversationId,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: transcriptText,
    runId,
    replyingAgentId: agent.id,
    createdAt: new Date(now.getTime() + 1_000),
    updatedAt: new Date(now.getTime() + 1_000),
  });
  await e2eDb.insert(chatMessageTranscriptEntries).values({
    orgId: organization.id,
    messageId: assistantMessageId,
    entrySeq: 0,
    payload: {
      kind: "assistant",
      ts: new Date(now.getTime() + 1_000).toISOString(),
      text: transcriptText,
    },
  });

  await page.addInitScript((orgId: string) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  const transcriptUrl = `**/api/chats/${conversationId}/messages/${assistantMessageId}/transcript`;
  const eventsUrl = `**/api/agent-runs/${runId}/events**`;
  let fallbackRequestSeen = false;
  await page.route(eventsUrl, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.route(transcriptUrl, async (route) => {
    fallbackRequestSeen = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });

  await page.goto(`/agents/${agent.id}/runs/${runId}`, { waitUntil: "domcontentloaded" });

  const detail = page.getByTestId("agent-runs-detail-pane");
  await expect(detail.getByText("Loading run logs...", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(detail.getByText("No persisted transcript for this run.", { exact: true })).toHaveCount(0);
  await expect(detail.getByText(transcriptText, { exact: false })).toBeVisible({ timeout: 15_000 });
  expect(fallbackRequestSeen).toBe(true);
});
