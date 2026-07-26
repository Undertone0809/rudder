import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const IMAGE_PATH = "/tmp/dashboard.png";
const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("expands ImageView transcript evidence into the recorded local image", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(({ expectedPath, base64 }) => {
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
          if (filePath !== expectedPath) throw new Error(`Unexpected local image path: ${filePath}`);
          return {
            canonicalPath: expectedPath,
            fileName: "dashboard.png",
            parentPath: "/tmp",
            contentType: "image/png",
            previewKind: "image",
            content: null,
            base64,
            sizeBytes: 68,
            modifiedAt: "2026-07-25T00:00:00.000Z",
            truncated: false,
          };
        },
      },
    });
  }, { expectedPath: IMAGE_PATH, base64: IMAGE_BASE64 });

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

  const imageEvidence = { id: "image-1", status: "completed", path: IMAGE_PATH };
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
    `data:image/png;base64,${IMAGE_BASE64}`,
  );
  expect(await page.evaluate(() => (
    (window as typeof window & { __rudderImageViewPreviewCalls?: string[] })
      .__rudderImageViewPreviewCalls ?? []
  ))).toEqual([IMAGE_PATH]);
  await page.screenshot({ path: "/tmp/rudder-image-view-expanded.png", fullPage: true });
});
