import { expect, test } from "@playwright/test";

test.describe("gateway agent creation", () => {
  test("creates a Hermes agent from the installed local profile without collecting provider settings", async ({ page }) => {
    const suffix = Date.now();
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Hermes-Local-${suffix}`, issuePrefix: `HL${suffix.toString(36).slice(-6).toUpperCase()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const availabilityResponse = await page.request.get(`/api/orgs/${organization.id}/adapters/availability`);
    expect(availabilityResponse.ok()).toBe(true);
    const availability = await availabilityResponse.json() as Array<{
      agentRuntimeType: string;
      status: string;
      resolvedCommand: string | null;
      hermesLocalBackend?: string;
      hermesProductRpcCapabilityGap?: string;
    }>;
    const hermes = availability.find((item) => item.agentRuntimeType === "hermes_gateway");
    test.skip(hermes?.status !== "available", "requires an installed, locally configured Hermes Agent");
    expect(hermes?.hermesLocalBackend).toMatch(/^(native_product_rpc|acp)$/);
    expect(hermes?.resolvedCommand).toBeTruthy();

    const existingAgent = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: { name: "Existing Operator", role: "ceo", agentRuntimeType: "codex_local", agentRuntimeConfig: {} },
    });
    expect(existingAgent.ok()).toBe(true);

    await page.goto(`/`);
    await page.evaluate((orgId) => window.localStorage.setItem("rudder.selectedOrganizationId", orgId), organization.id);
    await page.goto(`/${organization.issuePrefix}/agents/all`);
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByRole("button", { name: "I want advanced configuration myself" }).click();
    await expect(page.getByRole("button", { name: /^Hermes\b/ })).toHaveCount(1);
    await page.getByRole("button", { name: /^Hermes\b/ }).click();

    await expect(page.getByRole("heading", { name: "New Agent", exact: true })).toBeVisible();
    await expect(page.getByTestId("hermes-local-availability")).toContainText("Hermes is installed and its local ACP setup check passed");
    if (hermes?.hermesLocalBackend === "acp") {
      await expect(page.getByTestId("hermes-local-availability")).toContainText("This agent will use ACP; native Product RPC is unavailable");
    } else {
      await expect(page.getByTestId("hermes-local-availability")).toContainText("Native Product RPC prerequisites were detected");
    }
    await expect(page.getByRole("button", { name: "Create agent", exact: true })).toBeEnabled();
    await page.getByPlaceholder("Agent name").fill("Hermes Local Operator");
    await page.getByPlaceholder("Title (e.g. VP of Engineering)").fill("Local Hermes Agent");
    await page.getByRole("button", { name: "Advanced options", exact: true }).click();
    await expect(page.getByRole("button", { name: "Connect a custom Hermes API Server", exact: true })).toBeVisible();
    await expect(page.getByText("Command", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Extra args (comma-separated)", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Environment variables", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Payload template JSON", { exact: true })).toHaveCount(0);
    await expect(page.getByPlaceholder("http://127.0.0.1:8642")).toHaveCount(0);

    // Retain custom drafts across toggles, but never submit hidden custom
    // transport fields when returning to the default local mode.
    const customDraft = '{"metadata":{"draft":"custom-only"}}';
    await page.getByRole("button", { name: "Connect a custom Hermes API Server", exact: true }).click();
    await page.getByPlaceholder("http://127.0.0.1:8642").fill("http://127.0.0.1:18642");
    await page.getByPlaceholder("API_SERVER_KEY").fill("custom-draft-only");
    const payloadField = page.getByText("Payload template JSON", { exact: true }).locator("../..").locator("textarea");
    await payloadField.fill(customDraft);
    await page.getByRole("button", { name: "Use local Hermes instead", exact: true }).click();
    await expect(page.getByText("Payload template JSON", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Connect a custom Hermes API Server", exact: true }).click();
    await expect(page.getByPlaceholder("http://127.0.0.1:8642")).toHaveValue("http://127.0.0.1:18642");
    await expect(page.getByPlaceholder("API_SERVER_KEY")).toHaveValue("custom-draft-only");
    await expect(payloadField).toHaveValue(customDraft);
    await page.getByRole("button", { name: "Use local Hermes instead", exact: true }).click();
    await expect(page.getByText("Payload template JSON", { exact: true })).toHaveCount(0);
    await expect(page.getByPlaceholder("http://127.0.0.1:8642")).toHaveCount(0);
    await expect(page.getByPlaceholder("API_SERVER_KEY")).toHaveCount(0);

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/orgs/${organization.id}/agent-hires`),
    );
    await page.getByRole("button", { name: "Create agent", exact: true }).click();
    const response = await createResponse;
    expect(response.ok()).toBe(true);
    const payload = await response.json() as {
      agent: { id: string; agentRuntimeType: string; agentRuntimeConfig: Record<string, unknown> };
    };
    expect(payload.agent.agentRuntimeType).toBe("hermes_gateway");
    expect(payload.agent.agentRuntimeConfig).toMatchObject({
      hermesConnectionMode: "local",
      hermesChatBackend: hermes!.hermesLocalBackend,
      hermesAcpCommand: hermes!.resolvedCommand,
    });
    if (hermes?.hermesProductRpcCapabilityGap) {
      expect(payload.agent.agentRuntimeConfig.hermesProductRpcCapabilityGap).toBe(hermes.hermesProductRpcCapabilityGap);
    }
    expect(payload.agent.agentRuntimeConfig.url).toBeUndefined();
    expect(payload.agent.agentRuntimeConfig.apiKey).toBeUndefined();
    expect(payload.agent.agentRuntimeConfig.payloadTemplate).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(/apiKey|authToken|devicePrivateKeyPem/);
    expect(JSON.stringify(payload)).not.toContain("custom-draft-only");
    const persistedResponse = await page.request.get(`/api/agents/${payload.agent.id}`);
    expect(persistedResponse.ok()).toBe(true);
    const persisted = await persistedResponse.json() as { agentRuntimeConfig: Record<string, unknown> };
    expect(persisted.agentRuntimeConfig.hermesConnectionMode).toBe("local");
    expect(persisted.agentRuntimeConfig.url).toBeUndefined();
    expect(persisted.agentRuntimeConfig.apiKey).toBeUndefined();
    expect(persisted.agentRuntimeConfig.payloadTemplate).toBeUndefined();
    await expect(page.getByRole("heading", { name: "Hermes Local Operator", exact: true })).toBeVisible();
  });

  test("creates a custom Hermes API Server agent only from its explicit advanced route", async ({ page }) => {
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
    await expect(page.getByRole("button", { name: /^Hermes\b/ })).toHaveCount(1);
    await page.getByRole("button", { name: /^Hermes\b/ }).click();

    await expect(page.getByRole("heading", { name: "New Agent", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Advanced options", exact: true }).click();
    await page.getByRole("button", { name: "Connect a custom Hermes API Server", exact: true }).click();
    await expect(page.getByText("Hermes API Server URL", { exact: true })).toBeVisible();
    await expect(page.getByText("API Server key", { exact: true })).toBeVisible();
    await expect(page.getByText("Command", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Extra args (comma-separated)", { exact: true })).toHaveCount(0);
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
      hermesConnectionMode: "custom",
      hermesChatBackend: "native_runs_http",
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
