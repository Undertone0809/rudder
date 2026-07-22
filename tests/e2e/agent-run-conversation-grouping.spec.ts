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

test.describe("Agent Run conversation grouping", () => {
  test("keeps one active rail row while switching among persisted Chat replies", async ({ page }) => {
    const orgResponse = await page.request.post("/api/orgs", {
      data: { name: `Agent-Run-Conversation-Grouping-${Date.now()}` },
    });
    expect(orgResponse.ok()).toBe(true);
    const organization = await orgResponse.json() as { id: string };

    const agentResponse = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Conversation Run Inspector",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(agentResponse.ok()).toBe(true);
    const agent = await agentResponse.json() as { id: string };

    const conversationId = randomUUID();
    const runIds = [randomUUID(), randomUUID(), randomUUID()];
    const turnIds = [randomUUID(), randomUUID(), randomUUID()];
    const userMessageIds = [randomUUID(), randomUUID(), randomUUID()];
    const unlinkedRunId = randomUUID();
    const baseTime = Date.parse("2026-07-21T08:00:00.000Z");

    await e2eDb.insert(chatConversations).values({
      id: conversationId,
      orgId: organization.id,
      title: "Conversation with three persisted replies",
      issueCreationMode: "manual_approval",
      planMode: false,
      preferredAgentId: agent.id,
      lastMessageAt: new Date(baseTime + 6 * 60_000),
      createdAt: new Date(baseTime),
      updatedAt: new Date(baseTime + 6 * 60_000),
    });

    await e2eDb.insert(heartbeatRuns).values([
      ...runIds.map((runId, index) => ({
        id: runId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "chat" as const,
        triggerDetail: "chat_assistant_reply",
        status: "succeeded" as const,
        startedAt: new Date(baseTime + (index * 2 + 1) * 60_000),
        finishedAt: new Date(baseTime + (index * 2 + 2) * 60_000),
        chatConversationId: conversationId,
        contextSnapshot: {
          scene: "chat",
          conversationId,
          userMessageId: userMessageIds[index],
          chatTurnId: turnIds[index],
        },
        resultJson: { summary: `Persisted conversation result ${index + 1}` },
        resultSummaryJson: { summary: `Persisted conversation result ${index + 1}` },
        createdAt: new Date(baseTime + (index * 2 + 1) * 60_000),
        updatedAt: new Date(baseTime + (index * 2 + 2) * 60_000),
      })),
      {
        id: unlinkedRunId,
        orgId: organization.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "succeeded",
        startedAt: new Date(baseTime - 2 * 60_000),
        finishedAt: new Date(baseTime - 60_000),
        resultJson: { summary: "Standalone inspection run" },
        resultSummaryJson: { summary: "Standalone inspection run" },
        createdAt: new Date(baseTime - 2 * 60_000),
        updatedAt: new Date(baseTime - 60_000),
      },
    ]);

    await e2eDb.insert(chatMessages).values(
      turnIds.flatMap((turnId, index) => {
        const userCreatedAt = new Date(baseTime + index * 2 * 60_000);
        const assistantCreatedAt = new Date(baseTime + (index * 2 + 2) * 60_000);
        return [
          {
            id: userMessageIds[index],
            orgId: organization.id,
            conversationId,
            role: "user" as const,
            kind: "message" as const,
            status: "completed" as const,
            body: `Conversation prompt ${index + 1}`,
            chatTurnId: turnId,
            turnVariant: 0,
            createdAt: userCreatedAt,
            updatedAt: userCreatedAt,
          },
          {
            id: randomUUID(),
            orgId: organization.id,
            conversationId,
            role: "assistant" as const,
            kind: "message" as const,
            status: "completed" as const,
            body: `Conversation reply ${index + 1}`,
            runId: runIds[index],
            replyingAgentId: agent.id,
            chatTurnId: turnId,
            turnVariant: 0,
            createdAt: assistantCreatedAt,
            updatedAt: assistantCreatedAt,
          },
        ];
      }),
    );

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    const latestRunId = runIds[2];
    await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("chat-actions-trigger").click();
    await page.getByRole("menuitem", { name: "View agent runs" }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}/runs/${latestRunId}$`));

    const rail = page.getByTestId("agent-runs-list-pane");
    const conversationRows = rail.getByTestId("agent-run-conversation-group-row");
    await expect(conversationRows).toHaveCount(1);
    await expect(conversationRows).toContainText("3 runs");
    await expect(conversationRows).toContainText("Persisted conversation result 3");
    await expect(conversationRows).toHaveAttribute("aria-current", "page");
    await expect(rail.getByRole("link")).toHaveCount(2);
    await expect(rail.getByText(unlinkedRunId.slice(0, 8), { exact: true })).toBeVisible();

    const detail = page.getByTestId("agent-runs-detail-pane");
    await expect(detail.getByRole("link", { name: /Reply 3 Current/ })).toBeVisible();
    await detail.getByRole("link", { name: /Reply 1/ }).click();

    await expect(page).toHaveURL(new RegExp(`/agents/[^/]+/runs/${runIds[0]}$`));
    await expect(detail.getByRole("link", { name: /Reply 1 Current/ })).toBeVisible();
    await expect(conversationRows).toHaveCount(1);
    await expect(conversationRows).toHaveAttribute("aria-current", "page");
    await expect(conversationRows).toContainText("Persisted conversation result 1");
    await expect(rail.getByRole("link")).toHaveCount(2);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/agents/${agent.id}/runs`, { waitUntil: "domcontentloaded" });

    const mobileRail = page.getByTestId("agent-runs-list-pane");
    await expect(mobileRail.getByTestId("agent-run-conversation-group-row")).toHaveCount(1);
    await expect(mobileRail.getByTestId("agent-run-conversation-group-row")).toContainText("3 runs");
    await expect(mobileRail.getByRole("link")).toHaveCount(2);
    await expect(mobileRail.getByText(unlinkedRunId.slice(0, 8), { exact: true })).toBeVisible();
  });
});
