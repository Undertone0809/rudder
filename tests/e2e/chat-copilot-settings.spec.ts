import { expect, test } from "@playwright/test";

test.describe("Chat copilot settings", () => {
  test("renders Copilot-focused settings copy in organization settings", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Copilot-Settings-${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          modelFallbacks: [{ agentRuntimeType: "claude_local", model: "claude-sonnet-4-5" }],
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/organization/settings");

    await expect(page.getByText("Rudder Copilot", { exact: true })).toBeVisible();
    await expect(page.getByText("Copilot runtime chain", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Test Copilot runtime chain", exact: true })).toBeVisible();
    await expect(page.getByText("Primary", { exact: true })).toBeVisible();
    await expect(page.getByText("Fallback 1", { exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-primary-model")).toContainText("gpt-5.4");
    await expect(page.getByTestId("chat-fallback-model-1")).toContainText("claude-sonnet-4-5");
    await expect(
      page.getByText("Conversations without a preferred agent use Rudder Copilot. Preferred-agent chats inherit that agent's own runtime, skills, and instructions."),
    ).toBeVisible();
  });

  test("references Copilot in the composer warning when chat is unconfigured", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Copilot-Warning-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");

    await expect(
      page.getByText("Choose Rudder Copilot or a specific agent, or configure Copilot in Company Settings before sending messages."),
    ).toBeVisible({ timeout: 15_000 });
  });
});
