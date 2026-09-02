import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test("preserves uploaded asset images when creating an Issue description", async ({ page }) => {
  test.setTimeout(120_000);

  const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `Issue-Description-Asset-Persistence-${Date.now()}` },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  await page.goto(E2E_BASE_URL, { waitUntil: "domcontentloaded" });
  const imageDataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Failed to create canvas context for asset persistence test");
    context.fillStyle = "#f8fafc";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#0f172a";
    context.fillRect(40, 40, canvas.width - 80, canvas.height - 80);
    context.fillStyle = "#67e8f9";
    context.font = "bold 44px sans-serif";
    context.fillText("Durable description", 96, 200);
    return canvas.toDataURL("image/png");
  });
  const imageBuffer = Buffer.from(imageDataUrl.split(",", 2)[1] ?? "", "base64");

  const assetRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/assets/images`, {
    multipart: {
      namespace: "issue-description",
      file: {
        name: "durable-description.png",
        mimeType: "image/png",
        buffer: imageBuffer,
      },
    },
  });
  expect(assetRes.ok(), await assetRes.text()).toBe(true);
  const asset = await assetRes.json() as { contentPath: string };
  expect(asset.contentPath).toMatch(/^\/api\/assets\/[0-9a-f-]+\/content$/);

  const issueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Persist description image on create",
      description: `Inspect this screenshot:\n\n![Durable description](${asset.contentPath})`,
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  const issue = await issueRes.json() as {
    id: string;
    identifier: string | null;
    description: string | null;
  };
  expect(issue.description).toMatch(/\/api\/attachments\/[0-9a-f-]+\/content/);
  expect(issue.description).not.toContain(asset.contentPath);

  const attachmentPath = issue.description?.match(/\/api\/attachments\/[0-9a-f-]+\/content/)?.[0];
  expect(attachmentPath).toBeTruthy();
  const persistedAssetRes = await page.request.get(`${E2E_BASE_URL}${attachmentPath}`);
  expect(persistedAssetRes.ok(), await persistedAssetRes.text()).toBe(true);
  expect(persistedAssetRes.headers()["content-type"]).toContain("image/png");
  expect((await persistedAssetRes.body()).length).toBeGreaterThan(0);

  const issueDetailRes = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
  expect(issueDetailRes.ok(), await issueDetailRes.text()).toBe(true);
  const issueDetail = await issueDetailRes.json() as { description: string | null };
  expect(issueDetail.description).toBe(issue.description);

  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

  const descriptionImage = page.getByRole("button", {
    name: "Open image preview: Durable description",
  });
  await expect(descriptionImage).toBeVisible();
  await expect(descriptionImage.locator('img[alt="Durable description"]')).toBeVisible();
  await expect(descriptionImage.locator('img[alt="Durable description"]')).toHaveAttribute(
    "src",
    attachmentPath!,
  );
  await expect.poll(() => descriptionImage.locator("img").evaluate((image) => image.naturalWidth)).toBe(640);
  await expect.poll(() => descriptionImage.locator("img").evaluate((image) => image.naturalHeight)).toBe(360);

  await descriptionImage.locator(".rudder-inspectable-image-overlay").click();
  const previewDialog = page.getByTestId("markdown-body-image-preview-dialog");
  await expect(previewDialog).toBeVisible();
  await expect(previewDialog.getByRole("img", { name: "Durable description" })).toHaveAttribute(
    "src",
    new URL(attachmentPath!, E2E_BASE_URL).toString(),
  );
});

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

  const editor = page
    .locator(".rudder-issue-description-surface")
    .locator('[data-editor-engine="codemirror-live-preview"]');
  const sourceEditor = editor.locator(".cm-content");
  await expect(editor).toBeVisible();
  await sourceEditor.click();
  await sourceEditor.evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });
  await page.waitForTimeout(1_000);
  expect(descriptionPatches).toEqual([]);

  const unchangedRes = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
  expect(unchangedRes.ok(), await unchangedRes.text()).toBe(true);
  const unchanged = await unchangedRes.json() as { description: string | null; updatedAt: string };
  expect(unchanged.description).toBe(originalDescription);
  expect(unchanged.updatedAt).toBe(issue.updatedAt);

  await sourceEditor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(`${originalDescription} updated`);
  await sourceEditor.evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });

  await expect.poll(() => descriptionPatches.length).toBe(1);
  await expect.poll(async () => {
    const response = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
    expect(response.ok()).toBe(true);
    const updated = await response.json() as { description: string | null };
    return updated.description;
  }).toBe(`${originalDescription} updated`);
});

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
      description: "Opening paragraph\n\n- alpha\n- beta\n\n1. numbered",
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

  const bulletMarkers = editor.locator(
    ".rudder-cm-markdown-unordered-list-marker",
  );
  await expect(bulletMarkers).toHaveCount(2);
  await expect(bulletMarkers.first()).toHaveText("\u2022");
  await expect(editor.locator('[data-markdown-source-kind="list"]')
    .filter({ hasText: "1. numbered" })).toBeVisible();

  const openingPreview = editor
    .locator('[data-markdown-preview-state="preview"]')
    .filter({ hasText: "Opening paragraph" });
  await expect(openingPreview).toBeVisible();
  await openingPreview.dispatchEvent("mousedown", { button: 0 });
  await expect(
    editor
      .locator('[data-markdown-preview-state="source"]')
      .filter({ hasText: "Opening paragraph" }),
  ).toContainText("Opening paragraph");

  const alphaLine = editor
    .locator('[data-markdown-source-kind="list"]')
    .filter({ hasText: "alpha" });
  await alphaLine.getByText("alpha").click();
  await expect(alphaLine).toHaveAttribute("data-markdown-preview-state", "source");
  await expect(alphaLine.locator(
    ".rudder-cm-markdown-unordered-list-marker",
  )).toHaveText("\u2022");

  const exactDescription = "\nOpening paragraph  \n\nInserted paragraph\n\n- alpha\n- beta\n\n1. numbered\n";
  const sourceEditor = editor.locator(".cm-content");
  await sourceEditor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(exactDescription);
  await sourceEditor.evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });

  await page.getByRole("region", { name: "Issue properties" }).click();
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
  await expect(
    page.locator(
      ".rudder-issue-description-surface .rudder-cm-markdown-unordered-list-marker",
    ),
  ).toHaveCount(2);
  await page.screenshot({ path: "/tmp/rudder-issue-description-fixed.png", fullPage: false });
});

test("issue description images stay clickable while editing and open the global preview", async ({ page }) => {
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
  const issueAttachment = await issueAttachmentRes.json() as { id: string };

  const commentResponse = await page.request.post(`${E2E_BASE_URL}/api/issues/${issue.id}/comments`, {
    data: { body: "Delete confirmation comment evidence" },
  });
  expect(commentResponse.ok()).toBe(true);
  const comment = await commentResponse.json() as { id: string };

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

  const descriptionImage = descriptionEditor.getByRole("button", {
    name: "Open image preview: Description evidence",
  });
  await expect(descriptionImage).toBeVisible();
  await expect(descriptionImage.locator('img[alt="Description evidence"]')).toBeVisible();

  const previewDialog = page.getByTestId("markdown-body-image-preview-dialog");
  const previewImage = previewDialog.getByRole("img", { name: "Description evidence" });
  await descriptionImage.locator(".rudder-inspectable-image-overlay").click();
  await expect(previewDialog).toBeVisible();
  await expect(previewImage).toBeVisible();
  await expect(previewImage).toHaveAttribute(
    "src",
    new URL(attachment.contentPath, E2E_BASE_URL).toString(),
  );
  await expect.poll(() => previewImage.evaluate((image) => image.naturalWidth)).toBe(640);
  await expect.poll(() => previewImage.evaluate((image) => image.naturalHeight)).toBe(360);
  await expect(
    descriptionEditor.locator('[data-markdown-preview-state="source"]').filter({
      hasText: `![Description evidence](${attachment.contentPath})`,
    }),
  ).toHaveCount(0);
  await page.screenshot({ path: "/tmp/rudder-issue-description-inline-image-preview.png", fullPage: false });

  await previewDialog.getByRole("button", { name: "Close image preview" }).click();
  await expect(previewDialog).toHaveCount(0);
  await expect(descriptionImage).toBeVisible();

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
  await attachmentPreview.getByRole("button", { name: "Close image preview" }).click();

  let attachmentDeleteRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().endsWith(`/api/attachments/${issueAttachment.id}`)) {
      attachmentDeleteRequests += 1;
    }
  });
  const deleteAttachmentButton = attachmentName.locator("xpath=..").getByTitle("Delete attachment");

  await deleteAttachmentButton.click();
  let deleteDialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: 'Delete "issue-evidence.png"?' }),
  });
  await expect(deleteDialog).toContainText("This cannot be undone.");
  await deleteDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(attachmentName).toBeVisible();
  expect(attachmentDeleteRequests).toBe(0);

  await deleteAttachmentButton.click();
  deleteDialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: 'Delete "issue-evidence.png"?' }),
  });
  await page.keyboard.press("Escape");
  await expect(deleteDialog).toHaveCount(0);
  await expect(attachmentName).toBeVisible();
  expect(attachmentDeleteRequests).toBe(0);

  await deleteAttachmentButton.click();
  deleteDialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: 'Delete "issue-evidence.png"?' }),
  });
  const deleteAttachmentResponse = page.waitForResponse((response) =>
    response.request().method() === "DELETE"
    && response.url().endsWith(`/api/attachments/${issueAttachment.id}`)
    && response.ok(),
  );
  await deleteDialog.getByRole("button", { name: "Delete attachment" }).click({ clickCount: 2 });
  await deleteAttachmentResponse;
  await expect(attachmentName).toHaveCount(0);
  expect(attachmentDeleteRequests).toBe(1);

  const commentBody = page.getByText("Delete confirmation comment evidence", { exact: true });
  const issueRouteId = issue.identifier ?? issue.id;
  const commentActionsButton = page.getByRole("button", { name: "Comment actions", exact: true });
  await commentActionsButton.scrollIntoViewIfNeeded();
  const commentActionsHandle = await commentActionsButton.elementHandle();
  expect(commentActionsHandle).not.toBeNull();
  const openCommentActions = async () => {
    await commentActionsHandle!.dispatchEvent("pointerdown", { button: 0, ctrlKey: false, pointerType: "mouse" });
    await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeVisible();
  };
  let commentDeleteRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "DELETE"
      && request.url().endsWith(`/api/issues/${issueRouteId}/comments/${comment.id}`)
    ) {
      commentDeleteRequests += 1;
    }
  });

  await openCommentActions();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).dispatchEvent("click");
  let commentDialog = page.getByRole("dialog", { name: "Delete this comment?" });
  await expect(commentDialog).toContainText("permanently removes the comment from the issue");
  await commentDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(commentDialog).toHaveCount(0);
  await expect(commentBody).toBeVisible();
  expect(commentDeleteRequests).toBe(0);

  await openCommentActions();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).dispatchEvent("click");
  commentDialog = page.getByRole("dialog", { name: "Delete this comment?" });
  await page.keyboard.press("Escape");
  await expect(commentDialog).toHaveCount(0);
  await expect(commentBody).toBeVisible();
  expect(commentDeleteRequests).toBe(0);

  await openCommentActions();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).dispatchEvent("click");
  commentDialog = page.getByRole("dialog", { name: "Delete this comment?" });
  const commentDeleteResponse = page.waitForResponse((response) =>
    response.request().method() === "DELETE"
    && response.url().endsWith(`/api/issues/${issueRouteId}/comments/${comment.id}`)
    && response.ok(),
  );
  await commentDialog.getByRole("button", { name: "Delete comment" }).click({ clickCount: 2 });
  await commentDeleteResponse;
  await expect(commentBody).toHaveCount(0);
  await expect(page.getByText("Comment deleted")).toBeVisible();
  expect(commentDeleteRequests).toBe(1);
});
