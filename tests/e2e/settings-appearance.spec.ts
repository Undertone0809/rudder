import { expect, test } from "@playwright/test";

let issuePrefixSequence = 0;

function uniqueIssuePrefix() {
  issuePrefixSequence += 1;
  return `A${Date.now().toString(36).slice(-7)}${issuePrefixSequence.toString(36)}`
    .toUpperCase()
    .slice(0, 12);
}

test.describe("Settings appearance", () => {
  test("applies appearance preferences before React hydration", async ({ page }) => {
    await page.route("**/src/main.tsx*", (route) => route.abort());

    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-style", "luma");
    await expect(page.locator("html")).toHaveAttribute("data-base-color", "neutral");
    await expect(page.locator("html")).toHaveAttribute("data-theme-color", "emerald");

    await page.evaluate(() => {
      window.localStorage.setItem("rudder.accentTheme", "neutral");
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme-color", "neutral");
  });

  test("moves color mode from General into Appearance", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Appearance Settings ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const sidebar = modal.getByTestId("workspace-sidebar");

    await expect(sidebar.locator('a[href$="/instance/settings/appearance"]')).toBeVisible();

    await sidebar.locator('a[href$="/instance/settings/general"]').click();
    await expect(page).toHaveURL(/\/instance\/settings\/general$/);
    await expect(modal.getByRole("heading", { name: "General" })).toBeVisible();
    await expect(modal.getByText("Color mode")).toHaveCount(0);

    await sidebar.locator('a[href$="/instance/settings/appearance"]').click();
    await expect(page).toHaveURL(/\/instance\/settings\/appearance$/);
    await expect(modal.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await expect(modal.getByText("Color mode")).toBeVisible();
    await expect(modal.getByRole("button", { name: /^Light Warm paper surfaces$/ })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Auto" })).toBeVisible();
    await expect(modal.getByRole("button", { name: /^Dark Low-glare workspace$/ })).toBeVisible();
  });

  test("uses the default Rudder preset and persists design style choices", async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, {
        __initialAppearancePreferences: {
          designStyle: window.localStorage.getItem("rudder.designStyle"),
          baseColor: window.localStorage.getItem("rudder.baseColor"),
          accentTheme: window.localStorage.getItem("rudder.accentTheme"),
        },
      });
    });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Appearance Style ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const sidebar = modal.getByTestId("workspace-sidebar");
    await sidebar.locator('a[href$="/instance/settings/appearance"]').click();

    await expect(modal.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await expect(modal.getByText("Design style")).toBeVisible();
    await expect.poll(async () => page.evaluate(() => (
      window as typeof window & {
        __initialAppearancePreferences?: Record<string, string | null>;
      }
    ).__initialAppearancePreferences)).toEqual({
      designStyle: null,
      baseColor: null,
      accentTheme: null,
    });
    await expect(page.locator("html")).toHaveAttribute("data-style", "luma");
    await expect(page.locator("html")).toHaveAttribute("data-base-color", "neutral");
    await expect(page.locator("html")).toHaveAttribute("data-theme-color", "emerald");

    const designSection = modal.getByRole("heading", { name: "Design style", exact: true }).locator("..").locator("..");
    const designCards = designSection.locator('button[data-slot="settings-choice-card"]');
    await expect(designCards).toHaveCount(3);
    await expect(designCards.nth(0)).toHaveAccessibleName("Rudder Soft spacious controls");
    await expect(designCards.nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(designCards.nth(1)).toHaveAccessibleName("Classic Balanced low-glare surfaces");
    await expect(designCards.nth(2)).toHaveAccessibleName("Compact Compact cards and controls");

    const baseSection = modal.getByRole("heading", { name: "Base color", exact: true }).locator("..").locator("..");
    await expect(baseSection.getByRole("button", { name: /^Neutral Balanced gray surfaces$/ })).toHaveAttribute("aria-pressed", "true");

    const themeSection = modal.getByRole("heading", { name: "Theme", exact: true }).locator("..").locator("..");
    const themeCards = themeSection.locator('button[data-slot="settings-choice-card"]');
    await expect(themeCards.nth(0)).toHaveAccessibleName("Rudder Rudder green action color");
    await expect(themeCards.nth(0)).toHaveAttribute("aria-pressed", "true");

    await page.setViewportSize({ width: 1980, height: 1250 });
    await page.screenshot({ path: "/tmp/rudder-appearance-default.png", fullPage: true });
    await themeCards.nth(0).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/rudder-appearance-default-theme.png", fullPage: true });

    await modal.getByRole("button", { name: /^Light Warm paper surfaces$/ }).click();
    await modal.getByRole("button", { name: /^Compact Compact cards and controls$/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-style", "mira");
    await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("rudder.designStyle"))).toBe("mira");
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await modal.getByRole("button", { name: /^Dark Low-glare workspace$/ }).click();
    await modal.getByRole("button", { name: /^Rudder Soft spacious controls$/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-style", "luma");
    await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("rudder.designStyle"))).toBe("luma");

    await page.screenshot({ path: "/tmp/rudder-appearance-luma.png", fullPage: true });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-style", "luma");
  });

  test("applies shadcn-style base color and theme choices in light mode", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Appearance Preset ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    const sidebar = modal.getByTestId("workspace-sidebar");
    await sidebar.locator('a[href$="/instance/settings/appearance"]').click();
    await expect(modal.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await expect(modal.getByRole("button", { name: /^Taupe Warm taupe surfaces$/ })).toBeVisible();
    await expect(modal.getByRole("button", { name: /^Pink Pink action color$/ })).toBeVisible();
    await modal.getByRole("button", { name: /^Neutral Monochrome actions$/ }).click();

    const beforeTokens = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        surfacePage: styles.getPropertyValue("--surface-page").trim(),
        accentBase: styles.getPropertyValue("--accent-base").trim(),
        primary: styles.getPropertyValue("--primary").trim(),
        controlHeight: styles.getPropertyValue("--control-height").trim(),
        choicePaddingY: styles.getPropertyValue("--settings-choice-padding-y").trim(),
      };
    });
    expect(beforeTokens.accentBase).toBe("#4a4944");
    expect(beforeTokens.primary).toBe("#2d2c29");

    await modal.getByRole("button", { name: /^Light Warm paper surfaces$/ }).click();
    await modal.getByRole("button", { name: /^Compact Compact cards and controls$/ }).click();
    await modal.getByRole("button", { name: /^Olive Muted olive surfaces$/ }).click();
    await modal.getByRole("button", { name: /^Rudder Rudder green action color$/ }).click();

    await expect(page.locator("html")).toHaveAttribute("data-style", "mira");
    await expect(page.locator("html")).toHaveAttribute("data-base-color", "olive");
    await expect(page.locator("html")).toHaveAttribute("data-theme-color", "emerald");
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await modal.getByRole("button", { name: /^Taupe Warm taupe surfaces$/ }).click();
    await modal.getByRole("button", { name: /^Pink Pink action color$/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-base-color", "taupe");
    await expect(page.locator("html")).toHaveAttribute("data-theme-color", "pink");
    await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("rudder.baseColor"))).toBe("taupe");
    await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("rudder.accentTheme"))).toBe("pink");

    await modal.getByRole("button", { name: /^Olive Muted olive surfaces$/ }).click();
    await modal.getByRole("button", { name: /^Rudder Rudder green action color$/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-base-color", "olive");
    await expect(page.locator("html")).toHaveAttribute("data-theme-color", "emerald");

    const afterTokens = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        surfacePage: styles.getPropertyValue("--surface-page").trim(),
        accentBase: styles.getPropertyValue("--accent-base").trim(),
        controlHeight: styles.getPropertyValue("--control-height").trim(),
        choicePaddingY: styles.getPropertyValue("--settings-choice-padding-y").trim(),
      };
    });

    expect(afterTokens.surfacePage).not.toBe(beforeTokens.surfacePage);
    expect(afterTokens.accentBase).not.toBe(beforeTokens.accentBase);
    expect(afterTokens.controlHeight).not.toBe(beforeTokens.controlHeight);
    expect(afterTokens.choicePaddingY).not.toBe(beforeTokens.choicePaddingY);
    expect(afterTokens.surfacePage).toBe("#f2f1e7");
    expect(afterTokens.accentBase).toBe("#047857");
    expect(afterTokens.controlHeight).toBe("2.25rem");
    expect(afterTokens.choicePaddingY).toBe("0.5rem");

    await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("rudder.baseColor"))).toBe("olive");
    await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("rudder.accentTheme"))).toBe("emerald");

    await page.screenshot({ path: "/tmp/rudder-appearance-mira-olive-emerald-light.png", fullPage: true });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-style", "mira");
    await expect(page.locator("html")).toHaveAttribute("data-base-color", "olive");
    await expect(page.locator("html")).toHaveAttribute("data-theme-color", "emerald");
  });

  test("keeps shared controls usable outside settings under spacious style", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Appearance Controls ${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.addInitScript((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder.theme", "light");
      window.localStorage.setItem("rudder.designStyle", "luma");
      window.localStorage.setItem("rudder.baseColor", "olive");
      window.localStorage.setItem("rudder.accentTheme", "emerald");
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/ui-lab`);
    await expect(page.locator("html")).toHaveAttribute("data-style", "luma");
    await expect(page.locator("html")).toHaveAttribute("data-base-color", "olive");
    await expect(page.locator("html")).toHaveAttribute("data-theme-color", "emerald");

    await page.getByRole("button", { name: /^Primitives\b/ }).click();
    await expect(page.getByText("Buttons and badges")).toBeVisible();
    await expect(page.getByText("Inputs")).toBeVisible();

    const defaultButton = page.getByRole("button", { name: "Default", exact: true }).first();
    const input = page.getByPlaceholder("Agent name").first();
    const selectTrigger = page.locator("#ui-lab-select");
    await expect(defaultButton).toBeVisible();
    await expect(input).toBeVisible();
    await expect(selectTrigger).toBeVisible();

    const geometry = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find((element) => element.textContent?.trim() === "Default");
      const inputElement = document.querySelector<HTMLInputElement>("#ui-lab-name");
      const selectElement = document.querySelector<HTMLElement>("#ui-lab-select");
      const styles = getComputedStyle(document.documentElement);
      return {
        controlHeight: styles.getPropertyValue("--control-height").trim(),
        controlRadius: styles.getPropertyValue("--control-radius").trim(),
        buttonHeight: button?.getBoundingClientRect().height ?? 0,
        inputHeight: inputElement?.getBoundingClientRect().height ?? 0,
        selectHeight: selectElement?.getBoundingClientRect().height ?? 0,
      };
    });

    expect(geometry.controlHeight).toBe("2.75rem");
    expect(geometry.controlRadius).toBe("999px");
    expect(geometry.buttonHeight).toBeGreaterThanOrEqual(40);
    expect(geometry.buttonHeight).toBeLessThanOrEqual(48);
    expect(geometry.inputHeight).toBeGreaterThanOrEqual(40);
    expect(geometry.inputHeight).toBeLessThanOrEqual(48);
    expect(geometry.selectHeight).toBeGreaterThanOrEqual(40);
    expect(geometry.selectHeight).toBeLessThanOrEqual(48);

    await page.screenshot({ path: "/tmp/rudder-appearance-luma-ui-lab-controls.png", fullPage: true });
  });
});
