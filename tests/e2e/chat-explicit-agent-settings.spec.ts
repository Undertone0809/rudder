import { expect, test } from "@playwright/test";

test.describe("Explicit chat agent settings", () => {
  test("omits Copilot runtime controls from organization settings", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Explicit-Agent-Settings-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/organization/settings");

    await expect(page.getByText("Intelligence", { exact: true })).toBeVisible();
    await expect(page.getByText("Organization-level AI profiles for product features that are not agent work.")).toBeVisible();
    await expect(page.getByText("Rudder Copilot", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Copilot runtime chain", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Test Copilot runtime chain", exact: true })).toHaveCount(0);
  });

  test("asks the operator to create an agent when no chat agent is available", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Explicit-Agent-Warning-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat`);

    await expect(page.getByRole("button", { name: "No agents available", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Create or activate an agent before sending messages.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  test("points unsupported chat runtimes to model configuration", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Explicit-Agent-Model-Config-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Navigator",
        role: "engineer",
        agentRuntimeType: "process",
        agentRuntimeConfig: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Model configuration warning",
        preferredAgentId: agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    });
    expect(chatRes.ok()).toBe(true);
    const chat = await chatRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    await expect(page.getByRole("button", { name: /Navigator/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("The current user has not configured a chat model yet.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Configure model" })).toHaveAttribute("href", `/${organization.issuePrefix}/agents`);
    await expect(page.getByText("Navigator uses process")).toHaveCount(0);
    await expect(page.getByText("does not support chat conversations")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
