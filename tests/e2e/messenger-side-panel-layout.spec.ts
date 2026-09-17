import { expect, test } from "@playwright/test";

test("collapses the Messenger List with Side Panel and restores it after close", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 900 });

  const organizationResponse = await page.request.post("/api/orgs", {
    data: { name: `Messenger-Side-Panel-Layout-${Date.now()}` },
  });
  expect(organizationResponse.ok()).toBe(true);
  const organization = await organizationResponse.json() as { id: string; urlKey: string };

  await page.goto("/");
  await page.evaluate((organizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", organizationId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat`);

  const contextCard = page.getByTestId("workspace-context-card");
  const messengerList = page.getByTestId("workspace-sidebar");
  await expect(contextCard).toBeVisible({ timeout: 20_000 });
  await expect(messengerList).toBeVisible();

  const initialContextBox = await contextCard.boundingBox();
  const initialMessengerListBox = await messengerList.boundingBox();
  expect(initialContextBox).not.toBeNull();
  expect(initialMessengerListBox).not.toBeNull();
  expect(initialContextBox!.width).toBeGreaterThan(120);
  expect(initialMessengerListBox!.width).toBeGreaterThan(120);

  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click();

  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(sidePanel).toBeVisible();
  await expect(contextCard).toHaveAttribute("data-auto-collapsed", "true");
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await contextCard.boundingBox())?.width ?? 0).toBeLessThanOrEqual(2);

  await page.screenshot({
    path: testInfo.outputPath("messenger-side-panel-collapsed-list.png"),
    fullPage: true,
  });

  await page.getByTestId("chat-side-panel-collapse").click();
  await expect(sidePanel).toBeHidden();
  await expect(contextCard).not.toHaveAttribute("data-auto-collapsed");
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeGreaterThan(120);
  await expect.poll(async () => (await contextCard.boundingBox())?.width ?? 0).toBeGreaterThan(120);

  await page.screenshot({
    path: testInfo.outputPath("messenger-side-panel-restored-list.png"),
    fullPage: true,
  });

  expect(pageErrors).toEqual([]);
});
