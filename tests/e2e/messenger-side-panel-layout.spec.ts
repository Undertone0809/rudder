import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

test("collapses the Messenger List on a laptop and keeps the Side Panel when the list is reopened", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1366, height: 900 });

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
  expect(initialPrimaryRailBox!.width).toBe(50);
  expect(initialContextBox!.width).toBeGreaterThan(120);
  expect(initialMessengerListBox!.width).toBeGreaterThan(120);

  await messengerList.getByRole("button", { name: "Collapse workspace sidebar" }).click();
  await expect(contextCard).not.toHaveAttribute("data-auto-collapsed");
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);

  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click();

  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(sidePanel).toBeVisible();
  await expect(contextCard).toHaveAttribute("data-auto-collapsed", "true");
  const manualRestoreButton = page.getByTestId("workspace-sidebar-reopen-button");
  await expect(manualRestoreButton).toBeVisible();
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await contextCard.boundingBox())?.width ?? 0).toBeLessThanOrEqual(2);
  await expect.poll(async () => {
    const box = await sidePanel.boundingBox();
    return box ? box.x + box.width : 0;
  }).toBeLessThanOrEqual(1366);
  await expect.poll(async () => page.evaluate(() => {
    const card = document.querySelector<HTMLElement>("[data-testid='workspace-context-card']");
    if (!card) return null;
    const style = getComputedStyle(card);
    return `${style.borderLeftWidth}:${style.borderRightWidth}`;
  })).toBe("0px:0px");

  await manualRestoreButton.click();
  await expect(sidePanel).toBeVisible();
  await expect(contextCard).not.toHaveAttribute("data-auto-collapsed");
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeGreaterThan(120);
  await expect(manualRestoreButton).toHaveCount(0);
  await expect.poll(async () => (await page.getByTestId("workspace-main-card").boundingBox())?.width ?? 0)
    .toBeGreaterThan(200);
  await page.screenshot({
    path: testInfo.outputPath("messenger-laptop-manual-three-panel-layout.png"),
    fullPage: true,
  });

  await page.getByTestId("chat-side-panel-collapse").click();
  await expect(sidePanel).toBeHidden();
  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click();
  await expect(contextCard).toHaveAttribute("data-auto-collapsed", "true");
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);

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

test("reopens the Messenger List from the active chat header without closing the Side Panel", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1366, height: 900 });

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

  await page.getByTestId("chat-side-panel-trigger").click();

  const animationSamples = await page.evaluate(() => new Promise<Array<{
    elapsed: number;
    contextWidth: number;
    sidePanelWidth: number;
    mainWidth: number;
    stackWidth: number;
  }>>((resolve) => {
    const startedAt = performance.now();
    const samples: Array<{
      elapsed: number;
      contextWidth: number;
      sidePanelWidth: number;
      mainWidth: number;
      stackWidth: number;
    }> = [];
    const sample = () => {
      const context = document.querySelector<HTMLElement>("[data-testid='workspace-context-card']");
      const sidePanel = document.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
      const sidePanelWidth = sidePanel?.getBoundingClientRect().width ?? 0;
      if (sidePanel && sidePanelWidth > 0) {
        const main = document.querySelector<HTMLElement>("[data-testid='workspace-main-card']");
        const stack = document.querySelector<HTMLElement>("[data-testid='workspace-main-panel-stack']");
        samples.push({
          elapsed: performance.now() - startedAt,
          contextWidth: context?.getBoundingClientRect().width ?? 0,
          sidePanelWidth,
          mainWidth: main?.getBoundingClientRect().width ?? 0,
          stackWidth: stack?.getBoundingClientRect().width ?? 0,
        });
      }
      if (performance.now() - startedAt >= 360) {
        resolve(samples);
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));

  const sidePanel = page.getByTestId("chat-side-panel");
  const header = page.getByTestId("chat-conversation-header");
  const reopenButton = header.getByTestId("workspace-sidebar-reopen-button");
  const avatar = header.getByTestId("chat-header-agent-icon");
  await expect(sidePanel).toBeVisible();
  await expect(contextCard).toHaveAttribute("data-auto-collapsed", "true");
  await expect(reopenButton).toBeVisible();
  await expect(page.getByTestId("workspace-sidebar-reopen-zone")).toHaveCount(0);
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);

  const finalSidePanelBox = await sidePanel.boundingBox();
  expect(finalSidePanelBox).not.toBeNull();
  const sidePanelWidths = animationSamples.map((sample) => sample.sidePanelWidth);
  const contextWidths = animationSamples.map((sample) => sample.contextWidth);
  const stackWidths = animationSamples.map((sample) => sample.stackWidth);
  expect(animationSamples.length).toBeGreaterThan(4);
  expect(Math.max(...contextWidths)).toBeGreaterThan(20);
  expect(contextWidths[contextWidths.length - 1]!).toBeLessThanOrEqual(2);
  for (let index = 1; index < contextWidths.length; index += 1) {
    expect(contextWidths[index]!).toBeLessThanOrEqual(contextWidths[index - 1]! + 8);
  }
  const midpoint = animationSamples.find((sample) => sample.elapsed >= 100);
  expect(midpoint).toBeDefined();
  expect(midpoint!.sidePanelWidth).toBeGreaterThan(finalSidePanelBox!.width * 0.3);
  for (let index = 1; index < sidePanelWidths.length; index += 1) {
    expect(sidePanelWidths[index]!).toBeGreaterThanOrEqual(sidePanelWidths[index - 1]! - 8);
  }
  expect(Math.max(...stackWidths) - Math.min(...stackWidths)).toBeGreaterThan(20);

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

  await page.getByTestId("chat-side-panel-collapse").click();
  await expect(sidePanel).toBeHidden();
  await expect(contextCard).not.toHaveAttribute("data-auto-collapsed");
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeGreaterThan(120);

  await page.getByTestId("chat-side-panel-trigger").click();
  await expect(sidePanel).toBeVisible();
  await expect(contextCard).toHaveAttribute("data-auto-collapsed", "true");
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);

  for (const viewportWidth of [1280, 1024, 900, 1120, 1024, 1366]) {
    await page.setViewportSize({ width: viewportWidth, height: 900 });
    const immediateGeometry = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("[data-testid='workspace-main-card']")?.getBoundingClientRect();
      const panel = document.querySelector<HTMLElement>("[data-testid='chat-side-panel']")?.getBoundingClientRect();
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-shell']")?.getBoundingClientRect();
      if (!main || !panel || !shell) return null;
      return {
        mainWidth: main.width,
        panelWidth: panel.width,
        rightEdge: panel.right,
        shellRight: shell.right,
      };
    });
    expect(immediateGeometry).not.toBeNull();
    expect(immediateGeometry!.mainWidth).toBeGreaterThan(200);
    expect(immediateGeometry!.panelWidth).toBeGreaterThan(300);
    expect(immediateGeometry!.rightEdge).toBeLessThanOrEqual(immediateGeometry!.shellRight + 1);
    await expect.poll(async () => page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("[data-testid='workspace-main-card']");
      const panel = document.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
      if (!main || !panel) return false;
      const mainWidth = main.getBoundingClientRect().width;
      const panelWidth = panel.getBoundingClientRect().width;
      return mainWidth > 200 && panelWidth > 300 && Math.abs(mainWidth - panelWidth) <= 2;
    })).toBe(true);
  }

  await page.setViewportSize({ width: 1366, height: 900 });
  await expect.poll(async () => (await sidePanel.boundingBox())?.width ?? 0).toBeGreaterThan(300);
  await expect.poll(async () => page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("[data-testid='workspace-main-card']");
    const panel = document.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    if (!main || !panel) return null;
    return Math.abs(main.getBoundingClientRect().width - panel.getBoundingClientRect().width);
  })).toBeLessThanOrEqual(2);

  await reopenButton.click();
  await expect(sidePanel).toBeVisible();
  await expect(contextCard).not.toHaveAttribute("data-auto-collapsed");
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeGreaterThan(120);
  await expect(reopenButton).toHaveCount(0);
  await expect.poll(async () => {
    const panel = await sidePanel.boundingBox();
    const main = await page.getByTestId("workspace-main-card").boundingBox();
    return Boolean(panel && main
      && panel.width > 300
      && main.width > 200
      && panel.x + panel.width <= 1367);
  }).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("messenger-active-chat-manual-three-panel-layout.png"),
    fullPage: true,
  });

  expect(pageErrors).toEqual([]);
});

test("keeps Side Panel geometry when entering Messenger from an open panel", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.setViewportSize({ width: 1366, height: 900 });

  const organizationResponse = await page.request.post("/api/orgs", {
    data: { name: `Messenger-Open-Panel-Route-Continuity-${Date.now()}` },
  });
  expect(organizationResponse.ok()).toBe(true);
  const organization = await organizationResponse.json() as { id: string; urlKey: string };

  await page.goto("/");
  await page.evaluate((organizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", organizationId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/issues`);

  const contextCard = page.getByTestId("workspace-context-card");
  const messengerList = page.getByTestId("workspace-sidebar");
  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(contextCard).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click();
  await expect(sidePanel).toBeVisible();
  await expect(contextCard).not.toHaveAttribute("data-auto-collapsed");
  await expect.poll(async () => (await contextCard.boundingBox())?.width ?? 0).toBeGreaterThan(120);

  await page.getByRole("link", { name: "Messenger", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/messenger(?:/chat)?$`));
  await expect(messengerList).toBeVisible({ timeout: 20_000 });
  await expect(sidePanel).toBeVisible();
  await expect(contextCard).toHaveAttribute("data-auto-collapsed", "true");

  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await contextCard.boundingBox())?.width ?? 0).toBeLessThanOrEqual(2);
  await expect.poll(async () => page.evaluate(() => {
    const resizer = document.querySelector<HTMLElement>("[data-testid='workspace-column-resizer']");
    if (!resizer) return null;
    return {
      width: resizer.getBoundingClientRect().width,
      border: getComputedStyle(document.querySelector<HTMLElement>("[data-testid='workspace-context-card']")!).borderRightWidth,
    };
  })).toEqual({ width: 0, border: "0px" });
  await expect.poll(async () => {
    const main = await page.getByTestId("workspace-main-card").boundingBox();
    const panel = await sidePanel.boundingBox();
    if (!main || !panel) return null;
    return {
      mainWidth: main.width,
      panelWidth: panel.width,
      rightEdge: panel.x + panel.width,
    };
  }).toMatchObject({ rightEdge: expect.any(Number) });
  const geometry = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("[data-testid='workspace-main-card']")?.getBoundingClientRect();
    const panel = document.querySelector<HTMLElement>("[data-testid='chat-side-panel']")?.getBoundingClientRect();
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-shell']")?.getBoundingClientRect();
    if (!main || !panel || !shell) return null;
    return {
      mainWidth: main.width,
      panelWidth: panel.width,
      rightEdge: panel.right,
      shellRight: shell.right,
    };
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.mainWidth).toBeGreaterThan(240);
  expect(geometry!.panelWidth).toBeGreaterThan(300);
  expect(geometry!.rightEdge).toBeLessThanOrEqual(geometry!.shellRight + 1);

  await page.getByTestId("chat-side-panel-collapse").click();
  await expect(sidePanel).toBeHidden();
  await expect(contextCard).not.toHaveAttribute("data-auto-collapsed");
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeGreaterThan(120);
  await expect.poll(async () => (await contextCard.boundingBox())?.width ?? 0).toBeGreaterThan(120);

  await page.screenshot({
    path: testInfo.outputPath("messenger-from-open-panel-route-continuity.png"),
    fullPage: true,
  });

  expect(pageErrors).toEqual([]);
});

test("keeps the Messenger List visible when the Side Panel opens on a wide display", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });

  const organizationResponse = await page.request.post("/api/orgs", {
    data: { name: `Messenger-Wide-Side-Panel-${Date.now()}` },
  });
  expect(organizationResponse.ok()).toBe(true);
  const organization = await organizationResponse.json() as { id: string; urlKey: string };

  await page.goto(`/${organization.urlKey}/messenger/chat`);
  const contextCard = page.getByTestId("workspace-context-card");
  const messengerList = page.getByTestId("workspace-sidebar");
  await expect(messengerList).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("side-panel-hover-edge").hover();
  await page.getByTestId("global-side-panel-trigger").click();

  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(sidePanel).toBeVisible();
  await expect(contextCard).not.toHaveAttribute("data-auto-collapsed");
  await expect.poll(async () => (await messengerList.boundingBox())?.width ?? 0).toBeGreaterThan(120);
  await expect.poll(async () => (await sidePanel.boundingBox())?.width ?? 0).toBeGreaterThan(300);
  await expect.poll(async () => (await page.getByTestId("workspace-main-card").boundingBox())?.width ?? 0)
    .toBeGreaterThan(300);

  await page.screenshot({
    path: testInfo.outputPath("messenger-wide-three-panel-layout.png"),
    fullPage: true,
  });
});
