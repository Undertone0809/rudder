import { expect, test } from "@playwright/test";

test.describe("Issue detail breadcrumb", () => {
  test("uses the default breadcrumb fallback on Escape when opened directly", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-Detail-Direct-Escape-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Direct issue detail Escape should return to Issues",
        description: "Direct issue detail loads should still have a usable Escape fallback.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await page.addInitScript((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    await expect(page.getByRole("heading", { name: issue.title })).toBeVisible({ timeout: 15_000 });

    const sourceLink = page.getByTestId("issue-detail-breadcrumb").getByRole("link", { name: "Issues", exact: true });
    await expect(sourceLink).toBeVisible();
    await expect(sourceLink).toHaveAttribute("href", /\/issues$/);

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/issues$/);

    await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    await expect(page.getByRole("heading", { name: issue.title })).toBeVisible({ timeout: 15_000 });
    const emptyCommentEditor = page.locator(".chat-composer [contenteditable='true']").first();
    await expect(emptyCommentEditor).toBeVisible({ timeout: 15_000 });
    await emptyCommentEditor.click();

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/issues$`));
  });

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

    const mainContent = page.locator("#main-content");
    const issueLink = mainContent.getByRole("link", { name: issue.title }).first();
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
    await expect(page.getByTestId("issue-detail-breadcrumb").getByRole("link", { name: "Issues" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/issues\\?q=${encodeURIComponent(searchQuery)}`));
  });

  test("returns to the Messenger stack entry on Escape after opening an issue from Messenger", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });

    const sessionRes = await page.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-Detail-Messenger-Escape-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Messenger issue Escape should use browser stack",
        description: "Opening an issue from Messenger should return to Messenger on Escape.",
        status: "todo",
        priority: "medium",
        assigneeUserId: currentUserId,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const updateRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: {
        status: "blocked",
      },
    });
    expect(updateRes.ok()).toBe(true);

    await page.addInitScript((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/issues`, { waitUntil: "commit" });
    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("heading", { name: "Issues" })).toBeVisible({ timeout: 15_000 });
    const issueCard = page.locator(`[data-testid="messenger-issue-card-${issue.id}"]`);
    await expect(issueCard).toContainText(issue.title, { timeout: 15_000 });

    await issueCard.getByRole("link", { name: "Open issue" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}$`));
    await expect(page.getByRole("heading", { name: issue.title })).toBeVisible({ timeout: 15_000 });

    await page.locator("#main-content").focus();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/issues$`));
    await expect(mainContent.getByRole("heading", { name: "Issues" })).toBeVisible({ timeout: 15_000 });
  });
});
