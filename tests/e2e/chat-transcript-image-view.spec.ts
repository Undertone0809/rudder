import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const LOCAL_CHOOSER_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAoAAAAFoCAMAAADw7LpjAAAAElBMVEX18uomPVs6frBTno7npEn///+9jVZhAAAEvklEQVR4nO3SiWkDQAADQefrv+V0EHMsh4I9U4EQ+/iAocd6AO9NgEwJkCkBMiVApgTIlACZEiBTAmRKgEwJkCkBMiVApgTIlACZEiBTAmRKgEwJkCkBMiVApgTIlACZEiBTAmRKgEwJkCkBMiVApgTIlACZEiBTAmRKgEwJkCkBMiVApgTIlACZEiBTAmRKgEwJkCkBMiVApgTIlACZEiBTAmRKgEwJkCkBMiVApgTIlACZEiBTAmRKgEwJkCkBMiVApgTIlACZEiBTAmRKgEwJkCkBMiVApgTIlACZEiBTAmRKgEwJkCkBMiVApgTIlACZEiBTAmTqAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOx9vrFn33zxlAADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXYCDATYCTAQYCfAQICdAAMBdgIM8nl06wiW1t8jQNbWESytv0eArK0jWFp/jwBZW0ewtP4eAbK2jmBp/T0CZG0dwdL6ewTI2jqCpfX3CJC1dQRL6+8RIGvrCJbW3yPAP33zlAADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXYCDATYCTAQYCfAQICdAAMBdgIMBNgJMBBgJ8BAgJ0AAwF2AgwE2AkwEGAnwECAnQADAXY5QAAAAAAAAAAAAAAAAF7Dzwtaf8qBdSw3rD/lwDqWG9afcmAdyw3rTzmwjuWG9accWMdyw/pTDqxjuWH9KQfWsdyw/pQD61huWH/KgXUsN6w/5cA6lhvWn3JgHcsN6085sI7lhvWnHFjHcsP6Uw6sY7lh/SkH1rHcsP6UA+tYblh/yoF1LDesPwUAAAAAAAAAAAAAAAAA/rtfx0scbDIPET0AAAAASUVORK5CYII=";

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("keeps ImageView transcript evidence available after temporary runtime files are cleaned up", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const previewCalls: string[] = [];
    Object.defineProperty(window, "__rudderImageViewPreviewCalls", {
      configurable: true,
      value: previewCalls,
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        previewLocalFile: async (filePath: string) => {
          previewCalls.push(filePath);
          throw new Error(`Durable transcript images must not use Desktop local preview: ${filePath}`);
        },
      },
    });
  });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Transcript-ImageView-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "ImageView Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "ImageView transcript preview",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Inspect the captured dashboard image." },
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  const assetRes = await page.request.post(`/api/orgs/${organization.id}/assets/images`, {
    multipart: {
      namespace: "chat-transcript-image-view-e2e",
      file: {
        name: "dashboard.png",
        mimeType: "image/png",
        buffer: Buffer.from(IMAGE_BASE64, "base64"),
      },
    },
  });
  expect(assetRes.ok(), await assetRes.text()).toBe(true);
  const asset = await assetRes.json() as { assetId: string };
  const imagePath = `/api/assets/${asset.assetId}/content`;

  const imageEvidence = {
    id: "image-1",
    status: "completed",
    path: imagePath,
    displayName: "dashboard.png",
  };
  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: "The dashboard image was inspected.",
    structuredPayload: {
      __chatTranscript: [
        { kind: "system", ts: "2026-07-25T00:00:00.000Z", text: "turn started" },
        {
          kind: "tool_call",
          ts: "2026-07-25T00:00:01.000Z",
          name: "image_view",
          toolUseId: "image-1",
          input: imageEvidence,
        },
        {
          kind: "tool_result",
          ts: "2026-07-25T00:00:02.000Z",
          toolUseId: "image-1",
          toolName: "image_view",
          content: JSON.stringify(imageEvidence),
          isError: false,
        },
      ],
    },
    replyingAgentId: agent.id,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
  await page.reload();

  const transcript = page.getByTestId("chat-transcript-item");
  await transcript.getByRole("button", { name: /Worked for/i }).click();
  const imageView = transcript.getByRole("button", { name: "Preview image dashboard.png" });
  await expect(imageView).toBeVisible();
  await expect(transcript.getByAltText("Preview of dashboard.png")).toHaveCount(0);
  expect(await page.evaluate(() => (
    (window as typeof window & { __rudderImageViewPreviewCalls?: string[] })
      .__rudderImageViewPreviewCalls ?? []
  ))).toEqual([]);

  await imageView.click();

  await expect(transcript.getByAltText("Preview of dashboard.png")).toBeVisible();
  await expect(transcript.getByAltText("Preview of dashboard.png")).toHaveAttribute(
    "src",
    imagePath,
  );
  expect(await page.evaluate(() => (
    (window as typeof window & { __rudderImageViewPreviewCalls?: string[] })
      .__rudderImageViewPreviewCalls ?? []
  ))).toEqual([]);
  await page.screenshot({ path: "/tmp/rudder-image-view-expanded.png", fullPage: true });
});

test("chooses a browser-local image in Chat, switches recorded entries, and releases it on close", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const screenshotBase = `/tmp/rudder-browser-local-chat-preview-${randomUUID()}`;
  await page.addInitScript(() => {
    const revoked: string[] = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url); };
    Object.defineProperty(window, "__rudderRevokedImageUrls", { value: revoked });
    type DirectorySelection = {
      mode: "cancel" | "grant";
      rootName: string;
      fileName: string;
      imageBase64: string;
    };
    const browserWindow = window as Window & {
      __rudderDirectorySelection?: DirectorySelection;
      showDirectoryPicker?: (options: { mode: "read" }) => Promise<FileSystemDirectoryHandle>;
    };
    Object.defineProperty(browserWindow, "showDirectoryPicker", {
      configurable: true,
      value: async ({ mode }: { mode: "read" }) => {
        const selection = browserWindow.__rudderDirectorySelection;
        if (mode !== "read" || !selection) throw new Error("No browser directory selection was configured.");
        if (selection.mode === "cancel") throw new DOMException("Picker dismissed", "AbortError");
        const bytes = Uint8Array.from(atob(selection.imageBase64), (character) => character.charCodeAt(0));
        const file = new File([bytes], selection.fileName, { type: "image/png" });
        return {
          name: selection.rootName,
          getDirectoryHandle: async (name: string) => {
            throw new DOMException(`Unexpected directory traversal: ${name}`, "NotFoundError");
          },
          getFileHandle: async (name: string, options: { create?: boolean }) => {
            if (options.create !== false || name !== "screenshot.png") {
              throw new DOMException(`Unexpected target file: ${name}`, "NotFoundError");
            }
            return { getFile: async () => file };
          },
        } as unknown as FileSystemDirectoryHandle;
      },
    });
  });
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Browser-Local-Image-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Browser Local Image Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Browser local transcript images",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Inspect recorded images." },
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };
  const images = ["first", "second"].map((entry, index) => ({
    id: `image-${index}`,
    status: "completed",
    path: `/tmp/${entry}/screenshot.png`,
    displayName: "screenshot.png",
  }));
  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: "Both images were inspected.",
    structuredPayload: {
      __chatTranscript: images.flatMap((image, index) => [
        { kind: "tool_call", ts: `2026-07-25T00:00:0${index * 2}.000Z`, name: "image_view", toolUseId: image.id, input: image },
        { kind: "tool_result", ts: `2026-07-25T00:00:0${index * 2 + 1}.000Z`, toolUseId: image.id, toolName: "image_view", content: JSON.stringify(image), isError: false },
      ]),
    },
    replyingAgentId: agent.id,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });
  const imageUploads: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const pathname = new URL(request.url()).pathname;
    if (pathname === `/api/orgs/${organization.id}/assets/images`
      || /multipart\/form-data/i.test(request.headers()["content-type"] ?? "")) imageUploads.push(pathname);
  });
  await page.goto("/");
  await page.evaluate((orgId) => window.localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
  const transcript = page.getByTestId("chat-transcript-item");
  await transcript.getByRole("button", { name: /Worked for/i }).click();
  await transcript.getByRole("button", { name: "Expand tool activity" }).click();
  const first = transcript.locator('button[data-transcript-image-target="/tmp/first/screenshot.png"]');
  const second = transcript.locator('button[data-transcript-image-target="/tmp/second/screenshot.png"]');
  await expect(first).toHaveAccessibleName("Preview image screenshot.png");
  await expect(second).toHaveAccessibleName("Preview image screenshot.png");
  await first.click();
  const picker = transcript.getByTestId("transcript-browser-image-picker");
  await expect(picker).toContainText("browser cannot verify the selected folder's full system path");
  await page.screenshot({ path: `${screenshotBase}-picker.png`, fullPage: true });
  const setDirectorySelection = async (selection: {
    mode: "cancel" | "grant";
    rootName: string;
    fileName: string;
  }) => page.evaluate(({ nextSelection, imageBase64 }) => {
    (window as Window & {
      __rudderDirectorySelection?: {
        mode: "cancel" | "grant";
        rootName: string;
        fileName: string;
        imageBase64: string;
      };
    }).__rudderDirectorySelection = { ...nextSelection, imageBase64 };
  }, { nextSelection: selection, imageBase64: LOCAL_CHOOSER_IMAGE_BASE64 });

  const folderPicker = picker.getByRole("button", { name: "Choose workspace folder" });
  // The browser's native directory chooser is represented by the File System Access API in this E2E.
  await setDirectorySelection({ mode: "cancel", rootName: "first", fileName: "screenshot.png" });
  await folderPicker.click();
  await expect(picker.getByRole("alert")).toHaveCount(0);
  await expect(transcript.getByAltText("Preview of screenshot.png")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(transcript.getByRole("button", { name: /Worked for/i })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("side-panel-expanded-overlay")).toHaveCount(0);
  const localPickerButton = picker.getByRole("button", { name: "Choose workspace folder", exact: true });
  await setDirectorySelection({ mode: "cancel", rootName: "first", fileName: "screenshot.png" });
  await localPickerButton.focus();
  await localPickerButton.press("Enter");
  await expect(picker.getByRole("alert")).toHaveCount(0);
  await expect(transcript.getByAltText("Preview of screenshot.png")).toHaveCount(0);
  await setDirectorySelection({ mode: "grant", rootName: "unrelated", fileName: "screenshot.png" });
  await localPickerButton.click();
  await expect(picker.getByRole("alert")).toContainText("Choose a folder whose name appears in the recorded file path.");
  await setDirectorySelection({ mode: "grant", rootName: "first", fileName: "wrong-name.png" });
  await localPickerButton.click();
  await expect(picker.getByRole("alert")).toContainText("Select the local file named screenshot.png.");
  await expect(transcript.getByAltText("Preview of screenshot.png")).toHaveCount(0);
  await expect(localPickerButton).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshotBase}-wrong-file-narrow.png`, fullPage: true });
  await setDirectorySelection({ mode: "grant", rootName: "first", fileName: "screenshot.png" });
  await localPickerButton.click();
  const thumbnail = transcript.getByAltText("Preview of screenshot.png");
  await expect(thumbnail).toHaveAttribute("src", /^blob:/u);
  await page.screenshot({ path: `${screenshotBase}-inline.png`, fullPage: true });
  const firstBlob = await thumbnail.getAttribute("src");
  const previewTrigger = transcript.getByRole("button", { name: "Open image preview: screenshot.png" });
  await previewTrigger.focus();
  await previewTrigger.press("Enter");
  const fullscreen = page.getByTestId("transcript-image-preview-dialog");
  await expect(fullscreen).toBeVisible();
  await expect(fullscreen.getByRole("button", { name: "Copy Image" })).toBeVisible();
  await expect(fullscreen.getByRole("button", { name: "Download Image" })).toBeVisible();
  for (const control of ["Copy Image", "Download Image", "Close image preview"]) {
    await expect.poll(async () => {
      const box = await fullscreen.getByRole("button", { name: control, exact: true }).boundingBox();
      return Boolean(box && box.x >= 0 && box.x + box.width <= 390);
    }).toBe(true);
  }
  await expect.poll(() => fullscreen.locator("img").evaluate((image: HTMLImageElement) => [
    image.naturalWidth,
    image.naturalHeight,
  ])).toEqual([640, 360]);
  await page.screenshot({
    path: `${screenshotBase}-fullscreen.png`,
    fullPage: true,
    animations: "disabled",
  });
  await fullscreen.getByRole("button", { name: "Close image preview" }).click();
  await expect(fullscreen).toHaveCount(0);
  await expect(previewTrigger).toBeFocused();

  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(transcript.getByRole("button", { name: /Worked for/i })).toHaveAttribute("aria-expanded", "true");
  await expect(previewTrigger).toBeVisible();
  await expect(thumbnail).toHaveAttribute("src", firstBlob!);
  expect(await page.evaluate(() => (window as typeof window & { __rudderRevokedImageUrls?: string[] }).__rudderRevokedImageUrls ?? [])).not.toContain(firstBlob);
  await page.screenshot({ path: `${screenshotBase}-desktop-back.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(thumbnail).toHaveAttribute("src", firstBlob!);

  await previewTrigger.click();
  await expect(fullscreen).toBeVisible();
  // A transcript update can collapse the underlying entry while the modal owns its blob.
  // The modal makes the background inaccessible to role selectors, but the entry remains in the DOM.
  await first.evaluate((button: HTMLButtonElement) => button.click());
  await expect(fullscreen).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy Image" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download Image" })).toHaveCount(0);
  await expect(transcript.getByAltText("Preview of screenshot.png")).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __rudderRevokedImageUrls?: string[] }).__rudderRevokedImageUrls ?? [])).toContain(firstBlob);

  await second.click();
  const secondPicker = transcript.getByTestId("transcript-browser-image-picker");
  await expect(secondPicker).toContainText("browser cannot verify the selected folder's full system path");
  await setDirectorySelection({ mode: "grant", rootName: "second", fileName: "screenshot.png" });
  await secondPicker.getByRole("button", { name: "Choose workspace folder" }).click();
  await expect(transcript.getByAltText("Preview of screenshot.png")).toHaveAttribute("src", /^blob:/u);
  await page.screenshot({ path: `${screenshotBase}-second-inline.png`, fullPage: true });
  await transcript.getByRole("button", { name: "Collapse image screenshot.png" }).click();
  await expect(transcript.getByTestId("transcript-browser-image-picker")).toHaveCount(0);
  await page.screenshot({ path: `${screenshotBase}-closed.png`, fullPage: true });
  expect(imageUploads).toEqual([]);
});
