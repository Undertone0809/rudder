import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test("issue description stays Library-style source-backed and preserves exact line breaks", async ({ page }) => {
  test.setTimeout(120_000);

  const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `Issue-Description-Editing-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Description editing parity",
      description: "Opening paragraph\n\n- alpha",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  await page.goto(E2E_BASE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/messenger/issues/${issue.identifier ?? issue.id}`);

  const editor = page
    .locator(".rudder-issue-description-surface")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(editor).toBeVisible();
  await expect(page.locator(".rudder-issue-description-markdown-read")).toHaveCount(0);
  const verticalGap = await page.getByTestId("issue-detail-layout").evaluate((layout) => {
    const heading = layout.querySelector<HTMLElement>("[data-testid='issue-detail-heading']");
    const body = layout.querySelector<HTMLElement>("[data-testid='issue-detail-primary-content']");
    if (!heading || !body) throw new Error("Expected Issue Detail heading and body");
    return Math.round(body.getBoundingClientRect().top - heading.getBoundingClientRect().bottom);
  });
  expect(verticalGap).toBeGreaterThanOrEqual(16);
  expect(verticalGap).toBeLessThanOrEqual(32);

  const openingPreview = editor
    .locator('[data-markdown-preview-state="preview"]')
    .filter({ hasText: "Opening paragraph" });
  await expect(openingPreview).toBeVisible();
  await openingPreview.dispatchEvent("mousedown", { button: 0 });
  await expect(
    editor.locator('[data-markdown-preview-state="source"]').first(),
  ).toContainText("Opening paragraph");

  const exactDescription = "\nOpening paragraph  \n\nInserted paragraph\n\n- alpha\n- beta\n";
  const sourceEditor = editor.locator(".cm-content");
  await sourceEditor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(exactDescription);
  await sourceEditor.evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });

  await page.getByRole("region", { name: "Issue properties" }).getByText("Properties", { exact: true }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
    expect(response.ok()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toBe(exactDescription);

  await page.reload();
  await expect(
    page
      .locator(".rudder-issue-description-surface")
      .locator('[data-markdown-preview-state="preview"]')
      .filter({ hasText: "Inserted paragraph" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".rudder-issue-description-surface")
      .locator('[data-markdown-preview-state="preview"]')
      .filter({ hasText: "beta" }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/rudder-issue-description-fixed.png", fullPage: false });
});

test("issue description images reveal source while attachment images keep the global preview", async ({ page }) => {
  test.setTimeout(120_000);

  await page.addInitScript(() => {
    Object.defineProperty(window, "__rudderCopiedImage", {
      configurable: true,
      value: null,
      writable: true,
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        copyImage: async (payload: { filename: string; contentType: string; base64: string }) => {
          (window as typeof window & { __rudderCopiedImage: typeof payload | null }).__rudderCopiedImage = payload;
        },
      },
    });
  });

  const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `Issue-Description-Image-Preview-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  await page.goto(E2E_BASE_URL, { waitUntil: "domcontentloaded" });
  const imageDataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to create canvas context for issue description image test");
    }
    context.fillStyle = "#f8fafc";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#111827";
    context.fillRect(40, 40, canvas.width - 80, canvas.height - 80);
    context.fillStyle = "#67e8f9";
    context.font = "bold 44px sans-serif";
    context.fillText("Description evidence", 96, 200);
    return canvas.toDataURL("image/png");
  });

  const issueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Description image preview",
      description: "Inspect this screenshot.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  const imageBuffer = Buffer.from(imageDataUrl.split(",", 2)[1] ?? "", "base64");
  const attachmentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues/${issue.id}/attachments`, {
    multipart: {
      usage: "description_inline",
      file: {
        name: "description-evidence.png",
        mimeType: "image/png",
        buffer: imageBuffer,
      },
    },
  });
  expect(attachmentRes.ok()).toBe(true);
  const attachment = await attachmentRes.json() as { contentPath: string };

  const issueAttachmentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues/${issue.id}/attachments`, {
    multipart: {
      usage: "issue",
      file: {
        name: "issue-evidence.png",
        mimeType: "image/png",
        buffer: imageBuffer,
      },
    },
  });
  expect(issueAttachmentRes.ok()).toBe(true);

  const descriptionRes = await page.request.patch(`${E2E_BASE_URL}/api/issues/${issue.id}`, {
    data: {
      description: `Inspect this screenshot:\n\n![Description evidence](${attachment.contentPath})`,
    },
  });
  expect(descriptionRes.ok()).toBe(true);

  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

  const descriptionEditor = page
    .locator(".rudder-issue-description-surface")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  await expect(descriptionEditor).toBeVisible();
  await expect(page.locator(".rudder-issue-description-markdown-read")).toHaveCount(0);

  const descriptionImage = descriptionEditor.locator('img[alt="Description evidence"]:visible');
  await expect(descriptionImage).toBeVisible();
  await descriptionImage.dispatchEvent("mousedown", { button: 0 });
  await expect(
    descriptionEditor.locator('[data-markdown-preview-state="source"]').filter({
      hasText: `![Description evidence](${attachment.contentPath})`,
    }),
  ).toBeVisible();
  await expect(page.getByTestId("markdown-editor-image-preview-dialog")).toHaveCount(0);

  await descriptionEditor.locator(".cm-content").evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });
  await expect(descriptionEditor.locator('img[alt="Description evidence"]:visible')).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(previewDialog).toHaveCount(0);

  const commentComposer = page.getByTestId("comment-thread-fixed-composer");
  await commentComposer.locator('input[type="file"]').setInputFiles({
    name: "draft-comment-evidence.png",
    mimeType: "image/png",
    buffer: imageBuffer,
  });
  const draftCommentImage = commentComposer.locator('img[alt="draft-comment-evidence.png"]');
  await expect(draftCommentImage).toBeVisible();
  await draftCommentImage.click({ button: "right" });

  const draftImageContextMenu = page.getByTestId("markdown-image-context-menu");
  await expect(draftImageContextMenu).toBeVisible();
  await expect(draftImageContextMenu.getByRole("menuitem", { name: "Open Image" })).toBeVisible();
  await expect(draftImageContextMenu.getByRole("menuitem", { name: "Copy Image" })).toBeVisible();
  await expect(draftImageContextMenu.getByRole("menuitem", { name: "Download Image" })).toBeVisible();
  await page.screenshot({ path: "/tmp/rudder-issue-draft-comment-copy-image.png", fullPage: false });
  await draftImageContextMenu.getByRole("menuitem", { name: "Copy Image" }).click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __rudderCopiedImage?: { filename: string; contentType: string; base64: string } | null;
    }
  ).__rudderCopiedImage)).toMatchObject({
    filename: "draft-comment-evidence.png",
    contentType: "image/png",
  });
  await expect(draftImageContextMenu).toHaveCount(0);

  const attachmentName = page.getByRole("button", { name: "issue-evidence.png", exact: true });
  await expect(attachmentName).toBeVisible();
  await attachmentName.click();

  const attachmentPreview = page.getByTestId("issue-attachment-image-preview-dialog");
  await expect(attachmentPreview).toBeVisible();
  await expect(attachmentPreview.getByRole("button", { name: "Close image preview" })).toBeVisible();
  await expect(attachmentPreview.getByRole("button", { name: "Copy Image" })).toBeVisible();
  await expect(attachmentPreview.getByRole("button", { name: "Download Image" })).toBeVisible();
  await attachmentPreview.getByAltText("issue-evidence.png").click({ button: "right" });
  const previewImageContextMenu = page.getByTestId("image-preview-context-menu");
  await expect(previewImageContextMenu.getByRole("menuitem", { name: "Copy Image" })).toBeVisible();
  await previewImageContextMenu.getByRole("menuitem", { name: "Copy Image" }).click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __rudderCopiedImage?: { filename: string; contentType: string; base64: string } | null;
    }
  ).__rudderCopiedImage)).toMatchObject({
    filename: "issue-evidence.png",
    contentType: "image/png",
  });
  await page.screenshot({ path: "/tmp/rudder-issue-attachment-image-preview.png", fullPage: false });
});
