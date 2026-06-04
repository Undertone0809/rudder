import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("opens workspace launcher options from the Library sidebar", async ({ page, request }) => {
  await page.addInitScript(() => {
    const openedWorkspaces: Array<{ rootPath: string; targetId?: string }> = [];
    Object.defineProperty(window, "__rudderOpenedWorkspaces", {
      configurable: true,
      value: openedWorkspaces,
      writable: false,
    });

    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        listWorkspaceLaunchTargets: async () => [
          { id: "cursor", label: "Cursor", kind: "ide" },
          { id: "vscode", label: "VS Code", kind: "ide" },
          { id: "finder", label: "Finder", kind: "folder" },
        ],
        openWorkspace: async (rootPath: string, targetId?: string) => {
          openedWorkspaces.push({ rootPath, targetId });
        },
        openPath: async () => {},
        listAvailableIdes: async () => [{ id: "cursor", label: "Cursor" }],
        openWorkspaceFileInIde: async () => {},
        copyText: async () => {},
        getBootState: async () => ({}),
        onBootState: () => () => {},
        setAppearance: async () => {},
        restart: async () => {},
        getAppVersion: async () => "0.0.0-test",
        checkForUpdates: async () => ({
          status: "unavailable",
          channel: "stable",
          currentVersion: "0.0.0-test",
          checkedAt: "1970-01-01T00:00:00.000Z",
        }),
        sendFeedback: async () => {},
        openExternal: async () => {},
        openNotificationSettings: async () => ({ opened: false, platform: "darwin" }),
        setBadgeCount: async () => {},
        showNotification: async () => {},
        pickPath: async () => ({ canceled: true, path: null }),
      },
    });
  });

  const orgRes = await request.post("/api/orgs", {
    data: { name: `Library-Launcher-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const fileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath: "projects/launcher-proof/README.md",
      content: "# Launcher proof\n",
    },
  });
  expect(fileRes.ok()).toBe(true);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent("projects/launcher-proof/README.md")}`);

  const sidebarLauncher = page.getByTestId("org-workspaces-sidebar-launcher");
  await expect(sidebarLauncher).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("org-workspaces-editor-launcher")).toHaveCount(0);

  await sidebarLauncher.click();
  await expect(page.getByTestId("org-workspaces-sidebar-launch-target-cursor")).toContainText("Cursor");
  await expect(page.getByTestId("org-workspaces-sidebar-launch-target-vscode")).toContainText("VS Code");

  await page.getByTestId("org-workspaces-sidebar-launch-target-cursor").click();
  await expect.poll(async () =>
    page.evaluate(() => (window as typeof window & {
      __rudderOpenedWorkspaces?: Array<{ rootPath: string; targetId?: string }>;
    }).__rudderOpenedWorkspaces ?? []),
  ).toEqual([
    expect.objectContaining({ targetId: "cursor" }),
  ]);
});
