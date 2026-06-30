import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { agents, chatConversations, chatMessages, createDb } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

async function expectMessageInScrollViewport(page: import("@playwright/test").Page, messageId: string) {
  await expect.poll(() => page.evaluate((targetMessageId) => {
    const scrollRegion = document.querySelector<HTMLElement>('[data-testid="chat-messages-scroll-region"]');
    const message = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === targetMessageId);
    if (!scrollRegion || !message) return false;

    const containerBox = scrollRegion.getBoundingClientRect();
    const messageBox = message.getBoundingClientRect();
    return messageBox.bottom > containerBox.top && messageBox.top < containerBox.bottom;
  }, messageId), { timeout: 5_000 }).toBe(true);
}

test.describe("Chat message scroll map", () => {
  test("shows a hover preview and jumps within long conversations", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Scroll-Map-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agentId = randomUUID();
    await e2eDb.insert(agents).values({
      id: agentId,
      orgId: organization.id,
      name: "Navigator",
      role: "engineer",
      icon: "notionists-neutral",
      status: "idle",
    });

    const chatId = randomUUID();
    const baseTime = Date.parse("2026-06-29T09:00:00.000Z");
    const messages = Array.from({ length: 12 }, (_, index) => {
      const createdAt = new Date(baseTime + index * 60_000);
      const messageNumber = index + 1;
      const isUserMessage = index % 2 === 0;
      return {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chatId,
        role: isUserMessage ? "user" as const : "assistant" as const,
        kind: "message" as const,
        status: "completed" as const,
        body: `Checkpoint ${messageNumber}: ${isUserMessage ? "operator context" : "assistant progress"} for navigating a long conversation. ${"Detailed context. ".repeat(20)}`,
        structuredPayload: null,
        replyingAgentId: isUserMessage ? null : agentId,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt,
        updatedAt: createdAt,
      };
    });
    await e2eDb.insert(chatConversations).values({
      id: chatId,
      orgId: organization.id,
      title: "Scroll map chat",
      preferredAgentId: agentId,
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: "local-board",
      lastMessageAt: messages.at(-1)?.createdAt ?? new Date(baseTime),
      createdAt: new Date(baseTime),
      updatedAt: messages.at(-1)?.updatedAt ?? new Date(baseTime),
    });
    await e2eDb.insert(chatMessages).values(messages);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chatId}`);

    const scrollMap = page.getByTestId("chat-scroll-map");
    await expect(scrollMap).toBeVisible({ timeout: 15_000 });
    await expect(scrollMap.locator("[data-testid^='chat-scroll-map-marker-']")).toHaveCount(6);
    const compactRailGeometry = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('[data-testid="chat-scroll-map"]');
      const visibleUserBubble = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chat-user-message-bubble"]'))
        .find((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.bottom > 0 && bounds.top < window.innerHeight;
        });
      if (!rail || !visibleUserBubble) return null;
      const railBounds = rail.getBoundingClientRect();
      const userBubbleBounds = visibleUserBubble.getBoundingClientRect();
      return {
        railWidth: railBounds.width,
        railHeight: railBounds.height,
        railToUserBubbleGap: userBubbleBounds.left - railBounds.right,
      };
    });
    expect(compactRailGeometry).not.toBeNull();
    expect(compactRailGeometry?.railWidth).toBeLessThanOrEqual(20);
    expect(compactRailGeometry?.railHeight).toBeLessThanOrEqual(100);
    expect(compactRailGeometry?.railToUserBubbleGap).toBeGreaterThanOrEqual(4);
    expect(compactRailGeometry?.railToUserBubbleGap).toBeLessThanOrEqual(16);

    const targetMessage = messages[10];
    const targetMarker = page.getByTestId(`chat-scroll-map-marker-${targetMessage.id}`);
    await targetMarker.hover();
    const preview = page.getByTestId("chat-scroll-map-preview");
    await expect(preview).toContainText("Checkpoint 11");
    await expect(preview).not.toContainText("Message map");
    const floatingPreviewGeometry = await page.evaluate((targetMessageId) => {
      const marker = document.querySelector<HTMLElement>(`[data-testid="chat-scroll-map-marker-${targetMessageId}"]`);
      const previewCard = document.querySelector<HTMLElement>('[data-testid="chat-scroll-map-preview"]');
      const targetMessage = document.querySelector<HTMLElement>(`[data-message-id="${targetMessageId}"]`);
      const targetMessageContent = targetMessage?.querySelector<HTMLElement>('[data-testid="chat-user-message-bubble"]') ?? targetMessage;
      if (!marker || !previewCard || !targetMessageContent) return null;
      const targetMessageBounds = targetMessageContent.getBoundingClientRect();
      const visibleTargetBounds = targetMessageBounds.bottom > 0 && targetMessageBounds.top < window.innerHeight
        ? targetMessageBounds
        : Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chat-user-message-bubble"], [data-testid="chat-assistant-message"]'))
        .find((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.bottom > 0 && bounds.top < window.innerHeight;
        })
          ?.getBoundingClientRect();
      if (!visibleTargetBounds) return null;
      const markerBounds = marker.getBoundingClientRect();
      const previewBounds = previewCard.getBoundingClientRect();
      return {
        previewOffsetFromMarker: previewBounds.left - markerBounds.right,
        previewWidth: previewBounds.width,
        previewVisibleTop: previewBounds.top >= 0,
        previewVisibleBottom: previewBounds.bottom <= window.innerHeight,
        previewAvoidsVisibleMessage: previewBounds.bottom <= visibleTargetBounds.top - 8 || previewBounds.top >= visibleTargetBounds.bottom + 8,
      };
    }, targetMessage.id);
    expect(floatingPreviewGeometry).not.toBeNull();
    expect(floatingPreviewGeometry?.previewOffsetFromMarker).toBeGreaterThanOrEqual(4);
    expect(floatingPreviewGeometry?.previewOffsetFromMarker).toBeLessThanOrEqual(12);
    expect(floatingPreviewGeometry?.previewWidth).toBeGreaterThanOrEqual(440);
    expect(floatingPreviewGeometry?.previewVisibleTop).toBe(true);
    expect(floatingPreviewGeometry?.previewVisibleBottom).toBe(true);
    expect(floatingPreviewGeometry?.previewAvoidsVisibleMessage).toBe(true);
    await page.screenshot({ path: "/tmp/rudder-chat-scroll-map-preview.png", fullPage: true });

    await targetMarker.click();
    await expect(page.locator(`[data-message-id="${targetMessage.id}"]`)).toHaveClass(/chat-message-jump-highlight/);
    await expectMessageInScrollViewport(page, targetMessage.id);
    await expect(scrollMap).toBeVisible();
    await page.screenshot({ path: "/tmp/rudder-chat-scroll-map-jump.png", fullPage: true });
  });
});
