import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDb, issues } from "../../packages/db/src/index.ts";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function selectOrganization(page: Page, orgId: string) {
  await page.goto(E2E_BASE_URL, { waitUntil: "commit" });
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function updateIssue(page: Page, issueId: string, status: string) {
  const response = await page.request.patch(`${E2E_BASE_URL}/api/issues/${issueId}`, {
    data: { status },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function getCurrentUserId(page: Page) {
  const response = await page.request.get(`${E2E_BASE_URL}/api/auth/get-session`);
  expect(response.ok(), await response.text()).toBe(true);
  const session = await response.json() as { user?: { id?: string }; session?: { userId?: string } };
  const userId = session.user?.id ?? session.session?.userId;
  expect(userId).toBeTruthy();
  return userId!;
}

test.describe("Issue auto refresh", () => {
  test("refreshes list, search, and detail state without a live connection", async ({ page }) => {
    test.setTimeout(300_000);

    const organizationResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Issue-Auto-Refresh-${Date.now()}` },
    });
    expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
    const organization = await organizationResponse.json() as { id: string; issuePrefix: string };
    const currentUserId = await getCurrentUserId(page);
    const issueResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue status should refresh automatically",
        description: "This issue exercises polling, focus recovery, and retry after a missed live update.",
        status: "todo",
        priority: "medium",
        assigneeUserId: currentUserId,
        reviewerUserId: currentUserId,
      },
    });
    expect(issueResponse.ok(), await issueResponse.text()).toBe(true);
    const issue = await issueResponse.json() as { id: string; identifier: string | null; title: string };
    const issueRef = issue.identifier ?? issue.id;

    page.routeWebSocket(`**/api/orgs/${organization.id}/events/ws`, (socket) => socket.close());

    let blockBaseListReads = false;
    let blockSearchListReads = false;
    await page.route(`**/api/orgs/${organization.id}/issues**`, async (route) => {
      const requestUrl = new URL(route.request().url());
      const isIssueList = requestUrl.pathname === `/api/orgs/${organization.id}/issues`;
      const isSearch = Boolean(requestUrl.searchParams.get("q"));
      const shouldBlock = isIssueList && (isSearch ? blockSearchListReads : blockBaseListReads);
      if (shouldBlock) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary issue list outage" }),
        });
        return;
      }
      await route.continue();
    });

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`, { waitUntil: "domcontentloaded" });
    await page.getByTitle("List view").click();

    const issueRow = () => page.locator("a").filter({ hasText: issue.title }).first();
    const issueStatus = () => issueRow().locator('[data-slot="issue-status-icon"]').first();
    await expect(issueRow()).toBeVisible();
    await expect(issueStatus()).toHaveAttribute("data-status", "todo");

    blockBaseListReads = true;
    const listRefreshNotice = page.getByTestId("issue-refresh-notice");
    await expect(listRefreshNotice).toBeVisible({ timeout: 20_000 });
    await expect(issueRow()).toBeVisible();
    await expect(issueStatus()).toHaveAttribute("data-status", "todo");
    blockBaseListReads = false;
    await listRefreshNotice.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(listRefreshNotice).toBeHidden({ timeout: 10_000 });

    await updateIssue(page, issue.id, "in_progress");
    await expect(issueStatus()).toHaveAttribute("data-status", "in_progress", { timeout: 15_000 });

    const backgroundTab = await page.context().newPage();
    await backgroundTab.goto(E2E_BASE_URL, { waitUntil: "domcontentloaded" });
    await backgroundTab.bringToFront();
    await updateIssue(page, issue.id, "in_review");
    await page.bringToFront();
    await expect(issueStatus()).toHaveAttribute("data-status", "in_review", { timeout: 8_000 });
    await backgroundTab.close();

    const searchBox = page.getByRole("textbox", { name: "Search issues" });
    await searchBox.fill(issue.title);
    await expect(issueRow()).toBeVisible();
    blockBaseListReads = true;
    await page.waitForTimeout(6_000);
    await expect(listRefreshNotice).toBeHidden();
    blockBaseListReads = false;
    blockSearchListReads = true;
    await expect(listRefreshNotice).toBeVisible({ timeout: 20_000 });
    await expect(issueRow()).toBeVisible();
    blockSearchListReads = false;
    await listRefreshNotice.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(listRefreshNotice).toBeHidden({ timeout: 10_000 });

    await updateIssue(page, issue.id, "blocked");
    await expect(issueStatus()).toHaveAttribute("data-status", "blocked", { timeout: 15_000 });

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues/${issueRef}`, {
      waitUntil: "domcontentloaded",
    });
    const propertiesPanel = page.getByRole("region", { name: "Issue properties" });
    await expect(propertiesPanel.getByRole("button", { name: "Blocked", exact: true })).toBeVisible();

    let blockDetailReads = false;
    await page.route(`**/api/issues/${issueRef}`, async (route) => {
      if (blockDetailReads) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary issue read outage" }),
        });
        return;
      }
      await route.continue();
    });

    blockDetailReads = true;
    const detailRefreshNotice = page.getByTestId("issue-refresh-notice");
    await expect(detailRefreshNotice).toBeVisible({ timeout: 20_000 });
    await expect(propertiesPanel.getByRole("button", { name: "Blocked", exact: true })).toBeVisible();
    blockDetailReads = false;
    await detailRefreshNotice.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(detailRefreshNotice).toBeHidden({ timeout: 10_000 });

    await updateIssue(page, issue.id, "done");
    await expect(propertiesPanel.getByRole("button", { name: "Done", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("region", { name: "Issue activity timeline" })).toContainText(
      "moved from Blocked to Done",
      { timeout: 15_000 },
    );
  });

  test("preserves loaded pages and the scroll anchor while polling", async ({ page }) => {
    test.setTimeout(300_000);
    const organizationResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Issue-Auto-Refresh-Pagination-${Date.now()}` },
    });
    expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
    const organization = await organizationResponse.json() as { id: string; issuePrefix: string };
    const currentUserId = await getCurrentUserId(page);
    const baseTime = Date.now() - 201_000;
    const createdIssues = Array.from({ length: 201 }, (_, index) => ({
      id: randomUUID(),
      orgId: organization.id,
      title: `Paginated refresh issue ${String(index).padStart(3, "0")}`,
      description: "This issue keeps the list large enough to exercise the load-more boundary.",
      status: "todo" as const,
      priority: "medium" as const,
      assigneeUserId: currentUserId,
      createdAt: new Date(baseTime + index * 1_000),
      updatedAt: new Date(baseTime + index * 1_000),
    }));
    await e2eDb.insert(issues).values(createdIssues);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`, { waitUntil: "domcontentloaded" });
    await page.getByTitle("List view").click();

    const listSentinel = page.getByTestId("issues-list-load-more-sentinel");
    await expect(listSentinel).toBeAttached({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
    await listSentinel.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("issues-end-state")).toBeVisible({ timeout: 20_000 });

    const anchor = page.getByText("Paginated refresh issue 000", { exact: true });
    await anchor.scrollIntoViewIfNeeded();
    const before = await anchor.boundingBox();
    expect(before).not.toBeNull();

    await updateIssue(page, createdIssues[200]!.id, "in_progress");
    const updatedIssueRow = page.locator("main a").filter({ hasText: createdIssues[200]!.title }).first();
    await expect(updatedIssueRow.locator('[data-slot="issue-status-icon"]').first()).toHaveAttribute(
      "data-status",
      "in_progress",
      { timeout: 15_000 },
    );
    await expect(anchor).toBeVisible();
    const after = await anchor.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(120);
  });

  test("loads more completed issues when the done lane reaches its scroll threshold", async ({ page }) => {
    test.setTimeout(300_000);
    const organizationResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Issue-Infinite-Scroll-Done-${Date.now()}` },
    });
    expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
    const organization = await organizationResponse.json() as { id: string; issuePrefix: string };
    const currentUserId = await getCurrentUserId(page);
    const baseTime = Date.now() - 201_000;
    const createdIssues = Array.from({ length: 201 }, (_, index) => ({
      id: randomUUID(),
      orgId: organization.id,
      title: `Done infinite scroll issue ${String(index).padStart(3, "0")}`,
      description: "This completed issue exercises the status-lane infinite scroll boundary.",
      status: "done" as const,
      priority: "medium" as const,
      assigneeUserId: currentUserId,
      createdAt: new Date(baseTime + index * 1_000),
      updatedAt: new Date(baseTime + index * 1_000),
    }));
    await e2eDb.insert(issues).values(createdIssues);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`, { waitUntil: "domcontentloaded" });

    const doneLane = page.getByTestId("kanban-column-done");
    await expect(doneLane).toBeVisible({ timeout: 30_000 });
    await expect(doneLane.locator('[data-testid^="kanban-card-"]')).toHaveCount(200, { timeout: 30_000 });

    await doneLane.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await expect(doneLane.getByText("Done infinite scroll issue 000", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(doneLane.locator('[data-testid^="kanban-card-"]')).toHaveCount(201, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
    await expect(doneLane.getByTestId("kanban-end-state-done")).toBeVisible({ timeout: 20_000 });
  });

  test("discovers a filtered lane when the first page has no matching issues", async ({ page }) => {
    test.setTimeout(300_000);
    const organizationResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Issue-Infinite-Scroll-Filtered-Lane-${Date.now()}` },
    });
    expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
    const organization = await organizationResponse.json() as { id: string; issuePrefix: string };
    const baseTime = Date.now() - 201_000;
    const todoIssues = Array.from({ length: 200 }, (_, index) => ({
      id: randomUUID(),
      orgId: organization.id,
      title: `Todo discovery issue ${String(index).padStart(3, "0")}`,
      description: "These issues fill the first page without matching the active Done filter.",
      status: "todo" as const,
      priority: "medium" as const,
      createdAt: new Date(baseTime + (index + 1) * 1_000),
      updatedAt: new Date(baseTime + (index + 1) * 1_000),
    }));
    const doneIssue = {
      id: randomUUID(),
      orgId: organization.id,
      title: "Done issue discovered after filtering",
      description: "This issue is deliberately placed on the second page.",
      status: "done" as const,
      priority: "medium" as const,
      createdAt: new Date(baseTime),
      updatedAt: new Date(baseTime),
    };
    await e2eDb.insert(issues).values([...todoIssues, doneIssue]);

    await selectOrganization(page, organization.id);
    await page.evaluate((orgId) => {
      window.localStorage.setItem(
        `rudder:issues-view:${orgId}`,
        JSON.stringify({ viewMode: "board", statuses: ["done"], sortField: "updated", sortDir: "desc" }),
      );
    }, organization.id);

    const secondPageRequest = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === `/api/orgs/${organization.id}/issues`
        && url.searchParams.get("offset") === "200"
        && !url.searchParams.has("status");
    });
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`, { waitUntil: "domcontentloaded" });

    const pageResponse = await secondPageRequest;
    expect(pageResponse.ok(), await pageResponse.text()).toBe(true);
    const doneLane = page.getByTestId("kanban-column-done");
    await expect(doneLane).toBeVisible({ timeout: 30_000 });
    await expect(doneLane.getByText(doneIssue.title, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(doneLane.locator('[data-testid^="kanban-card-"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
  });
});
