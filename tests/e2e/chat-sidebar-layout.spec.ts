import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

const LIGHT_WORKSPACE_PAPER = "rgb(248, 244, 238)";

test.describe("Chat sidebar layout", () => {
  test("shows the active agent and a compact conversation title in the chat header", async ({ page }, testInfo) => {
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
    await expect(header.getByTestId("chat-header-title")).toHaveText("这是一个超过十个字…");
    await expect(header.getByTestId("chat-header-title")).toHaveAttribute("title", fullTitle);
    await expect(header.locator("img")).toBeVisible();

    const headerBox = await header.boundingBox();
    const actionsBox = await page.getByTestId("chat-desktop-toolbar-actions").boundingBox();
    expect(headerBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(headerBox!.x + headerBox!.width).toBeLessThanOrEqual(actionsBox!.x);

    await page.screenshot({
      path: testInfo.outputPath("chat-agent-title-header.png"),
      fullPage: true,
    });
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
    await expect(toolbarGlass).toHaveCSS("position", "absolute");
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
    await expect(loadError).toHaveCSS("margin-top", "68px");

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

  test("shows a compact title-first conversation list and a denser chat intake empty state", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Sidebar-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    await createE2EChatAgent(page.request, organization.id, { name: "Sidebar Agent" });

    const firstChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Release blockers",
        summary: "Collect the blockers, confirm owners, and decide whether this needs tracked execution.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(firstChatRes.ok()).toBe(true);
    const firstChat = await firstChatRes.json();

    const secondChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Agent runtime follow-up",
        summary: "Compare runtime options and keep the ask lightweight until the path is clear.",
        issueCreationMode: "manual_approval",
        planMode: true,
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
    await expect(page.getByTestId("workspace-main-header")).toBeVisible();
    await expect(page.getByTestId("workspace-column-resizer")).toBeVisible();
    await expect(page.getByText("Recent conversations")).toBeVisible();
    await expect(page.getByRole("link", { name: /New Chat/i })).toBeVisible();
    await expect(page.locator(".chat-sidebar .chat-chip")).toHaveCount(0);

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
    expect(mainCardStyles).toBe(LIGHT_WORKSPACE_PAPER);

    const firstRow = page.getByTestId(`chat-sidebar-conversation-${firstChat.id}`);
    await expect(firstRow).toContainText("Release blockers");
    await expect(firstRow).not.toContainText("Collect the blockers, confirm owners");

    const secondRow = page.getByTestId(`chat-sidebar-conversation-${secondChat.id}`);
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
});
