import { expect, test, type Page } from "@playwright/test";

function recentIssuesStorageKey(orgId: string): string {
  return `rudder:recent-issues:${orgId}`;
}

async function createOrganization(page: Page, name: string) {
  const response = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function createIssue(page: Page, orgId: string, title: string) {
  const response = await page.request.post(`/api/orgs/${orgId}/issues`, {
    data: {
      title,
      description: `${title} description`,
      status: "todo",
      priority: "medium",
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ id: string; identifier?: string | null; title: string }>;
}

async function seedRecentIssues(page: Page, orgId: string, issueIds: string[]) {
  await page.goto("/");
  await page.evaluate(
    ({ selectedOrgId, recentKey, recentIssueIds }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
      window.localStorage.setItem(recentKey, JSON.stringify(recentIssueIds));
    },
    {
      selectedOrgId: orgId,
      recentKey: recentIssuesStorageKey(orgId),
      recentIssueIds: issueIds,
    },
  );
}

test.describe("Issues recently viewed sidebar", () => {
  test("shows current-org recent issues in the sidebar without turning recent into a main view", async ({ page }) => {
    const organization = await createOrganization(page, "Issues-Recently-Viewed");
    const otherOrganization = await createOrganization(page, "Issues-Recently-Viewed-Other");

    const firstIssue = await createIssue(page, organization.id, "Recently viewed first issue");
    const secondIssue = await createIssue(page, organization.id, "Recently viewed second issue");
    const thirdIssue = await createIssue(page, organization.id, "Recently viewed third issue");
    const nonRecentIssue = await createIssue(page, organization.id, "Normal workspace issue");
    const otherOrgIssue = await createIssue(page, otherOrganization.id, "Other organization recent issue");

    await seedRecentIssues(page, organization.id, [
      otherOrgIssue.id,
      thirdIssue.id,
      "missing-issue-id",
      firstIssue.id,
      thirdIssue.id,
      secondIssue.id,
    ]);

    await page.goto("/issues?scope=recent");

    await expect(page).toHaveURL(/\/issues$/);
    await expect(page.getByRole("link", { name: /Recently Viewed \(/ })).toHaveCount(0);
    await expect(page.getByTestId("issue-recent-section")).toContainText("Recently Viewed");
    await expect(page.getByTestId(`issue-recent-row-${firstIssue.id}`)).toContainText("Recently viewed first issue");
    await expect(page.getByTestId(`issue-recent-row-${secondIssue.id}`)).toContainText("Recently viewed second issue");
    await expect(page.getByTestId(`issue-recent-row-${thirdIssue.id}`)).toContainText("Recently viewed third issue");
    await expect(page.getByText("Other organization recent issue", { exact: true })).toHaveCount(0);

    await expect(page.getByText("Normal workspace issue", { exact: true })).toBeVisible();

    const recentHref = `/issues/${firstIssue.identifier ?? firstIssue.id}`;
    await expect(page.getByTestId(`issue-recent-row-${firstIssue.id}`)).toHaveAttribute("href", recentHref);
  });

  test("records direct detail views and promotes sidebar recent clicks", async ({ page }) => {
    const organization = await createOrganization(page, "Issues-Recent-Detail");
    const firstIssue = await createIssue(page, organization.id, "Direct detail recent issue");
    const secondIssue = await createIssue(page, organization.id, "Sidebar promoted recent issue");
    const recentKey = recentIssuesStorageKey(organization.id);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/issues/${firstIssue.identifier ?? firstIssue.id}`);
    await expect(page.getByText("Direct detail recent issue", { exact: true }).first()).toBeVisible();
    await page.waitForFunction(
      ({ key, issueId }) => {
        const values = JSON.parse(window.localStorage.getItem(key) ?? "[]");
        return values[0] === issueId;
      },
      { key: recentKey, issueId: firstIssue.id },
    );

    await page.goto("/issues");
    await expect(page.getByTestId(`issue-recent-row-${firstIssue.id}`)).toContainText("Direct detail recent issue");

    await page.evaluate(
      ({ key, issueIds }) => {
        window.localStorage.setItem(key, JSON.stringify(issueIds));
      },
      { key: recentKey, issueIds: [firstIssue.id, secondIssue.id] },
    );
    await page.goto("/issues");
    await page.getByTestId(`issue-recent-row-${secondIssue.id}`).click();
    await page.waitForFunction(
      ({ key, issueId }) => {
        const values = JSON.parse(window.localStorage.getItem(key) ?? "[]");
        return values[0] === issueId;
      },
      { key: recentKey, issueId: secondIssue.id },
    );
  });

  test("updates the recent issue sidebar when the active organization changes", async ({ page }) => {
    const firstOrganization = await createOrganization(page, "Issues-Recent-Switch-A");
    const secondOrganization = await createOrganization(page, "Issues-Recent-Switch-B");

    const firstOrgIssue = await createIssue(page, firstOrganization.id, "Org one recent issue");
    const secondOrgIssueA = await createIssue(page, secondOrganization.id, "Org two first recent issue");
    const secondOrgIssueB = await createIssue(page, secondOrganization.id, "Org two second recent issue");

    await page.goto("/");
    await page.evaluate(
      ({ orgA, keyA, keyB, issueA, issueB1, issueB2 }) => {
        window.localStorage.setItem("rudder.selectedOrganizationId", orgA);
        window.localStorage.setItem(keyA, JSON.stringify([issueA]));
        window.localStorage.setItem(keyB, JSON.stringify([issueB2, issueB1]));
      },
      {
        orgA: firstOrganization.id,
        keyA: recentIssuesStorageKey(firstOrganization.id),
        keyB: recentIssuesStorageKey(secondOrganization.id),
        issueA: firstOrgIssue.id,
        issueB1: secondOrgIssueA.id,
        issueB2: secondOrgIssueB.id,
      },
    );

    await page.goto("/issues");

    await expect(page.getByTestId("issue-recent-section")).toBeVisible();
    await expect(page.getByTestId(`issue-recent-row-${firstOrgIssue.id}`)).toContainText("Org one recent issue");
    await expect(page.getByText("Org two first recent issue", { exact: true })).toHaveCount(0);

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, secondOrganization.id);

    await page.goto("/issues");

    await expect(page.getByTestId(`issue-recent-row-${secondOrgIssueA.id}`)).toContainText("Org two first recent issue");
    await expect(page.getByTestId(`issue-recent-row-${secondOrgIssueB.id}`)).toContainText("Org two second recent issue");
    await expect(page.getByText("Org one recent issue", { exact: true })).toHaveCount(0);
  });

  test("bounds long recent histories so project slices remain reachable", async ({ page }) => {
    const organization = await createOrganization(page, "Issues-Recent-Bounds");
    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Sidebar Project",
        description: "Project should remain reachable below recent history.",
        color: "blue",
      },
    });
    expect(projectRes.ok()).toBe(true);

    const issues = [];
    for (let index = 1; index <= 13; index += 1) {
      issues.push(await createIssue(page, organization.id, `Recent overflow issue ${String(index).padStart(2, "0")}`));
    }

    await seedRecentIssues(page, organization.id, issues.map((issue) => issue.id));
    await page.goto("/issues");

    await expect(page.getByTestId(`issue-recent-row-${issues[0].id}`)).toBeVisible();
    await expect(page.getByTestId(`issue-recent-row-${issues[4].id}`)).toBeVisible();
    await expect(page.getByTestId(`issue-recent-row-${issues[5].id}`)).toHaveCount(0);
    await expect(page.getByTestId("workspace-projects-section")).toContainText("Projects");
    await expect(page.getByRole("link", { name: /Sidebar Project/ })).toBeVisible();

    await expect(page.getByTestId("issue-recent-toggle")).toContainText("Show 7 more");
    await page.getByTestId("issue-recent-toggle").click();

    await expect(page.getByTestId(`issue-recent-row-${issues[11].id}`)).toBeVisible();
    await expect(page.getByTestId(`issue-recent-row-${issues[12].id}`)).toHaveCount(0);
    await expect(page.getByText("Showing latest 12 of 13")).toBeVisible();
    await expect(page.getByRole("link", { name: /Sidebar Project/ })).toBeVisible();
  });
});
