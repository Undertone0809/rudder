import { expect, test } from "@playwright/test";

const CHILDREN_ONLY_MESSAGE = "React.Children.only expected to receive a single React element child.";

test("auto refreshes recoverable app render failures before showing diagnostics", async ({ page }) => {
  await page.addInitScript(() => {
    window.__RUDDER_E2E_THROW_APP_RENDER_ERROR__ = "children-only";
    (window as typeof window & { __rudderReloadAppCalls?: number }).__rudderReloadAppCalls = 0;
    (window as typeof window & { desktopShell?: unknown }).desktopShell = {
      reloadApp: async () => {
        (window as typeof window & { __rudderReloadAppCalls?: number }).__rudderReloadAppCalls =
          ((window as typeof window & { __rudderReloadAppCalls?: number }).__rudderReloadAppCalls ?? 0) + 1;
        await new Promise(() => {});
      },
      restart: async () => {},
      copyText: async () => {},
      getBootState: async () => ({}),
      onBootState: () => () => {},
      openPath: async () => {},
      listAvailableIdes: async () => [],
      openWorkspaceFileInIde: async () => {},
      setAppearance: async () => {},
      getAppVersion: async () => "e2e",
      checkForUpdates: async () => ({
        status: "unavailable",
        channel: "stable",
        currentVersion: "e2e",
        checkedAt: new Date(0).toISOString(),
      }),
      installUpdate: async () => ({ status: "unavailable", message: "e2e" }),
      sendFeedback: async () => {},
      openExternal: async () => {},
      openNotificationSettings: async () => ({ opened: false, platform: "e2e" }),
      setBadgeCount: async () => {},
      showNotification: async () => {},
      pickPath: async () => ({ canceled: true, path: null }),
    };
  });

  await page.goto("/");

  await expect(page.getByText("Rudder is refreshing the UI...")).toBeVisible();
  await expect(page.getByText("Rudder hit a UI failure.")).toHaveCount(0);
  await expect(page.getByText(CHILDREN_ONLY_MESSAGE)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __rudderReloadAppCalls?: number }).__rudderReloadAppCalls ?? 0
  ))).toBe(1);

  await expect(page.getByText("Rudder hit a UI failure.")).toBeVisible();
  await expect(page.getByText(CHILDREN_ONLY_MESSAGE)).toBeVisible();
});
