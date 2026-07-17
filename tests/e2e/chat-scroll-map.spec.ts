import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { agents, chatConversations, chatMessages, createDb } from "../../packages/db/src/index.ts";
import { buildAgentMentionHref, buildIssueMentionHref } from "../../packages/shared/src/index.ts";
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
    await page.setViewportSize({ width: 1600, height: 820 });

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
      const tokenUserBody = `Checkpoint ${messageNumber}: ask [Navigator](${buildAgentMentionHref(agentId, "notionists-neutral")}) to review \`verification\` and [ZST-789](${buildIssueMentionHref("issue-789", "ZST-789", null, "in_progress")}). ${"Detailed context. ".repeat(20)}`;
      return {
        id: randomUUID(),
        orgId: organization.id,
        conversationId: chatId,
        role: isUserMessage ? "user" as const : "assistant" as const,
        kind: "message" as const,
        status: "completed" as const,
        body: messageNumber === 11 && isUserMessage
          ? tokenUserBody
          : `Checkpoint ${messageNumber}: ${isUserMessage ? "operator context" : "assistant progress"} for navigating a long conversation. ${"Detailed context. ".repeat(20)}`,
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
      const scrollRegion = document.querySelector<HTMLElement>('[data-testid="chat-messages-scroll-region"]');
      const visibleUserBubble = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chat-user-message-bubble"]'))
        .find((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.bottom > 0 && bounds.top < window.innerHeight;
        });
      if (!rail || !scrollRegion || !visibleUserBubble) return null;
      const railBounds = rail.getBoundingClientRect();
      const scrollRegionBounds = scrollRegion.getBoundingClientRect();
      const userBubbleBounds = visibleUserBubble.getBoundingClientRect();
      return {
        railWidth: railBounds.width,
        railHeight: railBounds.height,
        railLeftOffset: railBounds.left - scrollRegionBounds.left,
        railToUserBubbleGap: userBubbleBounds.left - railBounds.right,
      };
    });
    expect(compactRailGeometry).not.toBeNull();
    expect(compactRailGeometry?.railWidth).toBeLessThanOrEqual(20);
    expect(compactRailGeometry?.railHeight).toBeLessThanOrEqual(100);
    expect(compactRailGeometry?.railLeftOffset).toBeGreaterThanOrEqual(-1);
    expect(compactRailGeometry?.railLeftOffset).toBeLessThanOrEqual(1);
    expect(compactRailGeometry?.railToUserBubbleGap).toBeGreaterThan(80);

    const targetMessage = messages[10];
    const targetMarker = page.getByTestId(`chat-scroll-map-marker-${targetMessage.id}`);
    await targetMarker.hover();
    const preview = page.getByTestId("chat-scroll-map-preview");
    await expect(preview).toContainText("Checkpoint 11");
    await expect(preview).toContainText("Navigator");
    await expect(preview).toContainText("verification");
    await expect(preview).toContainText("assistant progress");
    await expect(preview).not.toContainText("Message map");
    await expect(preview).not.toContainText("agent://");
    await expect(preview).not.toContainText("issue://");
    const floatingPreviewGeometry = await page.evaluate((targetMessageId) => {
      const marker = document.querySelector<HTMLElement>(`[data-testid="chat-scroll-map-marker-${targetMessageId}"]`);
      const previewCard = document.querySelector<HTMLElement>('[data-testid="chat-scroll-map-preview"]');
      const previewTitle = previewCard?.querySelector<HTMLElement>(".chat-scroll-map-preview-title");
      const previewSummary = previewCard?.querySelector<HTMLElement>(".chat-scroll-map-preview-summary");
      const previewTitleText = previewTitle?.querySelector<HTMLElement>("p") ?? previewTitle;
      const previewSummaryText = previewSummary?.querySelector<HTMLElement>("p") ?? previewSummary;
      const agentMention = previewCard?.querySelector<HTMLElement>('[data-mention-kind="agent"]');
      const issueMention = previewCard?.querySelector<HTMLElement>('[data-mention-kind="issue"]');
      if (!marker || !previewCard || !previewTitleText || !previewSummaryText) return null;
      const markerBounds = marker.getBoundingClientRect();
      const previewBounds = previewCard.getBoundingClientRect();
      const style = window.getComputedStyle(previewCard);
      const titleStyle = window.getComputedStyle(previewTitleText);
      const summaryStyle = window.getComputedStyle(previewSummaryText);
      type RgbaColor = [number, number, number, number];
      const parseColor = (value: string): RgbaColor | null => {
        const channels = value.match(/[\d.]+/gu)?.map(Number) ?? [];
        if (channels.length < 3) return null;
        return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
      };
      const compositeColor = (foreground: RgbaColor, background: RgbaColor): RgbaColor => {
        const alpha = foreground[3] + background[3] * (1 - foreground[3]);
        if (alpha === 0) return [0, 0, 0, 0];
        return [
          (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
          (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
          (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
          alpha,
        ];
      };
      const luminance = (channels: RgbaColor) => {
        const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      };
      const contrastRatio = (foreground: string, background: string) => {
        const foregroundChannels = parseColor(foreground);
        const backgroundChannels = parseColor(background);
        if (!foregroundChannels || !backgroundChannels) return 0;
        const canvas: RgbaColor = [255, 255, 255, 1];
        const resolvedBackground = compositeColor(backgroundChannels, canvas);
        const resolvedForeground = compositeColor(foregroundChannels, resolvedBackground);
        const lighter = Math.max(luminance(resolvedForeground), luminance(resolvedBackground));
        const darker = Math.min(luminance(resolvedForeground), luminance(resolvedBackground));
        return (lighter + 0.05) / (darker + 0.05);
      };
      return {
        previewOffsetFromMarker: previewBounds.left - markerBounds.right,
        previewWidth: previewBounds.width,
        previewRadius: style.borderRadius,
        previewBackground: style.backgroundColor,
        previewTitleColor: titleStyle.color,
        previewSummaryColor: summaryStyle.color,
        previewTitleContrast: contrastRatio(titleStyle.color, style.backgroundColor),
        previewSummaryContrast: contrastRatio(summaryStyle.color, style.backgroundColor),
        previewVisibleTop: previewBounds.top >= 0,
        previewVisibleBottom: previewBounds.bottom <= window.innerHeight,
        hasAgentMention: Boolean(agentMention),
        hasIssueMention: Boolean(issueMention),
      };
    }, targetMessage.id);
    expect(floatingPreviewGeometry).not.toBeNull();
    expect(floatingPreviewGeometry?.previewOffsetFromMarker).toBeGreaterThanOrEqual(4);
    expect(floatingPreviewGeometry?.previewOffsetFromMarker).toBeLessThanOrEqual(12);
    expect(floatingPreviewGeometry?.previewWidth).toBeGreaterThanOrEqual(620);
    expect(floatingPreviewGeometry?.previewRadius).toBe("18px");
    expect(floatingPreviewGeometry?.previewBackground).toBe("rgba(42, 42, 42, 0.94)");
    expect(floatingPreviewGeometry?.previewTitleColor).toBe("rgba(255, 255, 255, 0.96)");
    expect(floatingPreviewGeometry?.previewSummaryColor).toBe("rgba(255, 255, 255, 0.68)");
    expect(floatingPreviewGeometry?.previewTitleContrast).toBeGreaterThanOrEqual(4.5);
    expect(floatingPreviewGeometry?.previewSummaryContrast).toBeGreaterThanOrEqual(4.5);
    expect(floatingPreviewGeometry?.previewVisibleTop).toBe(true);
    expect(floatingPreviewGeometry?.previewVisibleBottom).toBe(true);
    expect(floatingPreviewGeometry?.hasAgentMention).toBe(true);
    expect(floatingPreviewGeometry?.hasIssueMention).toBe(true);
    await page.screenshot({ path: "/tmp/rudder-chat-scroll-map-preview.png", fullPage: true });

    await targetMarker.click();
    const targetMessageRow = page.locator(`[data-message-id="${targetMessage.id}"]`);
    await expect(targetMessageRow).not.toHaveClass(/chat-message-jump-highlight/);
    await expect(targetMessageRow.getByTestId("chat-user-message-bubble")).toHaveClass(/chat-message-jump-highlight/);
    const jumpHighlightStyle = await page.evaluate((targetMessageId) => {
      const bubble = document
        .querySelector<HTMLElement>(`[data-message-id="${targetMessageId}"] [data-testid="chat-user-message-bubble"]`);
      if (!bubble) return null;
      const style = window.getComputedStyle(bubble);
      const pseudo = window.getComputedStyle(bubble, "::before");
      return {
        backgroundColor: style.backgroundColor,
        borderStyle: style.borderStyle,
        borderWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
        pseudoContent: pseudo.content,
      };
    }, targetMessage.id);
    expect(jumpHighlightStyle).not.toBeNull();
    expect(jumpHighlightStyle?.borderStyle).toBe("solid");
    expect(jumpHighlightStyle?.borderWidth).toBe("1px");
    expect(jumpHighlightStyle?.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(jumpHighlightStyle?.boxShadow).not.toBe("none");
    expect(jumpHighlightStyle?.pseudoContent).toBe("none");
    await expectMessageInScrollViewport(page, targetMessage.id);
    await expect(scrollMap).toBeVisible();
    await page.screenshot({ path: "/tmp/rudder-chat-scroll-map-jump.png", fullPage: true });

    await page.setViewportSize({ width: 920, height: 820 });
    await expect.poll(() => page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('[data-testid="chat-scroll-map"]');
      if (!rail) return "missing";
      return window.getComputedStyle(rail).visibility;
    }), { timeout: 5_000 }).toBe("hidden");
    await page.screenshot({ path: "/tmp/rudder-chat-scroll-map-responsive-hidden.png", fullPage: true });
  });
});
