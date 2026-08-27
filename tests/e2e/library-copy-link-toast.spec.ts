import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("keeps Library copy-link success feedback compact across file and tab menus", async ({ page, request }) => {
  await page.addInitScript(() => {
    const copiedText: string[] = [];
    Object.defineProperty(window, "__rudderCopiedText", {
      configurable: true,
      value: copiedText,
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        copyText: async (value: string) => {
          copiedText.push(value);
        },
      },
    });
  });

  const organizationResponse = await request.post("/api/orgs", {
    data: { name: `Library-Copy-Toast-${Date.now()}` },
  });
  expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
  const organization = await organizationResponse.json() as { id: string; issuePrefix: string };
  const filePath = "projects/copy-toast/README.md";
  const fileResponse = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath,
      content: "# Compact copy feedback\n",
    },
  });
  expect(fileResponse.ok(), await fileResponse.text()).toBe(true);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const fileRow = page.locator(`[data-workspace-entry-path="${filePath}"]`);
  await expect(fileRow).toBeVisible({ timeout: 15_000 });
  await fileRow.hover();
  await page.getByTestId(`org-workspaces-entry-more-${filePath}`).click();
  await page.getByTestId(`org-workspaces-entry-copy-submenu-${filePath}`).hover();
  await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await page.waitForTimeout(700);
  await expect(page.locator('[data-slot="dropdown-menu-content"]')).toHaveCount(0);

  const toastViewport = page.locator("aside[aria-live='polite']");
  await expect(toastViewport).toBeVisible();
  await expect(toastViewport.locator("p")).toHaveCount(1);
  await expect(toastViewport.locator("p")).toHaveText("Library link copied");
  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & { __rudderCopiedText?: string[] }
  ).__rudderCopiedText ?? [])).toEqual([
    expect.stringMatching(/^\[README\.md\]\(.+\)$/),
  ]);

  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.waitForTimeout(3_600);

  await fileRow.hover();
  await page.getByTestId(`org-workspaces-entry-more-${filePath}`).click();
  await page.getByTestId(`org-workspaces-entry-copy-submenu-${filePath}`).hover();
  await page.getByRole("menuitem", { name: "Copy absolute path", exact: true }).click();
  await page.waitForTimeout(700);
  await expect(page.locator('[data-slot="dropdown-menu-content"]')).toHaveCount(0);
  await expect(toastViewport.getByText("Absolute path copied", { exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & { __rudderCopiedText?: string[] }
  ).__rudderCopiedText ?? [])).toEqual([
    expect.stringMatching(/^\[README\.md\]\(.+\)$/),
    expect.stringMatching(/README\.md$/),
  ]);

  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.waitForTimeout(3_600);

  const editorTab = page.getByTestId(`org-workspaces-editor-tab-${filePath}`);
  await editorTab.click({ button: "right" });
  const tabMenu = page.getByTestId("org-workspaces-tab-context-menu");
  await expect(tabMenu).toBeVisible();
  await tabMenu.getByTestId("org-workspaces-tab-copy-submenu").hover();
  await page.getByTestId("org-workspaces-tab-copy-submenu-content")
    .getByRole("menuitem", { name: "Copy link", exact: true })
    .click();
  await page.waitForTimeout(700);
  await expect(tabMenu).toHaveCount(0);
  await expect(editorTab.getByRole("tab")).toBeFocused();

  await expect(toastViewport).toBeVisible();
  await expect(toastViewport.locator("p")).toHaveCount(1);
  await expect(toastViewport.locator("p")).toHaveText("Library link copied");
  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & { __rudderCopiedText?: string[] }
  ).__rudderCopiedText ?? [])).toEqual([
    expect.stringMatching(/^\[README\.md\]\(.+\)$/),
    expect.stringMatching(/README\.md$/),
    expect.stringMatching(/^\[README\.md\]\(.+\)$/),
  ]);

  await editorTab.click({ button: "right" });
  const absolutePathTabMenu = page.getByTestId("org-workspaces-tab-context-menu");
  await expect(absolutePathTabMenu).toBeVisible();
  await absolutePathTabMenu.getByTestId("org-workspaces-tab-copy-submenu").hover();
  await page.getByTestId("org-workspaces-tab-copy-submenu-content")
    .getByRole("menuitem", { name: "Copy absolute path", exact: true })
    .click();
  await page.waitForTimeout(700);
  await expect(absolutePathTabMenu).toHaveCount(0);
  await expect(editorTab.getByRole("tab")).toBeFocused();
  await expect(toastViewport.getByText("Absolute path copied", { exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & { __rudderCopiedText?: string[] }
  ).__rudderCopiedText ?? [])).toEqual([
    expect.stringMatching(/^\[README\.md\]\(.+\)$/),
    expect.stringMatching(/README\.md$/),
    expect.stringMatching(/^\[README\.md\]\(.+\)$/),
    expect.stringMatching(/README\.md$/),
  ]);
});
