import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  chatConversations,
  chatMessages,
  createDb,
  heartbeatRuns,
} from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test.describe("Agent detail chat run context", () => {
  test("shows the source conversation action and aggregated chat replies", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Agent-Chat-Run-Context-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Jordan",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };
    const secondAgentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Taylor",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(secondAgentRes.ok()).toBe(true);
    const secondAgent = await secondAgentRes.json() as { id: string };

    const conversationId = randomUUID();
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const firstTurnId = randomUUID();
    const secondTurnId = randomUUID();
    const userMessageId = randomUUID();

    await e2eDb.insert(chatConversations).values({
      id: conversationId,
      orgId: organization.id,
      title: "Skill inventory request",
      issueCreationMode: "manual_approval",
      planMode: false,
      preferredAgentId: agent.id,
      lastMessageAt: new Date("2026-06-17T10:07:00.000Z"),
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:07:00.000Z"),
    });

    await e2eDb.insert(heartbeatRuns).values([
      {
        id: firstRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "chat",
        triggerDetail: "chat_assistant_reply",
        status: "succeeded",
        startedAt: new Date("2026-06-17T10:00:30.000Z"),
        finishedAt: new Date("2026-06-17T10:01:30.000Z"),
        chatConversationId: conversationId,
        contextSnapshot: {
          scene: "chat",
          conversationId,
          userMessageId,
          chatTurnId: firstTurnId,
        },
        resultJson: { summary: "Listed enabled skills" },
        createdAt: new Date("2026-06-17T10:00:30.000Z"),
        updatedAt: new Date("2026-06-17T10:01:30.000Z"),
      },
      {
        id: secondRunId,
        orgId: organization.id,
        agentId: secondAgent.id,
        invocationSource: "chat",
        triggerDetail: "chat_assistant_reply",
        status: "succeeded",
        startedAt: new Date("2026-06-17T10:06:00.000Z"),
        finishedAt: new Date("2026-06-17T10:07:00.000Z"),
        chatConversationId: conversationId,
        contextSnapshot: {
          scene: "chat",
          conversationId,
          chatTurnId: secondTurnId,
        },
        resultJson: { summary: "Grouped skills by source" },
        createdAt: new Date("2026-06-17T10:06:00.000Z"),
        updatedAt: new Date("2026-06-17T10:07:00.000Z"),
      },
    ]);

    await e2eDb.insert(chatMessages).values([
      {
        id: userMessageId,
        orgId: organization.id,
        conversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Please list all enabled skills.",
        chatTurnId: firstTurnId,
        turnVariant: 0,
        createdAt: new Date("2026-06-17T10:00:00.000Z"),
        updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Here is the full list of enabled skills.",
        runId: firstRunId,
        replyingAgentId: agent.id,
        chatTurnId: firstTurnId,
        turnVariant: 0,
        createdAt: new Date("2026-06-17T10:01:00.000Z"),
        updatedAt: new Date("2026-06-17T10:01:00.000Z"),
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Group them by source.",
        chatTurnId: secondTurnId,
        turnVariant: 0,
        createdAt: new Date("2026-06-17T10:05:00.000Z"),
        updatedAt: new Date("2026-06-17T10:05:00.000Z"),
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Grouped by source across bundled, user, and project skills.",
        runId: secondRunId,
        replyingAgentId: secondAgent.id,
        chatTurnId: secondTurnId,
        turnVariant: 0,
        createdAt: new Date("2026-06-17T10:06:30.000Z"),
        updatedAt: new Date("2026-06-17T10:06:30.000Z"),
      },
    ]);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${firstRunId}`, { waitUntil: "domcontentloaded" });

    const card = page.getByTestId("run-chat-context-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByRole("link", { name: "Open conversation" })).toBeVisible();
    await expect(card.getByText("Here is the full list of enabled skills.").first()).toBeVisible();
    await expect(card.getByText("Grouped by source across bundled, user, and project skills.")).toBeVisible();
    await expect(card.getByText("Conversation replies")).toHaveCount(0);
    await expect(card.getByText("Skill inventory request")).toHaveCount(0);
    await expect(card.getByText("Please list all enabled skills.")).toHaveCount(0);
    await expect(card.getByText("User input")).toHaveCount(0);
    await expect(card.getByText("This reply")).toHaveCount(0);

    await expect(card.getByRole("link", { name: "Open conversation" })).toHaveAttribute(
      "href",
      new RegExp(`/messenger/chat/${conversationId}$`),
    );
    await card.getByRole("link", { name: /Reply 2/ }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${secondAgent.id}/runs/${secondRunId}$`));
  });
});
