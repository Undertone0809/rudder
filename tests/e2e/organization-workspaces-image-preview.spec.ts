import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveE2EOrganizationWorkspaceRoot } from "./support/organization-storage";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X5p1sAAAAASUVORK5CYII=",
  "base64",
);

const resolveOrganizationWorkspaceRoot = resolveE2EOrganizationWorkspaceRoot;

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
    await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText("cost-trend.png", { timeout: 15_000 });
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

  test("renders html files inline in the workspace browser", async ({ page, request }) => {
    let externalAssetRequested = false;
    await page.route("https://example.invalid/**", async (route) => {
      externalAssetRequested = true;
      await route.fulfill({ status: 204, body: "" });
    });

    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Html-Preview-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const htmlFilePath = "projects/rudder-dev/proposals/rendered-proposal.html";
    const fileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: htmlFilePath,
        content: [
          "<!doctype html>",
          "<html>",
          "<body>",
          "<main>",
          "<h1>Rendered Library proposal</h1>",
          "<p>This HTML should render inside the Library preview.</p>",
          "<img src=\"https://example.invalid/tracker.png\" alt=\"External tracker\" />",
          "<script>document.body.dataset.scriptRan = 'yes';</script>",
          "</main>",
          "</body>",
          "</html>",
        ].join(""),
      },
    });
    expect(fileRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(htmlFilePath)}`);

    await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText("rendered-proposal.html", { timeout: 15_000 });
    await expect(page.getByTestId("org-workspaces-editor-textarea")).toHaveCount(0);

    const preview = page.getByTestId("org-workspaces-html-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("sandbox", "");
    await expect(preview).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(preview).toHaveAttribute("srcdoc", /Content-Security-Policy/);
    await expect(preview).toHaveAttribute("srcdoc", /Rendered Library proposal/);
    await expect(preview.contentFrame().getByRole("heading", { name: "Rendered Library proposal" })).toBeVisible();
    await expect(preview.contentFrame().getByText("This HTML should render inside the Library preview.")).toBeVisible();
    await page.waitForTimeout(500);
    expect(externalAssetRequested).toBe(false);

    await page.getByRole("button", { name: "Source" }).click();
    const sourceEditor = page.getByTestId("org-workspaces-editor-textarea");
    await expect(sourceEditor).toBeVisible();
    await expect(sourceEditor).toHaveValue(/Rendered Library proposal/);

    const updatedHtml = [
      "<!doctype html>",
      "<html>",
      "<body>",
      "<main>",
      "<h1>Updated Library proposal</h1>",
      "<p>The editable source path should still work.</p>",
      "</main>",
      "</body>",
      "</html>",
    ].join("");
    const saveResponse = page.waitForResponse((response) =>
      response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
      && response.url().includes(encodeURIComponent(htmlFilePath))
      && response.request().method() === "PATCH",
    );
    await sourceEditor.fill(updatedHtml);
    await saveResponse;

    await page.getByRole("button", { name: "Preview" }).click();
    await expect(preview.contentFrame().getByRole("heading", { name: "Updated Library proposal" })).toBeVisible();
  });
});
