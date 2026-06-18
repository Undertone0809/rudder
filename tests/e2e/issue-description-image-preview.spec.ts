import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test("issue description markdown images open a preview on double click", async ({ page }) => {
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

  const descriptionImage = page.locator(".rudder-milkdown-content img").first();
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
  expect(previewMetrics.renderedWidth).toBeGreaterThan(600);
  expect(previewMetrics.renderedHeight).toBeGreaterThan(330);
  expect(previewMetrics.ratioDelta).toBeLessThan(0.01);
});
