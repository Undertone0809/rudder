import { expect, test, type Page } from "@playwright/test";

type DesktopWebLinkRequest = {
  url: string;
  source: "link" | "browser_popup";
};

async function installBrowserDesktopStub(page: Page) {
  await page.addInitScript(() => {
    let webLinkListener: ((request: DesktopWebLinkRequest) => void) | null = null;
    let browserResetListener: ((event: { reason: "clear" | "disabled"; enabled: boolean; available: boolean }) => void) | null = null;
    const externalUrls: string[] = [];
    const enabledCalls: boolean[] = [];
    let clearCalls = 0;
    Object.assign(window, {
      __rudderBrowserExternalUrls: externalUrls,
      __rudderBrowserEnabledCalls: enabledCalls,
      __emitDesktopWebLink: (request: DesktopWebLinkRequest) => webLinkListener?.(request),
      __rudderBrowserClearCalls: () => clearCalls,
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        setSidePanelCloseShortcutActive: async () => {},
        onCloseSidePanelActiveTab: () => () => {},
        onOpenWebLink: (listener: (request: DesktopWebLinkRequest) => void) => {
          webLinkListener = listener;
          return () => { webLinkListener = null; };
        },
        openExternal: async (url: string) => { externalUrls.push(url); },
        forceOpenExternal: async (url: string) => { externalUrls.push(url); },
        getBrowserPartition: async () => "persist:rudder-browser-v1-e2e",
        setBrowserEnabled: async (enabled: boolean) => {
          enabledCalls.push(enabled);
          if (!enabled) browserResetListener?.({ reason: "disabled", enabled: false, available: false });
        },
        onBrowserReset: (listener: typeof browserResetListener) => {
          browserResetListener = listener;
          return () => { browserResetListener = null; };
        },
        listBrowserImportSources: async () => [{
          id: "opaque-chrome-default",
          displayName: "Google Chrome - Default",
          browserName: "Google Chrome",
          profileName: "Default",
          supported: { cookies: true, passwords: false },
        }],
        importBrowserData: async () => ({
          status: "succeeded",
          importedCount: 12,
          skippedCount: 2,
          failedCount: 0,
          errors: [{
            errorCode: "COOKIE_PARTITION_UNSUPPORTED",
            message: "Partitioned cookies are not supported and were skipped.",
            count: 2,
            kind: "skipped",
          }],
        }),
        clearBrowserData: async () => {
          clearCalls += 1;
          browserResetListener?.({ reason: "clear", enabled: true, available: false });
        },
      },
    });
  });
}

test.describe("Built-in Browser", () => {
  test.beforeEach(async ({ page }) => {
    await installBrowserDesktopStub(page);
    const reset = await page.request.patch("/api/instance/settings/browser", {
      data: { enabled: true, openLinksIn: "built_in" },
    });
    expect(reset.ok(), await reset.text()).toBe(true);
  });

  test("routes Rudder web links through live instance settings", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Built-in Browser Link Router ${Date.now()}` },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await expect.poll(() => page.evaluate(() => typeof (
      window as typeof window & { __emitDesktopWebLink?: unknown }
    ).__emitDesktopWebLink)).toBe("function");
    const dashboardUrl = page.url();

    await page.evaluate(() => (
      window as typeof window & { __emitDesktopWebLink(request: DesktopWebLinkRequest): void }
    ).__emitDesktopWebLink({ url: "https://example.com/docs", source: "link" }));
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible();
    await expect(sidePanel.getByTestId("chat-side-panel-browser-webview")).toHaveAttribute("src", "https://example.com/docs");
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(1);
    expect(page.url()).toBe(dashboardUrl);

    await page.evaluate(() => (
      window as typeof window & { __emitDesktopWebLink(request: DesktopWebLinkRequest): void }
    ).__emitDesktopWebLink({ url: "https://example.com/docs", source: "link" }));
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(1);

    await page.evaluate(() => (
      window as typeof window & { __emitDesktopWebLink(request: DesktopWebLinkRequest): void }
    ).__emitDesktopWebLink({ url: "https://example.com/docs", source: "browser_popup" }));
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(2);

    const defaultBrowser = await page.request.patch("/api/instance/settings/browser", {
      data: { openLinksIn: "default_browser" },
    });
    expect(defaultBrowser.ok(), await defaultBrowser.text()).toBe(true);
    await page.evaluate(() => (
      window as typeof window & { __emitDesktopWebLink(request: DesktopWebLinkRequest): void }
    ).__emitDesktopWebLink({ url: "https://example.org/popup", source: "browser_popup" }));
    await expect(sidePanel.getByTestId("chat-side-panel-tab")).toHaveCount(3);
    await expect(sidePanel.getByTestId("chat-side-panel-browser-webview")).toHaveAttribute("src", "https://example.org/popup");

    await page.evaluate(() => (
      window as typeof window & { __emitDesktopWebLink(request: DesktopWebLinkRequest): void }
    ).__emitDesktopWebLink({ url: "https://example.org/system", source: "link" }));
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __rudderBrowserExternalUrls: string[] }
    ).__rudderBrowserExternalUrls)).toContain("https://example.org/system");

    const disabled = await page.request.patch("/api/instance/settings/browser", {
      data: { enabled: false, openLinksIn: "built_in" },
    });
    expect(disabled.ok(), await disabled.text()).toBe(true);
    await page.evaluate(() => (
      window as typeof window & { __emitDesktopWebLink(request: DesktopWebLinkRequest): void }
    ).__emitDesktopWebLink({ url: "https://example.net/disabled", source: "link" }));
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __rudderBrowserExternalUrls: string[] }
    ).__rudderBrowserExternalUrls)).toContain("https://example.net/disabled");
  });

  test("configures, imports, and clears the shared Browser profile", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1100, height: 640 });
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Built-in Browser Settings ${Date.now()}` },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();
    const modal = page.getByTestId("settings-modal-shell");
    await modal.locator('a[href$="/instance/settings/browser"]').click();
    await expect(modal.getByRole("heading", { name: "Browser", level: 1 })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Rudder Built-in Browser" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect(modal.getByText(/shared by every organization and Agent/i)).toBeVisible();

    await modal.getByRole("button", { name: "Default browser" }).click();
    await expect.poll(async () => (await page.request.get("/api/instance/settings/browser")).json()).toMatchObject({
      enabled: true,
      openLinksIn: "default_browser",
    });

    await modal.getByRole("button", { name: "Import..." }).click();
    const importDialog = page.getByRole("dialog", { name: "Import browser data" });
    await expect(importDialog).toBeVisible();
    await expect(importDialog.getByLabel("Browser profile")).toHaveValue("opaque-chrome-default");
    await expect(importDialog.getByText("Passwords", { exact: true })).toBeVisible();
    await expect(importDialog.getByText("Not available in this version", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("built-in-browser-import-dialog.png"), fullPage: true });
    await importDialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(importDialog.getByRole("status")).toContainText("Import complete");
    await expect(importDialog.getByRole("status")).toContainText("Imported 12");
    await expect(importDialog.getByRole("status")).toContainText("Skipped 2");
    await expect(importDialog.getByRole("status")).toContainText("Failed 0");
    await expect(importDialog.getByRole("status")).toContainText("Skipped details");
    await expect(importDialog.getByText("COOKIE_PARTITION_UNSUPPORTED", { exact: true })).toHaveCount(1);
    await expect(importDialog.locator(".text-destructive")).toHaveCount(0);
    const cancelButton = importDialog.getByRole("button", { name: "Cancel" });
    await expect(cancelButton).toBeVisible();
    const dialogBounds = await importDialog.boundingBox();
    expect(dialogBounds).not.toBeNull();
    expect(dialogBounds!.y).toBeGreaterThanOrEqual(0);
    expect(dialogBounds!.y + dialogBounds!.height).toBeLessThanOrEqual(640);
    await page.screenshot({ path: testInfo.outputPath("built-in-browser-import-result.png"), fullPage: true });
    await cancelButton.click();

    await modal.getByRole("button", { name: "Clear all browsing data" }).click();
    const confirmDialog = page.getByRole("dialog", { name: "Clear all browsing data?" });
    await expect(confirmDialog).toContainText("Every organization will be signed out");
    await confirmDialog.getByRole("button", { name: "Clear all browsing data" }).click();
    await expect(modal.getByText("All browsing data was cleared.")).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __rudderBrowserClearCalls(): number }
    ).__rudderBrowserClearCalls())).toBe(1);

    await modal.getByRole("switch", { name: "Enable Rudder Browser" }).click();
    await expect.poll(async () => (await page.request.get("/api/instance/settings/browser")).json()).toMatchObject({
      enabled: false,
      openLinksIn: "default_browser",
    });
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __rudderBrowserEnabledCalls: boolean[] }
    ).__rudderBrowserEnabledCalls)).toContain(false);
    await expect(modal.getByRole("button", { name: "Import..." })).toBeDisabled();
    await expect(modal.getByText("Enable Rudder Browser before importing data.")).toBeVisible();
  });
});
