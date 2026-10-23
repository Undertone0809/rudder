import { expect, test } from "@playwright/test";

test.describe("Agent runtime creation", () => {
  test("creates native Hermes through the same New Agent entry as Codex", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Hermes-Create-${Date.now()}`, issuePrefix: `HG${Date.now().toString(36).slice(-6).toUpperCase()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const existing = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: { name: "Existing Operator", role: "ceo", agentRuntimeType: "codex_local", agentRuntimeConfig: {} },
    });
    expect(existing.ok()).toBe(true);
    await page.goto(`/`);
    await page.evaluate((orgId) => window.localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
    await page.goto(`/${organization.issuePrefix}/agents/all`);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByRole("button", { name: "I want advanced configuration myself" }).click();
    await expect(page.getByRole("button", { name: /Hermes API Server|Hermes.*legacy/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Hermes Local Hermes agent", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New Agent", exact: true })).toBeVisible();
    await page.getByPlaceholder("Agent name").fill("Hermes Operator");
    await page.getByRole("button", { name: "Advanced options", exact: true }).click();
    await expect(page.getByText("Profile", { exact: true })).toBeVisible();
    await expect(page.getByText("Hermes API Server URL", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Command", { exact: true })).toHaveCount(0);

    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/api/orgs/${organization.id}/agent-hires`));
    await page.getByRole("button", { name: "Create agent", exact: true }).click();
    const response = await created;
    expect(response.ok()).toBe(true);
    const payload = await response.json() as { agent: { id: string; agentRuntimeType: string; agentRuntimeConfig: Record<string, unknown> } };
    expect(payload.agent.agentRuntimeType).toBe("hermes_local");
    expect(payload.agent.agentRuntimeConfig).toEqual({});
    await expect(page.getByRole("heading", { name: "Hermes Operator", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Hermes Operator", exact: true })).toBeVisible();
    const detail = await page.request.get(`/api/agents/${payload.agent.id}`);
    expect((await detail.json()).agentRuntimeType).toBe("hermes_local");
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
