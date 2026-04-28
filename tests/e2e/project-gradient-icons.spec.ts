import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.use({ serviceWorkers: "block" });

async function selectOrganization(page: import("@playwright/test").Page, orgId: string) {
  await page.goto(E2E_BASE_URL);
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.describe("Project gradient identity", () => {
  test("uses generated gradients instead of folder icons for project navigation", async ({ page }, testInfo) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Project-Gradient-Icons-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Gradient identity project",
        description: "Used to verify gradient project navigation markers.",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; color: string; urlKey?: string | null };
    expect(project.color).toMatch(/^linear-gradient\(/);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/projects`);

    const projectLink = page.getByTestId("workspace-sidebar").getByRole("link", { name: /Gradient identity project/ });
    await expect(projectLink).toBeVisible();
    await expect(projectLink.locator("svg")).toHaveCount(0);

    const colorMarker = page.getByTestId(`workspace-project-color-${project.id}`);
    await expect(colorMarker).toBeVisible();
    await expect(colorMarker).toHaveCSS("background-image", /linear-gradient/);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);
    const issueProjectMarker = page.getByTestId(`issue-project-color-${project.id}`);
    await expect(issueProjectMarker).toBeVisible();
    await expect(issueProjectMarker).not.toHaveCSS("color", "rgb(124, 58, 237)");

    await page.screenshot({
      path: testInfo.outputPath("project-gradient-icons.png"),
      fullPage: true,
    });
  });
});
