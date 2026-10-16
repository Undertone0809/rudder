import { expect } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// Real Electron E2E: caption geometry, settings and window actions share the
// actual preload/IPC path. OS-composited acrylic still needs a desktop capture.
export async function verifyWindowsShell(electronApp, page, routeKey, mode) {
  if (process.platform !== "win32") return;
  await page.goto(new URL(`/${routeKey}/messenger/chat`, page.url()).href);
  await expect(page.getByText("What can I help with?", { exact: true })).toBeVisible();
  const caption = page.getByTestId("desktop-caption-bar");
  await expect(caption).toBeVisible();
  const skipLink = page.locator('a[href="#main-content"]');
  await skipLink.focus();
  expect((await skipLink.boundingBox()).y).toBeGreaterThanOrEqual(38);
  await page.keyboard.press("Tab");
  const originalBounds = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.isVisible()).getBounds());
  const assertClearance = async () => {
    const geometry = await page.evaluate(() => {
      const bar = document.querySelector(".desktop-caption-bar").getBoundingClientRect();
      const rail = document.querySelector('[data-testid="primary-rail"]').getBoundingClientRect();
      const shell = document.querySelector(".app-shell-backdrop").getBoundingClientRect();
      return { captionBottom: bar.bottom, captionWidth: bar.width, railTop: rail.top, bottom: shell.bottom, width: innerWidth, height: innerHeight };
    });
    expect(geometry.captionBottom).toBe(38);
    // DOM rectangles retain fractional DIP; innerWidth is rounded at 125% DPI.
    expect(Math.abs(geometry.captionWidth - geometry.width)).toBeLessThanOrEqual(1);
    expect(geometry.railTop).toBeGreaterThanOrEqual(geometry.captionBottom);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height + 1);
  };
  for (const theme of ["Dark", "Light"]) {
    await page.getByRole("button", { name: "System settings", exact: true }).click();
    const modal = page.getByTestId("settings-modal-shell");
    await modal.locator('a[href$="/instance/settings/appearance"]').click();
    await modal.getByRole("button", { name: theme === "Dark" ? "Dark Low-glare workspace" : "Light Warm paper surfaces", exact: true }).click();
    await expect.poll(async () => (await modal.boundingBox()).y).toBeGreaterThanOrEqual(38);
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    // The caption shares the shell's backdrop in both themes, without a second tint.
    await expect(caption).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(caption).toHaveCSS("backdrop-filter", "none");
    const rail = page.getByTestId("primary-rail");
    await expect(rail).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(rail).toHaveCSS("background-image", "none");
    await expect(rail).toHaveCSS("backdrop-filter", "none");
    await expect(rail).toHaveCSS("border-right-width", "0px");
    await assertClearance();
    await page.screenshot({ path: path.join(os.tmpdir(), `rudder-windows-shell-${mode}-${theme.toLowerCase()}.png`) });
  }
  await page.getByRole("button", { name: "Maximize", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await assertClearance();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("button", { name: "Maximize", exact: true })).toBeVisible();
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.isVisible()).setSize(1080, 720));
  // Windows non-client metrics can add two DIP at the minimum outer size.
  await expect.poll(() => page.evaluate(() => innerHeight)).toBeLessThanOrEqual(724);
  await assertClearance();
  await page.getByRole("button", { name: "System settings", exact: true }).click();
  const modalBox = await page.getByTestId("settings-modal-shell").boundingBox();
  expect(modalBox.y).toBeGreaterThanOrEqual(38);
  expect(modalBox.y + modalBox.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
  await page.screenshot({ path: path.join(os.tmpdir(), `rudder-windows-shell-${mode}-constrained.png`) });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Minimize", exact: true }).click();
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isMinimized()))).toBe(true);
  await electronApp.evaluate(({ BrowserWindow }, bounds) => {
    const window = BrowserWindow.getAllWindows().find(w => w.isMinimized());
    window.restore();
    window.setBounds(bounds);
  }, originalBounds);
  await assertClearance();
}
