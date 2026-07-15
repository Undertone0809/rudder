import { expect, test } from "@playwright/test";

test("scrolls through a long resource list in the new project dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1_988, height: 1_247 });
  const uniqueSuffix = Date.now().toString(36).slice(-6).toUpperCase();
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `New-Project-Resource-Scroll-${Date.now()}`,
      issuePrefix: `RS${uniqueSuffix}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const resourceResponses = await Promise.all(
    Array.from({ length: 18 }, (_, index) => page.request.post(`/api/orgs/${organization.id}/resources`, {
      data: {
        name: `Scrollable resource ${String(index + 1).padStart(2, "0")}`,
        kind: "directory",
        locator: `/tmp/scrollable-resource-${index + 1}`,
      },
    })),
  );
  expect(resourceResponses.every((response) => response.ok())).toBe(true);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/dashboard`);

  await page.getByTestId("primary-rail").getByRole("button", { name: "Create" }).click();
  await page.getByRole("menuitem", { name: "Create new project" }).click();

  const dialog = page.locator('[data-slot="dialog-content"]').filter({
    has: page.getByText("New project", { exact: true }),
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Add resources" }).click();

  const scroller = page.getByTestId("new-project-add-resources-popover-scroll");
  await expect(scroller).toBeVisible();
  await expect.poll(() => scroller.evaluate((element) => (
    element.scrollHeight > element.clientHeight
  ))).toBe(true);

  const dimensions = await scroller.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.clientHeight).toBeGreaterThan(0);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  const box = await scroller.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 1_600);
  await expect.poll(() => scroller.evaluate((element) => Math.round(
    element.scrollHeight - element.scrollTop - element.clientHeight,
  ))).toBeLessThanOrEqual(1);

  const createExternalResource = page.getByRole("button", { name: /Create external resource/ });
  await expect(createExternalResource).toBeInViewport();
  const createExternalBox = await createExternalResource.boundingBox();
  const scrolledBox = await scroller.boundingBox();
  expect(createExternalBox).not.toBeNull();
  expect(scrolledBox).not.toBeNull();
  expect(createExternalBox!.y).toBeGreaterThanOrEqual(scrolledBox!.y - 1);
  expect(createExternalBox!.y + createExternalBox!.height).toBeLessThanOrEqual(
    scrolledBox!.y + scrolledBox!.height + 1,
  );
  expect(await createExternalResource.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const hitTarget = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hitTarget ? button.contains(hitTarget) : false;
  })).toBe(true);
});
