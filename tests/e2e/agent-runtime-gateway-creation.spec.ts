import { expect, test } from "@playwright/test";

test.describe("external gateway agent creation", () => {
  test("creates a Hermes API Server agent from the advanced New Agent flow", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Hermes-Create-${Date.now()}`, issuePrefix: `HG${Date.now().toString(36).slice(-6).toUpperCase()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const existingAgent = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Existing Operator",
        role: "ceo",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
      },
    });
    expect(existingAgent.ok()).toBe(true);

    await page.goto(`/`);
    await page.evaluate((orgId) => window.localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
    await page.goto(`/${organization.issuePrefix}/agents/all`);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByRole("button", { name: "I want advanced configuration myself" }).click();
    await page.getByRole("button", { name: /Hermes API Server.*Invoke Hermes over HTTP/i }).click();

    await expect(page.getByRole("heading", { name: "New Agent", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Advanced options", exact: true }).click();
    await expect(page.getByText("Hermes API Server URL", { exact: true })).toBeVisible();
    await expect(page.getByText("API Server key", { exact: true })).toBeVisible();
    await page.getByPlaceholder("Agent name").fill("Hermes Operator");
    await page.getByPlaceholder("Title (e.g. VP of Engineering)").fill("Hermes API Agent");
    await page.getByPlaceholder("http://127.0.0.1:8642").fill("http://127.0.0.1:18642");
    await page.getByPlaceholder("API_SERVER_KEY").fill("test-hermes-key");

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/orgs/${organization.id}/agent-hires`),
    );
    await page.getByRole("button", { name: "Create agent", exact: true }).click();
    const response = await createResponse;
    expect(response.ok()).toBe(true);
    const payload = await response.json() as {
      agent: {
        id: string;
        agentRuntimeType: string;
        agentRuntimeConfig: Record<string, unknown>;
      };
    };
    expect(payload.agent.agentRuntimeType).toBe("hermes_gateway");
    expect(payload.agent.agentRuntimeConfig).toMatchObject({
      url: "http://127.0.0.1:18642",
      sessionKeyStrategy: "issue",
    });
    expect(payload.agent.agentRuntimeConfig.apiKey).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("test-hermes-key");
    expect(JSON.stringify(payload)).not.toMatch(/apiKey|authToken|devicePrivateKeyPem/);
    const detail = await page.request.get(`/api/agents/${payload.agent.id}`);
    expect(detail.ok()).toBe(true);
    expect(JSON.stringify(await detail.json())).not.toContain("test-hermes-key");
    const list = await page.request.get(`/api/orgs/${organization.id}/agents`);
    expect(list.ok()).toBe(true);
    expect(JSON.stringify(await list.json())).not.toContain("test-hermes-key");
    await expect(page.getByRole("heading", { name: "Hermes Operator", exact: true })).toBeVisible();
  });

  test("creates an OpenClaw Gateway agent with persisted gateway credentials", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `OpenClaw-Create-${Date.now()}`, issuePrefix: `OG${Date.now().toString(36).slice(-6).toUpperCase()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await page.goto(`/`);
    await page.evaluate((orgId) => window.localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
    await page.goto(`/${organization.issuePrefix}/agents/all`);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByRole("button", { name: "I want advanced configuration myself" }).click();
    await page.getByRole("button", { name: /OpenClaw Gateway.*Invoke OpenClaw via gateway protocol/i }).click();

    await expect(page.getByRole("heading", { name: "New Agent", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Advanced options", exact: true }).click();
    await expect(page.getByText("Gateway URL", { exact: true })).toBeVisible();
    await expect(page.getByText("Gateway auth token", { exact: true })).toBeVisible();
    await page.getByPlaceholder("Agent name").fill("OpenClaw Operator");
    await page.getByPlaceholder("Title (e.g. VP of Engineering)").fill("OpenClaw Gateway Agent");
    await page.getByPlaceholder("ws://127.0.0.1:18789").fill("ws://127.0.0.1:18789");
    await page.getByPlaceholder("OpenClaw gateway token").fill("test-openclaw-gateway-token");

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/orgs/${organization.id}/agent-hires`),
    );
    await page.getByRole("button", { name: "Create agent", exact: true }).click();
    const response = await createResponse;
    expect(response.ok()).toBe(true);
    const payload = await response.json() as {
      agent: {
        id: string;
        agentRuntimeType: string;
        agentRuntimeConfig: Record<string, unknown>;
      };
    };
    expect(payload.agent.agentRuntimeType).toBe("openclaw_gateway");
    expect(payload.agent.agentRuntimeConfig).toMatchObject({
      url: "ws://127.0.0.1:18789",
      sessionKeyStrategy: "issue",
    });
    expect(payload.agent.agentRuntimeConfig.authToken).toBeUndefined();
    expect(payload.agent.agentRuntimeConfig.devicePrivateKeyPem).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("test-openclaw-gateway-token");
    expect(JSON.stringify(payload)).not.toMatch(/apiKey|authToken|devicePrivateKeyPem/);
    const detail = await page.request.get(`/api/agents/${payload.agent.id}`);
    expect(detail.ok()).toBe(true);
    expect(JSON.stringify(await detail.json())).not.toContain("test-openclaw-gateway-token");
    const list = await page.request.get(`/api/orgs/${organization.id}/agents`);
    expect(list.ok()).toBe(true);
    expect(JSON.stringify(await list.json())).not.toContain("test-openclaw-gateway-token");
    await expect(page.getByRole("heading", { name: "OpenClaw Operator", exact: true })).toBeVisible();
  });
});
