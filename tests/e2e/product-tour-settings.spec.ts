import { expect, type Page, test } from "@playwright/test";

async function expectTourChromeSeparated(page: Page) {
  const boxes = await page.evaluate(() => {
    const checklist = document.querySelector<HTMLElement>("[data-testid='product-tour-checklist']");
    const callout = document.querySelector<HTMLElement>("[data-testid='product-tour-callout']");
    const toBox = (element: HTMLElement | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      checklist: toBox(checklist),
      callout: toBox(callout),
    };
  });

  expect(boxes.callout).not.toBeNull();
  expect(boxes.checklist).not.toBeNull();
  expect(boxes.checklist!.width).toBeGreaterThan(0);
  expect(boxes.checklist!.height).toBeGreaterThan(0);

  const overlap =
    boxes.checklist.left < boxes.callout!.right + 8 &&
    boxes.checklist.right + 8 > boxes.callout!.left &&
    boxes.checklist.top < boxes.callout!.bottom + 8 &&
    boxes.checklist.bottom + 8 > boxes.callout!.top;

  expect(overlap).toBe(false);
}

test.describe("Product tour", () => {
  test("opens the issue tracker after the pending setup tour finishes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Product Tour Pending ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.evaluate(() => {
      window.localStorage.removeItem("rudder.productTour.completed.v1");
      window.localStorage.setItem("rudder.productTour.pendingAfterSetup.v1", "true");
    });
    await page.reload();

    await expect(page.getByRole("dialog", { name: "Rudder is the control plane for agent work" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/dashboard$`));

    for (const title of [
      "Start with one task an agent can actually move",
      "Issues are the executable units of work",
      "Inspect the work before you approve or continue",
      "You can replay this tour from Settings",
    ]) {
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByRole("dialog", { name: title })).toBeVisible();
      if (title === "Issues are the executable units of work") {
        await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/issues$`));
        await expect(page.getByRole("heading", { name: "Issue Tracker" })).toBeVisible();
      }
    }

    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/issues$`));
    await expect(page.getByRole("heading", { name: "Issue Tracker" })).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() => window.localStorage.getItem("rudder.productTour.pendingAfterSetup.v1")),
    ).toBeNull();
  });

  test("can be replayed from general settings without tour chrome overlap", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1257 });
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Product Tour ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await page.goto(`/${organization.issuePrefix}/dashboard`);
    await page.evaluate(() => {
      window.localStorage.setItem("rudder.productTour.completed.v1", "true");
      window.localStorage.removeItem("rudder.productTour.pendingAfterSetup.v1");
    });
    await page.reload();
    await page.getByRole("button", { name: "System settings" }).click();

    const modal = page.getByTestId("settings-modal-shell");
    await modal.locator('a[href$="/instance/settings/general"]').click();
    await expect(modal.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await expect(modal.getByText("Workspace tour")).toBeVisible();

    await modal.getByRole("button", { name: "Start tour" }).click();

    await expect(modal).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Rudder is the control plane for agent work" })).toBeVisible();
    await expect(page.getByText("Complete your first work loop")).toBeVisible();
    await expect(page.getByText("1 / 5")).toBeVisible();
    await expectTourChromeSeparated(page);

    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("dialog", { name: "Start with one task an agent can actually move" })).toBeVisible();
    await expectTourChromeSeparated(page);

    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("dialog", { name: "Rudder is the control plane for agent work" })).toBeVisible();
    await expectTourChromeSeparated(page);

    for (const title of [
      "Start with one task an agent can actually move",
      "Issues are the executable units of work",
      "Inspect the work before you approve or continue",
      "You can replay this tour from Settings",
    ]) {
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByRole("dialog", { name: title })).toBeVisible();
      if (title === "Issues are the executable units of work") {
        await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/issues$`));
        await expect(page.getByRole("heading", { name: "Issue Tracker" })).toBeVisible();
      }
      await expectTourChromeSeparated(page);
    }

    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() =>
      page.evaluate(() => window.localStorage.getItem("rudder.productTour.completed.v1")),
    ).toBe("true");
  });
});
