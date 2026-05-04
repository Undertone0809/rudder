import { expect, test } from "@playwright/test";

test("markdown editor links use the compact preview and edit popover", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Markdown-Link-Popover-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Link popover issue",
      description: "Reference: [Acontext](https://docs.acontext.io/store/skill)",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

  const editorLink = page
    .locator('.rudder-mdxeditor-content a[href="https://docs.acontext.io/store/skill"]')
    .first();
  await expect(editorLink).toBeVisible({ timeout: 15_000 });
  await editorLink.click();

  const popover = page.locator('[class*="_linkDialogPopoverContent_"]').first();
  await expect(popover).toBeVisible();
  await expect(popover.getByText("https://docs.acontext.io/store/skill")).toBeVisible();
  await expect(popover.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(popover.getByRole("button", { name: "Copy link" })).toBeVisible();

  const previewMetrics = await popover.evaluate((element) => {
    const styles = window.getComputedStyle(element);
    return {
      display: styles.display,
      borderRadius: Number.parseFloat(styles.borderRadius),
      height: element.getBoundingClientRect().height,
    };
  });
  expect(previewMetrics.display).toBe("flex");
  expect(previewMetrics.borderRadius).toBeGreaterThanOrEqual(8);
  expect(previewMetrics.height).toBeLessThan(48);

  await popover.getByRole("button", { name: "Edit" }).click();
  await expect(popover.getByText("Page or URL")).toBeVisible();
  await expect(popover.getByText("Link title")).toBeVisible();
  await expect(popover.getByRole("button", { name: "Done" })).toBeVisible();
  await expect(popover.getByRole("button", { name: "Cancel" })).toBeVisible();

  const editMetrics = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    return {
      alignItems: styles.alignItems,
      width: rect.width,
      height: rect.height,
    };
  });
  expect(editMetrics.alignItems).toBe("stretch");
  expect(editMetrics.width).toBeGreaterThan(420);
  expect(editMetrics.height).toBeGreaterThan(150);
});
