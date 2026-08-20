import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";

async function createStreamingOrg(
  page: Page,
  name: string,
  runtimeConfig: Record<string, unknown>,
) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Attachment Agent",
    agentRuntimeConfig: runtimeConfig,
  });
  return { ...organization, chatAgent };
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
  const imageName = prompt.includes("clipboard-image.png")
    ? "clipboard-image.png"
    : prompt.includes("drop-screenshot.png")
      ? "drop-screenshot.png"
      : null;
  const textFileName = prompt.includes("drop-notes.txt")
    ? "drop-notes.txt"
    : prompt.includes("notes.txt")
      ? "notes.txt"
      : null;
  const localPath = prompt.match(/localPath=([^;\\n]+)/)?.[1]?.trim();
  const localImageReadable = localPath
    ? await fs.access(localPath).then(() => true, () => false)
    : false;
  const hasInternalDownloadInstruction = prompt.includes("downloadCommand")
    || prompt.includes("Authorization: Bearer")
    || prompt.includes("curl -L");
  const body = hasAttachmentSection && imageName && textFileName && localImageReadable && !hasInternalDownloadInstruction
    ? "I found 2 attachments: " + imageName + " and " + textFileName + "."
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

async function pasteTextAttachment(page: Page, fileName: string, contents: string) {
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.evaluate(
    async (element, payload) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File([payload.contents], payload.fileName, { type: "text/plain" }),
      );

      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: dataTransfer,
      });
      element.dispatchEvent(pasteEvent);
    },
    { fileName, contents },
  );
}

async function pasteSameNamedImages(page: Page, count: number) {
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.evaluate(
    async (element, imageCount) => {
      const dataTransfer = new DataTransfer();
      for (let index = 0; index < imageCount; index += 1) {
        dataTransfer.items.add(
          new File([`image-${index}`], "image.png", {
            type: "image/png",
            lastModified: 1000,
          }),
        );
      }

      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: dataTransfer,
      });
      element.dispatchEvent(pasteEvent);
    },
    count,
  );
}

async function dragFilesOntoComposer(
  page: Page,
  files: Array<{ name: string; contents: string; type: string }>,
) {
  const composer = page.getByTestId("chat-composer-file-drop-target");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.evaluate((element, payload) => {
    const dataTransfer = new DataTransfer();
    for (const file of payload) {
      dataTransfer.items.add(new File([file.contents], file.name, { type: file.type }));
    }

    for (const type of ["dragenter", "dragover"] as const) {
      element.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));
    }
  }, files);
  await expect(page.getByTestId("chat-composer-file-drop-overlay")).toBeVisible();
  const screenshotPath = process.env.RUDDER_CHAT_FILE_DROP_SCREENSHOT?.trim();
  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, fullPage: false, animations: "disabled" });
  }
  await composer.evaluate((element, payload) => {
    const dataTransfer = new DataTransfer();
    for (const file of payload) {
      dataTransfer.items.add(new File([file.contents], file.name, { type: file.type }));
    }
    element.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }));
  }, files);
}

test("drops files onto the chat composer and stages them through the attachment workflow", async ({ page }) => {
  const { tempDir, stubPath } = await createAttachmentAwareCodexStub();
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    const organization = await createStreamingOrg(page, `Drop-Chat-${Date.now()}`, {
      model: "gpt-5.4",
      command: stubPath,
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${organization.chatAgent.id}`);

    await dragFilesOntoComposer(page, [
      { name: "drop-screenshot.png", contents: "image bytes", type: "image/png" },
      { name: "drop-notes.txt", contents: "release notes", type: "text/plain" },
    ]);

    await expect(page.getByTestId("chat-composer-file-drop-overlay")).toHaveCount(0);
    await expect(page.getByTestId("chat-pending-attachment")).toHaveCount(2);
    await expect(page.getByTestId("chat-pending-image-attachment")).toBeVisible();
    await expect(page.getByTestId("chat-pending-attachments")).toContainText("drop-notes.txt");

    const editor = page.locator(".rudder-mdxeditor-content").first();
    await editor.fill("Review these dropped files.");
    await page.getByRole("button", { name: "Send" }).click();

    const userBubble = page.getByTestId("chat-user-message-bubble").last();
    await expect(userBubble).toContainText("Review these dropped files.", { timeout: 15_000 });
    await expect(userBubble.getByTestId("chat-image-attachment").getByAltText("drop-screenshot.png"))
      .toBeVisible({ timeout: 15_000 });
    await expect(userBubble.getByRole("link", { name: "drop-notes.txt" }))
      .toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "I found 2 attachments: drop-screenshot.png and drop-notes.txt.",
      { timeout: 15_000 },
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("keeps multiple same-named pasted images staged independently", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  const organization = await createStreamingOrg(page, `Paste-Multi-Images-${Date.now()}`, {
    model: "gpt-5.4",
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${organization.chatAgent.id}`);
  await pasteSameNamedImages(page, 10);

  const pendingAttachments = page.getByTestId("chat-pending-attachment");
  await expect(pendingAttachments).toHaveCount(10);
  await expect(page.getByTestId("chat-pending-image-attachment")).toHaveCount(10);
  await expect.poll(async () =>
    page.locator(
      '[data-testid="chat-pending-attachments"] ~ [data-testid="chat-composer-editor-scroll"]',
    ).count()
  ).toBe(1);
  await expect.poll(async () =>
    page.locator(
      '[data-testid="chat-pending-attachments"] ~ [data-testid="chat-composer-toolbar"]',
    ).count()
  ).toBe(1);
  await page.setViewportSize({ width: 480, height: 900 });
  const attachmentBoxes = await pendingAttachments.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, left: box.left, right: box.right, bottom: box.bottom };
    }),
  );
  const pendingBox = await page.getByTestId("chat-pending-attachments").boundingBox();
  const editorBox = await page.getByTestId("chat-composer-editor-scroll").boundingBox();
  expect(new Set(attachmentBoxes.map(({ top }) => Math.round(top))).size).toBeGreaterThan(1);
  expect(pendingBox).not.toBeNull();
  expect(editorBox).not.toBeNull();
  expect(
    attachmentBoxes.every(({ left, right, bottom }) =>
      pendingBox
        ? left >= pendingBox.x &&
          right <= pendingBox.x + pendingBox.width &&
          bottom <= pendingBox.y + pendingBox.height
        : false,
    ),
  ).toBe(true);
  expect(pendingBox!.y + pendingBox!.height).toBeLessThanOrEqual(editorBox!.y);

  await page.getByRole("button", { name: "Remove image.png" }).first().click();
  await expect(pendingAttachments).toHaveCount(9);
  await expect(page.getByTestId("chat-pending-image-attachment")).toHaveCount(9);
});

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

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

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
    const sentImageChrome = await sentImage.evaluate((element) => {
      const button = element.querySelector("button");
      const image = element.querySelector("img");
      if (!(button instanceof HTMLButtonElement) || !(image instanceof HTMLImageElement)) {
        throw new Error("Expected image attachment button and image");
      }
      const wrapperStyle = window.getComputedStyle(element);
      const buttonStyle = window.getComputedStyle(button);
      const imageStyle = window.getComputedStyle(image);

      return {
        wrapperBackgroundColor: wrapperStyle.backgroundColor,
        wrapperBorderTopWidth: wrapperStyle.borderTopWidth,
        wrapperPaddingTop: wrapperStyle.paddingTop,
        buttonBorderTopWidth: buttonStyle.borderTopWidth,
        imageBorderTopWidth: imageStyle.borderTopWidth,
      };
    });
    expect(sentImageChrome.wrapperBackgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(sentImageChrome.wrapperBorderTopWidth).toBe("0px");
    expect(sentImageChrome.wrapperPaddingTop).toBe("0px");
    expect(sentImageChrome.buttonBorderTopWidth).toBe("1px");
    expect(sentImageChrome.imageBorderTopWidth).toBe("0px");
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
        && prompt.includes("localPath=")
        && !prompt.includes("downloadCommand")
        && !prompt.includes("Authorization: Bearer")
        && !prompt.includes("curl -L")
      );
    }).toBe(true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("keeps image attachments in the optimistic bubble while message acknowledgement is delayed", async ({ page }) => {
  const { tempDir, stubPath } = await createAttachmentAwareCodexStub();
  let releaseStreamResponse: (() => void) | null = null;
  const streamResponseGate = new Promise<void>((resolve) => {
    releaseStreamResponse = resolve;
  });
  let streamRouteReached = false;
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    const organization = await createStreamingOrg(page, `Optimistic-Image-${Date.now()}`, {
      model: "gpt-5.4",
      command: stubPath,
    });
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Optimistic image chat",
        preferredAgentId: organization.chatAgent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: {
          body: "Existing context for the screenshot review.",
        },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json() as { id: string };

    await page.route("**/api/chats/*/messages/stream", async (route) => {
      streamRouteReached = true;
      await streamResponseGate;
      await route.continue();
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Existing context for the screenshot review.", { exact: true })).toBeVisible();
    await composer.fill("Review this screenshot before the reply arrives.");
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "optimistic-screenshot.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await expect(page.getByTestId("chat-pending-image-attachment")).toBeVisible();

    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => streamRouteReached).toBe(true);
    const optimisticBubble = page.getByTestId("chat-user-message-bubble").last();
    await expect(optimisticBubble).toContainText("Review this screenshot before the reply arrives.");
    await expect(
      optimisticBubble
        .getByTestId("chat-optimistic-attachments")
        .getByAltText("optimistic-screenshot.png"),
    ).toBeVisible({ timeout: 5_000 });

    releaseStreamResponse();
    releaseStreamResponse = null;
    await expect(
      page.getByTestId("chat-user-message-bubble").last().getByTestId("chat-image-attachment"),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    releaseStreamResponse?.();
    await page.unroute("**/api/chats/*/messages/stream");
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("keeps pending pasted attachments scoped to the active chat conversation", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  const organization = await createStreamingOrg(page, `Paste-Scope-${Date.now()}`, {
    model: "gpt-5.4",
  });

  const firstChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Attachment scope A",
      preferredAgentId: organization.chatAgent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: {
        body: "First attachment scope.",
      },
    },
  });
  expect(firstChatRes.ok()).toBe(true);
  const firstChat = await firstChatRes.json();

  const secondChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Attachment scope B",
      preferredAgentId: organization.chatAgent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: {
        body: "Second attachment scope.",
      },
    },
  });
  expect(secondChatRes.ok()).toBe(true);
  const secondChat = await secondChatRes.json();

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${firstChat.id}`);
  await pasteTextAttachment(page, "scope-a.txt", "Attachment for the first chat only.");

  const pendingAttachments = page.getByTestId("chat-pending-attachment");
  await expect(pendingAttachments).toHaveCount(1);
  await expect(pendingAttachments.filter({ hasText: "scope-a.txt" })).toBeVisible();
  await expect(pendingAttachments.filter({ hasText: "scope-b.txt" })).toHaveCount(0);

  await page.getByRole("link", { name: /Attachment scope B/ }).click();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${secondChat.id}$`));
  await expect(pendingAttachments).toHaveCount(0);

  await pasteTextAttachment(page, "scope-b.txt", "Attachment for the second chat only.");
  await expect(pendingAttachments).toHaveCount(1);
  await expect(pendingAttachments.filter({ hasText: "scope-b.txt" })).toBeVisible();
  await expect(pendingAttachments.filter({ hasText: "scope-a.txt" })).toHaveCount(0);

  await page.getByRole("link", { name: /Attachment scope A/ }).click();
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${firstChat.id}$`));
  await expect(pendingAttachments).toHaveCount(1);
  await expect(pendingAttachments.filter({ hasText: "scope-a.txt" })).toBeVisible();
  await expect(pendingAttachments.filter({ hasText: "scope-b.txt" })).toHaveCount(0);
});
