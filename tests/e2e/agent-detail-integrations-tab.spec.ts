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
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.addInitScript(({ orgId }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, { orgId: organization.id });

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/integrations`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Integration Scout", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();
    await expect(page.getByText("Connect the external tools this agent can use during work loops.")).toBeVisible();
    await expect(page.getByText("0 of 10 connected")).toBeVisible();
    await expect(page.getByText("Custom API", { exact: true })).toBeVisible();
    await expect(page.getByText("MCP Server", { exact: true })).toBeVisible();
    await expect(page.getByText("Feishu / Lark Not configured")).toBeVisible();
    await expect(page.getByText("Create a Feishu bot named Integration Scout - Rudder")).toBeVisible();

    for (const name of [
      "Gmail",
      "Google Calendar",
      "Google Drive",
      "Notion",
      "Feishu Workspace",
      "GitHub",
      "Linear",
    ]) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: `${name} setup coming soon` })).toBeDisabled();
    }

    await expect(page.getByText("Coming soon")).toHaveCount(7);
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
    await page.getByLabel("Display name").fill("Internal CRM");
    await page.getByLabel("Base URL").fill("https://crm.example.test");
    await page.getByLabel("Tool name").fill("lookup_contact");
    await page.getByRole("button", { name: "Connect Custom API" }).click();

    await expect(page.getByText("Internal CRM")).toBeVisible();
    await expect(page.getByText("This agent only")).toBeVisible();
    await expect(page.getByText("custom.internal-crm.lookup_contact")).toBeVisible();

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
