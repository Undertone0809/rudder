import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.use({ serviceWorkers: "block" });

async function selectOrganization(page: import("@playwright/test").Page, orgId: string) {
  await page.goto(E2E_BASE_URL);
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

function firstColorAsRgb(color: string) {
  const hex = color.match(/#[0-9a-fA-F]{6}/)?.[0] ?? "#6366f1";
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

test.describe("Project identity icons", () => {
  test("renders and edits project color and icon identity in core project navigation", async ({ page }, testInfo) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Project-Gradient-Icons-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Gradient identity project",
        description: "Used to verify gradient project navigation markers.",
        icon: "plane",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; color: string; icon: string; urlKey?: string | null };
    expect(project.color).toMatch(/^linear-gradient\(/);
    expect(project.icon).toBe("plane");

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/projects`);

    const projectLink = page.getByTestId("workspace-sidebar").getByRole("link", { name: /Gradient identity project/ });
    await expect(projectLink).toBeVisible();
    await expect(projectLink.locator("svg")).toHaveCount(1);

    const colorMarker = page.getByTestId(`workspace-project-color-${project.id}`);
    await expect(colorMarker).toBeVisible();
    await expect(colorMarker).toHaveCSS("background-image", "none");
    await expect(colorMarker).toHaveCSS("color", firstColorAsRgb(project.color));
    await expect(colorMarker.locator("svg")).toHaveCount(1);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);
    const issueProjectMarker = page.getByTestId(`issue-project-color-${project.id}`);
    await expect(issueProjectMarker).toBeVisible();
    await expect(issueProjectMarker).toHaveCSS("background-image", "none");
    await expect(issueProjectMarker).toHaveCSS("color", firstColorAsRgb(project.color));
    await expect(issueProjectMarker.locator("svg")).toHaveCount(1);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/projects/${project.urlKey ?? project.id}/configuration`);
    await page.getByRole("button", { name: "Change project identity" }).click();
    const patchResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && /\/api\/projects\/[^/]+$/.test(new URL(response.url()).pathname)
      && response.ok(),
    );
    await page.getByRole("button", { name: "Select brain project icon" }).click();
    const updatedProject = await (await patchResponse).json() as { icon: string };
    expect(updatedProject.icon).toBe("brain");

    await page.screenshot({
      path: testInfo.outputPath("project-identity-icons.png"),
      fullPage: true,
    });
  });
});
