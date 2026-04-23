import { expect, test } from "@playwright/test";

const LIGHT_WORKSPACE_PAPER = "rgb(248, 244, 238)";

test.describe("Chat sidebar layout", () => {
  test("shows a compact title-first conversation list and a denser chat intake empty state", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Sidebar-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

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
});
