import { expect, test } from "@playwright/test";

test.describe("Issue navigation memory", () => {
  test("falls back to all issues when no remembered issue view exists", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Issue-Nav-Default-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.removeItem(`rudder:issue-navigation:${orgId}`);
    }, organization.id);

    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Issue" }).click();

    await expect(page).toHaveURL(/\/issues$/);
    await expect(page.getByRole("link", { name: "All Issues" })).toBeVisible();
  });

  test("reopens the remembered issue view for the active organization", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Issue-Nav-Remembered-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem(
        `rudder:issue-navigation:${orgId}`,
        JSON.stringify({ scope: "assigned" }),
      );
    }, organization.id);

    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Issue" }).click();

    await expect(page).toHaveURL(/\/issues\?scope=assigned$/);
    await expect(page.getByRole("link", { name: "Assigned to Me" })).toBeVisible();
  });

  test("returns to the last issue detail after switching away through the primary rail", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Issue-Nav-Detail-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Primary rail should remember this issue detail",
        description: "Switching primary rail sections should preserve the last issue detail route.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier: string | null; title: string };
    const issueRef = issue.identifier ?? issue.id;

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/issues/${issueRef}`);
    await expect(page.getByRole("heading", { name: issue.title })).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("primary-rail").getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/dashboard$`));

    await page.getByTestId("primary-rail").getByRole("link", { name: "Issue" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/issues/${issueRef}$`));
    await expect(page.getByRole("heading", { name: issue.title })).toBeVisible({ timeout: 15_000 });
  });

  test("marks shared buttons and issue links as non-draggable", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Issue-Nav-NoDrag-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: "Issue" })).toHaveAttribute("draggable", "false");
    await expect(page.getByRole("button", { name: "Search" })).toHaveAttribute("draggable", "false");

    await page.goto("/issues");
    await expect(page.getByRole("link", { name: "Assigned to Me" })).toHaveAttribute("draggable", "false");
  });
});
