import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto(E2E_BASE_URL);
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

function waitForIssueSearch(page: Page, orgId: string, query: string) {
  const encodedQuery = encodeURIComponent(query);
  return page.waitForResponse((response) => {
    const url = response.url();
    return response.request().method() === "GET"
      && url.includes(`${E2E_BASE_URL}/api/orgs/${orgId}/issues`)
      && url.includes(`q=${encodedQuery}`);
  });
}

test.describe("Issue search filters", () => {
  test("defaults to title search and expands to description or comments when selected", async ({ page }) => {
    await page.goto(E2E_BASE_URL);

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Issue-Search-Filters-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const titleIssueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Title scope search-token-title",
        status: "todo",
        priority: "medium",
      },
    });
    expect(titleIssueRes.ok()).toBe(true);

    const descriptionIssueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Description scope issue",
        description: "Only the description has search-token-description.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(descriptionIssueRes.ok()).toBe(true);

    const commentIssueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Comment scope issue",
        status: "todo",
        priority: "medium",
      },
    });
    expect(commentIssueRes.ok()).toBe(true);
    const commentIssue = await commentIssueRes.json() as { id: string };

    const commentRes = await page.request.post(`${E2E_BASE_URL}/api/issues/${commentIssue.id}/comments`, {
      data: { body: "Only the comment has search-token-comment." },
    });
    expect(commentRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);
    await page.getByTitle("List view").click();

    const searchBox = page.getByRole("textbox", { name: "Search issues" });
    await searchBox.click();
    await expect(page.getByText("Search in", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Title" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Description" })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Comments" })).not.toBeChecked();

    await Promise.all([
      waitForIssueSearch(page, organization.id, "search-token-title"),
      searchBox.fill("search-token-title"),
    ]);
    await expect(page.getByText("Title scope search-token-title", { exact: true })).toBeVisible();

    await Promise.all([
      waitForIssueSearch(page, organization.id, "search-token-description"),
      searchBox.fill("search-token-description"),
    ]);
    await expect(page.getByText("Description scope issue", { exact: true })).toHaveCount(0);

    await Promise.all([
      waitForIssueSearch(page, organization.id, "search-token-description"),
      page.getByRole("checkbox", { name: "Description" }).click(),
    ]);
    await expect(page.getByText("Description scope issue", { exact: true })).toBeVisible();

    await page.getByRole("checkbox", { name: "Description" }).click();
    await Promise.all([
      waitForIssueSearch(page, organization.id, "search-token-comment"),
      page.getByRole("checkbox", { name: "Comments" }).click(),
      searchBox.fill("search-token-comment"),
    ]);
    await expect(page.getByText("Comment scope issue", { exact: true })).toBeVisible();
  });
});
