import { expect, type Locator, type Page, test } from "@playwright/test";

type Organization = {
  id: string;
  issuePrefix: string;
  name: string;
  urlKey?: string;
};

type ShellSize = {
  width: number;
  height: number;
};

async function createOrganization(page: Page, prefix: string): Promise<Organization> {
  const name = `Settings layout ${prefix} ${Date.now()}`;
  const response = await page.request.post("/api/orgs", {
    data: {
      name,
      issuePrefix: `${prefix}${Date.now().toString().slice(-6)}`,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Organization>;
}

async function openSettings(page: Page, organization: Organization) {
  await page.addInitScript(() => {
    window.localStorage.setItem("rudder.productTour.completed.v1", "true");
    window.localStorage.removeItem("rudder.productTour.pendingAfterSetup.v1");
  });
  await page.goto(`/${organization.urlKey ?? organization.issuePrefix}/dashboard`);
  const openSidebar = page.getByRole("button", { name: "Open sidebar" });
  if (await openSidebar.isVisible()) {
    await openSidebar.click();
  }
  await page.getByRole("button", { name: "System settings" }).click();

  const modal = page.getByTestId("settings-modal-shell");
  await expect(modal).toBeVisible();
  return modal;
}

async function getShellSize(modal: Locator): Promise<ShellSize> {
  const box = await modal.boundingBox();
  expect(box).not.toBeNull();
  return { width: box!.width, height: box!.height };
}

async function expectStableSettingsLayout(modal: Locator, reference: ShellSize) {
  const settingsPage = modal.locator('[data-slot="settings-page"]');
  const main = modal.locator("#main-content");
  await expect(settingsPage).toBeVisible();

  const current = await getShellSize(modal);
  expect(Math.abs(current.width - reference.width)).toBeLessThanOrEqual(3);
  expect(Math.abs(current.height - reference.height)).toBeLessThanOrEqual(3);
  expect(await settingsPage.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await main.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

async function visitSettingsPage({
  modal,
  href,
  heading,
  reference,
}: {
  modal: Locator;
  href: string;
  heading: string;
  reference: ShellSize;
}) {
  const link = modal.locator(`a[href$="${href}"]`);
  await expect(link).toBeVisible();
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(modal.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
  await expectStableSettingsLayout(modal, reference);
}

test.describe("Settings layout", () => {
  test("keeps the desktop settings shell and page grammar stable across representative pages", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const organization = await createOrganization(page, "SLD");
    const settingsTrigger = page.locator('[data-settings-trigger="true"]').first();
    const modal = await openSettings(page, organization);
    const reference = await getShellSize(modal);
    const backgroundWorkspace = page.getByTestId("workspace-shell");

    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="settings-modal-shell"]')))).toBe(true);
    await expect(modal.getByRole("button", { name: "Close settings" })).toBeVisible();
    await expect.poll(() => backgroundWorkspace.evaluate((element) => Boolean(element.closest("[inert]")))).toBe(true);
    await expect.poll(() => backgroundWorkspace.evaluate((element) => Boolean(element.closest('[aria-hidden="true"]')))).toBe(true);
    await modal.locator("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])").first().focus();
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="settings-modal-shell"]')))).toBe(true);
    await page.keyboard.press("Tab");
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="settings-modal-shell"]')))).toBe(true);
    await expect(modal.getByRole("heading", { name: "Organization Settings", level: 1 })).toBeVisible();
    await expectStableSettingsLayout(modal, reference);
    await expect(modal.getByRole("button", { name: organization.name })).toHaveAttribute("aria-pressed", "true");

    const archiveTrigger = modal.getByRole("button", { name: "Archive organization" });
    await archiveTrigger.click();
    const archiveDialog = page.getByRole("dialog", { name: "Archive organization?" });
    await expect(archiveDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(archiveDialog).toHaveCount(0);
    await expect(archiveTrigger).toBeFocused();
    await expect(modal).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="settings-modal-shell"]')))).toBe(true);

    const destinations = [
      { href: "/instance/settings/profile", heading: "Profile" },
      { href: "/instance/settings/appearance", heading: "Appearance" },
      { href: "/instance/settings/notifications", heading: "System permissions" },
      { href: "/instance/settings/heartbeats", heading: "Heartbeats" },
      { href: "/instance/settings/plugins", heading: "Plugin Manager" },
    ];

    const browserLink = modal.locator('a[href$="/instance/settings/browser"]');
    if (await browserLink.count()) {
      destinations.splice(2, 0, { href: "/instance/settings/browser", heading: "Browser" });
    }

    for (const destination of destinations) {
      await visitSettingsPage({ modal, ...destination, reference });
    }

    const organizationButton = modal.getByRole("button", { name: organization.name });
    await organizationButton.click();
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey ?? organization.issuePrefix}/organization/settings$`));
    await expect(organizationButton).toHaveAttribute("aria-pressed", "true");
    await expect(modal.locator('a[href$="/instance/settings/plugins"]')).not.toHaveAttribute("aria-current", "page");
    await expect(modal.getByRole("heading", { name: "Organization Settings", level: 1 })).toBeVisible();
    await expectStableSettingsLayout(modal, reference);

    await page.mouse.move(0, 0);
    await page.screenshot({
      path: testInfo.outputPath("settings-layout-desktop.png"),
      fullPage: false,
    });

    await modal.getByRole("button", { name: "Close settings" }).click();
    await expect(modal).toHaveCount(0);
    await expect(settingsTrigger).toBeFocused();
  });

  test("uses a focused mobile drawer that auto-closes on navigation and closes before the modal on Escape", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const organization = await createOrganization(page, "SLM");
    const modal = await openSettings(page, organization);
    const reference = await getShellSize(modal);
    const navigation = modal.getByTestId("settings-modal-navigation");
    const openNavigation = modal.getByRole("button", { name: "Open sidebar" });

    await expect(navigation).toHaveAttribute("aria-hidden", "true");
    await expect(openNavigation).toBeFocused();
    await expectStableSettingsLayout(modal, reference);

    await openNavigation.click();
    await expect(navigation).toHaveAttribute("aria-hidden", "false");
    await expect(modal.getByRole("button", { name: "Close sidebar (System settings)" })).toBeFocused();

    const appearanceLink = navigation.locator('a[href$="/instance/settings/appearance"]');
    await appearanceLink.click();
    await expect(appearanceLink).toHaveAttribute("aria-current", "page");
    await expect(navigation).toHaveAttribute("aria-hidden", "true");
    await expect(openNavigation).toBeFocused();
    await expect(modal.getByRole("heading", { name: "Appearance", level: 1 })).toBeVisible();
    await expectStableSettingsLayout(modal, reference);

    await page.screenshot({
      path: testInfo.outputPath("settings-layout-mobile.png"),
      fullPage: false,
    });

    await openNavigation.click();
    await expect(navigation).toHaveAttribute("aria-hidden", "false");
    await page.keyboard.press("Escape");
    await expect(navigation).toHaveAttribute("aria-hidden", "true");
    await expect(modal).toBeVisible();
    await expect(openNavigation).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey ?? organization.issuePrefix}/dashboard$`));
    await expect(page.locator('[data-settings-trigger="true"]').first()).toBeFocused();
  });
});
