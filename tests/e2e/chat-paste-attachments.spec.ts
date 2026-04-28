import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

async function createStreamingOrg(
  page: Page,
  name: string,
  runtimeConfig: Record<string, unknown>,
) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: runtimeConfig,
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

async function createAttachmentAwareCodexStub() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-chat-attachment-stub-"));
  const stubPath = path.join(tempDir, "codex");
  const capturePath = path.join(tempDir, "chat-prompt.txt");
  const script = `#!/usr/bin/env node
const fs = require("node:fs/promises");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", async () => {
  if (process.env.RUDDER_TEST_CAPTURE_PATH) {
    await fs.writeFile(process.env.RUDDER_TEST_CAPTURE_PATH, prompt, "utf8");
  }
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const hasAttachmentSection = prompt.includes("Current user message attachments:");
  const hasImage = prompt.includes("clipboard-image.png");
  const hasTextFile = prompt.includes("notes.txt");
  const body = hasAttachmentSection && hasImage && hasTextFile
    ? "I found 2 attachments: clipboard-image.png and notes.txt."
    : "Attachment context missing.";
  const finalText = body + "\\n" + sentinel + JSON.stringify({
    kind: "message",
    body,
    structuredPayload: null,
  });
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-attachment", model: "gpt-5.4" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { id: "msg-1", type: "agent_message", text: finalText },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    result: finalText,
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  }) + "\\n");
});
`;
  await fs.writeFile(stubPath, script, { mode: 0o755 });
  return { tempDir, stubPath, capturePath };
}

test("pastes clipboard images and files into chat as pending attachments and exposes them to the assistant", async ({ page }) => {
  const { tempDir, stubPath, capturePath } = await createAttachmentAwareCodexStub();
  try {
    await page.setViewportSize({ width: 1600, height: 1100 });
    const organization = await createStreamingOrg(page, `Paste-Chat-${Date.now()}`, {
      model: "gpt-5.4",
      command: stubPath,
      env: {
        RUDDER_TEST_CAPTURE_PATH: capturePath,
      },
    });

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
    const previewChromeMetrics = await page.getByRole("dialog").evaluate((dialog) => {
      const image = dialog.querySelector('[data-testid="chat-image-preview-dialog"] img');
      const close = dialog.querySelector('[data-slot="dialog-close"]');
      if (!(image instanceof HTMLImageElement) || !(close instanceof HTMLElement)) {
        throw new Error("Expected image preview content and close button");
      }
      const dialogRect = dialog.getBoundingClientRect();
      const imageRect = image.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      const style = window.getComputedStyle(dialog);

      return {
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
        paddingTop: style.paddingTop,
        closeInsideImage:
          closeRect.top >= imageRect.top
          && closeRect.right <= imageRect.right
          && closeRect.bottom <= imageRect.bottom
          && closeRect.left >= imageRect.left,
      };
    });
    expect(previewChromeMetrics.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(previewChromeMetrics.borderTopWidth).toBe("0px");
    expect(
      previewChromeMetrics.boxShadow === "none"
      || /^rgba\(0,\s0,\s0,\s0\)\s0px\s0px\s0px\s0px(?:,\srgba\(0,\s0,\s0,\s0\)\s0px\s0px\s0px\s0px)*$/.test(previewChromeMetrics.boxShadow),
    ).toBe(true);
    expect(previewChromeMetrics.paddingTop).toBe("0px");
    expect(previewChromeMetrics.closeInsideImage).toBe(true);
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

    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "I found 2 attachments: clipboard-image.png and notes.txt.",
      { timeout: 15_000 },
    );
    await expect.poll(async () => {
      const prompt = await fs.readFile(capturePath, "utf8").catch(() => "");
      return (
        prompt.includes("Current user message attachments:")
        && prompt.includes("clipboard-image.png")
        && prompt.includes("notes.txt")
        && prompt.includes("$RUDDER_API_URL/api/assets/")
      );
    }).toBe(true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
