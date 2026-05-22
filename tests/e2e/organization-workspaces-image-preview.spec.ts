import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { E2E_HOME, E2E_INSTANCE_ID } from "./support/e2e-env";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X5p1sAAAAASUVORK5CYII=",
  "base64",
);

function resolveOrganizationWorkspaceRoot(orgId: string) {
  return path.join(
    E2E_HOME,
    "instances",
    E2E_INSTANCE_ID,
    "organizations",
    orgId,
    "workspaces",
  );
}

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.describe("Organization workspaces image preview", () => {
  test("renders image files inline in the workspace browser", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Image-Preview-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const imageFilePath = "artifacts/cost-trend.png";
    const imagePath = path.join(resolveOrganizationWorkspaceRoot(organization.id), imageFilePath);
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, ONE_BY_ONE_PNG);

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/workspaces?path=${encodeURIComponent(imageFilePath)}`);

    await expect(page.getByText(imageFilePath)).toBeVisible();
    await expect(page.getByText("png", { exact: true })).toBeVisible();
    await expect(page.getByText("Binary files are not previewed")).toHaveCount(0);

    const preview = page.getByTestId("org-workspaces-image-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute(
      "src",
      new RegExp(`/api/orgs/${organization.id}/workspace/file/content\\?path=artifacts%2Fcost-trend\\.png`),
    );
    await expect(preview).toHaveJSProperty("naturalWidth", 1);
    await expect(preview).toHaveJSProperty("naturalHeight", 1);
  });
});
