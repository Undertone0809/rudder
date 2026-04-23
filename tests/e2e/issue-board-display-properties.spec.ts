import { expect, test, type Page } from "@playwright/test";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function apiPost<T>(page: Page, path: string, data: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    async ({ requestPath, payload }) => {
      const response = await fetch(requestPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`POST ${requestPath} failed: ${response.status} ${await response.text()}`);
      }
      return response.json();
    },
    { requestPath: path, payload: data },
  ) as Promise<T>;
}

test.describe("Issue board display properties", () => {
  test("toggles board card metadata independently from filters", async ({ page }) => {
    await page.goto("/");

    const organization = await apiPost<{ id: string; issuePrefix: string }>(
      page,
      "/api/orgs",
      {
        name: `Issue-Board-Display-${Date.now()}`,
      },
    );

    const project = await apiPost<{ id: string; name: string }>(
      page,
      `/api/orgs/${organization.id}/projects`,
      {
        name: "field-visibility-project",
        status: "in_progress",
      },
    );

    const issue = await apiPost<{ identifier: string | null }>(
      page,
      `/api/orgs/${organization.id}/issues`,
      {
        projectId: project.id,
        title: "Tune board card fields",
        description: "Display properties should control board card metadata.",
        status: "todo",
        priority: "high",
      },
    );

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/issues`);
    await page.getByTitle("Board view").click();

    await expect(page.getByText("Tune board card fields", { exact: true })).toBeVisible();
    await expect(page.getByText(project.name, { exact: true })).toHaveCount(0);
    if (issue.identifier) {
      await expect(page.getByText(issue.identifier, { exact: true })).toBeVisible();
    }

    await page.getByRole("button", { name: /Display/ }).click();
    await page.getByText("Project", { exact: true }).click();
    await expect(page.getByText(project.name, { exact: true })).toBeVisible();

    if (issue.identifier) {
      await page.getByText("Identifier", { exact: true }).click();
      await expect(page.getByText(issue.identifier, { exact: true })).toHaveCount(0);
    }

    const savedDisplayProperties = await page.evaluate((orgId) => {
      const raw = window.localStorage.getItem(`rudder:issues-view:${orgId}`);
      return raw ? JSON.parse(raw).displayProperties : null;
    }, organization.id);
    expect(savedDisplayProperties).toContain("project");
    expect(savedDisplayProperties).not.toContain("identifier");
  });
});
