import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Chat requirements review prompt", () => {
  test("appears after more than five user messages and drafts a clarification request", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Requirements-Review-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Requirements Agent",
      command: E2E_CODEX_STUB,
    });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Requirements review chat",
        preferredAgentId: chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    const baseTime = Date.parse("2026-06-29T09:00:00.000Z");
    await e2eDb.insert(chatMessages).values(
      Array.from({ length: 6 }, (_, index) => {
        const createdAt = new Date(baseTime + index * 60_000);
        return {
          id: randomUUID(),
          orgId: organization.id,
          conversationId: chat.id,
          role: "user" as const,
          kind: "message" as const,
          status: "completed" as const,
          body: `Requirement note ${index + 1}`,
          structuredPayload: null,
          replyingAgentId: null,
          chatTurnId: randomUUID(),
          turnVariant: 0,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const reviewPrompt = page.getByTestId("chat-requirements-review-prompt");
    await expect(reviewPrompt).toBeVisible({ timeout: 15_000 });
    await expect(reviewPrompt).toContainText("Clarify requirements");
    await expect(reviewPrompt).toContainText("6 user notes");
    await page.screenshot({ path: "/tmp/rudder-chat-requirements-review-prompt.png", fullPage: true });

    await page.getByTestId("chat-requirements-review-action").click();
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toContainText("organize my requirements");
    await expect(composer).toContainText("open questions");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await page.screenshot({ path: "/tmp/rudder-chat-requirements-review-draft.png", fullPage: true });
  });
});
