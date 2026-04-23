import { expect, test, type Page } from "@playwright/test";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.describe("Issues inline assignee picker", () => {
  test("allows assigning an unassigned issue from the issues list", async ({ page }) => {
    test.slow();

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Issues-Inline-Assignee-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Alice Agent",
        role: "general",
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Inline assign me from list",
        description: "Unassigned issues should open the assignee picker directly from the list row.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await selectOrganization(page, organization.id);
    await page.goto("/issues");

    const issueTitle = page.getByText("Inline assign me from list", { exact: true });
    await expect(issueTitle).toBeVisible({ timeout: 20_000 });

    const issueRow = issueTitle.locator("xpath=ancestor::a[1]");
    const assigneeTrigger = issueRow.getByRole("button", { name: "Assignee", exact: true });
    await expect(assigneeTrigger).toBeVisible();

    await assigneeTrigger.click();

    await expect(page).toHaveURL(/\/issues(?:\?[^#]*)?$/);
    await expect(page.getByPlaceholder("Search assignees...")).toBeVisible();

    const updateResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/api/issues/${issue.id}`) &&
      response.ok(),
    );
    await page.getByText("Alice Agent", { exact: true }).click();
    await updateResponse;

    await expect(issueRow).toContainText("Alice Agent");

    const refreshedIssueRes = await page.request.get(`/api/issues/${issue.id}`);
    expect(refreshedIssueRes.ok()).toBe(true);
    const refreshedIssue = await refreshedIssueRes.json();
    expect(refreshedIssue.assigneeAgentId).toBe(agent.id);
  });
});
