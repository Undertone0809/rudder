import { expect, test } from "@playwright/test";
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
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Plan mode persistence",
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
    await expect(page.getByText("Read-only planning.", { exact: false })).toBeVisible();
    const offTrackColor = await planModeToggle.evaluate((element) => getComputedStyle(element).backgroundColor);

    await planModeToggle.click();
    await expect(planModeToggle).toHaveAttribute("aria-checked", "true");
    const checkedColors = await planModeToggle.evaluate((element) => ({
      track: getComputedStyle(element).backgroundColor,
      thumb: getComputedStyle(element.firstElementChild as HTMLElement).backgroundColor,
    }));
    expect(checkedColors.track).not.toBe(offTrackColor);
    expect(checkedColors.track).not.toBe(checkedColors.thumb);

    await page.keyboard.press("Escape");
    await page.reload();

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
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

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

    await page.goto("/chat");
    await expect(selector).toContainText("Launch Context", { timeout: 15_000 });

    await selector.click();
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
