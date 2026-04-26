import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("Agents row actions", () => {
  test("opens row-local actions for task creation, chat, heartbeat, and pause/resume", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Agents-Row-Actions-${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Row Action Agent",
        role: "engineer",
        title: "Founding Engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = (await agentRes.json()) as { id: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/all`);
    const row = page.getByTestId(`agent-row-${agent.id}`);
    const actions = page.getByTestId(`agent-row-actions-${agent.id}`);
    await expect(row).toContainText("Row Action Agent");
    await row.hover();
    await actions.click();

    await expect(page.getByRole("menuitem", { name: "Create task" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Chat with agent" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Run heartbeat" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Pause agent" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Copy agent name" })).toBeVisible();

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/dashboard`);
    const sidebarRow = page.getByTestId(`agent-sidebar-row-${agent.id}`);
    const sidebarActions = page.getByTestId(`agent-sidebar-actions-${agent.id}`);
    await expect(sidebarRow).toContainText("Row Action Agent");
    await sidebarRow.hover();
    await sidebarActions.click();
    await expect(page.getByRole("menuitem", { name: "Create task" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Chat with agent" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Run heartbeat" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Pause agent" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Copy agent name" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/all`);
    await row.hover();
    await actions.click();
    await page.getByRole("menuitem", { name: "Create task" }).click();
    await expect(page.getByText("New issue", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Row Action Agent (Founding Engineer)" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("New issue", { exact: true })).toHaveCount(0);

    await row.hover();
    await actions.click();
    await page.getByRole("menuitem", { name: "Chat with agent" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat/[^/]+$`));
    const chatId = new URL(page.url()).pathname.split("/").pop();
    expect(chatId).toBeTruthy();
    const chatRes = await page.request.get(`${E2E_BASE_URL}/api/chats/${chatId}`);
    expect(chatRes.ok()).toBe(true);
    const chat = (await chatRes.json()) as { preferredAgentId: string | null };
    expect(chat.preferredAgentId).toBe(agent.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/all`);
    await row.hover();
    await actions.click();
    const heartbeatResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/agents/${agent.id}/heartbeat/invoke`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("menuitem", { name: "Run heartbeat" }).click();
    expect((await heartbeatResponse).ok()).toBe(true);
    await expect(page.getByText("Heartbeat started", { exact: true })).toBeVisible();

    await row.hover();
    await actions.click();
    await page.getByRole("menuitem", { name: "Pause agent" }).click();
    await expect.poll(async () => {
      const refreshed = await page.request.get(`${E2E_BASE_URL}/api/agents/${agent.id}?orgId=${organization.id}`);
      const body = (await refreshed.json()) as { status: string };
      return body.status;
    }).toBe("paused");

    await row.hover();
    await actions.click();
    await expect(page.getByRole("menuitem", { name: "Resume agent" })).toBeVisible();
  });
});
