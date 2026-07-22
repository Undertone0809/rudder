import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatConversations, chatMessages, createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const ORG_NAME = `Plan-Mode-Chat-${Date.now()}`;
const e2eDb = createDb(E2E_DATABASE_URL);

test.describe("Chat options menu", () => {
  test("opens the latest Chat Agent Run from the persisted conversation menu", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Chat-Agent-Run-Menu-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string };
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Run Inspector",
      command: E2E_CODEX_STUB,
    });

    const conversationId = randomUUID();
    const runId = randomUUID();
    const turnId = randomUUID();
    const userMessageId = randomUUID();
    const startedAt = new Date("2026-07-21T08:00:00.000Z");
    const finishedAt = new Date("2026-07-21T08:01:00.000Z");

    await e2eDb.insert(chatConversations).values({
      id: conversationId,
      orgId: organization.id,
      title: "Inspect completed agent run",
      issueCreationMode: "manual_approval",
      planMode: false,
      preferredAgentId: chatAgent.id,
      lastMessageAt: finishedAt,
      createdAt: startedAt,
      updatedAt: finishedAt,
    });
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: chatAgent.id,
      invocationSource: "chat",
      triggerDetail: "chat_assistant_reply",
      status: "succeeded",
      startedAt,
      finishedAt,
      chatConversationId: conversationId,
      contextSnapshot: {
        scene: "chat",
        conversationId,
        userMessageId,
        chatTurnId: turnId,
      },
      resultJson: { summary: "Completed the requested inspection." },
      createdAt: startedAt,
      updatedAt: finishedAt,
    });
    await e2eDb.insert(chatMessages).values([
      {
        id: userMessageId,
        orgId: organization.id,
        conversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Inspect the latest run.",
        chatTurnId: turnId,
        turnVariant: 0,
        createdAt: startedAt,
        updatedAt: startedAt,
      },
      {
        id: randomUUID(),
        orgId: organization.id,
        conversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "The inspection is complete.",
        runId,
        replyingAgentId: chatAgent.id,
        chatTurnId: turnId,
        turnVariant: 0,
        createdAt: finishedAt,
        updatedAt: finishedAt,
      },
    ]);

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });

    await page.getByTestId("chat-actions-trigger").click();
    const viewRunsItem = page.getByRole("menuitem", { name: "View agent runs" });
    await expect(viewRunsItem).toBeEnabled();
    await viewRunsItem.click();

    await expect(page).toHaveURL(new RegExp(`/agents/${chatAgent.urlKey}/runs/${runId}$`));
    const detailPane = page.getByTestId("agent-runs-detail-pane");
    await expect(detailPane).toBeVisible({ timeout: 15_000 });
    await expect(detailPane.getByTestId("run-summary-card").getByText("succeeded", { exact: true })).toBeVisible();
  });

  test("toggles plan mode from the composer menu and persists it", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("rudder.theme", "dark");
    });

    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: ORG_NAME,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Planner",
      command: E2E_CODEX_STUB,
    });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Plan mode persistence",
        preferredAgentId: chatAgent.id,
        initialMessage: { body: "Plan this work before execution." },
      },
    });
    expect(chatRes.ok(), await chatRes.text()).toBe(true);
    const chat = await chatRes.json();

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat/${chat.id}`);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);

    const menuButton = page.getByRole("button", { name: "Add files and options" });
    await expect(menuButton).toBeVisible();

    await menuButton.click();
    await expect(page.getByRole("menuitem", { name: "Add files" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Open Library in Side Panel" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Open chat settings" })).toHaveCount(0);
    const planModeToggle = page.getByRole("switch", { name: "Plan mode" });
    await expect(planModeToggle).toHaveAttribute("aria-checked", "false");
    await expect(page.locator('[title*="Read-only planning."]')).toBeVisible();
    const planModeTrack = page.getByTestId("chat-plan-mode-track");
    const planModeThumb = page.getByTestId("chat-plan-mode-thumb");
    const offTrackColor = await planModeTrack.evaluate((element) => getComputedStyle(element).backgroundColor);

    let planModePatchCount = 0;
    let releasePlanModePatch: (() => void) | null = null;
    let resolvePlanModePatchStarted: (() => void) | null = null;
    const planModePatchStarted = new Promise<void>((resolve) => {
      resolvePlanModePatchStarted = resolve;
    });
    await page.route(`**/api/chats/${chat.id}`, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      planModePatchCount += 1;
      if (planModePatchCount === 1) {
        resolvePlanModePatchStarted?.();
        await new Promise<void>((release) => {
          releasePlanModePatch = release;
        });
      }
      await route.continue();
    });
    const planModePatchResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/chats/${chat.id}`),
    );

    await planModeToggle.click();
    await planModePatchStarted;
    await expect(planModeToggle).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('button[aria-label="Turn off plan mode"]')).toBeVisible();
    const checkedColors = {
      track: await planModeTrack.evaluate((element) => getComputedStyle(element).backgroundColor),
      thumb: await planModeThumb.evaluate((element) => getComputedStyle(element).backgroundColor),
    };
    releasePlanModePatch?.();
    expect((await planModePatchResponse).ok()).toBe(true);
    await expect.poll(() => planModePatchCount).toBe(1);
    expect(checkedColors.track).not.toBe(offTrackColor);
    expect(checkedColors.track).not.toBe(checkedColors.thumb);

    await page.keyboard.press("Escape");
    await page.reload();

    await expect(page.locator('button[aria-label="Turn off plan mode"]')).toBeVisible();
    await menuButton.click();
    const reloadedToggle = page.getByRole("switch", { name: "Plan mode" });
    await expect(reloadedToggle).toHaveAttribute("aria-checked", "true");
  });

  test("shows the Plan mode icon at rest and the dismiss icon only on hover", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("rudder.theme", "dark");
    });

    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Plan-Mode-Icon-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Planner",
      command: E2E_CODEX_STUB,
    });

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${chatAgent.id}`);

    await page.getByRole("button", { name: "Add files and options" }).click();
    const planModeToggle = page.getByRole("switch", { name: "Plan mode" });
    await expect(planModeToggle).toHaveAttribute("aria-checked", "false");
    await planModeToggle.click();
    await page.keyboard.press("Escape");

    const activePlanModeChip = page.locator('button[aria-label="Turn off plan mode"]');
    const planModeIcon = activePlanModeChip.getByTestId("chat-plan-mode-icon");
    const planModeDismissIcon = activePlanModeChip.getByTestId("chat-plan-mode-dismiss-icon");
    await page.evaluate(() => document.fonts.ready);
    await expect(activePlanModeChip).toBeVisible();
    await expect(planModeIcon).toBeVisible();
    await expect(planModeDismissIcon).toBeHidden();
    const restingGeometry = await activePlanModeChip.evaluate((chip) => {
      const iconSlot = chip.querySelector('[data-testid="chat-plan-mode-icon"]')?.parentElement;
      if (!iconSlot) throw new Error("Plan mode icon slot was not rendered");
      const chipRect = chip.getBoundingClientRect();
      const iconSlotRect = iconSlot.getBoundingClientRect();
      return {
        chip: { width: chipRect.width, height: chipRect.height },
        iconSlot: { width: iconSlotRect.width, height: iconSlotRect.height },
      };
    });
    await page.screenshot({ path: testInfo.outputPath("plan-mode-rest.png"), fullPage: true });

    await activePlanModeChip.hover();
    await expect(planModeIcon).toBeHidden();
    await expect(planModeDismissIcon).toBeVisible();
    await expect.poll(() => activePlanModeChip.evaluate((chip) => {
      const iconSlot = chip.querySelector('[data-testid="chat-plan-mode-icon"]')?.parentElement;
      if (!iconSlot) throw new Error("Plan mode icon slot was not rendered");
      const chipRect = chip.getBoundingClientRect();
      const iconSlotRect = iconSlot.getBoundingClientRect();
      return {
        chip: { width: chipRect.width, height: chipRect.height },
        iconSlot: { width: iconSlotRect.width, height: iconSlotRect.height },
      };
    })).toEqual(restingGeometry);
    await page.screenshot({ path: testInfo.outputPath("plan-mode-hover.png"), fullPage: true });

    await page.mouse.move(0, 0);
    await expect(planModeIcon).toBeVisible();
    await expect(planModeDismissIcon).toBeHidden();
  });

  test("shows project context, remembers it for new chat, and creates project-linked conversations", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("rudder.theme", "dark");
    });

    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Project-Context-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Project Agent",
      command: E2E_CODEX_STUB,
    });

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Launch Context",
        description: "Project loaded into chat context.",
        status: "in_progress",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Project-backed chat",
        preferredAgentId: chatAgent.id,
        contextLinks: [{ entityType: "project", entityId: project.id }],
        initialMessage: { body: "Keep this work in the selected project." },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat/${chat.id}`);
    const selector = page.getByTestId("chat-project-selector");
    await expect(selector).toContainText("Launch Context", { timeout: 15_000 });

    await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${chatAgent.id}`);
    await expect(selector).toContainText("Launch Context", { timeout: 15_000 });
    const toolbar = page.getByTestId("chat-composer-toolbar");
    await expect(toolbar.getByTestId("chat-project-selector")).toBeVisible();
    await expect(toolbar.getByRole("button", { name: /Project Agent/ })).toBeVisible();

    const composerBox = await page.locator(".rudder-mdxeditor-content").first().boundingBox();
    const selectorBox = await selector.boundingBox();
    const agentBox = await toolbar.getByRole("button", { name: /Project Agent/ }).boundingBox();
    expect(composerBox).not.toBeNull();
    expect(selectorBox).not.toBeNull();
    expect(agentBox).not.toBeNull();
    expect(selectorBox!.y).toBeGreaterThan(composerBox!.y);
    expect(
      Math.abs((selectorBox!.y + selectorBox!.height / 2) - (agentBox!.y + agentBox!.height / 2)),
    ).toBeLessThan(10);

    await selector.click();
    const projectMenu = page.getByTestId("chat-project-menu");
    await expect(projectMenu).toBeVisible();
    const composerSurfaceBox = await page.locator(".chat-composer").first().boundingBox();
    const projectMenuBox = await projectMenu.boundingBox();
    expect(composerSurfaceBox).not.toBeNull();
    expect(projectMenuBox).not.toBeNull();
    expect(projectMenuBox!.y + projectMenuBox!.height).toBeLessThanOrEqual(composerSurfaceBox!.y + 1);
    expect(Math.abs(projectMenuBox!.x - composerSurfaceBox!.x)).toBeLessThanOrEqual(20);
    expect(Math.abs(projectMenuBox!.width - composerSurfaceBox!.width)).toBeLessThanOrEqual(24);
    await page.getByRole("menuitemradio", { name: "No project" }).click();
    await expect(selector).toContainText("No project");

    await selector.click();
    await page.getByRole("menuitemradio", { name: /Launch Context/ }).click();
    await expect(selector).toContainText("Launch Context");

    const createResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/orgs/${organization.id}/chats`,
    );
    const composer = page.locator(".rudder-mdxeditor-content").first();
    await composer.fill("Use the selected project context");
    await page.getByRole("button", { name: "Send" }).click();

    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBe(true);
    const createdChat = await createResponse.json();
    expect(createdChat.contextLinks).toContainEqual(
      expect.objectContaining({
        entityType: "project",
        entityId: project.id,
      }),
    );
    await expect(selector).toBeDisabled();
    await expect(selector.getByTestId("chat-project-icon")).toBeVisible();
    await expect(page.getByTestId("chat-project-clear")).toHaveCount(0);
  });

  test("hides no-project context on started conversations", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("rudder.theme", "dark");
    });

    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `No-Project-Started-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Projectless Agent",
      command: E2E_CODEX_STUB,
    });

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "No project started chat",
        preferredAgentId: chatAgent.id,
        initialMessage: { body: "Start this conversation without project context." },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "what skill do you have?",
      structuredPayload: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat/${chat.id}`);

    const toolbar = page.getByTestId("chat-composer-toolbar");
    await expect(toolbar.getByRole("button", { name: /Projectless Agent/ })).toBeVisible({ timeout: 15_000 });
    await expect(toolbar.getByTestId("chat-project-selector")).toHaveCount(0);
    await expect(toolbar).not.toContainText("No project");
  });

  test("keeps the project icon visible after a project-backed conversation starts", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Started-Project-Chat-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Started Project Agent",
      command: E2E_CODEX_STUB,
    });
    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: { name: "Persistent Project Identity", status: "in_progress" },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };
    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Started project-backed chat",
        preferredAgentId: chatAgent.id,
        contextLinks: [{ entityType: "project", entityId: project.id }],
        initialMessage: { body: "Start this project-backed conversation." },
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Keep this project context visible.",
      structuredPayload: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await page.addInitScript((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/chat/${chat.id}`);

    const selector = page.getByTestId("chat-project-selector");
    await expect(selector).toContainText(project.name, { timeout: 15_000 });
    await expect(selector).toBeDisabled();
    await expect(selector.getByTestId("chat-project-icon")).toBeVisible();
    await selector.hover({ force: true });
    await expect(selector.getByTestId("chat-project-icon")).toHaveCSS("opacity", "1");
    await expect(page.getByTestId("chat-project-clear")).toHaveCount(0);
  });

  test("shows recent conversations for the selected project on new chat", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("rudder.theme", "dark");
    });
    await page.setViewportSize({ width: 860, height: 720 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Project-Recent-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
      urlKey?: string | null;
    };
    const organizationRouteKey = organization.urlKey || organization.issuePrefix;
    const chatAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Project Recent Agent",
      command: E2E_CODEX_STUB,
    });

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Launch Context",
        status: "in_progress",
      },
    });
    const otherProjectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Ops Context",
        status: "in_progress",
      },
    });
    expect(projectRes.ok()).toBe(true);
    expect(otherProjectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };
    const otherProject = await otherProjectRes.json() as { id: string; name: string };

    const projectChatSpecs = [
      {
        title: "Launch kickoff decisions",
        summary: "Review launch blockers and decide the first follow-up.",
      },
      {
        title: "Launch risk review",
        summary: "Capture the riskiest launch assumptions.",
      },
      {
        title: "Launch budget notes",
        summary: "Compare launch scope against remaining budget.",
      },
      {
        title: "Launch QA sync",
        summary: "Triage remaining release validation work.",
      },
      {
        title: "Launch release plan",
        summary: "Plan the release sequence.",
      },
      {
        title: "Launch scope check",
        summary: "Check the current launch scope.",
      },
      {
        title: "Launch scope review",
        summary: "Confirm the current launch scope before creating issues.",
      },
    ];
    const projectChats: Array<{ id: string }> = [];
    for (const spec of projectChatSpecs) {
      const response = await page.request.post(`/api/orgs/${organization.id}/chats`, {
        data: {
          ...spec,
          preferredAgentId: chatAgent.id,
          contextLinks: [{ entityType: "project", entityId: project.id }],
          initialMessage: { body: `Review ${spec.title}.` },
        },
      });
      expect(response.ok()).toBe(true);
      projectChats.push(await response.json());
    }
    const otherProjectChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Ops billing cleanup",
        summary: "This conversation belongs to a different project.",
        preferredAgentId: chatAgent.id,
        contextLinks: [{ entityType: "project", entityId: otherProject.id }],
        initialMessage: { body: "Review the operations billing cleanup." },
      },
    });
    expect(otherProjectChatRes.ok()).toBe(true);
    const olderProjectChat = projectChats[0];
    const newerProjectChat = projectChats[projectChats.length - 1];

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organizationRouteKey}/messenger/chat?agentId=${chatAgent.id}&projectId=${project.id}`);
    await expect(page.getByTestId("chat-project-selector")).toContainText(project.name, { timeout: 15_000 });

    const tabsList = page.getByRole("tablist", { name: "New chat empty state" });
    await expect(tabsList).toBeVisible();
    await expect(page.getByTestId("chat-empty-state-project-label")).toHaveCount(0);

    await page.getByTestId("chat-empty-state-tab-recent").click();
    const recentSection = page.getByTestId("chat-empty-state-recent-project-conversations");
    await expect(recentSection).toBeVisible();
    await expect(recentSection).toContainText("Launch scope review");
    await expect(recentSection).not.toContainText("Ops billing cleanup");

    const recentRows = recentSection.locator("a");
    await expect(recentRows.first()).toContainText("Launch scope review");
    await expect(page.getByTestId(`chat-empty-state-recent-conversation-${newerProjectChat.id}`)).toContainText("Launch scope review");
    const loadMoreRecentConversations = page.getByTestId("chat-empty-state-recent-conversations-load-more");
    if (await loadMoreRecentConversations.count()) {
      await loadMoreRecentConversations.scrollIntoViewIfNeeded();
    }
    await expect(recentRows).toHaveCount(projectChats.length);
    const olderProjectChatRow = page.getByTestId(`chat-empty-state-recent-conversation-${olderProjectChat.id}`);
    await expect(olderProjectChatRow).toContainText("Launch kickoff decisions");

    const restingGeometry = await olderProjectChatRow.evaluate((element) => {
      const dividerRow = element.parentElement;
      if (!dividerRow) throw new Error("Recent conversation row is missing its divider wrapper");
      const rowBox = element.getBoundingClientRect();
      const dividerBox = dividerRow.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        leftDelta: rowBox.x - dividerBox.x,
        rightDelta: dividerBox.right - rowBox.right,
        marginLeft: style.marginLeft,
        marginRight: style.marginRight,
        borderRadius: style.borderRadius,
      };
    });
    expect(Math.abs(restingGeometry.leftDelta)).toBeLessThanOrEqual(1);
    expect(Math.abs(restingGeometry.rightDelta)).toBeLessThanOrEqual(1);
    expect(Number.parseFloat(restingGeometry.marginLeft)).toBe(0);
    expect(Number.parseFloat(restingGeometry.marginRight)).toBe(0);
    expect(Number.parseFloat(restingGeometry.borderRadius)).toBe(0);

    await olderProjectChatRow.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(olderProjectChatRow).toBeFocused();
    await expect.poll(
      () => olderProjectChatRow.evaluate((element) => getComputedStyle(element).boxShadow),
    ).toContain("inset");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await olderProjectChatRow.hover();
    await expect.poll(
      () => olderProjectChatRow.evaluate((element) => getComputedStyle(element).backgroundColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
    await expect.poll(
      () => olderProjectChatRow.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderRadius)),
    ).toBeGreaterThan(0);
    const hoverGeometry = await olderProjectChatRow.evaluate((element) => {
      const dividerRow = element.parentElement;
      if (!dividerRow) throw new Error("Recent conversation row is missing its divider wrapper");
      const rowBox = element.getBoundingClientRect();
      const dividerBox = dividerRow.getBoundingClientRect();
      return {
        leftInset: rowBox.x - dividerBox.x,
        rightInset: dividerBox.right - rowBox.right,
        borderRadius: getComputedStyle(element).borderRadius,
      };
    });
    expect(hoverGeometry.leftInset).toBeGreaterThan(0);
    expect(hoverGeometry.rightInset).toBeGreaterThan(0);
    expect(Number.parseFloat(hoverGeometry.borderRadius)).toBeGreaterThan(0);
    await page.screenshot({
      path: testInfo.outputPath("project-new-chat-recent-conversations-hover.png"),
      fullPage: true,
    });

    const notificationDismissButtons = page.getByRole("button", { name: "Dismiss notification" });
    while (await notificationDismissButtons.count() > 0) {
      await notificationDismissButtons.first().click();
    }
    await olderProjectChatRow.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await expect.poll(
      () => olderProjectChatRow.evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    await expect.poll(
      () => olderProjectChatRow.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderRadius)),
    ).toBe(0);

    await page.screenshot({
      path: testInfo.outputPath("project-new-chat-recent-conversations.png"),
      fullPage: true,
    });

    await olderProjectChatRow.click();
    await expect(page).toHaveURL(new RegExp(`/${organizationRouteKey}/messenger/chat/${olderProjectChat.id}$`));
    await expect(page.getByTestId("chat-actions-trigger")).toBeVisible();
  });

  test("defaults new chat project context from the current agent's recent project", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Agent-Project-Defaults-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const agentA = await createE2EChatAgent(page.request, organization.id, {
      name: "Wesley",
      command: E2E_CODEX_STUB,
    });
    const agentB = await createE2EChatAgent(page.request, organization.id, {
      name: "Mira",
      command: E2E_CODEX_STUB,
    });

    const alphaRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Rudder Dev",
        status: "in_progress",
      },
    });
    const betaRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Release Ops",
        status: "in_progress",
      },
    });
    expect(alphaRes.ok()).toBe(true);
    expect(betaRes.ok()).toBe(true);
    const alpha = await alphaRes.json() as { id: string; name: string };
    const beta = await betaRes.json() as { id: string; name: string };

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    const selector = page.getByTestId("chat-project-selector");

    await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${agentA.id}&projectId=${alpha.id}`);
    await expect(selector).toContainText(alpha.name, { timeout: 15_000 });
    await expect(page.getByTestId("chat-agent-selector")).toContainText("Wesley");

    await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${agentB.id}&projectId=${beta.id}`);
    await expect(selector).toContainText(beta.name, { timeout: 15_000 });
    await expect(page.getByTestId("chat-agent-selector")).toContainText("Mira");

    await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${agentA.id}`);
    await expect(selector).toContainText(alpha.name, { timeout: 15_000 });
    await expect(page.getByTestId("chat-agent-selector")).toContainText("Wesley");

    await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${agentB.id}`);
    await expect(selector).toContainText(beta.name, { timeout: 15_000 });
    await expect(page.getByTestId("chat-agent-selector")).toContainText("Mira");

    await page.goto(`/${organization.urlKey}/messenger/chat?agentId=${agentA.id}`);
    await expect(selector).toContainText(alpha.name, { timeout: 15_000 });
    await page.getByTestId("chat-agent-selector").click();
    await page.getByRole("menuitemradio", { name: /Mira/ }).click();
    await expect(page.getByTestId("chat-agent-selector")).toContainText("Mira");
    await expect(selector).toContainText(beta.name, { timeout: 15_000 });
  });
});
