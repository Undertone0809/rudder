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

async function expectShellWithinViewport(page: Page, modal: Locator) {
  const box = await modal.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
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

async function expectCompactChoiceCards(modal: Locator, expectedCount: number) {
  const choiceGroup = modal.locator('[data-slot="settings-choice-grid"]').first();
  await expect(choiceGroup).toBeVisible();
  await expect(choiceGroup.locator('[data-slot="settings-choice-card"]')).toHaveCount(expectedCount);

  const geometry = await choiceGroup.evaluate((element) => {
    const containerBox = element.getBoundingClientRect();
    const cardBoxes = Array.from(
      element.querySelectorAll<HTMLElement>('[data-slot="settings-choice-card"]'),
      (card) => card.getBoundingClientRect(),
    );
    return {
      containerRight: containerBox.right,
      cardWidths: cardBoxes.map((box) => box.width),
      cardTops: cardBoxes.map((box) => box.top),
      lastCardRight: cardBoxes.at(-1)?.right ?? containerBox.right,
    };
  });

  expect(Math.max(...geometry.cardWidths)).toBeLessThan(260);
  expect(Math.max(...geometry.cardTops) - Math.min(...geometry.cardTops)).toBeLessThanOrEqual(3);
  expect(geometry.containerRight - geometry.lastCardRight).toBeGreaterThan(80);
}

test.describe("Settings layout", () => {
  test("keeps the desktop settings shell and page grammar stable across representative pages", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const organization = await createOrganization(page, "SLD");
    const settingsTrigger = page.locator('[data-settings-trigger="true"]').first();
    const modal = await openSettings(page, organization);
    const reference = await getShellSize(modal);
    const backgroundWorkspace = page.getByTestId("workspace-shell");
    const backdropFilter = await page.getByTestId("settings-modal-backdrop").evaluate(
      (element) => getComputedStyle(element).backdropFilter,
    );

    expect(backdropFilter).toContain("blur(30px)");
    expect(reference.width).toBeGreaterThanOrEqual(1406);
    expect(reference.width).toBeLessThanOrEqual(1410);
    expect(reference.height).toBeGreaterThanOrEqual(850);
    expect(reference.height).toBeLessThanOrEqual(854);
    await expectShellWithinViewport(page, modal);
    const sidebarWidth = await modal.getByTestId("workspace-sidebar").evaluate((element) => element.getBoundingClientRect().width);
    expect(sidebarWidth).toBeGreaterThanOrEqual(182);
    expect(sidebarWidth).toBeLessThanOrEqual(186);

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

    await visitSettingsPage({
      modal,
      href: "/instance/settings/general",
      heading: "General",
      reference,
    });
    await expectCompactChoiceCards(modal, 2);

    await visitSettingsPage({
      modal,
      href: "/instance/settings/appearance",
      heading: "Appearance",
      reference,
    });
    await expectCompactChoiceCards(modal, 3);

    const destinations = [
      { href: "/instance/settings/profile", heading: "Profile" },
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
    await expectShellWithinViewport(page, modal);
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
    await expectShellWithinViewport(page, modal);

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

  test("restores the glass backdrop in the dark macOS desktop shell", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "desktopShell", {
        configurable: true,
        value: {},
      });
      window.localStorage.setItem("rudder.theme", "dark");
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    const organization = await createOrganization(page, "SLG");
    const modal = await openSettings(page, organization);
    const backdrop = page.getByTestId("settings-modal-backdrop");

    await expect(modal).toBeVisible();
    await expect(backdrop).toBeVisible();
    await expect.poll(() => page.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      macOS: document.documentElement.classList.contains("desktop-shell-macos"),
    }))).toEqual({ dark: true, macOS: true });
    const backdropFilter = await backdrop.evaluate((element) => getComputedStyle(element).backdropFilter);
    expect(backdropFilter).toContain("blur(34px)");

    await page.screenshot({
      path: testInfo.outputPath("settings-layout-dark-macos.png"),
      fullPage: false,
    });
  });

  test("uses the shared layered glass hover treatment on settings actions", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const organization = await createOrganization(page, "SLH");
    const modal = await openSettings(page, organization);
    const aboutLink = modal.locator('a[href$="/instance/settings/about"]');
    await aboutLink.click();
    await expect(modal.getByRole("heading", { name: "About", level: 1 })).toBeVisible();
    await expect.poll(() => modal.evaluate(
      (element) => element.getAnimations().every((animation) => animation.playState === "finished"),
    )).toBe(true);
    await page.evaluate(() => document.fonts.ready);

    for (const label of ["Check for updates", "Send Feedback"]) {
      const button = modal.getByRole("button", { name: label, exact: true });
      await expect(button).toHaveClass(/control-hover/);
      const restState = await button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          background: getComputedStyle(element).backgroundColor,
          border: getComputedStyle(element).borderColor,
          boxShadow: getComputedStyle(element).boxShadow,
          scale: getComputedStyle(element).scale,
          transform: getComputedStyle(element).transform,
          coreOpacity: getComputedStyle(element, "::before").opacity,
        };
      });
      await button.hover();
      await expect.poll(() => button.evaluate((element) => getComputedStyle(element, "::before").opacity)).toBe("1");
      const hoverStyle = await button.evaluate((element) => {
        const style = getComputedStyle(element);
        const coreStyle = getComputedStyle(element, "::before");
        const rect = element.getBoundingClientRect();
        return {
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          background: style.backgroundColor,
          border: style.borderColor,
          boxShadow: style.boxShadow,
          scale: style.scale,
          transform: style.transform,
          coreBackground: coreStyle.backgroundColor,
          coreBackdropFilter: coreStyle.backdropFilter,
          coreOpacity: coreStyle.opacity,
        };
      });
      expect(restState.coreOpacity).toBe("0");
      expect(hoverStyle.coreOpacity).toBe("1");
      expect(hoverStyle.coreBackground).not.toBe(hoverStyle.background);
      expect(hoverStyle.background).toBe(restState.background);
      expect(hoverStyle.border).toBe(restState.border);
      expect(hoverStyle.boxShadow).toBe(restState.boxShadow);
      expect(hoverStyle.coreBackdropFilter).toContain("blur(16px)");
      expect(hoverStyle.rect).toEqual(restState.rect);
      expect(hoverStyle.scale).toBe(restState.scale);
      expect(hoverStyle.transform).toBe(restState.transform);
    }

    await page.mouse.move(0, 0);
    const darkButton = modal.getByRole("button", { name: "Check for updates", exact: true });
    await expect.poll(() => darkButton.evaluate(
      (element) => getComputedStyle(element, "::before").opacity,
    )).toBe("0");
    const lightRestBackground = await darkButton.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.evaluate(() => {
      window.localStorage.setItem("rudder.theme", "dark");
      document.documentElement.classList.add("dark");
    });
    await expect.poll(() => darkButton.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(lightRestBackground);
    await expect.poll(() => darkButton.evaluate(
      (element) => element.getAnimations({ subtree: true }).every((animation) => animation.playState === "finished"),
    )).toBe(true);
    await expect.poll(() => darkButton.evaluate((element) => getComputedStyle(element, "::before").opacity)).toBe("0");
    const darkRestBackground = await darkButton.evaluate((element) => getComputedStyle(element).backgroundColor);
    await darkButton.hover();
    await expect.poll(() => darkButton.evaluate((element) => getComputedStyle(element, "::before").opacity)).toBe("1");
    const darkHoverStyle = await darkButton.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      coreBackground: getComputedStyle(element, "::before").backgroundColor,
      coreOpacity: getComputedStyle(element, "::before").opacity,
    }));
    expect(darkHoverStyle.background).toBe(darkRestBackground);
    expect(darkHoverStyle.coreBackground).not.toBe(darkHoverStyle.background);
    expect(darkHoverStyle.coreOpacity).toBe("1");
  });
});
