import { expect, test } from "@playwright/test";

const CHILDREN_ONLY_MESSAGE = "React.Children.only expected to receive a single React element child.";
const INSERT_BEFORE_MESSAGE = "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.";
const AUTO_RECOVERY_STORAGE_KEY = "rudder:app-error-boundary:auto-recovery.v1";
const E2E_RELOAD_CALLS_KEY = "rudder:e2e:app-error-boundary:reload-calls";

for (const renderFailure of [
  { mode: "children-only" as const, message: CHILDREN_ONLY_MESSAGE },
  { mode: "insert-before" as const, message: INSERT_BEFORE_MESSAGE },
]) {
  test(`auto refreshes ${renderFailure.mode} app render failures once`, async ({ page }) => {
    await page.addInitScript(({ mode, reloadCallsKey }) => {
      window.__RUDDER_E2E_THROW_APP_RENDER_ERROR__ = mode;
      (window as typeof window & { desktopShell?: unknown }).desktopShell = {
        reloadApp: async () => {
          const calls = Number(window.sessionStorage.getItem(reloadCallsKey) ?? "0");
          window.sessionStorage.setItem(reloadCallsKey, String(calls + 1));
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
    }, { mode: renderFailure.mode, reloadCallsKey: E2E_RELOAD_CALLS_KEY });

    await page.goto("/", { waitUntil: "commit" });

    await expect.poll(() => page.evaluate((reloadCallsKey) => (
      Number(window.sessionStorage.getItem(reloadCallsKey) ?? "0")
    ), E2E_RELOAD_CALLS_KEY), { timeout: 20_000 }).toBe(1);
    await page.waitForTimeout(250);
    expect(await page.evaluate((reloadCallsKey) => (
      Number(window.sessionStorage.getItem(reloadCallsKey) ?? "0")
    ), E2E_RELOAD_CALLS_KEY)).toBe(1);
  });

  test(`shows diagnostics when ${renderFailure.mode} recovery already ran`, async ({ page }) => {
    await page.addInitScript(({ mode, message, storageKey, reloadCallsKey }) => {
      window.__RUDDER_E2E_THROW_APP_RENDER_ERROR__ = mode;
      window.sessionStorage.setItem(storageKey, JSON.stringify({
        attemptedAt: Date.now(),
        message,
        route: "/",
      }));
      (window as typeof window & { desktopShell?: unknown }).desktopShell = {
        reloadApp: async () => {
          const calls = Number(window.sessionStorage.getItem(reloadCallsKey) ?? "0");
          window.sessionStorage.setItem(reloadCallsKey, String(calls + 1));
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
    }, {
      mode: renderFailure.mode,
      message: renderFailure.message,
      storageKey: AUTO_RECOVERY_STORAGE_KEY,
      reloadCallsKey: E2E_RELOAD_CALLS_KEY,
    });

    await page.goto("/");
    await expect(page.getByText("Rudder hit a UI failure.")).toBeVisible();
    await expect(page.getByText(renderFailure.message)).toBeVisible();
    await expect.poll(() => page.evaluate((reloadCallsKey) => (
      Number(window.sessionStorage.getItem(reloadCallsKey) ?? "0")
    ), E2E_RELOAD_CALLS_KEY)).toBe(0);
  });
}
