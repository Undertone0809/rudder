import { expect, test } from "@playwright/test";

const RUDDER_DOCS_URL = "https://doc.rudder.zeeland.studio";

test.describe("Settings docs link", () => {
  test("shows a docs item in settings that points to the official docs", async ({ page }) => {
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
  });
});
