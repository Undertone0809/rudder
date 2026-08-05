import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

const LIGHT_WORKSPACE_PAPER = "rgb(248, 244, 238)";

test.describe("Chat sidebar layout", () => {
  test("shows the full conversation title while it fits within one third of the main workspace", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      });
      Object.defineProperty(window, "desktopShell", {
        configurable: true,
        value: {
          setBadgeCount: async () => {},
        },
      });
    });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Header-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; urlKey: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Header Agent" });
    const fullTitle = "这是一个超过十个字符的对话标题";

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: fullTitle,
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Verify the compact chat header." },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.urlKey}/messenger/chat/${chat.id}`);

    const header = page.getByTestId("chat-conversation-header");
    await expect(header).toBeVisible();
    await expect(page.getByRole("group", { name: `Header Agent chat: ${fullTitle}` })).toBeVisible();
    await expect(header).toHaveCSS("pointer-events", "auto");
    await expect(header.getByTestId("chat-header-agent-name")).toHaveText("Header Agent");
    await expect(header.getByTestId("chat-header-title")).toHaveText(fullTitle);
    await expect(header.getByTestId("chat-header-title")).toHaveAttribute("title", fullTitle);
    await expect(header.locator("img")).toBeVisible();

    for (const button of [
      page.getByRole("button", { name: "Search", exact: true }),
      page.getByRole("button", { name: "Create", exact: true }),
      page.getByRole("button", { name: "System settings", exact: true }),
      page.getByRole("button", { name: "Add files and options", exact: true }),
    ]) {
      await expect(button).toHaveClass(/control-hover/);
      await button.hover();
      const hoverStyle = await button.evaluate((element) => {
        const style = getComputedStyle(element);
        return { boxShadow: style.boxShadow, scale: style.scale, transform: style.transform };
      });
      expect(hoverStyle.boxShadow).not.toBe("none");
      expect(hoverStyle.scale).not.toBe("none");
      expect(hoverStyle.transform).not.toBe("none");
    }

    const headerBox = await header.boundingBox();
    const mainWorkspaceBox = await page.getByTestId("chat-main-workspace-card").boundingBox();
    const actionsBox = await page.getByTestId("chat-desktop-toolbar-actions").boundingBox();
    const toolbarGlassBox = await page.getByTestId("chat-desktop-toolbar-clearance").boundingBox();
    const messagesScrollBox = await page.getByTestId("chat-messages-scroll-region").boundingBox();
    expect(headerBox).not.toBeNull();
    expect(mainWorkspaceBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(toolbarGlassBox).not.toBeNull();
    expect(messagesScrollBox).not.toBeNull();
    expect(headerBox!.width).toBeLessThanOrEqual(mainWorkspaceBox!.width / 3 + 1);
    expect(headerBox!.x + headerBox!.width).toBeLessThanOrEqual(actionsBox!.x);
    expect(messagesScrollBox!.y).toBeGreaterThanOrEqual(toolbarGlassBox!.y + toolbarGlassBox!.height);

    const fittedTitleMetrics = await header.getByTestId("chat-header-title").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(fittedTitleMetrics.scrollWidth).toBeLessThanOrEqual(fittedTitleMetrics.clientWidth + 1);

    await page.screenshot({
      path: testInfo.outputPath("chat-agent-title-header.png"),
      fullPage: true,
    });

    const overflowTitle = `${fullTitle} ${"这是一个需要省略的超长标题".repeat(4)}`;
    const overflowChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: overflowTitle,
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Verify the overflow state of the chat header." },
      },
    });
    expect(overflowChatRes.ok()).toBe(true);
    const overflowChat = await overflowChatRes.json() as { id: string };

    await page.goto(`/${organization.urlKey}/messenger/chat/${overflowChat.id}`);
    const overflowHeader = page.getByTestId("chat-conversation-header");
    await expect(overflowHeader).toBeVisible();
    const overflowTitleElement = overflowHeader.getByTestId("chat-header-title");
    await expect(overflowTitleElement).toHaveAttribute("title", overflowTitle);
    const overflowTitleMetrics = await overflowTitleElement.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    });
    expect(overflowTitleMetrics.scrollWidth).toBeGreaterThan(overflowTitleMetrics.clientWidth);
    expect(overflowTitleMetrics.textOverflow).toBe("ellipsis");
    expect(overflowTitleMetrics.whiteSpace).toBe("nowrap");
  });

  test("keeps chat load errors inside the main workspace card", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      });
      Object.defineProperty(window, "desktopShell", {
        configurable: true,
        value: {
          setBadgeCount: async () => {},
        },
      });
    });
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Load-Error-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Error Layout Agent" });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Load error position",
        summary: "Verify that a failed chat detail request stays within the chat workspace.",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Open this chat before simulating the detail load failure." },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await page.route((url) => url.pathname === `/api/chats/${chat.id}/messages`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      });
    });
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.urlKey}/messenger/chat/${chat.id}`);

    const mainCard = page.getByTestId("chat-main-workspace-card");
    const loadError = mainCard.getByTestId("chat-load-error");
    const toolbarButton = mainCard.getByTestId("chat-side-panel-trigger");
    const toolbarGlass = mainCard.getByTestId("chat-desktop-toolbar-clearance");
    await expect(mainCard).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/\bdesktop-shell-macos\b/);
    await expect(loadError).toHaveText("Internal server error", { timeout: 15_000 });
    await expect(toolbarGlass).toBeVisible();
    await expect(toolbarGlass).toHaveCSS("position", "relative");
    await expect(toolbarGlass).toHaveCSS("backdrop-filter", /blur\(18px\)/);

    const desktopErrorBox = await loadError.boundingBox();
    const desktopToolbarBox = await toolbarButton.boundingBox();
    const desktopToolbarGlassBox = await toolbarGlass.boundingBox();
    expect(desktopErrorBox).not.toBeNull();
    expect(desktopToolbarBox).not.toBeNull();
    expect(desktopToolbarGlassBox).not.toBeNull();
    expect(desktopErrorBox!.y).toBeGreaterThanOrEqual(
      desktopToolbarGlassBox!.y + desktopToolbarGlassBox!.height + 23,
    );
    await expect(loadError).toHaveCSS("margin-top", "24px");

    await page.screenshot({
      path: testInfo.outputPath("chat-load-error-position-desktop.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(loadError).toHaveText("Internal server error", { timeout: 15_000 });
    await expect(mainCard.getByTestId("chat-load-error-mobile-clearance")).toBeVisible();
    await expect(loadError).toHaveCSS("margin-top", "24px");
    const mobileErrorBox = await loadError.boundingBox();
    const mobileToolbarBox = await toolbarButton.boundingBox();
    expect(mobileErrorBox).not.toBeNull();
    expect(mobileToolbarBox).not.toBeNull();
    expect(mobileErrorBox!.y).toBeGreaterThanOrEqual(mobileToolbarBox!.y + mobileToolbarBox!.height);

    await page.screenshot({
      path: testInfo.outputPath("chat-load-error-position-mobile.png"),
      fullPage: true,
    });
  });

  test("shows a compact title-first Messenger thread list and a denser chat intake empty state", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Sidebar-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Sidebar Agent" });

    const firstChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Release blockers",
        summary: "Collect the blockers, confirm owners, and decide whether this needs tracked execution.",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Review the current release blockers." },
      },
    });
    expect(firstChatRes.ok()).toBe(true);
    const firstChat = await firstChatRes.json();

    const secondChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Agent runtime follow-up",
        summary: "Compare runtime options and keep the ask lightweight until the path is clear.",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: true,
        initialMessage: { body: "Compare the available agent runtime options." },
      },
    });
    expect(secondChatRes.ok()).toBe(true);
    const secondChat = await secondChatRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");

    await expect(page.getByTestId("workspace-context-card")).toBeVisible();
    await expect(page.getByTestId("workspace-main-card")).toBeVisible();
    await expect(page.getByTestId("workspace-context-header")).toBeVisible();
    await expect(page.getByTestId("workspace-column-resizer")).toBeVisible();
    await expect(page.getByText("Threads", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "New chat", exact: true })).toBeVisible();

    const shellStyles = await page.getByTestId("workspace-shell").evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        backgroundColor: styles.backgroundColor,
        borderTopWidth: styles.borderTopWidth,
        boxShadow: styles.boxShadow,
      };
    });
    expect(shellStyles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(shellStyles.borderTopWidth).toBe("0px");
    expect(shellStyles.boxShadow).toBe("none");

    const contextCardStyles = await page.getByTestId("workspace-context-card").evaluate((element) => {
      const styles = getComputedStyle(element);
      return styles.backgroundColor;
    });
    const mainCardStyles = await page.getByTestId("workspace-main-card").evaluate((element) => {
      const styles = getComputedStyle(element);
      return styles.backgroundColor;
    });
    expect(contextCardStyles).toBe(LIGHT_WORKSPACE_PAPER);
    expect(mainCardStyles).toBe("rgba(0, 0, 0, 0)");

    const firstRow = page.getByTestId(`messenger-thread-chat-${firstChat.id}`);
    await expect(firstRow).toContainText("Release blockers");
    await expect(firstRow).not.toContainText("Collect the blockers, confirm owners");

    const secondRow = page.getByTestId(`messenger-thread-chat-${secondChat.id}`);
    await expect(secondRow).toContainText("Agent runtime follow-up");
    await expect(secondRow).not.toContainText("Compare runtime options and keep the ask lightweight");
    await expect(secondRow).not.toContainText("Light ops");

    const firstRowBox = await firstRow.boundingBox();
    expect(firstRowBox).not.toBeNull();
    expect(firstRowBox!.width).toBeLessThan(336);

    await firstRow.hover();
    await firstRow.getByRole("button", { name: "Chat actions" }).click();
    const archiveItem = page.getByRole("menuitem", { name: "Archive" });
    await expect(archiveItem).toBeVisible();
    await expect(archiveItem.locator("svg")).toHaveCount(1);

    const mainContentBox = await page.locator("#main-content").boundingBox();
    const composerBox = await page.locator(".chat-composer").first().boundingBox();
    const contextCardBox = await page.getByTestId("workspace-context-card").boundingBox();
    const mainCardBox = await page.getByTestId("workspace-main-card").boundingBox();

    expect(mainContentBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(contextCardBox).not.toBeNull();
    expect(mainCardBox).not.toBeNull();
    const mainContentCenterY = mainContentBox!.y + mainContentBox!.height / 2;
    const composerCenterY = composerBox!.y + composerBox!.height / 2;
    expect(Math.abs(mainContentCenterY - composerCenterY)).toBeLessThan(56);
    expect(mainCardBox!.x - (contextCardBox!.x + contextCardBox!.width)).toBeLessThanOrEqual(12);

    await page.screenshot({
      path: testInfo.outputPath("chat-sidebar-layout.png"),
      fullPage: true,
    });
  });

  test("keeps the chat toolbar in flow outside the macOS desktop shell", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Web-Toolbar-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; urlKey: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Web Toolbar Agent" });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Web toolbar layout",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Verify the ordinary web toolbar layout." },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.urlKey}/messenger/chat/${chat.id}`);

    await expect(page.locator("html")).not.toHaveClass(/\bdesktop-shell-macos\b/);
    await expect(page.getByTestId("chat-desktop-toolbar-clearance")).toHaveCount(0);
    await expect(page.getByTestId("chat-desktop-toolbar-actions")).toHaveCSS("position", "relative");
  });

  test("keeps the collapsed workspace sidebar trigger at the chat top-left", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      });
      Object.defineProperty(window, "desktopShell", {
        configurable: true,
        value: {
          setBadgeCount: async () => {},
        },
      });
    });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Sidebar-Trigger-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; urlKey: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Sidebar Trigger Agent" });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Sidebar trigger position",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: { body: "Verify the collapsed sidebar trigger position." },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.urlKey}/messenger/chat/${chat.id}`);

    const mainCard = page.getByTestId("chat-main-workspace-card");
    const collapseButton = page.getByRole("button", { name: "Collapse workspace sidebar" });
    const reopenZone = page.getByTestId("workspace-sidebar-reopen-zone");
    const reopenButton = page.getByTestId("workspace-sidebar-reopen-button");
    await expect(mainCard).toBeVisible();
    await expect(collapseButton).toBeVisible();
    await collapseButton.click();
    await expect(page.getByTestId("workspace-context-card")).toHaveAttribute("aria-hidden", "true");
    await expect(reopenButton).toHaveCount(1);

    await expect(reopenButton).toHaveCSS("opacity", "0");
    await expect(reopenButton).toHaveCSS("pointer-events", "none");

    const mainCardBox = await mainCard.boundingBox();
    const reopenZoneBox = await reopenZone.boundingBox();
    expect(mainCardBox).not.toBeNull();
    expect(reopenZoneBox).not.toBeNull();
    expect(Math.abs(reopenZoneBox!.y - mainCardBox!.y)).toBeLessThanOrEqual(2);
    expect(reopenZoneBox!.height).toBeLessThanOrEqual(48);

    await reopenZone.hover();
    await expect(reopenButton).toHaveCSS("opacity", "1");
    await expect(reopenButton).toHaveCSS("pointer-events", "auto");
    const reopenButtonBox = await reopenButton.boundingBox();
    expect(reopenButtonBox).not.toBeNull();
    expect(Math.abs(reopenButtonBox!.y - mainCardBox!.y)).toBeLessThanOrEqual(4);
    await page.screenshot({
      path: testInfo.outputPath("chat-sidebar-reopen-top-left.png"),
      fullPage: true,
    });

    await reopenButton.click();
    await expect(page.getByTestId("workspace-context-card")).toHaveAttribute("aria-hidden", "false");
    await expect(reopenButton).toHaveCount(0);
  });
});
