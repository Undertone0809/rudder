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
  const response = await page.request.get(`/api/issues/${issueId}?_=${Date.now()}`, {
    headers: { "cache-control": "no-cache" },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Issue>;
}

async function expectGoalControlsHidden(page: Page) {
  const properties = page.getByRole("region", { name: "Issue properties" });
  await expect(properties).toBeVisible();
  await expect(properties.getByText("Goal", { exact: true })).toHaveCount(0);
  await expect(properties.locator('[aria-label^="Change goal:"]')).toHaveCount(0);
  await expect(properties.locator('[aria-label="Open goal"]')).toHaveCount(0);
}

test.describe("Issue detail goal properties", () => {
  test("hides Goal controls while preserving a linked issue goal", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgResponse = await page.request.post("/api/orgs", {
      data: { name: `Issue-Detail-Goal-Properties-${Date.now()}` },
    });
    expect(orgResponse.ok()).toBe(true);
    const organization = await orgResponse.json() as Organization;

    const goalResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Goal Center rollout",
        status: "active",
        level: "organization",
      },
    });
    expect(goalResponse.ok()).toBe(true);
    const goal = await goalResponse.json() as Goal;

    const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Verify hidden issue goal properties",
        description: "A linked Goal remains supported even when its Issue Properties entry is removed.",
        status: "todo",
        priority: "medium",
        goalId: goal.id,
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
    await expectGoalControlsHidden(page);
    await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBe(goal.id);

    const descriptionResponse = await page.request.patch(`/api/issues/${issueRouteId}`, {
      data: { description: "Editing other Issue fields must preserve the linked Goal." },
    });
    expect(descriptionResponse.ok()).toBe(true);
    await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBe(goal.id);

    await page.reload();
    await expectGoalControlsHidden(page);
    await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBe(goal.id);
  });

  for (const status of ["done", "blocked"] as const) {
    test(`hides Goal controls on ${status} issues without changing the relation`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto("/");

      const orgResponse = await page.request.post("/api/orgs", {
        data: { name: `Issue-Detail-${status}-Goal-Properties-${Date.now()}` },
      });
      expect(orgResponse.ok()).toBe(true);
      const organization = await orgResponse.json() as Organization;

      const goalResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
        data: {
          title: `Terminal issue goal ${status}`,
          status: "active",
          level: "organization",
        },
      });
      expect(goalResponse.ok()).toBe(true);
      const goal = await goalResponse.json() as Goal;

      const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
        data: {
          title: `Verify hidden Goal controls on ${status} issues`,
          description: "Terminal issue properties should not expose Goal controls.",
          status,
          priority: "medium",
          goalId: goal.id,
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

      await expectGoalControlsHidden(page);
      await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBe(goal.id);

      const nextStatus = status === "done" ? "blocked" : "done";
      const statusResponse = await page.request.patch(`/api/issues/${issueRouteId}`, {
        data: { status: nextStatus },
      });
      expect(statusResponse.ok()).toBe(true);
      await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBe(goal.id);
    });
  }
});
