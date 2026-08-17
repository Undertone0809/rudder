import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

type ViewportCase = {
  height: number;
  label: string;
  width: number;
};

const viewports: ViewportCase[] = [
  { label: "desktop", width: 1280, height: 900 },
  { label: "mobile", width: 390, height: 844 },
];

async function openNewIssueDialog(page: Page, routeKey: string): Promise<Locator> {
  await page.goto(`${E2E_BASE_URL}/${routeKey}/issues`, { waitUntil: "domcontentloaded" });
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();
  } else {
    await page
      .getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("button", { name: "Create", exact: true })
      .click();
  }

  const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("New issue dialog close button", () => {
  test("keeps the close button in the dialog top-right on desktop and mobile", async ({ page }, testInfo) => {
    const organizationResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `New-Issue-Close-Button-${Date.now()}`,
      },
    });
    expect(organizationResponse.ok()).toBe(true);
    const organization = await organizationResponse.json() as { id: string; issuePrefix: string; urlKey?: string };
    const routeKey = organization.urlKey || organization.issuePrefix;
    const screenshotDirectory = process.env.RUDDER_E2E_SCREENSHOT_DIR;
    const screenshotPath = (name: string) =>
      screenshotDirectory ? `${screenshotDirectory}/${name}` : testInfo.outputPath(name);

    await page.goto(E2E_BASE_URL);
    await page.evaluate((organizationId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", organizationId);
    }, organization.id);

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const dialog = await openNewIssueDialog(page, routeKey);
      const modeBar = dialog.locator('[data-slot="new-issue-mode-bar"]');
      const header = dialog.locator('[data-slot="new-issue-header"]');
      const closeButton = dialog.getByRole("button", { name: "Close new issue dialog" });

      await expect(modeBar).toBeVisible();
      await expect(modeBar.getByRole("button", { name: "Close new issue dialog" })).toHaveCount(1);
      await expect(header.getByRole("button", { name: "Close new issue dialog" })).toHaveCount(0);

      const [dialogBox, modeBarBox, closeButtonBox] = await Promise.all([
        dialog.boundingBox(),
        modeBar.boundingBox(),
        closeButton.boundingBox(),
      ]);
      expect(dialogBox).not.toBeNull();
      expect(modeBarBox).not.toBeNull();
      expect(closeButtonBox).not.toBeNull();

      const dialogRight = (dialogBox?.x ?? 0) + (dialogBox?.width ?? 0);
      const closeButtonRight = (closeButtonBox?.x ?? 0) + (closeButtonBox?.width ?? 0);
      expect(dialogRight - closeButtonRight).toBeGreaterThanOrEqual(12);
      expect(dialogRight - closeButtonRight).toBeLessThanOrEqual(20);
      expect(closeButtonBox?.y ?? 0).toBeGreaterThanOrEqual((modeBarBox?.y ?? 0) - 1);
      expect((closeButtonBox?.y ?? 0) + (closeButtonBox?.height ?? 0)).toBeLessThanOrEqual(
        (modeBarBox?.y ?? 0) + (modeBarBox?.height ?? 0) + 1,
      );

      await page.screenshot({ path: screenshotPath(`new-issue-close-button-${viewport.label}.png`), fullPage: false });
      await closeButton.click();
      await expect(dialog).toBeHidden();
    }
  });
});
