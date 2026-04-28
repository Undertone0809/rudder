import { expect, test } from "@playwright/test";

test.describe("Issue detail breadcrumb", () => {
  test("keeps the source list in the header breadcrumb and returns there on Escape", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-Detail-Breadcrumb-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Breadcrumb navigation should preserve source context",
        description: "Issue detail should expose a clickable source breadcrumb and support Escape back.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    const searchQuery = "Breadcrumb navigation should preserve source context";
    await page.goto(`/issues?q=${encodeURIComponent(searchQuery)}`);

    const issueLink = page.getByRole("link", { name: issue.title }).first();
    await expect(issueLink).toBeVisible({ timeout: 15_000 });
    await issueLink.click();

    await expect(page).toHaveURL(new RegExp(`/issues/${issue.identifier ?? issue.id}$`));

    const breadcrumb = page.getByTestId("issue-detail-breadcrumb");
    const sourceLink = breadcrumb.getByRole("link", { name: "Issues" });
    await expect(sourceLink).toBeVisible();
    await expect(sourceLink).toHaveAttribute("href", new RegExp(`/issues\\?q=${encodeURIComponent(searchQuery)}`));

    await sourceLink.click();
    await expect(page).toHaveURL(new RegExp(`/issues\\?q=${encodeURIComponent(searchQuery)}`));

    await expect(issueLink).toBeVisible({ timeout: 15_000 });
    await issueLink.click();
    await expect(page).toHaveURL(new RegExp(`/issues/${issue.identifier ?? issue.id}$`));

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/issues\\?q=${encodeURIComponent(searchQuery)}`));
  });
});
