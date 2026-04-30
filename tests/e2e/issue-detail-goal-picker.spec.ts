import { expect, test, type Page } from "@playwright/test";

type Organization = {
  id: string;
  issuePrefix: string;
};

type Goal = {
  id: string;
  title: string;
};

type Issue = {
  id: string;
  identifier: string | null;
  goalId: string | null;
};

async function fetchIssue(page: Page, issueId: string): Promise<Issue> {
  const response = await page.request.get(`/api/issues/${issueId}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Issue>;
}

test.describe("Issue detail goal picker", () => {
  test("moves an issue to another goal and restores it from the properties panel", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgResponse = await page.request.post("/api/orgs", {
      data: { name: `Issue-Detail-Goal-Picker-${Date.now()}` },
    });
    expect(orgResponse.ok()).toBe(true);
    const organization = await orgResponse.json() as Organization;

    const originalGoalResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Goal Center rollout",
        status: "active",
        level: "team",
      },
    });
    expect(originalGoalResponse.ok()).toBe(true);
    const originalGoal = await originalGoalResponse.json() as Goal;

    const alternateGoalResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Lifecycle controls hardening",
        status: "active",
        level: "team",
      },
    });
    expect(alternateGoalResponse.ok()).toBe(true);
    const alternateGoal = await alternateGoalResponse.json() as Goal;

    const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Verify issue goal picker reassignment",
        description: "QA should be able to move an issue between goals from the issue detail properties panel.",
        status: "todo",
        priority: "medium",
        goalId: originalGoal.id,
      },
    });
    expect(issueResponse.ok()).toBe(true);
    const issue = await issueResponse.json() as Issue;
    const issueRouteId = issue.identifier ?? issue.id;

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/issues/${issueRouteId}`);
    await expect(page.getByText("Properties", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: originalGoal.title, exact: true }).first()).toBeVisible();

    const switchToAlternateGoal = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().endsWith(`/api/issues/${issueRouteId}`)
      && response.ok(),
    );
    await page.getByRole("button", { name: originalGoal.title, exact: true }).first().click();
    await page.getByRole("button", { name: alternateGoal.title, exact: true }).click();
    await switchToAlternateGoal;

    await expect(page.getByRole("button", { name: alternateGoal.title, exact: true }).first()).toBeVisible();
    await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBe(alternateGoal.id);

    const restoreOriginalGoal = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().endsWith(`/api/issues/${issueRouteId}`)
      && response.ok(),
    );
    await page.getByRole("button", { name: alternateGoal.title, exact: true }).first().click();
    await page.getByRole("button", { name: originalGoal.title, exact: true }).click();
    await restoreOriginalGoal;

    await expect(page.getByRole("button", { name: originalGoal.title, exact: true }).first()).toBeVisible();
    await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBe(originalGoal.id);
  });
});
