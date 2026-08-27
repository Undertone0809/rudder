import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Chat transcript internal instructions", () => {
  test("hides runtime-loaded user-role instruction blocks while keeping agent response visible", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Transcript-Instruction-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Transcript Agent",
      command: E2E_CODEX_STUB,
    });
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Internal instruction transcript proof",
        preferredAgentId: chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();
    const chatTurnId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();

    await e2eDb.insert(chatMessages).values([
      {
        id: userMessageId,
        orgId: organization.id,
        conversationId: chat.id,
        role: "user",
        kind: "message",
        status: "completed",
        body: "What skills do you have?",
        structuredPayload: null,
        chatTurnId,
        turnVariant: 0,
        createdAt: new Date("2026-06-17T08:00:00.000Z"),
        updatedAt: new Date("2026-06-17T08:00:00.000Z"),
      },
      {
        id: assistantMessageId,
        orgId: organization.id,
        conversationId: chat.id,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Got it. What would you like to work on next?",
        structuredPayload: {
          __chatTranscript: [
            {
              kind: "system",
              ts: "2026-06-17T08:00:00.000Z",
              text: "turn started",
            },
            {
              kind: "user",
              ts: "2026-06-17T08:00:01.000Z",
              text: [
                "<rudder_agent_operating_contract>",
                "",
                "Your home directory is $AGENT_HOME. Everything personal to you lives there.",
                "",
                "Use these paths consistently:",
                "- Personal instructions live under $AGENT_HOME/instructions.",
                "</rudder_agent_operating_contract>",
              ].join("\n"),
            },
            {
              kind: "assistant",
              ts: "2026-06-17T08:00:02.000Z",
              text: "I can use coding, debugging, Rudder operations, memory workflows, and skill-authoring workflows.",
            },
            {
              kind: "user",
              ts: "2026-06-17T08:00:03.000Z",
              text: [
                "Following communication protocol",
                "",
                "I need to respond following the Rudder protocol by delivering a progress update, a special marker, and then JSON.",
              ].join("\n"),
            },
            {
              kind: "assistant",
              ts: "2026-06-17T08:00:04.000Z",
              text: "Got it. What would you like to work on next?",
            },
          ],
        },
        replyingAgentId: chatAgent.id,
        chatTurnId,
        turnVariant: 0,
        createdAt: new Date("2026-06-17T08:00:01.000Z"),
        updatedAt: new Date("2026-06-17T08:00:01.000Z"),
      },
    ]);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    const lazyTranscriptResponse = page.waitForResponse((response) =>
      response.request().method() === "GET"
      && response.url().includes(`/api/chats/${chat.id}/messages/${assistantMessageId}/transcript`),
    );
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    await expect(page.getByTestId("chat-user-message-bubble").last()).toContainText("What skills do you have?", { timeout: 15_000 });
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Got it. What would you like to work on next?", { timeout: 15_000 });

    await page.getByRole("button", { name: /Worked for/ }).last().click();
    const transcriptPayload = await (await lazyTranscriptResponse).json();
    expect(transcriptPayload.transcript).toHaveLength(5);

    const transcriptItem = page.getByTestId("chat-transcript-item").last();
    await expect(transcriptItem.getByText("I can use coding, debugging, Rudder operations", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(transcriptItem.getByText("Rudder Agent Operating Contract", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.getByText("Following communication protocol", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.getByText("Use these paths consistently", { exact: false })).toHaveCount(0);
    await expect(transcriptItem.getByText("User", { exact: true })).toHaveCount(0);
    await expect(transcriptItem.getByText("Got it. What would you like to work on next?", { exact: false })).toHaveCount(0);
  });
});
