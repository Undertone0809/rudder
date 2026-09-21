import { expect, test } from "@playwright/test";

// Exercise the real router, workspace API, file tree and editor. Only the
// instance locale is overridden per page so parallel tests remain isolated.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 960 } });

for (const variant of [
  { locale: "en", theme: "light", projects: "Projects", library: "Library" },
  { locale: "zh-CN", theme: "dark", projects: "项目", library: "文档" },
] as const) {
  test(`@smoke Projects contains Library and preserves document navigation (${variant.locale}, ${variant.theme})`, async ({ page }, testInfo) => {
    const orgResponse = await page.request.post("/api/orgs", {
      data: { name: `Navigation-${variant.locale}-${Date.now()}` },
    });
    expect(orgResponse.ok()).toBe(true);
    const org = await orgResponse.json() as { id: string; urlKey: string };
    const projectResponse = await page.request.post(`/api/orgs/${org.id}/projects`, {
      data: { name: "Navigation Project", description: "Project and document navigation" },
    });
    expect(projectResponse.ok()).toBe(true);
    const project = await projectResponse.json() as { id: string; urlKey?: string | null };
    const filePath = "docs/navigation.md";
    const documentPath = `/library?path=${encodeURIComponent(filePath)}`;
    const projectPath = `/projects/${project.urlKey ?? project.id}/configuration`;
    const fileResponse = await page.request.post(`/api/orgs/${org.id}/workspace/file`, {
      data: { filePath, content: "# Navigation document\n\nThis document stays in Library.\n" },
    });
    expect(fileResponse.ok()).toBe(true);

    await page.route("**/api/health", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), uiLocale: variant.locale } });
    });
    await page.addInitScript(({ id, theme }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", id);
      window.localStorage.setItem("rudder.theme", theme);
    }, { id: org.id, theme: variant.theme });
    await page.goto(`/${org.urlKey}/messenger`);
    await expect(page.locator("html")).toHaveAttribute("lang", variant.locale);

    const rail = page.getByTestId("primary-rail");
    const projectsEntry = rail.getByRole("link", { name: variant.projects, exact: true });
    await expect(projectsEntry).toBeVisible();
    await expect(rail.getByRole("link", { name: /^(Library|文档|Organization|组织)$/ })).toHaveCount(0);
    await expect(projectsEntry).toHaveAttribute("href", `/${org.urlKey}/projects`);
    await projectsEntry.click();
    // Projects automatically opens the first project when the list is nonempty.
    await expect(page).toHaveURL(`/${org.urlKey}${projectPath}`);
    const sidebar = page.getByTestId("workspace-sidebar");
    await expect(sidebar.getByRole("heading", { name: variant.projects, exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: variant.library, exact: true })).toBeVisible();
    await page.getByTestId("workspace-projects-scroll").getByRole("link").filter({ hasText: "Navigation Project" }).click();
    await expect(page).toHaveURL(`/${org.urlKey}${projectPath}`);
    await expect(projectsEntry).toHaveAttribute("aria-current", "page");
    await testInfo.attach(`projects-sidebar-${variant.locale}-${variant.theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    await sidebar.getByRole("link", { name: variant.library, exact: true }).click();
    await expect(page).toHaveURL(`/${org.urlKey}/library`);
    await expect(page.getByTestId("org-workspaces-files-scroll")).toBeVisible();
    await expect(projectsEntry).toHaveAttribute("aria-current", "page");

    // Existing document links and reloads must continue to work without a
    // routing or storage migration. The file tree keeps its full sidebar.
    await page.goto(`/${org.urlKey}${documentPath}`);
    const editor = page.getByTestId("org-workspaces-markdown-editor").locator(".cm-content");
    await expect(editor).toContainText("This document stays in Library.");
    await page.reload();
    await expect(editor).toContainText("This document stays in Library.");
    await expect(projectsEntry).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("org-workspaces-files-scroll")).toBeVisible();
    await testInfo.attach(`library-under-projects-${variant.locale}-${variant.theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    // Clicking the active Projects rail escapes the file tree and returns to
    // the last project. The nested Library item restores its own document.
    await projectsEntry.click();
    await expect(page).toHaveURL(`/${org.urlKey}${projectPath}`);
    await sidebar.getByRole("link", { name: variant.library, exact: true }).click();
    await expect(page).toHaveURL(`/${org.urlKey}${documentPath}`);
    await expect(editor).toContainText("This document stays in Library.");

    for (const legacyPath of ["/resources", "/workspaces"]) {
      await page.goto(`/${org.urlKey}${legacyPath}`);
      await expect(page.getByTestId("org-workspaces-files-scroll")).toBeVisible();
      await expect(projectsEntry).toHaveAttribute("aria-current", "page");
      await projectsEntry.click();
      await expect(page).toHaveURL(`/${org.urlKey}${projectPath}`);
    }
  });
}
