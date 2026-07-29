import { expect, test, type Locator } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

async function placeCaretAtEnd(locator: Locator) {
  await locator.evaluate((element) => {
    const editable = element.closest<HTMLElement>('[contenteditable="true"]');
    if (!editable) throw new Error("Expected a contenteditable ancestor");
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

test("opening and blurring a list description does not rewrite the issue", async ({ page }) => {
  test.setTimeout(120_000);

  const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `Issue-Description-Noop-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const originalDescription = "Regression context\n\n- first item\n- second item";

  const issueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Description must not rewrite itself",
      description: originalDescription,
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  const issue = await issueRes.json() as {
    id: string;
    identifier: string | null;
    updatedAt: string;
  };

  const descriptionPatches: unknown[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    const issuePaths = new Set([
      `/api/issues/${issue.id}`,
      `/api/issues/${issue.identifier ?? issue.id}`,
    ]);
    if (request.method() !== "PATCH" || !issuePaths.has(url.pathname)) return;
    descriptionPatches.push(request.postDataJSON());
  });

  await page.goto(E2E_BASE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/messenger/issues/${issue.identifier ?? issue.id}`);

  const editor = page.locator(".rudder-issue-description-markdown .ProseMirror");
  await expect(editor).toBeVisible();
  await page.waitForTimeout(1_200);
  await page.getByRole("region", { name: "Issue properties" }).getByText("Properties", { exact: true }).click();
  await page.waitForTimeout(1_000);
  expect(descriptionPatches).toEqual([]);

  const unchangedRes = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
  expect(unchangedRes.ok(), await unchangedRes.text()).toBe(true);
  const unchanged = await unchangedRes.json() as { description: string | null; updatedAt: string };
  expect(unchanged.description).toBe(originalDescription);
  expect(unchanged.updatedAt).toBe(issue.updatedAt);

  await placeCaretAtEnd(editor.locator(":scope > p", { hasText: "Regression context" }));
  await page.keyboard.type(" updated");
  await page.getByRole("region", { name: "Issue properties" }).getByText("Properties", { exact: true }).click();

  await expect.poll(() => descriptionPatches.length).toBe(1);
  await expect.poll(async () => {
    const response = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
    expect(response.ok()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toContain("Regression context updated");
  await page.screenshot({
    path: "/tmp/rudder-time-display-fix-verified.png",
    fullPage: false,
  });
});

test("issue description stays Library-style editable and preserves Enter-created paragraphs", async ({ page }) => {
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

  const editor = page.locator(".rudder-issue-description-markdown .ProseMirror");
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

  const openingParagraph = editor.locator(":scope > p", { hasText: "Opening paragraph" });
  await placeCaretAtEnd(openingParagraph);
  await page.keyboard.press("Enter");

  const blankParagraph = editor.locator(":scope > p").nth(1);
  await expect(blankParagraph).toBeVisible();
  const blankParagraphHeight = await blankParagraph.evaluate((element) => element.getBoundingClientRect().height);
  expect(blankParagraphHeight).toBeGreaterThanOrEqual(20);
  await page.keyboard.type("Inserted paragraph");
  await expect(editor.locator(":scope > p", { hasText: "Inserted paragraph" })).toBeVisible();

  const alphaItem = editor.locator("li > p", { hasText: "alpha" });
  await placeCaretAtEnd(alphaItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type("beta");
  await expect(editor.locator("li > p", { hasText: "alpha" })).toHaveCount(1);
  await expect(editor.locator("li > p", { hasText: "beta" })).toHaveCount(1);

  await page.getByRole("region", { name: "Issue properties" }).getByText("Properties", { exact: true }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
    expect(response.ok()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toContain("Inserted paragraph");

  await page.reload();
  await expect(editor.locator(":scope > p", { hasText: "Inserted paragraph" })).toBeVisible();
  await expect(editor.locator("li > p", { hasText: "beta" })).toBeVisible();
  await page.screenshot({ path: "/tmp/rudder-issue-description-fixed.png", fullPage: false });
});

test("issue description and attachment images open the global preview", async ({ page }) => {
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

  const descriptionEditor = page.locator(".rudder-issue-description-markdown .ProseMirror");
  await expect(descriptionEditor).toBeVisible();
  await expect(page.locator(".rudder-issue-description-markdown-read")).toHaveCount(0);

  const descriptionImage = descriptionEditor.locator('img[alt="Description evidence"]:visible');
  await expect(descriptionImage).toBeVisible();
  await descriptionImage.dblclick();

  const previewDialog = page.getByTestId("markdown-editor-image-preview-dialog");
  await expect(previewDialog).toBeVisible();
  await expect(previewDialog.getByAltText("Description evidence")).toBeVisible();
  await expect(previewDialog.getByRole("button", { name: "Copy Image" })).toBeVisible();

  const previewMetrics = await previewDialog.getByAltText("Description evidence").evaluate((image) => {
    const element = image as HTMLImageElement;
    const rect = element.getBoundingClientRect();
    return {
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      ratioDelta: Math.abs(rect.width / rect.height - element.naturalWidth / element.naturalHeight),
    };
  });
  expect(previewMetrics.renderedWidth).toBeGreaterThan(560);
  expect(previewMetrics.renderedHeight).toBeGreaterThan(300);
  expect(previewMetrics.ratioDelta).toBeLessThan(0.01);

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
