import { expect, test } from "@playwright/test";

function recentIssuesStorageKey(orgId: string): string {
  return `rudder:recent-issues:${orgId}`;
}

test.describe("Issues recently viewed scope", () => {
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
});
