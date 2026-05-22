import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

const ORG_NAME = `Plan-Mode-Chat-${Date.now()}`;

test.describe("Chat options menu", () => {
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
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat/${chat.id}`);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);

    const menuButton = page.getByRole("button", { name: "Add files and options" });
    await expect(menuButton).toBeVisible();

    await menuButton.click();
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

    await page.goto(`/chat?agentId=${chatAgent.id}`);
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
    expect(Math.abs(projectMenuBox!.x - composerSurfaceBox!.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(projectMenuBox!.width - composerSurfaceBox!.width)).toBeLessThanOrEqual(2);
    await page.getByRole("menuitemradio", { name: "No project" }).click();
    await expect(selector).toContainText("No project");

    await selector.click();
    await page.getByRole("menuitemradio", { name: /Launch Context/ }).click();
    await expect(selector).toContainText("Launch Context");

    const createResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/chats`),
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
  });
});
