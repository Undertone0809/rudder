import { expect, test } from "@playwright/test";

type Organization = {
  id: string;
  issuePrefix: string;
};

type Goal = {
  id: string;
  title: string;
};

test.describe("Goal detail lifecycle controls", () => {
  test("keeps edit, delete, work, sub-goal, and activity affordances visible", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });

    const orgResponse = await page.request.post("/api/orgs", {
      data: { name: `Goal-Detail-Lifecycle-${Date.now()}` },
    });
    expect(orgResponse.ok()).toBe(true);
    const organization = await orgResponse.json() as Organization;

    const goalResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Restore goal lifecycle controls",
        description: "Goal detail should expose direct lifecycle operations.",
        status: "active",
        level: "team",
      },
    });
    expect(goalResponse.ok()).toBe(true);
    const goal = await goalResponse.json() as Goal;

    const childGoalResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Keep delete safety visible",
        status: "active",
        level: "task",
        parentId: goal.id,
      },
    });
    expect(childGoalResponse.ok()).toBe(true);

    const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Verify goal delete stays guarded",
        description: "Linked issue should block hard delete.",
        status: "todo",
        priority: "medium",
        goalId: goal.id,
      },
    });
    expect(issueResponse.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/goals/${goal.id}`);

    await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Work \(1\)/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Sub-Goals \(1\)/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Activity \(/ })).toBeVisible();
    await expect(page.getByText("Issues (1)")).toBeVisible();

    const renameResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().endsWith(`/api/goals/${goal.id}`)
      && response.ok(),
    );
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Title").fill("Restored goal lifecycle controls");
    await page.getByRole("button", { name: "Save" }).click();
    await renameResponse;
    await expect(page.getByText("Restored goal lifecycle controls")).toBeVisible();

    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Goal cannot be deleted yet")).toBeVisible();
  });
});
