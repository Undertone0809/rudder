import { expect, test } from "@playwright/test";

const RUDDER_DISCORD_URL = "https://discord.gg/ZcfWwPVkUz";
const DISMISSAL_KEY = "rudder:messenger:discord-cta:v1";

test.describe("Messenger Discord invitation", () => {
  test("opens the official invite in a safe new window", async ({ page }) => {
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

    await page.context().route(RUDDER_DISCORD_URL, (route) => route.fulfill({
      body: "Discord invite",
      contentType: "text/html",
      status: 200,
    }));
    const popupPromise = page.waitForEvent("popup");
    await invite.click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    expect(popup.url()).toBe(RUDDER_DISCORD_URL);
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
