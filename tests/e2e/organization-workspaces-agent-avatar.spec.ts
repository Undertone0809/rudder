import { expect, test } from "@playwright/test";

test.describe("Organization workspaces agent avatar", () => {
  test("shows each agent workspace with the agent's generated avatar", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Agent-Avatar-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Avatar Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/workspaces`);

    await page.getByRole("button", { name: /^agents$/i }).click();

    const agentWorkspaceRow = page.locator('[data-workspace-entry-path^="agents/"] > button').filter({
      hasText: "Avatar Agent",
    });
    await expect(agentWorkspaceRow).toBeVisible();
    await expect(
      agentWorkspaceRow.getByTestId("org-workspaces-agent-icon").locator('img[src^="data:image/svg+xml"]'),
    ).toBeVisible();
    await expect(agentWorkspaceRow.getByTestId("org-workspaces-agent-badge")).toHaveText("Agent");
  });

  test("moves entries by drag-and-drop and supports VS Code-style tree keyboard selection", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Tree-Interaction-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const folderPath = "target-folder";
    const filePath = "tree-file.md";
    const movedPath = `${folderPath}/${filePath}`;

    const directoryRes = await request.post(`/api/orgs/${organization.id}/workspace/directory`, {
      data: { directoryPath: folderPath },
    });
    expect(directoryRes.ok()).toBe(true);
    const fileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: { filePath, content: "# Tree file\n" },
    });
    expect(fileRes.ok()).toBe(true);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/library`);

    const folderRow = page.locator(`[data-workspace-entry-path="${folderPath}"]`);
    const folderButton = folderRow.locator("> button").first();
    const fileRow = page.locator(`[data-workspace-entry-path="${filePath}"]`);
    await expect(folderRow).toBeVisible();
    await expect(fileRow).toBeVisible();

    await folderButton.click();
    await expect(folderButton).toHaveAttribute("aria-selected", "true");
    await folderButton.press("ArrowDown");
    await expect(fileRow.locator("> button").first()).toBeFocused();
    await expect(fileRow.locator("> button").first()).toHaveAttribute("aria-selected", "true");

    await fileRow.dragTo(folderRow);
    await expect(page.locator(`[data-workspace-entry-path="${movedPath}"]`)).toBeVisible();
    await expect(page.getByTestId("org-workspaces-files-card")).not.toHaveClass(/ring-1/);

    const movedFileRes = await request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(movedPath)}`,
    );
    expect(movedFileRes.ok()).toBe(true);
    await expect(fileRow).toHaveCount(0);
  });
});
