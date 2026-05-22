import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test("issue comment markdown images expose preview and image actions", async ({ page }) => {
  const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `Issue-Comment-Images-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Comment image actions",
      description: "Comments should make image evidence easy to inspect.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  await page.goto(E2E_BASE_URL);
  const imageDataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to create canvas context for issue comment image test");
    }
    context.fillStyle = "#f8fafc";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#0f172a";
    context.fillRect(24, 24, canvas.width - 48, canvas.height - 48);
    context.fillStyle = "#38bdf8";
    context.font = "bold 34px sans-serif";
    context.fillText("Evidence", 104, 102);
    return canvas.toDataURL("image/png");
  });

  const commentRes = await page.request.post(`${E2E_BASE_URL}/api/issues/${issue.id}/comments`, {
    data: {
      body: `Validation screenshot:\n\n![Evidence screenshot](${imageDataUrl})`,
    },
  });
  expect(commentRes.ok()).toBe(true);

  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1360, height: 920 });
  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

  const commentImage = page.locator(".rudder-inspectable-image-trigger").first();
  await expect(commentImage).toBeVisible();
  await commentImage.hover();
  await expect(commentImage.locator(".rudder-inspectable-image-overlay")).toBeVisible();

  await commentImage.click();
  const previewDialog = page.getByTestId("markdown-body-image-preview-dialog");
  await expect(previewDialog).toBeVisible();
  await expect(previewDialog.getByRole("button", { name: "Open Image" })).toBeVisible();
  await expect(previewDialog.getByRole("button", { name: "Copy Image" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(previewDialog).toBeHidden();

  await commentImage.click({ button: "right" });
  const contextMenu = page.getByTestId("markdown-image-context-menu");
  await expect(contextMenu).toBeVisible();
  await expect(contextMenu.getByRole("menuitem", { name: "Open Image" })).toBeVisible();
  await expect(contextMenu.getByRole("menuitem", { name: "Copy Image" })).toBeVisible();
});
