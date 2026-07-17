import { expect, test, type Page } from "@playwright/test";

async function createOrganization(page: Page, name: string) {
  const response = await page.request.post("/api/orgs", { data: { name } });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function createIssue(page: Page, orgId: string, title: string) {
  const response = await page.request.post(`/api/orgs/${orgId}/issues`, {
    data: {
      title,
      description: "Sensitive issue content that must not survive permanent deletion.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function openArchivedIssueSettings(
  page: Page,
  organization: { id: string; issuePrefix: string },
) {
  await page.addInitScript((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/organization/settings`, { waitUntil: "commit" });
  await page.getByRole("tab", { name: "Issues", exact: true }).click();
  await expect(page.getByText("Archived issues", { exact: true })).toBeVisible({ timeout: 15_000 });
}

test.describe("Organization settings archived issues", () => {
  test("archives, restores, and permanently deletes an issue with a minimal tombstone", async ({ page }) => {
    const organization = await createOrganization(page, `Archived-Issue-${Date.now()}`);
    const otherOrganization = await createOrganization(page, `Archived-Issue-Other-${Date.now()}`);
    const issue = await createIssue(page, organization.id, "Archive lifecycle target");
    const otherIssue = await createIssue(page, otherOrganization.id, "Keep other organization issue");
    const calendarEventRes = await page.request.post(`/api/orgs/${organization.id}/calendar/events`, {
      data: {
        eventKind: "human_event",
        eventStatus: "planned",
        ownerType: "user",
        ownerUserId: "local-board",
        title: "Archived issue calendar evidence",
        startAt: "2026-07-17T08:00:00.000Z",
        endAt: "2026-07-17T09:00:00.000Z",
        issueId: issue.id,
        sourceMode: "manual",
      },
    });
    expect(calendarEventRes.ok()).toBe(true);
    const calendarEvent = await calendarEventRes.json();

    await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier}`);
    await page.getByRole("button", { name: "More issue actions" }).click();
    await page.getByRole("button", { name: "Archive Issue", exact: true }).click();
    await expect(page.getByRole("heading", { name: `Archive ${issue.identifier}?` })).toBeVisible();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByText("Issue archived", { exact: true })).toBeVisible();

    expect((await page.request.get(`/api/issues/${issue.id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/issues/${issue.identifier}`)).status()).toBe(404);
    expect((await page.request.get(
      `/api/orgs/${organization.id}/calendar/events/${calendarEvent.id}`,
    )).status()).toBe(404);
    const calendarList = await page.request.get(
      `/api/orgs/${organization.id}/calendar/events?start=2026-07-17T00:00:00.000Z&end=2026-07-18T00:00:00.000Z`,
    );
    expect(calendarList.ok()).toBe(true);
    expect(JSON.stringify(await calendarList.json())).not.toContain(issue.id);
    const activeList = await page.request.get(`/api/orgs/${organization.id}/issues`);
    expect(activeList.ok()).toBe(true);
    expect((await activeList.json()).map((row: { id: string }) => row.id)).not.toContain(issue.id);

    await openArchivedIssueSettings(page, organization);
    const archivedRow = page.getByTestId(`archived-issue-row-${issue.id}`);
    await expect(archivedRow).toContainText("Archive lifecycle target");
    await archivedRow.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(archivedRow).toHaveCount(0);
    expect((await page.request.get(`/api/issues/${issue.id}`)).status()).toBe(200);

    const archiveAgain = await page.request.post(`/api/issues/${issue.id}/archive`, { data: {} });
    expect(archiveAgain.ok()).toBe(true);
    await openArchivedIssueSettings(page, organization);
    const deleteRow = page.getByTestId(`archived-issue-row-${issue.id}`);
    await deleteRow.getByRole("button", { name: `Delete ${issue.identifier}` }).click();
    await expect(page.getByRole("heading", { name: "Permanently delete archived issue?" })).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(deleteRow).toHaveCount(0);

    const deletedById = await page.request.get(`/api/issues/${issue.id}`);
    expect(deletedById.status()).toBe(410);
    const tombstone = await deletedById.json();
    expect(tombstone).toMatchObject({
      code: "ENTITY_DELETED",
      tombstone: {
        entityType: "issue",
        id: issue.id,
        title: "Archive lifecycle target",
        issueNumber: issue.issueNumber,
      },
    });
    expect(JSON.stringify(tombstone)).not.toContain("Sensitive issue content");
    expect((await page.request.get(`/api/issues/${issue.identifier}`)).status()).toBe(410);
    expect((await page.request.get(`/api/issues/${otherIssue.id}`)).status()).toBe(200);
  });
});
