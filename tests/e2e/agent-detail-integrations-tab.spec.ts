import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("Agent detail integrations tab", () => {
  test("shows Feishu setup plus custom integration controls", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Agent-Integrations-Tab-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Integration Scout",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.addInitScript(({ orgId }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder.designStyle", "luma");
    }, { orgId: organization.id });

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/integrations`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Integration Scout", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Integrations", exact: true })).toHaveCount(0);
    await expect(page.getByText("Connect the external tools this agent can use during work loops.")).toHaveCount(0);
    await expect(page.getByText("0 of 10 connected")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Discover", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Manage", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Built-in" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Agent-scoped custom API" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Message" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Productivity" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Developer" })).toBeVisible();
    await expect(page.getByText("Rudder MCP tools", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Rudder Browser", { exact: true })).toHaveCount(0);
    await expect(page.getByText("rudder-tools · 77 tools · runtime-managed auth")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rudder MCP tools are built in" })).toHaveCount(0);
    await expect(page.getByText("Custom API", { exact: true })).toBeVisible();
    await expect(page.getByText("MCP Server", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Custom API", { exact: true }).locator("xpath=ancestor::div[contains(@class,'border-dashed')][1]")).toBeVisible();
    await expect(page.getByText("Feishu / Lark")).toBeVisible();
    await expect(page.getByText("Not configured")).toBeVisible();
    await expect(page.getByText("Create a Feishu bot named Integration Scout - Rudder")).toHaveCount(0);
    await expect(page.locator('img[src="/brands/gmail-logo.svg"]')).toBeVisible();
    await expect(page.locator('img[src="/brands/google-calendar-logo.svg"]')).toBeVisible();
    await expect(page.locator('img[src="/brands/github-logo.svg"]')).toBeVisible();

    await page.getByRole("button", { name: /^Set up$/ }).first().click();
    const feishuDialog = page.getByRole("dialog", { name: "Connect Feishu / Lark" });
    await expect(feishuDialog).toBeVisible();
    await expect(feishuDialog.getByText("Create a Feishu bot named Integration Scout - Rudder")).toBeVisible();
    const regionGroup = feishuDialog.getByRole("group", { name: "Feishu or Lark region" });
    const feishuRegionButton = regionGroup.getByRole("button", { name: "Feishu CN" });
    const larkRegionButton = regionGroup.getByRole("button", { name: "Lark Global" });
    await expect(feishuRegionButton).toHaveAttribute("aria-pressed", "true");
    await expect(larkRegionButton).toHaveAttribute("aria-pressed", "false");

    const regionRadii = await regionGroup.evaluate((group) => {
      const [feishuButton, larkButton] = Array.from(group.querySelectorAll("button"));
      return {
        control: getComputedStyle(document.documentElement).getPropertyValue("--control-radius").trim(),
        group: getComputedStyle(group).borderRadius,
        feishu: feishuButton ? getComputedStyle(feishuButton).borderRadius : "",
        lark: larkButton ? getComputedStyle(larkButton).borderRadius : "",
      };
    });
    expect(regionRadii.feishu).toBe(regionRadii.control);
    expect(regionRadii.lark).toBe(regionRadii.control);
    expect(Number.parseFloat(regionRadii.group) - Number.parseFloat(regionRadii.control)).toBeCloseTo(2);

    await larkRegionButton.click();
    await expect(feishuRegionButton).toHaveAttribute("aria-pressed", "false");
    await expect(larkRegionButton).toHaveAttribute("aria-pressed", "true");
    await feishuRegionButton.click();
    await expect(feishuRegionButton).toHaveAttribute("aria-pressed", "true");
    await expect(larkRegionButton).toHaveAttribute("aria-pressed", "false");
    await feishuDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(feishuDialog).toBeHidden();

    for (const name of [
      "Gmail",
      "Google Calendar",
      "Google Drive",
      "Notion",
      "GitHub",
      "Linear",
    ]) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }

    await expect(page.getByText("Feishu Workspace", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Coming soon")).toHaveCount(4);
    await expect(page.getByRole("button", { name: "GitHub coming soon" })).toHaveText("Coming soon");
    await expect(page.getByRole("button", { name: "GitHub coming soon" })).toBeDisabled();
    await page.getByRole("button", { name: "Gmail coming soon" }).click({ force: true });
    await expect(page.getByRole("dialog", { name: "Gmail" })).toHaveCount(0);

    await page.getByRole("tab", { name: "Manage", exact: true }).click();
    await expect(page.getByText("No connected integrations")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Built-in" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Built-in" }).locator("..")).toContainText("2");
    await expect(page.getByText("Rudder MCP tools", { exact: true })).toBeVisible();
    await expect(page.getByText("Rudder Browser", { exact: true })).toBeVisible();
    await expect(page.locator('img[src="/rudder-logo.png"]')).toHaveCount(2);
    const coreRow = page.getByLabel("Rudder MCP tools integration");
    const browserRow = page.getByLabel("Rudder Browser integration");
    await expect(coreRow).toContainText("Available");
    await expect(browserRow).toContainText("Available");
    await expect(page.getByText("Managed automatically by the Rudder runtime.")).toHaveCount(2);
    await expect(page.getByText("No user credential")).toHaveCount(2);
    await expect(page.getByText(/exposed/)).toHaveCount(0);
    await expect(page.getByText("rudder_agent_me", { exact: true })).toHaveCount(0);
    await expect(page.getByText("rudder_browser_tabs", { exact: true })).toHaveCount(0);

    const unsupportedAgentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Unsupported Browser Runtime",
        role: "engineer",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
      },
    });
    expect(unsupportedAgentRes.ok()).toBe(true);
    const unsupportedAgent = await unsupportedAgentRes.json() as { id: string };

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${unsupportedAgent.id}/integrations`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("tab", { name: "Manage", exact: true }).click();
    const unsupportedCoreRow = page.getByLabel("Rudder MCP tools integration");
    const unsupportedBrowserRow = page.getByLabel("Rudder Browser integration");
    await expect(unsupportedCoreRow).toContainText("Available");
    await expect(unsupportedBrowserRow).toContainText("Disabled");
    await expect(unsupportedBrowserRow).not.toContainText("exposed");
  });

  test("keeps managed provider loading and failure states distinct from not connected", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Agent-MCP-Status-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Status Observer",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.addInitScript(({ orgId }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, { orgId: organization.id });

    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const statusPattern = `**/api/agents/${agent.id}/mcp-provider-status**`;
    await page.route(statusPattern, async (route) => {
      await statusGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            provider: "supabase",
            organization: {
              state: "connected",
              connectionId: "11111111-1111-4111-8111-111111111111",
              maxAccess: "read_only",
              scopeMode: "account",
              revision: 1,
            },
            agent: {
              access: "none",
              activeRunUsesOlderPolicy: false,
            },
          },
          {
            provider: "linear",
            organization: {
              state: "not_connected",
              connectionId: null,
              maxAccess: null,
              scopeMode: null,
              revision: null,
            },
            agent: {
              access: "none",
              activeRunUsesOlderPolicy: false,
            },
          },
          {
            provider: "notion",
            organization: {
              state: "not_connected",
              connectionId: null,
              maxAccess: null,
              scopeMode: null,
              revision: null,
            },
            agent: {
              access: "none",
              activeRunUsesOlderPolicy: false,
            },
          },
        ]),
      });
    });

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/integrations`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByLabel("Loading Supabase status")).toBeVisible();
    await expect(page.getByTestId("managed-mcp-provider-supabase")).toHaveCount(0);

    releaseStatus();
    const supabaseCard = page.getByTestId("managed-mcp-provider-supabase");
    await expect(supabaseCard).toContainText("Available");
    await expect(supabaseCard).not.toContainText("Not connected");

    await page.unroute(statusPattern);
    await page.route(statusPattern, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "provider status unavailable" }),
      });
    });
    await page.reload({ waitUntil: "domcontentloaded" });

    const failedSupabaseCard = page.getByTestId("managed-mcp-provider-supabase");
    await expect(failedSupabaseCard).toContainText("Unavailable", { timeout: 20_000 });
    await expect(failedSupabaseCard).toContainText("Managed MCP status could not be loaded.");
    await expect(failedSupabaseCard).not.toContainText("Not connected");
    await expect(failedSupabaseCard.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("creates custom integrations with agent and organization scope boundaries", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Agent-Custom-Integrations-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const otherOrgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Agent-Custom-Integrations-Other-${Date.now()}`,
      },
    });
    expect(otherOrgRes.ok()).toBe(true);
    const otherOrganization = await otherOrgRes.json() as { id: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: { name: "Custom Integrator", role: "engineer" },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const secondAgentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: { name: "Shared Tool User", role: "engineer" },
    });
    expect(secondAgentRes.ok()).toBe(true);
    const secondAgent = await secondAgentRes.json() as { id: string };

    const otherAgentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${otherOrganization.id}/agents`, {
      data: { name: "Other Org Agent", role: "engineer" },
    });
    expect(otherAgentRes.ok()).toBe(true);
    const otherAgent = await otherAgentRes.json() as { id: string };

    await page.addInitScript(({ orgId }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, { orgId: organization.id });

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/integrations`, {
      waitUntil: "domcontentloaded",
    });

    await page.getByRole("button", { name: "Configure" }).first().click();
    const customApiDialog = page.getByRole("dialog", { name: "Connect Custom API" });
    await expect(customApiDialog).toBeVisible();
    await expect(customApiDialog.getByText("Choose whether this integration is limited to this agent")).toBeVisible();
    await expect(customApiDialog.locator(".md\\:grid-cols-2")).toHaveCount(0);
    await customApiDialog.getByLabel("Display name").fill("Internal CRM");
    await customApiDialog.getByLabel("Base URL").fill("https://crm.example.test");
    await customApiDialog.getByLabel("Tool name").fill("lookup_contact");
    await customApiDialog.getByRole("button", { name: "Connect Custom API" }).click();
    await expect(customApiDialog).toBeHidden();

    await page.getByRole("tab", { name: "Manage", exact: true }).click();
    await expect(page.getByText("Internal CRM")).toBeVisible();
    await expect(page.getByText("This agent only")).toBeVisible();
    await expect(page.getByText("custom.internal-crm.lookup_contact")).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);

    const customListRes = await page.request.get(
      `${E2E_BASE_URL}/api/agents/${agent.id}/custom-integrations?orgId=${organization.id}`,
    );
    expect(customListRes.ok()).toBe(true);
    const customList = await customListRes.json() as Array<{
      id: string;
      scope: string;
      hasCredentialSecret: boolean;
      tools: Array<{ id: string; rudderToolName: string }>;
    }>;
    expect(customList).toHaveLength(1);
    expect(customList[0]?.scope).toBe("agent");
    expect(JSON.stringify(customList)).not.toContain("credentialSecretId");

    const agentScopedBindRes = await page.request.patch(
      `${E2E_BASE_URL}/api/agents/${secondAgent.id}/custom-integrations/${customList[0]!.id}/binding?orgId=${organization.id}`,
      { data: { enabledToolIds: [customList[0]!.tools[0]!.id] } },
    );
    expect(agentScopedBindRes.status()).toBe(403);

    const orgScopedRes = await page.request.post(
      `${E2E_BASE_URL}/api/agents/${agent.id}/custom-integrations?orgId=${organization.id}`,
      {
        data: {
          scope: "organization",
          kind: "mcp_server",
          displayName: "Shared Search MCP",
          config: { serverUrl: "https://mcp.example.test" },
          tools: [{ externalToolName: "search_docs" }],
        },
      },
    );
    expect(orgScopedRes.ok()).toBe(true);
    const orgScoped = await orgScopedRes.json() as {
      id: string;
      scope: string;
      tools: Array<{ id: string; rudderToolName: string }>;
    };
    expect(orgScoped.scope).toBe("organization");

    const sameOrgBindRes = await page.request.patch(
      `${E2E_BASE_URL}/api/agents/${secondAgent.id}/custom-integrations/${orgScoped.id}/binding?orgId=${organization.id}`,
      { data: { enabledToolIds: [orgScoped.tools[0]!.id] } },
    );
    expect(sameOrgBindRes.ok()).toBe(true);

    const crossOrgBindRes = await page.request.patch(
      `${E2E_BASE_URL}/api/agents/${otherAgent.id}/custom-integrations/${orgScoped.id}/binding?orgId=${otherOrganization.id}`,
      { data: { enabledToolIds: [orgScoped.tools[0]!.id] } },
    );
    expect(crossOrgBindRes.status()).toBe(404);
  });
});
