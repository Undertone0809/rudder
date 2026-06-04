import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

const AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAvElEQVR4nOXOMQEAIAzAsCqZTiTiisnIwZE/nbnvZ+mAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YCWDmjpgJYOaOmAlg5o6YC2eEHSLFdn2uQAAAAASUVORK5CYII=",
  "base64",
);

async function expectDirectImageAvatar(page: Page) {
  const assistantMessage = page.getByTestId("chat-assistant-message").last();
  await expect(assistantMessage).toContainText("Image avatar reply.", { timeout: 15_000 });

  const avatar = assistantMessage.locator('img[src*="/api/assets/"]').first();
  await expect(avatar).toBeVisible({ timeout: 15_000 });
  await expect(avatar).toHaveCSS("object-fit", "cover");

  const wrappedShell = avatar.locator(
    'xpath=ancestor::*[contains(@class, "border-border/70") or contains(@class, "bg-muted/90") or contains(@class, "shadow-sm")]',
  );
  await expect(wrappedShell).toHaveCount(0);

  const [avatarBox, messageBox] = await Promise.all([
    avatar.boundingBox(),
    assistantMessage.boundingBox(),
  ]);
  expect(avatarBox).not.toBeNull();
  expect(messageBox).not.toBeNull();
  expect(avatarBox!.width).toBeGreaterThanOrEqual(31);
  expect(avatarBox!.width).toBeLessThanOrEqual(33);
  expect(avatarBox!.height).toBeGreaterThanOrEqual(31);
  expect(avatarBox!.height).toBeLessThanOrEqual(33);
  expect(messageBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test.describe("Chat message layout", () => {
  test("keeps the user bubble compact and places message actions below it", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Layout-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Layout Agent",
      command: E2E_CODEX_STUB,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat?agentId=${chatAgent.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("你好");
    await page.getByRole("button", { name: "Send" }).click();

    const bubble = page.getByTestId("chat-user-message-bubble").filter({ hasText: "你好" }).last();
    await expect(bubble).toBeVisible({ timeout: 15_000 });
    await bubble.hover();

    const toolbar = page.getByTestId("chat-user-message-toolbar").last();
    await expect(toolbar).toBeVisible();
    await expect(toolbar).not.toContainText("ago");
    await expect(toolbar).toContainText(/[A-Z][a-z]{2} \d{1,2}, (?:\d{1,2}:\d{2} [AP]M|\d{1,2}:\d{2})/);

    const bubbleBox = await bubble.boundingBox();
    const toolbarBox = await toolbar.boundingBox();

    expect(bubbleBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    expect(bubbleBox!.width).toBeLessThan(160);
    expect(toolbarBox!.y).toBeGreaterThanOrEqual(bubbleBox!.y + bubbleBox!.height - 1);
  });

  test("renders uploaded agent image avatars directly in assistant message attribution", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Avatar-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Image Agent",
      command: E2E_CODEX_STUB,
    });

    const uploadRes = await page.request.post(`/api/agents/${chatAgent.id}/avatar`, {
      multipart: {
        file: {
          name: "avatar.png",
          mimeType: "image/png",
          buffer: AVATAR_PNG,
        },
      },
    });
    expect(uploadRes.ok()).toBe(true);

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Image avatar chat",
        preferredAgentId: chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Image avatar reply.",
      structuredPayload: null,
      replyingAgentId: chatAgent.id,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    await expectDirectImageAvatar(page);
    await page.screenshot({ path: "/tmp/rudder-chat-avatar-desktop.png", fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expectDirectImageAvatar(page);
    await page.screenshot({ path: "/tmp/rudder-chat-avatar-mobile.png", fullPage: true });
  });

  test("shows a hover copy button for Messenger code blocks", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 1280, height: 820 });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Code-Copy-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Code copy chat",
        summary: "Regression coverage for code-block copy controls.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: [
        "Run this command, not the inline `pnpm ignored` example.",
        "",
        "```sh",
        "pnpm --filter @rudderhq/ui typecheck",
        "```",
      ].join("\n"),
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("Run this command", { timeout: 15_000 });
    await expect(assistantMessage.locator("p code", { hasText: "pnpm ignored" })).toBeVisible();

    const codeBlock = assistantMessage.locator(".rudder-code-block-copy-wrap").first();
    const copyButton = codeBlock.locator(".rudder-code-block-copy-button");
    await expect(copyButton).toHaveCount(1);
    await expect(copyButton).toHaveCSS("opacity", "0");

    await codeBlock.hover();
    await expect(copyButton).toHaveCSS("opacity", "1");
    await expect(copyButton).toHaveAttribute("aria-label", "Copy code");
    await page.screenshot({ path: "/tmp/rudder-zst-131-code-copy-hover.png", fullPage: true });

    await copyButton.click();
    await expect(copyButton).toHaveAttribute("aria-label", "Copied");
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(
      "pnpm --filter @rudderhq/ui typecheck",
    );
  });

  test("collapses long assistant messages behind an expandable preview", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Long-Message-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Long message preview chat",
        summary: "Regression coverage for long message previews.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: Array.from(
        { length: 55 },
        (_, index) =>
          `Long response paragraph ${index + 1}. This line keeps the rendered chat message tall enough to require expansion.`,
      ).join("\n\n"),
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    const longBody = assistantMessage.getByTestId("chat-long-message-body").last();
    const toggle = assistantMessage.getByTestId("chat-long-message-toggle").last();

    await expect(assistantMessage).toContainText("Long response paragraph 1", { timeout: 15_000 });
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText("Show more");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    const collapsedHeight = await longBody.evaluate((node) => node.getBoundingClientRect().height);
    expect(collapsedHeight).toBeLessThanOrEqual(396);
    await page.screenshot({
      path: `/tmp/rudder-zst244-long-message-collapsed.png`,
      fullPage: true,
    });

    await toggle.click();

    await expect(toggle).toContainText("Show less");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => longBody.evaluate((node) => node.getBoundingClientRect().height))
      .toBeGreaterThan(collapsedHeight + 120);
  });
});
