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

test.describe("Issues recently viewed scope", () => {
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

  test("shows only current-org visible recent issues in the badge and list", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issues-Recently-Viewed-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const otherOrgRes = await page.request.post("/api/orgs", {
      data: { name: `Issues-Recently-Viewed-Other-${Date.now()}` },
    });
    expect(otherOrgRes.ok()).toBe(true);
    const otherOrganization = await otherOrgRes.json();

    const createIssue = async (orgId: string, title: string) => {
      const response = await page.request.post(`/api/orgs/${orgId}/issues`, {
        data: {
          title,
          description: `${title} description`,
          status: "todo",
          priority: "medium",
        },
      });
      expect(response.ok()).toBe(true);
      return response.json();
    };

    const firstIssue = await createIssue(organization.id, "Recently viewed first issue");
    const secondIssue = await createIssue(organization.id, "Recently viewed second issue");
    const thirdIssue = await createIssue(organization.id, "Recently viewed third issue");
    const otherOrgIssue = await createIssue(otherOrganization.id, "Other organization recent issue");

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

    await expect(page.getByRole("link", { name: /Recently Viewed \(3\)/ })).toBeVisible();
    await expect(page.getByText("Recently viewed first issue", { exact: true })).toBeVisible();
    await expect(page.getByText("Recently viewed second issue", { exact: true })).toBeVisible();
    await expect(page.getByText("Recently viewed third issue", { exact: true })).toBeVisible();
    await expect(page.getByText("Other organization recent issue", { exact: true })).toHaveCount(0);
  });

  test("updates the recently viewed badge when the active organization changes", async ({ page }) => {
    const firstOrgRes = await page.request.post("/api/orgs", {
      data: { name: `Issues-Recent-Switch-A-${Date.now()}` },
    });
    expect(firstOrgRes.ok()).toBe(true);
    const firstOrganization = await firstOrgRes.json();

    const secondOrgRes = await page.request.post("/api/orgs", {
      data: { name: `Issues-Recent-Switch-B-${Date.now()}` },
    });
    expect(secondOrgRes.ok()).toBe(true);
    const secondOrganization = await secondOrgRes.json();

    const createIssue = async (orgId: string, title: string) => {
      const response = await page.request.post(`/api/orgs/${orgId}/issues`, {
        data: {
          title,
          description: `${title} description`,
          status: "todo",
          priority: "medium",
        },
      });
      expect(response.ok()).toBe(true);
      return response.json();
    };

    const firstOrgIssue = await createIssue(firstOrganization.id, "Org one recent issue");
    const secondOrgIssueA = await createIssue(secondOrganization.id, "Org two first recent issue");
    const secondOrgIssueB = await createIssue(secondOrganization.id, "Org two second recent issue");

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

    await page.goto("/issues?scope=recent");

    await expect(page.getByRole("link", { name: /Recently Viewed \(1\)/ })).toBeVisible();
    await expect(page.getByText("Org one recent issue", { exact: true })).toBeVisible();

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, secondOrganization.id);

    await page.goto("/issues?scope=recent");

    await expect(page.getByRole("link", { name: /Recently Viewed \(2\)/ })).toBeVisible();
    await expect(page.getByText("Org two first recent issue", { exact: true })).toBeVisible();
    await expect(page.getByText("Org two second recent issue", { exact: true })).toBeVisible();
    await expect(page.getByText("Org one recent issue", { exact: true })).toHaveCount(0);
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
