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

async function createIssue(page: Page, orgId: string, title: string, data: Record<string, unknown> = {}) {
  const response = await page.request.post(`/api/orgs/${orgId}/issues`, {
    data: {
      title,
      description: `${title} description`,
      status: "todo",
      priority: "medium",
      ...data,
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ id: string; identifier?: string | null; title: string }>;
}

async function createProject(page: Page, orgId: string, name: string) {
  const response = await page.request.post(`/api/orgs/${orgId}/projects`, {
    data: {
      name,
      description: `${name} description`,
      color: "#3b82f6",
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ id: string; name: string }>;
}

test.describe("Issues recently viewed sidebar", () => {
  test("saves custom issue boards and removes the old starred sidebar view", async ({ page }) => {
    const organization = await createOrganization(page, "Issues-Custom-Boards");
    await createIssue(page, organization.id, "Custom board visible issue");

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/issues");

    await expect(page.getByRole("link", { name: /Starred/ })).toHaveCount(0);

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toBe("Name this board");
      await dialog.accept("Review board");
    });
    await page.getByRole("button", { name: /Save board/ }).click();

    await expect(page).toHaveURL(/\/issues\?view=/);
    await expect(page.getByTestId("issue-custom-views-section")).toContainText("Custom Boards");
    await expect(page.getByRole("link", { name: /Review board/ })).toBeVisible();
    await expect(page.getByTestId("issues-view-toolbar")).toContainText("Review board");

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toBe('Delete custom board "Review board"? This cannot be undone.');
      await dialog.accept();
    });
    await page.getByLabel("Delete custom board Review board").click();

    await expect(page).toHaveURL(/\/issues$/);
    await expect(page.getByRole("link", { name: /Review board/ })).toHaveCount(0);
  });

  test("shows current-org recent issues in the sidebar without turning recent into a main view", async ({ page }) => {
    const organization = await createOrganization(page, "Issues-Recently-Viewed");
    const otherOrganization = await createOrganization(page, "Issues-Recently-Viewed-Other");
    const firstIssue = await createIssue(page, organization.id, "Recently viewed first issue");
    const secondIssue = await createIssue(page, organization.id, "Recently viewed second issue");
    const thirdIssue = await createIssue(page, organization.id, "Recently viewed third issue");
    const otherOrgIssue = await createIssue(page, otherOrganization.id, "Other organization recent issue");

    await page.goto("/");
    await page.evaluate(
      ({ orgId, recentKey, recentIssueIds }) => {
        window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
        window.localStorage.setItem(recentKey, JSON.stringify(recentIssueIds));
      },
      {
        orgId: organization.id,
        recentKey: recentIssuesStorageKey(organization.id),
        recentIssueIds: [
          otherOrgIssue.id,
          thirdIssue.id,
          "missing-issue-id",
          firstIssue.id,
          thirdIssue.id,
          secondIssue.id,
        ],
      },
    );

    await page.goto("/issues?scope=recent");

    await expect(page).toHaveURL(/\/issues(?:\?|$)/);
    await expect(page).not.toHaveURL(/scope=recent/);
    await expect(page.getByRole("link", { name: /Recently Viewed/ })).toHaveCount(0);
    await expect(page.getByTestId("issue-recent-section")).toContainText("Recently Viewed");
    await expect(page.getByText("Recently viewed first issue", { exact: true })).toBeVisible();
    await expect(page.getByText("Recently viewed second issue", { exact: true })).toBeVisible();
    await expect(page.getByText("Recently viewed third issue", { exact: true })).toBeVisible();
    await expect(page.getByText("Other organization recent issue", { exact: true })).toHaveCount(0);

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
      ({ orgA, orgB, keyA, keyB, issueA, issueB1, issueB2 }) => {
        window.localStorage.setItem("rudder.selectedOrganizationId", orgA);
        window.localStorage.setItem(keyA, JSON.stringify([issueA]));
        window.localStorage.setItem(keyB, JSON.stringify([issueB2, issueB1]));
      },
      {
        orgA: firstOrganization.id,
        orgB: secondOrganization.id,
        keyA: recentIssuesStorageKey(firstOrganization.id),
        keyB: recentIssuesStorageKey(secondOrganization.id),
        issueA: firstOrgIssue.id,
        issueB1: secondOrgIssueA.id,
        issueB2: secondOrgIssueB.id,
      },
    );

    await page.goto("/issues");

    await expect(page.getByTestId("issue-recent-section")).toContainText("Recently Viewed");
    await expect(page.getByText("Org one recent issue", { exact: true })).toBeVisible();

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, secondOrganization.id);

    await page.goto("/issues");

    await expect(page.getByTestId("issue-recent-section")).toContainText("Recently Viewed");
    await expect(page.getByText("Org two first recent issue", { exact: true })).toBeVisible();
    await expect(page.getByText("Org two second recent issue", { exact: true })).toBeVisible();
    await expect(page.getByText("Org one recent issue", { exact: true })).toHaveCount(0);
  });

  test("bounds long recent issue lists without hiding projects", async ({ page }) => {
    const organization = await createOrganization(page, "Issues-Recent-Overflow");
    const project = await createProject(page, organization.id, "Sidebar Project");
    const issues = [];
    for (let index = 1; index <= 13; index += 1) {
      issues.push(await createIssue(page, organization.id, `Recent overflow issue ${String(index).padStart(2, "0")}`));
    }

    await page.goto("/");
    await page.evaluate(
      ({ orgId, recentKey, issueIds }) => {
        window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
        window.localStorage.setItem(recentKey, JSON.stringify(issueIds));
      },
      {
        orgId: organization.id,
        recentKey: recentIssuesStorageKey(organization.id),
        issueIds: issues.map((issue) => issue.id),
      },
    );

    await page.goto("/issues");

    await expect(page.getByTestId(`issue-recent-row-${issues[0].id}`)).toBeVisible();
    await expect(page.getByTestId(`issue-recent-row-${issues[4].id}`)).toBeVisible();
    await expect(page.getByTestId(`issue-recent-row-${issues[5].id}`)).toHaveCount(0);
    await expect(page.getByTestId("workspace-projects-section")).toContainText("Projects");
    await expect(page.getByRole("link", { name: project.name })).toBeVisible();

    await expect(page.getByTestId("issue-recent-toggle")).toContainText("Show 7 more");
    await page.getByTestId("issue-recent-toggle").click();

    await expect(page.getByTestId(`issue-recent-row-${issues[11].id}`)).toBeVisible();
    await expect(page.getByTestId(`issue-recent-row-${issues[12].id}`)).toHaveCount(0);
    await expect(page.getByText("Showing latest 12 of 13")).toBeVisible();
    await expect(page.getByRole("link", { name: project.name })).toBeVisible();
  });

  test("shows live run counts on issue project slices", async ({ page }) => {
    const organization = await createOrganization(page, "Issues-Project-Live");
    const project = await createProject(page, organization.id, "Sidebar Live Project");
    const firstIssue = await createIssue(page, organization.id, "Project live issue 1", { projectId: project.id });
    const secondIssue = await createIssue(page, organization.id, "Project live issue 2", { projectId: project.id });

    await page.route(`**/api/orgs/${organization.id}/live-runs`, async (route) => {
      await route.fulfill({
        json: [
          {
            id: "run-live-1",
            status: "running",
            invocationSource: "manual",
            triggerDetail: "Manual wakeup",
            startedAt: "2026-04-30T10:00:00.000Z",
            finishedAt: null,
            createdAt: "2026-04-30T10:00:00.000Z",
            agentId: "agent-1",
            agentName: "Live Agent",
            agentRuntimeType: "codex_local",
            issueId: firstIssue.id,
          },
          {
            id: "run-live-2",
            status: "running",
            invocationSource: "manual",
            triggerDetail: "Manual wakeup",
            startedAt: "2026-04-30T10:01:00.000Z",
            finishedAt: null,
            createdAt: "2026-04-30T10:01:00.000Z",
            agentId: "agent-2",
            agentName: "Live Agent Two",
            agentRuntimeType: "codex_local",
            issueId: secondIssue.id,
          },
        ],
      });
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/issues");

    const projectRow = page.getByTestId(`issue-project-row-${project.id}`);
    await expect(projectRow).toContainText("Sidebar Live Project");
    await expect(projectRow).toContainText("2 live");
  });
});
