import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Chat agent attribution navigation", () => {
  test("keeps the bound agent identity on an un-attributed response projection", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Chat-Agent-Link-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Avatar Link Agent",
      icon: "dicebear:notionists:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Agent attribution link chat",
        preferredAgentId: chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Verify the queued response identity." },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    const completedAt = new Date();
    const projectionAt = new Date(completedAt.getTime() + 1);
    await e2eDb.insert(chatMessages).values([
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Click the avatar to inspect the agent.",
        structuredPayload: null,
        replyingAgentId: chatAgent.id,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt: completedAt,
        updatedAt: completedAt,
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Queued response projection.",
        structuredPayload: null,
        replyingAgentId: null,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt: projectionAt,
        updatedAt: projectionAt,
      },
    ]);

    await page.addInitScript((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`, { waitUntil: "domcontentloaded" });

    const assistantMessage = page.getByTestId("chat-assistant-message").filter({ hasText: "Queued response projection." });
    await expect(assistantMessage).toContainText("Avatar Link Agent", { timeout: 15_000 });

    const attributionLink = assistantMessage.getByRole("link", { name: "Open Avatar Link Agent agent detail" });
    await expect(attributionLink).toHaveAttribute(
      "href",
      new RegExp(`/${organization.urlKey}/agents/${chatAgent.urlKey ?? "avatar-link-agent"}$`),
    );
    await page.screenshot({
      path: `${process.env.RUDDER_RUNTIME_TMPDIR ?? "/tmp"}/rudder-chat-queue-agent-identity.png`,
      fullPage: false,
    });
    await attributionLink.locator("img").click();

    await expect(page).toHaveURL(
      new RegExp(`/${organization.urlKey}/agents/${chatAgent.urlKey ?? "avatar-link-agent"}(?:/dashboard)?$`),
      { timeout: 15_000 },
    );
    await expect(page.getByRole("heading", { name: "Avatar Link Agent" })).toBeVisible({ timeout: 15_000 });
  });
});
