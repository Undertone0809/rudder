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
          importedCount: 313,
          skippedCount: 3484,
          failedCount: 0,
          errors: [
            {
              errorCode: "COOKIE_EXPIRED",
              message: "An expired cookie was skipped.",
              count: 84,
              kind: "skipped",
            },
            {
              errorCode: "COOKIE_PARTITION_UNSUPPORTED",
              message: "A partitioned cookie is not supported by this version of Rudder.",
              count: 565,
              kind: "skipped",
            },
            {
              errorCode: "COOKIE_ALREADY_EXISTS",
              message: "A matching cookie already exists in the Rudder Browser and was preserved.",
              count: 2835,
              kind: "skipped",
            },
          ],
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
    await expect(sidePanel.getByTestId("chat-side-panel-browser-webview"))
      .toHaveAttribute("src", "https://example.net/disabled");
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __rudderBrowserExternalUrls: string[] }
    ).__rudderBrowserExternalUrls)).not.toContain("https://example.net/disabled");
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
    await expect(importDialog.getByLabel("Imported 313")).toBeVisible();
    await expect(importDialog.getByLabel("Skipped 3484")).toBeVisible();
    await expect(importDialog.getByLabel("Failed 0")).toBeVisible();
    const skippedDetails = importDialog.getByTestId("browser-import-skipped-details-trigger");
    await expect(skippedDetails).toHaveAttribute("aria-expanded", "false");
    await expect(skippedDetails).toContainText("3 reasons");
    await expect(importDialog.getByText("COOKIE_PARTITION_UNSUPPORTED", { exact: true })).toHaveCount(0);
    await skippedDetails.click();
    await expect(skippedDetails).toHaveAttribute("aria-expanded", "true");
    const skippedDetailsContent = importDialog.getByTestId("browser-import-skipped-details-content");
    await skippedDetailsContent.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await expect(importDialog.getByText("COOKIE_PARTITION_UNSUPPORTED", { exact: true })).toHaveCount(1);
    const skippedRows = importDialog.getByTestId("browser-import-skipped-detail");
    await expect(skippedRows).toHaveCount(3);
    const renderedSkippedRows = await skippedRows.all();
    for (const row of renderedSkippedRows) {
      const layout = await row.evaluate((element) => {
        const reason = element.firstElementChild?.getBoundingClientRect();
        const count = element.lastElementChild?.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return {
          overflows: element.scrollWidth > element.clientWidth,
          reasonEndsBeforeCount: Boolean(reason && count && reason.right <= count.left),
          countStaysInside: Boolean(count && count.right <= bounds.right + 0.5),
        };
      });
      expect(layout).toEqual({
        overflows: false,
        reasonEndsBeforeCount: true,
        countStaysInside: true,
      });
    }
    await expect(importDialog.locator(".text-destructive")).toHaveCount(0);
    const cancelButton = importDialog.getByRole("button", { name: "Cancel" });
    await expect(cancelButton).toBeVisible();
    const dialogBounds = await importDialog.boundingBox();
    expect(dialogBounds).not.toBeNull();
    expect(dialogBounds!.y).toBeGreaterThanOrEqual(0);
    expect(dialogBounds!.y + dialogBounds!.height).toBeLessThanOrEqual(640);
    await page.setViewportSize({ width: 1100, height: 760 });
    await importDialog.getByTestId("browser-import-result-panel").scrollIntoViewIfNeeded();
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

    await modal.getByRole("switch", { name: "Enable Browser access for Agents" }).click();
    await expect.poll(async () => (await page.request.get("/api/instance/settings/browser")).json()).toMatchObject({
      enabled: false,
      openLinksIn: "default_browser",
    });
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __rudderBrowserEnabledCalls: boolean[] }
    ).__rudderBrowserEnabledCalls)).toContain(false);
    await modal.getByRole("button", { name: "Rudder Built-in Browser" }).click();
    await expect.poll(async () => (await page.request.get("/api/instance/settings/browser")).json()).toMatchObject({
      enabled: false,
      openLinksIn: "built_in",
    });
    await page.evaluate(() => (
      window as typeof window & { __emitDesktopWebLink(request: DesktopWebLinkRequest): void }
    ).__emitDesktopWebLink({ url: "https://example.net/agent-disabled", source: "link" }));
    await expect(page.getByTestId("chat-side-panel-browser-webview"))
      .toHaveAttribute("src", "https://example.net/agent-disabled");
    await expect(modal.getByRole("button", { name: "Import..." })).toBeDisabled();
    await expect(modal.getByText("Enable Browser access for Agents before importing data.")).toBeVisible();
  });
});
