import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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
  await page.addInitScript(() => {
    const revoked: string[] = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url); };
    Object.defineProperty(window, "__rudderRevokedImageUrls", { value: revoked });
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
  const images = ["first.png", "second.png"].map((name, index) => ({
    id: `image-${index}`,
    status: "completed",
    path: `/tmp/${name}`,
    displayName: name,
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
  await page.goto("/");
  await page.evaluate((orgId) => window.localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
  const transcript = page.getByTestId("chat-transcript-item");
  await transcript.getByRole("button", { name: /Worked for/i }).click();
  await transcript.getByRole("button", { name: "Expand tool activity" }).click();
  const first = transcript.getByRole("button", { name: "Preview image first.png" });
  const second = transcript.getByRole("button", { name: "Preview image second.png" });
  await first.click();
  const picker = transcript.getByTestId("transcript-browser-image-picker");
  await expect(picker).toContainText("original workspace path cannot be verified");
  await picker.locator('input[type="file"]').setInputFiles({
    name: "first.png",
    mimeType: "image/png",
    buffer: Buffer.from(IMAGE_BASE64, "base64"),
  });
  const thumbnail = transcript.getByAltText("Preview of first.png");
  await expect(thumbnail).toHaveAttribute("src", /^blob:/u);
  const firstBlob = await thumbnail.getAttribute("src");
  const previewTrigger = transcript.getByRole("button", { name: "Open image preview: first.png" });
  await previewTrigger.click();
  const fullscreen = page.getByTestId("transcript-image-preview-dialog");
  await expect(fullscreen).toBeVisible();
  await expect(fullscreen.getByRole("button", { name: "Copy Image" })).toBeVisible();
  await expect(fullscreen.getByRole("button", { name: "Download Image" })).toBeVisible();
  await page.screenshot({ path: "/tmp/rudder-browser-local-chat-preview-fullscreen.png", fullPage: true });
  await fullscreen.getByRole("button", { name: "Close image preview" }).click();
  await expect(fullscreen).toHaveCount(0);
  await expect(previewTrigger).toBeFocused();

  await previewTrigger.click();
  await expect(fullscreen).toBeVisible();
  // A transcript update can collapse the underlying entry while the modal owns its blob.
  // The modal makes the background inaccessible to role selectors, but the entry remains in the DOM.
  await transcript.locator('button[data-transcript-image-target="/tmp/first.png"][aria-expanded="true"]')
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(fullscreen).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy Image" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download Image" })).toHaveCount(0);
  await expect(transcript.getByAltText("Preview of first.png")).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __rudderRevokedImageUrls?: string[] }).__rudderRevokedImageUrls ?? [])).toContain(firstBlob);

  await second.click();
  await expect(transcript.getByTestId("transcript-browser-image-picker")).toContainText("second.png");
  await page.screenshot({ path: "/tmp/rudder-browser-local-chat-preview-open.png", fullPage: true });
  await transcript.getByRole("button", { name: "Collapse image second.png" }).click();
  await expect(transcript.getByTestId("transcript-browser-image-picker")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/rudder-browser-local-chat-preview-closed.png", fullPage: true });
});
