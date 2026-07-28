import { expect, test } from "@playwright/test";

const RUDDER_DISCORD_URL = "https://discord.gg/ZcfWwPVkUz";
const DISMISSAL_KEY = "rudder:messenger:discord-cta:v1";

test.describe("Messenger Discord invitation", () => {
  test("opens the official invite in the system browser instead of built-in Browser", async ({ page }) => {
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
      data: { name: `Messenger Discord ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/messenger`);

    const cta = page.getByTestId("messenger-discord-cta");
    await expect(cta).toBeVisible();
    const invite = cta.getByRole("link", { name: /Join our Discord/ });
    await expect(invite).toHaveAttribute("href", RUDDER_DISCORD_URL);
    await expect(invite).toHaveAttribute("target", "_blank");
    await expect(cta.getByTestId("discord-logo")).toBeVisible();
    await invite.click();

    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __rudderForcedExternalUrls?: string[] })
        .__rudderForcedExternalUrls ?? []
    ))).toEqual([RUDDER_DISCORD_URL]);
    expect(await page.evaluate(() => (
      (window as typeof window & { __rudderRoutedExternalUrls?: string[] })
        .__rudderRoutedExternalUrls ?? []
    ))).toEqual([]);
  });

  test("persists dismissal across Messenger reloads", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Dismiss Discord ${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/messenger`);
    const cta = page.getByTestId("messenger-discord-cta");
    await expect(cta).toBeVisible();

    await cta.getByRole("button", { name: "Dismiss Discord invitation" }).click();
    await expect(cta).toBeHidden();
    await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), DISMISSAL_KEY))
      .toBe("dismissed");

    await page.reload();
    await expect(page.getByTestId("messenger-discord-cta")).toHaveCount(0);
  });
});
