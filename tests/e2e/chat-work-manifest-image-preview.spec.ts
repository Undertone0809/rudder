import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  chatAttachments,
  chatMessages,
  createDb,
} from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const previewScreenshotPath = "/tmp/rudder-chat-work-manifest/image-preview.png";
const previewImagePath = new URL("../../ui/public/android-chrome-192x192.png", import.meta.url);

test("opens Work image attachments in the global image preview", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Chat-Work-Image-${Date.now()}`,
      issuePrefix: `CWI${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, { name: "Image Preview Agent" });

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: { title: "Image preview manifest", preferredAgentId: agent.id },
  });
  expect(chatRes.ok(), await chatRes.text()).toBe(true);
  const chat = await chatRes.json() as { id: string };
  const messageId = randomUUID();
  await e2eDb.insert(chatMessages).values({
    id: messageId,
    orgId: organization.id,
    conversationId: chat.id,
    role: "user",
    body: "Inspect the attached screenshot.",
    status: "completed",
  });

  const imageRes = await page.request.post(`/api/orgs/${organization.id}/assets/images`, {
    multipart: {
      namespace: "chat-work-manifest-e2e",
      file: {
        name: "manifest-image.png",
        mimeType: "image/png",
        buffer: await readFile(previewImagePath),
      },
    },
  });
  expect(imageRes.ok(), await imageRes.text()).toBe(true);
  const imageAsset = await imageRes.json() as { assetId: string };
  await e2eDb.insert(chatAttachments).values({
    orgId: organization.id,
    conversationId: chat.id,
    messageId,
    assetId: imageAsset.assetId,
  });

  await page.goto("/");
  await page.evaluate((orgId) => localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const shelf = page.getByRole("complementary", { name: "Work manifest" });
  await expect(shelf).toBeVisible({ timeout: 15_000 });
  const imageRow = shelf.getByRole("button", { name: "manifest-image.png", exact: true });
  await expect(imageRow.locator("[data-file-icon='image']")).toBeVisible();
  await imageRow.click();

  const preview = page.getByTestId("chat-work-manifest-image-preview-dialog");
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("button", { name: "Close image preview" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Copy Image" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Download Image" })).toBeVisible();
  await expect(page.getByTestId("chat-side-panel")).toHaveCount(0);
  await expect.poll(async () => preview.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

  const previewBox = await preview.boundingBox();
  const closeBox = await preview.getByRole("button", { name: "Close image preview" }).boundingBox();
  const copyBox = await preview.getByRole("button", { name: "Copy Image" }).boundingBox();
  expect(previewBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(previewBox!.x + previewBox!.width);
  expect(copyBox!.x).toBeGreaterThanOrEqual(previewBox!.x);
  await page.screenshot({ path: previewScreenshotPath, fullPage: true });

  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));
});
