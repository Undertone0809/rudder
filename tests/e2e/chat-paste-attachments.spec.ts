import { expect, test, type Page } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

test("pastes clipboard images and files into chat as pending attachments", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  const organization = await createStreamingOrg(page, `Paste-Chat-${Date.now()}`);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto("/chat");

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Please review these pasted files.");

  await composer.evaluate(async (element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 900;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to create canvas context for test image");
    }
    context.fillStyle = "#f3f4f6";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#111827";
    context.fillRect(72, 72, canvas.width - 144, canvas.height - 144);
    context.fillStyle = "#60a5fa";
    context.fillRect(120, 132, 460, 220);
    context.fillStyle = "#f9fafb";
    context.font = "bold 88px sans-serif";
    context.fillText("1600 × 900", 660, 490);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) {
      throw new Error("Failed to create PNG blob for paste test");
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([blob], "clipboard-image.png", { type: "image/png" }),
    );
    dataTransfer.items.add(
      new File(["Quarterly note"], "notes.txt", { type: "text/plain" }),
    );

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: dataTransfer,
    });
    element.dispatchEvent(pasteEvent);
  });

  const pendingAttachments = page.getByTestId("chat-pending-attachment");
  await expect(pendingAttachments).toHaveCount(2);
  const pendingImage = page.getByTestId("chat-pending-image-attachment");
  await expect(pendingImage).toBeVisible();
  await expect(pendingImage.getByAltText("clipboard-image.png")).toBeVisible();
  await expect(pendingAttachments.filter({ hasText: "notes.txt" })).toBeVisible();

  await page.getByRole("button", { name: "Send" }).click();

  const userBubble = page.getByTestId("chat-user-message-bubble").last();
  await expect(userBubble).toContainText("Please review these pasted files.", { timeout: 15_000 });
  const sentImage = userBubble.getByTestId("chat-image-attachment");
  await expect(sentImage).toBeVisible({ timeout: 15_000 });
  await expect(sentImage.getByAltText("clipboard-image.png")).toBeVisible({ timeout: 15_000 });
  await expect(userBubble.getByRole("link", { name: "notes.txt" })).toBeVisible({ timeout: 15_000 });

  await sentImage.click();
  const previewDialog = page.getByTestId("chat-image-preview-dialog");
  await expect(previewDialog).toBeVisible({ timeout: 15_000 });
  const previewImage = previewDialog.getByAltText("clipboard-image.png");
  await expect(previewImage).toBeVisible();
  const previewMetrics = await previewImage.evaluate((image) => {
    const element = image as HTMLImageElement;
    const rect = element.getBoundingClientRect();
    return {
      ratioDelta: Math.abs(rect.width / rect.height - element.naturalWidth / element.naturalHeight),
      renderedWidth: rect.width,
      renderedHeight: rect.height,
    };
  });
  expect(previewMetrics.ratioDelta).toBeLessThan(0.01);
  expect(previewMetrics.renderedWidth).toBeGreaterThan(1200);
  expect(previewMetrics.renderedHeight).toBeGreaterThan(675);
  await page.keyboard.press("Escape");
  await expect(previewDialog).toHaveCount(0);

  await expect.poll(async () => {
    const chatId = new URL(page.url()).pathname.split("/").at(-1);
    if (!chatId) return -1;
    const messagesRes = await page.request.get(`/api/chats/${chatId}/messages`);
    if (!messagesRes.ok()) return -1;
    const messages = await messagesRes.json();
    const userMessage = [...messages].reverse().find((message: { role: string }) => message.role === "user");
    return userMessage?.attachments?.length ?? 0;
  }).toBe(2);
});
