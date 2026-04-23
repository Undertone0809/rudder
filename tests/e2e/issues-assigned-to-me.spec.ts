import { expect, test } from "@playwright/test";

const ORG_NAME = `Issues-Assigned-To-Me-${Date.now()}`;

test.describe("Issues assigned to me scope", () => {
  test("shows only issues assigned to the current board user", async ({ page }) => {
    await page.goto("/");

    const sessionRes = await page.request.get("/api/auth/session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    expect(currentUserId).toBeTruthy();

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: ORG_NAME },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const assignedTitle = "Assigned to me issue";
    const touchedOnlyTitle = "Created by me but not assigned";

    const assignedRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: assignedTitle,
        description: "This issue should stay visible in the assigned scope.",
        status: "todo",
        priority: "medium",
        assigneeUserId: currentUserId,
      },
    });
    expect(assignedRes.ok()).toBe(true);

    const touchedOnlyRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: touchedOnlyTitle,
        description: "This issue should not appear in the assigned scope.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(touchedOnlyRes.ok()).toBe(true);

    await page.goto("/issues?scope=assigned");

    await expect(page.getByText(assignedTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(touchedOnlyTitle, { exact: true })).toHaveCount(0);
  });
});
