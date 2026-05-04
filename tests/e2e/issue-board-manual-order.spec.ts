import { expect, test, type Locator, type Page } from "@playwright/test";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function dragCardOver(page: Page, source: Locator, target: Locator) {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("Could not resolve card bounds for drag");
  }

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 6, { steps: 12 });
  await page.mouse.up();
}

test.describe("Issue board manual order", () => {
  test("persists manual card order after dragging within a status lane", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Issue-Board-Manual-Order-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const firstRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Manual order first issue",
        status: "todo",
        priority: "medium",
      },
    });
    const secondRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Manual order second issue",
        status: "todo",
        priority: "medium",
      },
    });
    const thirdRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Manual order third issue",
        status: "todo",
        priority: "medium",
      },
    });
    expect(firstRes.ok()).toBe(true);
    expect(secondRes.ok()).toBe(true);
    expect(thirdRes.ok()).toBe(true);
    const firstIssue = await firstRes.json() as { identifier: string | null };
    const thirdIssue = await thirdRes.json() as { identifier: string | null };
    const firstIdentifier = firstIssue.identifier;
    const thirdIdentifier = thirdIssue.identifier;
    if (!firstIdentifier || !thirdIdentifier) {
      throw new Error("Expected created issues to have identifiers");
    }

    await selectOrganization(page, organization.id);
    await page.evaluate((orgId) => {
      window.localStorage.setItem(
        `rudder:issues-view:${orgId}`,
        JSON.stringify({ viewMode: "board", sortField: "manual", sortDir: "asc" }),
      );
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/issues`);

    const todoCards = page.locator('[data-testid="kanban-column-todo"] [data-testid^="kanban-card-"]');
    await expect(todoCards.nth(0)).toContainText("Manual order first issue");
    await expect(todoCards.nth(1)).toContainText("Manual order second issue");
    await expect(todoCards.nth(2)).toContainText("Manual order third issue");

    const reorderResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/orgs/${organization.id}/issues/reorder`) &&
      response.request().method() === "POST",
    );
    await dragCardOver(
      page,
      page.getByTestId(`kanban-card-${thirdIdentifier}`),
      page.getByTestId(`kanban-card-${firstIdentifier}`),
    );
    await expect(await reorderResponse).toBeOK();

    await expect(todoCards.nth(0)).toContainText("Manual order third issue");
    await page.reload();
    await expect(todoCards.nth(0)).toContainText("Manual order third issue");
  });
});
