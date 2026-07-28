import { expect, test, type Page } from "@playwright/test";

const RUDDER_DISCORD_URL = "https://discord.gg/ZcfWwPVkUz";
const DISMISSAL_KEY = "rudder:messenger:discord-cta:v1";
const ELIGIBILITY_KEY = "rudder:messenger:discord-cta:eligible:v1";
const COOLDOWN_MS = 15 * 24 * 60 * 60 * 1_000;

async function resetDiscordCtaState(page: Page) {
  await page.addInitScript(({ dismissalKey, eligibilityKey }) => {
    window.localStorage.removeItem(dismissalKey);
    window.localStorage.removeItem(eligibilityKey);
  }, {
    dismissalKey: DISMISSAL_KEY,
    eligibilityKey: ELIGIBILITY_KEY,
  });
}

async function seedEligibleDiscordCtaState(page: Page) {
  await page.addInitScript(({ dismissalKey, eligibilityKey, seedKey }) => {
    if (window.sessionStorage.getItem(seedKey) === "seeded") return;
    window.localStorage.removeItem(dismissalKey);
    window.localStorage.setItem(eligibilityKey, "eligible");
    window.sessionStorage.setItem(seedKey, "seeded");
  }, {
    dismissalKey: DISMISSAL_KEY,
    eligibilityKey: ELIGIBILITY_KEY,
    seedKey: "rudder:e2e:discord-cta-seeded",
  });
}

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createOrganizationAndAgent(page: Page, name: string) {
  const organization = await createOrganization(page, name);
  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Discord Guide",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  return { agent, organization };
}

test.describe("Messenger Discord invitation", () => {
  test("opens the official invite in the system browser instead of built-in Browser", async ({ page }) => {
    await resetDiscordCtaState(page);
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

    const { agent, organization } = await createOrganizationAndAgent(
      page,
      `Messenger Discord ${Date.now()}`,
    );

    await page.goto(`/${organization.issuePrefix}/messenger`);
    await expect(page.getByTestId("messenger-discord-cta")).toHaveCount(0);

    const runResponse = await page.request.post(
      `/api/agents/${agent.id}/heartbeat/invoke?orgId=${organization.id}`,
    );
    expect(runResponse.ok()).toBe(true);
    const cta = page.getByTestId("messenger-discord-cta");
    await expect(cta).toBeVisible();
    await expect.poll(() => page.evaluate(
      (key) => window.localStorage.getItem(key),
      ELIGIBILITY_KEY,
    )).toBe("eligible");
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

  test("shows again 15 days after dismissal", async ({ page }) => {
    await seedEligibleDiscordCtaState(page);
    const organization = await createOrganization(
      page,
      `Dismiss Discord ${Date.now()}`,
    );

    await page.goto(`/${organization.issuePrefix}/messenger`);
    const cta = page.getByTestId("messenger-discord-cta");
    await expect(cta).toBeVisible();

    await cta.getByRole("button", { name: "Dismiss Discord invitation" }).click();
    await expect(cta).toBeHidden();
    await expect.poll(() => page.evaluate(
      (key) => Number(window.localStorage.getItem(key)),
      DISMISSAL_KEY,
    )).toBeGreaterThan(0);

    await page.reload();
    await expect(page.getByTestId("messenger-discord-cta")).toHaveCount(0);

    await page.evaluate(({ key, cooldownMs }) => {
      window.localStorage.setItem(key, String(Date.now() - cooldownMs));
    }, { key: DISMISSAL_KEY, cooldownMs: COOLDOWN_MS });
    await page.reload();
    await expect(page.getByTestId("messenger-discord-cta")).toBeVisible();
  });
});
