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
