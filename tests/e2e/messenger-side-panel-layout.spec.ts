import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

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
  const primaryRail = page.getByTestId("primary-rail");
  await expect(contextCard).toBeVisible({ timeout: 20_000 });
  await expect(messengerList).toBeVisible();

  const initialPrimaryRailBox = await primaryRail.boundingBox();
  const initialContextBox = await contextCard.boundingBox();
  const initialMessengerListBox = await messengerList.boundingBox();
  expect(initialPrimaryRailBox).not.toBeNull();
  expect(initialContextBox).not.toBeNull();
  expect(initialMessengerListBox).not.toBeNull();
  expect(initialPrimaryRailBox!.width).toBeLessThan(60);
  expect(initialContextBox!.width).toBeGreaterThan(120);
  expect(initialMessengerListBox!.width).toBeGreaterThan(120);

  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click();

  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(sidePanel).toBeVisible();
  await expect(contextCard).toHaveAttribute("data-auto-collapsed", "true");
  await expect(page.getByTestId("workspace-sidebar-reopen-button")).toBeVisible();
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await contextCard.boundingBox())?.width ?? 0).toBeLessThanOrEqual(2);
  await expect.poll(async () => page.evaluate(() => {
    const card = document.querySelector<HTMLElement>("[data-testid='workspace-context-card']");
    if (!card) return null;
    const style = getComputedStyle(card);
    return `${style.borderLeftWidth}:${style.borderRightWidth}`;
  })).toBe("0px:0px");

  await page.screenshot({
    path: testInfo.outputPath("messenger-side-panel-collapsed-list.png"),
    fullPage: true,
  });

  await page.getByTestId("workspace-sidebar-reopen-button").click();
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

test("restores the Messenger List from the active chat header", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 900 });

  const organizationResponse = await page.request.post("/api/orgs", {
    data: { name: `Messenger-Active-Chat-Side-Panel-${Date.now()}` },
  });
  expect(organizationResponse.ok()).toBe(true);
  const organization = await organizationResponse.json() as { id: string; urlKey: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Messenger Layout Agent",
  });
  const chatResponse = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Messenger layout recovery",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Verify the active Messenger layout recovery." },
    },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat = await chatResponse.json() as { id: string };

  await page.goto("/");
  await page.evaluate((organizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", organizationId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat/${chat.id}`);

  const contextCard = page.getByTestId("workspace-context-card");
  const messengerList = page.getByTestId("workspace-sidebar");
  await expect(page.getByTestId("chat-conversation-header")).toBeVisible({ timeout: 20_000 });
  await expect(contextCard).toBeVisible();
  await expect(messengerList).toBeVisible();

  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click();

  const sidePanel = page.getByTestId("chat-side-panel");
  const header = page.getByTestId("chat-conversation-header");
  const reopenButton = header.getByTestId("workspace-sidebar-reopen-button");
  const avatar = header.getByTestId("chat-header-agent-icon");
  await expect(sidePanel).toBeVisible();
  await expect(contextCard).toHaveAttribute("data-auto-collapsed", "true");
  await expect(reopenButton).toBeVisible();
  await expect(page.getByTestId("workspace-sidebar-reopen-zone")).toHaveCount(0);
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);

  await expect.poll(async () => {
    const reopenBox = await reopenButton.boundingBox();
    const avatarBox = await avatar.boundingBox();
    if (!reopenBox || !avatarBox) return null;
    return {
      leftOfAvatar: reopenBox.x + reopenBox.width <= avatarBox.x + 1,
      verticallyAligned: Math.abs(
        reopenBox.y + reopenBox.height / 2 - (avatarBox.y + avatarBox.height / 2),
      ) <= 2,
    };
  }).toEqual({ leftOfAvatar: true, verticallyAligned: true });

  await page.screenshot({
    path: testInfo.outputPath("messenger-active-chat-sidebar-reopen.png"),
    fullPage: true,
  });

  await reopenButton.click();
  await expect(sidePanel).toBeHidden();
  await expect(contextCard).not.toHaveAttribute("data-auto-collapsed");
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeGreaterThan(120);
  await expect(reopenButton).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
