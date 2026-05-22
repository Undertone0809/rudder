import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_ERROR_STUB, E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const ORG_NAME = `Err-Chat-${Date.now()}`;
const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Chat error toasts", () => {
  test("shows the real runtime error instead of a Node stack frame", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: ORG_NAME,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Error Agent",
      command: E2E_CODEX_ERROR_STUB,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat?agentId=${chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Why did this fail?");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Failed to send message")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("Missing optional dependency @openai/codex-darwin-arm64", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("file:///stub/codex.js:100")).toHaveCount(0);
  });

  test("lets the operator retry a failed assistant reply", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Retry-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Retry Agent",
      command: E2E_CODEX_STUB,
    });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Failed reply retry",
        preferredAgentId: chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    const chatTurnId = randomUUID();
    await e2eDb.insert(chatMessages).values([
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Please retry this failed request",
        structuredPayload: null,
        replyingAgentId: null,
        chatTurnId,
        turnVariant: 0,
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chat.id,
        role: "assistant",
        kind: "message",
        status: "failed",
        body: "Something went wrong. Unexpected token '<' is not valid JSON.",
        structuredPayload: null,
        replyingAgentId: chatAgent.id,
        chatTurnId,
        turnVariant: 0,
      },
    ]);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const failedMessage = page.getByTestId("chat-assistant-message")
      .filter({ hasText: "Something went wrong" });
    await expect(failedMessage).toBeVisible({ timeout: 15_000 });
    await expect(failedMessage.getByRole("button", { name: "Retry" })).toBeVisible();

    await failedMessage.getByRole("button", { name: "Retry" }).click();

    await expect(page.getByTestId("chat-user-message-bubble").filter({
      hasText: "Please retry this failed request",
    })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
      timeout: 15_000,
    });
    await expect(failedMessage).toHaveCount(0);
  });
});
