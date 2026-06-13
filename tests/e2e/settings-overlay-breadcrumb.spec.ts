import { expect, test } from "@playwright/test";

test.describe("Settings overlay breadcrumbs", () => {
  test("keeps the background issue breadcrumb while settings is open as an overlay", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Settings Breadcrumb ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Multi-reviewer design",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { identifier: string };

    await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier}`);

    const breadcrumb = page.getByTestId("issue-detail-breadcrumb");
    await expect(breadcrumb).toContainText("Issues");
    await expect(breadcrumb).toContainText(`${issue.identifier} Multi-reviewer design`);

    await page.getByRole("button", { name: "System settings" }).click();

    await expect(page.getByTestId("settings-modal-shell")).toBeVisible();
    await expect(breadcrumb).toContainText("Issues");
    await expect(breadcrumb).toContainText(`${issue.identifier} Multi-reviewer design`);
    await expect(breadcrumb).not.toContainText("System settings");
  });
});
