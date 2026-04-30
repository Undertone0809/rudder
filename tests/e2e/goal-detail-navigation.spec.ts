import { expect, test } from "@playwright/test";

type Organization = {
  id: string;
  issuePrefix: string;
};

type Goal = {
  id: string;
  title: string;
};

test.describe("Goal detail navigation", () => {
  test("shows ancestor breadcrumbs and returns to the parent goal with Escape", async ({ page }) => {
    const orgResponse = await page.request.post("/api/orgs", {
      data: { name: `Goal-Detail-Navigation-${Date.now()}` },
    });
    expect(orgResponse.ok()).toBe(true);
    const organization = await orgResponse.json() as Organization;

    const parentResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Goal Center rollout",
        status: "active",
        level: "team",
      },
    });
    expect(parentResponse.ok()).toBe(true);
    const parent = await parentResponse.json() as Goal;

    const childResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Lifecycle controls hardening",
        status: "planned",
        level: "task",
        parentId: parent.id,
      },
    });
    expect(childResponse.ok()).toBe(true);
    const child = await childResponse.json() as Goal;

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/goals/${child.id}`);

    const header = page.getByTestId("workspace-main-header");
    await expect(header.getByRole("link", { name: "Goals" })).toBeVisible();
    await expect(header.getByRole("link", { name: parent.title })).toBeVisible();
    await expect(header.getByText(child.title, { exact: true })).toBeVisible();
    await expect(page.getByText("Completion", { exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/goals/${parent.id}$`));
  });
});
