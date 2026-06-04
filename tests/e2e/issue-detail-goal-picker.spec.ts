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

type ActivityEvent = {
  action: string;
  details: Record<string, unknown> | null;
};

async function fetchIssue(page: Page, issueId: string): Promise<Issue> {
  const response = await page.request.get(`/api/issues/${issueId}?_=${Date.now()}`, {
    headers: { "cache-control": "no-cache" },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Issue>;
}

async function fetchIssueActivity(page: Page, issueId: string): Promise<ActivityEvent[]> {
  const response = await page.request.get(`/api/issues/${issueId}/activity?_=${Date.now()}`, {
    headers: { "cache-control": "no-cache" },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<ActivityEvent[]>;
}

async function goalUpdateActivityCount(page: Page, issueId: string): Promise<number> {
  return (await fetchIssueActivity(page, issueId))
    .filter((event) => event.action === "issue.updated" && event.details && "goalId" in event.details)
    .length;
}

test.describe("Issue detail goal picker", () => {
  test("moves, clears, and preserves issue goals from the properties panel", async ({ page }) => {
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
        level: "organization",
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
    await expect(page.getByRole("button", { name: `Change goal: ${originalGoal.title}` }).first()).toBeVisible();

    const switchToAlternateGoal = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().endsWith(`/api/issues/${issueRouteId}`)
      && response.ok(),
    );
    await page.getByRole("button", { name: `Change goal: ${originalGoal.title}` }).first().click();
    await page.getByRole("button", { name: alternateGoal.title, exact: true }).click();
    await switchToAlternateGoal;

    await expect(page.getByRole("button", { name: `Change goal: ${alternateGoal.title}` }).first()).toBeVisible();
    await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBe(alternateGoal.id);

    const restoreOriginalGoal = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().endsWith(`/api/issues/${issueRouteId}`)
      && response.ok(),
    );
    await page.getByRole("button", { name: `Change goal: ${alternateGoal.title}` }).first().click();
    await page.getByRole("button", { name: originalGoal.title, exact: true }).click();
    await restoreOriginalGoal;

    await expect(page.getByRole("button", { name: `Change goal: ${originalGoal.title}` }).first()).toBeVisible();
    await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBe(originalGoal.id);

    const clearGoal = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().endsWith(`/api/issues/${issueRouteId}`)
      && response.ok(),
    );
    await page.getByRole("button", { name: `Change goal: ${originalGoal.title}` }).first().click();
    await page.getByRole("button", { name: "No goal", exact: true }).click();
    await clearGoal;

    await expect(page.getByRole("button", { name: "Change goal: No goal" }).first()).toBeVisible();
    await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBeNull();

    const goalActivityCountAfterClear = await goalUpdateActivityCount(page, issue.id);

    const descriptionResponse = await page.request.patch(`/api/issues/${issueRouteId}`, {
      data: { description: "Description edits must not restore a cleared default goal." },
    });
    expect(descriptionResponse.ok()).toBe(true);

    await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBeNull();
    await expect.poll(async () => goalUpdateActivityCount(page, issue.id)).toBe(goalActivityCountAfterClear);

    const noProjectResponse = await page.request.patch(`/api/issues/${issueRouteId}`, {
      data: { projectId: null },
    });
    expect(noProjectResponse.ok()).toBe(true);

    await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBeNull();
    await expect.poll(async () => goalUpdateActivityCount(page, issue.id)).toBe(goalActivityCountAfterClear);

    await page.reload();
    await expect(page.getByRole("button", { name: "Change goal: No goal" }).first()).toBeVisible();
    await expect(page.getByText("updated the description, set the goal")).toHaveCount(0);
  });

  for (const status of ["done", "blocked"] as const) {
    test(`keeps a cleared goal empty on ${status} issue status edits`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto("/");

      const orgResponse = await page.request.post("/api/orgs", {
        data: { name: `Issue-Detail-Terminal-Goal-${status}-${Date.now()}` },
      });
      expect(orgResponse.ok()).toBe(true);
      const organization = await orgResponse.json() as Organization;

      const defaultGoalResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
        data: {
          title: `Default terminal goal ${status}`,
          status: "active",
          level: "organization",
        },
      });
      expect(defaultGoalResponse.ok()).toBe(true);
      const defaultGoal = await defaultGoalResponse.json() as Goal;

      const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
        data: {
          title: `Verify ${status} goal clear persistence`,
          description: "Terminal issues should keep explicit goal clears across normal edits.",
          status,
          priority: "medium",
          goalId: defaultGoal.id,
        },
      });
      expect(issueResponse.ok()).toBe(true);
      const issue = await issueResponse.json() as Issue;
      const issueRouteId = issue.identifier ?? issue.id;

      const clearResponse = await page.request.patch(`/api/issues/${issueRouteId}`, {
        data: { goalId: null },
      });
      expect(clearResponse.ok()).toBe(true);
      await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBeNull();

      await page.goto("/");
      await page.evaluate((orgId) => {
        window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      }, organization.id);
      await page.goto(`/${organization.issuePrefix}/issues/${issueRouteId}`);
      await expect(page.getByText("Properties", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Change goal: No goal" }).first()).toBeVisible();

      const goalActivityCountAfterClear = await goalUpdateActivityCount(page, issue.id);
      const nextStatus = status === "done" ? "blocked" : "done";
      const statusResponse = await page.request.patch(`/api/issues/${issueRouteId}`, {
        data: { status: nextStatus },
      });
      expect(statusResponse.ok()).toBe(true);

      await expect.poll(async () => (await fetchIssue(page, issue.id)).goalId).toBeNull();
      await expect.poll(async () => goalUpdateActivityCount(page, issue.id)).toBe(goalActivityCountAfterClear);
    });
  }
});
