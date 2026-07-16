import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

async function placeCaretAtParagraphEnd(page: Page, paragraph: Locator) {
  const placementTarget = await paragraph.evaluate((element) => {
    const textNode = element.lastChild;
    if (!(textNode instanceof Text) || textNode.length === 0) {
      throw new Error("Expected paragraph to end with a text node");
    }
    const range = document.createRange();
    range.setStart(textNode, textNode.length - 1);
    range.setEnd(textNode, textNode.length);
    const rect = range.getBoundingClientRect();
    const paragraphRect = element.getBoundingClientRect();
    return {
      textLength: textNode.length,
      x: rect.left - paragraphRect.left,
      width: rect.width,
      y: rect.top - paragraphRect.top + rect.height / 2,
    };
  });
  const fractions = [0.55, 0.7, 0.85];
  for (const fraction of fractions) {
    await paragraph.click({
      position: {
        x: placementTarget.x + placementTarget.width * fraction,
        y: placementTarget.y,
      },
    });
    const offset = await paragraph.evaluate((element) => {
      const textNode = element.lastChild;
      const selection = window.getSelection();
      return textNode instanceof Text && selection?.anchorNode === textNode
        ? selection.anchorOffset
        : null;
    });
    if (offset !== placementTarget.textLength) continue;
    await page.waitForTimeout(100);
    const settledOffset = await paragraph.evaluate((element) => {
      const textNode = element.lastChild;
      const selection = window.getSelection();
      return textNode instanceof Text && selection?.anchorNode === textNode
        ? selection.anchorOffset
        : null;
    });
    if (settledOffset === placementTarget.textLength) return;
  }
  await paragraph.click({
    position: {
      x: placementTarget.x + Math.min(0.25, placementTarget.width / 10),
      y: placementTarget.y,
    },
  });
  const fallbackOffset = await paragraph.evaluate((element) => {
    const textNode = element.lastChild;
    const selection = window.getSelection();
    return textNode instanceof Text && selection?.anchorNode === textNode
      ? selection.anchorOffset
      : null;
  });
  if (fallbackOffset === placementTarget.textLength - 1) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
    const settledOffset = await paragraph.evaluate((element) => {
      const textNode = element.lastChild;
      const selection = window.getSelection();
      return textNode instanceof Text && selection?.anchorNode === textNode
        ? selection.anchorOffset
        : null;
    });
    if (settledOffset === placementTarget.textLength) return;
  }
  throw new Error("Failed to settle caret at paragraph end");
}

async function blurIssueDescription(page: Page) {
  const propertiesLabel = page
    .getByRole("region", { name: "Issue properties" })
    .getByText("Properties", { exact: true });
  await expect(propertiesLabel).toHaveCount(1);
  await propertiesLabel.click();
}

test("issue descriptions keep the Library-style editor, Enter behavior, and image preview", async ({ page }) => {
  test.setTimeout(120_000);

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
  await expect(descriptionImage).toHaveCount(1);
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
  await expect(previewDialog).toBeHidden();
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);

  const firstParagraph = descriptionEditor.getByText("Inspect this screenshot:", { exact: true });
  await placeCaretAtParagraphEnd(page, firstParagraph);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Enter creates a new paragraph");
  await expect(descriptionEditor.getByText("Enter creates a new paragraph", { exact: true })).toBeVisible();
  await expect(descriptionEditor.locator("p", { hasText: "Enter creates a new paragraph" })).toHaveCount(1);
  await expect(descriptionImage).toBeVisible();

  await blurIssueDescription(page);

  await expect.poll(async () => {
    const response = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
    expect(response.ok()).toBe(true);
    const updatedIssue = await response.json() as { description: string | null };
    return updatedIssue.description;
  }).toContain("Enter creates a new paragraph");

  const persistedIssueRes = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
  const persistedIssue = await persistedIssueRes.json() as { description: string | null };
  expect(persistedIssue.description).toContain(`![Description evidence](${attachment.contentPath})`);

  const listDescriptionRes = await page.request.patch(`${E2E_BASE_URL}/api/issues/${issue.id}`, {
    data: {
      description: `${persistedIssue.description ?? ""}\n\n- alpha`,
    },
  });
  expect(listDescriptionRes.ok()).toBe(true);
  await page.reload();

  const alphaListParagraph = descriptionEditor.locator("li > p", { hasText: "alpha" });
  await expect(alphaListParagraph).toHaveCount(1);
  await placeCaretAtParagraphEnd(page, alphaListParagraph);
  await page.keyboard.press("Enter");
  await page.keyboard.type("beta", { delay: 80 });
  await expect(descriptionEditor.locator("li > p", { hasText: "alpha" })).toHaveCount(1);
  await expect(descriptionEditor.locator("li > p", { hasText: "beta" })).toHaveCount(1);
  await blurIssueDescription(page);

  await expect.poll(async () => {
    const response = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
    expect(response.ok()).toBe(true);
    const updatedIssue = await response.json() as { description: string | null };
    return updatedIssue.description;
  }).toMatch(/(?:^|\n)[*-] alpha\n(?:\n)?[*-] beta(?:\n|$)/);

  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/messenger/issues/${issue.identifier ?? issue.id}`);

  const messengerDescriptionEditor = page.locator(".rudder-issue-description-markdown .ProseMirror");
  await expect(messengerDescriptionEditor).toBeVisible();
  await expect(page.locator(".rudder-issue-description-markdown-read")).toHaveCount(0);
  await expect(messengerDescriptionEditor.getByText("Enter creates a new paragraph", { exact: true })).toBeVisible();

  const messengerDescriptionImage = messengerDescriptionEditor.locator('img[alt="Description evidence"]:visible');
  await expect(messengerDescriptionImage).toHaveCount(1);
  await expect(messengerDescriptionImage).toBeVisible();

  const messengerFirstParagraph = messengerDescriptionEditor.getByText("Inspect this screenshot:", { exact: true });
  await placeCaretAtParagraphEnd(page, messengerFirstParagraph);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Messenger Enter creates a new paragraph");
  await expect(messengerDescriptionEditor.getByText("Messenger Enter creates a new paragraph", { exact: true })).toBeVisible();
  await expect(messengerDescriptionImage).toBeVisible();
  await blurIssueDescription(page);

  await expect.poll(async () => {
    const response = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
    expect(response.ok()).toBe(true);
    const updatedIssue = await response.json() as { description: string | null };
    return updatedIssue.description;
  }).toContain("Messenger Enter creates a new paragraph");

  const messengerPersistedIssueRes = await page.request.get(`${E2E_BASE_URL}/api/issues/${issue.id}`);
  const messengerPersistedIssue = await messengerPersistedIssueRes.json() as { description: string | null };
  expect(messengerPersistedIssue.description).toContain(`![Description evidence](${attachment.contentPath})`);

  await messengerDescriptionImage.dblclick();
  await expect(previewDialog).toBeVisible();
  await expect(previewDialog.getByAltText("Description evidence")).toBeVisible();
});
