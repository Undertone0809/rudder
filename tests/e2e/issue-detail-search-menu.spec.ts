import { expect, test, type Page } from "@playwright/test";

async function createOrganization(page: Page, name: string) {
  const response = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createIssue(page: Page, orgId: string, title: string) {
  const response = await page.request.post(`/api/orgs/${orgId}/issues`, {
    data: {
      title,
      description: `${title} description`,
      status: "todo",
      priority: "medium",
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ id: string; identifier?: string | null; title: string }>;
}

test.describe("Issue detail search menu", () => {
  test("opens issue results under the detail header search and navigates to the selected issue", async ({ page }) => {
    const organization = await createOrganization(page, "Issue-Detail-Search");
    const currentIssue = await createIssue(page, organization.id, "Current detail issue");
    const targetIssue = await createIssue(page, organization.id, "Search target issue");
    const targetRef = targetIssue.identifier ?? targetIssue.id;

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/issues/${currentIssue.identifier ?? currentIssue.id}`);
    await expect(page.getByRole("heading", { name: "Current detail issue", exact: true })).toBeVisible();

    await page.getByRole("textbox", { name: "Search issues" }).fill(targetRef);

    const menu = page.locator("#issue-search-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText(targetRef);
    await expect(menu).toContainText("Search target issue");
    await expect(menu.locator("[data-slot='issue-status-icon']")).toHaveAttribute("data-status", "todo");

    const geometry = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search issues"]');
      const menu = document.querySelector<HTMLElement>("#issue-search-menu");
      if (!input || !menu) return null;
      const inputRect = input.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      return {
        leftDelta: Math.round(menuRect.left - inputRect.left),
        widthDelta: Math.round(menuRect.width - inputRect.width),
        verticalGap: Math.round(menuRect.top - inputRect.bottom),
      };
    });
    expect(geometry).toEqual({ leftDelta: 0, widthDelta: 0, verticalGap: 8 });

    const option = page.locator("#issue-search-menu [role='option']");
    await expect(option).toHaveCount(1);
    await option.click();

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/issues/${targetRef}$`));
    await expect(page.getByRole("heading", { name: "Search target issue", exact: true })).toBeVisible();
  });
});
