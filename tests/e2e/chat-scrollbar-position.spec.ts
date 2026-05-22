import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";
import { createE2EChatAgent } from "./support/chat-agent";

const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Chat scrollbar position", () => {
  test("keeps long composer drafts inside the editor scroll region on desktop and narrow screens", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Composer-Scroll-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Composer Scroll Agent",
    });
    const longDraft = Array.from(
      { length: 42 },
      (_, index) => `Composer draft line ${index + 1} should remain inside the editor scroll region.`,
    ).join("\n");

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    for (const viewport of [
      { width: 1280, height: 760 },
      { width: 390, height: 740 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`/chat?agentId=${chatAgent.id}`);

      const editor = page.locator(".rudder-mdxeditor-content").first();
      const editorScrollRegion = page.getByTestId("chat-composer-editor-scroll");
      const toolbar = page.getByTestId("chat-composer-toolbar");

      await expect(editor).toBeVisible({ timeout: 15_000 });
      await expect(toolbar).toBeVisible();
      await editor.fill(longDraft);

      const metrics = await editorScrollRegion.evaluate((node) => {
        const regionBox = node.getBoundingClientRect();
        const toolbar = document.querySelector('[data-testid="chat-composer-toolbar"]');
        const toolbarBox = toolbar?.getBoundingClientRect();
        return {
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
          regionBottom: regionBox.bottom,
          toolbarTop: toolbarBox?.top ?? 0,
          toolbarBottom: toolbarBox?.bottom ?? 0,
          viewportHeight: window.innerHeight,
        };
      });

      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 24);
      expect(metrics.toolbarTop).toBeGreaterThanOrEqual(metrics.regionBottom - 1);
      expect(metrics.toolbarBottom).toBeLessThanOrEqual(metrics.viewportHeight);
      await expect(editorScrollRegion).toHaveClass(/scrollbar-auto-hide/);
    }
  });

  test("keeps the message scroll region flush with the main card edge on wide desktop shells", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1720, height: 1180 });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Scroll-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Scrollbar placement",
        summary: "Open the thread and keep the message scroller pinned to the main card edge.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat/${chat.id}`);

    const mainContent = page.locator("#main-content");
    const scrollRegion = page.getByTestId("chat-messages-scroll-region");
    const contentColumn = page.getByTestId("chat-messages-content");

    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`), { timeout: 15_000 });
    await expect(scrollRegion).toBeVisible();
    await expect(contentColumn).toBeVisible();

    const mainContentBox = await mainContent.boundingBox();
    const scrollRegionBox = await scrollRegion.boundingBox();
    const contentColumnBox = await contentColumn.boundingBox();

    expect(mainContentBox).not.toBeNull();
    expect(scrollRegionBox).not.toBeNull();
    expect(contentColumnBox).not.toBeNull();

    const scrollGapToMainEdge =
      mainContentBox!.x + mainContentBox!.width - (scrollRegionBox!.x + scrollRegionBox!.width);

    expect(scrollGapToMainEdge).toBeLessThanOrEqual(24);
    expect(scrollRegionBox!.width - contentColumnBox!.width).toBeGreaterThanOrEqual(160);

    await page.screenshot({
      path: testInfo.outputPath("chat-scrollbar-position.png"),
      fullPage: true,
    });
  });

  test("opens long chat conversations scrolled to the latest message", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Bottom-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Long chat opens at bottom",
        summary: "Regression coverage for initial chat scroll position.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();
    const now = Date.now();
    const latestBody = "Latest message is visible after opening this long chat.";

    await e2eDb.insert(chatMessages).values(
      Array.from({ length: 18 }, (_, index) => {
        const isLatest = index === 17;
        const createdAt = new Date(now + index * 1000);
        return {
          id: randomUUID(),
          orgId: organization.id,
          conversationId: chat.id,
          role: index % 2 === 0 ? "user" : "assistant",
          kind: "message",
          status: "completed",
          body: isLatest
            ? latestBody
            : `Historical chat message ${index + 1}. ${"This message adds vertical height. ".repeat(10)}`,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat/${chat.id}`);

    const scrollRegion = page.getByTestId("chat-messages-scroll-region");
    const messageContent = page.getByTestId("chat-messages-content");
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`), { timeout: 15_000 });
    await expect(scrollRegion).toBeVisible();
    await expect(messageContent.getByText(latestBody)).toBeVisible({ timeout: 15_000 });

    await expect.poll(async () => {
      return await scrollRegion.evaluate((node) =>
        Math.round(node.scrollHeight - node.scrollTop - node.clientHeight)
      );
    }).toBeLessThanOrEqual(4);
  });
});
