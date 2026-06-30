import { expect, test, type Page } from "@playwright/test";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.describe("Organization workspaces entry copy", () => {
  test("creates a numbered file copy from the Library entry menu", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Entry-Copy-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const sourcePath = "docs/rudder-mcp-tools-report.md";
    const sourceContent = "# Rudder MCP tools\n\nCopy this report without losing content.\n";
    const sourceRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: sourcePath,
        content: sourceContent,
      },
    });
    expect(sourceRes.ok()).toBe(true);

    const existingCopyRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: "docs/rudder-mcp-tools-report copy.md",
        content: "# Existing copy\n",
      },
    });
    expect(existingCopyRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(sourcePath)}`);
    await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText("rudder-mcp-tools-report.md", { timeout: 15_000 });

    await page.getByTestId(`org-workspaces-entry-more-${sourcePath}`).click();
    const copyResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/workspace/entry/copy`)
      && response.url().includes(encodeURIComponent(sourcePath)),
    );
    await page.getByRole("menuitem", { name: "Create copy" }).click();
    const response = await copyResponse;
    expect(response.ok()).toBe(true);
    const copied = await response.json() as { path: string };
    expect(copied.path).toBe("docs/rudder-mcp-tools-report copy 2.md");

    await expect(page).toHaveURL(new RegExp(`path=${encodeURIComponent(copied.path).replace(/%20/g, "(?:%20|\\+)")}`));
    await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText("rudder-mcp-tools-report copy 2.md");
    await expect(page.getByTestId("org-workspaces-editor-textarea")).toHaveValue(sourceContent);

    const copiedFileRes = await request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(copied.path)}`,
    );
    expect(copiedFileRes.ok()).toBe(true);
    const copiedFile = await copiedFileRes.json() as { content: string; libraryEntryId: string };
    expect(copiedFile.content).toBe(sourceContent);

    const sourceFileRes = await request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(sourcePath)}`,
    );
    expect(sourceFileRes.ok()).toBe(true);
    const sourceFile = await sourceFileRes.json() as { libraryEntryId: string };
    expect(copiedFile.libraryEntryId).not.toBe(sourceFile.libraryEntryId);
  });
});
