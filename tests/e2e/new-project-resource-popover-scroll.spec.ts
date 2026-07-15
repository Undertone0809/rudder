import { expect, test } from "@playwright/test";

test("keeps external resource creation at the top while the resource list scrolls", async ({ page }) => {
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
  const createExternalResource = page.getByRole("button", { name: /Create external resource/ });
  const librarySearch = page.getByPlaceholder("Search Library or paste relative path");
  await expect(scroller).toBeVisible();
  await expect(createExternalResource).toBeVisible();
  await expect(librarySearch).toBeVisible();
  await expect.poll(() => scroller.evaluate((element) => (
    element.scrollHeight > element.clientHeight
  ))).toBe(true);

  await createExternalResource.evaluate(async (button) => {
    const popoverAnimations = button.parentElement?.getAnimations({ subtree: true }) ?? [];
    await Promise.all(popoverAnimations.map((animation) => animation.finished.catch(() => undefined)));
  });

  const createExternalBeforeBox = await createExternalResource.boundingBox();
  const librarySearchBox = await librarySearch.boundingBox();
  expect(createExternalBeforeBox).not.toBeNull();
  expect(librarySearchBox).not.toBeNull();
  expect(createExternalBeforeBox!.y + createExternalBeforeBox!.height).toBeLessThanOrEqual(librarySearchBox!.y);
  expect(await createExternalResource.evaluate((button) => (
    button.closest('[data-testid="new-project-add-resources-popover-scroll"]') === null
  ))).toBe(true);

  const box = await scroller.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 1_600);
  await expect.poll(() => scroller.evaluate((element) => Math.round(
    element.scrollHeight - element.scrollTop - element.clientHeight,
  ))).toBeLessThanOrEqual(1);

  await expect(createExternalResource).toBeInViewport();
  const createExternalAfterBox = await createExternalResource.boundingBox();
  expect(createExternalAfterBox).not.toBeNull();
  expect(createExternalAfterBox!.y).toBeCloseTo(createExternalBeforeBox!.y, 0);
  expect(await createExternalResource.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const hitTarget = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hitTarget ? button.contains(hitTarget) : false;
  })).toBe(true);
});
