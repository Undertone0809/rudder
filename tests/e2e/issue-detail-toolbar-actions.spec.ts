import { expect, test } from "@playwright/test";

const ORG_NAME = `Issue-Detail-Toolbar-${Date.now()}`;

test.describe("Issue detail toolbar actions", () => {
  test("keeps desktop issue actions consolidated into a single right-side group", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: ORG_NAME },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue actions should not repeat",
        description: "Desktop issue detail should keep repeated actions in one place.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);

    await expect(page.getByRole("button", { name: "Copy ID" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Chat" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "More issue actions" })).toHaveCount(1);
    await expect(page.getByText("Properties", { exact: true })).toBeVisible();
  });

  test("shows default labels for issues in newly created organizations", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `${ORG_NAME}-Labels` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Label defaults should be seeded",
        description: "New organizations should expose built-in issue labels immediately.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);

    await page.getByRole("button", { name: /No labels/i }).click();

    await expect(page.getByPlaceholder("Search labels...")).toBeVisible();
    await expect(page.getByRole("button", { name: "Bug", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Feature", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "UI", exact: true })).toBeVisible();
  });

  test("uses a search-first label picker with inline create results", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `${ORG_NAME}-Inline-Create` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Label picker should inline create",
        description: "Issue detail should create labels from search results, not a footer form.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    await page.getByRole("button", { name: /No labels/i }).click();

    await expect(page.getByRole("button", { name: /^Create label "/ })).toHaveCount(0);
    await expect(page.locator('button[title^="Delete "]')).toHaveCount(0);

    const searchInput = page.getByPlaceholder("Search labels...");
    await searchInput.fill("Customer escalation");
    await expect(page.getByRole("button", { name: 'Create label "Customer escalation"' })).toBeVisible();

    const createLabelResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/orgs/${organization.id}/labels`) &&
      response.ok(),
    );
    const patchIssueResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      /\/api\/issues\/[^/]+$/.test(response.url()) &&
      response.ok(),
    );
    await page.getByRole("button", { name: 'Create label "Customer escalation"' }).click();
    await createLabelResponse;
    await patchIssueResponse;

    await expect(page.getByText("Customer escalation", { exact: true })).toBeVisible();
  });
});
