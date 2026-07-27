import { expect, test } from "@playwright/test";

const RUDDER_DOCS_URL = "https://docs.rudderhq.dev";

test.describe("Settings docs link", () => {
  test("opens the official docs in the system browser from desktop settings", async ({ page }) => {
    await page.addInitScript(() => {
      const routedExternalUrls: string[] = [];
      const forcedExternalUrls: string[] = [];
      Object.assign(window, {
        __rudderRoutedExternalUrls: routedExternalUrls,
        __rudderForcedExternalUrls: forcedExternalUrls,
        desktopShell: {
          openExternal: async (url: string) => { routedExternalUrls.push(url); },
          forceOpenExternal: async (url: string) => { forcedExternalUrls.push(url); },
        },
      });
    });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Settings Docs ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const docsLink = modal.getByRole("link", { name: /Docs/ });
    await expect(docsLink).toBeVisible();
    await expect(docsLink).toHaveAttribute("href", RUDDER_DOCS_URL);
    await expect(docsLink).toHaveAttribute("target", "_blank");
    await docsLink.click();

    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __rudderForcedExternalUrls?: string[] })
        .__rudderForcedExternalUrls ?? []
    ))).toEqual([RUDDER_DOCS_URL]);
    expect(await page.evaluate(() => (
      (window as typeof window & { __rudderRoutedExternalUrls?: string[] })
        .__rudderRoutedExternalUrls ?? []
    ))).toEqual([]);
  });
});
